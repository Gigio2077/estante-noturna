/* Escuta pelo microfone: detecção polifônica simples por soma de harmônicos + detecção de ataque por nota.
   Emite "ataques" (onsets) de notas MIDI. A prática decide se estão certos. */
const Listener = (() => {
  const LO = 28, HI = 104;                 // Mi0 .. Sol#7
  const HW = [1, 0.8, 0.65, 0.5, 0.42, 0.36];
  const HIST = 8;                          // quadros de histórico (~160 ms)
  const FRAME_MS = 20;
  const HARM = new Set([12, 19, 24, 28, 31, 34, 36]);

  let ctx, analyser, src, stream, timer = null, running = false, mode = null;
  let dbBuf, timeBuf, mag, ranges, sal, floor, hist, histPos = 0, frames = 0;
  const lastOn = new Float64Array(128);
  const recent = [];                       // [{m, t}] ataques recentes
  const pending = [];                      // candidatos inesperados aguardando confirmação
  let expected = new Set();
  let sens = 5;
  let onOnsets = () => {}, onLevel = () => {};

  function setup(c) {
    ctx = c;
    analyser = ctx.createAnalyser();
    analyser.fftSize = 8192;
    analyser.smoothingTimeConstant = 0;
    analyser.minDecibels = -120; analyser.maxDecibels = 0;
    dbBuf = new Float32Array(analyser.frequencyBinCount);
    timeBuf = new Float32Array(2048);
    mag = new Float32Array(analyser.frequencyBinCount);
    const binHz = ctx.sampleRate / analyser.fftSize;
    const nyq = ctx.sampleRate / 2 * 0.92;
    ranges = [];
    for (let m = 0; m < 128; m++) {
      const r = [];
      if (m >= LO - 1 && m <= HI + 1) {
        const f0 = 440 * Math.pow(2, (m - 69) / 12);
        for (let h = 1; h <= HW.length; h++) {
          const f = f0 * h * Math.sqrt(1 + 0.0004 * h * h);
          if (f > nyq) break;
          let a = Math.floor(f * 0.988 / binHz), b = Math.ceil(f * 1.012 / binHz);
          if (b - a < 2) { a = Math.round(f / binHz) - 1; b = a + 2; }
          a = Math.max(3, a);
          const w = Math.max(2, Math.round(f * 0.03 / binHz));
          r.push([a, b, Math.max(1, a - 2 - w), a - 2, b + 2, b + 2 + w]);
        }
      }
      ranges.push(r);
    }
    sal = new Float32Array(128).fill(-120);
    floor = new Float32Array(128).fill(-60);
    hist = Array.from({ length: HIST }, () => new Float32Array(128).fill(-120));
    frames = 0;
  }

  let work = null, salW = null, eps = 1e-6;
  const samp = new Float32Array(600);

  function salience(m, M) {
    const r = ranges[m]; let s = 0, p1 = 0, p2 = 0, p23 = 0, phi = 0;
    for (let h = 0; h < r.length; h++) {
      const q = r[h];
      let p = 0; for (let i = q[0]; i <= q[1]; i++) if (M[i] > p) p = M[i];
      // o harmônico precisa ser um pico estreito: ataques e ruído de banda larga não contam
      let side = 0, cnt = 0;
      for (let i = q[2]; i <= q[3]; i++) { side += M[i]; cnt++; }
      for (let i = q[4]; i <= q[5] && i < M.length; i++) { side += M[i]; cnt++; }
      const prom = p / (side / Math.max(1, cnt) + eps * 0.5);
      p *= Math.max(0, Math.min(1, (prom - 2.5) / 4));
      s += HW[h] * p;
      if (h === 0) p1 = p; else if (h <= 2) p23 = Math.max(p23, p);
      if (h === 1) p2 = p; else if (h >= 2) phi = Math.max(phi, p);
    }
    let d = 20 * Math.log10(s + eps);
    if (m >= 45 && p1 < 0.18 * p23) d -= 12;        // fundamental ausente => provável fantasma
    else if (m < 45 && Math.max(p1, p2) < 0.3 * phi) d -= 12;   // grave "virtual" feito só de harmônicos de outras notas
    return d;
  }

  function tick() {
    if (!running) return;
    analyser.getFloatFrequencyData(dbBuf);
    for (let i = 0; i < dbBuf.length; i++) mag[i] = dbBuf[i] > -200 ? Math.pow(10, dbBuf[i] / 20) : 0;
    analyser.getFloatTimeDomainData(timeBuf);
    let rms = 0; for (let i = 0; i < timeBuf.length; i++) rms += timeBuf[i] * timeBuf[i];
    rms = Math.sqrt(rms / timeBuf.length);
    onLevel(Math.min(1, rms * 12));

    // piso de ruído de banda larga (mediana do espectro)
    for (let k = 0; k < samp.length; k++) samp[k] = mag[20 + k * 5] || 0;
    const sorted = Array.from(samp).sort((x, y) => x - y);
    eps = Math.max(1e-7, sorted[sorted.length >> 1] * 2);

    let gmax = -300;
    for (let m = LO - 1; m <= HI + 1; m++) {
      sal[m] = salience(m, mag);
      if (m >= LO && m <= HI && sal[m] > gmax) gmax = sal[m];
    }
    const epsDb = 20 * Math.log10(eps);

    // estimativa iterativa: pega a nota mais forte, atenua seus harmônicos, repete
    if (!work || work.length !== mag.length) { work = new Float32Array(mag.length); salW = new Float32Array(128); }
    work.set(mag); salW.set(sal);
    const present = new Map();
    for (let it = 0; it < 7; it++) {
      let best = -1, bv = -300;
      for (let m = LO; m <= HI; m++) if (!present.has(m) && salW[m] > bv) { bv = salW[m]; best = m; }
      if (best < 0 || bv < gmax - 22 || bv < epsDb + 14) break;
      present.set(best, bv);
      for (const q of ranges[best]) for (let i = q[0] - 1; i <= q[1] + 1; i++) work[i] *= 0.2;
      for (let m = LO - 1; m <= HI + 1; m++) if (!present.has(m)) salW[m] = salience(m, work);
    }

    const now = performance.now();
    const RISE = 9 - sens * 0.6, ABOVE = 17 - sens;
    const cands = [];
    if (frames > HIST) {
      for (let m = LO; m <= HI; m++) {
        const exp = expected.has(m), pres = present.has(m);
        if (!exp && !pres) continue;
        let mn = 999; for (let k = 0; k < HIST; k++) if (hist[k][m] < mn) mn = hist[k][m];
        const rise = sal[m] - mn, above = sal[m] - floor[m];
        if (rise < (exp ? RISE - 2.5 : RISE)) continue;
        if (above < (exp ? ABOVE - 4 : ABOVE)) continue;
        if (!pres && (sal[m] < gmax - 30 || sal[m] < sal[m - 1] || sal[m] < sal[m + 1])) continue;
        if (now - lastOn[m] < HIST * FRAME_MS + 20) continue;
        cands.push({ m, db: sal[m], rise, above, exp, present: pres });
      }
    }
    // atualizar histórico e piso por nota
    const hrow = hist[histPos]; histPos = (histPos + 1) % HIST;
    for (let m = LO - 1; m <= HI + 1; m++) {
      hrow[m] = sal[m];
      if (frames < 5) floor[m] = sal[m];
      else if (sal[m] < floor[m]) floor[m] = floor[m] * 0.7 + sal[m] * 0.3;
      else floor[m] += 0.04;
    }
    frames++;

    // notas esperadas saem já; inesperadas esperam 2 quadros e só valem se ainda forem notas "de verdade"
    const out = [];
    for (let i = pending.length - 1; i >= 0; i--) {
      const pc = pending[i];
      if (frames < pc.due) continue;
      pending.splice(i, 1);
      if (present.has(pc.m)) out.push(pc);
    }
    for (const c of cands) {
      lastOn[c.m] = now;
      if (c.exp) out.push(c);
      else if (c.present) pending.push(Object.assign(c, { due: frames + 2 }));
    }
    if (out.length) {
      out.sort((a, b) => b.db - a.db);
      while (recent.length && now - recent[0].t > 500) recent.shift();
      for (const c of out) {
        c.harmonic = !present.has(c.m) ||
          recent.some(r => r.m !== c.m && (HARM.has(c.m - r.m) || HARM.has(r.m - c.m))) ||
          (!c.exp && [...expected].some(e => HARM.has(c.m - e) || HARM.has(e - c.m)));
      }
      for (const c of out) if (present.has(c.m)) recent.push({ m: c.m, t: now });
      onOnsets(out);
    }
  }

  async function startMic() {
    const c = Sound.ensure();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('insecure');
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    if (!analyser || ctx !== c) setup(c);
    src = c.createMediaStreamSource(stream);
    src.connect(analyser);
    begin('mic');
  }
  /** Autoteste: escuta o próprio sintetizador em vez do microfone. */
  function startLoopback() {
    const c = Sound.ensure();
    if (!analyser || ctx !== c) setup(c);
    Sound.setTap(analyser);
    // um pouco de ruído para imitar um microfone de verdade
    const len = c.sampleRate * 2, nb = c.createBuffer(1, len, c.sampleRate), d = nb.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * 0.002;
    const ns = c.createBufferSource(); ns.buffer = nb; ns.loop = true; ns.connect(analyser); ns.start();
    begin('loopback');
  }
  function begin(m) {
    mode = m; running = true; frames = 0;
    clearInterval(timer); timer = setInterval(tick, FRAME_MS);
  }
  function stop() {
    running = false; clearInterval(timer); timer = null;
    if (src) { try { src.disconnect(); } catch (e) {} src = null; }
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    if (mode === 'loopback') Sound.setTap(null);
    mode = null; onLevel(0);
  }

  return {
    startMic, startLoopback, stop,
    get running() { return running; },
    get mode() { return mode; },
    setExpected(arr) { expected = new Set(arr); },
    setSensitivity(v) { sens = v; },
    onOnsets(fn) { onOnsets = fn; },
    onLevel(fn) { onLevel = fn; },
  };
})();
