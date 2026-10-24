// Balance (plan §14 balance.test.ts, §6 "no single archetype dominates",
// §9 sudden death) for the $10,000 redesign (2026-10-24): $10,000 archetype
// armies (12 fighters at most, the copy ramp, the redesign's prices and
// mechanics) with "chase nearest", focus-fire and backline-diver bots fight
// headless battles on real §9.2 maps with the DEFAULT config. 51 archetypes: the classic six, the building,
// minion-kind, specialist, element/support and template armies refit to the
// new economy ("fill" parts and padding: helpers/balance.ts), the padded
// one-design soldiers, the combo armies (kindle, brittle, overload), five
// factories, splash answers, the exploit search's builds and three backline
// divers (assassins, cavalry, runner raid: fast units that hunt the healers,
// casters and shooters past the front line).
//
//   * the full matrix: nobody beats everyone, everyone beats someone and loses
//     to someone, ≤ 70% round-robin wins except the re-recorded bricks key and
//     one WATCH ITEM (the padded one-design soldiers, the meta the user
//     accepted), both capped at the measured numbers (helpers/balanceRules.ts);
//   * the re-recorded shape checks and stated outcomes (STATED);
//   * no element dominates per dollar (twins); combos happen; heal limits; a
//     side of damage-0 units is out at once; lightning and accuracy battles are
//     deterministic; burst pays; all-tower and all-building armies are reached
//     by sudden death before the 120 s end; dormant factories can't turtle;
//     walls never win alone; fortress vs rush, turtle vs rush, 2-team Lanes and
//     Ring 8 free-for-alls.
//
// 8 battles per pair by default (one seed); BALANCE_FULL=1 plays both seeds
// (16 per pair, what docs/balance.md records). `npm run balance` checks the
// same round-robin rules with early stopping (docs/balance.md "Fast balance runs").

import { describe, expect, it } from 'vitest';
import { checkStats, computeCost, mapFor, type MapStyle, type StatsSnapshot } from '@pixel-clash/shared';
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
  TEMPLATE_ARCHETYPES,
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
  statsOf,
  unitCost,
  type Archetype,
  type MatchupCell,
  type PairResult,
} from './helpers/balance.js';
import { FULL_DOMINANCE_EXCEPTIONS, ROUND_ROBIN_WIN_CAP, STATED, WATCH_ITEMS } from './helpers/balanceRules.js';

const T = 60_000;
/** The big round robin (thousands of battles, in worker processes). */
const MATRIX_T = 15 * T;
const BATTLE_END = BALANCE_CONFIG.timers.battleTicks;
/** The most of the free-for-all battles any one army may win (a 1st shared by k armies counts 1/k). */
const FFA_WIN_SHARE_CAP = 0.5;
/**
 * Known dominance in the free-for-alls, recorded in docs/balance.md (watch items),
 * capped at the measured number so it can only get better. No new key may be added.
 */
const DOMINANCE_EXCEPTIONS: Record<string, { ffaWinShareCap?: number }> = {
  // The classic Ring 8 free-for-all: a passive tower army mops up after the soldier armies grind
  // each other down. The M8.8 key was the turtle (12 of 16); the redesign re-keys it to the sniper
  // nest at its measured 9 of 16 (the turtle now takes 7: sudden death at 10%/s reaches it).
  snipers: { ffaWinShareCap: 9 / 16 },
};
// The 70% cap (ROUND_ROBIN_WIN_CAP), the recorded bricks key and the watch item live
// in helpers/balanceRules.ts, shared with the fast balance CLI (scripts/balance.ts).
const ALL_KEYS = ALL_ARCHETYPES.map((a) => a.key);
const byKey = archetypeByKey;
const WALL_KEYS = ALL_ARCHETYPES.filter((a) => a.army.some(([k]) => statsOf(a, k).type === 'wall')).map((a) => a.key);
const FACTORY_KEYS = ALL_ARCHETYPES.filter((a) => a.army.some(([k]) => statsOf(a, k).type === 'factory')).map((a) => a.key);
/**
 * A free-for-all's 1st places as shares: a 1st place shared by k armies (the
 * last towers caught by the circle on the same tick) counts 1/k for each.
 */
