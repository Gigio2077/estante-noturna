/* Treinador: guarda o histórico por compasso e decide o próximo exercício.
   Tipos: 'new' (seção nova), 'errors' (onde mais erra), 'wide' (revisão de um trecho maior), 'free' (escolhido no mapa). */
const Coach = (() => {
  const KEY = 'estante-noturna.v1';
  const WIDE_EVERY = 4;          // a cada 4 exercícios concluídos, uma revisão ampla
  const WEAK = 0.15;             // taxa de erro a partir da qual o compasso entra em revisão
  const DAY = 86400000;
  let store = load();

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || { pieces: {} }; } catch (e) { return { pieces: {} }; }
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) {} }

  function modeData(pieceId, hand) {
    const p = store.pieces[pieceId] || (store.pieces[pieceId] = { modes: {}, prefs: {} });
    return p.modes[hand] || (p.modes[hand] = { bars: {}, sections: {}, done: 0, lastType: null, history: [] });
  }
  function prefs(pieceId) { const p = store.pieces[pieceId] || (store.pieces[pieceId] = { modes: {}, prefs: {} }); return p.prefs; }

  /** Seções de ~2 compassos; compassos muito longos (cadência) ficam sozinhos; anacruse junta à primeira. */
  function sections(piece) {
    const b = piece.bars, n = b.length - 1;
    const lens = []; for (let i = 0; i < n; i++) lens.push(b[i + 1] - b[i]);
    const sorted = [...lens].sort((x, y) => x - y), normal = sorted[Math.floor(n / 2)];
    const out = []; let cur = [];
    const close = () => { if (cur.length) out.push({ from: cur[0], to: cur[cur.length - 1] }); cur = []; };
    for (let i = 0; i < n; i++) {
      if (lens[i] > normal * 1.6) { close(); cur = [i]; close(); continue; }
      cur.push(i);
      const full = cur.reduce((a, j) => a + lens[j], 0);
      if (full >= normal * 2 - 1e-9) close();
    }
    close();
    // não deixar seções de 1 compasso “normal” soltas antes de um compasso longo se puderem juntar
    return out.map((s, i) => ({ ...s, id: i }));
  }

  const barLabel = (from, to) => {
    if (from === 0 && to > 0) from = 1;                 // a anacruse vai junto com o compasso 1
    if (to === 0) return 'Anacruse';
    return from === to ? `Compasso ${from}` : `Compassos ${from}–${to}`;
  };
  function weakness(bar, now) {
    if (!bar || !bar.att) return 0;
    const ageDays = (now - bar.last) / DAY;
    return (bar.err + 0.5 * (bar.hes || 0)) * (1 + Math.min(ageDays, 14) * 0.05);
  }

  function next(piece, hand) {
    const md = modeData(piece.id, hand);
    const secs = sections(piece);
    const now = Date.now();
    const learned = secs.filter(s => md.sections[s.id] && md.sections[s.id].learned);
    const firstNew = secs.find(s => !(md.sections[s.id] && md.sections[s.id].learned));
    // compassos já aprendidos (contíguos a partir do início ou não)
    const learnedBars = new Set(); learned.forEach(s => { for (let b = s.from; b <= s.to; b++) learnedBars.add(b); });

    // 1) revisão ampla periódica
    if (md.done > 0 && md.done % WIDE_EVERY === 0 && md.lastType !== 'wide' && learnedBars.size >= 5) {
      const w = pickWide(piece, md, learnedBars, now);
      if (w) return w;
    }
    // 2) revisão dos compassos com mais erros (alternando com material novo)
    //    entra também o compasso que trava a seção atual depois de 2 tentativas sem passagem limpa
    const stuckSec = firstNew && md.sections[firstNew.id] && md.sections[firstNew.id].tries >= 2 && !md.sections[firstNew.id].clean ? firstNew : null;
    const pool = new Set(learnedBars);
    if (stuckSec) for (let b = stuckSec.from; b <= stuckSec.to; b++) pool.add(b);
    const weak = [...pool].map(b => ({ b, w: weakness(md.bars[b], now) })).filter(x => x.w >= WEAK).sort((a, b) => b.w - a.w);
    if (weak.length && md.lastType !== 'errors') {
      const worst = weak[0].b;
      const sec = secs.find(s => worst >= s.from && worst <= s.to);
      const pct = Math.round(md.bars[worst].err * 100);
      if (stuckSec && sec.id === stuckSec.id) {
        return { type: 'errors', from: worst, to: worst, focus: worst, label: barLabel(worst, worst),
          why: `O compasso ${worst} está travando esta seção (${pct}% de erro). Isole só ele, devagar, depois volte à seção.` };
      }
      return { type: 'errors', from: sec.from, to: sec.to, focus: worst, label: barLabel(sec.from, sec.to),
        why: `Você errou ${pct}% das notas no compasso ${worst} nas últimas tentativas. Vamos firmar esse trecho.` };
    }
    // 3) seção nova (ou continuar a atual até ficar firme)
    if (firstNew) {
      const st = md.sections[firstNew.id];
      const tries = st ? st.tries : 0, clean = st ? st.clean : 0;
      const why = !tries ? (firstNew.id === 0 ? 'Começo da peça. Vá devagar e deixe a partitura esperar por você.' : 'Próximo trecho da peça.')
        : `Precisa de ${2 - clean} passagem${2 - clean > 1 ? 's' : ''} limpa${2 - clean > 1 ? 's' : ''} (90% ou mais) para marcar como aprendido.`;
      return { type: 'new', from: firstNew.from, to: firstNew.to, label: barLabel(firstNew.from, firstNew.to), why, sectionId: firstNew.id };
    }
    // 4) tudo aprendido: revisão ampla ou peça inteira
    const w = pickWide(piece, md, learnedBars, now, true);
    return w || { type: 'wide', from: 0, to: piece.bars.length - 2, label: 'Peça inteira', why: 'Tudo aprendido. Toque a peça inteira.' };
  }

  function pickWide(piece, md, learnedBars, now, allowWhole) {
    const arr = [...learnedBars].sort((a, b) => a - b);
    if (!arr.length) return null;
    const size = Math.min(arr.length, 8 + 4 * Math.floor(md.done / 16));
    if (allowWhole && arr.length === piece.bars.length - 1 && md.done % (WIDE_EVERY * 3) === 0)
      return { type: 'wide', from: 0, to: arr[arr.length - 1], label: 'Peça inteira', why: 'Revisão geral: a peça do começo ao fim.' };
    let best = null, bs = -1;
    for (let i = 0; i + size <= arr.length; i++) {
      const from = arr[i], to = arr[i + size - 1];
      if (to - from + 1 !== size) continue;          // só janelas contínuas
      let score = 0;
      for (let b = from; b <= to; b++) {
        const x = md.bars[b];
        const age = x ? (now - (x.wideAt || x.last || 0)) / DAY : 30;
        score += Math.min(age, 30) + (x ? x.err * 3 : 0);
      }
      if (score > bs) { bs = score; best = { from, to }; }
    }
    if (!best) { best = { from: arr[0], to: arr[arr.length - 1] }; }
    return { type: 'wide', ...best, label: barLabel(best.from, best.to),
      why: `Revisão de um trecho maior (${best.to - best.from + 1} compassos) para ligar as seções e não esquecer o que já aprendeu.` };
  }

  function record(piece, hand, ex, result) {
    const md = modeData(piece.id, hand);
    const now = Date.now();
    for (const [b, r] of Object.entries(result.bars)) {
      const x = md.bars[b] || (md.bars[b] = { att: 0, err: 0, hes: 0, last: 0, wrongs: 0 });
      const rate = r.steps ? r.errs / r.steps : 0;
      const hes = r.steps ? r.hes / r.steps : 0;
      x.err = x.att ? x.err * 0.55 + rate * 0.45 : rate;
      x.hes = x.att ? x.hes * 0.55 + hes * 0.45 : hes;
      x.att++; x.last = now; x.wrongs += r.wrongs;
      if (ex.type === 'wide') x.wideAt = now;
    }
    for (const s of sections(piece)) {
      if (s.from < ex.from || s.to > ex.to) continue;
      let st = 0, er = 0;
      for (let b = s.from; b <= s.to; b++) if (result.bars[b]) { st += result.bars[b].steps; er += result.bars[b].errs; }
      if (!st) continue;
      const acc = 1 - er / st;
      const sec = md.sections[s.id] || (md.sections[s.id] = { tries: 0, clean: 0, learned: false });
      sec.tries++;
      sec.clean = acc >= 0.9 ? sec.clean + 1 : 0;
      if (sec.clean >= 2) sec.learned = true;
      sec.last = now;
    }
    md.done++; md.lastType = ex.type;
    md.history.push({ at: now, type: ex.type, from: ex.from, to: ex.to, acc: Math.round(result.accuracy * 100) });
    if (md.history.length > 200) md.history.splice(0, md.history.length - 200);
    save();
  }

  return {
    sections, next, record, barLabel,
    bars(pieceId, hand) { return modeData(pieceId, hand).bars; },
    sectionState(pieceId, hand) { return modeData(pieceId, hand).sections; },
    meta(pieceId, hand) { const m = modeData(pieceId, hand); return { done: m.done, lastType: m.lastType, untilWide: WIDE_EVERY - (m.done % WIDE_EVERY) }; },
    prefs(pieceId) { return prefs(pieceId); },
    savePrefs() { save(); },
    reset(pieceId) { const p = store.pieces[pieceId]; if (p) p.modes = {}; save(); },
  };
})();
