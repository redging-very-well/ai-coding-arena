// Balance (plan §14 balance.test.ts, §6 "no single archetype dominates",
// §9 / §9.2 sudden death). $1,000 archetype armies with "chase nearest" bots
// fight headless battles on real §9.2 maps with the DEFAULT config:
//
//   * a round robin of the six §14 archetypes on Corners 4 and Ring 8
//     (two zone pairs per map, both orders, two seeds): no archetype beats
//     every other one, every archetype beats at least one, every archetype
//     has a losing matchup and wins at most 70% overall (with the documented,
//     capped exceptions below);
//   * all-tower armies on every map style at its largest arena: sudden death
//     reaches every army before 90 s and kills towers in every battle (it was
//     tuned for this in M6: 60 s / 4%/s let Duel, Corners and Ring 8 tower
//     battles reach 90 s without a single loss);
//   * tower turtle vs soldier rush: the RUSH wins (stated expected outcome),
//     in duels and as 2-team Lanes;
//   * Ring 8 free-for-all over 8 zone rotations: no zone index wins far more
//     often than the others, and no army takes more than half the 1st places
//     (except the documented, capped turtle).
//
// M8.5 (walls and factories, plan §5.2/§6): seven building archetypes join the
// round robin (sealed wall fortress, walled sniper nest, factory swarm, walls +
// rush, mixed, all four templates, all-building bunker):
//
//   * the six §14 archetypes keep their assertions and capped exceptions on
//     their own 6×6 part of the matrix (unchanged numbers);
//   * the full 13×13 matrix: nobody beats everyone, everyone beats someone and
//     loses to someone, nobody wins more than 70% (bricks and tanks: capped
//     exceptions at today's numbers), and no battle is ever won by a side
//     with only walls standing;
//   * all-building armies (walls + towers, towers + factories) on every map
//     style: sudden death reaches them and kills fighters, and walls never win;
//   * the rush beats the open §14 wall fortress (a U); the sealed one holds the
//     rush but loses to towers, snipers and factory swarms (stated outcomes);
//   * 2-team Lanes and a Ring 8 free-for-all with building armies.
//
// M8.6 (minion kinds, squad orders and burst, plan §5.3): four kind archetypes
// join the round robin (archer nest guarding a tower behind walls, burst-4
// runner swarm on the weakest enemy, brute wall-breakers, grunt home guard on
// defend):
//
//   * the 6×6 and 13×13 parts keep every M8.5 assertion and cap unchanged
//     (a pair's battles don't depend on who else is in the matrix);
//   * the full 17×17 matrix: every kind archetype fits the general caps with
//     no exception, beats someone and loses to someone; bricks and tanks (the
//     big bodies minions can't scratch) are capped at today's numbers; no
//     walls-only win;
//   * stated outcomes: brutes break the sealed fortress (≥ 3 in 4), archers
//     out-range walled turtles, defend beats attack for a tower bunker, and a
//     burst of 4 runners loses fewer minions per kill than burst 1.
//
// The matrix and the numbers are recorded in docs/balance.md; regenerate with
// `npx tsx --conditions=source scripts/balance-matrix.ts`.

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, computeCost, mapFor, type MapStyle } from '@pixel-clash/shared';
import {
  ALL_ARCHETYPES,
  ARCHETYPES,
  BUILDING_ARCHETYPES,
  DORMANT,
  KIND_ARCHETYPES,
  RUNNER_TRICKLE,
  DUEL_SITES,
  OPEN_FORTRESS,
  RUSH,
  SEEDS,
  UNITS,
  armyCopies,
  armyCost,
  balanceBattle,
  beats,
  duel,
  hasFighter,
  lanesTeams,
  matrixMarkdown,
  roundRobin,
  unitCost,
  type Archetype,
  type MatchupCell,
} from './helpers/balance.js';

const T = 60_000;
const BATTLE_END = DEFAULT_CONFIG.timers.battleTicks;
/** §6 "no single archetype dominates": the most of its round-robin battles any archetype may win. */
const ROUND_ROBIN_WIN_CAP = 0.7;
/** The most of the free-for-all battles any one army may win (shared 1sts count). */
const FFA_WIN_SHARE_CAP = 0.5;
/**
 * Known dominance with the default config, recorded in docs/balance.md (watch items).
 * Each one is capped at today's number, so it can only get better, never silently worse.
 * Retune (docs/balance.md: cost.hp / curveK for the tanks and bricks, cost.range for the
 * turtle) and delete the entry once the archetype fits the general caps.
 */
