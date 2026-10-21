// The cost curve (plan §6): maxing out a stat gets progressively more
// expensive, so one expensive unit is discouraged.
//
//   term_i = c_i × x_i × (1 + k × r_i²),  r_i = x_i / max_i,  k = cost.curveK (2)
//
// Property tests over every priced stat, on a deterministic grid plus seeded
// random sampling: monotonic, convex, exact at max / half max, concentration
// penalty (one doubled unit never beats two normal ones), archetype guards
// (incl. the plan §6 reference table, parsed from plan.md) and config guards.

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
  maxHealth: { min: bounds.maxHealth.min, max: bounds.maxHealth.max, step: 1 },
  damage: { min: bounds.damage.min, max: bounds.damage.max, step: 0.25 },
  range: { min: bounds.range.min, max: bounds.range.max, step: 1 },
  speed: { min: bounds.soldierSpeed.min, max: bounds.soldierSpeed.max, step: 0.01 },
  size: { min: bounds.size.min, max: bounds.size.max, step: 0.05 },
};

const BASIC_SOLDIER: CostStats = { type: 'soldier', maxHealth: 120, damage: 10, range: 40, speed: 1.5, attackCooldown: 60, size: 10 };
const BASIC_TOWER: CostStats = { type: 'tower', maxHealth: 150, damage: 15, range: 180, speed: 0, attackCooldown: 45, size: 14 };

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

  it('the last step to the max costs far more than the first step (the slope at the max is 1 + 3k = 7× the slope at 0 with k = 2)', () => {
    for (const stat of ['maxHealth', 'damage', 'range', 'speed'] as const) {
      const values = grid(stat);
      const first = raw(withStat(BASIC_SOLDIER, stat, values[1]!)) - raw(withStat(BASIC_SOLDIER, stat, values[0]!));
      const last = raw(withStat(BASIC_SOLDIER, stat, values.at(-1)!)) - raw(withStat(BASIC_SOLDIER, stat, values.at(-2)!));
      expect(last / first, stat).toBeGreaterThan(5);
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
      expect(max.multiplier).toBe(3);
      const half = computeCost(at(stat, 0.5), coeffs).breakdown.parts[stat];
      expect(half.ratio).toBe(0.5);
      expect(half.total).toBe((1 + k / 4) * half.linear);
      expect(half.multiplier).toBe(1.5);
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
  /** At least one of HP / damage / range / speed at ≥ 50% of its max. */
  const bigEnough = (u: CostStats) => (['maxHealth', 'damage', 'range', 'speed'] as const).some((s) => ratio(u, s) >= 0.5);

  it('seeded random units: cost(doubled) ≥ 2 × cost(original) whenever the doubled unit has a stat ≥ 50% of max', () => {
    const rng = mulberry32(0xb16);
    let checked = 0;
    for (let i = 0; i < 5000; i++) {
      const u = randomUnit(rng, true);
      const d = doubled(u);
      if (!bigEnough(d)) continue;
      checked++;
      expect(cost(d), JSON.stringify(u)).toBeGreaterThanOrEqual(2 * cost(u));
    }
    expect(checked).toBeGreaterThan(3000);
  });

  it('worst case grid: one stat pushed from 25% to 100% of max, every other stat at its minimum, any cooldown', () => {
    const minimal: CostStats = { type: 'soldier', maxHealth: 10, damage: 0, range: 20, speed: 0.5, attackCooldown: 60, size: 6 };
    for (const cd of [10, 20, 45, 60, 600]) {
      for (const stat of ['maxHealth', 'damage', 'range', 'speed'] as const) {
        for (let r = 0.25; r <= 0.5 + 1e-9; r += 0.005) {
          const u = withStat({ ...minimal, attackCooldown: cd }, stat, Math.max(RANGE[stat].min, r * CURVE_MAX[stat]));
          const d = doubled(u);
          expect(bigEnough(d)).toBe(true);
          expect(cost(d), `${stat} r=${r} cd=${cd}`).toBeGreaterThanOrEqual(2 * cost(u));
        }
      }
    }
  });

  it('explicit: 1 maxed unit costs more than 2 units at half stats', () => {
    const half: CostStats = { type: 'soldier', maxHealth: 250, damage: 30, range: 150, speed: 2.5, attackCooldown: 60, size: 13 };
    const max: CostStats = { type: 'soldier', maxHealth: 500, damage: 60, range: 300, speed: 5, attackCooldown: 60, size: 20 };
    expect(cost(half)).toBe(267);
    expect(cost(max)).toBe(1036);
    expect(cost(max)).toBeGreaterThan(2 * cost(half));
    // Big Tank vs two Half Tanks.
    const tank: CostStats = { type: 'soldier', maxHealth: 500, damage: 20, range: 40, speed: 0.8, attackCooldown: 60, size: 20 };
    expect(cost(tank)).toBeGreaterThan(2 * cost({ ...tank, maxHealth: 250 }));
  });

  it('without the curve (k = 0) the same check fails: one big unit was cheaper than two', () => {
    const linear = { ...coeffs, curveK: 0 };
    const half: CostStats = { type: 'soldier', maxHealth: 250, damage: 30, range: 150, speed: 2.5, attackCooldown: 60, size: 13 };
    expect(cost(doubled(half), linear)).toBeLessThan(2 * cost(half, linear));
  });
});

describe('cost curve: archetype guards', () => {
  it('an all-max unit at CD 60 is rejected (> cap)', () => {
    const max: CostStats = { type: 'soldier', maxHealth: 500, damage: 60, range: 300, speed: 5, attackCooldown: 60, size: 20 };
    expect(cost(max)).toBeGreaterThan(cap);
    // Even as a tower (speed 0) it doesn't fit.
    expect(cost({ ...max, type: 'tower', speed: 0 })).toBeGreaterThan(cap);
  });

  it('templates stay in their target band and 4-8 unit armies fit the budget', () => {
    const soldier = cost(BASIC_SOLDIER);
    const tower = cost(BASIC_TOWER);
    expect(soldier).toBeGreaterThanOrEqual(90);
    expect(soldier).toBeLessThanOrEqual(120);
    expect(tower).toBeGreaterThanOrEqual(150);
    expect(tower).toBeLessThanOrEqual(200);
    expect(4 * soldier + 3 * tower).toBeLessThanOrEqual(DEFAULT_CONFIG.caps.budget);
    expect(8 * soldier).toBeLessThanOrEqual(DEFAULT_CONFIG.caps.budget);
  });

  it('Big Tank (500 HP) and Sniper Tower (range 280) cost clearly more than their linear price', () => {
    const linear = { ...coeffs, curveK: 0 };
    const tank: CostStats = { type: 'soldier', maxHealth: 500, damage: 20, range: 40, speed: 0.8, attackCooldown: 60, size: 20 };
    const sniper: CostStats = { type: 'tower', maxHealth: 80, damage: 40, range: 280, speed: 0, attackCooldown: 60, size: 14 };
    expect(cost(tank) / cost(tank, linear)).toBeGreaterThan(2);
    expect(cost(sniper) / cost(sniper, linear)).toBeGreaterThan(1.8);
    expect(cost(tank)).toBeLessThanOrEqual(cap); // pricey, but still buildable
  });

  it('every plan §6 reference row matches computeCost exactly', () => {
    const plan = readFileSync(new URL('../plan.md', import.meta.url), 'utf8');
    const section = plan.split('### Reference units (curve k = 2)')[1]!.split('\n### ')[0]!;
    const rows = section.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Unit') && !l.startsWith('|---'));
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const line of rows) {
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      const [name, type, hp, dmg, range, speed, size, cd, linearSum, curve, sum, , rawCell, costCell, withoutCurve] = cells as string[];
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
      expect(r.cost, `${name} cost`).toBe(Number(/\$(\d+)/.exec(costCell!)![1]));
      expect(/rejected/.test(costCell!), `${name} rejected`).toBe(r.cost > cap);
      expect(cost(st, { ...coeffs, curveK: 0 }), `${name} without curve`).toBe(Number(/\$(\d+)/.exec(withoutCurve!)![1]));
    }
  });
});

