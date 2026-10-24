// The cost curve (plan §6): maxing out a stat gets progressively more
// expensive, so one expensive unit is discouraged.
//
//   term_i = c_i × x_i × (1 + k × r_i²),  r_i = x_i / max_i,  k = cost.curveK (1, M8.8)
//
// Property tests over every priced stat (M8.8: plus splashRadius,
// supportPower and supportRange), on a deterministic grid plus seeded random
// sampling: monotonic, convex, exact at max / half max, concentration penalty
// (one doubled unit never beats two normal ones once a stat reaches 65% of its
// max), archetype guards (incl. the plan §6 reference table, parsed from
// plan.md) and config guards.

import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CURVE_MAX,
  DEFAULT_CONFIG,
  MIN_PRICED_SIZE,
  PRICED_STATS,
  computeCost,
  nearMaxWarnings,
  parseConfig,
  safeParseConfig,
  tooExpensiveError,
  type CostCoefficients,
  type CostStats,
  type PricedStat,
} from '@pixel-clash/shared';
import { mulberry32 } from '../packages/server/src/sim/prng.js';
import { buildContract, buildRules } from '../packages/server/src/services/rules.js';
import type { RunningServer } from '../packages/server/src/server.js';
import { adminClient, bootServer, removeDir, tempDataDir, type Client } from './helpers/server.js';

const coeffs = DEFAULT_CONFIG.cost;
const cap = DEFAULT_CONFIG.caps.unitCost;
const bounds = DEFAULT_CONFIG.stats.bounds;
const k = coeffs.curveK;
const raw = (st: CostStats, c: CostCoefficients = coeffs) => computeCost(st, c).raw;
const cost = (st: CostStats, c: CostCoefficients = coeffs) => computeCost(st, c).cost;

/** Legal range of each stat for a soldier (towers: speed fixed at 0). */
const RANGE: Record<PricedStat, { min: number; max: number; step: number }> = {
  maxHealth: { min: bounds.maxHealth.min, max: bounds.maxHealth.max, step: 5 },
  damage: { min: bounds.damage.min, max: bounds.damage.max, step: 1 },
  range: { min: bounds.range.min, max: bounds.range.max, step: 1 },
  speed: { min: bounds.soldierSpeed.min, max: bounds.soldierSpeed.max, step: 0.01 },
  size: { min: bounds.size.min, max: bounds.size.max, step: 0.05 },
};

const BASIC_SOLDIER: CostStats = { type: 'soldier', maxHealth: 600, damage: 50, range: 40, speed: 1.5, attackCooldown: 60, size: 10 };
const BASIC_TOWER: CostStats = { type: 'tower', maxHealth: 625, damage: 75, range: 140, speed: 0, attackCooldown: 45, size: 14 };

/** Seeded random legal unit. `half` keeps every stat ≤ half its max (so it can be doubled). */
function randomUnit(rng: () => number, half = false): CostStats {
  const pick = (stat: PricedStat) => {
    const { min, max } = RANGE[stat];
    const hi = half ? (stat === 'size' ? MIN_PRICED_SIZE + CURVE_MAX.size / 2 : max / 2) : max;
    return Math.round((min + rng() * (hi - min)) * 100) / 100;
  };
  const type = rng() < 0.7 ? 'soldier' : 'tower';
  return {
    type,
    maxHealth: pick('maxHealth'),
    damage: pick('damage'),
    range: pick('range'),
    speed: type === 'tower' ? 0 : pick('speed'),
    size: pick('size'),
    attackCooldown: Math.round(bounds.attackCooldown.min + rng() * (bounds.attackCooldown.max - bounds.attackCooldown.min)),
  };
}

/** The grid of values a stat takes, low to high. */
function grid(stat: PricedStat): number[] {
  const { min, max, step } = RANGE[stat];
  const out: number[] = [];
  for (let i = 0; min + i * step <= max + 1e-9; i++) out.push(Math.round((min + i * step) * 1e6) / 1e6);
  return out;
}

const withStat = (st: CostStats, stat: PricedStat, v: number): CostStats => ({ ...st, [stat]: v });

