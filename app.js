/* Thermal Headroom page. Every number is computed here from data/fleet.js by src/thermal.js. */
(function () {
  'use strict';
  const T = window.ThermalHeadroom, D = window.FLEET_DATA;
  const $ = (id) => document.getElementById(id);
  const fmt = (x, d) => x.toLocaleString('en-US', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 });
  const VC = { Replace: '#e02020', Monitor: '#ffb800', Defer: '#00c700' };
  const start = new Date(D.start + 'T00:00:00');
  const dayDate = (d) => new Date(start.getTime() + d * 864e5);
  const mon = (dt) => dt.toLocaleString('en-US', { month: 'short' });
  const Q = new URLSearchParams(location.search);
  const S = { alpha: [0.05, 0.1, 0.2].includes(+Q.get('alpha')) ? +Q.get('alpha') : 0.1, sel: Q.get('tx'), charts: {} };
  const Ta = Float64Array.from(D.ambient);

  Chart.defaults.font.family = '"Helvetica Neue", Helvetica, Arial, sans-serif';
  Chart.defaults.font.size = 11;
  Chart.defaults.color = '#545c71';
  Chart.defaults.animation = false;
  const grid = { color: '#eef0f4', drawTicks: false };

  function chart(id, cfg) {
    if (S.charts[id]) S.charts[id].destroy();
    cfg.options = Object.assign({ responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }, cfg.options);
    S.charts[id] = new Chart($(id), cfg);
  }

  function run() {
    S.A = T.analyzeFleet(D, { alpha: S.alpha });
    if (!S.sel || !S.A.res.find((r) => r.serial === S.sel)) {
      const pick = S.A.res.filter((r) => r.kvaFlag && r.verdict === 'Defer').sort((a, b) => b.overHours - a.overHours)[0] ||
        S.A.res.filter((r) => r.kvaFlag && r.verdict !== 'Replace').sort((a, b) => b.overHours - a.overHours)[0];
      S.sel = pick.serial;
    }
    render();
  }

  function render() {
    const A = S.A, r = A.res.find((x) => x.serial === S.sel), t = D.fleet.find((f) => f.serial === S.sel);
    const K = Float64Array.from(t.kva, (v) => v / t.rated);
    const sim = T.simulate(r.p, K, Ta), simQ = T.simulate(Object.assign({}, r.p, { bias: r.p.bias + A.q }), K, Ta);
    const N = K.length, last = N - 1;
    let kwh = 0; for (const v of t.kva) kwh += v * D.stepH * 0.98;

    // side panel
    $('serial').textContent = r.serial; $('serialSub').textContent = r.serial;
    $('kvaRating').textContent = fmt(r.rated, r.rated % 1 ? 1 : 0); $('homes').textContent = r.homes;
    const lastDay = dayDate(D.days - 1);
    $('upd').textContent = 'The values above were last updated on: ' + (lastDay.getMonth() + 1) + '/' + lastDay.getDate() + '/' + lastDay.getFullYear() + ' 11:30:00 PM';
    const hostTxt = r.verdict === 'Replace' ? 'Replace' : (r.hosting > 0 ? '+' + r.hosting + ' EV' + (r.hosting > 1 ? 's' : '') : 'At limit');
    const icon = (p) => '<div class="circle"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#0d1c4b" stroke-width="2">' + p + '</svg></div>';
    const items = [
      [icon('<path d="M5 20V10M10 20V4M15 20v-7M20 20v-12"/>'), 'Metrics Overview', ''],
      [icon('<path d="M12 3c3 4 5 6.5 5 9.5a5 5 0 01-10 0C7 9.5 9 7 12 3z"/>'), 'Current &amp; Oil Temperature', fmt(t.oil[last], 1) + '&deg;C'],
      [icon('<path d="M13 3L5 14h6l-1 7 8-11h-6l1-7z"/>'), 'kVA', fmt(t.kva[last], 1) + ' kVA'],
      [icon('<path d="M13 3L5 14h6l-1 7 8-11h-6l1-7z"/>'), 'kWh', fmt(kwh, 0) + ' kWh'],
      ['<div class="circle"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><path d="M14 14.8V5a2 2 0 10-4 0v9.8a4 4 0 104 0z"/><path d="M12 11v6"/></svg></div>', 'Thermal Headroom<span class="new">NEW</span>', hostTxt, 'on'],
      [icon('<path d="M6 20V5l12 4-12 4"/>'), 'Tilt', '']
    ];
    $('mlist').innerHTML = items.map((x) => '<div class="it' + (x[3] ? ' on' : '') + '">' + x[0] + '<b>' + x[1] + '</b><span>' + x[2] + '</span></div>').join('');

    // header strip
    const Sm = A.summary;
    const keep = Sm.flaggedMonitor + Sm.flaggedDefer;
    $('fleetline').innerHTML = '<b>' + Sm.n + '</b> DTM+ transformers &nbsp;&middot;&nbsp; Overloaded insight flags <b>' + Sm.kvaFlagged + '</b> &nbsp;&middot;&nbsp; thermal verdict: <b class="r">' + Sm.flaggedReplace +
      ' replace</b>, <b class="y">' + Sm.flaggedMonitor + ' monitor</b>, <b class="g">' + Sm.flaggedDefer + ' defer</b> of those flagged';
    const d0 = dayDate(0), d1 = dayDate(D.days - 1);
    const dl = (d) => d.toLocaleString('en-US', { weekday: 'short' }) + ' ' + mon(d) + ' ' + d.getDate() + ' ' + d.getFullYear();
    $('dateRange').textContent = dl(d0) + ' - ' + dl(d1) + ' 12:00 AM - 11:59 PM';

    // card 1: last 10 days (held-out window)
    const from = A.opt.calTo * 48;
    const xs = [], oilM = [], oilP = [], hs = [];
    for (let i = from; i < N; i++) { xs.push(i); oilM.push(t.oil[i]); oilP.push(+sim.oil[i].toFixed(2)); hs.push(+simQ.hs[i].toFixed(2)); }
    const tickLbl = (i) => { const d = dayDate(Math.floor(i / 48)); const h = (i % 48) / 2; return [mon(d) + ' ' + d.getDate(), h === 8 ? '8AM' : '8PM']; };
    const ys = hs.concat(oilM);
    chart('cHs', { type: 'line', data: { labels: xs, datasets: [
      { data: oilM, borderColor: '#ff5600', borderWidth: 1.4, pointRadius: 0 },
      { data: oilP, borderColor: '#ffb800', borderWidth: 1.4, borderDash: [4, 3], pointRadius: 0 },
      { data: hs, borderColor: '#6a3cf0', borderWidth: 1.6, pointRadius: 0 },
      { data: xs.map(() => T.C57.hsLimit), borderColor: '#e02020', borderWidth: 1.4, pointRadius: 0 }
    ] }, options: { scales: {
      x: { grid: { display: false }, ticks: { autoSkip: false, maxRotation: 0, callback: (v, idx) => { const i = xs[idx]; const h = (i % 48) / 2; return h === 12 ? tickLbl(i)[0] : null; } } },
      y: { position: 'right', grid, border: { display: false }, suggestedMin: Math.floor(Math.min(...ys) / 10) * 10, suggestedMax: 130, ticks: { stepSize: 20, callback: (v) => v + ' \u00b0C' } } } } });
    let mx = -1e9, mxi = 0; for (let i = from; i < N; i++) if (simQ.hs[i] > mx) { mx = simQ.hs[i]; mxi = i; }
    const md = dayDate(Math.floor(mxi / 48));
    $('capHs').innerHTML = 'Held-out ' + (D.days - A.opt.calTo) + ' days. Peak estimated hot-spot <b>' + fmt(mx, 1) + ' &deg;C</b> on ' + mon(md) + ' ' + md.getDate() + ' (includes the +' + fmt(A.q, 2) +
      ' &deg;C calibrated margin). Fitted: &tau; = ' + fmt(r.p.tau, 2) + ' h, rated top-oil rise ' + fmt(r.p.dTOR, 1) + ' &deg;C, solar gain ' + fmt(r.p.solar, 1) + ' &deg;C, fit RMSE ' + fmt(r.fit.rmse, 2) + ' &deg;C.';

    // card 2: daily aging over the whole record
    const days = [], ages = [];
    for (let d = 1; d < D.days; d++) { const a = T.agingStats(simQ.hs, d * 48, (d + 1) * 48); days.push(d); ages.push(+a.feqa.toFixed(4)); }
    const total = ages.reduce((a, v) => a + v, 0);
    const amax = Math.max(1.2, ...ages);
    chart('cAge', { type: 'bar', data: { labels: days, datasets: [
      { type: 'line', data: days.map(() => 1), borderColor: '#e02020', borderWidth: 1.4, pointRadius: 0 },
      { data: ages, backgroundColor: ages.map((v) => v > 1 ? '#e02020' : v > 0.5 ? '#ffb800' : '#00c700'), barPercentage: 0.8, categoryPercentage: 0.9 }
    ] }, options: { scales: {
      x: { grid: { display: false }, ticks: { autoSkip: false, maxRotation: 0, callback: (v, idx) => { const d = dayDate(days[idx]); return d.getDate() === 1 || d.getDate() === 15 ? mon(d) + ' ' + d.getDate() : null; } } },
      y: { position: 'right', grid, border: { display: false }, min: 0, max: Math.ceil(amax * 2) / 2, ticks: { stepSize: 0.25, callback: (v) => v + ' d/d' } } } } });
    const daysOver = ages.filter((v) => v > 1).length;
    $('capAge').innerHTML = 'Used <b>' + fmt(total, 1) + ' days</b> of insulation life in ' + days.length + ' days (normal rate = 1.0 day per day; ' + daysOver + ' day' + (daysOver === 1 ? '' : 's') + ' above it). Design day (hottest, ' + mon(dayDate(A.dDesign)) + ' ' + dayDate(A.dDesign).getDate() + '): ' + fmt(r.design.feqa, 2) + ' d/d, max hot-spot ' + fmt(r.design.maxHs, 1) + ' &deg;C.';

    // card 3: EV hosting
    chart('cEv', { type: 'line', data: { labels: r.curve.map((c) => c.k), datasets: [
      { data: r.curve.map((c) => +(100 * c.risk).toFixed(1)), borderColor: '#00b2ff', backgroundColor: '#00b2ff', borderWidth: 2, pointRadius: 3, tension: 0.2 },
      { data: r.curve.map(() => 100 * S.alpha), borderColor: '#e02020', borderWidth: 1.4, borderDash: [5, 4], pointRadius: 0 }
    ] }, options: { scales: {
      x: { grid: { display: false }, title: { display: true, text: 'Added Level 2 chargers (7.2 kW)', color: '#545c71', font: { size: 11 } } },
      y: { position: 'right', grid, border: { display: false }, min: 0, max: 100, ticks: { stepSize: 25, callback: (v) => v + '%' } } } } });
    $('capEv').innerHTML = r.verdict === 'Replace'
      ? 'Already over the limit on the design day with today\u2019s load (risk ' + fmt(100 * r.design.risk, 0) + '% vs ' + fmt(100 * S.alpha, 0) + '% target): <b>replace or offload</b>.'
      : 'Can host <b>' + r.hosting + ' more Level 2 charger' + (r.hosting === 1 ? '' : 's') + '</b> at ' + fmt(100 * S.alpha, 0) + '% risk (' + S.A.opt.sims + ' simulated design days per count, evening plug-ins, 85% daily use).';

    // card 4: scatter
    const pts = A.res.map((x) => ({ x: Math.max(0.5, x.overHours), y: +x.design.maxHs.toFixed(1), v: x.verdict, s: x.serial }));
    chart('cSc', { type: 'scatter', data: { datasets: [
      { data: pts, pointRadius: pts.map((p) => p.s === S.sel ? 7 : 4.5), pointBackgroundColor: pts.map((p) => VC[p.v]), pointBorderColor: pts.map((p) => p.s === S.sel ? '#0d1c4b' : '#fff'), pointBorderWidth: pts.map((p) => p.s === S.sel ? 2.5 : 1) },
      { type: 'line', data: [{ x: 1, y: 40 }, { x: 1, y: 180 }], borderColor: '#99a1b7', borderDash: [4, 3], borderWidth: 1.2, pointRadius: 0 },
      { type: 'line', data: [{ x: 0, y: 120 }, { x: 400, y: 120 }], borderColor: '#e02020', borderWidth: 1.4, pointRadius: 0 }
    ] }, options: { scales: {
      x: { type: 'logarithmic', min: 0.4, max: 400, grid: { display: false }, title: { display: true, text: 'Hours above kVA rating in 60 days (log); Overloaded insight fires at 1 h', color: '#545c71', font: { size: 11 } }, ticks: { callback: (v) => v === 0.5 ? '0' : [1, 5, 10, 50, 100].includes(v) ? v : null } },
      y: { position: 'right', grid, border: { display: false }, min: 50, max: 180, ticks: { stepSize: 30, callback: (v) => v + ' \u00b0C' } } },
      onClick: (e, els) => { const el = els.find((q) => q.datasetIndex === 0); if (el) { S.sel = pts[el.index].s; render(); } } } });
    const flaggedOk = A.res.filter((x) => x.kvaFlag && x.verdict !== 'Replace');
    $('capSc').innerHTML = 'Of <b>' + Sm.kvaFlagged + '</b> transformers flagged overloaded by kVA, <b>' + keep + '</b> stay under IEEE C57.91 limits on the design day (y = design-day peak hot-spot). ' +
      (Sm.unflaggedReplace ? Sm.unflaggedReplace + ' unflagged units need replacement.' : 'None of the unflagged units need replacement.');

    // table
    const order = { Replace: 0, Monitor: 1, Defer: 2 };
    const rows = A.res.slice().sort((a, b) => order[a.verdict] - order[b.verdict] || b.design.maxHs - a.design.maxHs);
    const selIdx = rows.findIndex((x) => x.serial === S.sel);
    const page = Math.floor(selIdx / 10);
    const shown = rows.slice(page * 10, page * 10 + 10);
    $('tbl').innerHTML = '<tr><th>Serial Number</th><th>kVA Rating</th><th>Peak kVA</th><th>Hours &gt; Rating</th><th>Overloaded Insight</th><th>Design Hot-Spot</th><th>Design Aging</th><th>60-day Life Used</th><th>EV Hosting</th><th>Thermal Verdict</th></tr>' +
      shown.map((x) => {
        const tt = D.fleet.find((f) => f.serial === x.serial);
        const KK = Float64Array.from(tt.kva, (v) => v / tt.rated);
        const hq = T.simulate(Object.assign({}, x.p, { bias: x.p.bias + A.q }), KK, Ta).hs;
        const used = T.agingStats(hq, 48, KK.length).feqa * (D.days - 1);
        return '<tr data-s="' + x.serial + '"' + (x.serial === S.sel ? ' class="on"' : '') + '><td>' + x.serial + '</td><td>' + fmt(x.rated, x.rated % 1 ? 1 : 0) + ' kVA</td><td>' + fmt(x.peakKva, 1) + ' kVA</td><td>' + fmt(x.overHours, 1) + ' h</td><td>' +
          (x.kvaFlag ? '<span class="pill"><i style="background:#ff5600"></i>Overloaded</span>' : '<span class="pill"><i style="background:#00b2ff"></i>Normal</span>') + '</td><td>' + fmt(x.design.maxHs, 1) + ' &deg;C</td><td>' + fmt(x.design.feqa, 2) + ' d/d</td><td>' + fmt(used, 1) + ' d</td><td>' +
          (x.verdict === 'Replace' ? '&ndash;' : '+' + x.hosting) + '</td><td><span class="pill"><i style="background:' + VC[x.verdict] + '"></i>' + x.verdict + '</span></td></tr>';
      }).join('');
    $('tbl').onclick = (e) => { const tr = e.target.closest('tr[data-s]'); if (tr) { S.sel = tr.dataset.s; render(); } };
    $('tblfoot').textContent = 'Items Per Page: 10 \u00a0\u00a0 ' + (page * 10 + 1) + ' \u2013 ' + (page * 10 + shown.length) + ' of ' + rows.length;
    $('method').innerHTML = 'Method: each unit\u2019s IEEE C57.91 top-oil model (time constant, loss ratio, rated rise, sensor offset) is fit to its own oil temperature over the first ' + A.opt.fitTo +
      ' days. Daily-peak oil errors on the next ' + (A.opt.calTo - A.opt.fitTo) + ' days across the fleet (' + A.calN + ' day-peaks) set a split-conformal margin of +' + fmt(A.q, 2) + ' &deg;C at ' + fmt(100 * S.alpha, 0) + '%, which held on ' +
      fmt(100 * A.coverage, 1) + '% of ' + A.testN + ' held-out day-peaks. Hot-spot adds 25 &deg;C &times; K<sup>1.6</sup> (rated hot-spot gradient assumed); aging uses F<sub>AA</sub> = exp(15000/383 &minus; 15000/(&theta;<sub>H</sub>+273)). Verdict: Replace if today\u2019s design-day risk exceeds the target, Monitor if it can host at most one more charger, else Defer.';
  }

  $('alphaSel').innerHTML = [0.05, 0.1, 0.2].map((a) => '<option value="' + a + '"' + (a === S.alpha ? ' selected' : '') + '>Risk ' + (100 * a) + '%</option>').join('');
  $('alphaSel').onchange = () => { S.alpha = +$('alphaSel').value; run(); };
  run();
  document.body.setAttribute('data-ready', '1');
})();
