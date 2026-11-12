/* Motor de prática: transforma um trecho em "passos" (notas simultâneas) e avalia o que foi tocado. */
class Practice {
  /**
   * opts: hand 'R'|'L'|'B', fromBar, toBar, mode 'wait'|'tempo', speed (0.25..1), strict 'easy'|'normal'|'strict'
   */
  constructor(piece, opts) {
    this.piece = piece;
    this.o = Object.assign({ hand: 'B', mode: 'wait', speed: 0.5, strict: 'normal' }, opts);
    const { fromBar, toBar, hand } = this.o;
    this.t0 = piece.bars[fromBar];
    this.t1 = piece.bars[toBar + 1];
    const inRange = piece.notes.filter(n => n.bar >= fromBar && n.bar <= toBar);
    this.active = inRange.filter(n => hand === 'B' || n.h === hand);
    this.other = inRange.filter(n => !(hand === 'B' || n.h === hand));
    this.steps = [];
    for (const n of this.active) {
      let s = this.steps[this.steps.length - 1];
      if (!s || Math.abs(s.t - n.t) > 1e-6) {
        s = { t: n.t, notes: [], bar: n.bar, hit: new Set(), wrongs: 0, missed: false, skipped: false, done: false, wait: 0 };
        this.steps.push(s);
      }
      if (!s.notes.some(x => x.m === n.m)) s.notes.push(n);
    }
    for (const s of this.steps) s.need = this.needFor(s.notes.length);
    // tempo: colcheia = 132 * speed por minuto  ->  semibreves por segundo
    this.wps = (piece.tempo8 / 8 / 60) * this.o.speed;
    this.idx = 0;
    this.started = false; this.finished = false; this.paused = false;
    this.pos = this.steps.length ? this.steps[0].t : this.t0;   // posição musical (semibreves)
    this.cb = {};
    this.stepStartedAt = 0;
    this.startClock = 0;
  }
  on(name, fn) { this.cb[name] = fn; return this; }
  emit(name, ...a) { if (this.cb[name]) this.cb[name](...a); }

  needFor(n) {
    const s = this.o.strict;
    if (s === 'strict' || n <= 1) return n;
    if (s === 'normal') return n <= 2 ? n : Math.ceil(n * 2 / 3);
    return Math.max(1, Math.ceil(n / 2));
  }
  get current() { return this.steps[this.idx]; }
  get expected() {
    if (this.o.mode === 'wait') {
      const s = this.current; if (!s) return [];
      return s.notes.filter(n => !s.hit.has(n.m)).map(n => n.m);
    }
    const tol = this.tolW();
    return this.steps.filter(s => !s.done && Math.abs(s.t - this.pos) < tol * 2.5).flatMap(s => s.notes.map(n => n.m));
  }
  tolW() { return Math.max(0.18 * this.wps, 1 / 32); }
  latency() { return 0.12 * this.wps; }

  start(now) {
    this.started = true; this.paused = false;
    this.stepStartedAt = now; this.firstAt = now;
    if (this.o.mode === 'tempo') {
      this.lead = 1.6;                       // segundos de entrada
      this.startClock = now + this.lead * 1000;
      this.pos = this.t0 - this.lead * this.wps;
      this.posStart = this.t0;
    }
    if (!this.steps.length) this.finish(now);
  }
  pause(now) { this.paused = true; this.pausedAt = now; }
  resume(now) {
    if (!this.paused) return;
    const d = now - this.pausedAt;
    this.startClock += d; this.stepStartedAt += d; this.paused = false;
  }

  /** Entrada de nota. src: 'mic' | 'midi' | 'touch'. Retorna 'hit' | 'wrong' | 'ignored'. */
  input(m, now, src, attack) {
    if (!this.started || this.finished || this.paused) return 'ignored';
    // a martelada que completou um passo não vale para o seguinte (eco/harmônicos do mesmo toque)
    if (attack != null && this.o.mode === 'wait' && this.doneAttack != null && attack <= this.doneAttack + 60) return 'ignored';
    this.curAttack = attack;
    return this.o.mode === 'wait' ? this.inputWait(m, now, src) : this.inputTempo(m, now, src);
  }

  /** Erros reais costumam ser notas vizinhas; muito longe do esperado é ruído do microfone. */
  nearRegister(m, exp) {
    if (!exp.length) return false;
    return m >= Math.min(...exp) - 12 && m <= Math.max(...exp) + 12;
  }

  related(m, list) {
    return list.some(x => {
      const d = m - x;
      if (d === 0 || d === 12 || d === 19 || d === 24 || d === -12 || d === -19 || d === 28) return true;
      return Math.abs(d) === 1 && Math.min(m, x) < 60;   // no grave o microfone mal separa semitons
    });
  }

  inputWait(m, now, src) {
    const s = this.current; if (!s) return 'ignored';
    if (s.notes.some(n => n.m === m)) {
      if (s.hit.has(m)) return 'ignored';
      s.hit.add(m); this.emit('hit', m, s);
      if (s.hit.size >= s.need) this.complete(now);
      return 'hit';
    }
    // tocou já a nota do próximo passo (passagens rápidas): aceita se o atual estava quase completo
    const nx = this.steps[this.idx + 1];
    if (nx && nx.notes.some(n => n.m === m) && s.hit.size >= Math.max(1, s.need - 1) && src !== 'touch') {
      this.complete(now);
      return this.inputWait(m, now, src);
    }
    const prev = this.steps[this.idx - 1];
    const prevNotes = prev ? prev.notes.map(n => n.m) : [];
    if (src === 'mic') {
      // ecos, harmônicos e notas ainda soando (pedal) não contam como erro
      const sounding = this.sounding(now).concat(s.notes.map(n => n.m), nx ? nx.notes.map(n => n.m) : []);
      if (this.related(m, sounding)) return 'ignored';
      if (!this.nearRegister(m, s.notes.map(n => n.m))) return 'ignored';
      if (now - this.stepStartedAt < 120) return 'ignored';
      if (this.lastWrong && this.lastWrong.m === m && now - this.lastWrong.t < 1500) return 'ignored';
    } else if (prevNotes.includes(m) && now - this.stepStartedAt < 250) return 'ignored';
    this.lastWrong = { m, t: now };
    s.wrongs++;
    this.emit('wrong', m, s);
    return 'wrong';
  }