/** A few fixed "other stats" contexts plus seeded random ones. */
function contexts(n: number, seed: number): CostStats[] {
  const rng = mulberry32(seed);
  const out: CostStats[] = [BASIC_SOLDIER, { ...BASIC_SOLDIER, attackCooldown: 10 }];
  for (let i = 0; i < n; i++) out.push({ ...randomUnit(rng), type: 'soldier' });
  return out;
}

/** k = 0 plus everything up to the schema's max, with the default coefficients. */
const K_VALUES = [0, 0.5, 1, 2, 3, 5];

describe('cost curve: monotonic (every stat, others fixed)', () => {
  for (const stat of PRICED_STATS) {
    const strict = stat !== 'size';
    it(`${stat}: cost never falls${strict ? ' and raw strictly rises' : ''} as it rises (grid × seeded contexts × k 0-5)`, () => {
      const values = grid(stat);
      for (const ctx of contexts(12, 0x5eed + stat.length)) {
        for (const curveK of K_VALUES) {
          const c = { ...coeffs, curveK };
          let prevRaw = -Infinity;
          let prevCost = -Infinity;
          for (const v of values) {
            const r = raw(withStat(ctx, stat, v), c);
            const p = cost(withStat(ctx, stat, v), c);
            if (strict) expect(r, `${stat}=${v} k=${curveK}`).toBeGreaterThan(prevRaw);
            else expect(r, `${stat}=${v} k=${curveK}`).toBeGreaterThanOrEqual(prevRaw);
            expect(p, `${stat}=${v} k=${curveK}`).toBeGreaterThanOrEqual(prevCost);
            prevRaw = r;
            prevCost = p;
          }
        }
      }
    });
  }

  it('M8.8: splashRadius, supportPower and supportRange: cost never falls as they rise (raw strictly rises)', () => {
    for (const ctx of contexts(8, 0x88)) {
      let prev = -Infinity;
      for (let r = 0; r <= bounds.splashRadius.max; r += 0.5) {
        const v = raw({ ...ctx, splashRadius: r });
        expect(v, `splash ${r}`).toBeGreaterThan(prev);
        prev = v;
      }
      for (const kind of ['heal', 'haste', 'might', 'shield'] as const) {
        const b = bounds.support[kind];
        let prevP = -Infinity;
        for (let p = b.power.min; p <= b.power.max; p += 1) {
          const v = raw({ ...ctx, support: { kind, power: p, range: b.range.min } });
          expect(v, `${kind} power ${p}`).toBeGreaterThan(prevP);
          prevP = v;
        }
        let prevR = -Infinity;
        for (let rr = b.range.min; rr <= b.range.max; rr += 1) {
          const v = raw({ ...ctx, support: { kind, power: b.power.min, range: rr } });
          expect(v, `${kind} range ${rr}`).toBeGreaterThan(prevR);
          prevR = v;
        }
      }
    }
  });

  it('random pairs: raising any one stat of a random unit never lowers its cost', () => {
    const rng = mulberry32(42);
    for (let i = 0; i < 2000; i++) {
      const u = randomUnit(rng);
      const stat = PRICED_STATS[Math.floor(rng() * PRICED_STATS.length)]!;
      if (u.type === 'tower' && stat === 'speed') continue;
      const { max } = RANGE[stat];
      const from = stat === 'size' ? u.size! : u[stat];
      const to = from + rng() * (max - from);
      expect(cost(withStat(u, stat, to)), JSON.stringify({ u, stat, to })).toBeGreaterThanOrEqual(cost(u));
    }
  });
});

