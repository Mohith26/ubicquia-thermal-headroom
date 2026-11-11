/*
 * Thermal Headroom (core module).
 *
 * Turns distribution-transformer monitor data (secondary kVA, oil temperature,
 * ambient) into an IEEE C57.91 thermal verdict per transformer:
 *   1. identify each unit's top-oil thermal parameters from its own oil data,
 *   2. calibrate the model's forecast error with split conformal prediction,
 *   3. compute hot-spot temperature and insulation aging (FAA / FEQA),
 *   4. Monte Carlo how many more Level 2 EV chargers it can host at a risk level.
 *
 * Browser: window.ThermalHeadroom. Node: module.exports.
 * Unofficial concept by Mohith Gajjela. Not affiliated with Ubicquia.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ThermalHeadroom = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DT_H = 0.5;          // data step: 30 minutes
  const STEPS_PER_DAY = 48;

  // IEEE C57.91-2011 constants for ONAN distribution transformers
  const C57 = {
    n: 0.8,                  // top-oil exponent (ONAN)
    m: 0.8,                  // winding exponent (ONAN)
    dHR: 25,                 // rated hot-spot rise over top oil (65 C rise unit: 80 - 55), assumed
    life: 180000,            // normal insulation life, hours
    hsLimit: 120,            // planned-overload hot-spot limit (C)
    feqaLimit: 1.0           // equivalent aging limit on the design day (days of life per day)
  };

  // ---------------------------------------------------------------- rng ---
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gauss(rng) {
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // ------------------------------------------------------------- C57.91 ---
  function faa(thetaH) { return Math.exp(15000 / 383 - 15000 / (thetaH + 273)); }

  // Normalised top-oil response x(t) for dTOR = 1: tau dx/dt = u(K) - x,
  // u(K) = ((K^2 R + 1)/(R + 1))^n. Exact discretisation for piecewise-constant K.
  function topOilUnitResponse(K, R, tauH, x0) {
    const a = Math.exp(-DT_H / tauH);
    const out = new Float64Array(K.length);
    let x = x0 == null ? Math.pow((K[0] * K[0] * R + 1) / (R + 1), C57.n) : x0;
    for (let i = 0; i < K.length; i++) {
      const u = Math.pow((K[i] * K[i] * R + 1) / (R + 1), C57.n);
      x = u + (x - u) * a;
      out[i] = x;
    }
    return out;
  }

  // Clear-sky solar shape on the tank (0 at night, 1 at solar noon ~13:30).
  function sunShape(i) { const t = (i % STEPS_PER_DAY) * DT_H; return Math.max(0, Math.sin(Math.PI * (t - 7) / 13)); }

  // Full model: top oil = ambient + bias + dTOR * x + solar * sun ; hot spot adds dHR * K^(2m)
  function simulate(p, K, Ta) {
    const x = topOilUnitResponse(K, p.R, p.tau, p.x0);
    const oil = new Float64Array(K.length), hs = new Float64Array(K.length);
    const sg = p.solar || 0;
    for (let i = 0; i < K.length; i++) {
      oil[i] = Ta[i] + p.bias + p.dTOR * x[i] + sg * sunShape(i);
      hs[i] = oil[i] + C57.dHR * Math.pow(K[i], 2 * C57.m);
    }
    return { oil, hs };
  }

  // ---------------------------------------------------------- identification ---
  // Grid over (tau, R); for each, (bias, dTOR, solar) by closed-form least
  // squares on the regressors [1, x(t), sun(t)].
  function solve3(A, b) {
    const M = A.map((r, i) => r.concat([b[i]]));
    for (let c = 0; c < 3; c++) {
      let piv = c; for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      [M[c], M[piv]] = [M[piv], M[c]];
      if (Math.abs(M[c][c]) < 1e-12) return null;
      for (let r = 0; r < 3; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k]; }
    }
    return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
  }
  function fitThermal(K, Ta, oil, opts) {
    const o = opts || {};
    const taus = o.taus || range(1.0, 6.0, 0.25);
    const Rs = o.Rs || range(2.0, 10.0, 0.5);
    const warm = o.warm == null ? STEPS_PER_DAY : o.warm;     // skip first day (initial state)
    const sun = Float64Array.from({ length: K.length }, (_, i) => sunShape(i));
    let best = null;
    for (const tau of taus) for (const R of Rs) {
      const x = topOilUnitResponse(K, R, tau);
      const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
      for (let i = warm; i < K.length; i++) {
        const z = [1, x[i], sun[i]], y = oil[i] - Ta[i];
        for (let r = 0; r < 3; r++) { b[r] += z[r] * y; for (let c = 0; c < 3; c++) A[r][c] += z[r] * z[c]; }
      }
      const w = solve3(A, b);
      if (!w) continue;
      const [bias, dTOR, solar] = w;
      let sse = 0, n = 0;
      for (let i = warm; i < K.length; i++) { const e = oil[i] - Ta[i] - bias - dTOR * x[i] - solar * sun[i]; sse += e * e; n++; }
      if (!best || sse < best.sse) best = { tau, R, dTOR, bias, solar, sse, rmse: Math.sqrt(sse / n) };
    }
    return best;
  }
  function range(a, b, s) { const r = []; for (let v = a; v <= b + 1e-9; v += s) r.push(+v.toFixed(4)); return r; }

  // ------------------------------------------------------------ conformal ---
  // Daily-peak top-oil residuals (measured - predicted) on calibration days.
  function dailyPeakResiduals(p, K, Ta, oil, dayFrom, dayTo) {
    const sim = simulate(p, K, Ta).oil;
    const res = [];
    for (let d = dayFrom; d < dayTo; d++) {
      let mMeas = -Infinity, mPred = -Infinity;
      for (let i = d * STEPS_PER_DAY; i < (d + 1) * STEPS_PER_DAY; i++) {
        if (oil[i] > mMeas) mMeas = oil[i];
        if (sim[i] > mPred) mPred = sim[i];
      }
      res.push(mMeas - mPred);
    }
    return res;
  }
  // Upper split-conformal quantile: ceil((m+1)(1-alpha))-th smallest score.
  function conformalUpper(scores, alpha) {
    const s = scores.slice().sort((a, b) => a - b);
    const m = s.length, k = Math.ceil((m + 1) * (1 - alpha));
    return k > m ? Infinity : s[k - 1];
  }

  // ------------------------------------------------------------ aging ---
  function agingStats(hs, from, to) {
    let sum = 0, max = -Infinity, n = 0;
    for (let i = from; i < to; i++) { sum += faa(hs[i]); if (hs[i] > max) max = hs[i]; n++; }
    return { feqa: sum / n, maxHs: max };
  }

  // ------------------------------------------------------- EV hosting ---
  // Level 2 sessions: 7.2 kW at the panel, evening arrivals, energy log-normal.
  function evSessionKw(rng) {
    const arrive = 18.25 + 1.6 * gauss(rng);                        // hour
    const kwh = Math.min(45, Math.max(4, 11 * Math.exp(0.5 * gauss(rng))));
    const dur = kwh / 7.2;
    return { arrive, dur, kw: 7.2 };
  }
  // Adds k chargers to a 48-step day profile (kVA), each plugging in with prob pDay.
  function addEvs(baseKva, k, rng, pDay) {
    const out = Float64Array.from(baseKva);
    for (let c = 0; c < k; c++) {
      if (rng() > (pDay == null ? 0.85 : pDay)) continue;
      const s = evSessionKw(rng);
      for (let h = 0; h < 48; h++) {
        // overlap of [s.arrive, s.arrive + dur) with step (wrap past midnight)
        const t0 = h * DT_H, t1 = t0 + DT_H;
        let ov = 0;
        for (const shift of [0, -24]) {
          const a = s.arrive + shift, b = a + s.dur;
          ov += Math.max(0, Math.min(t1, b) - Math.max(t0, a));
        }
        out[h] += s.kw / 0.98 * (ov / DT_H);
      }
    }
    return out;
  }

  // Risk that a design day with k added chargers breaks either limit, using the
  // identified model plus the conformal top-oil margin q. Three warm-up days
  // repeat the design day so the oil starts from its periodic state.
  function evRisk(p, kvaRated, designKva, designTa, k, q, sims, seed, limits) {
    const L = Object.assign({ hs: C57.hsLimit, feqa: C57.feqaLimit }, limits || {});
    const rng = mulberry32(seed);
    let bad = 0, sumFeqa = 0, sumMax = 0;
    for (let s = 0; s < sims; s++) {
      const day = addEvs(designKva, k, rng);
      const K = new Float64Array(48 * 4), Ta = new Float64Array(48 * 4);
      for (let r = 0; r < 4; r++) for (let h = 0; h < 48; h++) { K[r * 48 + h] = day[h] / kvaRated; Ta[r * 48 + h] = designTa[h]; }
      const sim = simulate(Object.assign({}, p, { bias: p.bias + q }), K, Ta);
      const a = agingStats(sim.hs, 144, 192);
      sumFeqa += a.feqa; sumMax += a.maxHs;
      if (a.maxHs > L.hs || a.feqa > L.feqa) bad++;
    }
    return { k, risk: bad / sims, feqa: sumFeqa / sims, maxHs: sumMax / sims };
  }
  function hosting(p, kvaRated, designKva, designTa, q, alpha, opts) {
    const o = Object.assign({ kMax: 12, sims: 200, seed: 7 }, opts || {});
    const curve = [];
    let kStar = -1;
    for (let k = 0; k <= o.kMax; k++) {
      const r = evRisk(p, kvaRated, designKva, designTa, k, q, o.sims, o.seed + 31 * k);
      curve.push(r);
      if (r.risk <= alpha && kStar === k - 1) kStar = k;
    }
    return { kStar, curve };
  }

  // -------------------------------------------------------- UbiVu rule ---
  // Current insight: "calculated kVA exceeding rating for at least 1 hour".
  function kvaOverloadHours(kva, rated) {
    let hours = 0, run = 0, flagged = false;
    for (let i = 0; i < kva.length; i++) {
      if (kva[i] > rated) { run++; hours += DT_H; if (run * DT_H >= 1) flagged = true; } else run = 0;
    }
    return { hours, flagged };
  }

  // ----------------------------------------------------------- synthetic data ---
  const RATINGS = [25, 37.5, 50, 50, 75];
  function ambientSeries(days, seed) {
    // Palm Beach summer: daily min ~25 C, max ~32 C, multi-day weather swings
    const rng = mulberry32(seed);
    const Ta = new Float64Array(days * 48);
    let anom = 0;
    for (let d = 0; d < days; d++) {
      anom = 0.75 * anom + 0.9 * gauss(rng);
      const heat = d >= 44 && d <= 49 ? 1.6 : 0;                   // a heat wave
      const tmin = 24.8 + 0.4 * anom + heat * 0.6, tmax = 32.0 + anom + heat;
      for (let h = 0; h < 48; h++) {
        const t = h * DT_H;
        const shape = 0.5 - 0.5 * Math.cos(2 * Math.PI * (t - 5.5) / 24);   // min ~5:30, max ~17:30
        Ta[d * 48 + h] = tmin + (tmax - tmin) * Math.pow(shape, 1.3) + 0.3 * gauss(rng);
      }
    }
    return Ta;
  }
  function makeFleet(nTx, days, seed) {
    const rng = mulberry32(seed);
    const Ta = ambientSeries(days, seed + 1);
    const fleet = [];
    for (let j = 0; j < nTx; j++) {
      const rated = RATINGS[Math.floor(rng() * RATINGS.length)];
      const homes = Math.max(2, Math.round(rated / 5.0 * (0.8 + 0.65 * rng())));
      const evs = Math.floor(rng() * rng() * 5);
      // true thermal parameters (unknown to the analysis)
      const truth = { tau: 2 + 2.5 * rng(), R: 3 + 4 * rng(), dTOR: 48 + 12 * rng() + (rng() < 0.12 ? 10 : 0), bias: (rng() - 0.5) * 2 };
      const kva = new Float64Array(days * 48);
      for (let d = 0; d < days; d++) {
        const dayRng = mulberry32(seed * 1000 + j * 97 + d);
        const base = Float64Array.from({ length: 48 }, (_, h) => {
          const t = h * DT_H;
          const ta = Ta[d * 48 + h];
          const ac = Math.max(0, ta - 24) * (0.33 + 0.1 * Math.sin(2 * Math.PI * (t - 15) / 24));
          const evening = 0.9 * Math.exp(-Math.pow((t - 19.5) / 2.2, 2)) + 0.4 * Math.exp(-Math.pow((t - 7.5) / 1.5, 2));
          return homes * (0.55 + ac * 0.6 + evening * 1.1) * (0.92 + 0.16 * dayRng());
        });
        const withEv = addEvs(base, evs, dayRng, 0.8);
        for (let h = 0; h < 48; h++) kva[d * 48 + h] = Math.max(0.3, withEv[h] * (1 + 0.05 * gauss(dayRng)));
      }
      const K = Float64Array.from(kva, (v) => v / rated);
      const sim = simulate(Object.assign({}, truth, { x0: undefined }), K, Ta);
      const nrng = mulberry32(seed * 7 + j);
      // model mismatch the analysis does not know about: solar heating of the
      // tank (pole-mount units in full sun), varying with daily cloud cover
      const solarGain = 1.5 + 3.5 * rng();
      const cloud = Float64Array.from({ length: days }, () => 0.4 + 0.6 * nrng());
      const oil = Float64Array.from(sim.oil, (v, i) => {
        const sun = sunShape(i);
        return Math.round((v + solarGain * cloud[Math.floor(i / 48)] * sun + 0.45 * gauss(nrng)) * 10) / 10;
      });
      const lat = 26.62 + 0.16 * rng(), lon = -80.16 + 0.12 * rng();
      const serial = (2320 + Math.floor(rng() * 14)) + 'UTMF' + String(100 + Math.floor(rng() * 900)).padStart(5, '0');
      fleet.push({ serial, rated, homes, evs, lat: +lat.toFixed(5), lon: +lon.toFixed(5), truth,
        kva: Array.from(kva, (v) => Math.round(v * 10) / 10), oil: Array.from(oil) });
    }
    return { days, stepH: DT_H, ambient: Array.from(Ta, (v) => Math.round(v * 10) / 10), fleet };
  }

  // ---------------------------------------------------------------- pipeline ---
  // Split (defaults 35/15/10 days): [0, fitTo) identify, [fitTo, calTo) calibrate, [calTo, days) test.
  function analyzeFleet(data, o) {
    const opt = Object.assign({ fitTo: 35, calTo: 50, alpha: 0.1, sims: 150 }, o || {});
    const Ta = Float64Array.from(data.ambient);
    const nFit = opt.fitTo * 48;
    const units = data.fleet.map((t) => {
      const kva = Float64Array.from(t.kva), oil = Float64Array.from(t.oil);
      const K = Float64Array.from(kva, (v) => v / t.rated);
      const fit = fitThermal(K.subarray(0, nFit), Ta.subarray(0, nFit), oil.subarray(0, nFit));
      const p = { tau: fit.tau, R: fit.R, dTOR: fit.dTOR, bias: fit.bias, solar: fit.solar };
      return { t, K, kva, oil, p, fit };
    });
    // pooled conformal margin on daily peak top-oil (calibration days)
    const calRes = [];
    for (const u of units) calRes.push(...dailyPeakResiduals(u.p, u.K, Ta, u.oil, opt.fitTo, opt.calTo));
    const q = conformalUpper(calRes, opt.alpha);
    // held-out coverage of the margin
    let cov = 0, tot = 0;
    for (const u of units) for (const r of dailyPeakResiduals(u.p, u.K, Ta, u.oil, opt.calTo, data.days)) { tot++; if (r <= q) cov++; }
    // design day = hottest day of the record (max daily mean ambient)
    let dDesign = 0, best = -Infinity;
    for (let d = 0; d < data.days; d++) {
      let s = 0; for (let h = 0; h < 48; h++) s += Ta[d * 48 + h];
      if (s > best) { best = s; dDesign = d; }
    }
    const designTa = Ta.slice(dDesign * 48, dDesign * 48 + 48);
    const res = units.map((u) => {
      const rule = kvaOverloadHours(u.kva, u.t.rated);
      const sim = simulate(Object.assign({}, u.p, { bias: u.p.bias + q }), u.K, Ta);
      const hist = agingStats(sim.hs, 48, u.K.length);
      const designKva = u.kva.slice(dDesign * 48, dDesign * 48 + 48);
      const host = hosting(u.p, u.t.rated, designKva, designTa, q, opt.alpha, { sims: opt.sims, seed: 11 });
      const now = host.curve[0];
      const verdict = now.risk > opt.alpha ? 'Replace' : host.kStar <= 1 ? 'Monitor' : 'Defer';
      let peak = 0; for (const v of u.kva) if (v > peak) peak = v;
      return { serial: u.t.serial, rated: u.t.rated, lat: u.t.lat, lon: u.t.lon, homes: u.t.homes, evs: u.t.evs,
        peakKva: peak, overHours: rule.hours, kvaFlag: rule.flagged, fit: u.fit, p: u.p, truth: u.t.truth,
        histFeqa: hist.feqa, histMaxHs: hist.maxHs, design: now, hosting: host.kStar, curve: host.curve, verdict };
    });
    const flagged = res.filter((r) => r.kvaFlag);
    return { opt, q, calN: calRes.length, coverage: cov / tot, testN: tot, dDesign, designTa: Array.from(designTa), res,
      summary: {
        n: res.length,
        kvaFlagged: flagged.length,
        replace: res.filter((r) => r.verdict === 'Replace').length,
        flaggedReplace: flagged.filter((r) => r.verdict === 'Replace').length,
        flaggedDefer: flagged.filter((r) => r.verdict === 'Defer').length,
        flaggedMonitor: flagged.filter((r) => r.verdict === 'Monitor').length,
        unflaggedReplace: res.filter((r) => !r.kvaFlag && r.verdict === 'Replace').length,
        deferHostingTotal: flagged.filter((r) => r.verdict === 'Defer').reduce((a, r) => a + r.hosting, 0)
      } };
  }

  return { DT_H, STEPS_PER_DAY, C57, mulberry32, gauss, faa, sunShape, topOilUnitResponse, simulate, fitThermal,
    dailyPeakResiduals, conformalUpper, agingStats, addEvs, evRisk, hosting, kvaOverloadHours,
    ambientSeries, makeFleet, analyzeFleet };
});