const firstShares = (places: number[]): number[] => {
  const k = places.filter((p) => p === 1).length;
  return places.map((p) => (p === 1 ? 1 / k : 0));
};
/** Heal events carry amounts rounded to 0.01 HP: a window summed from them may read a hair over the limit. */
const HEAL_TOLERANCE = 1e-4;
const battlesPerPair = DUEL_SITES.reduce((n, s) => n + s.pairs.length * 2, 0) * MATRIX_SEEDS.length;
/** A stated outcome: A wins more than half of its battles against B (≥ 9 of 16, ≥ 5 of 8). */
const winsMost = (c: MatchupCell) => c.wins * 2 > c.wins + c.draws + c.losses;

/** One full round robin (all 51 archetypes), shared by the tests below. */
let fullMatrix: Promise<{ results: PairResult[]; m: Map<string, Map<string, MatchupCell>> }> | undefined;
const full = () =>
  (fullMatrix ??= (async () => {
    const results = await playPairs(allPairs(ALL_KEYS), MATRIX_SEEDS);
    return { results, m: matrixOf(results, ALL_KEYS) };
  })());
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

/** A design as checkStats input (its support back as the three contract fields). */
function asInput(s: StatsSnapshot): Record<string, unknown> {
  const { support, ...rest } = s;
  return support ? { ...rest, support: support.kind, supportPower: support.power, supportRange: support.range } : rest;
}

describe('the archetypes are legal armies ($10,000 budget with the copy ramp, $3,000 cap)', () => {
  const armies = [...ALL_ARCHETYPES, OPEN_FORTRESS, DORMANT, RUNNER_TRICKLE, ...Object.values(NORMAL_TWINS)];
  it.each(armies.map((a) => [a.key, a] as const))('%s', (_key, a) => {
    const caps = BALANCE_CONFIG.caps;
    // armyCost prices the copy ramp (copies of one design beyond the 3rd cost more; walls never).
    expect(armyCost(a)).toBeLessThanOrEqual(caps.budget);
    expect(armyCost(a)).toBeGreaterThan(caps.budget * 0.7); // nobody is badly handicapped by leftover money
    // §5.2 copy caps: ≤ 12 fighters, of which ≤ 5 factories, plus ≤ 16 walls; at least one fighter.
    expect(armyCopies(a, 'fighters')).toBeLessThanOrEqual(caps.maxCopies);
    expect(armyCopies(a, 'fighters')).toBeGreaterThan(0);
    expect(armyCopies(a, 'factories')).toBeLessThanOrEqual(caps.maxFactoryCopies);
    expect(armyCopies(a, 'walls')).toBeLessThanOrEqual(caps.maxWallCopies);
    expect(a.army.filter(([k]) => statsOf(a, k).type === 'soldier').length).toBeLessThanOrEqual(caps.maxUnitTypes);
    expect(a.army.filter(([k]) => statsOf(a, k).type !== 'soldier').length).toBeLessThanOrEqual(caps.maxBuildingTypes);
    for (const [k] of a.army) {
      const s = statsOf(a, k);
      expect(computeCost(s, BALANCE_CONFIG.cost).cost, k).toBeLessThanOrEqual(caps.unitCost);
      const r = checkStats(asInput(s), BALANCE_CONFIG.stats.bounds);
      expect(r.ok, `${k}: ${JSON.stringify(!r.ok && r.errors)}`).toBe(true);
    }
  });

  it('51 round-robin archetypes, every key once', () => {
    expect(ALL_ARCHETYPES).toHaveLength(51);
    expect(new Set(ALL_KEYS).size).toBe(ALL_KEYS.length);
    expect(SPECIALIST_ARCHETYPES.map((a) => a.key)).toEqual(['hugetanks', 'glass', 'longbow', 'soldiersFilled']);
    expect(ELEMENT_ARCHETYPES).toHaveLength(25);
    expect(TEMPLATE_ARCHETYPES.map((a) => a.key)).toEqual(['rush', 'tmix']);
    expect(WALL_KEYS.length).toBeGreaterThanOrEqual(8);
    expect(FACTORY_KEYS.length).toBeGreaterThanOrEqual(8);
  });

  it('the units are the §6 reference units at today\'s prices', () => {
    expect(unitCost('soldier')).toBe(807);
    expect(unitCost('tower')).toBe(1200);
    expect(unitCost('tank')).toBe(1386);
    expect(unitCost('sniper')).toBe(1717);
    expect(unitCost('hugeTank')).toBe(2868);
    expect(unitCost('glass')).toBe(1641);
    expect(unitCost('maxSniper')).toBe(2181);
    expect(unitCost('fireSoldier')).toBe(1049);
    expect(unitCost('medic')).toBe(892);
    expect(unitCost('drummer')).toBe(869);
  });

  it('the bricks are the max-cost HP × damage unit; the padded soldiers fill the budget under the copy ramp', () => {
    const cap = BALANCE_CONFIG.caps.unitCost;
    expect(unitCost('brick')).toBeLessThanOrEqual(cap);
    // 80 more HP or 4 more damage would break the cap.
    expect(computeCost({ ...UNITS.brick, maxHealth: UNITS.brick.maxHealth + 80 }, BALANCE_CONFIG.cost).cost).toBeGreaterThan(cap);
    expect(computeCost({ ...UNITS.brick, damage: UNITS.brick.damage + 4 }, BALANCE_CONFIG.cost).cost).toBeGreaterThan(cap);
    const padded = byKey('soldiersFilled');
    expect(armyCost(padded)).toBeLessThanOrEqual(BALANCE_CONFIG.caps.budget);
    expect(armyCost(padded)).toBeGreaterThan(0.97 * BALANCE_CONFIG.caps.budget);
  });

  it('the buildings are the §6 reference buildings', () => {
    expect(unitCost('wall')).toBe(149);
    expect(unitCost('factory')).toBe(2194);
    expect(unitCost('swarmFactory')).toBe(2371);
  });
});

