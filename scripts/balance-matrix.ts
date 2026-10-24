// Print the balance numbers recorded in docs/balance.md (plan §14): the
// archetype round robin, all-tower battles per map style, turtle vs rush and
// the Ring 8 free-for-all rotations; M8.5: the walls-and-factories archetypes
// in the same round robin, all-building armies per map style, fortress vs
// rush, 2-team Lanes and a Ring 8 free-for-all with buildings, and the
// engine time per battle; M8.6: the minion-kind archetypes in the round robin,
// burst vs one-at-a-time runners, the kinds' minion output and a Ring 8
// free-for-all with kind armies; M8.8: the 37-archetype matrix (specialist,
// element and support archetypes), the stated outcomes, the element armies
// against their normal twins, the effects and heal limits, the plain template
// armies (the 9-soldier rush, 5 soldiers + 2 towers) against the field, and Lanes and a free-for-all with element armies. Same
// harness as tests/balance.test.ts; the round robins run in worker processes.
//
//   npx tsx --conditions=source scripts/balance-matrix.ts            (16 battles per pair, both seeds)
//   BALANCE_SEEDS=11 npx tsx --conditions=source scripts/balance-matrix.ts   (8, the default test run)

import { DEFAULT_CONFIG, mapFor, type MapStyle } from '@pixel-clash/shared';
import {
  ALL_ARCHETYPES,
  ARCHETYPES,
  BUILDING_ARCHETYPES,
  DUEL_SITES,
  KIND_ARCHETYPES,
  NORMAL_TWINS,
  RUNNER_TRICKLE,
  OPEN_FORTRESS,
  RUSH,
  SEEDS,
  TEMPLATE_MIX,
  allPairs,
  archetypeByKey,
  armyCost,
  balanceBattle,
  duel,
  lanesTeams,
  matrixMarkdown,
  matrixOf,
  playPairs,
  rowRate,
  type Archetype,
  type BalanceBattle,
  type MatchupCell,
} from '../tests/helpers/balance.js';

const byKey = archetypeByKey;
/** Engine time of every battle that has a wall or a factory in it (lean runner, so this is the sim alone). */
const buildingTimes: Array<{ ms: number; ticks: number }> = [];
const timed = (b: BalanceBattle, entrants: Archetype[]) => {
  if (entrants.some((a) => ARCHETYPES.indexOf(a) < 0 && a !== RUSH)) buildingTimes.push({ ms: b.ms, ticks: b.result.endTick });
  return b;
};
const sd = DEFAULT_CONFIG.suddenDeath;
const s = (ticks: number | null) => (ticks === null ? '-' : `${(ticks / 60).toFixed(1)} s`);
const matrixSeeds = process.env.BALANCE_SEEDS ? process.env.BALANCE_SEEDS.split(',').map(Number) : SEEDS;
const pct = (wins: number, battles: number) => `${wins}/${battles} (${Math.round((100 * wins) / Math.max(1, battles))}%)`;
const cellText = (c: MatchupCell | undefined) => (c ? `${c.wins}-${c.draws}-${c.losses}` : '-');

