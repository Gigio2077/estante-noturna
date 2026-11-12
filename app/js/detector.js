/* Núcleo da escuta: recebe blocos de áudio (domínio do tempo) e devolve ataques de notas MIDI.
   Sem dependências do navegador, para rodar igual no app e nos testes. */
(function (root) {
  const HW = [1, 0.8, 0.65, 0.5, 0.42, 0.36];
  const HARM = new Set([12, 19, 24, 28, 31, 34, 36]);

  function fftInPlace(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = a + len / 2;
          const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
          const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
  }

  class PitchDetector {
    constructor(sampleRate, opts = {}) {
      this.sr = sampleRate;
      this.N = opts.fftSize || 8192;
      this.LO = 28; this.HI = 104;
      this.HIST = 8;
      this.frameMs = opts.frameMs || 20;
      this.sens = 5;
      this.expected = new Set();
      const N = this.N;
      this.win = new Float32Array(N);
      for (let i = 0; i < N; i++) this.win[i] = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / N) + 0.08 * Math.cos(4 * Math.PI * i / N);
      this.re = new Float64Array(N); this.im = new Float64Array(N);
      this.mag = new Float32Array(N / 2);
      this.work = new Float32Array(N / 2);
      const binHz = sampleRate / N, nyq = sampleRate / 2 * 0.92;
      this.ranges = [];
      for (let m = 0; m < 128; m++) {
        const r = [];
        if (m >= this.LO - 1 && m <= this.HI + 1) {
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
        this.ranges.push(r);
      }
      this.sal = new Float32Array(128).fill(-120);
      this.salW = new Float32Array(128);
      this.floor = new Float32Array(128).fill(-60);
      this.hist = Array.from({ length: this.HIST }, () => new Float32Array(128).fill(-120));
      this.histPos = 0; this.frames = 0;
      this.lastOn = new Float64Array(128).fill(-1e9);
      this.recent = []; this.pending = [];
      this.eps = 1e-6;
      this.level = 0;
      // detector de ataque (martelo): energia dos agudos no trecho mais novo do sinal
      this.hfHist = []; this.lastAttack = -1e9; this.attackGate = opts.attackGate ?? true;
      this.hopSamples = Math.round(sampleRate * this.frameMs / 1000);
    }
    setExpected(arr) { this.expected = new Set(arr); }
    setSensitivity(v) { this.sens = v; }

    salience(m, M) {
      const r = this.ranges[m], eps = this.eps; let s = 0, p1 = 0, p2 = 0, pmax = 0;
      const ps = this._ps || (this._ps = new Float32Array(8));
      for (let h = 0; h < r.length; h++) {
        const q = r[h];
        let p = 0; for (let i = q[0]; i <= q[1]; i++) if (M[i] > p) p = M[i];
        let side = 0, cnt = 0;
        for (let i = q[2]; i <= q[3]; i++) { side += M[i]; cnt++; }
        for (let i = q[4]; i <= q[5] && i < M.length; i++) { side += M[i]; cnt++; }
        const prom = p / (side / Math.max(1, cnt) + eps * 0.5);
        p *= Math.max(0, Math.min(1, (prom - 2.5) / 4));
        s += HW[h] * p;
        if (h === 0) p1 = p; else if (h === 1) p2 = p;
        if (p > pmax) pmax = p;
        ps[h] = p;
      }
      let nh = 0; for (let h = 0; h < r.length; h++) if (ps[h] >= 0.12 * pmax && pmax > 0) nh++;
      let d = 20 * Math.log10(s + eps);
      // nota "fantasma": a energia vem só de harmônicos altos (de outra nota mais aguda).
      // Do meio para cima a fundamental tem que existir; no grave (microfone de celular perde a fundamental) basta o 1º ou 2º harmônico.
      const base = m >= 45 ? p1 : Math.max(p1, p2);
      if (base < 0.2 * pmax) d -= 15;
      // um pico isolado (baque do tampo, ruído) não é nota de piano: exige ao menos 2 harmônicos abaixo da região aguda
      else if (m < 84 && r.length >= 2 && nh < 2) d -= 15;
      return d;
    }

    /** frame: os últimos N amostras (Float32Array). now: ms. Retorna lista de ataques. */
    process(frame, now) {
      const N = this.N, re = this.re, im = this.im, mag = this.mag;
      let rms = 0;
      for (let i = 0; i < N; i++) { const x = frame[i]; rms += x * x; re[i] = x * this.win[i]; im[i] = 0; }
      this.level = Math.sqrt(rms / N);
      // ataque: energia da derivada (realça agudos/ruído do martelo) no último bloco vs. blocos anteriores
      const H = this.hopSamples;
      let e = 0; for (let i = N - H; i < N; i++) { const d = frame[i] - frame[i - 1]; e += d * d; }
      e /= H;
      const hh = this.hfHist;
      if (hh.length >= 4) {
        const prev = hh.slice(-6).sort((a, b) => a - b)[Math.floor(Math.min(hh.length, 6) / 2)];
        if (e > prev * 1.8 && e > 1e-9) this.lastAttack = now;
      }
      hh.push(e); if (hh.length > 12) hh.shift();
      this.attackAge = now - this.lastAttack;
      fftInPlace(re, im);
      const norm = 2 / N;
      for (let i = 0; i < N / 2; i++) mag[i] = Math.hypot(re[i], im[i]) * norm;

      // piso de ruído (mediana)
      const samp = []; for (let k = 20; k < Math.min(N / 2, 3020); k += 5) samp.push(mag[k]);
      samp.sort((a, b) => a - b);
      this.eps = Math.max(1e-7, samp[samp.length >> 1] * 2);
      const epsDb = 20 * Math.log10(this.eps);
      const { LO, HI, sal, salW, floor, hist, HIST } = this;
      let gmax = -300;
      for (let m = LO - 1; m <= HI + 1; m++) {
        sal[m] = this.salience(m, mag);
        if (m >= LO && m <= HI && sal[m] > gmax) gmax = sal[m];
      }
      const work = this.work; work.set(mag); salW.set(sal);
      const present = new Map();
      for (let it = 0; it < 7; it++) {
        let best = -1, bv = -300;
        for (let m = LO; m <= HI; m++) if (!present.has(m) && salW[m] > bv) { bv = salW[m]; best = m; }
        if (best < 0 || bv < gmax - 22 || bv < epsDb + 14) break;
        present.set(best, bv);
        for (const q of this.ranges[best]) for (let i = q[0] - 1; i <= q[1] + 1; i++) work[i] *= 0.2;
        for (let m = LO - 1; m <= HI + 1; m++) if (!present.has(m)) salW[m] = this.salience(m, work);
      }
      this.present = present;

      const RISE = 9 - this.sens * 0.6, ABOVE = 17 - this.sens;
      const cands = [];
      if (this.frames > HIST) {
        for (let m = LO; m <= HI; m++) {
          const exp = this.expected.has(m), pres = present.has(m);
          if (!exp && !pres) continue;
          let mn = 999; for (let k = 0; k < HIST; k++) if (hist[k][m] < mn) mn = hist[k][m];
          const rise = sal[m] - mn, above = sal[m] - floor[m];
          if (rise < (exp ? RISE - 2.5 : RISE)) continue;
          if (above < (exp ? ABOVE - 4 : ABOVE)) continue;
          if (!pres && (sal[m] < gmax - 30 || sal[m] < sal[m - 1] || sal[m] < sal[m + 1])) continue;
          if (now - this.lastOn[m] < HIST * this.frameMs + 20) continue;
          // sem martelada recente não é nota nova (batimento de cordas, pedal, eco)
          // notas inesperadas, ou esperadas que acabaram de soar (nota repetida), precisam coincidir com uma martelada
          if (this.attackGate && now - this.lastAttack > 200 && (!exp || now - this.lastOn[m] < 2000)) continue;
          cands.push({ m, db: sal[m], rise, above, exp, present: pres });
        }
      }
      const hrow = hist[this.histPos]; this.histPos = (this.histPos + 1) % HIST;
      for (let m = LO - 1; m <= HI + 1; m++) {
        hrow[m] = sal[m];
        if (this.frames < 5) floor[m] = sal[m];
        else if (sal[m] < floor[m]) floor[m] = floor[m] * 0.7 + sal[m] * 0.3;
        else floor[m] += 0.04;
      }
      this.frames++;

      const out = [], pending = this.pending, recent = this.recent;
      for (let i = pending.length - 1; i >= 0; i--) {
        const pc = pending[i];
        if (this.frames < pc.due) continue;
        pending.splice(i, 1);
        if (present.has(pc.m)) out.push(pc);
      }
      for (const c of cands) {
        this.lastOn[c.m] = now;
        if (c.exp) out.push(c);
        else if (c.present) pending.push(Object.assign(c, { due: this.frames + 2 }));
      }
      if (out.length) {
        out.sort((a, b) => b.db - a.db);
        while (recent.length && now - recent[0].t > 500) recent.shift();
        const expected = [...this.expected];
        for (const c of out) {
          c.harmonic = !present.has(c.m) ||
            recent.some(r => r.m !== c.m && (HARM.has(c.m - r.m) || HARM.has(r.m - c.m))) ||
            (!c.exp && expected.some(e => HARM.has(c.m - e) || HARM.has(e - c.m)));
        }
        for (const c of out) if (present.has(c.m)) recent.push({ m: c.m, t: now });
      }
      return out;
    }
  }
  root.PitchDetector = PitchDetector;
  if (typeof module !== 'undefined') module.exports = { PitchDetector, fftInPlace };
})(typeof window !== 'undefined' ? window : globalThis);
