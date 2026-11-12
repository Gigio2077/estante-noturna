const sim = require('./sim.js'), perf = require('./perf.js');
const { SR, piece, Practice, PitchDetector } = sim;
const sc = JSON.parse(process.argv[2]);
const p = new Practice(piece, { hand: sc.hand, fromBar: sc.from, toBar: sc.to, mode: 'wait' });
const rec = perf.readWav(sc.rec).x, ref = perf.readWav(sc.ref).x, lag = perf.findLag(ref, rec);
const det = new PitchDetector(SR); det.setSensitivity(5);
const N = det.N, hop = 960, ring = new Float32Array(N), GAP = 1.2, T0 = 1;
for (let i = 0; i + hop <= rec.length; i += hop) {
  const now = (i + hop) / SR * 1000, tt = now / 1000 - lag, k = Math.floor((tt - T0 + 0.05) / GAP);
  const s = p.steps[k]; det.setExpected(s ? s.notes.map(n => n.m) : []);
  ring.copyWithin(0, hop); ring.set(rec.subarray(i, i + hop), N - hop);
  const ons = det.process(ring, now);
  const rel = Math.round((tt - (T0 + k * GAP)) * 1000);
  if (k === sc.step && rel > -40 && rel < 300) {
    const f = m => `${m}: sal ${det.sal[m].toFixed(0)} at ${det.salAtAttack[m].toFixed(0)} S ${det.salS[m].toFixed(0)} atS ${det.salSAtAttack[m].toFixed(0)} fl ${det.floor[m].toFixed(0)} pres ${det.present.has(m)}`;
    console.log(rel, 'atk', Math.round(now - det.lastAttack), 'gmax', Math.max(...det.sal.slice(28, 105)).toFixed(0), 'noteLvl', det.noteLevel && det.noteLevel.toFixed(0), 'present', [...det.present.keys()].join(','), '|', s.notes.map(n => f(n.m)).join(' | '), ons.length ? 'ONS ' + ons.map(o => o.m).join(',') : '');
  }
}
