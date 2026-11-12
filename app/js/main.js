/* Estante Noturna: liga partitura, notas caindo, escuta e treinador. */
(() => {
  const $ = id => document.getElementById(id);
  const piece = window.PIECES[0];
  const params = new URLSearchParams(location.search);
  const SELFTEST = params.has('selftest');
  const HAND_NAME = { R: 'mão direita', L: 'mão esquerda', B: 'ambas as mãos' };
  const TYPE_NAME = { new: 'Nova seção', errors: 'Revisar erros', wide: 'Revisão ampla', free: 'Trecho livre', cont: 'Continuar seção', locked: 'Trecho fixo' };

  const prefs = Object.assign({ hand: 'B', mode: 'wait', speed: 0.5, strict: 'normal', names: true, accomp: false, click: true, sens: 5, locked: null, view: 'both', zoom: null }, Coach.prefs(piece.id));
  const savePrefs = () => { Object.assign(Coach.prefs(piece.id), prefs); Coach.savePrefs(); };

  let ex = null, practice = null, demo = null, running = false, wakeLock = null;
  let lastIdx = -1, accompPtr = 0, lastBeat = null, selftestIdx = -1;
  let startBar = null;          // compasso de onde a prática atual começa (pode ser no meio do exercício)
  const pieceNotes = piece.notes;

  // ---------- partitura e teclado ----------
  $('pieceTitle').textContent = piece.title;
  $('pieceSub').textContent = `${piece.composer.split(' ').pop()} · ${piece.key} · ${piece.meter}`;
  $('credit').textContent = piece.credit + '. Composição em domínio público. Som de piano: Salamander Grand Piano (Yamaha C5), de Alexander Holm (CC BY 3.0).';
  const roll = new Roll($('roll'), (m, down) => { if (down) { Sound.note(m, 0.6, 0.6); handleInput(m, 'touch'); } });
  const score = new Score($('score'), piece);
  score.load().then(() => {
    $('scoreLoading').hidden = true;
    if (practice) { score.setRange(ex.from, ex.to); score.moveTo(practice.pos, false); }
  }).catch(err => { $('scoreLoading').textContent = 'Não foi possível desenhar a partitura.'; console.error(err); });
  let rzT; window.addEventListener('resize', () => { clearTimeout(rzT); rzT = setTimeout(() => { score.rerenderIfNeeded(); if (practice) { score.setRange(ex.from, ex.to); score.moveTo(curT(), false); } }, 300); });

  // tocar num compasso da partitura: começa a prática dali (dentro do trecho) ou vai para a seção dele
  score.onBarClick = bar => {
    if (demo) stopDemo();
    if (bar >= ex.from && bar <= ex.to) {
      prepare(bar);
      say(bar === ex.from ? 'Do começo do trecho' : `Começando do compasso ${bar}`, 'ok');
    } else if (prefs.locked) {
      say(`Fora do trecho fixo (${Coach.barLabel(ex.from, ex.to).toLowerCase()}). Saia do trecho para ir até lá.`, 'err', 2600);
    } else {
      const sec = Coach.sections(piece).find(s => bar >= s.from && bar <= s.to);
      setExercise({ type: 'free', from: sec.from, to: sec.to, label: Coach.barLabel(sec.from, sec.to), why: 'Seção escolhida na partitura.' });
      if (bar !== sec.from) prepare(bar);
      say(`Indo para o compasso ${bar}`, 'ok');
    }
  };
  $('btnUnlock').onclick = unlock;

  // ---------- feedback ----------
  let fbT;
  function say(text, kind = '', ms = 1400) {
    const f = $('feedback'); f.textContent = text; f.className = 'feedback show ' + kind;
    clearTimeout(fbT); fbT = setTimeout(() => f.classList.remove('show'), ms);
  }

  // ---------- exercício ----------
  function lockedEx() {
    const { from, to } = prefs.locked;
    return { type: 'locked', from, to, label: Coach.barLabel(from, to),
      why: 'Trecho fixo: ele se repete até você tocar em “Sair do trecho”. Toque num compasso da partitura para começar dali.' };
  }
  function lockPassage(from, to) {
    prefs.locked = { from: Math.min(from, to), to: Math.max(from, to) }; savePrefs();
    setExercise(lockedEx());
  }
  function unlock() {
    prefs.locked = null; savePrefs(); planNext();
  }
  function planNext() {
    if (prefs.locked) { ex = lockedEx(); prepare(); return; }
    ex = Coach.next(piece, prefs.hand);
    if (ex.type === 'new') {
      const st = Coach.sectionState(piece.id, prefs.hand)[ex.sectionId];
      if (st && st.tries) ex.type = 'cont';
    }
    prepare();
  }
  function setExercise(e) { ex = e; prepare(); }

  function prepare(from) {
    stopDemo(); running = false;
    startBar = from != null && from >= ex.from && from <= ex.to ? from : ex.from;
    practice = new Practice(piece, { hand: prefs.hand, fromBar: startBar, toBar: ex.to, mode: prefs.mode, speed: prefs.speed, strict: prefs.strict });
    practice.on('hit', (m) => roll.flashKey(m, roll.col.ok, 250))
      .on('wrong', (m, s) => {
        roll.flashKey(m, roll.col.err, 500);
        const exp = s.notes.filter(n => !s.hit.has(n.m)).map(n => ptName(n.n)).join(' + ');
        say(`${ptName(nameOf(m))} não — ${exp ? 'esperado ' + exp : 'nota errada'}`, 'err');
        if (navigator.vibrate) navigator.vibrate(40);
        updateStats();
      })
      .on('miss', () => updateStats())
      .on('step', () => updateStats())
      .on('finish', onFinish);
    lastIdx = -1; accompPtr = 0; lastBeat = null; selftestIdx = -1;
    const t = $('exType'); t.textContent = TYPE_NAME[ex.type] || ex.type; t.className = 'ex-type t-' + (ex.type === 'cont' ? 'new' : ex.type);
    $('exRange').textContent = `${ex.label}${startBar !== ex.from ? ` (desde o c. ${startBar})` : ''} · ${HAND_NAME[prefs.hand]}`;
    $('exWhy').textContent = ex.why;
    $('btnUnlock').hidden = !prefs.locked;
    setStartLabel('Começar');
    updateStats();
    instantRange = true;
    const lo = piece.bars[startBar], hi = piece.bars[ex.to + 1];
    exNotes = pieceNotes.filter(n => n.t >= lo - 1e-6 && n.t < hi - 1e-6);
    if (score.ready) { score.setRange(ex.from, ex.to); score.moveTo(practice.pos, false); }
  }
  let instantRange = true;
  let exNotes = [];

  function nameOf(m) {
    const n = pieceNotes.find(x => x.m === m);
    return n ? n.n : SHARP_NAMES[m % 12];
  }
  function updateStats() {
    if (!practice) return;
    const p = practice, total = p.steps.length;
    const done = p.steps.filter(s => s.done).length;
    const errs = p.steps.filter(s => s.wrongs || s.missed || s.skipped).length;
    $('statHits').textContent = `${done} / ${total} passos`;
    $('statErr').textContent = `${errs} ${errs === 1 ? 'erro' : 'erros'}`;
    $('statErr').classList.toggle('has', errs > 0);
    $('progressFill').style.width = (total ? done / total * 100 : 0) + '%';
    // resumo compacto sobre as notas (usado com o celular deitado)
    const si = $('stageInfo');
    si.innerHTML = '';
    const b = document.createElement('b'); b.textContent = ex.label;
    si.append(`${TYPE_NAME[ex.type] || ''}: `, b, ` · ${HAND_NAME[prefs.hand]} · ${done}/${total} · ${errs} ${errs === 1 ? 'erro' : 'erros'}`);
    if (prefs.locked) {
      const u = document.createElement('button'); u.textContent = 'Sair do trecho'; u.onclick = unlock; si.append(u);
    }
  }
  function setStartLabel(t) {
    $('btnStartLabel').textContent = t;
    $('btnStart').querySelector('path').setAttribute('d', t === 'Pausar' ? 'M8 5v14M16 5v14' : 'M7 5l12 7-12 7z');
  }

  async function start() {
    Sound.ensure();
    stopDemo();
    if (!practice || practice.finished) prepare();
    if (practice.started && practice.paused) { practice.resume(performance.now()); running = true; setStartLabel('Pausar'); return; }
    if (practice.started && !practice.paused) { practice.pause(performance.now()); running = false; setStartLabel('Continuar'); return; }
    if (!Listener.running && !midiOn && !SELFTEST) await enableMic();
    if (prefs.mode === 'tempo') {
      await countdown();
    }
    practice.start(performance.now());
    running = true; setStartLabel('Pausar');
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch (e) {}
  }
  function countdown() {
    return new Promise(res => {
      const el = $('countdown'); el.hidden = false; let n = 3;
      const tick = () => {
        if (n === 0) { el.hidden = true; res(); return; }
        el.textContent = n; Sound.click(n === 3); n--; setTimeout(tick, 60000 / (piece.tempo8 * prefs.speed) * 3 / 2.2);
      };
      tick();
    });
  }

  function onFinish(r) {
    running = false;
    setStartLabel('Começar');
    try { wakeLock?.release(); } catch (e) {} wakeLock = null;
    const done = ex;
    Coach.record(piece, prefs.hand, { ...done, from: startBar, type: done.type === 'cont' ? 'new' : done.type === 'locked' ? 'free' : done.type }, r);
    const acc = Math.round(r.accuracy * 100);
    $('resAcc').textContent = acc + '%';
    $('resErr').textContent = r.errSteps;
    const sec = Math.round(r.seconds);
    $('resTime').textContent = sec >= 60 ? `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}` : sec + 's';
    const rb = $('resBars'); rb.innerHTML = '';
    for (const [b, x] of Object.entries(r.bars)) {
      const rate = x.steps ? x.errs / x.steps : 0;
      const d = document.createElement('div'); d.className = 'res-bar';
      d.style.borderColor = rate === 0 ? 'var(--ok)' : rate < 0.2 ? 'var(--warn)' : 'var(--err)';
      d.innerHTML = `<b>${b === '0' ? 'ana.' : 'c. ' + b}</b>${Math.round((1 - rate) * 100)}%`;
      rb.appendChild(d);
    }
    const worst = Object.entries(r.bars).sort((a, b) => (b[1].errs / b[1].steps) - (a[1].errs / a[1].steps))[0];
    $('resMsg').textContent = acc >= 90 ? 'Passagem limpa. Conta para marcar o trecho como aprendido.'
      : acc >= 70 ? `Quase. O compasso ${worst[0]} foi o mais difícil; ele entra na fila de revisão.`
      : `Muitos erros no compasso ${worst[0]}. Experimente mais devagar ou só com uma mão.`;
    if (prefs.locked) {
      $('resNext').textContent = `Trecho fixo · ${ex.label}`;
      $('btnNext').textContent = 'Tocar de novo';
      $('btnRepeat').textContent = 'Sair do trecho';
    } else {
      const nx = Coach.next(piece, prefs.hand);
      $('resNext').textContent = `${TYPE_NAME[nx.type]} · ${nx.label}`;
      $('btnNext').textContent = 'Continuar';
      $('btnRepeat').textContent = 'Repetir este';
    }
    $('resultSheet').hidden = false;
    console.log('[resultado]', JSON.stringify({ acc, errSteps: r.errSteps, steps: r.steps, wrong: r.wrongNotes }));
  }
  $('btnNext').onclick = () => { $('resultSheet').hidden = true; prefs.locked ? prepare(startBar) : planNext(); };
  $('btnRepeat').onclick = () => { $('resultSheet').hidden = true; prefs.locked ? unlock() : prepare(startBar); };

  $('btnStart').onclick = start;
  $('btnRestart').onclick = () => { prepare(startBar); };
  $('btnSkip').onclick = () => {
    if (!practice || !practice.started) { say('Comece o trecho primeiro'); return; }
    if (prefs.mode !== 'wait') { say('Pular só funciona no modo Espera'); return; }
    practice.skip(performance.now()); updateStats();
  };

  // ---------- entrada ----------
  function handleInput(m, src) {
    if (demo) return;
    if (!practice || !practice.started || practice.finished) {
      roll.flashKey(m, src === 'mic' ? roll.col.muted : roll.col.R, 300);
      return;
    }
    const r = practice.input(m, performance.now(), src);
    if (r === 'ignored' && src !== 'mic') roll.flashKey(m, roll.col.muted, 200);
    return r;
  }

  // microfone
  Listener.setSensitivity(prefs.sens);
  Listener.onLevel(v => { $('micLevel').style.transform = `scaleX(${v})`; });
  let loud = null;     // volume típico das notas certas (dB), para filtrar fantasmas fracos
  Listener.onOnsets(cands => {
    for (const c of cands) {
      let r;
      if (c.exp) {
        r = handleInput(c.m, 'mic');
        if (r === 'hit') loud = loud == null ? c.db : loud * 0.8 + c.db * 0.2;
      } else if (!c.harmonic && (loud == null || c.db >= loud - 8)) r = handleInput(c.m, 'mic');
      // mostra no teclado o que o microfone ouviu, mesmo quando não conta para a prática
      if (r === 'ignored' && !c.harmonic) roll.flashKey(c.m, roll.col.muted, 220);
    }
  });
  async function enableMic() {
    try {
      await Listener.startMic();
      $('btnMic').classList.add('on'); $('btnMic').classList.remove('denied');
      $('btnMic').setAttribute('aria-label', 'Desligar microfone');
      say('Ouvindo pelo microfone. Notas ouvidas piscam em cinza no teclado.', 'ok', 2600);
      setInputInfo(); return true;
    } catch (e) {
      $('btnMic').classList.add('denied');
      say(e.message === 'insecure' ? 'O microfone exige https (ou localhost)' : 'Sem acesso ao microfone. Libere a permissão no navegador; o teclado da tela continua funcionando.', 'err', 4000);
      setInputInfo(); return false;
    }
  }
  $('btnMic').onclick = async () => {
    if (Listener.running) {
      Listener.stop(); $('btnMic').classList.remove('on'); $('btnMic').setAttribute('aria-label', 'Ligar microfone');
      setInputInfo(); return;
    }
    await enableMic();
  };

  // MIDI
  let midiOn = false;
  $('btnMidi').onclick = async () => {
    if (!navigator.requestMIDIAccess) { say('Este navegador não tem Web MIDI (use Chrome no Android ou no computador)', 'err', 3500); return; }
    try {
      const acc = await navigator.requestMIDIAccess();
      const bind = () => {
        let n = 0;
        acc.inputs.forEach(inp => {
          n++;
          inp.onmidimessage = e => {
            const [st, m, v] = e.data;
            if ((st & 0xf0) === 0x90 && v > 0) handleInput(m, 'midi');
          };
        });
        midiOn = n > 0; setInputInfo();
        say(midiOn ? 'Teclado MIDI conectado' : 'Nenhum teclado MIDI encontrado', midiOn ? 'ok' : 'err', 2200);
      };
      acc.onstatechange = bind; bind();
    } catch (e) { say('Acesso MIDI negado', 'err'); }
  };
  function setInputInfo() {
    const parts = [];
    if (Listener.running) parts.push('Microfone ligado');
    if (midiOn) parts.push('teclado MIDI conectado');
    $('inputInfo').textContent = parts.length ? parts.join(' · ') + '. O teclado da tela também funciona.' : 'Microfone desligado. Toque no teclado da tela para testar.';
  }

  // ---------- ouvir o trecho ----------
  function startDemo() {
    Sound.ensure();
    if (practice && practice.started && !practice.finished) { practice.pause(performance.now()); running = false; setStartLabel('Continuar'); }
    const t0 = piece.bars[ex.from], t1 = piece.bars[ex.to + 1];
    const wps = (piece.tempo8 / 8 / 60) * prefs.speed;
    const startAt = Sound.now + 0.15;
    for (const n of pieceNotes) {
      if (n.t < t0 - 1e-6 || n.t >= t1 - 1e-6) continue;
      const mine = prefs.hand === 'B' || n.h === prefs.hand;
      Sound.note(n.m, Math.max(0.12, n.d / wps), mine ? 0.7 : 0.4, startAt + (n.t - t0) / wps);
    }
    demo = { t0, t1, wps, clock: performance.now() + 150 };
    $('btnListen').lastChild.textContent = 'Parar';
  }
  function stopDemo() {
    if (!demo) return;
    demo = null; Sound.stopAll();
    $('btnListen').lastChild.textContent = 'Ouvir';
    if (practice) score.moveTo(curT(), false);
  }
  $('btnListen').onclick = () => demo ? stopDemo() : startDemo();

  // ---------- laço de desenho ----------
  function curT() {
    if (demo) return demo.t0 + Math.max(0, (performance.now() - demo.clock) / 1000 * demo.wps);
    return practice ? practice.pos : 0;
  }
  // lógica (relógio, avanço, metrônomo) num timer próprio; desenho no requestAnimationFrame
  function logic() {
    const now = performance.now();
    if (demo) {
      const pos = curT();
      if (pos > demo.t1 + 0.05) stopDemo();
      else if (score.ready) score.moveTo(pos);
      return;
    }
    const p = practice; if (!p) return;
    p.update(now);
    if (prefs.mode === 'wait') {
      if (p.idx !== lastIdx) {
        const s = p.current;
        if (score.ready) score.moveTo(s ? s.t : p.t1);
        if (prefs.accomp && p.started && lastIdx >= 0) playAccomp(p.steps[lastIdx].t, s ? s.t : p.t1);
        lastIdx = p.idx;
      }
    } else if (p.started && !p.paused && !p.finished) {
      if (score.ready) score.moveTo(Math.max(p.pos, p.t0));
      tempoSide(p, p.pos);
    }
    Listener.setExpected(p.started && !p.finished ? p.expected : []);
    if (SELFTEST) selftestDrive(p);
  }
  setInterval(logic, 16);

  function frame() { draw(); requestAnimationFrame(frame); }
  function draw() {
    let pos = 0, current = null, currentT = -1, hits = null;
    const curHand = new Map(), curName = new Map();
    if (demo) { pos = curT(); currentT = pos; }
    else if (practice) {
      const p = practice;
      pos = p.pos;
      if (prefs.mode === 'wait') {
        const s = p.current;
        if (s) {
          current = new Set(s.notes.map(n => n.m)); currentT = s.t; hits = s.hit;
          s.notes.forEach(n => { curHand.set(n.m, roll.col[n.h]); curName.set(n.m, n.n); });
        } else currentT = p.t1;
      } else {
        const tol = p.tolW();
        currentT = pos - tol;
        current = new Set(); hits = new Set();
        for (const s of p.steps) {
          if (s.t < pos - tol) continue; if (s.t > pos + tol) break;
          s.notes.forEach(n => { current.add(n.m); curHand.set(n.m, roll.col[n.h]); curName.set(n.m, n.n); });
          s.hit.forEach(m => hits.add(m));
        }
      }
    }
    roll.draw({
      pos, notes: exNotes, activeHand: prefs.hand, current, currentT, hits, curHand, curName,
      bars: piece.bars, showNames: prefs.names, span: 1.6, instant: instantRange,
    });
    instantRange = false;
  }

  function playAccomp(fromT, toT) {
    const wps = practice.wps;
    for (const n of practice.other) {
      if (n.t >= fromT - 1e-6 && n.t < toT - 1e-6) Sound.note(n.m, Math.max(0.15, n.d / wps), 0.45, Sound.now + (n.t - fromT) / wps * 0.6);
    }
  }
  function tempoSide(p, pos) {
    // metrônomo: semínima pontuada (3 colcheias), acento na cabeça do compasso
    if (prefs.click && pos >= p.t0 - 1e-3) {
      const bi = piece.bars.findIndex((b, i) => pos >= b && pos < piece.bars[i + 1]);
      const bs = piece.bars[Math.max(0, bi)];
      const beat = bi * 1000 + Math.floor((pos - bs) / (3 / 8) + 1e-6);
      if (beat !== lastBeat) { Sound.click(Math.floor((pos - bs) / (3 / 8) + 1e-6) === 0); lastBeat = beat; }
    }
    if (prefs.accomp) {
      const oth = p.other;
      while (accompPtr < oth.length && oth[accompPtr].t <= pos) {
        const n = oth[accompPtr++];
        if (pos - n.t < 0.05) Sound.note(n.m, Math.max(0.15, n.d / p.wps), 0.45);
      }
    }
  }

  // autoteste: o próprio app toca as notas esperadas e escuta pelo “microfone” interno
  let selftestAt = 0;
  window.__selftestLog = [];
  function selftestDrive(p) {
    if (!p.started || p.finished || p.paused || p.o.mode !== 'wait') return;
    const now = performance.now();
    if (p.idx === selftestIdx && now - selftestAt < 1300) return;
    const retry = p.idx === selftestIdx;
    selftestIdx = p.idx; selftestAt = now;
    const s = p.current; if (!s) return;
    const idx = p.idx;
    if (retry) window.__selftestLog.push({ idx, bar: s.bar, notes: s.notes.map(n => n.m), hit: [...s.hit] });
    setTimeout(() => {
      if (p.idx !== idx || p.finished) return;
      const wrong = params.get('selftest') === 'wrong' && idx % 7 === 3 && !retry;
      s.notes.forEach(n => Sound.note(wrong ? n.m + 1 : n.m, 0.35, 0.75));
      if (wrong) setTimeout(() => { if (p.idx === idx) s.notes.forEach(n => Sound.note(n.m, 0.35, 0.75)); }, 450);
    }, 220);
  }

  // ---------- mãos ----------
  function setHand(h) {
    prefs.hand = h; savePrefs();
    document.querySelectorAll('.hand').forEach(b => b.setAttribute('aria-checked', String(b.dataset.hand === h)));
    $('mapHand').textContent = HAND_NAME[h];
    planNext();
  }
  document.querySelectorAll('.hand').forEach(b => b.onclick = () => setHand(b.dataset.hand));

  // ---------- mapa ----------
  let selA = null, selB = null, dragging = false;
  function openMap() {
    if (prefs.locked) { selA = prefs.locked.from; selB = prefs.locked.to; }
    renderMap(); $('mapSheet').hidden = false;
  }
  function renderMap() {
    const bars = Coach.bars(piece.id, prefs.hand);
    const g = $('mapGrid'); g.innerHTML = '';
    const nb = piece.bars.length - 1;
    for (let i = 0; i < nb; i++) {
      const x = bars[i];
      const c = document.createElement('button'); c.className = 'cell'; c.dataset.bar = i;
      c.textContent = i === 0 ? 'ana' : i;
      let label = 'não tocado';
      if (x && x.att) {
        const e = x.err + 0.5 * (x.hes || 0);
        c.style.background = e < 0.08 ? 'var(--ok)' : e < 0.25 ? 'var(--warn)' : 'var(--err)';
        c.style.color = '#14141c'; c.style.borderColor = 'transparent';
        label = `${Math.round(x.err * 100)}% de erro, ${x.att} tentativas`;
        if (x.wrongs > 0) { const tr = document.createElement('i'); tr.className = 'tri'; c.appendChild(tr); }
      }
      c.setAttribute('aria-label', `Compasso ${i}: ${label}`); c.title = label;
      g.appendChild(c);
    }
    paintSel();

    const secs = Coach.sections(piece), st = Coach.sectionState(piece.id, prefs.hand);
    const sl = $('sectionList'); sl.innerHTML = '';
    for (const s of secs) {
      const x = st[s.id];
      const btn = document.createElement('button'); btn.className = 'sec';
      const stat = x ? (x.learned ? 'aprendida' : `${x.tries} tentativa${x.tries > 1 ? 's' : ''}`) : 'nova';
      btn.innerHTML = `<span>${Coach.barLabel(s.from, s.to)}</span><span class="st ${x && x.learned ? 'learned' : ''}">${stat}</span>`;
      btn.onclick = () => { $('mapSheet').hidden = true; lockPassage(s.from, s.to); };
      sl.appendChild(btn);
    }
    const meta = Coach.meta(piece.id, prefs.hand);
    const weak = Object.entries(bars).filter(([, x]) => x.att && x.err >= 0.15).sort((p, q) => q[1].err - p[1].err).slice(0, 5).map(([b]) => b);
    $('planInfo').textContent = `${meta.done} exercício${meta.done === 1 ? '' : 's'} feito${meta.done === 1 ? '' : 's'} com ${HAND_NAME[prefs.hand]}. ` +
      `Próxima revisão ampla em ${meta.untilWide} exercício${meta.untilWide === 1 ? '' : 's'} (quando houver 5+ compassos aprendidos). ` +
      (weak.length ? `Compassos na fila de revisão de erros: ${weak.join(', ')}.` : 'Nenhum compasso na fila de revisão de erros.');
  }
  function selRange() { if (selA == null) return null; const b = selB ?? selA; return [Math.min(selA, b), Math.max(selA, b)]; }
  function paintSel() {
    const r = selRange();
    document.querySelectorAll('#mapGrid .cell').forEach(c => {
      const i = +c.dataset.bar;
      c.classList.toggle('inrange', !!r && i >= r[0] && i <= r[1]);
      c.classList.toggle('sel', !!r && (i === r[0] || i === r[1]));
    });
    $('btnMapGo').disabled = !r;
    $('btnMapClear').hidden = !r;
    let lbl = 'Toque no compasso inicial';
    if (r && selB == null) lbl = `Início: ${r[0] === 0 ? 'anacruse' : 'c. ' + r[0]}. Agora toque no compasso final.`;
    else if (r) lbl = `${Coach.barLabel(r[0], r[1])} (${r[1] - r[0] + 1} compassos)`;
    $('mapSelLabel').textContent = lbl;
  }
  const cellAt = (x, y) => { const el = document.elementFromPoint(x, y); const c = el && el.closest('#mapGrid .cell'); return c ? +c.dataset.bar : null; };
  $('mapGrid').addEventListener('pointerdown', e => {
    const i = cellAt(e.clientX, e.clientY); if (i == null) return;
    e.preventDefault();
    if (selA != null && selB == null && i !== selA) { selB = i; paintSel(); return; }   // segundo toque = fim
    selA = i; selB = null; dragging = true; paintSel();
  });
  $('mapGrid').addEventListener('pointermove', e => {
    if (!dragging) return;
    const i = cellAt(e.clientX, e.clientY);
    if (i != null && i !== (selB ?? selA)) { selB = i === selA ? null : i; paintSel(); }
  });
  const endDrag = () => { dragging = false; };
  window.addEventListener('pointerup', endDrag); window.addEventListener('pointercancel', endDrag);
  $('btnMapClear').onclick = () => { selA = selB = null; paintSel(); };
  $('btnMapGo').onclick = () => {
    const r = selRange(); if (!r) return;
    $('mapSheet').hidden = true;
    lockPassage(r[0], r[1]);
    say(`Trecho fixo: ${Coach.barLabel(r[0], r[1]).toLowerCase()}`, 'ok', 2000);
  };
  $('btnMap').onclick = openMap;

  // ---------- ajustes ----------
  function syncSettings() {
    document.querySelectorAll('#setMode button').forEach(b => b.classList.toggle('on', b.dataset.v === prefs.mode));
    document.querySelectorAll('#setStrict button').forEach(b => b.classList.toggle('on', b.dataset.v === prefs.strict));
    $('setSpeed').value = Math.round(prefs.speed * 100);
    $('setSpeedVal').textContent = Math.round(prefs.speed * 100) + '%';
    $('setSpeedBpm').textContent = `(colcheia = ${Math.round(piece.tempo8 * prefs.speed)})`;
    $('setNames').checked = prefs.names; $('setAccomp').checked = prefs.accomp; $('setClick').checked = prefs.click;
    $('setSens').value = prefs.sens;
  }
  const changed = (rebuild = true) => { savePrefs(); syncSettings(); if (rebuild && !(practice && practice.started && !practice.finished)) prepare(); };
  document.querySelectorAll('#setMode button').forEach(b => b.onclick = () => { prefs.mode = b.dataset.v; changed(); prepare(); });
  document.querySelectorAll('#setStrict button').forEach(b => b.onclick = () => { prefs.strict = b.dataset.v; changed(); });
  $('setSpeed').oninput = e => { prefs.speed = e.target.value / 100; changed(); };
  $('setNames').onchange = e => { prefs.names = e.target.checked; changed(false); };
  $('setAccomp').onchange = e => { prefs.accomp = e.target.checked; changed(false); };
  $('setClick').onchange = e => { prefs.click = e.target.checked; changed(false); };
  $('setSens').oninput = e => { prefs.sens = +e.target.value; Listener.setSensitivity(prefs.sens); changed(false); };
  let resetArm = false;
  $('btnReset').onclick = () => {
    if (!resetArm) { resetArm = true; $('resetConfirm').hidden = false; setTimeout(() => { resetArm = false; $('resetConfirm').hidden = true; }, 4000); return; }
    Coach.reset(piece.id); resetArm = false; $('resetConfirm').hidden = true; say('Progresso zerado'); planNext();
  };
  $('btnSettings').onclick = () => { syncSettings(); setInputInfo(); $('settingsSheet').hidden = false; };
  document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => { $(b.dataset.close).hidden = true; });
  document.querySelectorAll('.sheet').forEach(sh => sh.addEventListener('click', e => { if (e.target === sh && sh.id !== 'resultSheet') sh.hidden = true; }));

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && practice && practice.started && !practice.finished && !practice.paused) { practice.pause(performance.now()); running = false; setStartLabel('Continuar'); }
  });
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    if (e.code === 'Space') { e.preventDefault(); start(); }
  });

  // ---------- o que mostrar: partitura, teclado ou ambos ----------
  const VIEWS = ['both', 'score', 'roll'];
  const VIEW_LABEL = { both: 'Partitura + teclado', score: 'Só partitura', roll: 'Só teclado' };
  const VIEW_ICON = { both: 'M4 10h16', score: 'M4 14h16M8 8h8', roll: 'M4 13h16M8 13v7M12 13v7M16 13v7' };
  function setView(v, announce) {
    prefs.view = v; savePrefs();
    $('app').dataset.view = v;
    $('viewIconPath').setAttribute('d', VIEW_ICON[v]);
    $('btnView').setAttribute('aria-label', 'Mostrar: ' + VIEW_LABEL[v]);
    document.querySelectorAll('#setView button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
    setTimeout(() => {
      score.rerenderIfNeeded();
      if (practice && score.ready) { score.setRange(ex.from, ex.to); score.moveTo(curT(), false); }
    }, 60);
    if (announce) say(VIEW_LABEL[v]);
  }
  $('btnView').onclick = () => setView(VIEWS[(VIEWS.indexOf(prefs.view) + 1) % VIEWS.length], true);
  document.querySelectorAll('#setView button').forEach(b => b.onclick = () => setView(b.dataset.v));

  // ---------- zoom do teclado ----------
  function paintZoom() {
    $('btnZoomFit').classList.toggle('on', !roll.zoomKeys);
    $('btnZoomFit').textContent = roll.zoomKeys ? Math.round(roll.zoomKeys) + ' teclas' : 'Auto';
  }
  roll.onZoom = k => { prefs.zoom = k; savePrefs(); paintZoom(); };
  roll.zoomKeys = prefs.zoom || null;
  $('btnZoomIn').onclick = () => roll.zoomBy(0.78);
  $('btnZoomOut').onclick = () => roll.zoomBy(1.28);
  $('btnZoomFit').onclick = () => roll.setZoom(null);
  paintZoom();

  // ---------- início ----------
  setView(prefs.view);
  setHand(prefs.hand);
  syncSettings();
  if (SELFTEST) {
    $('btnMic').classList.add('on');
    // ?selftest=mic toca pelos alto-falantes e escuta pelo microfone de verdade
    document.addEventListener('click', () => {
      if (Listener.running) return;
      if (params.get('selftest') === 'mic') Listener.startMic().catch(e => say('Microfone: ' + e.message, 'err', 4000));
      else Listener.startLoopback();
    }, { once: true, capture: true });
  }
  requestAnimationFrame(frame);
  window.__app = { get practice() { return practice; }, get ex() { return ex; }, piece, Coach, Listener, setExercise, start, score, lockPassage, unlock, roll, redraw: draw };
})();