describe('cost curve: convex (marginal cost never shrinks)', () => {
  for (const stat of PRICED_STATS) {
    it(`${stat}: the price of one more step is non-decreasing across the whole range`, () => {
      const values = grid(stat);
      for (const ctx of contexts(6, 0xc0ffee + stat.length)) {
        let prevStep = -Infinity;
        for (let i = 1; i < values.length; i++) {
          const step = raw(withStat(ctx, stat, values[i]!)) - raw(withStat(ctx, stat, values[i - 1]!));
          expect(step, `${stat} ${values[i - 1]}→${values[i]}`).toBeGreaterThanOrEqual(prevStep - 1e-9);
          prevStep = step;
        }
      }
    });
  }

  it('the last step to the max costs far more than the first step (the slope at the max is 1 + 3k = 4× the slope at 0 with k = 1)', () => {
    for (const stat of ['maxHealth', 'damage', 'range', 'speed'] as const) {
      const values = grid(stat);
      const first = raw(withStat(BASIC_SOLDIER, stat, values[1]!)) - raw(withStat(BASIC_SOLDIER, stat, values[0]!));
      const last = raw(withStat(BASIC_SOLDIER, stat, values.at(-1)!)) - raw(withStat(BASIC_SOLDIER, stat, values.at(-2)!));
      expect(last / first, stat).toBeGreaterThan(3);
    }
  });
});

describe('cost curve: exact multipliers', () => {
  const at = (stat: PricedStat, ratio: number): CostStats =>
    withStat(BASIC_SOLDIER, stat, stat === 'size' ? MIN_PRICED_SIZE + ratio * CURVE_MAX.size : ratio * CURVE_MAX[stat]);

  for (const stat of PRICED_STATS) {
    it(`${stat}: maxed term = exactly (1 + k)× its linear term; half max = (1 + k/4)×`, () => {
      const max = computeCost(at(stat, 1), coeffs).breakdown.parts[stat];
      expect(max.ratio).toBe(1);
      expect(max.linear).toBeGreaterThan(0);
      expect(max.total).toBe((1 + k) * max.linear);
      expect(max.multiplier).toBe(2);
      const half = computeCost(at(stat, 0.5), coeffs).breakdown.parts[stat];
      expect(half.ratio).toBe(0.5);
      expect(half.total).toBe((1 + k / 4) * half.linear);
      expect(half.multiplier).toBe(1.25);
      // The surcharge is what the breakdown shows on top of the linear part.
      expect(max.curve).toBe(k * max.linear);
      expect(half.curve).toBe((k / 4) * half.linear);
    });
  }

  it('the curve maxima are the §5 default bounds', () => {
    expect(CURVE_MAX).toEqual({
      maxHealth: bounds.maxHealth.max,
      damage: bounds.damage.max,
      range: bounds.range.max,
      speed: bounds.soldierSpeed.max,
      size: bounds.size.max - MIN_PRICED_SIZE,
    });
  });

  it('the multiplier holds for any k in the schema range', () => {
    for (const curveK of K_VALUES) {
      const c = { ...coeffs, curveK };
      const part = computeCost(at('maxHealth', 1), c).breakdown.parts.maxHealth;
      expect(part.total).toBe((1 + curveK) * part.linear);
    }
  });
});

