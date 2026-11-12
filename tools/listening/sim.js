// Simulador: piano Salamander (Yamaha C5) -> detector -> motor de prática (modo Espera), com um "aluno" que reage ao app.
const fs = require('fs'), path = require('path'), vm = require('vm');
const APP = process.env.APP;
const SAMPLES = process.env.SAMPLES;
const SR = 48000;

const ctx = { window: {}, console, Math, Set, Map, Float32Array, Float64Array, performance: { now: () => 0 } };
ctx.globalThis = ctx; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(APP, 'pieces/chopin-op9-2.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(APP, 'js/practice.js'), 'utf8') + '\nthis.Practice = Practice;', ctx);
const { PitchDetector } = require(path.join(APP, 'js/detector.js'));
const piece = ctx.window.PIECES[0], Practice = ctx.Practice;

// ---------- amostras ----------
const NAMES = { C: 0, Ds: 3, Fs: 6, A: 9 };
async function loadSamples() {
  const dir = path.join(SAMPLES, 'pcm48k'); fs.mkdirSync(dir, { recursive: true });
  const out = {};
  let dec = null;
  for (const f of fs.readdirSync(SAMPLES).filter(f => f.endsWith('.mp3'))) {
    const m = f.match(/^([A-Z]s?)(\d)\.mp3$/); if (!m) continue;
    const midi = 12 * (+m[2] + 1) + NAMES[m[1]];
    const cf = path.join(dir, midi + '.f32');
    if (fs.existsSync(cf)) { const b = fs.readFileSync(cf); out[midi] = new Float32Array(b.buffer, b.byteOffset, b.length / 4); continue; }
    if (!dec) { const { MPEGDecoder } = require('mpg123-decoder'); dec = new MPEGDecoder(); await dec.ready; }
    dec.reset();
    const r = dec.decode(new Uint8Array(fs.readFileSync(path.join(SAMPLES, f))));
    const ch = r.channelData[0], ch2 = r.channelData[1] || ch;
    const ratio = r.sampleRate / SR, len = Math.floor((ch.length - 1) / ratio);
    const x = new Float32Array(len);
    for (let i = 0; i < len; i++) { const q = i * ratio, k = q | 0, fr = q - k; const A = (ch[k] + ch2[k]) / 2, B = (ch[k + 1] + ch2[k + 1]) / 2; x[i] = A + (B - A) * fr; }
    out[midi] = x; fs.writeFileSync(cf, Buffer.from(x.buffer));
  }
  return out;
}

// ---------- ruído ambiente (longe do microfone) ----------
class Interference {
  constructor(type, level, seed = 11) {
    this.type = type; this.level = level; this.t = 0; this.r = seed;
    this.bp = [0, 1, 2].map(() => ({ x1: 0, x2: 0, y1: 0, y2: 0 }));
    this.phase = 0; this.f0 = 140; this.syl = 0; this.form = [700, 1200, 2600]; this.env = 0; this.on = false;
    this.knock = []; this.tones = []; this.toneT = 0; this.pink = [0, 0, 0];
  }
  rand() { return (this.r = (this.r * 16807) % 2147483647) / 2147483647; }
  biquad(st, x, f, q) {
    const w = 2 * Math.PI * f / SR, al = Math.sin(w) / (2 * q), b0 = al, a0 = 1 + al, a1 = -2 * Math.cos(w), a2 = 1 - al;
    const y = (b0 * x - b0 * st.x2 - a1 * st.y1 - a2 * st.y2) / a0;
    st.x2 = st.x1; st.x1 = x; st.y2 = st.y1; st.y1 = y; return y;
  }
  voice() {
    // sílabas de 120-320 ms, pausas; pulso glótico filtrado por 3 formantes; pitch deslizando
    if (--this.syl <= 0) {
      this.on = this.rand() > 0.25;
      this.syl = Math.round((0.12 + this.rand() * 0.2) * SR);
      const V = [[730, 1090, 2440], [270, 2290, 3010], [530, 1840, 2480], [570, 840, 2410], [300, 870, 2240]];
      this.form = V[Math.floor(this.rand() * V.length)];
      this.f0t = 100 + this.rand() * 140;
    }
    this.f0 += ((this.f0t || 140) - this.f0) * 0.0005;
    this.env += ((this.on ? 1 : 0) - this.env) * 0.003;
    this.phase += this.f0 / SR; let g = 0; if (this.phase >= 1) { this.phase -= 1; g = 1; }
    const src = g * 4 + (this.rand() - 0.5) * 0.05;
    let y = 0; for (let k = 0; k < 3; k++) y += this.biquad(this.bp[k], src, this.form[k], 6) / (k + 1);
    return y * this.env;
  }
  music() {
    // "TV com música": acordes de tons harmônicos mudando a cada ~0.5 s
    if (this.toneT-- <= 0) {
      this.toneT = Math.round((0.3 + this.rand() * 0.5) * SR);
      const root = 48 + Math.floor(this.rand() * 24);
      this.tones = [root, root + 4, root + 7, root + 12 + Math.floor(this.rand() * 5)].map(m => ({ f: 440 * Math.pow(2, (m - 69) / 12), ph: 0, a: 0.5 + this.rand() * 0.5 }));
      this.mEnv = 1;
    }
    this.mEnv *= 0.99995;
    let y = 0;
    for (const t of this.tones) { t.ph += t.f / SR; for (let h = 1; h <= 4; h++) y += Math.sin(2 * Math.PI * t.ph * h) * t.a / (h * h); }
    return y * 0.25 * this.mEnv;
  }
  knocks() {
    if (this.rand() < 1 / (SR * 0.9)) this.knock.push({ f: 70 + this.rand() * 200, t: 0, a: 0.5 + this.rand() });
    let y = 0;
    for (const k of this.knock) { y += Math.sin(2 * Math.PI * k.f * k.t / SR) * Math.exp(-k.t / (0.03 * SR)) * k.a + (k.t < 40 ? (this.rand() - 0.5) * k.a : 0); k.t++; }
    this.knock = this.knock.filter(k => k.t < 0.3 * SR);
    return y;
  }
  hiss() {
    const w = this.rand() * 2 - 1; this.pink[0] = 0.99 * this.pink[0] + w * 0.1; this.pink[1] = 0.9 * this.pink[1] + w * 0.3;
    if (this.rand() < 1 / (SR * 1.5)) this.burst = 0.4 * SR;
    const b = this.burst > 0 ? (this.burst--, 1) : 0.15;
    return (this.pink[0] + this.pink[1] + w * 0.2) * b;
  }
  sample() {
    switch (this.type) {
      case 'voz': return this.voice() * this.level;
      case 'tv': return (this.voice() * 0.6 + this.music()) * this.level;
      case 'batidas': return this.knocks() * this.level;
      case 'chiado': return this.hiss() * this.level;
      default: return 0;
    }
  }
}

// ---------- mixer ----------
class Mixer {
  constructor(samples, opts) {
    this.s = samples; this.keys = Object.keys(samples).map(Number).sort((a, b) => a - b);
    this.voices = []; this.t = 0; this.o = opts;
    this.hpPrev = 0; this.hpOut = 0;
    this.intf = opts.interf ? new Interference(opts.interf.type, opts.interf.level, opts.seed || 11) : null;
  }
  noteOn(m, vel, delaySamples = 0) {
    let best = this.keys[0]; for (const k of this.keys) if (Math.abs(k - m) < Math.abs(best - m)) best = k;
    this.voices.push({ buf: this.s[best], rate: Math.pow(2, (m - best) / 12), pos: -delaySamples, gain: vel, rel: null, m });
  }
  damp(filter) { for (const v of this.voices) if (!v.rel && (!filter || filter(v))) v.rel = 1; }
  render(n) {
    const out = new Float32Array(n);
    const relK = Math.exp(-1 / (0.12 * SR));
    for (const v of this.voices) {
      for (let i = 0; i < n; i++) {
        const p = v.pos * v.rate; v.pos++;
        if (p < 0) continue;
        const k = p | 0; if (k + 1 >= v.buf.length) { v.done = true; break; }
        let g = v.gain; if (v.rel != null) { v.rel *= relK; g *= v.rel; if (v.rel < 1e-4) { v.done = true; break; } }
        out[i] += (v.buf[k] + (v.buf[k + 1] - v.buf[k]) * (p - k)) * g;
      }
    }
    this.voices = this.voices.filter(v => !v.done);
    // "microfone de celular": passa-altas ~100 Hz, ganho, ruído de sala
    const a = Math.exp(-2 * Math.PI * (this.o.hp || 100) / SR);
    for (let i = 0; i < n; i++) {
      const x = out[i] * (this.o.gain || 1);
      this.hpOut = a * (this.hpOut + x - this.hpPrev); this.hpPrev = x;
      out[i] = this.hpOut + (Math.random() * 2 - 1) * (this.o.noise ?? 0.002) + (this.intf ? this.intf.sample() : 0);
    }
    return out;
  }
}

function simulate(samples, sc) {
  const p = new Practice(piece, { hand: sc.hand, fromBar: sc.from, toBar: sc.to, mode: 'wait', speed: 0.5, strict: sc.strict || 'normal' });
  const det = new PitchDetector(SR); det.setSensitivity(sc.sens ?? 5);
  const mix = new Mixer(samples, sc);
  const N = det.N, hop = Math.round(SR * 0.02), ring = new Float32Array(N);
  let now = 0, lastIdx = -1, nextPlay = 0, tries = 0, replays = 0, falseWrong = 0, flagged = 0, loud = null, lastBar = -1, injected = 0;
  let falseAdv = 0, playedAt = null; const lat = [];
  const log = [];
  p.on('wrong', (m, s) => { flagged++; log.push(`wrong ${m} @step ${p.idx} bar ${s.bar} exp ${s.notes.map(n => n.m)} t=${now}`); });
  p.on('hit', (m, s) => { if (sc.logHits) log.push(`hit ${m} step ${p.idx} [${s.notes.map(n => n.m)}] t=${now} played=${playedAt}`); });
  p.start(0);
  const limit = p.steps.length * 4000 + 3000;
  let rnd = sc.seed || 1; const rand = () => (rnd = (rnd * 16807) % 2147483647) / 2147483647;
  while (!p.finished && now < limit) {
    if (p.idx !== lastIdx) {
      if (lastIdx >= 0 && playedAt == null) falseAdv++;                 // avançou sem o aluno tocar
      if (lastIdx >= 0 && playedAt != null && tries === 1) lat.push(now - playedAt);
      lastIdx = p.idx; nextPlay = now + (sc.pauseMs || 250) + rand() * 200; tries = 0; playedAt = null;
    }
    if (now >= nextPlay) {
      const s = p.current;
      if (s) {
        if (s.bar !== lastBar) { mix.damp(); lastBar = s.bar; }     // troca de pedal no compasso
        const wrongNow = sc.wrongEvery && tries === 0 && p.idx % sc.wrongEvery === sc.wrongEvery - 1;
        if (wrongNow) { injected++; mix.noteOn(s.notes[0].m + 1, 0.7); nextPlay = now + 500; tries++; }
        else {
          if (tries > 0) replays++;
          let d0 = 1e9;
          for (const n of s.notes) { const d = Math.round(rand() * 0.025 * SR); d0 = Math.min(d0, d); mix.noteOn(n.m, (n.h === 'L' ? 0.45 : 0.75) * (0.8 + rand() * 0.4) * (sc.vel || 1), d); }
          if (playedAt == null) playedAt = now + d0 / SR * 1000;
          tries++; nextPlay = now + 1600;
        }
      }
    }
    const blk = mix.render(hop);
    ring.copyWithin(0, hop); ring.set(blk, N - hop);
    det.setExpected(p.started && !p.finished ? p.expected : []);
    const ons = det.process(ring, now);
    for (const c of ons) {
      if (c.exp) { const r = p.input(c.m, now, 'mic', c.attack); if (r === 'hit') loud = loud == null ? c.db : loud * 0.8 + c.db * 0.2; }
      else if (!c.harmonic && (loud == null || c.db >= loud - 8)) p.input(c.m, now, 'mic', c.attack);
    }
    p.update(now);
    now += 20;
  }
  falseWrong = flagged - injected;
  lat.sort((a, b) => a - b);
  const q = f => lat.length ? Math.round(lat[Math.min(lat.length - 1, Math.floor(lat.length * f))]) : null;
  return { name: sc.name, steps: p.steps.length, done: p.idx, finished: p.finished, replays, flagged, injected, falseWrong, falseAdv, latMed: q(0.5), latP90: q(0.9), secs: Math.round(now / 1000), log: log.slice(0, sc.showLog || 0) };
}

module.exports = { loadSamples, simulate, Mixer, piece, Practice, PitchDetector, SR };

if (require.main === module) (async () => {
  const samples = await loadSamples();
  const scen = JSON.parse(process.argv[2] || '[]');
  for (const sc of scen) {
    const r = simulate(samples, sc);
    console.log(JSON.stringify(r));
  }
})();
