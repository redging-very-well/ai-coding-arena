// Print the balance numbers recorded in docs/balance.md (plan §14): the
// archetype round robin, all-tower battles per map style, turtle vs rush and
// the Ring 8 free-for-all rotations; M8.5: the walls-and-factories archetypes
// in the same round robin, all-building armies per map style, fortress vs
// rush, 2-team Lanes and a Ring 8 free-for-all with buildings, and the
// engine time per battle. Same harness as tests/balance.test.ts.
//
//   npx tsx --conditions=source scripts/balance-matrix.ts

import { DEFAULT_CONFIG, mapFor, type MapStyle } from '@pixel-clash/shared';
import {
  ALL_ARCHETYPES,
  ARCHETYPES,
  DUEL_SITES,
  OPEN_FORTRESS,
  RUSH,
  SEEDS,
  armyCost,
  balanceBattle,
  duel,
  lanesTeams,
  matrixMarkdown,
  roundRobin,
  type Archetype,
  type BalanceBattle,
} from '../tests/helpers/balance.js';

const byKey = (k: string): Archetype =>
  k === RUSH.key ? RUSH : k === OPEN_FORTRESS.key ? OPEN_FORTRESS : ALL_ARCHETYPES.find((a) => a.key === k)!;
/** Engine time of every battle that has a wall or a factory in it (lean runner, so this is the sim alone). */
const buildingTimes: Array<{ ms: number; ticks: number }> = [];
const timed = (b: BalanceBattle, entrants: Archetype[]) => {
  if (entrants.some((a) => ARCHETYPES.indexOf(a) < 0 && a !== RUSH)) buildingTimes.push({ ms: b.ms, ticks: b.result.endTick });
  return b;
};
const sd = DEFAULT_CONFIG.suddenDeath;
const s = (ticks: number | null) => (ticks === null ? '-' : `${(ticks / 60).toFixed(1)} s`);