async function main(): Promise<void> {
  const c = DEFAULT_CONFIG;
  console.log(`Sudden death: from ${sd.startTick / 60} s, radius ${sd.startRadius} → ${sd.endRadius} (800 arena), ${sd.damagePctPerSecond}% max HP/s`);
  console.log(`Economy: budget $${c.caps.budget}, cap $${c.caps.unitCost}; cost base ${c.cost.base}, hp ${c.cost.hp}, damage ${c.cost.damage}, range ${c.cost.range}, speed ${c.cost.speed}, size ${c.cost.size}, curveK ${c.cost.curveK}, power ${c.cost.powerFactor}; grunt ${c.factory.minions.grunt.maxHealth}/${c.factory.minions.grunt.damage}`);
  console.log(`Matrix seeds: ${matrixSeeds.join(', ')} (${DUEL_SITES.reduce((n, site) => n + site.pairs.length * 2, 0) * matrixSeeds.length} battles per pair)\n`);
  console.log('## Archetypes\n');
  for (const a of [...ALL_ARCHETYPES, RUSH, OPEN_FORTRESS, RUNNER_TRICKLE, ...Object.values(NORMAL_TWINS)]) console.log(`- ${a.key}: ${a.label}, $${armyCost(a).toLocaleString('en-US')}`);

  const keys = ALL_ARCHETYPES.map((a) => a.key);
  const started = performance.now();
  const results = await playPairs(allPairs(keys), matrixSeeds);
  const wall = performance.now() - started;
  const m = matrixOf(results, keys);
  console.log(`\n## Round robin, ${keys.length} archetypes (row W-D-L vs column; the first six are the §14 matrix, the first 13 M8.5's, the first 17 M8.6's)\n`);
  console.log(matrixMarkdown(m, ALL_ARCHETYPES));
  const sets: Array<[string, Set<string>]> = [
    ['the six', new Set(ARCHETYPES.map((a) => a.key))],
    ['the M8.5 13', new Set([...ARCHETYPES, ...BUILDING_ARCHETYPES].map((a) => a.key))],
    ['the M8.6 17', new Set([...ARCHETYPES, ...BUILDING_ARCHETYPES, ...KIND_ARCHETYPES].map((a) => a.key))],
  ];
  const rateIn = (a: string, set?: Set<string>) => {
    if (set && !set.has(a)) return '-';
    const row = new Map([...m.get(a)!].filter(([b]) => !set || set.has(b)));
    const r = rowRate(row);
    return pct(r.wins, r.battles);
  };
  console.log(`\n| archetype | ${sets.map(([n]) => `wins vs ${n}`).join(' | ')} | wins vs all ${keys.length - 1} | beats | loses to |\n|---|${sets.map(() => '---|').join('')}---|---|---|`);
  const order = [...keys].sort((x, y) => rowRate(m.get(y)!).rate - rowRate(m.get(x)!).rate);
  for (const a of order) {
    const row = m.get(a)!;
    const beaten = [...row].filter(([, cell]) => cell.wins > cell.losses).length;
    const losing = [...row].filter(([, cell]) => cell.losses > cell.wins).map(([b]) => b);
    console.log(`| ${a} | ${sets.map(([, set]) => rateIn(a, set)).join(' | ')} | ${rateIn(a)} | ${beaten} | ${losing.join(', ')} |`);
  }
  console.log(`\n${results.reduce((n, r) => n + r.cell.wins + r.cell.draws + r.cell.losses, 0)} battles in ${(wall / 1000).toFixed(0)} s wall clock (worker processes); engine ${(results.reduce((n, r) => n + r.ms, 0) / 1000).toFixed(0)} s.`);

  console.log('\n## Stated outcomes (M8.8)\n');
  const stated: Array<[string, string]> = [
    ['shatter', 'bricks'], ['shatter', 'bigFriends'], ['frostnest', 'bricks'], ['blizzard', 'bricks'], ['blizzard', 'buffedrush'],
    ['mortars', 'scoutsFilled'], ['storm', 'scoutsFilled'], ['storm', 'runners'], ['firenest', 'storm'], ['icewall', 'wallrush'],
    ['healerball', 'templates'], ['shatter', 'healerball'], ['firenest', 'healerball'], ['firesquad', 'healerball'], ['buffedrush', 'templates'],
    ['buffedrush', 'shatter'], ['buffedrush', 'turtle'], ['buffedrush', 'longbow'], ['shieldwall', 'glass'], ['bigFriends', 'tanks'],
    ['bigFriends', 'bombard'], ['bigFriends', 'longbow'], ['elemfactories', 'runners'], ['medictent', 'mixed'],
  ];
  console.log('| A | B | A vs B (W-D-L) |\n|---|---|---|');
  for (const [a, b] of stated) console.log(`| ${a} | ${b} | ${cellText(m.get(a)!.get(b))} |`);

  console.log('\n## Element armies against the same army made normal (M8.8)\n');
  const twins = Object.entries(NORMAL_TWINS);
  const twinRows = await playPairs(twins.flatMap(([key, twin]) => [[twin.key, key] as [string, string], ...keys.filter((k) => k !== key).map((k) => [twin.key, k] as [string, string])]), matrixSeeds);
  console.log('| element army | its round robin | normal twin | twin\'s round robin (same field) | head to head (W-D-L) |\n|---|---|---|---|---|');
  for (const [key, twin] of twins) {
    const tm = matrixOf(twinRows, [twin.key, ...keys]).get(twin.key)!;
    const h2h = tm.get(key);
    tm.delete(key);
    const er = rowRate(m.get(key)!);
    const tr = rowRate(tm);
    console.log(`| ${key} ($${armyCost(byKey(key))}) | ${pct(er.wins, er.battles)} | ${twin.label} ($${armyCost(twin)}) | ${pct(tr.wins, tr.battles)} | ${h2h ? `${h2h.losses}-${h2h.draws}-${h2h.wins}` : '-'} |`);
  }

  console.log('\n## Effects and heal limits in the round robin (M8.8)\n');
  const side = (k: string) => results.flatMap((r) => (r.a === k ? [r.effects[0]] : r.b === k ? [r.effects[1]] : []));
  console.log('| archetype | burn damage | shatters | zaps | overload zaps | HP healed | cleanses |\n|---|---|---|---|---|---|---|');
  for (const k of keys) {
    const e = side(k).reduce((t, x) => ({ shatters: t.shatters + x.shatters, arcs: t.arcs + x.arcs, overloads: t.overloads + x.overloads, burnDamage: t.burnDamage + x.burnDamage, healed: t.healed + x.healed, cleanses: t.cleanses + x.cleanses }));
    if (!e.burnDamage && !e.shatters && !e.arcs && !e.healed) continue;
    console.log(`| ${k} | ${Math.round(e.burnDamage).toLocaleString('en-US')} | ${e.shatters} | ${e.arcs} | ${e.overloads} | ${Math.round(e.healed).toLocaleString('en-US')} | ${e.cleanses} |`);
  }
  const healed = results.filter((r) => r.healBattles > 0);
  console.log(`\n- ${healed.reduce((n, r) => n + r.healBattles, 0)} battles with heals: the most any body got in one 60-tick window is ${(100 * Math.max(...healed.map((r) => r.worstHealWindow))).toFixed(2)}% of its max HP (cap ${c.support.healRoomPctPerSecond}%); the last heal lands in the frame at t = ${Math.max(...healed.map((r) => r.lastHealTick))} (sudden death from ${sd.startTick}).`);
  console.log(`- Battles won with only walls standing: ${results.reduce((n, r) => n + r.wallOnlyWins, 0)}.`);

  console.log('\n## The plain template armies against the field (watch item, not in the round robin)\n');
  // The 9-soldier rush (the most Basic Soldiers $5,000 buys) and 5 soldiers + 2 towers.
  const plain = [RUSH, TEMPLATE_MIX];
  const plainRows = await playPairs(plain.flatMap((p) => [...keys, ...plain.filter((q) => q !== p).map((q) => q.key)].map((k) => [p.key, k] as [string, string])), matrixSeeds);
  for (const p of plain) {
    const row = matrixOf(plainRows, [p.key, ...keys, ...plain.filter((q) => q !== p).map((q) => q.key)]).get(p.key)!;
    const r = rowRate(row);
    const cells = [...row].map(([b, cell]) => `${b} ${cellText(cell)}`).join(', ');
    console.log(`- ${p.key} (${p.label}, $${armyCost(p)}): ${pct(r.wins, r.battles)}; loses to ${[...row].filter(([, cell]) => cell.losses > cell.wins).map(([b]) => b).join(', ')}\n  ${cells}`);
  }

  console.log('\n## Minion kinds, orders and burst (M8.6)\n');
  const output = async (a: Archetype, foes: Archetype[]) => {
    let made = 0;
    let lost = 0;
    let kills = 0;
    let dmg = 0;
    let wins = 0;
    let n = 0;
    for (const b of foes)
      for (const site of DUEL_SITES)
        for (const [z1, z2] of site.pairs)
          for (const zones of [[z1, z2], [z2, z1]] as Array<[number, number]>)
            for (const seed of SEEDS) {
              const { outcome, battle } = await duel(site.style, site.players, a, b, zones, seed);
              n++;
              if (outcome === 1) wins++;
              for (const u of battle.result.units) {
                if (u.playerId !== 'p0') continue;
                if (u.type === 'minion') {
                  kills += u.kills;
                  dmg += u.damageDealt;
                }
                if (u.factory) {
                  made += u.factory.minionsMade;
                  lost += u.factory.minionsLost;
                }
              }
            }
    return `| ${a.key} | ${wins}/${n} | ${made} | ${lost} | ${kills} | ${Math.round(dmg)} | ${(dmg / Math.max(1, made)).toFixed(1)} | ${(lost / Math.max(1, kills)).toFixed(1)} |`;
  };
  console.log('Minion output against the M8.6 archetypes (all sites, both orders, both seeds):\n');
  console.log('| army | wins | minions made | lost | minion KOs | minion damage | damage per minion | lost per KO |\n|---|---|---|---|---|---|---|---|');
  const foes = [...ARCHETYPES, ...BUILDING_ARCHETYPES, ...KIND_ARCHETYPES].filter((a) => a.key !== 'runners');
  for (const a of [...KIND_ARCHETYPES, RUNNER_TRICKLE, byKey('swarm'), byKey('bunker')]) console.log(await output(a, foes.filter((b) => b !== a)));

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

  console.log('\n## Lanes 8 with element and support armies (M8.8)\n');
  const elementCases: Array<[string[], string[]]> = [
    [['firesquad', 'storm', 'healerball', 'frostnest'], ['templates', 'rush', 'tanks', 'turtle']],
    [['shatter', 'mortars', 'buffedrush', 'medictent'], ['bricks', 'scoutsFilled', 'wallrush', 'snipers']],
    [['blizzard', 'bigFriends', 'stormrunners', 'shieldwall'], ['storm', 'glass', 'firenest', 'elemfactories']],
  ];
  for (const [t0, t1] of elementCases)
    for (const round of [0, 1])
      for (const seed of SEEDS) {
        const b = await lanesTeams(8, t0.map(byKey), t1.map(byKey), round, seed + round);
        console.log(`- ${t0.join(' + ')} vs ${t1.join(' + ')}, round ${round}, seed ${seed}: first hit ${s(b.firstContactTick)}, winner team ${b.winner}, end ${s(b.result.endTick)} ${b.result.endReason}`);
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
    ['Ring 8 free-for-all with minion-kind armies (M8.6), 8 rotations × 2 seeds', ['archers', 'runners', 'brutes', 'homeguard', 'swarm', 'fortress', 'quad', 'rush']],
    ['Ring 8 free-for-all with element and support armies (M8.8), 8 rotations × 2 seeds', ['storm', 'shatter', 'mortars', 'healerball', 'blizzard', 'firenest', 'buffedrush', 'bigFriends']],
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
