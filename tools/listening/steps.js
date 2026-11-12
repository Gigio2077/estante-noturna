// Gera/analisa uma sequência de passos (um a cada 1,2 s) para diagnóstico do caminho acústico.
const sim = require('./sim.js'), perf = require('./perf.js');
const { SR, piece, Practice, PitchDetector, Mixer } = sim;
const cmd = process.argv[2], sc = JSON.parse(process.argv[3]);
const p = new Practice(piece, { hand: sc.hand, fromBar: sc.from, toBar: sc.to, mode: 'wait' });
const GAP = sc.gap || 1.2, T0 = 1.0;
(async () => {
  if (cmd === 'render') {
    const samples = await sim.loadSamples();
    const mix = new Mixer(samples, { hp: 20, noise: 0, gain: 0.7 });
    const len = Math.ceil((T0 + p.steps.length * GAP + 2) * SR), x = new Float32Array(len);
    let k = 0, lastBar = -1;
    for (let i = 0; i < len; i += 480) {
      const t = i / SR;
      while (k < p.steps.length && T0 + k * GAP <= t) {
        const s = p.steps[k++]; if (s.bar !== lastBar) { mix.damp(); lastBar = s.bar; }
        for (const n of s.notes) mix.noteOn(n.m, n.h === 'L' ? 0.5 : 0.75, Math.round(Math.random() * 0.02 * SR));
      }
      x.set(mix.render(Math.min(480, len - i)), i);
    }
    perf.writeWav(sc.out, x); console.log('ok', len / SR);
  } else {
    const rec = perf.readWav(sc.rec).x, ref = perf.readWav(sc.ref).x;
    const lag = perf.findLag(ref, rec);
    const det = new PitchDetector(SR); det.setSensitivity(sc.sens ?? 5);
    const N = det.N, hop = 960, ring = new Float32Array(N);
    const res = p.steps.map(s => ({ notes: s.notes.map(n => n.m), hits: [], attacks: [], others: [] }));
    for (let i = 0; i + hop <= rec.length; i += hop) {
      const now = (i + hop) / SR * 1000, tt = now / 1000 - lag;
      const k = Math.floor((tt - T0 + 0.05) / GAP);
      const cur = k >= 0 && k < res.length ? res[k] : null;
      det.setExpected(cur ? cur.notes.filter(m => !cur.hits.some(h => h.m === m)) : []);
      ring.copyWithin(0, hop); ring.set(rec.subarray(i, i + hop), N - hop);
      const before = det.lastAttack;
      const ons = det.process(ring, now);
      if (!cur) continue;
      const rel = Math.round((tt - (T0 + k * GAP)) * 1000);
      if (det.lastAttack !== before) cur.attacks.push(rel);
      else if (rel >= 0 && rel < 300 && !cur.dbg) { cur.dbg = det.attackInfo; }
      for (const c of ons) (c.exp ? cur.hits : cur.others).push({ m: c.m, rel, harm: c.harmonic });
    }
    let ok = 0;
    for (const [k, r] of res.entries()) {
      const got = new Set(r.hits.map(h => h.m)); const all = r.notes.every(m => got.has(m)); if (all) ok++;
      if (sc.v || !all) console.log(`passo ${k} [${r.notes}] hits ${r.hits.map(h => h.m + '@' + h.rel).join(' ')} | marteladas ${r.attacks.join(',')} | outras ${r.others.filter(o => !o.harm).map(o => o.m + '@' + o.rel).join(' ')} | ${r.dbg ? `cnt ${r.dbg.cnt} med ${r.dbg.med} added/silence ${(10 * Math.log10(r.dbg.added / r.dbg.silence)).toFixed(1)}dB` : ''}`);
    }
    console.log(`lag ${lag}s  reconhecidos ${ok}/${res.length}`);
  }
})();
