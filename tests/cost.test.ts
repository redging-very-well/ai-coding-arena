// The M8.8 cost formula (plan §6 "M8.8 economy"): every row of "Reference
// units (curve k = 1)" parsed from plan.md and checked column by column
// (cost, raw, linear, curve, heal, every factor and the aura), the factor
// tables, the breakdown texts, the levers of UNIT_TOO_EXPENSIVE and the
// ×5 example armies. The numbers come from the reference implementation of
// the approved design spec (cost.mjs / tables.mjs).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  checkStats,
  computeCost,
  nearMaxWarnings,
  powerHighWarning,
  reachFactor,
  tooExpensiveError,
  type CostStats,
  type Element,
  type SupportKind,
} from '@pixel-clash/shared';

const coeffs = DEFAULT_CONFIG.cost;
const cap = DEFAULT_CONFIG.caps.unitCost;
const PLAN = readFileSync(new URL('../plan.md', import.meta.url), 'utf8');

/** Rounded like the plan tables (tables.mjs f2): 2 decimals, no trailing zeros. */
const f2 = (n: number) => Math.round(n * 100) / 100;
const num = (cell: string) => Number(cell.replace(/[×+$,*]/g, '').trim());

interface Row {
  name: string;
  stats: CostStats;
  linear: number;
  curve: number;
  heal: number;
  sum: number;
  cdF: number;
  power: number;
  splashF: number;
  elemF: number;
  aura: number;
  raw: number;
  cost: number;
  rejected: boolean;
  old: string;
}

/** The plan table under `heading`: its data rows as cell arrays. */
function tableRows(heading: string): string[][] {
  const at = PLAN.indexOf(`### ${heading}\n`);
  expect(at, heading).toBeGreaterThan(-1);
  const body = PLAN.slice(at).split('\n').slice(1);
  const start = body.findIndex((l) => l.startsWith('|'));
  const rows: string[][] = [];
  for (const line of body.slice(start + 2)) {
    if (!line.startsWith('|')) break;
    rows.push(line.split('|').slice(1, -1).map((c) => c.trim()));
  }
  return rows;
}

function parseSupport(cell: string): CostStats['support'] {
  if (!cell) return null;
  const m = /^(heal|haste|might|shield) (\d+)%? \/ (\d+) px$/.exec(cell);
  expect(m, cell).not.toBeNull();
  return { kind: m![1] as SupportKind, power: Number(m![2]), range: Number(m![3]) };
}

const UNITS: Row[] = tableRows('Reference units (curve k = 1)').map((c) => {
  const [name, type, hp, dmg, range, spd, size, cd, element, splash, support, linear, curve, heal, sum, cdF, power, splashF, elemF, aura, raw, cost, old] = c as [
    string, string, string, string, string, string, string, string, string, string, string, string, string, string, string, string, string, string, string, string, string, string, string,
  ];
  return {
    name,
    stats: {
      type: type as 'soldier' | 'tower',
      maxHealth: num(hp),
      damage: num(dmg),
      range: num(range),
      speed: num(spd),
      size: num(size),
      attackCooldown: num(cd),
      element: (element || 'normal') as Element,
      splashRadius: splash ? num(splash) : 0,
      support: parseSupport(support),
    },
    linear: num(linear),
    curve: num(curve),
    heal: heal ? num(heal) : 0,
    sum: num(sum),
    cdF: num(cdF),
    power: num(power),
    splashF: num(splashF),
    elemF: num(elemF),
    aura: aura ? num(aura) : 0,
    raw: num(raw),
    cost: num(cost.replace(/, rejected$/, '')),
    rejected: /rejected/.test(cost),
    old,
  };
});

/** The $1,000-game formula with every money coefficient ×5 (the "Old ×5 (k 2)" column). */
const OLD_X5 = { ...coeffs, base: 50, hp: 0.25, damage: 1.5, range: 1.0, speed: 60, size: 2.5, curveK: 2, powerFactor: 0 };