const DOMINANCE_EXCEPTIONS: Record<string, { roundRobinWinCap?: number; unbeaten?: true; ffaWinShareCap?: number }> = {
  // 71-0-9: loses only to the tanks (7-9).
  bricks: { roundRobinWinCap: 0.89 },
  // 63-0-17 and no losing matchup (worst: 8-8 with the turtle).
  tanks: { roundRobinWinCap: 0.79, unbeaten: true },
  // 14 of 16 Ring 8 free-for-alls: it mops up after the soldier armies grind each other down.
  turtle: { ffaWinShareCap: 14 / 16 },
};
/**
 * The same caps over the full M8.5 matrix (13 archetypes, 192 battles each). Only the
 * two old soldier archetypes need one; every building archetype fits the general caps.
 */
const FULL_DOMINANCE_EXCEPTIONS: Record<string, { roundRobinWinCap: number }> = {
  // 156-0-36 (81%, down from 89% among the six): loses to the tanks (7-9), the sealed
  // fortress (2-14) and walls + rush (5-11). Minions and walls barely scratch 430 HP.
  bricks: { roundRobinWinCap: 156 / 192 },
  // 143-0-49 (74%): loses to the sealed fortress (0-16) and the walled sniper nest (2-14).
  tanks: { roundRobinWinCap: 143 / 192 },
};
/**
 * The caps over the full M8.6 matrix (17 archetypes, 256 battles each), at today's
 * numbers. Only the two big-body soldier archetypes need one: minions (40 HP or less,
 * brutes 100) barely scratch 430- and 250-HP bodies. No building or kind archetype has one.
 */
const KIND_DOMINANCE_EXCEPTIONS: Record<string, { roundRobinWinCap: number }> = {
  // 220-0-36 (86%): beats every kind archetype 16-0; loses to the tanks, the sealed fortress and walls + rush.
  bricks: { roundRobinWinCap: 220 / 256 },
  // 207-0-49 (81%): beats every kind archetype 16-0; loses to the sealed fortress and the walled sniper nest.
  tanks: { roundRobinWinCap: 207 / 256 },
};
const M85_KEYS = new Set([...ARCHETYPES, ...BUILDING_ARCHETYPES].map((a) => a.key));
const KIND_KEYS = KIND_ARCHETYPES.map((a) => a.key);
const byKey = (k: string): Archetype =>
  k === RUSH.key ? RUSH : k === OPEN_FORTRESS.key ? OPEN_FORTRESS : ALL_ARCHETYPES.find((a) => a.key === k)!;
const WALL_KEYS = BUILDING_ARCHETYPES.filter((a) => a.army.some(([k]) => UNITS[k].type === 'wall')).map((a) => a.key);
const FACTORY_KEYS = BUILDING_ARCHETYPES.filter((a) => a.army.some(([k]) => UNITS[k].type === 'factory')).map((a) => a.key);

/** One full round robin (all 17 archetypes) shared by the tests below: the 6×6 part is the §14 matrix, the 13×13 part M8.5's. */
let fullMatrix: Promise<{ m: Map<string, Map<string, MatchupCell>>; wallOnlyWins: string[] }> | undefined;
const full = () =>
  (fullMatrix ??= (async () => {
    const wallOnlyWins: string[] = [];
    const m = await roundRobin(ALL_ARCHETYPES, undefined, (a, b, battle, outcome) => {
      // The winner always has a fighter standing (§5.2: a side of walls only is eliminated).
      if (outcome !== 0 && !hasFighter(battle.standing[outcome === 1 ? 0 : 1]!)) wallOnlyWins.push(`${a.key} vs ${b.key}`);
    });
    return { m, wallOnlyWins };
  })());

