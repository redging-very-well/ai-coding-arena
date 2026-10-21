// Print the balance numbers recorded in docs/balance.md (plan §14): the
// archetype round robin, all-tower battles per map style, turtle vs rush and
// the Ring 8 free-for-all rotations. Same harness as tests/balance.test.ts.
//
//   npx tsx --conditions=source scripts/balance-matrix.ts

import { DEFAULT_CONFIG, mapFor, type MapStyle } from '@pixel-clash/shared';
import {
  ARCHETYPES,
  DUEL_SITES,
  RUSH,
  SEEDS,
  armyCost,
  balanceBattle,
  duel,
  lanesTeams,
  matrixMarkdown,
  roundRobin,
  type Archetype,
} from '../tests/helpers/balance.js';

const byKey = (k: string): Archetype => (k === RUSH.key ? RUSH : ARCHETYPES.find((a) => a.key === k)!);
const sd = DEFAULT_CONFIG.suddenDeath;
const s = (ticks: number | null) => (ticks === null ? '-' : `${(ticks / 60).toFixed(1)} s`);

async function main(): Promise<void> {
  console.log(`Sudden death: from ${sd.startTick / 60} s, radius ${sd.startRadius} → ${sd.endRadius} (800 arena), ${sd.damagePctPerSecond}% max HP/s\n`);
  console.log('## Archetypes\n');
  for (const a of [...ARCHETYPES, RUSH]) console.log(`- ${a.key}: ${a.label}, $${armyCost(a)}`);

  console.log('\n## Round robin (row W-D-L vs column)\n');
  console.log(matrixMarkdown(await roundRobin()));

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

  console.log('\n## Ring 8 free-for-all, 8 rotations × 2 seeds\n');
  const lineup = [...ARCHETYPES, RUSH, byKey('templates')];
  const zoneWins = new Array<number>(8).fill(0);
  const wins = new Map<string, number>();
  for (const seed of SEEDS)
    for (let r = 0; r < 8; r++) {
      const entrants = lineup.map((archetype, i) => ({ archetype, zone: (i + r) % 8 }));
      const b = await balanceBattle('ring', 8, entrants, seed + r);
      b.places.forEach((p, i) => {
        if (p !== 1) return;
        zoneWins[entrants[i]!.zone]!++;
        wins.set(lineup[i]!.key, (wins.get(lineup[i]!.key) ?? 0) + 1);
      });
    }
  console.log(`- 1st places by zone index 0-7: ${zoneWins.join(', ')}`);
  console.log(`- 1st places by army: ${[...wins].map(([k, w]) => `${k} ${w}`).join(', ')}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
