// Prints every number the page shows, from data/fleet.js via src/thermal.js.
const fs = require('fs');
const path = require('path');
const T = require('../src/thermal.js');
const src = fs.readFileSync(path.join(__dirname, '..', 'data', 'fleet.js'), 'utf8');
const data = JSON.parse(src.slice(src.indexOf('{'), src.lastIndexOf('}') + 1));
const t0 = Date.now();
const A = T.analyzeFleet(data);
const S = A.summary;
console.log('transformers', S.n, ' kVA-rule flagged', S.kvaFlagged, ' thermal Replace', S.replace, '(flagged', S.flaggedReplace + ', unflagged', S.unflaggedReplace + ')');
console.log('flagged -> Replace', S.flaggedReplace, ' Monitor', S.flaggedMonitor, ' Defer', S.flaggedDefer, ' EV room in deferred units', S.deferHostingTotal);
const unflaggedNoRoom = A.res.filter((r) => !r.kvaFlag && r.hosting <= 0).length;
console.log('unflagged with no room for one more EV:', unflaggedNoRoom, ' unflagged Monitor:', A.res.filter((r) => !r.kvaFlag && r.verdict === 'Monitor').length);
console.log('conformal top-oil margin q =', A.q.toFixed(2), 'C from', A.calN, 'calibration day-peaks; held-out coverage', (100 * A.coverage).toFixed(1) + '% of', A.testN);
console.log('design day index', A.dDesign);
// identification check against the generator's hidden parameters
let eTau = 0, eRise = 0;
for (const r of A.res) { eTau += Math.abs(r.p.tau - r.truth.tau); eRise += Math.abs(r.p.dTOR - r.truth.dTOR); }
console.log('mean |tau error|', (eTau / A.res.length).toFixed(2), 'h; mean |rated top-oil rise error|', (eRise / A.res.length).toFixed(1), 'C');
const ex = A.res.filter((r) => r.kvaFlag && r.verdict !== 'Replace').sort((a, b) => b.overHours - a.overHours)[0];
console.log('example flagged-but-fine:', ex.serial, ex.rated + ' kVA', ex.overHours + ' h over rating', 'design max hot-spot', ex.design.maxHs.toFixed(1), 'FEQA', ex.design.feqa.toFixed(2), 'hosting', ex.hosting);
console.log('ms', Date.now() - t0);