describe('the archetypes are legal $1,000 armies', () => {
  it.each([...ALL_ARCHETYPES, RUSH, OPEN_FORTRESS, DORMANT, RUNNER_TRICKLE].map((a) => [a.key, a] as const))('%s', (_key, a) => {
    const caps = DEFAULT_CONFIG.caps;
    expect(armyCost(a)).toBeLessThanOrEqual(caps.budget);
    expect(armyCost(a)).toBeGreaterThan(caps.budget * 0.85); // nobody is handicapped by leftover money
    // §5.2 copy caps: ≤ 12 fighters, of which ≤ 2 factories, plus ≤ 12 walls; at least one fighter.
    expect(armyCopies(a, 'fighters')).toBeLessThanOrEqual(caps.maxCopies);
    expect(armyCopies(a, 'fighters')).toBeGreaterThan(0);
    expect(armyCopies(a, 'factories')).toBeLessThanOrEqual(caps.maxFactoryCopies);
    expect(armyCopies(a, 'walls')).toBeLessThanOrEqual(caps.maxWallCopies);
    expect(a.army.filter(([k]) => UNITS[k].type === 'soldier').length).toBeLessThanOrEqual(caps.maxUnitTypes);
    expect(a.army.filter(([k]) => UNITS[k].type !== 'soldier').length).toBeLessThanOrEqual(caps.maxBuildingTypes);
    for (const [k] of a.army) expect(unitCost(k)).toBeLessThanOrEqual(caps.unitCost);
  });

  it('the bricks are max-cost units and the tanks the §6 Half Tank', () => {
    expect(computeCost(UNITS.brick, DEFAULT_CONFIG.cost).cost).toBeGreaterThan(480);
    expect(computeCost(UNITS.tank, DEFAULT_CONFIG.cost).cost).toBe(180);
    expect(computeCost(UNITS.sniper, DEFAULT_CONFIG.cost).cost).toBe(305);
  });

  it('the buildings are the §6 reference buildings (M8.5)', () => {
    expect(unitCost('wall')).toBe(32);
    expect(unitCost('factory')).toBe(193);
    expect(unitCost('swarmFactory')).toBe(277);
    expect(armyCost(byKey('fortress'))).toBe(946);
    expect(armyCost(OPEN_FORTRESS)).toBe(914);
    expect(armyCost(byKey('swarm'))).toBe(922);
  });
});

