import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  checkStats,
  computeCost,
  tooExpensiveError,
  type CostStats,
} from '@pixel-clash/shared';

const coeffs = DEFAULT_CONFIG.cost;
const cap = DEFAULT_CONFIG.caps.unitCost;

interface Row {
  name: string;
  type: 'soldier' | 'tower';
  stats: CostStats;
  sum: number;
  factor: number;
  raw: number;
  cost: number;
  rejected?: boolean;
}

const s = (
  type: 'soldier' | 'tower',
  maxHealth: number,
  damage: number,
  range: number,
  speed: number,
  attackCooldown: number,
  size?: number,
): CostStats => ({ type, maxHealth, damage, range, speed, attackCooldown, ...(size === undefined ? {} : { size }) });

// Plan §6 "Reference units", every row (size included). Sums include the k = 2 curve.
const TABLE: Row[] = [
  { name: 'Basic Soldier (template)', type: 'soldier', stats: s('soldier', 120, 10, 40, 1.5, 60, 10), sum: 91.14030839, factor: 1, raw: 91.14030839, cost: 92 },
  { name: 'Basic Tower (template)', type: 'tower', stats: s('tower', 150, 15, 180, 0, 45, 14), sum: 148.0947449, factor: 4 / 3, raw: 197.45965986, cost: 198 },
  { name: 'Big Tank', type: 'soldier', stats: s('soldier', 500, 20, 40, 0.8, 60, 20), sum: 461.04263111, factor: 1, raw: 461.04263111, cost: 462 },
  { name: 'Sniper Tower', type: 'tower', stats: s('tower', 80, 40, 280, 0, 60, 14), sum: 304.53402268, factor: 1, raw: 304.53402268, cost: 305 },
  { name: 'Slow Sniper (the trap)', type: 'tower', stats: s('tower', 80, 40, 280, 0, 90, 14), sum: 304.53402268, factor: 1, raw: 304.53402268, cost: 305 },
  { name: 'Speedy Scout', type: 'soldier', stats: s('soldier', 60, 6, 30, 4, 20, 6), sum: 150.172, factor: 3, raw: 450.516, cost: 451 },
  { name: 'Scout with cooldown 10', type: 'soldier', stats: s('soldier', 60, 6, 30, 4, 10, 6), sum: 150.172, factor: 6, raw: 901.032, cost: 902, rejected: true },
  { name: "Old plan's Laser Sniper", type: 'soldier', stats: s('soldier', 100, 20, 150, 2, 30, 10), sum: 152.67319728, factor: 2, raw: 305.34639456, cost: 306 },
  { name: 'Max stats at CD 60', type: 'soldier', stats: s('soldier', 500, 60, 300, 5, 60, 20), sum: 1036, factor: 1, raw: 1036, cost: 1036, rejected: true },
  { name: 'Everything maxed', type: 'soldier', stats: s('soldier', 500, 60, 300, 5, 10, 20), sum: 1036, factor: 6, raw: 6216, cost: 6216, rejected: true },
  { name: 'Cheapest legal', type: 'tower', stats: s('tower', 10, 0, 20, 0, 600, 6), sum: 16.53755556, factor: 1, raw: 16.53755556, cost: 17 },
];

