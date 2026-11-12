const perf = require('./perf.js'), sim = require('./sim.js');
const { SR, piece, Practice, PitchDetector } = sim;
const sc = JSON.parse(process.argv[2]);
const { x } = perf.readWav(sc.rec);
const p = new Practice(piece, { hand: sc.hand, fromBar: sc.from, toBar: sc.to, mode: 'tempo', speed: sc.speed, strict: 'normal' });
const det = new PitchDetector(SR, { attackGate: sc.gate ?? true }); det.setSensitivity(sc.sens ?? 5);
const N = det.N, hop = 960, ring = new Float32Array(N);
p.start(0); let loud = null;
const notes = piece.notes.filter(n => n.bar >= sc.from && n.bar <= sc.to && (sc.hand === 'B' || n.h === sc.hand));
const secOf = t => 1.6 + (t - p.t0) / p.wps;
for (let i = 0; i + hop <= x.length && !p.finished; i += hop) {
  const now = (i + hop) / SR * 1000;
  ring.copyWithin(0, hop); ring.set(x.subarray(i, i + hop), N - hop);
  p.update(now); det.setExpected(p.started && !p.finished ? p.expected : []);
  for (const c of det.process(ring, now)) {
    let r = 'skip';
    if (c.exp) { r = p.input(c.m, now, 'mic'); if (r === 'hit') loud = loud == null ? c.db : loud * 0.8 + c.db * 0.2; }
    else if (!c.harmonic && (loud == null || c.db >= loud - 8)) r = p.input(c.m, now, 'mic');
    if (sc.all || r === 'wrong') {
      const near = notes.filter(n => n.m === c.m).map(n => +(secOf(n.t) - now / 1000).toFixed(2)).sort((a, b) => Math.abs(a) - Math.abs(b)).slice(0, 2);
      const sounding = notes.filter(n => secOf(n.t) <= now / 1000 && secOf(n.t) > now / 1000 - 1.5).map(n => n.m);
      console.log(`${(now / 1000).toFixed(2)}s m${c.m} ${r} exp=${c.exp} pres=${c.present} harm=${c.harmonic} db=${c.db.toFixed(1)} loud=${loud && loud.toFixed(1)} rise=${c.rise.toFixed(1)} above=${c.above.toFixed(1)} atk=${det.attackAge}ms nearSame=${near} sounding=[${sounding}]`);
    }
  }
}