describe('round robin: no archetype dominates (§6, §14)', () => {
  it(
    'on Corners 4 and Ring 8, over zone pairs, both orders and seeds: nobody beats everyone, everyone beats someone',
    async () => {
      const { m: all } = await full();
      // The §14 six among themselves (each pair's battles don't depend on who else is in the matrix).
      const old = new Set(ARCHETYPES.map((a) => a.key));
      const m = new Map([...all].filter(([a]) => old.has(a)).map(([a, row]) => [a, new Map([...row].filter(([b]) => old.has(b)))]));
      if (process.env.BALANCE_REPORT) console.log(matrixMarkdown(m));
      const battlesPerPair = DUEL_SITES.reduce((n, s) => n + s.pairs.length * 2, 0) * SEEDS.length;
      for (const [a, row] of m) {
        for (const [, c] of row) expect(c.wins + c.draws + c.losses).toBe(battlesPerPair);
        const beaten = [...row].filter(([, c]) => beats(c)).map(([b]) => b);
        // Nobody wins every matchup...
        expect(beaten.length, `${a} beats ${beaten.join(', ')}`).toBeLessThan(ARCHETYPES.length - 1);
        // ...and nobody is useless.
        expect(beaten.length, `${a} beats nobody`).toBeGreaterThan(0);
        // Nobody dominates: everyone has a losing matchup and a capped overall win rate.
        const ex = DOMINANCE_EXCEPTIONS[a] ?? {};
        const losingTo = [...row].filter(([, c]) => c.losses > c.wins).map(([b]) => b);
        if (!ex.unbeaten) expect(losingTo.length, `${a} has no losing matchup`).toBeGreaterThan(0);
        const wins = [...row].reduce((n, [, c]) => n + c.wins, 0);
        const rate = wins / (battlesPerPair * row.size);
        expect(rate, `${a} wins ${wins} of ${battlesPerPair * row.size}`).toBeLessThanOrEqual(ex.roundRobinWinCap ?? ROUND_ROBIN_WIN_CAP);
      }
      // The shape recorded in docs/balance.md (rock-paper-scissors at the top).
      expect(beats(m.get('tanks')!.get('bricks')!)).toBe(true); // a spread army beats 2 bricks
      expect(beats(m.get('bricks')!.get('turtle')!)).toBe(true); // bricks walk through the turtle
      expect(beats(m.get('turtle')!.get('templates')!)).toBe(true);
      expect(beats(m.get('scouts')!.get('snipers')!)).toBe(true); // fast swarm vs few slow-firing towers
      expect(beats(m.get('tanks')!.get('turtle')!)).toBe(false);
    },
    3 * T,
  );

  it(
    'with walls and factories (M8.5, 13 archetypes): nobody dominates, walls and factories win some and lose some',
    async () => {
      const { m: all, wallOnlyWins } = await full();
      // The 13 M8.5 archetypes among themselves (the same battles as before M8.6).
      const m = new Map([...all].filter(([a]) => M85_KEYS.has(a)).map(([a, row]) => [a, new Map([...row].filter(([b]) => M85_KEYS.has(b)))]));
      if (process.env.BALANCE_REPORT) console.log(matrixMarkdown(m, ALL_ARCHETYPES.filter((a) => M85_KEYS.has(a.key))));
      const battlesPerPair = DUEL_SITES.reduce((n, s) => n + s.pairs.length * 2, 0) * SEEDS.length;
      for (const [a, row] of m) {
        const beaten = [...row].filter(([, c]) => beats(c)).map(([b]) => b);
        const losingTo = [...row].filter(([, c]) => c.losses > c.wins).map(([b]) => b);
        expect(beaten.length, `${a} beats ${beaten.join(', ')}`).toBeLessThan(row.size);
        expect(beaten.length, `${a} beats nobody`).toBeGreaterThan(0);
        // No "unbeaten" exception here: the sealed fortress beats the tanks.
        expect(losingTo.length, `${a} has no losing matchup`).toBeGreaterThan(0);
        const wins = [...row].reduce((n, [, c]) => n + c.wins, 0);
        const rate = wins / (battlesPerPair * row.size);
        expect(rate, `${a} wins ${wins} of ${battlesPerPair * row.size}`).toBeLessThanOrEqual(FULL_DOMINANCE_EXCEPTIONS[a]?.roundRobinWinCap ?? ROUND_ROBIN_WIN_CAP);
      }
      // Every wall and factory archetype fits the general caps (no exceptions for buildings).
      for (const k of BUILDING_ARCHETYPES.map((a) => a.key)) expect(FULL_DOMINANCE_EXCEPTIONS[k]).toBeUndefined();
      expect(WALL_KEYS.length).toBeGreaterThanOrEqual(4);
      expect(FACTORY_KEYS.length).toBeGreaterThanOrEqual(3);
      // Walls can't win on their own: no battle was won by a side with only walls left.
      expect(wallOnlyWins).toEqual([]);
      // The shape recorded in docs/balance.md: walls stop melee, range and minions break walls.
      const f = m.get('fortress')!;
      for (const melee of ['tanks', 'bricks', 'scouts']) expect(beats(f.get(melee)!), `fortress vs ${melee}`).toBe(true);
      for (const breaker of ['turtle', 'snipers', 'swarm', 'bunker']) expect(f.get(breaker)!.losses, `fortress vs ${breaker}`).toBeGreaterThan(f.get(breaker)!.wins);
      expect(beats(m.get('swarm')!.get('turtle')!)).toBe(true); // minions overrun a tower turtle
      const sb = m.get('swarm')!.get('bunker')!;
      expect(Math.max(sb.wins, sb.losses), 'swarm vs bunker is close').toBeLessThanOrEqual(10); // two factory armies
      expect(beats(m.get('tanks')!.get('swarm')!)).toBe(true); // ...and big melee bodies too
      expect(beats(m.get('wallrush')!.get('templates')!)).toBe(true);
    },
    3 * T,
  );

  it(
    'with minion kinds, orders and bursts (M8.6, 17 archetypes): every kind archetype fits the caps; brutes break the sealed fortress',
    async () => {
      const { m, wallOnlyWins } = await full();
      if (process.env.BALANCE_REPORT) console.log(matrixMarkdown(m, ALL_ARCHETYPES));
      const battlesPerPair = DUEL_SITES.reduce((n, s) => n + s.pairs.length * 2, 0) * SEEDS.length;
      expect(m.size).toBe(17);
      for (const [a, row] of m) {
        const beaten = [...row].filter(([, c]) => beats(c)).map(([b]) => b);
        const losingTo = [...row].filter(([, c]) => c.losses > c.wins).map(([b]) => b);
        expect(beaten.length, `${a} beats ${beaten.join(', ')}`).toBeLessThan(row.size);
        expect(beaten.length, `${a} beats nobody`).toBeGreaterThan(0);
        expect(losingTo.length, `${a} has no losing matchup`).toBeGreaterThan(0);
        const wins = [...row].reduce((n, [, c]) => n + c.wins, 0);
        const rate = wins / (battlesPerPair * row.size);
        expect(rate, `${a} wins ${wins} of ${battlesPerPair * row.size}`).toBeLessThanOrEqual(KIND_DOMINANCE_EXCEPTIONS[a]?.roundRobinWinCap ?? ROUND_ROBIN_WIN_CAP);
      }
      // No exception for any building or kind archetype.
      for (const k of [...BUILDING_ARCHETYPES.map((a) => a.key), ...KIND_KEYS]) expect(KIND_DOMINANCE_EXCEPTIONS[k]).toBeUndefined();
      expect(wallOnlyWins).toEqual([]);
      // Stated outcomes (docs/balance.md): brutes break the sealed fortress at least 3 in 4...
      const bf = m.get('brutes')!.get('fortress')!;
      expect(bf.wins / battlesPerPair, 'brutes vs fortress').toBeGreaterThanOrEqual(0.75);
      // ...archers shoot over walls: they beat the walled turtles...
      for (const walled of ['turtle', 'fortress', 'snipewall']) expect(beats(m.get('archers')!.get(walled)!), `archers vs ${walled}`).toBe(true);
      // ...and defend beats attack for the same towers + Swarm Factories.
      expect(beats(m.get('homeguard')!.get('bunker')!)).toBe(true);
    },
    3 * T,
  );
});