describe('computeCost: §6 reference table', () => {
  for (const row of TABLE) {
    it(`${row.name} → $${row.cost}${row.rejected ? ' (rejected)' : ''}`, () => {
      const r = computeCost(row.stats, coeffs);
      expect(r.breakdown.sum).toBeCloseTo(row.sum, 6);
      expect(r.breakdown.factor).toBeCloseTo(row.factor, 9);
      expect(r.raw).toBeCloseTo(row.raw, 6);
      expect(r.cost).toBe(row.cost);
      expect(r.breakdown.cost).toBe(row.cost);
      expect(r.cost > cap).toBe(Boolean(row.rejected));
    });
  }

  it('every table unit passes the stat bounds (cost aside)', () => {
    for (const row of TABLE) {
      const res = checkStats({ name: row.name.slice(0, 24), color: '#123456', ...row.stats }, DEFAULT_CONFIG.stats.bounds);
      expect(res.ok, row.name).toBe(true);
    }
  });

  it('breakdown lists each term (Basic Soldier)', () => {
    const { breakdown } = computeCost(s('soldier', 120, 10, 40, 1.5, 60, 10), coeffs);
    // Linear parts 30 / 15 / 8 / 18 / 2, each times 1 + 2·r².
    expect(breakdown.terms.base).toBe(10);
    expect(breakdown.terms.maxHealth).toBeCloseTo(30 * (1 + 2 * 0.24 ** 2), 9);
    expect(breakdown.terms.damage).toBeCloseTo(15 * (1 + 2 * (10 / 60) ** 2), 9);
    expect(breakdown.terms.range).toBeCloseTo(8 * (1 + 2 * (40 / 300) ** 2), 9);
    expect(breakdown.terms.speed).toBeCloseTo(18 * (1 + 2 * 0.3 ** 2), 9);
    expect(breakdown.terms.size).toBeCloseTo(2 * (1 + 2 * (4 / 14) ** 2), 9);
    expect(breakdown.parts.maxHealth).toMatchObject({ value: 120, ratio: 0.24, linear: 30 });
    expect(breakdown.parts.maxHealth.curve).toBeCloseTo(3.456, 9);
    expect(breakdown.parts.maxHealth.text).toBe('maxHealth 120 costs $33.46: $30 base + $3.46 for being at 24% of the max');
    expect(breakdown.curveK).toBe(2);
  });

  it('breakdown explains a maxed stat (Big Tank)', () => {
    const { breakdown } = computeCost(s('soldier', 500, 20, 40, 0.8, 60, 20), coeffs);
    expect(breakdown.parts.maxHealth).toMatchObject({ value: 500, ratio: 1, linear: 125, curve: 250, total: 375, multiplier: 3 });
    expect(breakdown.parts.maxHealth.text).toBe('maxHealth 500 costs $375: $125 base + $250 for being near the max (100% of max)');
    expect(breakdown.parts.size).toMatchObject({ value: 20, ratio: 1, linear: 7, curve: 14 });
    expect(breakdown.parts.speed.text).toBe('speed 0.8 costs $10.09: $9.6 base + $0.49 for being at 16% of the max');
  });

  it('an omitted size is priced at the type default (soldier 10, tower 14)', () => {
    expect(computeCost(s('soldier', 120, 10, 40, 1.5, 60), coeffs).cost).toBe(92);
    expect(computeCost(s('tower', 150, 15, 180, 0, 45), coeffs).cost).toBe(198);
    expect(computeCost(s('soldier', 120, 10, 40, 1.5, 60, 6), coeffs).breakdown.terms.size).toBe(0);
    expect(computeCost(s('soldier', 120, 10, 40, 1.5, 60, 20), coeffs).cost).toBe(110);
  });

  it('example armies fit the $1,000 budget', () => {
    const c = (st: CostStats) => computeCost(st, coeffs).cost;
    const soldier = c(s('soldier', 120, 10, 40, 1.5, 60, 10));
    const tower = c(s('tower', 150, 15, 180, 0, 45, 14));
    const tank = c(s('soldier', 500, 20, 40, 0.8, 60, 20));
    const sniper = c(s('tower', 80, 40, 280, 0, 60, 14));
    const scout = c(s('soldier', 60, 6, 30, 4, 20, 6));
    expect(4 * soldier + 3 * tower).toBe(962);
    expect(sniper + 3 * soldier + 2 * tower).toBe(977);
    expect(tank + 5 * soldier).toBe(922);
    expect(scout + 5 * soldier).toBe(911);
    // Two Big Tanks leave no room for even one more Basic Soldier.
    expect(2 * tank + soldier).toBeGreaterThan(1000);
  });
});

describe('cooldown factor clamp', () => {
  it('CD 90 is clamped to factor 1 (no discount)', () => {
    const at60 = computeCost(s('tower', 80, 40, 280, 0, 60, 14), coeffs);
    const at90 = computeCost(s('tower', 80, 40, 280, 0, 90, 14), coeffs);
    expect(at90.breakdown.factor).toBe(1);
    expect(at90.cost).toBe(at60.cost);
  });

  it('CD 600 is clamped to factor 1', () => {
    const r = computeCost(s('tower', 10, 0, 20, 0, 600, 6), coeffs);
    expect(r.breakdown.factor).toBe(1);
    expect(r.cost).toBe(17);
  });

  it('cooldown below 60 scales the whole sum', () => {
    const r = computeCost(s('soldier', 120, 10, 40, 1.5, 30, 10), coeffs);
    expect(r.breakdown.factor).toBe(2);
    expect(r.cost).toBe(183);
  });
});