describe('computeCost: §6 "Reference units (curve k = 1)", every column', () => {
  it('parses every row of the plan table', () => {
    expect(UNITS.length).toBeGreaterThanOrEqual(40);
    expect(UNITS.map((u) => u.name)).toContain('Basic Soldier (template)');
    expect(UNITS.map((u) => u.name)).toContain('Max healer');
  });

  for (const row of UNITS) {
    it(`${row.name} → $${row.cost}${row.rejected ? ' (rejected)' : ''}`, () => {
      const r = computeCost(row.stats, coeffs);
      const b = r.breakdown;
      expect(f2(b.linear!)).toBe(row.linear);
      expect(f2(b.curve!)).toBe(row.curve);
      expect(f2(b.heal?.total ?? 0)).toBe(row.heal);
      expect(f2(b.sum)).toBe(row.sum);
      expect(f2(b.factor)).toBe(row.cdF);
      expect(f2(b.power!.factor)).toBe(row.power);
      expect(f2(b.splash!.factor)).toBe(row.splashF);
      expect(f2(b.element!.factor)).toBe(row.elemF);
      expect(f2(b.aura?.total ?? 0)).toBe(row.aura);
      expect(f2(r.raw)).toBe(row.raw);
      expect(r.cost).toBe(row.cost);
      expect(b.cost).toBe(row.cost);
      expect(r.cost > cap).toBe(row.rejected);
      // "Old ×5 (k 2)": today's formula ×5 (– for rows with new mechanics).
      if (row.old !== '–') {
        const old = computeCost({ ...row.stats, element: 'normal', splashRadius: 0, support: null }, OLD_X5).cost;
        expect(`$${old.toLocaleString('en-US')}${old > cap ? ' ✗' : ''}`).toBe(row.old);
      }
    });
  }

  it('every table unit passes the ×5 stat bounds (cost aside)', () => {
    for (const row of UNITS) {
      const s = row.stats.support;
      const raw = { name: row.name.slice(0, 24), color: '#123456', ...row.stats, support: s?.kind, supportPower: s?.power, supportRange: s?.range };
      if (!s) {
        delete raw.support;
        delete raw.supportPower;
        delete raw.supportRange;
      }
      const res = checkStats(raw, DEFAULT_CONFIG.stats.bounds);
      expect(res.ok, `${row.name}: ${JSON.stringify(!res.ok && res.errors)}`).toBe(true);
    }
  });

  it('the heal sits inside the cooldown factor, the aura outside it', () => {
    const medic = UNITS.find((u) => u.name === 'Field Medic')!;
    const rapid = UNITS.find((u) => u.name === 'Rapid Medic (CD 30)')!;
    expect(rapid.raw).toBeCloseTo(2 * medic.raw, 1);
    const drummer = UNITS.find((u) => u.name === 'War Drummer')!.stats;
    const fast = computeCost({ ...drummer, attackCooldown: 10 }, coeffs).breakdown;
    const slow = computeCost(drummer, coeffs).breakdown;
    expect(fast.aura!.total).toBe(slow.aura!.total);
    expect(fast.raw - fast.aura!.total).toBeCloseTo(6 * (slow.raw - slow.aura!.total), 6);
  });
});

describe('the factor tables (§6 M8.8 factor tables, tables.mjs)', () => {
  const block = PLAN.slice(PLAN.indexOf('### M8.8 factor tables'));
  const line = (prefix: string) => block.split('\n').find((l) => l.startsWith(prefix))!;
  const pairs = (l: string) => [...l.matchAll(/(\d+(?:\/\d+)?):×([\d.]+)/g)].map((m) => [m[1]!, Number(m[2])] as const);

  it('splash 10-80 px', () => {
    for (const [r, f] of pairs(line('splash '))) {
      const b = computeCost({ type: 'tower', maxHealth: 625, damage: 100, range: 140, speed: 0, attackCooldown: 60, splashRadius: Number(r) }, coeffs).breakdown;
      expect(f2(b.splash!.factor), `splash ${r}`).toBe(f);
    }
  });

  it('heal reach and aura radius', () => {
    for (const [r, f] of pairs(line('heal reach'))) expect(f2(reachFactor(Number(r) / 200))).toBe(f);
    for (const [r, f] of pairs(line('aura radius'))) expect(f2(reachFactor(Number(r) / 150))).toBe(f);
  });

  it('the power factor corners', () => {
    for (const [hd, f] of pairs(line('power corners'))) {
      const [hp, dmg] = hd.split('/').map(Number) as [number, number];
      const b = computeCost({ type: 'soldier', maxHealth: hp, damage: dmg, range: 40, speed: 1, attackCooldown: 60 }, coeffs).breakdown;
      expect(f2(b.power!.factor), hd).toBe(f);
    }
  });

  it('elements multiply the whole price by 1.2; normal by 1', () => {
    const base: CostStats = { type: 'soldier', maxHealth: 600, damage: 50, range: 40, speed: 1.5, attackCooldown: 60, size: 10 };
    const normal = computeCost(base, coeffs).raw;
    for (const element of ['fire', 'ice', 'lightning'] as const) {
      expect(computeCost({ ...base, element }, coeffs).raw).toBeCloseTo(normal * 1.2, 9);
    }
  });
});