describe('burst: saving runners up pays (M8.6 stated outcome)', () => {
  it(
    'a burst of 4 runners loses fewer minions per kill than the same runners sent one at a time',
    async () => {
      const foes = ALL_ARCHETYPES.filter((a) => a.key !== 'runners');
      const lossPerKill = async (a: Archetype) => {
        let lost = 0;
        let kills = 0;
        for (const b of foes)
          for (const site of DUEL_SITES)
            for (const zones of site.pairs.slice(0, 1))
              for (const seed of SEEDS) {
                const { battle } = await duel(site.style, site.players, a, b, zones, seed);
                for (const u of battle.result.units) {
                  if (u.playerId !== 'p0') continue;
                  if (u.type === 'minion') kills += u.kills;
                  if (u.factory) lost += u.factory.minionsLost;
                }
              }
        return lost / Math.max(1, kills);
      };
      const burst = await lossPerKill(byKey('runners'));
      const trickle = await lossPerKill(RUNNER_TRICKLE);
      if (process.env.BALANCE_REPORT) console.log({ burst, trickle });
      expect(burst).toBeLessThan(trickle);
    },
    3 * T,
  );
});

/** Every style at its largest arena (§14): Ring 8, Lanes 8, Islands 8 at 1200, plus the 2-4 player styles at 800. */
const TOWER_SITES: Array<[MapStyle, number]> = [
  ['duel', 2],
  ['triangle', 3],
  ['corners', 4],
  ['ring', 8],
  ['lanes', 8],
  ['islands', 8],
];
const TOWER_PAIRS: Array<[string, string]> = [
  ['turtle', 'turtle'],
  ['snipers', 'turtle'],
  ['snipers', 'snipers'],
];

describe('all-tower armies interact before 90 s: sudden death bites (§9, tuned in M6)', () => {
  for (const [style, players] of TOWER_SITES) {
    it(
      `${style} ${players} (arena ${mapFor(style, players).width})`,
      async () => {
        const map = mapFor(style, players);
        for (const [ka, kb] of TOWER_PAIRS) {
          // Two armies in zones 0 and n/2, and a full map of alternating armies.
          for (const zones of [[0, Math.floor(players / 2)], map.zones.map((z) => z.index)]) {
            const entrants = zones.map((zone, i) => ({ archetype: byKey(i % 2 ? kb : ka), zone }));
            const b = await balanceBattle(style, players, entrants, 7);
            const label = `${ka}/${kb} in zones ${zones.join(',')}`;
            // Every army still standing is caught outside the safe circle before 90 s...
            b.suddenDeathBy.forEach((t, i) => {
              const wipedOut = b.lost[i] === armyCopies(entrants[i]!.archetype);
              // Shot to pieces, or the last one standing, before the circle got there: they fought.
              if (wipedOut || (b.result.endReason === 'elimination' && b.firstContactTick !== null)) return;
              expect(t, `${label}: army ${i}`).not.toBeNull();
              expect(t!, `${label}: army ${i}`).toBeLessThan(BATTLE_END);
            });
            // ...and sitting still costs towers: some die before 90 s in every battle.
            expect(Math.max(...b.lost), `${label}: lost ${b.lost.join(',')}`).toBeGreaterThan(0);
          }
        }
      },
      T,
    );
  }

  it('on Corners 4, where towers can never reach each other, sudden death alone decides it', async () => {
    const b = await balanceBattle('corners', 4, [{ archetype: byKey('snipers'), zone: 0 }, { archetype: byKey('turtle'), zone: 2 }], 7);
    expect(b.firstContactTick).toBeNull();
    // Both armies lose towers to the circle (60 s / 4%/s killed none here).
    expect(b.lost[0]).toBeGreaterThan(0);
    expect(b.lost[1]).toBeGreaterThan(0);
  });
});

