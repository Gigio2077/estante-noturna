/* Escuta: microfone (ou o próprio som do app, no autoteste) -> PitchDetector (detector.js). */
const Listener = (() => {
  const FRAME_MS = 20;
  let ctx, analyser, keepAlive, src, stream, timer = null, running = false, mode = null, det = null, buf = null;
  let sens = 5, expected = [];
  let onOnsets = () => {}, onLevel = () => {};

  function setup(c) {
    ctx = c;
    analyser = ctx.createAnalyser();
    analyser.fftSize = 8192;
    analyser.smoothingTimeConstant = 0;
    // mantém o nó sendo processado em todos os navegadores (Safari só puxa o que chega ao destino)
    keepAlive = ctx.createGain(); keepAlive.gain.value = 0;
    analyser.connect(keepAlive); keepAlive.connect(ctx.destination);
    buf = new Float32Array(analyser.fftSize);
    det = new PitchDetector(ctx.sampleRate, { fftSize: 8192, frameMs: FRAME_MS });
    det.setSensitivity(sens); det.setExpected(expected);
  }

  function tick() {
    if (!running) return;
    analyser.getFloatTimeDomainData(buf);
    const ons = det.process(buf, performance.now());
    onLevel(Math.min(1, det.level * 12));
    if (ons.length) onOnsets(ons);
  }

  async function startMic() {
    const c = Sound.ensure();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('insecure');
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    if (!analyser || ctx !== c) setup(c);
    src = c.createMediaStreamSource(stream);
    src.connect(analyser);
    if (c.state === 'suspended') await c.resume();
    begin('mic');
  }
  /** Autoteste: escuta o próprio som do app em vez do microfone. */
  function startLoopback() {
    const c = Sound.ensure();
    if (!analyser || ctx !== c) setup(c);
    Sound.setTap(analyser);
    const len = c.sampleRate * 2, nb = c.createBuffer(1, len, c.sampleRate), d = nb.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * 0.002;
    const ns = c.createBufferSource(); ns.buffer = nb; ns.loop = true; ns.connect(analyser); ns.start();
    begin('loopback');
  }
  function begin(m) {
    mode = m; running = true;
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
    get detector() { return det; },
    setExpected(arr) { expected = arr; if (det) det.setExpected(arr); },
    setSensitivity(v) { sens = v; if (det) det.setSensitivity(v); },
    onOnsets(fn) { onOnsets = fn; },
    onLevel(fn) { onLevel = fn; },
  };
})();
