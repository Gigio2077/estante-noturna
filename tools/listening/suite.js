const sim = require('./sim.js'), perf = require('./perf.js');
const S = process.env.SDIR;
(async () => {
  const samples = await sim.loadSamples();
  const only = process.argv[2] || 'all';
  const rows = [];
  if (only === 'all' || only === 'wait') {
    const base = [
      { name: 'Espera D c0-4', hand: 'R', from: 0, to: 4 },
      { name: 'Espera E c0-4', hand: 'L', from: 0, to: 4 },
      { name: 'Espera Ambas c0-4', hand: 'B', from: 0, to: 4 },
      { name: 'Espera D c13-16', hand: 'R', from: 13, to: 16 },
      { name: 'Espera D c32 cadência', hand: 'R', from: 32, to: 32 },
      { name: 'Espera E c25-28', hand: 'L', from: 25, to: 28 },
    ];
    const conds = [
      { tag: 'sens2', sens: 2 }, { tag: 'sens5', sens: 5 }, { tag: 'sens8', sens: 8 },
      { tag: 'baixo', sens: 5, gain: 0.12, noise: 0.002 }, { tag: 'ruído', sens: 5, noise: 0.01 },
    ];
    for (const b of base) for (const c of conds) {
      const r = sim.simulate(samples, { ...b, ...c, seed: 3 });
      rows.push(`${(b.name + ' ' + c.tag).padEnd(32)} passos ${String(r.done).padStart(3)}/${String(r.steps).padEnd(3)} repetições ${String(r.replays).padStart(3)}  erros falsos ${r.falseWrong}`);
    }
    for (const c of [{ tag: 'sens5', sens: 5 }, { tag: 'sens2', sens: 2 }]) {
      const r = sim.simulate(samples, { name: 'inj', hand: 'R', from: 0, to: 4, wrongEvery: 4, seed: 5, ...c });
      rows.push(`${('Erro proposital D ' + c.tag).padEnd(32)} injetados ${r.injected} marcados ${r.flagged} (repetições ${r.replays})`);
      const r2 = sim.simulate(samples, { name: 'inj', hand: 'B', from: 0, to: 2, wrongEvery: 4, seed: 5, ...c });
      rows.push(`${('Erro proposital Ambas ' + c.tag).padEnd(32)} injetados ${r2.injected} marcados ${r2.flagged} (repetições ${r2.replays})`);
    }
  }
  if (only === 'all' || only === 'tempo') {
    for (const [f, hand, to] of [['rh', 'R', 4], ['both', 'B', 2]]) {
      const { x } = perf.readWav(`${S}/rec/${f}.wav`);
      for (const c of [{ tag: 'limpo' }, { tag: 'ruído', noise: 0.004 }, { tag: 'baixo', gain: 0.1, noise: 0.001 }]) {
        const y = x.map(v => v * (c.gain || 1) + (c.noise ? (Math.random() * 2 - 1) * c.noise : 0));
        const r = perf.evaluate(y, { name: f, hand, from: 0, to, speed: 0.5, sens: 5 });
        rows.push(`${('No ritmo ' + f + ' ' + c.tag).padEnd(32)} precisão ${r.acc}%  perdidas ${r.misses}  erradas falsas ${r.wrongs}`);
      }
    }
  }
  console.log(rows.join('\n'));
})();