/** All-building armies (M8.5): walls + towers, and towers + factories, with no soldier at all. */
const BUILDING_PAIRS: Array<[string, string]> = [
  ['fortress', 'fortress'],
  ['bunker', 'fortress'],
  ['snipewall', 'bunker'],
];

describe('factories that never build can\'t turtle (§9.3 canMake)', () => {
  it(
    'walls + holding Fortress Factories never win and are always eliminated, even with nobody reaching them',
    async () => {
      const ticks = DEFAULT_CONFIG.timers.battleTicks;
      const interval = UNITS.fortressFactory.productionInterval!;
      for (const foe of [byKey('snipewall'), byKey('fortress')]) {
        for (const site of DUEL_SITES)
          for (const [z1, z2] of site.pairs)
            for (const zones of [[z1, z2], [z2, z1]] as Array<[number, number]>)
              for (const seed of SEEDS) {
                const { outcome, battle } = await duel(site.style, site.players, DORMANT, foe, zones, seed);
                const label = `dormant vs ${foe.key} on ${site.name} zones ${zones.join(',')} seed ${seed}`;
                expect(outcome, label).toBe(-1);
                // Out by the time it could no longer build a minion, at the latest.
                const out = battle.result.players.find((p) => p.playerId === 'p0')!.eliminatedAtTick;
                expect(out, label).not.toBeNull();
                expect(out!, label).toBeLessThanOrEqual(ticks - interval);
              }
      }
    },
    T,
  );
});

describe('all-building armies can\'t win by turtling: sudden death and elimination bite (M8.5)', () => {
  for (const [style, players] of TOWER_SITES) {
    it(
      `${style} ${players}`,
      async () => {
        const map = mapFor(style, players);
        for (const [ka, kb] of BUILDING_PAIRS) {
          for (const zones of [[0, Math.floor(players / 2)], map.zones.map((z) => z.index)]) {
            const entrants = zones.map((zone, i) => ({ archetype: byKey(i % 2 ? kb : ka), zone }));
            const b = await balanceBattle(style, players, entrants, 7);
            const label = `${ka}/${kb} in zones ${zones.join(',')}`;
            // Fighters die before 90 s in every battle (shot, or caught by the circle)...
            const fightersLost = b.result.units.filter((u) => u.type !== 'wall' && u.type !== 'minion' && !u.survived).length;
            expect(fightersLost, label).toBeGreaterThan(0);
            // ...a side that sits it out is reached by the circle...
            b.suddenDeathBy.forEach((t, i) => {
              if (!hasFighter(b.standing[i]!) && b.result.endReason === 'elimination' && b.firstContactTick !== null) return;
              if (b.lost[i] === armyCopies(entrants[i]!.archetype)) return;
              expect(t, `${label}: army ${i}`).not.toBeNull();
            });
            // ...and nobody places above a side with fighters with only walls left.
            b.places.forEach((p, i) => {
              if (hasFighter(b.standing[i]!)) return;
              for (let j = 0; j < entrants.length; j++) if (hasFighter(b.standing[j]!)) expect(p, `${label}: army ${i} (walls only) vs ${j}`).toBeGreaterThan(b.places[j]!);
            });
          }
        }
      },
      T,
    );
  }
});