async function main(): Promise<void> {
  console.log(`Sudden death: from ${sd.startTick / 60} s, radius ${sd.startRadius} → ${sd.endRadius} (800 arena), ${sd.damagePctPerSecond}% max HP/s\n`);
  console.log('## Archetypes\n');
  for (const a of [...ALL_ARCHETYPES, RUSH, OPEN_FORTRESS]) console.log(`- ${a.key}: ${a.label}, $${armyCost(a)}`);

  console.log('\n## Round robin (row W-D-L vs column; the first six are the §14 matrix)\n');
  const m = await roundRobin(ALL_ARCHETYPES, undefined, (a, b, battle) => timed(battle, [a, b]));
  console.log(matrixMarkdown(m, ALL_ARCHETYPES));
  const perPair = DUEL_SITES.reduce((n, site) => n + site.pairs.length * 2, 0) * SEEDS.length;
  const rate = (row: Map<string, { wins: number }>, keys?: Set<string>) => {
    const cells = [...row].filter(([k]) => !keys || keys.has(k));
    const wins = cells.reduce((n, [, c]) => n + c.wins, 0);
    return `${wins}/${perPair * cells.length} (${Math.round((100 * wins) / (perPair * cells.length))}%)`;
  };
  const old = new Set(ARCHETYPES.map((a) => a.key));
  console.log('\n| archetype | wins vs the six | wins vs all 12 |\n|---|---|---|');
  for (const [a, row] of m) console.log(`| ${a} | ${old.has(a) ? rate(row, old) : '-'} | ${rate(row)} |`);

  console.log('\n## All-tower battles\n');
  console.log('| map | armies | zones | first hit | circle reaches | towers lost | end | places |');
  console.log('|---|---|---|---|---|---|---|---|');
  const sites: Array<[MapStyle, number]> = [['duel', 2], ['triangle', 3], ['corners', 4], ['ring', 8], ['lanes', 8], ['islands', 8]];
  for (const [style, n] of sites) {
    const map = mapFor(style, n);
    for (const [ka, kb] of [['turtle', 'turtle'], ['snipers', 'turtle'], ['snipers', 'snipers']] as const) {
      for (const zones of n === 2 ? [[0, 1]] : [[0, Math.floor(n / 2)], map.zones.map((z) => z.index)]) {
        const b = await balanceBattle(style, n, zones.map((zone, i) => ({ archetype: byKey(i % 2 ? kb : ka), zone })), 7);
        const reach = b.suddenDeathBy.filter((t): t is number => t !== null);
        console.log(
          `| ${style} ${n} | ${ka} / ${kb} | ${zones.length === n ? 'all' : zones.join(', ')} | ${s(b.firstContactTick)} | ${reach.length ? s(Math.min(...reach)) : '-'} | ${b.lost.join(', ')} | ${s(b.result.endTick)} ${b.result.endReason} | ${b.places.join(', ')} |`,
        );
      }
    }
  }

  console.log('\n## All-building armies (M8.5)\n');
  console.log('| map | armies | zones | first hit | lost (placed) | standing | end | places |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const [style, n] of sites) {
    const map = mapFor(style, n);
    for (const [ka, kb] of [['fortress', 'fortress'], ['bunker', 'fortress'], ['snipewall', 'bunker']] as const) {
      for (const zones of n === 2 ? [[0, 1]] : [[0, Math.floor(n / 2)], map.zones.map((z) => z.index)]) {
        const armies = zones.map((_, i) => byKey(i % 2 ? kb : ka));
        const b = timed(await balanceBattle(style, n, zones.map((zone, i) => ({ archetype: armies[i]!, zone })), 7), armies);
        const standing = b.standing.map((st) => Object.entries(st).map(([t, k]) => `${k} ${t}`).join(' + ') || 'none');
        console.log(
          `| ${style} ${n} | ${ka} / ${kb} | ${zones.length === n ? 'all' : zones.join(', ')} | ${s(b.firstContactTick)} | ${b.lost.join(', ')} | ${standing.join('; ')} | ${s(b.result.endTick)} ${b.result.endReason} | ${b.places.join(', ')} |`,
        );
      }
    }
  }

  console.log('\n## Fortress vs rush (M8.5)\n');
  for (const fort of [OPEN_FORTRESS, byKey('fortress')]) {
    let rushWins = 0;
    const ends: string[] = [];
    for (const site of DUEL_SITES)
      for (const [z1, z2] of site.pairs)
        for (const seed of SEEDS)
          for (const [za, zb] of [[z1, z2], [z2, z1]] as Array<[number, number]>) {
            const d = await duel(site.style, site.players, RUSH, fort, [za, zb], seed);
            timed(d.battle, [fort]);
            rushWins += d.outcome === 1 ? 1 : 0;
            ends.push(s(d.battle.result.endTick));
          }
    console.log(`- rush vs ${fort.key}: the rush wins ${rushWins} of ${ends.length} (ends ${ends.join(', ')})`);
  }

  console.log('\n## Turtle vs rush\n');
  for (const site of DUEL_SITES)
    for (const [z1, z2] of site.pairs)
      for (const seed of SEEDS) {
        const a = await duel(site.style, site.players, byKey('turtle'), RUSH, [z1, z2], seed);
        const b = await duel(site.style, site.players, RUSH, byKey('turtle'), [z1, z2], seed);
        const w = (o: number, first: string, second: string) => (o === 1 ? first : o === -1 ? second : 'draw');
        console.log(`- ${site.name} zones ${z1}/${z2} seed ${seed}: turtle@${z1} vs rush@${z2} → ${w(a.outcome, 'turtle', 'rush')} (${s(a.battle.result.endTick)}); rush@${z1} vs turtle@${z2} → ${w(b.outcome, 'rush', 'turtle')} (${s(b.battle.result.endTick)})`);
      }
  for (const players of [4, 8] as const)
    for (const round of [0, 1]) {
      const n = players / 2;
      const b = await lanesTeams(players, Array(n).fill(byKey('turtle')), Array(n).fill(RUSH), round, 11 + round);
      console.log(`- Lanes ${players} round ${round}: winner team ${b.winner === 1 ? 'rush' : b.winner === 0 ? 'turtle' : 'draw'} (${s(b.result.endTick)})`);
    }

  console.log('\n## Lanes 8, mixed 4v4\n');
  for (const round of [0, 1]) {
    const b = await lanesTeams(8, ['bricks', 'templates', 'tanks', 'turtle'].map(byKey), ['scouts', 'snipers', 'rush', 'templates'].map(byKey), round, 11 + round);
    console.log(`- round ${round}: first hit ${s(b.firstContactTick)}, winner team ${b.winner}, end ${s(b.result.endTick)} ${b.result.endReason}`);
  }

  console.log('\n## Lanes 8 with building armies (M8.5)\n');
  const cases: Array<[string[], string[]]> = [
    [['fortress', 'swarm', 'wallrush', 'mixed'], ['bricks', 'tanks', 'rush', 'snipers']],
    [['bunker', 'snipewall', 'fortress', 'swarm'], ['rush', 'rush', 'templates', 'turtle']],
  ];
  for (const [t0, t1] of cases)
    for (const round of [0, 1])
      for (const seed of SEEDS) {
        const b = await lanesTeams(8, t0.map(byKey), t1.map(byKey), round, seed + round);
        timed(b, t0.map(byKey));
        console.log(`- ${t0.join(' + ')} vs ${t1.join(' + ')}, round ${round}, seed ${seed}: first hit ${s(b.firstContactTick)}, winner team ${b.winner}, end ${s(b.result.endTick)} ${b.result.endReason}`);
      }

  for (const [title, keys] of [
    ['Ring 8 free-for-all, 8 rotations × 2 seeds', ['bricks', 'templates', 'tanks', 'turtle', 'scouts', 'snipers', 'rush', 'templates']],
    ['Ring 8 free-for-all with building armies (M8.5), 8 rotations × 2 seeds', ['fortress', 'swarm', 'snipewall', 'wallrush', 'bunker', 'mixed', 'quad', 'rush']],
  ] as const) {
    console.log(`\n## ${title}\n`);
    const lineup = keys.map(byKey);
    const zoneWins = new Array<number>(8).fill(0);
    const wins = new Map<string, number>();
    for (const seed of SEEDS)
      for (let r = 0; r < 8; r++) {
        const entrants = lineup.map((archetype, i) => ({ archetype, zone: (i + r) % 8 }));
        const b = timed(await balanceBattle('ring', 8, entrants, seed + r), lineup);
        b.places.forEach((p, i) => {
          if (p !== 1) return;
          zoneWins[entrants[i]!.zone]!++;
          wins.set(lineup[i]!.key, (wins.get(lineup[i]!.key) ?? 0) + 1);
        });
      }
    console.log(`- 1st places by zone index 0-7: ${zoneWins.join(', ')}`);
    console.log(`- 1st places by army: ${[...wins].map(([k, w]) => `${k} ${w}`).join(', ')}`);
  }

  console.log('\n## Engine time, battles with walls or factories (lean runner: the sim alone)\n');
  const ms = buildingTimes.map((t) => t.ms).sort((a, b) => a - b);
  const perTick = buildingTimes.map((t) => t.ms / Math.max(1, t.ticks)).sort((a, b) => a - b);
  console.log(`- ${ms.length} battles: median ${ms[ms.length >> 1]!.toFixed(0)} ms, max ${ms.at(-1)!.toFixed(0)} ms per battle; max ${perTick.at(-1)!.toFixed(3)} ms per tick on average over a battle`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
