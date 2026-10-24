// Balance (plan §14 balance.test.ts, §6 "no single archetype dominates",
// §9 / §9.2 sudden death). $5,000 archetype armies with "chase nearest" bots
// fight headless battles on real §9.2 maps with the DEFAULT config:
//
//   * a round robin of the six §14 archetypes on Corners 4 and Ring 8
//     (two zone pairs per map, both orders): no archetype beats every other
//     one, every archetype beats at least one, and no archetype wins more
//     than 70% overall;
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
// rush, mixed, all four templates, all-building bunker): on the 13×13 part
// nobody beats everyone, everyone beats someone and loses to someone, nobody
// wins more than 70%, and no battle is ever won by a side with only walls
// standing; all-building armies can't win by turtling; the rush beats the open
// §14 fortress and the sealed one holds it; 2-team Lanes and a Ring 8
// free-for-all with building armies.
//
// M8.6 (minion kinds, squad orders and burst, plan §5.3): four kind archetypes
// join (archer nest guarding a tower behind walls, burst-4 runner swarm on the
// weakest enemy, brute wall-breakers, grunt home guard on defend): on the
// 17×17 part every kind archetype fits the caps; brutes break the sealed
// fortress, archers out-range walled turtles, defend beats attack for a tower
// bunker, and a burst of 4 runners loses fewer minions per kill than burst 1.
//
// M8.8 (elements, splash, support and the ×5 economy; plan §14 "M8.8
// balance"): every archetype is refit to the M8.8 prices ($5,000 budget,
// $2,500 cap), and four specialist archetypes (Huge Tanks, Glass Cannons, Max
// Snipers, the HP-padded scout swarm) and sixteen element and support
// archetypes join: 37 in all, 8 battles per pair (one seed; BALANCE_FULL=1
// plays both seeds, 16 per pair, the numbers docs/balance.md records). The
// pairs are shared out over worker processes (helpers/balanceWorker.ts).
//
//   * the 6×6, 13×13 and 17×17 parts keep their structural assertions and
//     stated outcomes, re-recorded at ×5;
//   * the full matrix: nobody beats everyone, everyone beats someone and loses
//     to someone, ≤ 70% round-robin wins with ONE capped exception (bricks).
//     The M8.7 exceptions (walls + rush, grunt home guard; open item 7) are
//     gone, and so are the old tank exceptions;
//   * the element and support stated outcomes (the designed counters);
//   * no element dominates per dollar (each element army against the same
//     army made normal, over the whole field); combos happen but the combo
//     army stays under the cap;
//   * no immortality: heals never beat 5% of max HP per second or land in
//     sudden death, and healer-ball mirrors always end with a death;
//   * a side of damage-0 units only is eliminated at once; lightning battles
//     are deterministic whatever the placement order;
//   * 2-team Lanes and a Ring 8 free-for-all with element and support armies.
//
// The matrix and the numbers are recorded in docs/balance.md; regenerate with
// `npx tsx --conditions=source scripts/balance-matrix.ts` (BALANCE_FULL=1).

import { describe, expect, it } from 'vitest';
import { computeCost, mapFor, type MapStyle } from '@pixel-clash/shared';
import {
  ALL_ARCHETYPES,
  BALANCE_CONFIG,
  ARCHETYPES,
  BUILDING_ARCHETYPES,
  DORMANT,
  ELEMENT_ARCHETYPES,
  KIND_ARCHETYPES,
  MATRIX_SEEDS,
  NORMAL_TWINS,
  RUNNER_TRICKLE,
  DUEL_SITES,
  OPEN_FORTRESS,
  RUSH,
  SEEDS,
  SPECIALIST_ARCHETYPES,
  SUPPORT_ONLY,
  UNITS,
  allPairs,
  archetypeByKey,
  armyCopies,
  armyCost,
  balanceBattle,
  beats,
  duel,
  hasFighter,
  healLimits,
  lanesTeams,
  matrixMarkdown,
  matrixOf,
  playPairs,
  rowRate,
  unitCost,
  type Archetype,
  type MatchupCell,
  type PairResult,
} from './helpers/balance.js';
import { FULL_DOMINANCE_EXCEPTIONS, KIND_DOMINANCE_EXCEPTIONS, ROUND_ROBIN_WIN_CAP, STATED } from './helpers/balanceRules.js';