describe('wall fortress vs soldier rush (stated expected outcomes, M8.5)', () => {
  it(
    'the rush beats the open §14 fortress (a U of 10 walls) at least 3 in 4; the sealed fortress holds the rush',
    async () => {
      let open = 0;
      let sealed = 0;
      let total = 0;
      for (const site of DUEL_SITES)
        for (const [z1, z2] of site.pairs)
          for (const seed of SEEDS)
            for (const [za, zb] of [[z1, z2], [z2, z1]] as Array<[number, number]>) {
              const o = await duel(site.style, site.players, RUSH, OPEN_FORTRESS, [za, zb], seed);
              const s = await duel(site.style, site.players, RUSH, byKey('fortress'), [za, zb], seed);
              open += o.outcome === 1 ? 1 : 0;
              sealed += s.outcome === 1 ? 1 : 0;
              total++;
              // Both are decided by fighting, before sudden death.
              for (const d of [o, s]) expect(d.battle.result.endTick).toBeLessThan(DEFAULT_CONFIG.suddenDeath.startTick);
            }
      expect(open / total).toBeGreaterThanOrEqual(0.75);
      // Walls stop chase-nearest soldiers: the sealed box wins (its answers are range and minions, see the matrix).
      expect(sealed / total).toBeLessThanOrEqual(0.25);
    },
    T,
  );
});

describe('tower turtle vs soldier rush: the rush wins (stated expected outcome)', () => {
  it(
    'duels on Corners 4 and Ring 8 (both orders, all zone pairs and seeds): the rush wins at least 3 in 4',
    async () => {
      let rush = 0;
      let total = 0;
      for (const site of DUEL_SITES)
        for (const [z1, z2] of site.pairs)
          for (const seed of SEEDS) {
            const a = await duel(site.style, site.players, byKey('turtle'), RUSH, [z1, z2], seed);
            const b = await duel(site.style, site.players, RUSH, byKey('turtle'), [z1, z2], seed);
            rush += (a.outcome === -1 ? 1 : 0) + (b.outcome === 1 ? 1 : 0);
            total += 2;
            // It is decided by fighting, long before sudden death, in both orders.
            for (const d of [a, b]) {
              expect(d.battle.result.endReason).toBe('elimination');
              expect(d.battle.result.endTick).toBeLessThan(DEFAULT_CONFIG.suddenDeath.startTick);
            }
          }
      expect(rush / total).toBeGreaterThanOrEqual(0.75);
    },
    T,
  );

  it('2-team Lanes (2v2 and 4v4, both block rotations): the rush team wins', async () => {
    for (const players of [4, 8] as const) {
      const n = players / 2;
      for (const round of [0, 1]) {
        const b = await lanesTeams(players, Array(n).fill(byKey('turtle')), Array(n).fill(RUSH), round, 11 + round);
        expect(b.winner, `Lanes ${players} round ${round}`).toBe(1);
      }
    }
  });
});

describe('2-team Lanes with mixed armies', () => {
  it('the teams make contact before sudden death and the battle is decided', async () => {
    const team0 = ['bricks', 'templates', 'tanks', 'turtle'].map(byKey);
    const team1 = ['scouts', 'snipers', 'rush', 'templates'].map(byKey);
    for (const round of [0, 1]) {
      const b = await lanesTeams(8, team0, team1, round, 11 + round);
      expect(b.firstContactTick).not.toBeNull();
      expect(b.firstContactTick!).toBeLessThan(DEFAULT_CONFIG.suddenDeath.startTick);
      expect(b.winner).not.toBeNull();
    }
  });
});

describe('2-team Lanes with building armies (M8.5)', () => {
  const CASES: Array<[string[], string[]]> = [
    [['fortress', 'swarm', 'wallrush', 'mixed'], ['bricks', 'tanks', 'rush', 'snipers']],
    [['bunker', 'snipewall', 'fortress', 'swarm'], ['rush', 'rush', 'templates', 'turtle']],
  ];
  it('contact before sudden death, every battle decided, the building team wins some and loses some', async () => {
    const won: boolean[] = [];
    for (const [t0, t1] of CASES)
      for (const round of [0, 1])
        for (const seed of SEEDS) {
          const b = await lanesTeams(8, t0.map(byKey), t1.map(byKey), round, seed + round);
          const label = `${t0.join('+')} round ${round} seed ${seed}`;
          expect(b.firstContactTick, label).not.toBeNull();
          expect(b.firstContactTick!, label).toBeLessThan(DEFAULT_CONFIG.suddenDeath.startTick);
          expect(b.winner, label).not.toBeNull();
          // The winning team has a fighter standing.
          expect(b.standing.some((st, i) => b.result.teams?.find((t) => t.place === 1)?.teamId === (i < 4 ? 0 : 1) && hasFighter(st)), label).toBe(true);
          won.push(b.winner === 0);
        }
    expect(won).toContain(true);
    expect(won).toContain(false);
  });
});

