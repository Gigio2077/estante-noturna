/* Núcleo da escuta: recebe blocos de áudio (domínio do tempo) e devolve ataques de notas MIDI.
   Sem dependências do navegador, para rodar igual no app e nos testes.

   Uma nota só é aceita quando três coisas acontecem juntas:
   1. Martelada: um salto súbito de agudos (ruído do martelo) no bloco mais recente,
      com volume bem acima do silêncio da sala e não muito abaixo do volume em que se está tocando.
   2. A altura daquela nota cresce logo depois da martelada (nota que só continua soando não conta).
   3. A nota aparece na estimativa polifônica (fundamental + harmônicos, sem ser fantasma de outra). */
(function (root) {
  const HW = [1, 0.8, 0.65, 0.5, 0.42, 0.36];
  const HARM = new Set([12, 19, 24, 28, 31, 34, 36]);
  const SPLIT = 72;            // do Dó5 para cima usa a janela curta (menos atraso)

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

  class Spectrum {
    constructor(sr, n, kind) {
      this.n = n; this.sr = sr;
      this.win = new Float32Array(n);
      const bl = (i, len) => 0.42 - 0.5 * Math.cos(2 * Math.PI * i / len) + 0.08 * Math.cos(4 * Math.PI * i / len);
      // 'asym': sobe devagar e desce rápido, com o pico perto do áudio mais recente (menos atraso, mesma resolução)
      const A = Math.round(n * (kind.asym || 0.75)), B = n - A;
      for (let i = 0; i < n; i++) this.win[i] = kind === 'hann' ? 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n)
        : kind === 'blackman' ? bl(i, n)
        : i < A ? bl(i, 2 * A) : bl(A + (i - A) * A / B, 2 * A);
      this.re = new Float64Array(n); this.im = new Float64Array(n);
      this.mag = new Float32Array(n / 2); this.work = new Float32Array(n / 2);
      this.eps = 1e-6;
      const binHz = sr / n, nyq = sr / 2 * 0.92;
      this.ranges = [];
      for (let m = 0; m < 128; m++) {
        const r = [];
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
        this.ranges.push(r);
      }
    }
    compute(frame) {
      const n = this.n, off = frame.length - n, re = this.re, im = this.im, mag = this.mag;
      for (let i = 0; i < n; i++) { re[i] = frame[off + i] * this.win[i]; im[i] = 0; }
      fftInPlace(re, im);
      const norm = 2 / n;
      for (let i = 0; i < n / 2; i++) mag[i] = Math.hypot(re[i], im[i]) * norm;
      const samp = []; const top = Math.min(n / 2, Math.round(5000 / (this.sr / n)));
      for (let k = 10; k < top; k += 3) samp.push(mag[k]);
      samp.sort((a, b) => a - b);
      this.eps = Math.max(1e-8, samp[samp.length >> 1] * 2);
      this.work.set(mag);
    }
  }

  class PitchDetector {
    constructor(sampleRate, opts = {}) {
      this.sr = sampleRate;
      this.N = opts.fftSize || 8192;
      this.frameMs = opts.frameMs || 20;
      this.LO = 28; this.HI = 104;
      this.HIST = 8;
      this.sens = 5;
      this.expected = new Set();
      this.L = new Spectrum(sampleRate, this.N, opts.longWindow || { asym: 0.75 });
      this.S = new Spectrum(sampleRate, this.N / 2, 'hann');
      this.sal = new Float32Array(128).fill(-150);
      this.salW = new Float32Array(128);
      this.floor = new Float32Array(128).fill(-150);
      this.hist = Array.from({ length: this.HIST }, () => new Float32Array(128).fill(-150));
      this.histPos = 0; this.frames = 0;
      this.lastOn = new Float64Array(128).fill(-1e9);
      this.recent = []; this.pending = [];
      this.level = 0;
      this.hop = Math.round(sampleRate * this.frameMs / 1000);
      this.eHist = [];
      this.silence = null;            // silêncio da sala: sobe só 0,2 dB/s (o pedal não vira "silêncio")
      this.noteLevel = null;          // força típica das notas certas (dB)
      this.lastAttack = -1e9;
      // fluxo espectral (martelada): quantas frequências saltam de repente
      this.logPrev = []; this.cntHist = [];
      this.salAtAttack = new Float32Array(128).fill(-150);
      // energia de cada nota na janela curta (reage rápido a notas re-tocadas, inclusive graves)
      this.salS = new Float32Array(128).fill(-150);
      this.histS = Array.from({ length: this.HIST }, () => new Float32Array(128).fill(-150));
      this.salSAtAttack = new Float32Array(128).fill(-150);
      this.attackGate = opts.attackGate ?? true;
    }
    setExpected(arr) { this.expected = new Set(arr); }
    setSensitivity(v) { this.sens = v; }
    spec(m) { return m >= SPLIT ? this.S : this.L; }

    salience(m, useWork, forceSp) {
      const sp = forceSp || this.spec(m), M = useWork ? sp.work : sp.mag, r = sp.ranges[m], eps = sp.eps;
      let s = 0, p1 = 0, p2 = 0, pmax = 0;
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
      const base = m >= 45 ? p1 : Math.max(p1, p2);
      if (base < 0.2 * pmax) d -= 15;                                   // fantasma (sem fundamental)
      else if (m < 84 && r.length >= 2 && nh < 2) d -= 15;              // pico isolado (baque, ruído)
      return d;
    }

    /** Atenua os harmônicos da nota m nas duas janelas (para achar as outras notas do acorde). */
    explain(m) {
      for (const sp of [this.L, this.S]) for (const q of sp.ranges[m]) for (let i = q[0] - 1; i <= q[1] + 1 && i < sp.work.length; i++) sp.work[i] *= 0.2;
    }

    /** frame: as últimas N amostras (Float32Array). now: ms. Retorna lista de ataques. */
    process(frame, now) {
      const N = this.N, H = this.hop;
      // ---- energia ----
      let e = 0, rms = 0;
      for (let i = N - H; i < N; i++) e += frame[i] * frame[i];
      for (let i = 0; i < N; i += 4) rms += frame[i] * frame[i];
      this.level = Math.sqrt(rms / (N / 4));
      e = e / H + 1e-12;
      const eh = this.eHist;
      eh.push(e); if (eh.length > 12) eh.shift();
      this.silence = this.silence == null ? e : Math.min(this.silence * 1.0009, e);
      const sens = this.sens;
      const ambDb = 20 - sens * 1.2;                 // energia nova acima do silêncio: sens 0: 20 dB; 5: 14; 10: 8
      this.noteGapDb = 14 + sens * 1.4;              // nota até X dB mais fraca que as notas certas: 14 / 21 / 28

      // ---- espectros ----
      this.L.compute(frame); this.S.compute(frame);

      // ---- martelada: fluxo espectral na janela curta (150 Hz a 6 kHz) ----
      const SM = this.S.mag, binHz = this.sr / this.S.n;
      const k0 = Math.round(150 / binHz), k1 = Math.min(SM.length - 1, Math.round(6000 / binHz));
      const floorDb = 20 * Math.log10(this.S.eps) + 3;
      const lp = new Float32Array(k1 - k0 + 1);
      for (let k = k0; k <= k1; k++) lp[k - k0] = 20 * Math.log10(SM[k] + 1e-12);
      let cnt = 0, flat = 0;
      if (this.logPrev.length >= 3) {
        const [a1, a2, a3] = this.logPrev;
        // concentração da energia nova: nota de piano põe quase tudo em poucos harmônicos; ruído espalha
        const ds = new Float32Array(lp.length); let sumD = 0;
        for (let i = 0; i < lp.length; i++) {
          const before = Math.max(a1[i], a2[i], a3[i]);
          if (lp[i] - before > 9 && lp[i] > floorDb) cnt++;
          const d = Math.max(0, Math.pow(10, lp[i] / 10) - Math.pow(10, before / 10));
          ds[i] = d; sumD += d;
        }
        if (sumD > 0) { ds.sort(); let top = 0; const k = Math.ceil(ds.length * 0.04); for (let i = ds.length - k; i < ds.length; i++) top += ds[i]; flat = 1 - top / sumD; }
      }
      this.flat = flat;
      this.logPrev.push(lp); if (this.logPrev.length > 3) this.logPrev.shift();
      const ch = this.cntHist;
      const med = ch.length ? ch.slice().sort((x, y) => x - y)[ch.length >> 1] : 0;
      ch.push(cnt); if (ch.length > 50) ch.shift();
      const before = eh.length > 8 ? Math.min(...eh.slice(-8, -2)) : e;
      const added = e - before;                       // energia que a martelada acrescentou
      // martelada real faz dezenas de frequências saltarem em 1-2 quadros; oscilações do decaimento, poucas
      const score = cnt + (this.prevCnt || 0); this.prevCnt = cnt;
      const minScore = 16 - sens;                     // sens 0: 16; 5: 11; 10: 6
      let attack = cnt >= 3 && score >= Math.max(minScore, 3 * med) && added > this.silence * Math.pow(10, ambDb / 10)
        && flat < 0.4;                                // energia nova espalhada por tudo = ruído, não martelo
      // dois quadros seguidos do mesmo ataque contam como um
      if (attack && now - this.lastAttack < 45) attack = false;
      this.attackInfo = { cnt, med, added, silence: this.silence };

      const { LO, HI, sal, salW, floor, hist, HIST } = this;
      let gmax = -300;
      const salS = this.salS, histS = this.histS;
      for (let m = LO - 1; m <= HI + 1; m++) {
        sal[m] = this.salience(m, false);
        salS[m] = m >= SPLIT ? sal[m] : this.salience(m, false, this.S);
        if (m >= LO && m <= HI && sal[m] > gmax) gmax = sal[m];
      }
      if (attack) {
        // como cada nota estava logo antes da martelada
        for (let m = LO - 1; m <= HI + 1; m++) {
          let mn = sal[m], mnS = salS[m];
          for (let k = 0; k < HIST; k++) { if (hist[k][m] < mn) mn = hist[k][m]; if (histS[k][m] < mnS) mnS = histS[k][m]; }
          this.salAtAttack[m] = mn; this.salSAtAttack[m] = mnS;
        }
        this.lastAttack = now;
      }
      // estimativa polifônica: pega a mais forte, atenua seus harmônicos, repete
      salW.set(sal);
      const present = new Map();
      for (let it = 0; it < 7; it++) {
        let best = -1, bv = -300;
        for (let m = LO; m <= HI; m++) if (!present.has(m) && salW[m] > bv) { bv = salW[m]; best = m; }
        if (best < 0 || bv < gmax - 22 || bv < 20 * Math.log10(this.spec(best).eps) + 14) break;
        present.set(best, bv);
        this.explain(best);
        for (let m = LO - 1; m <= HI + 1; m++) if (!present.has(m)) salW[m] = this.salience(m, true);
      }
      this.present = present;

      // ---- candidatos: só logo depois de uma martelada ----
      const RISE = 9 - sens * 0.4;                    // sens 0: 9 dB; 5: 7; 10: 5
      const sinceAttack = now - this.lastAttack;
      const cands = [];
      if (this.frames > HIST && (!this.attackGate || sinceAttack <= 200)) {
        for (let m = LO; m <= HI; m++) {
          const exp = this.expected.has(m), pres = present.has(m);
          if (!exp && !pres) continue;
          if (m >= SPLIT && sinceAttack > 140) continue;
          const rise = Math.max(sal[m] - this.salAtAttack[m], salS[m] - this.salSAtAttack[m]);
          if (rise < (exp ? RISE - 1.5 : RISE)) continue;
          if (sal[m] - floor[m] < 10) continue;
          if (this.noteLevel != null && sal[m] < this.noteLevel - this.noteGapDb) continue;   // fraco demais (longe)
          // nota esperada grave: a janela curta já mostra o ataque (sem esperar a longa encher)
          if (!pres) {
            // esperada que não aparece como nota própria (microfone/alto-falante fraco no grave, acorde cheio):
            // aceita se subiu forte, é pico local e não é só harmônico de uma nota mais grave que está soando
            if (rise < RISE + (m >= 60 ? 5 : 0)) continue;
            const peakL = sal[m] >= sal[m - 1] && sal[m] >= sal[m + 1] && sal[m] >= gmax - 30;
            const peakS = m < SPLIT && salS[m] >= salS[m - 1] && salS[m] >= salS[m + 1] && salS[m] - this.salSAtAttack[m] >= RISE;
            if (!peakL && !peakS) continue;
            let h = false; for (const q of present.keys()) if (HARM.has(m - q)) { h = true; break; }
            if (h) continue;
          }
          if (now - this.lastOn[m] < 150) continue;
          if (this.attackGate && this.lastOn[m] >= this.lastAttack) continue;   // uma vez por martelada
          cands.push({ m, db: sal[m], rise, above: sal[m] - floor[m], exp, present: pres, attack: this.lastAttack });
        }
      }
      const hrow = hist[this.histPos], hrowS = histS[this.histPos]; this.histPos = (this.histPos + 1) % HIST;
      for (let m = LO - 1; m <= HI + 1; m++) {
        hrow[m] = sal[m]; hrowS[m] = salS[m];
        if (this.frames < 5) floor[m] = sal[m];
        else if (sal[m] < floor[m]) floor[m] = floor[m] * 0.7 + sal[m] * 0.3;
        else floor[m] += 0.04;
      }
      this.frames++;

      // esperadas saem já; inesperadas esperam 1 quadro e precisam continuar presentes
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
        else pending.push(Object.assign(c, { due: this.frames + 1 }));
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
        for (const c of out) if (c.exp) this.noteLevel = this.noteLevel == null ? c.db : Math.max(this.noteLevel * 0.9 + c.db * 0.1, this.noteLevel - 0.5);
      }
      return out;
    }
  }
  root.PitchDetector = PitchDetector;
  if (typeof module !== 'undefined') module.exports = { PitchDetector, fftInPlace };
})(typeof window !== 'undefined' ? window : globalThis);