describe('rounding', () => {
  it('91.14 rounds up to 92', () => {
    expect(computeCost(s('soldier', 120, 10, 40, 1.5, 60, 10), coeffs).cost).toBe(92);
  });

  it('197.46 (sum × 4/3) rounds up to 198', () => {
    const r = computeCost(s('tower', 150, 15, 180, 0, 45, 14), coeffs);
    expect(r.raw).toBeCloseTo((148.0947449 * 4) / 3, 6);
    expect(r.cost).toBe(198);
  });

  it('a whole-number raw is not rounded up (Max stats at CD 60: exactly 1036)', () => {
    expect(computeCost(s('soldier', 500, 60, 300, 5, 60, 20), coeffs).cost).toBe(1036);
  });

  it('float noise just above a whole number does not round up an extra credit', () => {
    // 0.1 + 0.2 style noise: base 0.1+0.2 → 0.30000000000000004; with a sum that
    // should be exactly 30, ceil must give 30 not 31.
    const noisy = { ...coeffs, base: 0.1 + 0.2, hp: 0, damage: 0, range: 0, speed: 0, size: 0, curveK: 0 };
    const r = computeCost(s('tower', 10, 0, 20, 0, 6), noisy); // factor 10 → 3.0000000000000004
    expect(r.raw).toBeGreaterThan(3);
    expect(r.cost).toBe(3);
  });
});

describe('UNIT_TOO_EXPENSIVE error', () => {
  it('Scout with cooldown 10 names the cooldown factor as the biggest lever (§7 example)', () => {
    const stats = s('soldier', 60, 6, 30, 4, 10, 6);
    const err = tooExpensiveError(stats, computeCost(stats, coeffs), cap, coeffs);
    expect(err.code).toBe('UNIT_TOO_EXPENSIVE');
    expect(err.value).toBe(902);
    expect(err.allowed).toEqual({ max: 500 });
    expect(err.breakdown?.cost).toBe(902);
    expect(err.fix).toBe(
      'Cost is $902 but the max is $500. The ×6 cooldown factor is the biggest cost: raising attackCooldown from 10 to 20 makes it ×3 ($451). ' +
        'The most expensive stat is speed: 4 costs $109.44 before the factor ($48 base + $61.44 for being 80% of the max). ' +
        'Lowering speed from 4 to 2 saves $467 ($435).',
    );
  });

  it('max stats at CD 60: names maxHealth, the saving of a concrete lower value, and the next stat', () => {
    const stats = s('soldier', 500, 60, 300, 5, 60, 20);
    const err = tooExpensiveError(stats, computeCost(stats, coeffs), cap, coeffs);
    expect(err.fix).toBe(
      'Cost is $1036 but the max is $500. The most expensive stat is maxHealth: 500 costs $375 before the factor ' +
        '($125 base + $250 for being 100% of the max). Lowering maxHealth from 500 to 300 saves $246 ($790); ' +
        "that alone isn't enough, so also lower damage. Maxed stats cost up to 3× their normal price, so spread them over two units instead.",
    );
  });

  it('a unit one stat away from fitting gets the highest round value of that stat that fits', () => {
    const stats = s('soldier', 500, 60, 40, 0.8, 60, 20);
    const priced = computeCost(stats, coeffs);
    expect(priced.cost).toBeGreaterThan(cap);
    const err = tooExpensiveError(stats, priced, cap, coeffs);
    const m = /Lowering maxHealth from 500 to (\d+) saves \$(\d+) \(\$(\d+)\)\./.exec(err.fix);
    expect(m, err.fix).not.toBeNull();
    const to = Number(m![1]);
    const lowered = computeCost({ ...stats, maxHealth: to }, coeffs).cost;
    expect(lowered).toBeLessThanOrEqual(cap);
    expect(Number(m![3])).toBe(lowered);
    expect(Number(m![2])).toBe(priced.cost - lowered);
    // 10 HP more would not fit: it is the highest round value that does.
    expect(computeCost({ ...stats, maxHealth: to + 10 }, coeffs).cost).toBeGreaterThan(cap);
  });

  it('everything maxed: no cooldown fix fits, so it names the biggest stat', () => {
    const stats = s('soldier', 500, 60, 300, 5, 10, 20);
    const err = tooExpensiveError(stats, computeCost(stats, coeffs), cap, coeffs);
    expect(err.fix).toContain('$6216');
    expect(err.fix).toContain('The most expensive stat is maxHealth: 500 costs $375 before the factor');
  });
});

describe('re-pricing after a config change', () => {
  // The service part (re-price stored units, invalidate, refuse template
  // breaks) is covered in api.test.ts and cost-curve.test.ts.
  it('a retune changes the computed price (pure part)', () => {
    const doubled = { ...coeffs, hp: coeffs.hp * 2 };
    expect(computeCost(s('soldier', 500, 20, 40, 0.8, 60, 20), doubled).cost).toBe(837);
  });

  it('curveK 0 gives the plain linear price', () => {
    const linear = { ...coeffs, curveK: 0 };
    expect(computeCost(s('soldier', 500, 20, 40, 0.8, 60, 20), linear).cost).toBe(190);
    expect(computeCost(s('soldier', 500, 60, 300, 5, 60, 20), linear).cost).toBe(352);
  });
});
