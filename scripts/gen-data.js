// Writes data/fleet.js: 48 synthetic pole-mount transformers, 60 summer days at
// 30-minute resolution (kVA, oil temperature) plus ambient. Deterministic.
//   node scripts/gen-data.js
const fs = require('fs');
const path = require('path');
const T = require('../src/thermal.js');
function build() {
  const d = T.makeFleet(48, 60, 2026);
  // truth stays in the file only for the tests (the page never reads it)
  return { generated: 'scripts/gen-data.js', start: '2026-07-01', days: d.days, stepH: d.stepH, ambient: d.ambient, fleet: d.fleet };
}
if (require.main === module) {
  const out = path.join(__dirname, '..', 'data', 'fleet.js');
  const data = build();
  fs.writeFileSync(out, 'window.FLEET_DATA = ' + JSON.stringify(data) + ';\n');
  console.log('wrote', out, data.fleet.length, 'transformers', data.days, 'days');
}
module.exports = { build };