  /** Notas tocadas nos últimos 2,5 s (ainda podem estar soando com o pedal). */
  sounding(now) {
    const out = [];
    for (let i = this.idx - 1; i >= 0; i--) {
      const st = this.steps[i];
      if (!st.doneAt || now - st.doneAt > 4000) break;
      st.notes.forEach(n => out.push(n.m));
    }
    return out;
  }

  complete(now) {
    const s = this.current; if (!s) return;
    s.done = true; s.doneAt = now;
    if (this.curAttack != null) this.doneAttack = this.curAttack;
    const prev = this.steps[this.idx - 1];
    const expectSec = prev ? (s.t - prev.t) / this.wps : 0;
    s.wait = Math.max(0, (now - this.stepStartedAt) / 1000 - expectSec);
    this.idx++;
    this.stepStartedAt = now;
    this.emit('step', this.idx, s);
    if (this.idx >= this.steps.length) this.finish(now);
  }
  skip(now) {
    if (this.o.mode !== 'wait' || !this.current) return;
    this.current.skipped = true;
    this.complete(now);
  }

  inputTempo(m, now, src) {
    const tol = this.tolW();
    const pos = this.pos - (src === 'mic' ? this.latency() : 0);   // a escuta percebe a nota com atraso
    let best = null, bd = 1e9;
    for (let i = this.idx; i < this.steps.length; i++) {
      const s = this.steps[i];
      if (s.t - pos > tol) break;
      if (s.done && s.hit.size >= s.notes.length) continue;
      if (!s.notes.some(n => n.m === m) || s.hit.has(m)) continue;
      const d = Math.abs(s.t - pos);
      if (d <= tol && d < bd) { bd = d; best = s; }
    }
    if (best) {
      best.hit.add(m); this.emit('hit', m, best);
      if (!best.done && best.hit.size >= best.need) { best.done = true; this.emit('step', this.steps.indexOf(best) + 1, best); }
      return 'hit';
    }
    // erro: atribui ao passo mais próximo
    let near = null; bd = 1e9;
    for (const s of this.steps) { const d = Math.abs(s.t - pos); if (d < bd) { bd = d; near = s; } }
    if (!near) return 'ignored';
    const around = this.steps.filter(s => s.t > pos - Math.max(tol * 3, 4 * this.wps) && s.t < pos + tol * 3).flatMap(s => s.notes.map(n => n.m));
    if (src === 'mic' && this.related(m, around)) return 'ignored';
    if (src === 'mic' && !this.nearRegister(m, near.notes.map(n => n.m))) return 'ignored';
    if (src === 'mic' && this.lastWrong && this.lastWrong.m === m && now - this.lastWrong.t < 1500) return 'ignored';
    this.lastWrong = { m, t: now };
    if (around.includes(m)) return 'ignored';
    near.wrongs++; this.emit('wrong', m, near);
    return 'wrong';
  }

  /** Avança o relógio (modo no ritmo) e anima a posição (modo espera). */
  update(now) {
    if (!this.started || this.finished || this.paused) return;
    if (this.o.mode === 'tempo') {
      this.pos = this.posStart + (now - this.startClock) / 1000 * this.wps;
      const tol = this.tolW();
      while (this.idx < this.steps.length && this.steps[this.idx].t + tol < this.pos - this.latency()) {
        const s = this.steps[this.idx];
        if (!s.done) { s.done = true; if (s.hit.size < s.need) { s.missed = true; this.emit('miss', s); } }
        this.idx++;
      }
      const last = this.steps[this.steps.length - 1];
      if (this.idx >= this.steps.length && this.pos > Math.min(this.t1, last.t + 0.25) + tol) this.finish(now);
    } else {
      const s = this.current;
      const target = s ? s.t : this.t1;
      this.pos += (target - this.pos) * 0.22;
      if (Math.abs(target - this.pos) < 1e-4) this.pos = target;
    }
  }

  finish(now) {
    if (this.finished) return;
    this.finished = true;
    const bars = {};
    let errSteps = 0, wrongNotes = 0;
    for (const s of this.steps) {
      const b = bars[s.bar] || (bars[s.bar] = { steps: 0, errs: 0, wrongs: 0, hes: 0 });
      b.steps++;
      const bad = s.wrongs > 0 || s.missed || s.skipped;
      if (bad) { b.errs++; errSteps++; }
      b.wrongs += s.wrongs; wrongNotes += s.wrongs;
      if (s.wait > 2.5) b.hes++;
    }
    const total = this.steps.length;
    this.result = {
      bars, steps: total, errSteps, wrongNotes,
      accuracy: total ? 1 - errSteps / total : 1,
      seconds: (now - (this.firstAt || now)) / 1000,
    };
    this.emit('finish', this.result);
  }
}