describe('cost curve: concentration penalty (one big unit is never cheaper than two halves)', () => {
  /** Every stat doubled (size: the priced part above 6 doubled). */
  const doubled = (u: CostStats): CostStats => ({
    ...u,
    maxHealth: u.maxHealth * 2,
    damage: u.damage * 2,
    range: u.range * 2,
    speed: u.speed * 2,
    size: MIN_PRICED_SIZE + 2 * ((u.size ?? 0) - MIN_PRICED_SIZE),
  });
  const ratio = (u: CostStats, stat: PricedStat) => computeCost(u, coeffs).breakdown.parts[stat].ratio;
  /**
   * At least one of HP / damage / range / speed at ≥ 65% of its max (M8.8).
   *
   * Why 65% and not the k = 2 test's 50%: k = 1 halves the curve, so doubling
   * a unit adds Σ 6k·c·x·r² of extra curve while two halves pay Base twice.
   * With the smallest c·max of the four big stats (speed, 60 × 5 = 300) the
   * doubled unit can only be cheaper below r ≈ (50 / (6 · 300))^(1/3) = 0.30,
   * a doubled ratio of 0.61; the design spec's conc.mjs measured 0 failures at
   * 65% (20,000 seeded units per variant plus the worst-case grid; worst
   * 1.054 / 1.030) and 4 random + 75 grid failures at 50%. The power factor
   * only makes doubling dearer; the cooldown, splash and element factors
   * multiply both sides equally, so the variants below hold too (plan §6 M8.8
   * concentration property).
   */
  const THRESHOLD = 0.65;
  const bigEnough = (u: CostStats) => (['maxHealth', 'damage', 'range', 'speed'] as const).some((s) => ratio(u, s) >= THRESHOLD);
  const VARIANTS: Array<[string, Partial<CostStats>]> = [
    ['normal', {}],
    ['fire', { element: 'fire' }],
    ['splash 80', { splashRadius: 80 }],
    ['ice + splash 80', { element: 'ice', splashRadius: 80 }],
  ];

  for (const [label, variant] of VARIANTS) {
    it(`seeded random units (${label}): cost(doubled) ≥ 2 × cost(original) whenever the doubled unit has a stat ≥ 65% of max`, () => {
      const rng = mulberry32(0xb16);
      let checked = 0;
      for (let i = 0; i < 5000; i++) {
        const u = { ...randomUnit(rng, true), ...variant };
        const d = doubled(u);
        if (!bigEnough(d)) continue;
        checked++;
        expect(cost(d), JSON.stringify(u)).toBeGreaterThanOrEqual(2 * cost(u));
      }
      expect(checked).toBeGreaterThan(3000);
    });

    it(`worst case grid (${label}): one stat pushed from 32.5% to 100% of max, every other stat at its minimum, any cooldown`, () => {
      const minimal: CostStats = { type: 'soldier', maxHealth: 50, damage: 0, range: 20, speed: 0.5, attackCooldown: 60, size: 6, ...variant };
      for (const cd of [10, 20, 45, 60, 600]) {
        for (const stat of ['maxHealth', 'damage', 'range', 'speed'] as const) {
          for (let r = THRESHOLD / 2; r <= 0.5 + 1e-9; r += 0.005) {
            const u = withStat({ ...minimal, attackCooldown: cd }, stat, Math.max(RANGE[stat].min, r * CURVE_MAX[stat]));
            const d = doubled(u);
            expect(bigEnough(d)).toBe(true);
            expect(cost(d), `${stat} r=${r} cd=${cd}`).toBeGreaterThanOrEqual(2 * cost(u));
          }
        }
      }
    });
  }

  it('explicit (§6 M8.8): max stats $6,660 > 2 × half stats; Huge Tank > 2 × Half Tank; Glass Cannon > 2 × half damage', () => {
    const half: CostStats = { type: 'soldier', maxHealth: 1250, damage: 150, range: 150, speed: 2.5, attackCooldown: 60, size: 13 };
    const max: CostStats = { type: 'soldier', maxHealth: 2500, damage: 300, range: 300, speed: 5, attackCooldown: 60, size: 20 };
    expect(cost(half)).toBe(1536);
    expect(cost(max)).toBe(6660);
    expect(cost(max)).toBeGreaterThan(2 * cost(half));
    const tank: CostStats = { type: 'soldier', maxHealth: 2500, damage: 100, range: 40, speed: 0.8, attackCooldown: 60, size: 20 };
    expect(cost(tank)).toBe(2462);
    expect(cost({ ...tank, maxHealth: 1250 })).toBe(1122);
    expect(cost(tank)).toBeGreaterThan(2 * cost({ ...tank, maxHealth: 1250 }));
    const glass: CostStats = { type: 'soldier', maxHealth: 300, damage: 300, range: 40, speed: 2, attackCooldown: 60, size: 8 };
    expect(cost(glass)).toBe(1359);
    expect(cost({ ...glass, damage: 150 })).toBe(672);
    expect(cost(glass)).toBeGreaterThan(2 * cost({ ...glass, damage: 150 }));
  });

  it('the power factor makes doubling strictly dearer (r_HP · r_dmg quadruples)', () => {
    const noPower = { ...coeffs, powerFactor: 0 };
    const rng = mulberry32(0x9e);
    for (let i = 0; i < 500; i++) {
      const u = randomUnit(rng, true);
      if (u.damage === 0) continue;
      const d = doubled(u);
      expect(raw(d) / raw(u), JSON.stringify(u)).toBeGreaterThan(raw(d, noPower) / raw(u, noPower));
    }
  });

  it('without the curve and the power factor (k = 0, q = 0) the same check fails: one big unit is cheaper than two', () => {
    const linear = { ...coeffs, curveK: 0, powerFactor: 0 };
    const half: CostStats = { type: 'soldier', maxHealth: 1250, damage: 150, range: 150, speed: 2.5, attackCooldown: 60, size: 13 };
    expect(cost(doubled(half), linear)).toBe(2106);
    expect(cost(half, linear)).toBe(1078);
    expect(cost(doubled(half), linear)).toBeLessThan(2 * cost(half, linear));
  });
});

