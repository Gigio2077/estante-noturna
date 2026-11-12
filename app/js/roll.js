/* Notas caindo + teclado de referência (estilo "piano roll"), desenhados num canvas. */
const PT_NAMES = { C: 'Dó', D: 'Ré', E: 'Mi', F: 'Fá', G: 'Sol', A: 'Lá', B: 'Si' };
function ptName(n) {
  if (!n) return '';
  const base = PT_NAMES[n[0]] || n[0];
  const acc = n.slice(1).replace(/bb/, '𝄫').replace(/b/, '♭').replace(/##/, '𝄪').replace(/#/, '♯');
  return base + acc;
}
const WHITE_OF = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6];
const IS_BLACK = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];
const SHARP_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const wIndex = m => Math.floor(m / 12) * 7 + WHITE_OF[m % 12];

class Roll {
  constructor(canvas, onKey) {
    this.c = canvas; this.g = canvas.getContext('2d');
    this.onKey = onKey;
    this.wLo = wIndex(48); this.wHi = wIndex(84);
    this.flash = new Map();          // m -> {color, until}
    this.pressed = new Map();        // pointerId -> m
    const css = getComputedStyle(document.documentElement);
    const v = k => css.getPropertyValue(k).trim();
    this.col = { R: v('--rh'), L: v('--lh'), ok: v('--ok'), err: v('--err'), ink: v('--ink'), line: v('--line'), muted: v('--muted'), text: v('--text'), deck: v('--deck') };
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.zoomKeys = null;            // null = automático (cabe tudo); número = teclas brancas visíveis
    this.onZoom = null;
    this.touches = new Map(); this.pinch = null;
    canvas.addEventListener('pointerdown', e => this.zoomPointer(e, 'down'));
    canvas.addEventListener('pointermove', e => this.zoomPointer(e, 'move'));
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) canvas.addEventListener(ev, e => this.zoomPointer(e, 'up'));
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      this.setZoom(this.visibleKeys * Math.exp(e.deltaY * 0.0015));
    }, { passive: false });
    canvas.addEventListener('pointerdown', e => this.pointer(e, true));
    canvas.addEventListener('pointerup', e => this.pointer(e, false));
    canvas.addEventListener('pointercancel', e => this.pointer(e, false));
    canvas.addEventListener('pointerleave', e => this.pointer(e, false));
  }
  resize() {
    const r = this.c.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.W = r.width; this.H = r.height; this.dpr = dpr;
    this.c.width = Math.round(r.width * dpr); this.c.height = Math.round(r.height * dpr);
  }
  get kh() { return Math.round(Math.min(this.H * (this.zoomKeys && this.H > 320 ? 0.42 : 0.34), Math.max(60, this.ww * 5.2))); }
  get visibleKeys() { return this.wHi - this.wLo + 1; }
  setZoom(k) {
    this.zoomKeys = k == null ? null : Math.max(8, Math.min(52, k));
    this.zLo = null;
    if (this.onZoom) this.onZoom(this.zoomKeys);
  }
  zoomBy(f) { this.setZoom(Math.round(this.visibleKeys * f)); }
  /** Pinça com dois dedos na área das notas. */
  zoomPointer(e, kind) {
    const r = this.c.getBoundingClientRect(), y = e.clientY - r.top;
    if (kind === 'down') {
      if (y >= this.H - this.kh) return;
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touches.size === 2) {
        const [a, b] = [...this.touches.values()];
        this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: this.visibleKeys };
      }
    } else if (kind === 'move') {
      if (!this.touches.has(e.pointerId)) return;
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pinch && this.touches.size === 2) {
        const [a, b] = [...this.touches.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d > 10) this.setZoom(this.pinch.k * this.pinch.d / d);
      }
    } else {
      this.touches.delete(e.pointerId);
      if (this.touches.size < 2) this.pinch = null;
    }
  }
  get ww() { return this.W / (this.wHi - this.wLo + 1); }
  keyRect(m) {
    const ww = this.ww, top = this.H - this.kh;
    if (!IS_BLACK[m % 12]) return { x: (wIndex(m) - this.wLo) * ww, w: ww, y: top, h: this.kh, black: false };
    const bw = ww * 0.62;
    return { x: (wIndex(m) + 1 - this.wLo) * ww - bw / 2, w: bw, y: top, h: this.kh * 0.62, black: true };
  }
  pointer(e, down) {
    const r = this.c.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    if (!down) {
      const m = this.pressed.get(e.pointerId);
      if (m != null) { this.pressed.delete(e.pointerId); this.onKey(m, false); }
      return;
    }
    if (y < this.H - this.kh) return;
    e.preventDefault();
    let hit = null;
    const lo = Math.max(21, this.mLo - 1), hi = Math.min(108, this.mHi + 1);
    for (let m = lo; m <= hi; m++) {
      if (!IS_BLACK[m % 12]) continue;
      const k = this.keyRect(m);
      if (x >= k.x && x <= k.x + k.w && y <= k.y + k.h) { hit = m; break; }
    }
    if (hit == null) for (let m = lo; m <= hi; m++) {
      if (IS_BLACK[m % 12]) continue;
      const k = this.keyRect(m);
      if (x >= k.x && x < k.x + k.w) { hit = m; break; }
    }
    if (hit != null) { this.pressed.set(e.pointerId, hit); this.onKey(hit, true); }
  }
  flashKey(m, color, ms = 350) { this.flash.set(m, { color, until: performance.now() + ms }); }

  /**
   * s: { pos, notes:[{t,d,m,h,g,n}], activeHand:'R'|'L'|'B', current:Set<m>, currentT, hits:Set<m>, bars:[], showNames, span }
   */
  draw(s) {
    const g = this.g, W = this.W, H = this.H, dpr = this.dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const kh = this.kh, hitY = H - kh;
    // pouca altura (celular deitado): mostra menos tempo para as notas não ficarem achatadas
    const span = Math.max(0.6, Math.min(s.span || 1.6, (hitY - 8) / 170));
    const pps = (hitY - 8) / span;
    const now = performance.now();

    // faixa visível do teclado acompanha as notas próximas
    let lo = 200, hi = 0;
    for (const n of s.notes) {
      if (n.t + n.d < s.pos - 0.05 || n.t > s.pos + span * 1.2) continue;
      if (n.m < lo) lo = n.m; if (n.m > hi) hi = n.m;
    }
    if (lo > hi) { lo = 55; hi = 79; }
    const minSpan = W < 500 ? 20 : W < 900 ? 30 : 40;
    let tLo = wIndex(lo) - 1, tHi = wIndex(hi) + 1;
    while (tHi - tLo + 1 < minSpan * 7 / 12) { tLo -= 0.5; tHi += 0.5; }
    if (this.zoomKeys) {
      // zoom manual: janela fixa de teclas que acompanha as notas de agora
      const K = Math.round(this.zoomKeys);
      let fLo = 200, fHi = 0;
      const focus = s.current && s.current.size ? [...s.current]
        : s.notes.filter(n => n.t + n.d >= s.pos - 0.01 && n.t <= s.pos + 0.35 && (s.activeHand === 'B' || n.h === s.activeHand)).map(n => n.m);
      for (const m of focus) { if (m < fLo) fLo = m; if (m > fHi) fHi = m; }
      if (fLo > fHi) { fLo = lo; fHi = hi; }
      const a = wIndex(fLo), b = wIndex(fHi);
      let zl = this.zLo;
      const fits = b - a + 3 <= K;
      if (zl == null || a < zl + 1 || b > zl + K - 2) {
        zl = fits ? Math.round((a + b) / 2 - (K - 1) / 2) : a - 1;     // não cabe tudo: prioriza a nota mais grave
      }
      zl = Math.max(wIndex(21), Math.min(wIndex(108) - K + 1, zl));
      this.zLo = zl;
      tLo = zl; tHi = zl + K - 1;
    }
    const k = s.instant ? 1 : 0.08;
    this.wLo += (tLo - this.wLo) * k; this.wHi += (tHi - this.wHi) * k;
    const ww = this.ww;
    this.mLo = Math.max(21, Math.floor(this.wLo / 7) * 12 - 1); this.mHi = Math.min(108, Math.ceil(this.wHi / 7) * 12 + 12);

    // pistas de oitava
    g.fillStyle = this.col.ink; g.fillRect(0, 0, W, hitY);
    g.strokeStyle = 'rgba(255,255,255,0.045)'; g.lineWidth = 1;
    for (let w = Math.floor(this.wLo); w <= Math.ceil(this.wHi); w++) {
      if (w % 7 === 0 || w % 7 === 3) {
        const x = Math.round((w - this.wLo) * ww) + 0.5;
        g.beginPath(); g.moveTo(x, 0); g.lineTo(x, hitY); g.stroke();
      }
    }
    // barras de compasso
    g.font = '600 10px system-ui, sans-serif'; g.textBaseline = 'bottom';
    for (let i = 0; i < s.bars.length; i++) {
      const t = s.bars[i];
      if (t < s.pos - 0.01 || t > s.pos + span) continue;
      const y = Math.round(hitY - (t - s.pos) * pps) + 0.5;
      g.strokeStyle = 'rgba(255,255,255,0.13)'; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
      if (i > 0 && i < s.bars.length - 1) { g.fillStyle = this.col.muted; g.fillText('c. ' + i, 6, y - 2); }
    }

    // notas
    const labels = [];
    for (const n of s.notes) {
      if (n.t + n.d < s.pos - 0.02 || n.t > s.pos + span) continue;
      const kr = this.keyRect(n.m);
      if (kr.x + kr.w < 0 || kr.x > W) continue;
      const mine = s.activeHand === 'B' || n.h === s.activeHand;
      const yb = hitY - (n.t - s.pos) * pps;
      let yt = hitY - (n.t + n.d - s.pos) * pps;
      if (yb - yt < 5) yt = yb - 5;
      const y0 = Math.max(0, yt), y1 = Math.min(hitY, yb);
      if (y1 <= y0) continue;
      const pad = n.g ? kr.w * 0.22 : (kr.black ? 0.5 : 1.5);
      const x = kr.x + pad, w = kr.w - pad * 2;
      const isCur = s.current && Math.abs(n.t - s.currentT) < 1e-6 && mine;
      const passed = n.t < s.currentT - 1e-6;
      let col = this.col[n.h];
      g.globalAlpha = !mine ? 0.22 : passed ? 0.35 : 1;
      if (isCur && s.hits && s.hits.has(n.m)) col = this.col.ok;
      g.fillStyle = col;
      if (isCur) { g.shadowColor = col; g.shadowBlur = 14; }
      roundRect(g, x, y0, w, y1 - y0, Math.min(5, w / 3));
      g.fill();
      g.shadowBlur = 0;
      if (mine && !passed) {
        g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 1; g.stroke();
      }
      if (s.showNames && mine && !passed) labels.push({ n, x, w, y0, y1, col: this.col[n.h], cur: isCur });
      g.globalAlpha = 1;
    }
    // nomes das notas: dentro da barra quando cabe, senão numa etiqueta logo abaixo do início da nota
    if (labels.length) {
      const fs = Math.max(9, Math.min(12, ww * 0.62));
      g.font = `700 ${fs}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
      const placed = [];
      labels.sort((a, b) => b.y1 - a.y1);
      for (const L of labels) {
        const txt = ptName(L.n.n), tw = g.measureText(txt).width;
        const cx = L.x + L.w / 2;
        if (tw + 4 <= L.w && L.y1 - L.y0 >= fs + 6) {
          g.fillStyle = '#14141c'; g.fillText(txt, cx, L.y1 - fs / 2 - 3);
          continue;
        }
        const pw = tw + 6, ph = fs + 4;
        let py = L.y1 - ph - 1;
        for (let k = 0; k < 4; k++) {
          const hit = placed.find(r => Math.abs(r.cx - cx) < (r.w + pw) / 2 && Math.abs(r.y - py) < ph);
          if (!hit) break;
          py = hit.y - ph - 1;
        }
        if (py < -ph) continue;
        placed.push({ cx, y: py, w: pw });
        g.fillStyle = 'rgba(17,19,31,0.88)';
        roundRect(g, cx - pw / 2, py, pw, ph, 4); g.fill();
        g.strokeStyle = L.col; g.lineWidth = L.cur ? 1.5 : 1; g.stroke();
        g.fillStyle = L.col; g.fillText(txt, cx, py + ph / 2 + 0.5);
      }
      g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    }

    // linha de toque
    g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(0, hitY - 3, W, 3);

    // teclado
    const keyState = m => {
      const f = this.flash.get(m);
      if (f && f.until > now) return f.color;
      if (s.current && s.current.has(m)) return s.hits && s.hits.has(m) ? this.col.ok : (s.curHand && s.curHand.get(m)) || this.col.R;
      return null;
    };
    const names = s.showNames ? (s.curName || new Map()) : null;
    for (let m = this.mLo; m <= this.mHi; m++) {
      if (IS_BLACK[m % 12]) continue;
      const r = this.keyRect(m); if (r.x > W || r.x + r.w < 0) continue;
      const st = keyState(m);
      g.fillStyle = st || '#ecebf2';
      g.fillRect(r.x + 0.5, r.y, r.w - 1, r.h - 2);
      if (st) { g.fillStyle = 'rgba(255,255,255,0.25)'; g.fillRect(r.x + 0.5, r.y, r.w - 1, 4); }
      g.fillStyle = '#c9c7d4'; g.fillRect(r.x + r.w - 1, r.y, 1, r.h - 2);
      if (m % 12 === 0 && r.w > 14) {
        g.fillStyle = '#8a8898'; g.font = `600 ${Math.min(10, r.w * 0.38)}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'bottom';
        g.fillText('Dó' + (Math.floor(m / 12) - 1), r.x + r.w / 2, r.y + r.h - 6); g.textAlign = 'left';
      }
      if (names && names.has(m) && r.w > 6) {
        g.fillStyle = '#14141c'; g.font = `700 ${Math.max(8, Math.min(12, r.w * 0.42))}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'bottom';
        g.fillText(ptName(names.get(m)), r.x + r.w / 2, r.y + r.h - (m % 12 === 0 ? 20 : 6)); g.textAlign = 'left';
      }
    }
    for (let m = this.mLo; m <= this.mHi; m++) {
      if (!IS_BLACK[m % 12]) continue;
      const r = this.keyRect(m); if (r.x > W || r.x + r.w < 0) continue;
      const st = keyState(m);
      g.fillStyle = st || '#1d1e27';
      roundRect(g, r.x, r.y - 1, r.w, r.h, 3); g.fill();
      if (!st) { g.fillStyle = '#3a3c4c'; g.fillRect(r.x + 2, r.y + r.h - 8, r.w - 4, 4); }
      if (names && names.has(m) && r.w > 5) {
        g.fillStyle = st ? '#14141c' : '#fff'; g.font = `700 ${Math.max(7, Math.min(10, r.w * 0.4))}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'bottom';
        g.fillText(ptName(names.get(m)), r.x + r.w / 2, r.y + r.h - 10); g.textAlign = 'left';
      }
    }
    g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(0, hitY, W, 3);
    // notas esperadas fora da tela (com zoom): seta na borda com o nome
    if (s.current && this.zoomKeys) {
      const left = [], right = [];
      for (const m of s.current) {
        const k = this.keyRect(m);
        if (k.x + k.w < 2) left.push(m); else if (k.x > W - 2) right.push(m);
      }
      g.font = '700 11px system-ui, sans-serif'; g.textBaseline = 'middle';
      const tag = (list, side) => {
        if (!list.length) return;
        list.sort((a, b) => a - b);
        const txt = (side < 0 ? '◀ ' : '') + list.map(m => ptName((s.curName && s.curName.get(m)) || SHARP_NAMES[m % 12]) + (Math.floor(m / 12) - 1)).join(' ') + (side > 0 ? ' ▶' : '');
        const tw = g.measureText(txt).width + 12, y = hitY - 16;
        const x = side < 0 ? 4 : W - tw - 4;
        g.fillStyle = 'rgba(17,19,31,0.92)'; roundRect(g, x, y - 10, tw, 20, 6); g.fill();
        g.strokeStyle = (s.curHand && s.curHand.get(list[0])) || this.col.R; g.lineWidth = 1.5; g.stroke();
        g.fillStyle = this.col.text; g.textAlign = 'left'; g.fillText(txt, x + 6, y + 0.5);
      };
      tag(left, -1); tag(right, 1);
      g.textBaseline = 'alphabetic';
    }
    for (const [m, f] of this.flash) if (f.until < now) this.flash.delete(m);
  }
}
function roundRect(g, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