describe('Ring 8 free-for-all over zone rotations (§14)', () => {
  it(
    'every army plays from every zone; no zone index wins far more often than the others',
    async () => {
      const lineup = [...ARCHETYPES, RUSH, byKey('templates')];
      const zoneWins = new Array<number>(8).fill(0);
      const archetypeWins = new Map<string, number>();
      let battles = 0;
      for (const seed of SEEDS)
        for (let r = 0; r < 8; r++) {
          const entrants = lineup.map((archetype, i) => ({ archetype, zone: (i + r) % 8 }));
          const b = await balanceBattle('ring', 8, entrants, seed + r);
          battles++;
          b.places.forEach((p, i) => {
            if (p !== 1) return;
            zoneWins[entrants[i]!.zone]!++;
            archetypeWins.set(lineup[i]!.key, (archetypeWins.get(lineup[i]!.key) ?? 0) + 1);
          });
        }
      if (process.env.BALANCE_REPORT) console.log({ zoneWins, archetypeWins });
      const mean = zoneWins.reduce((a, b) => a + b, 0) / zoneWins.length;
      expect(Math.max(...zoneWins)).toBeLessThanOrEqual(2 * mean);
      expect(Math.min(...zoneWins)).toBeGreaterThan(0);
      // No army takes more than half the 1st places (the turtle is a capped exception: docs/balance.md).
      for (const [k, w] of archetypeWins) {
        expect(w, `${k} wins ${w} of ${battles}`).toBeLessThanOrEqual(battles * (DOMINANCE_EXCEPTIONS[k]?.ffaWinShareCap ?? FFA_WIN_SHARE_CAP));
        expect(w, k).toBeLessThan(battles);
      }
    },
    T,
  );
});

describe('Ring 8 free-for-all with building armies (M8.5)', () => {
  it(
    'walls never win alone, nobody wins every battle, and no army takes more than half the 1st places',
    async () => {
      const lineup = ['fortress', 'swarm', 'snipewall', 'wallrush', 'bunker', 'mixed', 'quad', 'rush'].map(byKey);
      const wins = new Map<string, number>();
      let battles = 0;
      for (const seed of SEEDS)
        for (let r = 0; r < 8; r++) {
          const entrants = lineup.map((archetype, i) => ({ archetype, zone: (i + r) % 8 }));
          const b = await balanceBattle('ring', 8, entrants, seed + r);
          battles++;
          b.places.forEach((p, i) => {
            if (p !== 1) return;
            expect(hasFighter(b.standing[i]!) || b.result.endReason === 'elimination', `${lineup[i]!.key} won with walls only`).toBe(true);
            wins.set(lineup[i]!.key, (wins.get(lineup[i]!.key) ?? 0) + 1);
          });
        }
      if (process.env.BALANCE_REPORT) console.log({ wins });
      for (const [k, w] of wins) expect(w, `${k} wins ${w} of ${battles}`).toBeLessThanOrEqual(battles * FFA_WIN_SHARE_CAP);
      expect(wins.size).toBeGreaterThan(1);
    },
    T,
  );
});

describe('Ring 8 free-for-all with minion-kind armies (M8.6)', () => {
  it(
    'walls never win alone, several armies win, and no army takes more than half the 1st places',
    async () => {
      const lineup = ['archers', 'runners', 'brutes', 'homeguard', 'swarm', 'fortress', 'quad', 'rush'].map(byKey);
      const wins = new Map<string, number>();
      let battles = 0;
      for (const seed of SEEDS)
        for (let r = 0; r < 8; r++) {
          const entrants = lineup.map((archetype, i) => ({ archetype, zone: (i + r) % 8 }));
          const b = await balanceBattle('ring', 8, entrants, seed + r);
          battles++;
          b.places.forEach((p, i) => {
            if (p !== 1) return;
            expect(hasFighter(b.standing[i]!) || b.result.endReason === 'elimination', `${lineup[i]!.key} won with walls only`).toBe(true);
            wins.set(lineup[i]!.key, (wins.get(lineup[i]!.key) ?? 0) + 1);
          });
        }
      if (process.env.BALANCE_REPORT) console.log({ wins });
      for (const [k, w] of wins) expect(w, `${k} wins ${w} of ${battles}`).toBeLessThanOrEqual(battles * FFA_WIN_SHARE_CAP);
      expect(wins.size).toBeGreaterThan(1);
    },
    T,
  );
});
