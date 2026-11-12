/* Partitura (OpenSheetMusicDisplay) numa faixa horizontal com cursor sincronizado ao tempo musical. */
class Score {
  constructor(container, piece) {
    this.el = container; this.piece = piece;
    this.positions = [];   // tempo musical (semibreves) de cada posição do cursor
    this.cur = 0;
    this.ready = false;
    this.barX = [];        // [x0, x1] em px de cada compasso
    this.range = null;
    this.onBarClick = null;
    container.addEventListener('click', e => {
      if (!this.ready || !this.onBarClick) return;
      const r = this.el.getBoundingClientRect();
      const x = e.clientX - r.left + this.el.scrollLeft;
      const i = this.barX.findIndex(([a, b]) => x >= a && x < b);
      if (i >= 0) this.onBarClick(i);
    });
  }
  async load() {
    const OSMD = opensheetmusicdisplay.OpenSheetMusicDisplay;
    this.osmd = new OSMD(this.el, {
      autoResize: false, backend: 'svg', drawTitle: false, drawSubtitle: false, drawComposer: false,
      drawLyricist: false, drawPartNames: false, drawPartAbbreviations: false, drawCredits: false,
      drawMetronomeMarks: false, renderSingleHorizontalStaffline: true, autoBeam: true,
      drawingParameters: 'compacttight', followCursor: false,
      cursorsOptions: [{ type: 3, color: '#b9a6ff', alpha: 0.35, follow: false }],
    });
    await this.osmd.load(this.piece.xml);
    this.fitZoom();
    this.osmd.render();
    this.buildTimeline();
    this.measureBars();
    this.ready = true;
  }
  fitZoom() {
    const h = this.el.clientHeight || 200;
    this.osmd.zoom = Math.max(0.45, Math.min(1.4, h / 270));
    this.zoomFor = h;
  }
  rerenderIfNeeded() {
    if (!this.ready) return;
    const h = this.el.clientHeight;
    if (h < 40 || Math.abs(h - this.zoomFor) < 20) return;   // escondida ou sem mudança relevante
    this.fitZoom(); this.osmd.render(); this.buildTimeline(); this.measureBars();
    if (this.range) this.setRange(...this.range);
  }
  /** Posição horizontal (px) de cada compasso, para cliques e destaque do trecho. */
  measureBars() {
    const unit = 10 * this.osmd.zoom;
    const ml = this.osmd.GraphicSheet.MeasureList;
    this.barX = ml.map(staves => {
      const gm = staves.find(Boolean);
      if (!gm) return [0, 0];
      const ps = gm.PositionAndShape;
      const x0 = (ps.AbsolutePosition.x + ps.BorderLeft) * unit, x1 = (ps.AbsolutePosition.x + ps.BorderRight) * unit;
      return [x0, x1];
    });
    // o primeiro compasso inclui clave/armadura à esquerda
    if (this.barX.length) this.barX[0][0] = 0;
  }
  /** Esmaece a partitura fora do trecho em prática. */
  setRange(from, to) {
    this.range = [from, to];
    if (!this.ready) return;
    this.el.querySelectorAll('.score-dim, .score-edge').forEach(n => n.remove());
    const a = this.barX[from], b = this.barX[to];
    if (!a || !b) return;
    const total = Math.max(this.el.scrollWidth, b[1] + 40);
    const add = (cls, left, width) => {
      const d = document.createElement('div'); d.className = cls;
      d.style.left = left + 'px'; if (width != null) d.style.width = width + 'px';
      this.el.appendChild(d);
    };
    if (a[0] > 1) add('score-dim', 0, a[0]);
    add('score-dim', b[1], total - b[1]);
    add('score-edge', a[0] - 1);
    add('score-edge', b[1] - 2);
  }
  buildTimeline() {
    const c = this.osmd.cursor;
    c.show(); c.reset();
    const bars = this.piece.bars;
    const measures = this.osmd.Sheet.SourceMeasures;
    this.positions = [];
    let guard = 0;
    while (!c.iterator.EndReached && guard++ < 5000) {
      const mi = c.iterator.CurrentMeasureIndex;
      const rel = c.iterator.currentTimeStamp.RealValue - measures[mi].AbsoluteTimestamp.RealValue;
      this.positions.push((bars[mi] ?? 0) + rel);
      c.next();
    }
    c.reset(); this.cur = 0;
  }
  /** Move o cursor para o último evento com tempo <= t e rola a faixa. */
  moveTo(t, smooth = true) {
    if (!this.ready || !this.positions.length) return;
    let lo = 0, hi = this.positions.length - 1, k = 0;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (this.positions[mid] <= t + 1e-6) { k = mid; lo = mid + 1; } else hi = mid - 1; }
    // posições repetidas (apojaturas) — pega a última com o mesmo tempo
    const c = this.osmd.cursor;
    if (k < this.cur) { c.reset(); this.cur = 0; }
    while (this.cur < k) { c.next(); this.cur++; }
    this.scrollToCursor(smooth);
  }
  scrollToCursor(smooth) {
    const ce = this.osmd.cursor.cursorElement;
    if (!ce) return;
    const left = parseFloat(ce.style.left) || ce.offsetLeft || 0;
    const target = Math.max(0, left - this.el.clientWidth * 0.28);
    if (Math.abs(this.el.scrollLeft - target) > 2) this.el.scrollTo({ left: target, behavior: smooth ? 'smooth' : 'auto' });
  }
}
