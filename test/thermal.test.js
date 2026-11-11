// node --test test/thermal.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const T = require('../src/thermal.js');
const { build } = require('../scripts/gen-data.js');

function loadData() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'data', 'fleet.js'), 'utf8');
  return JSON.parse(src.slice(src.indexOf('{'), src.lastIndexOf('}') + 1));
}

test('C57.91 aging acceleration: 1.0 at 110 C, about 2.7 at 120 C, about 0.125 at 90 C', () => {
  assert.ok(Math.abs(T.faa(110) - 1) < 1e-9);
  assert.ok(Math.abs(T.faa(120) - 2.71) < 0.02);
  assert.ok(Math.abs(T.faa(90) - 0.125) < 0.01);
});

test('top-oil response: steady state equals the ultimate rise; one time constant reaches 63.2%', () => {
  const K1 = new Float64Array(400).fill(1);
  const x = T.topOilUnitResponse(K1, 5, 3);
  assert.ok(Math.abs(x[399] - 1) < 1e-12);
  // step from K=0.5 steady state to K=1.2, tau = 3 h -> after 6 steps (3 h) 63.2% of the way
  const K = new Float64Array(200).fill(1.2);
  const u0 = Math.pow((0.25 * 5 + 1) / 6, 0.8), u1 = Math.pow((1.44 * 5 + 1) / 6, 0.8);
  const y = T.topOilUnitResponse(K, 5, 3, u0);
  assert.ok(Math.abs((y[5] - u0) / (u1 - u0) - (1 - Math.exp(-1))) < 1e-9);
});

test('identification recovers the parameters exactly on noiseless data from the model', () => {
  const Ta = T.ambientSeries(20, 3);
  const rng = T.mulberry32(9);
  const K = Float64Array.from({ length: Ta.length }, (_, i) => 0.6 + 0.5 * Math.sin(2 * Math.PI * (i % 48) / 48) + 0.2 * rng());
  const truth = { tau: 3.25, R: 4.5, dTOR: 55, bias: 0.7, solar: 3.2 };
  const oil = T.simulate(truth, K, Ta).oil;
  const fit = T.fitThermal(K, Ta, oil);
  assert.equal(fit.tau, 3.25);
  assert.equal(fit.R, 4.5);
  assert.ok(Math.abs(fit.dTOR - 55) < 1e-6 && Math.abs(fit.bias - 0.7) < 1e-6 && Math.abs(fit.solar - 3.2) < 1e-6);
});

test('conformal upper quantile is the ceil((m+1)(1-alpha))-th order statistic and covers fresh draws', () => {
  const s = Array.from({ length: 19 }, (_, i) => i + 1);
  assert.equal(T.conformalUpper(s, 0.1), 18);
  assert.equal(T.conformalUpper([1, 2, 3], 0.1), Infinity);
  const rng = T.mulberry32(4);
  let miss = 0, tot = 0;
  for (let r = 0; r < 300; r++) {
    const cal = Array.from({ length: 100 }, () => T.gauss(rng) * 2 + rng());
    const q = T.conformalUpper(cal, 0.1);
    for (let k = 0; k < 20; k++) { tot++; if (T.gauss(rng) * 2 + rng() > q) miss++; }
  }
  assert.ok(miss / tot <= 0.11, 'miscoverage ' + miss / tot);
});

test('UbiVu-style rule: flags only kVA above rating for at least one hour', () => {
  assert.deepEqual(T.kvaOverloadHours([10, 60, 10, 60, 10], 50), { hours: 1, flagged: false });
  assert.deepEqual(T.kvaOverloadHours([10, 60, 61, 10], 50), { hours: 1, flagged: true });
});

test('EV sessions conserve energy (7.2 kW at 98% efficiency) inside the day', () => {
  const rng = T.mulberry32(1);
  for (let k = 0; k < 50; k++) {
    const base = new Float64Array(48);
    const out = T.addEvs(base, 1, rng, 1);
    const kvah = out.reduce((a, v) => a + v, 0) * T.DT_H;
    assert.ok(kvah > 4 / 0.98 - 1e-6 && kvah < 45 / 0.98 + 1e-6);
    assert.ok(Math.max(...out) <= 7.2 / 0.98 + 1e-9);
  }
});

test('adding chargers never lowers expected aging (common random numbers per k)', () => {
  const p = { tau: 3, R: 5, dTOR: 55, bias: 0 };
  const day = Float64Array.from({ length: 48 }, (_, h) => 30 + 15 * Math.exp(-Math.pow((h / 2 - 19) / 2.5, 2)));
  const Ta = Float64Array.from({ length: 48 }, (_, h) => 26 + 6 * Math.sin(Math.PI * (h / 2 - 6) / 12));
  let prev = 0;
  for (let k = 0; k <= 6; k++) {
    const r = T.evRisk(p, 50, day, Ta, k, 0, 120, 5);
    assert.ok(r.feqa >= prev - 1e-12);
    prev = r.feqa;
  }
});

test('committed data is exactly what scripts/gen-data.js builds', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(build())), loadData());
});

test('fleet analysis is internally consistent', () => {
  const A = T.analyzeFleet(loadData());
  const S = A.summary;
  assert.equal(S.flaggedReplace + S.flaggedMonitor + S.flaggedDefer, S.kvaFlagged);
  for (const r of A.res) {
    assert.equal(r.verdict === 'Replace', r.design.risk > A.opt.alpha);
    if (r.verdict !== 'Replace') {
      assert.ok(r.hosting >= 0);
      assert.ok(r.curve[r.hosting].risk <= A.opt.alpha);
      if (r.hosting < r.curve.length - 1) assert.ok(r.curve[r.hosting + 1].risk > A.opt.alpha);
    }
  }
  assert.ok(A.coverage >= 0.9, 'held-out coverage ' + A.coverage);
});