describe('round robin: no archetype dominates (§6, §14)', () => {
  it(
    'the full matrix (51 archetypes): nobody beats everyone, everyone beats and loses to someone, ≤ 70% with the bricks key and one capped watch item',
    async () => {
      const { m, results } = await full();
      if (process.env.BALANCE_REPORT) console.log(matrixMarkdown(m, ALL_ARCHETYPES));
      expect(m.size).toBe(51);
      structural(m, { ...FULL_DOMINANCE_EXCEPTIONS, ...WATCH_ITEMS }, true);
      // The one exception key left from M8.8, re-recorded at the measured number, below the M8.6 cap...
      expect(Object.keys(FULL_DOMINANCE_EXCEPTIONS)).toEqual(['bricks']);
      expect(FULL_DOMINANCE_EXCEPTIONS.bricks!.roundRobinWinCap).toBeLessThanOrEqual(220 / 256);
      // ...and one watch item, a padded one-design army "slightly over 70%" (the user's rule), never above 75%.
      expect(Object.keys(WATCH_ITEMS)).toEqual(['soldiersFilled']);
      for (const w of Object.values(WATCH_ITEMS)) expect(w.roundRobinWinCap).toBeLessThanOrEqual(0.75);
      // Walls can't win on their own: no battle was won by a side with only walls left.
      expect(results.filter((r) => r.wallOnlyWins > 0).map((r) => `${r.a} vs ${r.b}`)).toEqual([]);
      // The shape recorded in docs/balance.md: walls stop melee, range and minions break walls.
      expect(beats(m.get('bricks')!.get('tanks')!)).toBe(true);
      expect(beats(m.get('turtle')!.get('templates')!)).toBe(true);
      expect(beats(m.get('tanks')!.get('turtle')!)).toBe(false);
      const f = m.get('fortress')!;
      for (const melee of ['tanks', 'bricks', 'scouts', 'soldiersFilled', 'rush']) expect(beats(f.get(melee)!), `fortress vs ${melee}`).toBe(true);
      for (const breaker of ['turtle', 'snipers']) expect(f.get(breaker)!.losses, `fortress vs ${breaker}`).toBeGreaterThan(f.get(breaker)!.wins);
      expect(beats(m.get('swarm')!.get('bunker')!)).toBe(true);
      expect(beats(m.get('tanks')!.get('swarm')!)).toBe(true);
      expect(beats(m.get('wallrush')!.get('templates')!)).toBe(true);
      // Brutes break the sealed fortress at least 3 in 4; archers shoot over walls; defend beats attack for a bunker.
      expect(m.get('brutes')!.get('fortress')!.wins / battlesPerPair, 'brutes vs fortress').toBeGreaterThanOrEqual(0.75);
      for (const walled of ['turtle', 'fortress', 'snipewall']) expect(beats(m.get('archers')!.get(walled)!), `archers vs ${walled}`).toBe(true);
      expect(beats(m.get('homeguard')!.get('bunker')!)).toBe(true);
    },
    MATRIX_T,
  );
});