describe('cost curve: archetype guards', () => {
  it('an all-max unit at CD 60 is rejected (> cap)', () => {
    const max: CostStats = { type: 'soldier', maxHealth: 2500, damage: 300, range: 300, speed: 5, attackCooldown: 60, size: 20 };
    expect(cost(max)).toBeGreaterThan(cap);
    // Even as a tower (speed 0) it doesn't fit.
    expect(cost({ ...max, type: 'tower', speed: 0 })).toBeGreaterThan(cap);
  });

  it('templates stay in their target band and 4-8 unit armies fit the budget', () => {
    const soldier = cost(BASIC_SOLDIER);
    const tower = cost(BASIC_TOWER);
    expect(soldier).toBe(529);
    expect(tower).toBe(954);
    expect(4 * soldier + 3 * tower).toBeLessThanOrEqual(DEFAULT_CONFIG.caps.budget);
    expect(8 * soldier).toBeLessThanOrEqual(DEFAULT_CONFIG.caps.budget);
  });

  it('Huge Tank (2500 HP) and Sniper Tower (range 280) cost clearly more than their linear price, but stay buildable', () => {
    const linear = { ...coeffs, curveK: 0, powerFactor: 0 };
    const tank: CostStats = { type: 'soldier', maxHealth: 2500, damage: 100, range: 40, speed: 0.8, attackCooldown: 60, size: 20 };
    const sniper: CostStats = { type: 'tower', maxHealth: 400, damage: 200, range: 280, speed: 0, attackCooldown: 60, size: 14 };
    expect(cost(tank) / cost(tank, linear)).toBeGreaterThan(2);
    expect(cost(sniper) / cost(sniper, linear)).toBeGreaterThan(1.6);
    expect(cost(tank)).toBeLessThanOrEqual(cap); // pricey, but still buildable
    expect(cost(sniper)).toBeLessThanOrEqual(cap);
  });

  it('every plan §6 reference row matches computeCost exactly', () => {
    const plan = readFileSync(new URL('../plan.md', import.meta.url), 'utf8');
    // M8.8: "Reference units (curve k = 1)" (cost.test.ts checks every column; here the plain stat rows).
    const section = plan.split('### Reference units (curve k = 1)')[1]!.split('\n### ')[0]!;
    const rows = section.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Unit') && !l.startsWith('|---'));
    expect(rows.length).toBeGreaterThanOrEqual(40);
    let plain = 0;
    for (const line of rows) {
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      const [name, type, hp, dmg, range, speed, size, cd, element, splash, support, linearSum, curve, , sum, , , , , , rawCell, costCell] = cells as string[];
      if (element || splash || support) continue;
      plain++;
      const st: CostStats = {
        type: type as 'soldier' | 'tower',
        maxHealth: Number(hp),
        damage: Number(dmg),
        range: Number(range),
        speed: Number(speed),
        size: Number(size),
        attackCooldown: Number(cd),
      };
      const r = computeCost(st, coeffs);
      const b = r.breakdown;
      const lin = b.terms.base + PRICED_STATS.reduce((a, s) => a + b.parts[s].linear, 0);
      const cur = PRICED_STATS.reduce((a, s) => a + b.parts[s].curve, 0);
      const round2 = (n: number) => Math.round(n * 100) / 100;
      expect(round2(lin), `${name} linear`).toBe(Number(linearSum));
      expect(round2(cur), `${name} curve`).toBe(Number(curve!.replace('+', '')));
      expect(round2(b.sum), `${name} sum`).toBe(Number(sum));
      expect(round2(r.raw), `${name} raw`).toBe(Number(rawCell));
      expect(r.cost, `${name} cost`).toBe(Number(/\$([\d,]+)/.exec(costCell!)![1]!.replace(/,/g, '')));
      expect(/rejected/.test(costCell!), `${name} rejected`).toBe(r.cost > cap);
    }
    expect(plain).toBeGreaterThanOrEqual(17);
  });
});

