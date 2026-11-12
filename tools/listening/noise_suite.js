const sim = require('./sim.js');
(async () => {
  const samples = await sim.loadSamples();
  const rows = [];
  const conds = [
    { tag: 'silêncio' },
    { tag: 'voz longe', interf: { type: 'voz', level: 0.004 } },
    { tag: 'voz perto', interf: { type: 'voz', level: 0.02 } },
    { tag: 'TV música longe', interf: { type: 'tv', level: 0.006 } },
    { tag: 'batidas', interf: { type: 'batidas', level: 0.03 } },
    { tag: 'chiado', interf: { type: 'chiado', level: 0.01 } },
  ];
  const sensList = (process.argv[2] || '2,5,8').split(',').map(Number);
  for (const sens of sensList) for (const c of conds) for (const b of [{ n: 'D', hand: 'R', from: 0, to: 2 }, { n: 'Ambas', hand: 'B', from: 0, to: 2 }]) {
    const r = sim.simulate(samples, { name: b.n, hand: b.hand, from: b.from, to: b.to, sens, pauseMs: 2200, seed: 9, ...c });
    rows.push(`sens${sens} ${(c.tag + ' ' + b.n).padEnd(22)} ${String(r.done).padStart(2)}/${r.steps} avanço-sozinho ${String(r.falseAdv).padStart(2)}  erradas-falsas ${String(r.falseWrong).padStart(2)}  repetições ${String(r.replays).padStart(2)}  atraso med ${r.latMed}ms p90 ${r.latP90}ms`);
  }
  console.log(rows.join('\n'));
})();