const T = 60_000;
/** The big round robin (thousands of battles, in worker processes). */
const MATRIX_T = 15 * T;
const BATTLE_END = BALANCE_CONFIG.timers.battleTicks;
/** The most of the free-for-all battles any one army may win (shared 1sts count). */
const FFA_WIN_SHARE_CAP = 0.5;
/**
 * Known dominance with the default config, recorded in docs/balance.md (watch items).
 * Each one is capped at the measured number (BALANCE_FULL=1, 16 battles per pair; the
 * one-seed default run measures at or under it), so it can only get better, never
 * silently worse. M8.8: the six §14 archetypes and the 13 M8.5 ones need none (the
 * bricks and tank exceptions are gone); only the bricks keep a key, in the 17- and
 * 37-archetype matrices, below the M8.6 cap (220/256). No new key may be added.
 */
const DOMINANCE_EXCEPTIONS: Record<string, { ffaWinShareCap?: number }> = {
  // The Ring 8 free-for-all: it mops up after the soldier armies grind each other down
  // (M8.8: 12 of 16, re-recorded; was 14 of 16).
  turtle: { ffaWinShareCap: 12 / 16 },
};
// The 70% cap (ROUND_ROBIN_WIN_CAP) and the recorded bricks exceptions in the 17×17
// (188/256, 73%) and full (410/576, 71%) matrices live in helpers/balanceRules.ts,
// shared with the fast balance CLI (scripts/balance.ts).
const ALL_KEYS = ALL_ARCHETYPES.map((a) => a.key);
const SIX_KEYS = ARCHETYPES.map((a) => a.key);
const M85_KEYS = [...ARCHETYPES, ...BUILDING_ARCHETYPES].map((a) => a.key);
const KIND_KEYS = KIND_ARCHETYPES.map((a) => a.key);
const M86_KEYS = [...M85_KEYS, ...KIND_KEYS];
const byKey = archetypeByKey;
const WALL_KEYS = BUILDING_ARCHETYPES.filter((a) => a.army.some(([k]) => UNITS[k].type === 'wall')).map((a) => a.key);
const FACTORY_KEYS = BUILDING_ARCHETYPES.filter((a) => a.army.some(([k]) => UNITS[k].type === 'factory')).map((a) => a.key);
const battlesPerPair = DUEL_SITES.reduce((n, s) => n + s.pairs.length * 2, 0) * MATRIX_SEEDS.length;
/** A stated outcome: A wins more than half of its battles against B (≥ 9 of 16, ≥ 5 of 8). */
const winsMost = (c: MatchupCell) => c.wins * 2 > c.wins + c.draws + c.losses;

/** One full round robin (all 37 archetypes), shared by the tests below: the 6×6, 13×13 and 17×17 parts are views of it. */
let fullMatrix: Promise<{ results: PairResult[]; m: Map<string, Map<string, MatchupCell>> }> | undefined;
const full = () =>
  (fullMatrix ??= (async () => {
    const results = await playPairs(allPairs(ALL_KEYS), MATRIX_SEEDS);
    return { results, m: matrixOf(results, ALL_KEYS) };
  })());
const sub = (m: Map<string, Map<string, MatchupCell>>, keys: string[]) => {
  const set = new Set(keys);
  return new Map([...m].filter(([a]) => set.has(a)).map(([a, row]) => [a, new Map([...row].filter(([b]) => set.has(b)))]));
};

