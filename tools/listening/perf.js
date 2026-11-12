// Gera uma execução no andamento (WAV) e avalia gravações com o motor no modo "No ritmo".
const fs = require('fs');
const sim = require('./sim.js');
const { SR, piece, Practice, PitchDetector, Mixer } = sim;

function writeWav(file, x) {
  const b = Buffer.alloc(44 + x.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + x.length * 2, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(SR, 24);
  b.writeUInt32LE(SR * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(x.length * 2, 40);
  for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(x[i] * 32767))), 44 + i * 2);
  fs.writeFileSync(file, b);
}
function readWav(file) {
  const b = fs.readFileSync(file);
  let off = 12, fmt = null, data = null;
  while (off < b.length - 8) {
    const id = b.toString('ascii', off, off + 4), sz = b.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(off + 10), sr: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22), fmt: b.readUInt16LE(off + 8) };
    if (id === 'data') { data = b.subarray(off + 8, off + 8 + Math.min(sz, b.length - off - 8)); break; }
    off += 8 + sz + (sz & 1);
  }
  const bps = fmt.bits / 8, n = Math.floor(data.length / bps / fmt.ch), x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < fmt.ch; c++) {
      const o = (i * fmt.ch + c) * bps;
      s += fmt.fmt === 3 ? data.readFloatLE(o) : fmt.bits === 16 ? data.readInt16LE(o) / 32768 : data.readInt32LE(o) / 2147483648;
    }
    x[i] = s / fmt.ch;
  }
  return { x, sr: fmt.sr };
}

/** Execução: todas as notas do trecho (as duas mãos soam), pedal trocado a cada meio compasso. */
function render(samples, sc) {
  const p = new Practice(piece, { hand: sc.hand, fromBar: sc.from, toBar: sc.to, mode: 'tempo', speed: sc.speed });
  const wps = p.wps, lead = 1.6, t0 = p.t0;
  const notes = piece.notes.filter(n => n.bar >= sc.from && n.bar <= sc.to && (sc.allHands || sc.hand === 'B' || n.h === sc.hand));
  const dur = lead + (p.t1 - t0) / wps + 2.5;
  const mix = new Mixer(samples, { hp: 20, noise: 0, gain: sc.gain || 0.8 });
  const out = new Float32Array(Math.ceil(dur * SR));
  const hop = 480; let k = 0, lastHalf = -1;
  let rnd = 7; const rand = () => (rnd = (rnd * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < out.length; i += hop) {
    const tSec = i / SR, tMus = t0 + (tSec - lead) * wps;
    const half = Math.floor((tMus - piece.bars[1]) / 0.75);
    if (half !== lastHalf && tMus >= t0) { mix.damp(); lastHalf = half; }
    while (k < notes.length && notes[k].t <= tMus) {
      const n = notes[k++];
      const v = (n.h === 'L' ? 0.42 : 0.8) * (0.85 + rand() * 0.3);
      mix.noteOn(n.m, v, Math.round(rand() * 0.015 * SR));
    }
    out.set(mix.render(Math.min(hop, out.length - i)), i);
  }
  return { x: out, lead, wps };
}

/** Avalia um sinal com o motor no modo No ritmo; offsetSec = atraso da gravação. */
function evaluate(x, sc, offsetSec = 0) {
  const p = new Practice(piece, { hand: sc.hand, fromBar: sc.from, toBar: sc.to, mode: 'tempo', speed: sc.speed, strict: sc.strict || 'normal' });
  const det = new PitchDetector(SR); det.setSensitivity(sc.sens ?? 5);
  const N = det.N, hop = 960, ring = new Float32Array(N);
  const wrongs = [], misses = [];
  p.on('wrong', (m, s) => wrongs.push(`${m}@c${s.bar}[${s.notes.map(n => n.m)}]`));
  p.on('miss', s => misses.push(`c${s.bar}[${s.notes.map(n => n.m)}]hit:${[...s.hit]}`));
  p.start(offsetSec * 1000);           // o relógio do motor começa junto com o áudio (com o atraso medido)
  let loud = null, maxLevel = 0;
  for (let i = 0; i + hop <= x.length && !p.finished; i += hop) {
    const now = (i + hop) / SR * 1000;
    ring.copyWithin(0, hop); ring.set(x.subarray(i, i + hop), N - hop);
    p.update(now);
    det.setExpected(p.started && !p.finished ? p.expected : []);
    const ons = det.process(ring, now);
    maxLevel = Math.max(maxLevel, det.level);
    for (const c of ons) {
      if (c.exp) { const r = p.input(c.m, now, 'mic'); if (r === 'hit') loud = loud == null ? c.db : loud * 0.8 + c.db * 0.2; }
      else if (!c.harmonic && (loud == null || c.db >= loud - 8)) p.input(c.m, now, 'mic');
    }
  }
  if (!p.finished) p.finish(x.length / SR * 1000);
  const r = p.result;
  return { name: sc.name, steps: r.steps, acc: Math.round(r.accuracy * 100), misses: misses.length, wrongs: wrongs.length, rmsMax: +maxLevel.toFixed(4), missList: misses.slice(0, sc.show || 0), wrongList: wrongs.slice(0, sc.show || 0) };
}

/** Atraso da gravação em relação ao original (correlação de envelopes de 10 ms). */
function findLag(ref, rec) {
  const env = (x) => { const w = 480, e = new Float32Array(Math.floor(x.length / w)); for (let i = 0; i < e.length; i++) { let s = 0; for (let j = 0; j < w; j++) s += Math.abs(x[i * w + j]); e[i] = s; } return e; };
  const a = env(ref), b = env(rec);
  const d = (e) => { const o = new Float32Array(e.length); for (let i = 1; i < e.length; i++) o[i] = Math.max(0, e[i] - e[i - 1]); return o; };
  const da = d(a), db = d(b);
  let best = 0, bv = -1;
  for (let lag = 0; lag < 300; lag++) { let s = 0; for (let i = 0; i + lag < db.length && i < da.length; i++) s += da[i] * db[i + lag]; if (s > bv) { bv = s; best = lag; } }
  return best * 0.01;
}

module.exports = { render, evaluate, writeWav, readWav, findLag };

if (require.main === module) (async () => {
  const cmd = process.argv[2], sc = JSON.parse(process.argv[3]);
  const samples = await sim.loadSamples();
  if (cmd === 'render') {
    const r = render(samples, sc);
    writeWav(sc.out, r.x);
    console.log(JSON.stringify({ out: sc.out, secs: +(r.x.length / SR).toFixed(1) }));
    console.log(JSON.stringify(evaluate(r.x, sc)));
  } else if (cmd === 'eval') {
    const rec = readWav(sc.rec), ref = readWav(sc.ref);
    if (rec.sr !== SR) throw new Error('sr ' + rec.sr);
    const lag = findLag(ref.x, rec.x);
    let peak = 0; for (const v of rec.x) peak = Math.max(peak, Math.abs(v));
    console.log(JSON.stringify({ lag, peak: +peak.toFixed(3) }));
    for (const s of [].concat(sc.variants || [sc])) {
      const x = s.gain ? rec.x.map(v => v * s.gain) : rec.x;
      console.log(JSON.stringify(evaluate(x, { ...sc, ...s }, lag)));
    }
  }
})();