describe('breakdown texts (§6 M8.8 breakdown)', () => {
  const brick: CostStats = { type: 'soldier', maxHealth: 1750, damage: 265, range: 40, speed: 1.5, attackCooldown: 60, size: 16 };

  it('per stat, the power factor and the other factors', () => {
    const b = computeCost(brick, coeffs).breakdown;
    expect(b.parts.maxHealth.text).toBe('maxHealth 1750 costs $782.25: $525 base + $257.25 for being at 70% of the max');
    expect(b.parts.damage.text).toBe('damage 265 costs $707.66: $397.5 base + $310.16 for being near the max (88% of max)');
    expect(b.power!.text).toBe('Power ×1.37: tough (70% of max HP) AND strong (88% of max damage). One tough unit plus one strong unit is cheaper.');
    expect(b.splash!.text).toBe('Splash ×1 (one target)');
    expect(b.element!.text).toBe('Element normal ×1');
    const splashy = computeCost({ ...brick, splashRadius: 40, element: 'fire' }, coeffs).breakdown;
    expect(splashy.splash!.text).toBe('Splash ×1.53 (radius 40: everyone within 40 px of the target takes half)');
    expect(splashy.element!.text).toBe('Element fire ×1.2');
  });

  it('the heal and aura lines', () => {
    const body: CostStats = { type: 'soldier', maxHealth: 500, damage: 0, range: 20, speed: 1.5, attackCooldown: 60, size: 10 };
    expect(computeCost({ ...body, support: { kind: 'heal', power: 60, range: 120 } }, coeffs).breakdown.heal!.text).toBe(
      'Heal 60 HP, reach 120 px: $382.64 (before the cooldown factor)',
    );
    expect(computeCost({ ...body, support: { kind: 'might', power: 30, range: 100 } }, coeffs).breakdown.aura!.text).toBe(
      'Aura might 30% in 100 px: +$226.67 (always on: after the factors)',
    );
  });

  it('the §6 worked examples (exact arithmetic)', () => {
    const soldier = computeCost({ type: 'soldier', maxHealth: 600, damage: 50, range: 40, speed: 1.5, attackCooldown: 60, size: 10 }, coeffs).breakdown;
    expect(soldier.terms.base).toBe(50);
    expect(f2(soldier.terms.maxHealth)).toBe(190.37);
    expect(f2(soldier.terms.damage)).toBe(77.08);
    expect(f2(soldier.terms.range)).toBe(56.18);
    expect(f2(soldier.terms.speed)).toBe(107.91);
    expect(f2(soldier.terms.size)).toBe(34.61);
    expect(f2(soldier.sum)).toBe(516.15);
    expect(soldier.linear).toBeCloseTo(491.2, 9);
    expect(f2(soldier.power!.factor)).toBe(1.02);
    expect(soldier.cost).toBe(529);
    const tower = computeCost({ type: 'tower', maxHealth: 625, damage: 75, range: 140, speed: 0, attackCooldown: 45, size: 14 }, coeffs);
    expect(f2(tower.breakdown.sum)).toBe(688.92);
    expect(tower.breakdown.power!.factor).toBeCloseTo(1.0375, 12);
    expect(f2(tower.raw)).toBe(953.01);
    expect(tower.cost).toBe(954);
  });

  it('W_STAT_NEAR_MAX says 1.81× at 90% and covers supportPower; W_POWER_HIGH from ×1.25', () => {
    const stats: CostStats = { type: 'soldier', maxHealth: 2250, damage: 20, range: 40, speed: 1, attackCooldown: 60 };
    const w = nearMaxWarnings(stats, computeCost(stats, coeffs), coeffs);
    expect(w.map((x) => x.field)).toEqual(['maxHealth']);
    expect(w[0]!.message).toBe('maxHealth is at 90% of max and costs 1.81× its normal price; two medium units usually beat one maxed one.');
    const healer: CostStats = { type: 'soldier', maxHealth: 500, damage: 0, range: 20, speed: 1.5, attackCooldown: 60, support: { kind: 'heal', power: 240, range: 100 } };
    expect(nearMaxWarnings(healer, computeCost(healer, coeffs), coeffs).map((x) => x.field)).toEqual(['supportPower']);
    expect(powerHighWarning(brick, computeCost(brick, coeffs), coeffs)).toMatchObject({ code: 'W_POWER_HIGH', field: 'damage', value: 1.37 });
    const tank: CostStats = { type: 'soldier', maxHealth: 2500, damage: 100, range: 40, speed: 0.8, attackCooldown: 60, size: 20 };
    expect(powerHighWarning(tank, computeCost(tank, coeffs), coeffs)).toBeNull(); // ×1.2
  });
});

