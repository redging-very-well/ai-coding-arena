// The $10,000 redesign cost formula: every row of "Reference units (curve
// k = 1)" parsed from tests/fixtures/economy-reference.md and checked column
// by column (cost, raw, linear, curve, heal, every factor, the aura and the
// "$5,000 game" price of the same unit in M8.8), the factor tables (copy ramp
// included), the breakdown texts, the levers of UNIT_TOO_EXPENSIVE and the
// $10,000 example armies. The numbers come from an independent reference
// implementation of the formula.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  checkStats,
  computeCost,
  copiesCost,
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
const REF = readFileSync(new URL('./fixtures/economy-reference.md', import.meta.url), 'utf8');

/** Rounded like the reference tables: 2 decimals, no trailing zeros. */
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

/** The reference table under `heading`: its data rows as cell arrays. */
function tableRows(heading: string): string[][] {
  const at = REF.indexOf(`### ${heading}\n`);
  expect(at, heading).toBeGreaterThan(-1);
  const body = REF.slice(at).split('\n').slice(1);
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

/**
 * The "$5,000 game" column: the same unit in M8.8 (HP ÷1.6, damage ÷0.8, heal
 * power ÷1.6, priced with the M8.8 coefficients and curve maxima HP 2500,
 * damage 300, heal 250). Those maxima are the redesign's ÷1.6 / ÷0.8 too, so
 * every curve ratio is unchanged and the M8.8 price is today's computeCost on
 * the redesign stats with the M8.8 coefficients rescaled: hp 0.3/1.6,
 * damage 1.5/0.8, heal 4.5/1.6.
 */
const M88 = {
  ...coeffs,
  base: 50, hp: 0.3 / 1.6, damage: 1.5 / 0.8, range: 1.38, speed: 66, size: 8, referenceCooldown: 60, curveK: 1, powerFactor: 0.6, splash: 0.7,
  element: { normal: 1, fire: 1.2, ice: 1.2, lightning: 1.2 }, heal: 4.5 / 1.6, aura: { haste: 5, might: 4, shield: 7 },
};

describe('computeCost: "Reference units (curve k = 1)", every column', () => {
  it('parses every row of the reference table', () => {
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
      // "$5,000 game": the same unit priced in M8.8.
      expect(`$${computeCost(row.stats, M88).cost.toLocaleString('en-US')}`).toBe(row.old);
    });
  }

  it('every table unit passes the default stat bounds (cost aside)', () => {
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

describe('the factor tables', () => {
  const block = REF.slice(REF.indexOf('### Factor tables'));
  const line = (prefix: string) => block.split('\n').find((l) => l.startsWith(prefix))!;
  const pairs = (l: string) => [...l.matchAll(/(\d+(?:\/\d+)?):×([\d.]+)/g)].map((m) => [m[1]!, Number(m[2])] as const);

  it('splash 10-80 px', () => {
    for (const [r, f] of pairs(line('splash '))) {
      const b = computeCost({ type: 'tower', maxHealth: 1000, damage: 80, range: 140, speed: 0, attackCooldown: 60, splashRadius: Number(r) }, coeffs).breakdown;
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

  it('elements multiply the whole price: fire and lightning 1.3, ice 1.75; normal by 1', () => {
    const base: CostStats = { type: 'soldier', maxHealth: 1400, damage: 56, range: 40, speed: 1.5, attackCooldown: 60, size: 10 };
    const normal = computeCost(base, coeffs).raw;
    for (const [element, f] of [['fire', 1.3], ['ice', 1.75], ['lightning', 1.3]] as const) {
      expect(computeCost({ ...base, element }, coeffs).raw).toBeCloseTo(normal * f, 9);
    }
  });

  it('the copy ramp: n copies of a $1,000 design cost n × $1,000 × the factor (walls never ramp)', () => {
    const ramp = DEFAULT_CONFIG.caps.copyRamp;
    expect(ramp).toEqual({ freeCopies: 3, pctPerCopy: 15 });
    const found = pairs(line('copy ramp'));
    expect(found.length).toBeGreaterThanOrEqual(8);
    for (const [n, f] of found) expect(f2(copiesCost(1000, Number(n), 'soldier', ramp) / 1000), `copies ${n}`).toBe(f);
    expect(copiesCost(149, 12, 'wall', ramp)).toBe(12 * 149);
  });
});

describe('breakdown texts', () => {
  // The M8.8 brick 1750 / 265 rescaled (HP ×1.6, damage ×0.8): same stat prices, power ×2.24 now.
  const brick: CostStats = { type: 'soldier', maxHealth: 2800, damage: 212, range: 40, speed: 1.5, attackCooldown: 60, size: 16 };

  it('per stat, the power factor and the other factors', () => {
    const b = computeCost(brick, coeffs).breakdown;
    expect(b.parts.maxHealth.text).toBe('maxHealth 2800 costs $782.25: $525 base + $257.25 for being at 70% of the max');
    expect(b.parts.damage.text).toBe('damage 212 costs $707.66: $397.5 base + $310.16 for being near the max (88% of max)');
    expect(b.power!.text).toBe('Power ×2.24: tough (70% of max HP) AND strong (88% of max damage).');
    expect(b.splash!.text).toBe('Splash ×1 (one target)');
    expect(b.element!.text).toBe('No element ×1');
    const splashy = computeCost({ ...brick, splashRadius: 40, element: 'fire' }, coeffs).breakdown;
    expect(splashy.splash!.text).toBe('Splash ×1.6 (radius 40: everyone within 40 px of the target takes half)');
    expect(splashy.element!.text).toBe('Fire (hits burn) ×1.3');
  });

  it('the heal and aura lines', () => {
    // The Field Medic and the War Drummer of the reference table.
    const body: CostStats = { type: 'soldier', maxHealth: 800, damage: 0, range: 20, speed: 1.5, attackCooldown: 60, size: 10 };
    expect(computeCost({ ...body, support: { kind: 'heal', power: 96, range: 120 } }, coeffs).breakdown.heal!.text).toBe(
      'Heal 96 HP up to 120 px away: $476.17 (faster healing costs more)',
    );
    expect(computeCost({ ...body, support: { kind: 'might', power: 30, range: 100 } }, coeffs).breakdown.aura!.text).toBe(
      'Might aura 30% within 100 px: +$453.33, added on top',
    );
  });

  it('the worked examples (exact arithmetic)', () => {
    // Basic Soldier: base 50 + HP 262.5 (+32.16) + damage 105 (+5.72) + range 55.2 (+0.98) + speed 135 (+12.15) + size 32 (+2.61).
    const soldier = computeCost({ type: 'soldier', maxHealth: 1400, damage: 56, range: 40, speed: 1.5, attackCooldown: 60, size: 10 }, coeffs).breakdown;
    expect(soldier.terms.base).toBe(50);
    expect(f2(soldier.terms.maxHealth)).toBe(294.66);
    expect(f2(soldier.terms.damage)).toBe(110.72);
    expect(f2(soldier.terms.range)).toBe(56.18);
    expect(f2(soldier.terms.speed)).toBe(147.15);
    expect(f2(soldier.terms.size)).toBe(34.61);
    expect(f2(soldier.sum)).toBe(693.32);
    expect(soldier.linear).toBeCloseTo(639.7, 9);
    expect(soldier.power!.factor).toBeCloseTo(1 + 2 * 0.35 * (56 / 240), 12);
    expect(f2(soldier.power!.factor)).toBe(1.16);
    expect(soldier.cost).toBe(807);
    // Basic Tower: 762.57 × 60/45 × 1.18 → $1,200.
    const tower = computeCost({ type: 'tower', maxHealth: 1200, damage: 72, range: 140, speed: 0, attackCooldown: 45, size: 14 }, coeffs);
    expect(f2(tower.breakdown.sum)).toBe(762.57);
    expect(tower.breakdown.power!.factor).toBeCloseTo(1.18, 12);
    expect(f2(tower.raw)).toBe(1199.78);
    expect(tower.cost).toBe(1200);
  });

  it('W_STAT_NEAR_MAX says 1.81× at 90% and covers supportPower; W_POWER_HIGH from ×1.25', () => {
    const stats: CostStats = { type: 'soldier', maxHealth: 3600, damage: 20, range: 40, speed: 1, attackCooldown: 60 };
    const w = nearMaxWarnings(stats, computeCost(stats, coeffs), coeffs);
    expect(w.map((x) => x.field)).toEqual(['maxHealth']);
    expect(w[0]!.message).toBe('maxHealth is at 90% of max and costs 1.81× its normal price.');
    const healer: CostStats = { type: 'soldier', maxHealth: 800, damage: 0, range: 20, speed: 1.5, attackCooldown: 60, support: { kind: 'heal', power: 384, range: 100 } };
    expect(nearMaxWarnings(healer, computeCost(healer, coeffs), coeffs).map((x) => x.field)).toEqual(['supportPower']);
    expect(powerHighWarning(brick, computeCost(brick, coeffs), coeffs)).toMatchObject({ code: 'W_POWER_HIGH', field: 'damage', value: 2.24 });
    const tank: CostStats = { type: 'soldier', maxHealth: 2000, damage: 56, range: 40, speed: 0.8, attackCooldown: 60, size: 20 };
    expect(powerHighWarning(tank, computeCost(tank, coeffs), coeffs)).toBeNull(); // ×1.23
    const halfTank: CostStats = { ...tank, damage: 80 };
    expect(powerHighWarning(halfTank, computeCost(halfTank, coeffs), coeffs)).toMatchObject({ code: 'W_POWER_HIGH', value: 1.33 });
  });
});

describe('cooldown factor clamp and rounding', () => {
  const sniper: CostStats = { type: 'tower', maxHealth: 640, damage: 160, range: 280, speed: 0, attackCooldown: 60, size: 14 };

  it('CD 90 and 600 are clamped to factor 1 (no discount)', () => {
    expect(computeCost({ ...sniper, attackCooldown: 90 }, coeffs).breakdown.factor).toBe(1);
    expect(computeCost({ ...sniper, attackCooldown: 90 }, coeffs).cost).toBe(computeCost(sniper, coeffs).cost);
    expect(computeCost(sniper, coeffs).cost).toBe(1717);
    expect(computeCost({ type: 'tower', maxHealth: 80, damage: 0, range: 20, speed: 0, attackCooldown: 600, size: 6 }, coeffs).cost).toBe(93);
  });

  it('an omitted size is priced at the type default (soldier 10, tower 14)', () => {
    expect(computeCost({ type: 'soldier', maxHealth: 1400, damage: 56, range: 40, speed: 1.5, attackCooldown: 60 }, coeffs).cost).toBe(807);
    expect(computeCost({ type: 'tower', maxHealth: 1200, damage: 72, range: 140, speed: 0, attackCooldown: 45 }, coeffs).cost).toBe(1200);
  });

  it('a whole-number raw is not rounded up (the maxed wall: exactly 920)', () => {
    expect(computeCost({ type: 'wall', maxHealth: 12000, damage: 0, range: 0, speed: 0, attackCooldown: 0 }, coeffs).raw).toBe(920);
    expect(computeCost({ type: 'wall', maxHealth: 12000, damage: 0, range: 0, speed: 0, attackCooldown: 0 }, coeffs).cost).toBe(920);
  });

  it('float noise just above a whole number does not round up an extra credit', () => {
    const noisy = { ...coeffs, base: 0.1 + 0.2, hp: 0, damage: 0, range: 0, speed: 0, size: 0, curveK: 0, powerFactor: 0 };
    const r = computeCost({ type: 'tower', maxHealth: 80, damage: 0, range: 20, speed: 0, attackCooldown: 6 }, noisy);
    expect(r.raw).toBeGreaterThan(3);
    expect(r.cost).toBe(3);
  });
});

describe('UNIT_TOO_EXPENSIVE levers (in order: cooldown, power, splash, element, support, stat)', () => {
  const scout = (cd: number): CostStats => ({ type: 'soldier', maxHealth: 480, damage: 24, range: 30, speed: 4, attackCooldown: cd, size: 6 });

  it('Scout with cooldown 10 ($5,032) names the cooldown factor: CD 20 makes it $2,516', () => {
    const err = tooExpensiveError(scout(10), computeCost(scout(10), coeffs), cap, coeffs);
    expect(err).toMatchObject({ code: 'UNIT_TOO_EXPENSIVE', value: 5032, allowed: { max: 3000 } });
    expect(err.fix).toContain('Cost is $5,032 but the max is $3,000. The ×6 cooldown factor is the biggest cost: raising attackCooldown from 10 to 20 makes it ×3 ($2,516).');
    expect(err.fix).toContain('The most expensive stat is speed');
  });

  it('a brick over the cap names the power factor first', () => {
    const stats: CostStats = { type: 'soldier', maxHealth: 2800, damage: 212, range: 40, speed: 1.5, attackCooldown: 60, size: 16 };
    const priced = computeCost(stats, coeffs);
    expect(priced.cost).toBe(4170);
    const err = tooExpensiveError(stats, priced, cap, coeffs);
    // The more maxed of HP (70%) and damage (88%) comes down until the power factor is at most ×1.25.
    expect(err.fix).toMatch(/^Cost is \$4,170 but the max is \$3,000\. Lowering damage from 212 to \d+ drops the power factor from ×2\.24 to ×1\.2\d and saves \$\d+/);
    expect(err.fix).toContain('Maxed stats cost up to 2× their normal price');
  });

  it('then splash, then the element, then the support', () => {
    // Power ×1.2 (below ×1.25), so splash is the first lever.
    const splashBrick: CostStats = { type: 'soldier', maxHealth: 1200, damage: 80, range: 160, speed: 4, attackCooldown: 60, size: 16, element: 'fire', splashRadius: 80 };
    const s = tooExpensiveError(splashBrick, computeCost(splashBrick, coeffs), cap, coeffs);
    expect(s.fix).toMatch(/^Cost is \$4,091 but the max is \$3,000\. Splash 80 → 40 \(this\.splashRadius = 40\) saves \$454 \(\$3,637\)/);
    const iceBrick: CostStats = { type: 'soldier', maxHealth: 2000, damage: 56, range: 160, speed: 4, attackCooldown: 60, size: 16, element: 'ice' };
    const e = tooExpensiveError(iceBrick, computeCost(iceBrick, coeffs), cap, coeffs);
    expect(computeCost(iceBrick, coeffs).cost).toBe(3506);
    expect(e.fix).toMatch(/^Cost is \$3,506 but the max is \$3,000\. normal instead of ice \(leave this\.element out\) saves \$1,502 \(\$2,004\)/);
    const healer: CostStats = { type: 'soldier', maxHealth: 800, damage: 0, range: 20, speed: 1.5, attackCooldown: 60, size: 10, support: { kind: 'heal', power: 400, range: 200 } };
    const h = tooExpensiveError(healer, computeCost(healer, coeffs), cap, coeffs);
    expect(h.fix).toMatch(/^Cost is \$4,616 but the max is \$3,000\. Lowering supportPower \(heal\) from 400 to 200 saves \$\d+/);
  });

  it('the max-stats unit names maxHealth and the next stat', () => {
    const stats: CostStats = { type: 'soldier', maxHealth: 4000, damage: 240, range: 160, speed: 5, attackCooldown: 60, size: 20 };
    const err = tooExpensiveError(stats, computeCost(stats, coeffs), cap, coeffs);
    expect(err.value).toBe(11573);
    expect(err.fix).toContain('The most expensive stat is maxHealth: 4000 costs $1,500 before the factors ($750 base + $750 for being 100% of the max).');
  });

  it('a unit one stat away from fitting gets the highest round value of that stat that fits', () => {
    const stats: CostStats = { type: 'soldier', maxHealth: 4000, damage: 60, range: 160, speed: 0.8, attackCooldown: 60, size: 20 };
    const priced = computeCost(stats, coeffs);
    expect(priced.cost).toBeGreaterThan(cap);
    const err = tooExpensiveError(stats, priced, cap, coeffs);
    const m = /Lowering maxHealth from 4000 to (\d+) saves \$([\d,]+) \(\$([\d,]+)\)\./.exec(err.fix);
    expect(m, err.fix).not.toBeNull();
    const to = Number(m![1]);
    const lowered = computeCost({ ...stats, maxHealth: to }, coeffs).cost;
    expect(lowered).toBeLessThanOrEqual(cap);
    expect(Number(m![3]!.replace(/,/g, ''))).toBe(lowered);
    expect(computeCost({ ...stats, maxHealth: to + 50 }, coeffs).cost).toBeGreaterThan(cap);
  });
});

describe('example armies at $10,000 (with the copy ramp)', () => {
  const c = (st: CostStats) => computeCost(st, coeffs).cost;
  const ramp = DEFAULT_CONFIG.caps.copyRamp;
  const soldier = c({ type: 'soldier', maxHealth: 1400, damage: 56, range: 40, speed: 1.5, attackCooldown: 60, size: 10 });
  const tower = c({ type: 'tower', maxHealth: 1200, damage: 72, range: 140, speed: 0, attackCooldown: 45, size: 14 });
  const wall = c({ type: 'wall', maxHealth: 3200, damage: 0, range: 0, speed: 0, attackCooldown: 0 });

  it('templates: 3 soldiers + 3 towers + the factory = $8,215; 9 soldiers is the biggest template rush ($9,810)', () => {
    expect([soldier, tower, wall]).toEqual([807, 1200, 149]);
    expect(copiesCost(soldier, 3, 'soldier', ramp) + copiesCost(tower, 3, 'tower', ramp) + 2194).toBe(8215);
    // All four templates: 4 soldiers (the 4th +15%) + 2 towers + the factory + 6 walls (walls never ramp).
    expect(copiesCost(soldier, 4, 'soldier', ramp) + 2 * tower + 2194 + copiesCost(wall, 6, 'wall', ramp)).toBe(8838);
    expect(9 * soldier).toBe(7263);
    expect(copiesCost(soldier, 9, 'soldier', ramp)).toBe(9810);
    expect(copiesCost(soldier, 10, 'soldier', ramp)).toBeGreaterThan(DEFAULT_CONFIG.caps.budget);
  });

  it('the max-cost brick (2480 / 180) fits the cap and two fit the budget; one step more does not', () => {
    const brick = c({ type: 'soldier', maxHealth: 2480, damage: 180, range: 40, speed: 1.5, attackCooldown: 60, size: 16 });
    expect(brick).toBe(2983);
    expect(copiesCost(brick, 2, 'soldier', ramp) + copiesCost(soldier, 4, 'soldier', ramp)).toBe(9316);
    expect(c({ type: 'soldier', maxHealth: 2560, damage: 180, range: 40, speed: 1.5, attackCooldown: 60, size: 16 })).toBeGreaterThan(cap);
    expect(c({ type: 'soldier', maxHealth: 2480, damage: 184, range: 40, speed: 1.5, attackCooldown: 60, size: 16 })).toBeGreaterThan(cap);
  });

  it('curveK 0 and powerFactor 0 give the plain linear price', () => {
    const linear = { ...coeffs, curveK: 0, powerFactor: 0 };
    const half: CostStats = { type: 'soldier', maxHealth: 2000, damage: 120, range: 150, speed: 2.5, attackCooldown: 60, size: 13 };
    expect(computeCost(half, linear).cost).toBe(1138);
  });
});
