// Teste acústico em tempo real: alto-falante (pw-play) -> ar -> microfone (pw-record) -> detector -> motor (modo Espera).
const { spawn } = require('child_process');
const sim = require('./sim.js');
const { SR, piece, Practice, PitchDetector, Mixer } = sim;

(async () => {
  const sc = JSON.parse(process.argv[2]);
  const samples = await sim.loadSamples();
  const play = spawn('pw-play', ['--raw', '--rate', String(SR), '--channels', '1', '--format', 'f32', '--latency', '20ms', '-'], { stdio: ['pipe', 'ignore', 'ignore'] });
  const rec = spawn('pw-record', ['--raw', '--rate', String(SR), '--channels', '1', '--format', 'f32', '--latency', '20ms', '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const p = new Practice(piece, { hand: sc.hand, fromBar: sc.from, toBar: sc.to, mode: 'wait', speed: 0.5, strict: sc.strict || 'normal' });
  const det = new PitchDetector(SR); det.setSensitivity(sc.sens ?? 5);
  const mix = new Mixer(samples, { hp: 20, noise: 0, gain: sc.gain || 0.7 });
  const N = det.N, ring = new Float32Array(N);
  let loud = null, lastIdx = -1, nextPlay = 0, tries = 0, replays = 0, flagged = 0, injected = 0, lastBar = -1;
  let falseAdv = 0, playedAt = null; const lat = [];
  const log = [];
  p.on('wrong', (m, s) => { flagged++; log.push(`errada ${m} no passo ${p.idx} (c.${s.bar}, esperado ${s.notes.map(n => n.m)})`); });
  const t0 = Date.now(); const now = () => Date.now() - t0;
  p.start(0);
  // gerador: 20 ms de áudio a cada 20 ms, adiantado ~60 ms
  let produced = 0;
  const gen = setInterval(() => {
    const target = (now() + 60) / 1000 * SR;
    while (produced < target) {
      const t = now();
      if (p.idx !== lastIdx) {
        if (lastIdx >= 0 && playedAt == null) falseAdv++;
        if (lastIdx >= 0 && playedAt != null && tries === 1) lat.push(t - playedAt);
        lastIdx = p.idx; nextPlay = t + (sc.pauseMs || 300); tries = 0; playedAt = null;
      }
      if (t >= nextPlay && !p.finished) {
        const s = p.current;
        if (s) {
          if (s.bar !== lastBar) { mix.damp(); lastBar = s.bar; }
          if (sc.wrongEvery && tries === 0 && p.idx % sc.wrongEvery === sc.wrongEvery - 1) { injected++; mix.noteOn(s.notes[0].m + 1, 0.7); nextPlay = t + 700; tries++; }
          else {
            if (tries > 0) replays++;
            for (const n of s.notes) mix.noteOn(n.m, (n.h === 'L' ? 0.5 : 0.75), Math.round(Math.random() * 0.02 * SR));
            if (playedAt == null) playedAt = t + (produced / SR * 1000 - t);   // instante em que o bloco com a nota sai
            tries++; nextPlay = t + 1800;
          }
        }
      }
      const blk = mix.render(960); produced += 960;
      play.stdin.write(Buffer.from(blk.buffer));
    }
  }, 10);
  let pend = Buffer.alloc(0);
  rec.stdout.on('data', d => {
    pend = Buffer.concat([pend, d]);
    while (pend.length >= 960 * 4) {
      const chunk = new Float32Array(pend.buffer.slice(pend.byteOffset, pend.byteOffset + 960 * 4));
      pend = pend.subarray(960 * 4);
      ring.copyWithin(0, 960); ring.set(chunk, N - 960);
      const t = now();
      det.setExpected(p.started && !p.finished ? p.expected : []);
      for (const c of det.process(ring, t)) {
        if (c.exp) { const r = p.input(c.m, t, 'mic', c.attack); if (r === 'hit') loud = loud == null ? c.db : loud * 0.8 + c.db * 0.2; }
        else if (!c.harmonic && (loud == null || c.db >= loud - 8)) p.input(c.m, t, 'mic', c.attack);
      }
      p.update(t);
    }
  });
  const limit = p.steps.length * 4000 + 4000;
  const done = await new Promise(res => { const iv = setInterval(() => { if (p.finished || now() > limit) { clearInterval(iv); res(); } }, 100); });
  clearInterval(gen); play.stdin.end(); rec.kill(); setTimeout(() => play.kill(), 500);
  lat.sort((a, b) => a - b);
  console.log(JSON.stringify({ name: sc.name, steps: p.steps.length, done: p.idx, replays, falseAdv, injected, flagged, falseWrong: flagged - injected, latMed: lat.length ? Math.round(lat[lat.length >> 1]) : null, secs: Math.round(now() / 1000), log: log.slice(0, 4) }));
  setTimeout(() => process.exit(0), 800);
})();