describe('cooldown factor clamp and rounding', () => {
  const sniper: CostStats = { type: 'tower', maxHealth: 400, damage: 200, range: 280, speed: 0, attackCooldown: 60, size: 14 };

  it('CD 90 and 600 are clamped to factor 1 (no discount)', () => {
    expect(computeCost({ ...sniper, attackCooldown: 90 }, coeffs).breakdown.factor).toBe(1);
    expect(computeCost({ ...sniper, attackCooldown: 90 }, coeffs).cost).toBe(computeCost(sniper, coeffs).cost);
    expect(computeCost({ type: 'tower', maxHealth: 50, damage: 0, range: 20, speed: 0, attackCooldown: 600, size: 6 }, coeffs).cost).toBe(93);
  });

  it('an omitted size is priced at the type default (soldier 10, tower 14)', () => {
    expect(computeCost({ type: 'soldier', maxHealth: 600, damage: 50, range: 40, speed: 1.5, attackCooldown: 60 }, coeffs).cost).toBe(529);
    expect(computeCost({ type: 'tower', maxHealth: 625, damage: 75, range: 140, speed: 0, attackCooldown: 45 }, coeffs).cost).toBe(954);
  });

  it('a whole-number raw is not rounded up (the maxed wall: exactly 920)', () => {
    expect(computeCost({ type: 'wall', maxHealth: 7500, damage: 0, range: 0, speed: 0, attackCooldown: 0 }, coeffs).raw).toBe(920);
    expect(computeCost({ type: 'wall', maxHealth: 7500, damage: 0, range: 0, speed: 0, attackCooldown: 0 }, coeffs).cost).toBe(920);
  });

  it('float noise just above a whole number does not round up an extra credit', () => {
    const noisy = { ...coeffs, base: 0.1 + 0.2, hp: 0, damage: 0, range: 0, speed: 0, size: 0, curveK: 0, powerFactor: 0 };
    const r = computeCost({ type: 'tower', maxHealth: 50, damage: 0, range: 20, speed: 0, attackCooldown: 6 }, noisy);
    expect(r.raw).toBeGreaterThan(3);
    expect(r.cost).toBe(3);
  });
});

