const sim = require('./sim.js');
(async () => {
  const samples = await sim.loadSamples(); const rows = [];
  const runs = [
    ['D baixo sens5', { hand: 'R', from: 0, to: 4, sens: 5, gain: 0.12, noise: 0.002 }],
    ['D baixo sens8', { hand: 'R', from: 0, to: 4, sens: 8, gain: 0.12, noise: 0.002 }],
    ['E baixo sens8', { hand: 'L', from: 0, to: 4, sens: 8, gain: 0.12, noise: 0.002 }],
    ['Ambas baixo sens8', { hand: 'B', from: 0, to: 4, sens: 8, gain: 0.12, noise: 0.002 }],
    ['E normal sens5', { hand: 'L', from: 0, to: 4, sens: 5 }],
    ['Ambas normal sens5', { hand: 'B', from: 0, to: 4, sens: 5 }],
    ['D chiado sens8 pausa', { hand: 'R', from: 0, to: 2, sens: 8, pauseMs: 2200, interf: { type: 'chiado', level: 0.01 } }],
    ['Ambas chiado sens8 pausa', { hand: 'B', from: 0, to: 2, sens: 8, pauseMs: 2200, interf: { type: 'chiado', level: 0.01 } }],
    ['D TV sens8 pausa', { hand: 'R', from: 0, to: 2, sens: 8, pauseMs: 2200, interf: { type: 'tv', level: 0.006 } }],
    ['D silêncio sens0 pausa', { hand: 'R', from: 0, to: 4, sens: 0, pauseMs: 1500 }],
    ['Ambas silêncio sens0 pausa', { hand: 'B', from: 0, to: 4, sens: 0, pauseMs: 1500 }],
    ['D c13-16 sens5', { hand: 'R', from: 13, to: 16, sens: 5 }],
  ];
  for (const [n, sc] of runs) { const r = sim.simulate(samples, { seed: 9, ...sc }); rows.push(`${n.padEnd(28)} ${r.done}/${r.steps} sozinho ${r.falseAdv} erradas ${r.falseWrong} repetições ${r.replays} atraso ${r.latMed}/${r.latP90}ms`); }
  console.log(rows.join('\n'));
})();
