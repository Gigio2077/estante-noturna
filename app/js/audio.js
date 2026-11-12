/* Síntese simples de piano (aditiva) para referência, acompanhamento e metrônomo. */
const Sound = (() => {
  let ctx = null, master = null, bus = null, tap = null;
  const voices = new Set();
  // amostras do piano (Salamander Grand Piano, Yamaha C5), a cada terça menor
  const piano = new Map();          // midi -> AudioBuffer
  let pianoLoading = null;
  const SAMPLE_NAMES = [];
  for (let o = 0; o <= 7; o++) for (const [n, k] of [['C', 0], ['Ds', 3], ['Fs', 6], ['A', 9]]) {
    const midi = 12 * (o + 1) + k; if (midi >= 21) SAMPLE_NAMES.push([n + o, midi]);
  }
  SAMPLE_NAMES.push(['C8', 108]);
  function loadPiano() {
    if (pianoLoading || !ctx) return pianoLoading;
    pianoLoading = Promise.all(SAMPLE_NAMES.map(async ([name, midi]) => {
      try {
        const r = await fetch(`samples/piano/${name}.mp3`);
        if (!r.ok) return;
        piano.set(midi, await ctx.decodeAudioData(await r.arrayBuffer()));
      } catch (e) { /* sem amostra: usa o sintetizador */ }
    }));
    return pianoLoading;
  }
  function nearestSample(m) {
    let best = null, bd = 99;
    for (const k of piano.keys()) { const d = Math.abs(k - m); if (d < bd) { bd = d; best = k; } }
    return bd <= 3 ? best : null;
  }
  function sampleNote(m, dur, vel, t0) {
    const k = nearestSample(m); if (k == null) return null;
    const srcN = ctx.createBufferSource(); srcN.buffer = piano.get(k);
    srcN.playbackRate.value = Math.pow(2, (m - k) / 12);
    const g = ctx.createGain();
    const amp = 0.9 * Math.pow(vel, 1.4);
    g.gain.setValueAtTime(amp, t0);
    const end = t0 + Math.max(0.15, dur);
    g.gain.setValueAtTime(amp, end);
    g.gain.setTargetAtTime(0, end, 0.12);
    srcN.connect(g); g.connect(bus); if (tap) g.connect(tap);
    srcN.start(t0); srcN.stop(end + 1);
    const v = { out: g, oscs: [srcN], end };
    voices.add(v);
    srcN.onended = () => { voices.delete(v); try { g.disconnect(); } catch (e) {} };
    return v;
  }

  function ensure() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      master = ctx.createGain(); master.gain.value = 0.55;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18; comp.ratio.value = 4;
      bus = ctx.createGain();
      bus.connect(master); master.connect(comp); comp.connect(ctx.destination);
      loadPiano();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  const freq = m => 440 * Math.pow(2, (m - 69) / 12);

  /** Toca uma nota. when: tempo do AudioContext (0 = agora). */
  function note(m, dur = 0.6, vel = 0.7, when = 0) {
    ensure();
    const t0 = Math.max(ctx.currentTime, when || 0);
    if (piano.size) { const v = sampleNote(m, dur, vel, t0); if (v) return v; }
    const f = freq(m);
    const out = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.min(16000, f * (5 + 10 * vel));
    out.connect(lp); lp.connect(bus);
    if (tap) lp.connect(tap);
    const B = 0.00035, oscs = [];
    const partials = f < 130 ? 8 : f < 500 ? 6 : 4;
    const decayBase = 1.6 * Math.pow(261.6 / f, 0.45);
    for (let k = 1; k <= partials; k++) {
      const fk = f * k * Math.sqrt(1 + B * k * k);
      if (fk > 15000) break;
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = fk;
      const g = ctx.createGain();
      const amp = vel * 0.22 / Math.pow(k, f < 200 ? 0.8 : 1.25) * (k === 1 && f < 90 ? 0.6 : 1);
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(amp, t0 + 0.004);
      g.gain.setTargetAtTime(amp * 0.35, t0 + 0.004, 0.08 / Math.sqrt(k));
      g.gain.setTargetAtTime(0.0001, t0 + 0.12, decayBase / Math.sqrt(k));
      o.connect(g); g.connect(out); o.start(t0); oscs.push(o);
    }
    const end = t0 + Math.max(0.12, dur);
    out.gain.setValueAtTime(1, end);
    out.gain.setTargetAtTime(0, end, 0.09);
    oscs.forEach(o => o.stop(end + 0.6));
    const v = { out, oscs, end };
    voices.add(v);
    oscs[0].onended = () => { voices.delete(v); try { out.disconnect(); lp.disconnect(); } catch (e) {} };
    return v;
  }

  function click(accent = false, when = 0) {
    ensure();
    const t0 = Math.max(ctx.currentTime, when || 0);
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'square'; o.frequency.value = accent ? 1760 : 1175;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(accent ? 0.18 : 0.1, t0 + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.05);
    o.connect(g); g.connect(master); if (tap) g.connect(tap);
    o.start(t0); o.stop(t0 + 0.06);
  }

  function stopAll() {
    if (!ctx) return;
    const now = ctx.currentTime;
    voices.forEach(v => { try { v.out.gain.cancelScheduledValues(now); v.out.gain.setTargetAtTime(0, now, 0.03); v.oscs.forEach(o => o.stop(now + 0.2)); } catch (e) {} });
    voices.clear();
  }

  return {
    ensure, note, click, stopAll, freq, loadPiano,
    get pianoReady() { return piano.size > 0; },
    get ctx() { return ctx; },
    get now() { return ctx ? ctx.currentTime : 0; },
    /** Encaminha o som do sintetizador para um nó extra (usado no autoteste da escuta). */
    setTap(node) { tap = node; },
    setMuted(mu) { if (master) master.gain.value = mu ? 0 : 0.55; },
  };
})();