describe('cost curve: messages follow curveK', () => {
  const max: CostStats = { type: 'soldier', maxHealth: 500, damage: 60, range: 300, speed: 5, attackCooldown: 60, size: 20 };
  const tank: CostStats = { type: 'soldier', maxHealth: 500, damage: 20, range: 40, speed: 0.8, attackCooldown: 60, size: 20 };

  it('k = 2: W_STAT_NEAR_MAX says 3× and the too-expensive fix says to spread stats', () => {
    const w = nearMaxWarnings(tank, computeCost(tank, coeffs), coeffs);
    expect(w.map((x) => x.field)).toContain('maxHealth');
    expect(w.find((x) => x.field === 'maxHealth')!.message).toContain('costs 3× its normal price');
    const err = tooExpensiveError(max, computeCost(max, coeffs), cap, coeffs);
    expect(err.fix).toContain('Maxed stats cost up to 3× their normal price');
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
      expect((await admin.get('/admin/config')).body.config.cost.curveK).toBe(2);
    });

    it('refuses a curve retune that would make a template invalid', async () => {
      // A steep curve with pricier range pushes the Basic Tower (range 180) over $500.
      const r = await admin.put('/admin/config', { cost: { curveK: 5, range: 1 } });
      expect(r.body.error.code).toBe('TEMPLATE_WOULD_BREAK');
      expect(r.body.error.message).toContain('Basic Tower');
      expect((await admin.get('/admin/config')).body.config.cost).toEqual(DEFAULT_CONFIG.cost);
    });

    it('accepts a valid curve retune and re-prices the templates', async () => {
      const r = await admin.put('/admin/config', { cost: { curveK: 0 } });
      expect(r.status).toBe(200);
      expect(r.body.config.cost.curveK).toBe(0);
      const back = await admin.put('/admin/config', { cost: { curveK: 2 } });
      expect(back.status).toBe(200);
    });
  });
});