describe('the designed counters and combos (stated outcomes, re-recorded for the redesign)', () => {
  // STATED (helpers/balanceRules.ts): [A, B, why], A wins most of its battles against B (≥ 9 of 16; ≥ 5 of 8 on one seed).
  it(
    'each stated outcome holds',
    async () => {
      const { m } = await full();
      for (const [a, b, why] of STATED) expect(winsMost(m.get(a)!.get(b)!), `${a} vs ${b} (${why}): ${JSON.stringify(m.get(a)!.get(b))}`).toBe(true);
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

describe('no immortality (heal limits)', () => {
  it(
    'in every round-robin battle with heals: at most the heal room (4% of max HP) per body per second, and none in sudden death',
    async () => {
      const { results } = await full();
      const healed = results.filter((r) => r.healBattles > 0);
      expect(healed.length).toBeGreaterThan(0);
      const pct = BALANCE_CONFIG.support.healRoomPctPerSecond / 100;
      for (const r of healed) {
        expect(r.worstHealWindow, `${r.a} vs ${r.b}`).toBeLessThanOrEqual(pct + HEAL_TOLERANCE);
        // A heal in the tick before sudden death is in the frame at its start tick; nothing after.
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
            expect(worst, label).toBeLessThanOrEqual(BALANCE_CONFIG.support.healRoomPctPerSecond / 100 + HEAL_TOLERANCE);
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
      ['storm', 'rush'],
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
      // The classic, building and kind archetypes (the old 17 minus the runners themselves).
      const foes = [...ARCHETYPES, ...BUILDING_ARCHETYPES, ...KIND_ARCHETYPES].filter((a) => a.key !== 'runners');
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

describe('all-tower armies interact before the 120 s end: sudden death bites (§9)', () => {
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
            // Every army still standing is caught outside the safe circle before the end...
            b.suddenDeathBy.forEach((t, i) => {
              const wipedOut = b.lost[i] === armyCopies(entrants[i]!.archetype);
              // Shot to pieces, or the last one standing, before the circle got there: they fought.
              if (wipedOut || (b.result.endReason === 'elimination' && b.firstContactTick !== null)) return;
              expect(t, `${label}: army ${i}`).not.toBeNull();
              expect(t!, `${label}: army ${i}`).toBeLessThan(BATTLE_END);
            });
            // ...and sitting still costs towers: some die before the end in every battle.
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
            // Fighters die before the end in every battle (shot, or caught by the circle)...
            const fightersLost = b.result.units.filter((u) => u.type !== 'wall' && u.type !== 'minion' && !u.survived).length;
            expect(fightersLost, label).toBeGreaterThan(0);
            // ...a side that sits it out is reached by the circle...
            b.suddenDeathBy.forEach((t, i) => {
              if (!hasFighter(b.standing[i]!) && b.result.endReason === 'elimination' && b.firstContactTick !== null) return;
              // The winner of a battle decided before the circle reached its zone was never caught: it won by fighting.
              if (b.result.endReason === 'elimination' && b.places[i] === 1 && b.firstContactTick !== null) return;
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

describe('tower turtle vs template rush (stated expected outcome, re-recorded for the redesign)', () => {
  it(
    'duels on Corners 4 and Ring 8 (both orders, all zone pairs and seeds): an even fight, each side wins at least 1 in 4, decided by fighting',
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
      // Redesign: twice the time-to-kill gives towers twice the shots at an approaching rush (was: the rush wins 3 in 4).
      expect(rush / total).toBeGreaterThanOrEqual(0.25);
      expect(rush / total).toBeLessThanOrEqual(0.75);
    },
    T,
  );

  it('2-team Lanes (2v2 and 4v4, both block rotations): the turtle team holds (towers cover each other across the lane)', async () => {
    for (const players of [4, 8] as const) {
      const n = players / 2;
      for (const round of [0, 1]) {
        const b = await lanesTeams(players, Array(n).fill(byKey('turtle')), Array(n).fill(RUSH), round, 11 + round);
        expect(b.winner, `Lanes ${players} round ${round}`).toBe(0);
        expect(b.result.endReason).toBe('elimination');
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
          const shares = firstShares(b.places);
          b.places.forEach((p, i) => {
            if (p !== 1) return;
            zoneWins[entrants[i]!.zone]! += shares[i]!;
            archetypeWins.set(lineup[i]!.key, (archetypeWins.get(lineup[i]!.key) ?? 0) + shares[i]!);
          });
        }
      if (process.env.BALANCE_REPORT) console.log({ zoneWins, archetypeWins });
      const mean = zoneWins.reduce((a, b) => a + b, 0) / zoneWins.length;
      expect(Math.max(...zoneWins)).toBeLessThanOrEqual(2 * mean);
      expect(Math.min(...zoneWins)).toBeGreaterThan(0);
      // No army takes more than half the 1st places (shares of shared 1sts; no exception key is left).
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
          const shares = firstShares(b.places);
          b.places.forEach((p, i) => {
            if (p !== 1) return;
            expect(hasFighter(b.standing[i]!) || b.result.endReason === 'elimination', `${lineup[i]!.key} won with walls only`).toBe(true);
            wins.set(lineup[i]!.key, (wins.get(lineup[i]!.key) ?? 0) + shares[i]!);
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
          const shares = firstShares(b.places);
          b.places.forEach((p, i) => {
            if (p !== 1) return;
            expect(hasFighter(b.standing[i]!) || b.result.endReason === 'elimination', `${lineup[i]!.key} won with walls only`).toBe(true);
            wins.set(lineup[i]!.key, (wins.get(lineup[i]!.key) ?? 0) + shares[i]!);
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
    [['shatter', 'mortars', 'buffedrush', 'medictent'], ['bricks', 'soldiersFilled', 'wallrush', 'snipers']],
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
            expect(worst, label).toBeLessThanOrEqual(BALANCE_CONFIG.support.healRoomPctPerSecond / 100 + HEAL_TOLERANCE);
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
          const shares = firstShares(b.places);
          b.places.forEach((p, i) => {
            if (p !== 1) return;
            expect(hasFighter(b.standing[i]!) || b.result.endReason === 'elimination', `${lineup[i]!.key} won with walls only`).toBe(true);
            wins.set(lineup[i]!.key, (wins.get(lineup[i]!.key) ?? 0) + shares[i]!);
          });
        }
      if (process.env.BALANCE_REPORT) console.log({ wins });
      for (const [k, w] of wins) expect(w, `${k} wins ${w} of ${battles}`).toBeLessThanOrEqual(battles * FFA_WIN_SHARE_CAP);
      expect(wins.size).toBeGreaterThan(1);
    },
    T,
  );
});