describe('UNIT_TOO_EXPENSIVE levers (§6 M8.8 order: cooldown, power, splash, element, support, stat)', () => {
  const scout = (cd: number): CostStats => ({ type: 'soldier', maxHealth: 300, damage: 30, range: 30, speed: 4, attackCooldown: cd, size: 6 });

  it('Scout with cooldown 10 ($3,998) names the cooldown factor: CD 20 makes it $1,999 (§7)', () => {
    const err = tooExpensiveError(scout(10), computeCost(scout(10), coeffs), cap, coeffs);
    expect(err).toMatchObject({ code: 'UNIT_TOO_EXPENSIVE', value: 3998, allowed: { max: 2500 } });
    expect(err.fix).toContain('Cost is $3998 but the max is $2500. The ×6 cooldown factor is the biggest cost: raising attackCooldown from 10 to 20 makes it ×3 ($1999).');
    expect(err.fix).toContain('The most expensive stat is speed');
  });

  it('a brick over the cap names the power factor first', () => {
    const stats: CostStats = { type: 'soldier', maxHealth: 2150, damage: 250, range: 40, speed: 1.5, attackCooldown: 60, size: 16 };
    const priced = computeCost(stats, coeffs);
    expect(priced.cost).toBe(2993);
    const err = tooExpensiveError(stats, priced, cap, coeffs);
    // The more maxed of HP (86%) and damage (83%) comes down until the power factor is ×1.25.
    expect(err.fix).toMatch(/^Cost is \$2993 but the max is \$2500\. Lowering maxHealth from 2150 to \d+ drops the power factor from ×1\.43 to ×1\.25 and saves \$\d+/);
    expect(err.fix).toContain('Maxed stats cost up to 2× their normal price');
  });

  it('then splash, then the element, then the support', () => {
    const splashBrick: CostStats = { type: 'soldier', maxHealth: 1000, damage: 200, range: 40, speed: 1.5, attackCooldown: 60, size: 16, element: 'fire', splashRadius: 80 };
    const s = tooExpensiveError(splashBrick, computeCost(splashBrick, coeffs), cap, coeffs);
    expect(s.fix).toMatch(/Splash 80 → 40 \(this\.splashRadius = 40\) saves \$\d+/);
    const fireBrick: CostStats = { type: 'soldier', maxHealth: 2000, damage: 120, range: 40, speed: 4, attackCooldown: 60, size: 16, element: 'fire' };
    const e = tooExpensiveError(fireBrick, computeCost(fireBrick, coeffs), cap, coeffs);
    expect(computeCost(fireBrick, coeffs).cost).toBeGreaterThan(cap);
    expect(e.fix).toMatch(/normal instead of fire \(leave this\.element out\) saves \$\d+/);
    const healer: CostStats = { type: 'soldier', maxHealth: 500, damage: 0, range: 20, speed: 1.5, attackCooldown: 60, size: 10, support: { kind: 'heal', power: 250, range: 200 } };
    const h = tooExpensiveError(healer, computeCost(healer, coeffs), cap, coeffs);
    expect(h.fix).toMatch(/Lowering supportPower \(heal\) from 250 to 125 saves \$\d+/);
  });

  it('the max-stats unit names maxHealth and the next stat', () => {
    const stats: CostStats = { type: 'soldier', maxHealth: 2500, damage: 300, range: 300, speed: 5, attackCooldown: 60, size: 20 };
    const err = tooExpensiveError(stats, computeCost(stats, coeffs), cap, coeffs);
    expect(err.value).toBe(6660);
    expect(err.fix).toContain('The most expensive stat is maxHealth: 2500 costs $1500 before the factors ($750 base + $750 for being 100% of the max).');
  });

  it('a unit one stat away from fitting gets the highest round value of that stat that fits', () => {
    const stats: CostStats = { type: 'soldier', maxHealth: 2500, damage: 60, range: 300, speed: 0.8, attackCooldown: 60, size: 20 };
    const priced = computeCost(stats, coeffs);
    expect(priced.cost).toBeGreaterThan(cap);
    const err = tooExpensiveError(stats, priced, cap, coeffs);
    const m = /Lowering maxHealth from 2500 to (\d+) saves \$(\d+) \(\$(\d+)\)\./.exec(err.fix);
    expect(m, err.fix).not.toBeNull();
    const to = Number(m![1]);
    const lowered = computeCost({ ...stats, maxHealth: to }, coeffs).cost;
    expect(lowered).toBeLessThanOrEqual(cap);
    expect(Number(m![3])).toBe(lowered);
    expect(computeCost({ ...stats, maxHealth: to + 50 }, coeffs).cost).toBeGreaterThan(cap);
  });
});

describe('§6 M8.8 example armies at $5,000', () => {
  const c = (st: CostStats) => computeCost(st, coeffs).cost;
  const soldier = c({ type: 'soldier', maxHealth: 600, damage: 50, range: 40, speed: 1.5, attackCooldown: 60, size: 10 });
  const tower = c({ type: 'tower', maxHealth: 625, damage: 75, range: 140, speed: 0, attackCooldown: 45, size: 14 });

  it('templates: 4 soldiers + 3 towers = $4,978; 9 soldiers is the biggest template rush', () => {
    expect(4 * soldier + 3 * tower).toBe(4978);
    expect(9 * soldier).toBe(4761);
    expect(10 * soldier).toBeGreaterThan(DEFAULT_CONFIG.caps.budget);
  });

  it('two max-cost bricks fit; today\'s brick ×5 does not', () => {
    // M8.8 balance retune: 1,700 / 270 (the spec's 1,750 / 265 costs $2,502 after cost.speed 66).
    const brick = c({ type: 'soldier', maxHealth: 1700, damage: 270, range: 40, speed: 1.5, attackCooldown: 60, size: 16 });
    expect(brick).toBe(2480);
    expect(2 * brick).toBe(4960);
    expect(c({ type: 'soldier', maxHealth: 1750, damage: 265, range: 40, speed: 1.5, attackCooldown: 60, size: 16 })).toBeGreaterThan(cap);
    expect(c({ type: 'soldier', maxHealth: 2150, damage: 250, range: 40, speed: 1.5, attackCooldown: 60, size: 16 })).toBeGreaterThan(cap);
  });

  it('curveK 0 and powerFactor 0 give the plain linear price', () => {
    const linear = { ...coeffs, curveK: 0, powerFactor: 0 };
    const half: CostStats = { type: 'soldier', maxHealth: 1250, damage: 150, range: 150, speed: 2.5, attackCooldown: 60, size: 13 };
    expect(computeCost(half, linear).cost).toBe(1078);
  });
});