/** The structural checks of a (sub-)matrix: nobody beats everyone, everyone beats someone, the win cap. */
function structural(m: Map<string, Map<string, MatchupCell>>, caps: Record<string, { roundRobinWinCap: number }>, losingMatchup: boolean): void {
  for (const [a, row] of m) {
    for (const [, c] of row) expect(c.wins + c.draws + c.losses).toBe(battlesPerPair);
    const beaten = [...row].filter(([, c]) => beats(c)).map(([b]) => b);
    const losingTo = [...row].filter(([, c]) => c.losses > c.wins).map(([b]) => b);
    // Nobody wins every matchup...
    expect(beaten.length, `${a} beats ${beaten.join(', ')}`).toBeLessThan(row.size);
    // ...and nobody is useless.
    expect(beaten.length, `${a} beats nobody`).toBeGreaterThan(0);
    if (losingMatchup) expect(losingTo.length, `${a} has no losing matchup`).toBeGreaterThan(0);
    const { wins, battles, rate } = rowRate(row);
    expect(rate, `${a} wins ${wins} of ${battles}`).toBeLessThanOrEqual(caps[a]?.roundRobinWinCap ?? ROUND_ROBIN_WIN_CAP);
  }
}

describe('the archetypes are legal armies (M8.8: $5,000 budget, $2,500 cap)', () => {
  const armies = [...ALL_ARCHETYPES, RUSH, OPEN_FORTRESS, DORMANT, RUNNER_TRICKLE, ...Object.values(NORMAL_TWINS)];
  it.each(armies.map((a) => [a.key, a] as const))('%s', (_key, a) => {
    const caps = BALANCE_CONFIG.caps;
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

  it('37 round-robin archetypes, every key once', () => {
    expect(ALL_ARCHETYPES).toHaveLength(37);
    expect(new Set(ALL_KEYS).size).toBe(ALL_KEYS.length);
    expect(SPECIALIST_ARCHETYPES.map((a) => a.key)).toEqual(['hugetanks', 'glass', 'longbow', 'scoutsFilled']);
    expect(ELEMENT_ARCHETYPES).toHaveLength(16);
  });

  it('the units are the §6 M8.8 reference units at today\'s prices', () => {
    // The templates still make 4 soldiers + 3 towers.
    expect(unitCost('soldier')).toBe(529);
    expect(unitCost('tower')).toBe(954);
    expect(4 * unitCost('soldier') + 3 * unitCost('tower')).toBeLessThanOrEqual(BALANCE_CONFIG.caps.budget);
    expect(computeCost(UNITS.tank, BALANCE_CONFIG.cost).cost).toBe(1122);
    expect(computeCost(UNITS.sniper, BALANCE_CONFIG.cost).cost).toBe(1505);
    expect(unitCost('hugeTank')).toBe(2462);
    expect(unitCost('glass')).toBe(1359);
    expect(unitCost('maxSniper')).toBe(1860);
    expect(unitCost('fireSoldier')).toBe(635);
    expect(unitCost('medic')).toBe(759);
    expect(unitCost('drummer')).toBe(603);
  });

  it('the bricks are the max-cost HP × damage unit, the padded scouts fill the budget', () => {
    const brick = unitCost('brick');
    expect(brick).toBeLessThanOrEqual(BALANCE_CONFIG.caps.unitCost);
    // 50 more HP or 5 more damage would break the cap.
    expect(computeCost({ ...UNITS.brick, maxHealth: UNITS.brick.maxHealth + 50 }, BALANCE_CONFIG.cost).cost).toBeGreaterThan(BALANCE_CONFIG.caps.unitCost);
    expect(computeCost({ ...UNITS.brick, damage: UNITS.brick.damage + 5 }, BALANCE_CONFIG.cost).cost).toBeGreaterThan(BALANCE_CONFIG.caps.unitCost);
    expect(11 * unitCost('scoutFilled')).toBeLessThanOrEqual(BALANCE_CONFIG.caps.budget);
    expect(11 * computeCost({ ...UNITS.scoutFilled, maxHealth: UNITS.scoutFilled.maxHealth + 10 }, BALANCE_CONFIG.cost).cost).toBeGreaterThan(BALANCE_CONFIG.caps.budget);
  });

  it('the buildings are the §6 M8.8 reference buildings', () => {
    expect(unitCost('wall')).toBe(149);
    expect(unitCost('factory')).toBe(987);
    expect(unitCost('swarmFactory')).toBe(1431);
    expect(armyCost(byKey('fortress'))).toBe(4501);
    expect(armyCost(OPEN_FORTRESS)).toBe(4352);
    expect(armyCost(byKey('swarm'))).toBe(4978);
  });
});

describe('round robin: no archetype dominates (§6, §14)', () => {
  it(
    'the six §14 archetypes on Corners 4 and Ring 8: nobody beats everyone, everyone beats someone, nobody wins more than 70%',
    async () => {
      const { m: all } = await full();
      const m = sub(all, SIX_KEYS);
      if (process.env.BALANCE_REPORT) console.log(matrixMarkdown(m));
      // M8.8: no exception among the six. (The turtle draws the bricks and the snipers here, so the
      // "losing matchup" rule is checked on the bigger matrices, where it loses to the minion armies.)
      structural(m, {}, false);
      // The shape recorded in docs/balance.md (rock-paper-scissors at the top).
      expect(beats(m.get('bricks')!.get('tanks')!)).toBe(true); // M8.8: 2 bricks beat 4 Half Tanks (5 no longer fit)
      expect(beats(m.get('turtle')!.get('templates')!)).toBe(true);
      expect(beats(m.get('scouts')!.get('snipers')!)).toBe(true); // fast swarm vs few slow-firing towers
      expect(beats(m.get('tanks')!.get('turtle')!)).toBe(false);
      expect(beats(m.get('snipers')!.get('bricks')!)).toBe(true); // range picks off two big bodies
    },
    MATRIX_T,
  );

  it(
    'with walls and factories (M8.5, 13 archetypes): nobody dominates, walls and factories win some and lose some',
    async () => {
      const { m: all, results } = await full();
      const m = sub(all, M85_KEYS);
      if (process.env.BALANCE_REPORT) console.log(matrixMarkdown(m, M85_KEYS.map(byKey)));
      // M8.8: no exception at all in the 13 (the bricks and tanks keys are gone).
      structural(m, {}, true);
      expect(WALL_KEYS.length).toBeGreaterThanOrEqual(4);
      expect(FACTORY_KEYS.length).toBeGreaterThanOrEqual(3);
      // Walls can't win on their own: no battle was won by a side with only walls left.
      expect(results.filter((r) => r.wallOnlyWins > 0).map((r) => `${r.a} vs ${r.b}`)).toEqual([]);
      // The shape recorded in docs/balance.md: walls stop melee, range and minions break walls.
      const f = m.get('fortress')!;
      for (const melee of ['tanks', 'bricks', 'scouts']) expect(beats(f.get(melee)!), `fortress vs ${melee}`).toBe(true);
      for (const breaker of ['turtle', 'snipers', 'swarm', 'bunker']) expect(f.get(breaker)!.losses, `fortress vs ${breaker}`).toBeGreaterThan(f.get(breaker)!.wins);
      expect(beats(m.get('swarm')!.get('turtle')!)).toBe(true); // minions overrun a tower turtle
      // M8.8: two factory armies, and the swarm's 4 soldiers decide it (it was a close 8-8 with 4 of 9 at $1,000).
      expect(beats(m.get('swarm')!.get('bunker')!)).toBe(true);
      expect(beats(m.get('tanks')!.get('swarm')!)).toBe(true); // ...and big melee bodies too
      expect(beats(m.get('wallrush')!.get('templates')!)).toBe(true);
    },
    MATRIX_T,
  );

  it(
    'with minion kinds, orders and bursts (M8.6, 17 archetypes): every kind archetype fits the caps; brutes break the sealed fortress',
    async () => {
      const { m: all } = await full();
      const m = sub(all, M86_KEYS);
      if (process.env.BALANCE_REPORT) console.log(matrixMarkdown(m, M86_KEYS.map(byKey)));
      expect(m.size).toBe(17);
      structural(m, KIND_DOMINANCE_EXCEPTIONS, true);
      // Open item 7 resolved: walls + rush and the grunt home guard fit the general cap again.
      expect(Object.keys(KIND_DOMINANCE_EXCEPTIONS)).toEqual(['bricks']);
      expect(KIND_DOMINANCE_EXCEPTIONS.bricks!.roundRobinWinCap).toBeLessThanOrEqual(220 / 256); // never above the M8.6 cap
      // Stated outcomes (docs/balance.md): brutes break the sealed fortress at least 3 in 4...
      const bf = m.get('brutes')!.get('fortress')!;
      expect(bf.wins / battlesPerPair, 'brutes vs fortress').toBeGreaterThanOrEqual(0.75);
      // ...archers shoot over walls: they beat the walled turtles...
      for (const walled of ['turtle', 'fortress', 'snipewall']) expect(beats(m.get('archers')!.get(walled)!), `archers vs ${walled}`).toBe(true);
      // ...and defend beats attack for the same towers + Swarm Factories.
      expect(beats(m.get('homeguard')!.get('bunker')!)).toBe(true);
    },
    MATRIX_T,
  );

  it(
    'the full M8.8 matrix (37 archetypes): nobody beats everyone, everyone beats and loses to someone, ≤ 70% with only the bricks capped',
    async () => {
      const { m } = await full();
      if (process.env.BALANCE_REPORT) console.log(matrixMarkdown(m, ALL_ARCHETYPES));
      expect(m.size).toBe(37);
      structural(m, FULL_DOMINANCE_EXCEPTIONS, true);
      // One exception key, at the measured number, below the M8.6 cap; no new keys.
      expect(Object.keys(FULL_DOMINANCE_EXCEPTIONS)).toEqual(['bricks']);
      expect(FULL_DOMINANCE_EXCEPTIONS.bricks!.roundRobinWinCap).toBeLessThanOrEqual(220 / 256);
      // The stress army (the spec's watch item) and the soldier-spam archetypes fit the general cap.
      for (const k of ['scoutsFilled', 'wallrush', 'homeguard', 'tanks', 'storm', 'shatter']) expect(rowRate(m.get(k)!).rate, k).toBeLessThanOrEqual(ROUND_ROBIN_WIN_CAP);
    },
    MATRIX_T,
  );
});

describe('elements, splash and support: the designed counters (M8.8 stated outcomes)', () => {
  // STATED (helpers/balanceRules.ts): [A, B, why], A wins most of its battles against B (≥ 9 of 16; ≥ 5 of 8 on one seed).
  it(
    'each stated outcome holds',
    async () => {
      const { m } = await full();
      for (const [a, b, why] of STATED) expect(winsMost(m.get(a)!.get(b)!), `${a} vs ${b} (${why}): ${JSON.stringify(m.get(a)!.get(b))}`).toBe(true);
      // Lightning is the anti-swarm counter: the storm crowd beats the padded scouts or the runners.
      expect(winsMost(m.get('storm')!.get('scoutsFilled')!) || winsMost(m.get('storm')!.get('runners')!)).toBe(true);
    },
    MATRIX_T,
  );

  it(
    'the effects happen in the round robin: burns, shatters, zaps, heals and cleanses',
    async () => {
      const { results } = await full();
      const sideOf = (k: string) => results.flatMap((r) => (r.a === k ? [r.effects[0]] : r.b === k ? [r.effects[1]] : []));
      const sum = (k: string, f: 'shatters' | 'arcs' | 'burnDamage' | 'healed' | 'cleanses') => sideOf(k).reduce((n, e) => n + e[f], 0);
      expect(sum('firesquad', 'burnDamage')).toBeGreaterThan(0);
      expect(sum('shatter', 'shatters')).toBeGreaterThan(0);
      expect(sum('blizzard', 'shatters')).toBeGreaterThan(0);
      expect(sum('storm', 'arcs')).toBeGreaterThan(0);
      expect(sum('stormrunners', 'arcs')).toBeGreaterThan(0);
      for (const healer of ['healerball', 'bigFriends', 'medictent']) expect(sum(healer, 'healed'), healer).toBeGreaterThan(0);
      // Every burn on a healer-ball body costs its medic a heal.
      expect(sum('healerball', 'cleanses')).toBeGreaterThan(0);
    },
    MATRIX_T,
  );
});

describe('no element dominates per dollar; combos matter but don\'t dominate (M8.8)', () => {
  it(
    'each element army does at most 12 points better over the whole field than the same army made normal',
    async () => {
      const { m } = await full();
      // The twins (the element army made normal, the leftover money in Basic Soldiers) against the field.
      const twins = Object.entries(NORMAL_TWINS);
      const rows = await playPairs(
        twins.flatMap(([, twin]) => ALL_KEYS.map((k) => [twin.key, k] as [string, string])),
        MATRIX_SEEDS,
      );
      const report: string[] = [];
      for (const [key, twin] of twins) {
        const field = matrixOf(rows, [twin.key, ...ALL_KEYS]).get(twin.key)!;
        field.delete(key);
        const elem = new Map(m.get(key)!);
        const twinRate = rowRate(field).rate;
        const elemRate = rowRate(elem).rate;
        report.push(`${key} ${(100 * elemRate).toFixed(1)}% vs ${twin.key} ${(100 * twinRate).toFixed(1)}%`);
        expect(elemRate - twinRate, `${key} vs its normal twin`).toBeLessThanOrEqual(0.12);
      }
      if (process.env.BALANCE_REPORT) console.log(report);
    },
    MATRIX_T,
  );

  it(
    'fire is how you beat medics: the fire squad does better against the healer ball than its normal twin',
    async () => {
      const { m } = await full();
      const [twin] = await playPairs([[NORMAL_TWINS.firesquad!.key, 'healerball']], MATRIX_SEEDS);
      expect(m.get('firesquad')!.get('healerball')!.wins).toBeGreaterThan(twin!.cell.wins);
    },
    MATRIX_T,
  );

  it(
    'the combo armies (fire + ice) shatter and stay under the cap',
    async () => {
      const { m, results } = await full();
      for (const k of ['shatter', 'blizzard']) {
        const shatters = results.reduce((n, r) => n + (r.a === k ? r.effects[0].shatters : r.b === k ? r.effects[1].shatters : 0), 0);
        expect(shatters, k).toBeGreaterThan(0);
        expect(rowRate(m.get(k)!).rate, k).toBeLessThanOrEqual(ROUND_ROBIN_WIN_CAP);
      }
    },
    MATRIX_T,
  );
});

describe('no immortality (M8.8 heal limits)', () => {
  it(
    'in every round-robin battle with heals: at most 5% of max HP per body per second, and none in sudden death',
    async () => {
      const { results } = await full();
      const healed = results.filter((r) => r.healBattles > 0);
      expect(healed.length).toBeGreaterThan(0);
      const pct = BALANCE_CONFIG.support.healRoomPctPerSecond / 100;
      for (const r of healed) {
        expect(r.worstHealWindow, `${r.a} vs ${r.b}`).toBeLessThanOrEqual(pct + 1e-9);
        // A heal at tick 2999 is in the frame at t = 3000; nothing after.
        expect(r.lastHealTick, `${r.a} vs ${r.b}`).toBeLessThanOrEqual(BALANCE_CONFIG.suddenDeath.startTick);
      }
    },
    MATRIX_T,
  );

  it(
    'healer ball against healer ball always ends with a death before the timeout',
    async () => {
      const hb = byKey('healerball');
      for (const site of DUEL_SITES)
        for (const [z1, z2] of site.pairs)
          for (const seed of SEEDS) {
            const { battle } = await duel(site.style, site.players, hb, hb, [z1, z2], seed);
            const label = `${site.name} zones ${z1},${z2} seed ${seed}`;
            const firstDeath = Math.min(...battle.result.units.map((u) => u.diedAtTick ?? Infinity));
            expect(firstDeath, label).toBeLessThan(BATTLE_END);
            const { worst, last } = healLimits(battle);
            expect(worst, label).toBeLessThanOrEqual(BALANCE_CONFIG.support.healRoomPctPerSecond / 100 + 1e-9);
            expect(last, label).toBeLessThanOrEqual(BALANCE_CONFIG.suddenDeath.startTick);
          }
    },
    T,
  );
});

describe('damage-0 units and determinism (M8.8)', () => {
  it('a side of damage-0 units only (medics and banners) is eliminated at once and never wins', async () => {
    for (const foe of ['templates', 'turtle']) {
      const { outcome, battle } = await duel('corners', 4, SUPPORT_ONLY, byKey(foe), [0, 1], 11);
      expect(outcome, foe).toBe(-1);
      expect(battle.result.players.find((p) => p.playerId === 'p0')!.eliminatedAtTick, foe).toBe(0);
      expect(battle.result.endTick, foe).toBe(0);
    }
  });

  it('lightning battles are deterministic: the same seed with the placements in reverse order gives identical frames', async () => {
    for (const [a, b] of [
      ['storm', 'scoutsFilled'],
      ['storm', 'wallrush'],
    ]) {
      const run = (reverse: boolean) =>
        balanceBattle('ring', 8, [{ archetype: byKey(a!), zone: 0, reversePlacements: reverse }, { archetype: byKey(b!), zone: 1, reversePlacements: reverse }], 4242, BALANCE_CONFIG, true);
      const [x, y] = [await run(false), await run(true)];
      expect(x.effects[0]!.arcs, `${a} zaps`).toBeGreaterThan(0);
      expect(y.frameHash, `${a} vs ${b}`).toBe(x.frameHash);
      expect(y.result.ranking).toEqual(x.result.ranking);
    }
  });
});

describe('burst: saving runners up pays (M8.6 stated outcome)', () => {
  it(
    'a burst of 4 runners loses fewer minions per kill than the same runners sent one at a time',
    async () => {
      // The M8.6 field (the 17 minus the runners themselves).
      const foes = M86_KEYS.filter((k) => k !== 'runners').map(byKey);
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
      const ticks = BALANCE_CONFIG.timers.battleTicks;
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
              for (const d of [o, s]) expect(d.battle.result.endTick).toBeLessThan(BALANCE_CONFIG.suddenDeath.startTick);
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
              expect(d.battle.result.endTick).toBeLessThan(BALANCE_CONFIG.suddenDeath.startTick);
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
      expect(b.firstContactTick!).toBeLessThan(BALANCE_CONFIG.suddenDeath.startTick);
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
          expect(b.firstContactTick!, label).toBeLessThan(BALANCE_CONFIG.suddenDeath.startTick);
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

describe('2-team Lanes with element and support armies (M8.8)', () => {
  const CASES: Array<[string[], string[]]> = [
    [['firesquad', 'storm', 'healerball', 'frostnest'], ['templates', 'rush', 'tanks', 'turtle']],
    [['shatter', 'mortars', 'buffedrush', 'medictent'], ['bricks', 'scoutsFilled', 'wallrush', 'snipers']],
    [['blizzard', 'bigFriends', 'stormrunners', 'shieldwall'], ['storm', 'glass', 'firenest', 'elemfactories']],
  ];
  it(
    'contact before sudden death, every battle decided by fighters, the element teams win some and lose some',
    async () => {
      const won: boolean[] = [];
      for (const [t0, t1] of CASES)
        for (const round of [0, 1])
          for (const seed of SEEDS) {
            const b = await lanesTeams(8, t0.map(byKey), t1.map(byKey), round, seed + round);
            const label = `${t0.join('+')} round ${round} seed ${seed}`;
            expect(b.firstContactTick, label).not.toBeNull();
            expect(b.firstContactTick!, label).toBeLessThan(BALANCE_CONFIG.suddenDeath.startTick);
            expect(b.winner, label).not.toBeNull();
            // The winning team has a fighter standing (walls and damage-0 units can't win).
            expect(b.standing.some((st, i) => b.result.teams?.find((t) => t.place === 1)?.teamId === (i < 4 ? 0 : 1) && hasFighter(st)), label).toBe(true);
            const { worst, last } = healLimits(b);
            expect(worst, label).toBeLessThanOrEqual(BALANCE_CONFIG.support.healRoomPctPerSecond / 100 + 1e-9);
            expect(last, label).toBeLessThanOrEqual(BALANCE_CONFIG.suddenDeath.startTick);
            won.push(b.winner === 0);
          }
      if (process.env.BALANCE_REPORT) console.log({ won });
      expect(won).toContain(true);
      expect(won).toContain(false);
    },
    T,
  );
});

describe('Ring 8 free-for-all with element and support armies (M8.8)', () => {
  it(
    'walls and damage-0 units never win alone, several armies win, and no army takes more than half the 1st places',
    async () => {
      const lineup = ['storm', 'shatter', 'mortars', 'healerball', 'blizzard', 'firenest', 'buffedrush', 'bigFriends'].map(byKey);
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