describe('cost curve: messages follow curveK', () => {
  const max: CostStats = { type: 'soldier', maxHealth: 2500, damage: 300, range: 300, speed: 5, attackCooldown: 60, size: 20 };
  const tank: CostStats = { type: 'soldier', maxHealth: 2500, damage: 100, range: 40, speed: 0.8, attackCooldown: 60, size: 20 };

  it('k = 1: W_STAT_NEAR_MAX says 2× and the too-expensive fix says "up to 2×"; k = 2 says 3×', () => {
    const w = nearMaxWarnings(tank, computeCost(tank, coeffs), coeffs);
    expect(w.map((x) => x.field)).toContain('maxHealth');
    expect(w.find((x) => x.field === 'maxHealth')!.message).toContain('costs 2× its normal price');
    const err = tooExpensiveError(max, computeCost(max, coeffs), cap, coeffs);
    expect(err.fix).toContain('Maxed stats cost up to 2× their normal price');
    const k2 = { ...coeffs, curveK: 2 };
    expect(nearMaxWarnings(tank, computeCost(tank, k2), k2).find((x) => x.field === 'maxHealth')!.message).toContain('costs 3× its normal price');
    expect(tooExpensiveError(max, computeCost(max, k2), cap, k2).fix).toContain('Maxed stats cost up to 3× their normal price');
  });

  it('k = 0 (linear): no W_STAT_NEAR_MAX and no "spread them over two units" claim', () => {
    const linear = { ...coeffs, curveK: 0 };
    expect(nearMaxWarnings(tank, computeCost(tank, linear), linear)).toEqual([]);
    const hugeCap = 100;
    const err = tooExpensiveError(max, computeCost(max, linear), hugeCap, linear);
    expect(err.code).toBe('UNIT_TOO_EXPENSIVE');
    expect(err.fix).not.toMatch(/Maxed stats|spread them|1×/);
  });

  it('get_rules costFormula and the contract tip use curveK, not fixed 3×/1.5×', () => {
    const at = (curveK: number) => parseConfig({ cost: { curveK } });
    expect(buildRules(at(2)).costFormula).toContain('3x its normal price and one at half its max 1.5x');
    expect(buildRules(at(1)).costFormula).toContain('2x its normal price and one at half its max 1.25x');
    expect(buildRules(at(0)).costFormula).not.toMatch(/two medium units are cheaper/);
    const tip = (curveK: number) => buildContract(at(curveK)).notes.find((n) => /Maxing a stat|straight line/.test(n))!;
    expect(tip(2)).toContain('Maxing a stat costs 3× its normal price (half its max costs 1.5×)');
    expect(tip(4)).toContain('Maxing a stat costs 5× its normal price (half its max costs 2×)');
    expect(tip(0)).not.toMatch(/3×|1\.5×|Maxing a stat/);
  });

  it('the contract sudden-death tip follows suddenDeath config, like get_rules', () => {
    const sdTip = (cfg: ReturnType<typeof parseConfig>) => buildContract(cfg).notes.find((n) => /^Tip: .*safe circle/.test(n))!;
    const def = parseConfig({});
    expect(sdTip(def)).toContain(`After ${def.suddenDeath.startTick / 60} s`);
    expect(sdTip(def)).toContain(`${def.suddenDeath.damagePctPerSecond}% of max health`);
    const custom = parseConfig({ suddenDeath: { startTick: 2400, damagePctPerSecond: 5 } });
    expect(sdTip(custom)).toContain('After 40 s');
    expect(sdTip(custom)).toContain('5% of max health');
    expect(buildRules(custom).suddenDeath.text).toContain('From 40 s');
  });

  it('get_rules carries the live seat limit (the projector hides its join card at it)', () => {
    expect(buildRules(parseConfig({})).maxPlayers).toBe(8);
    expect(buildRules(parseConfig({ match: { maxPlayers: 6 } })).maxPlayers).toBe(6);
  });
});

describe('cost curve: config guards', () => {
  it('the schema refuses curveK < 0 (cost would fall as a stat rises) and > 5', () => {
    expect(safeParseConfig({ cost: { curveK: -0.1 } }).success).toBe(false);
    expect(safeParseConfig({ cost: { curveK: 5.5 } }).success).toBe(false);
    expect(safeParseConfig({ cost: { curveK: Number.NaN } }).success).toBe(false);
    expect(parseConfig({ cost: { curveK: 0 } }).cost.curveK).toBe(0);
    expect(parseConfig({ cost: { curveK: 5 } }).cost.curveK).toBe(5);
  });

  it('any config the schema accepts keeps cost monotonic in every stat (seeded random retunes)', () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 200; i++) {
      const parsed = safeParseConfig({
        cost: {
          base: rng() * 50,
          hp: rng(),
          damage: rng() * 4,
          range: rng(),
          speed: rng() * 30,
          size: rng() * 3,
          curveK: rng() * 5,
        },
      });
      expect(parsed.success).toBe(true);
      if (!parsed.success) continue;
      const c = parsed.data.cost;
      const u = randomUnit(rng);
      for (const stat of PRICED_STATS) {
        if (u.type === 'tower' && stat === 'speed') continue;
        let prev = -Infinity;
        for (const v of grid(stat).filter((_, j) => j % 7 === 0)) {
          const r = raw(withStat(u, stat, v), c);
          expect(r).toBeGreaterThanOrEqual(prev);
          prev = r;
        }
      }
    }
  });

  describe('PUT /admin/config', () => {
    let srv: RunningServer;
    let dir: string;
    let admin: Client;
    beforeAll(async () => {
      dir = tempDataDir();
      srv = await bootServer({ dataDir: dir });
      admin = await adminClient(srv.url);
    }, 60_000);
    afterAll(async () => {
      await srv.close();
      removeDir(dir);
    });

    it('refuses curveK < 0 (non-monotonic cost) and > 5', async () => {
      for (const curveK of [-1, -0.01, 6]) {
        const r = await admin.put('/admin/config', { cost: { curveK } });
        expect(r.status, String(curveK)).toBe(400);
        expect(r.body.error.code).toBe('BAD_REQUEST');
        expect(JSON.stringify(r.body.error.details.issues)).toContain('curveK');
      }
      expect((await admin.get('/admin/config')).body.config.cost.curveK).toBe(1);
    });

    it('refuses a curve retune that would make a template invalid', async () => {
      // A steep curve with pricier range pushes the Basic Tower (range 140) over $2,500.
      const r = await admin.put('/admin/config', { cost: { curveK: 5, range: 5 } });
      expect(r.body.error.code).toBe('TEMPLATE_WOULD_BREAK');
      expect(r.body.error.message).toContain('Basic Tower');
      expect((await admin.get('/admin/config')).body.config.cost).toEqual(DEFAULT_CONFIG.cost);
    });

    it('accepts a valid curve retune and re-prices the templates', async () => {
      const r = await admin.put('/admin/config', { cost: { curveK: 0 } });
      expect(r.status).toBe(200);
      expect(r.body.config.cost.curveK).toBe(0);
      const back = await admin.put('/admin/config', { cost: { curveK: 1 } });
      expect(back.status).toBe(200);
    });
  });
});
