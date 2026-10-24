// Walls and factories in shared (plan §5.2, §6 Walls and factories, §7 per
// type, §9.3 Placement check, M8.5): the reference price tables, the
// production part, re-pricing inputs, per-type stat guards, config limits and
// the W_TRAPPED flood fill.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  checkStats,
  computeCost,
  deepMerge,
  expectedMinions,
  mapFor,
  minionPrice,
  minionSprite,
  pricingOf,
  safeParseConfig,
  sizeOf,
  tooExpensiveError,
  trappedCells,
  checkSprite,
  type CostStats,
  type GameConfig,
  type UnitType,
} from '@pixel-clash/shared';

const C = DEFAULT_CONFIG;
const wall = (hp: number): CostStats => ({ type: 'wall', maxHealth: hp, damage: 0, range: 0, speed: 0, attackCooldown: 0 });
const factory = (hp: number, interval: number): CostStats => ({
  type: 'factory',
  maxHealth: hp,
  damage: 0,
  range: 0,
  speed: 0,
  attackCooldown: 0,
  productionInterval: interval,
});
const cost = (s: CostStats, cfg: GameConfig = C) => computeCost(s, cfg.cost, pricingOf(cfg)).cost;
const cfg = (patch: unknown): GameConfig => deepMerge(C, patch);

const PLAN = readFileSync(new URL('../plan.md', import.meta.url), 'utf8');
/** The rows of the plan table that follows `marker` inside "Reference walls, minions and factories (curve k = 1)". */
function planTable(marker: string): string[][] {
  const section = PLAN.slice(PLAN.indexOf('### Reference walls, minions and factories (curve k = 1)'));
  const at = section.indexOf(marker);
  expect(at, marker).toBeGreaterThan(-1);
  const lines = section.slice(at).split('\n');
  const start = lines.findIndex((l) => l.startsWith('|'));
  const out: string[][] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break;
    out.push(line.split('|').slice(1, -1).map((c) => c.trim()));
  }
  return out;
}
const dollars = (cell: string) => Number(/\$([\d,]+)/.exec(cell)![1]!.replace(/,/g, ''));
const f2 = (n: number) => Math.round(n * 100) / 100;

describe('§6 reference walls, minions and factories (curve k = 1, M8.8)', () => {
  it('every wall row of the plan table: linear, curve, raw and cost', () => {
    const rows = planTable('Walls, `raw =');
    expect(rows.length).toBe(8);
    for (const [hp, linear, curve, raw, price] of rows as Array<[string, string, string, string, string]>) {
      const r = computeCost(wall(Number(hp)), C.cost);
      expect(f2(r.breakdown.terms.base + r.breakdown.parts.maxHealth.linear), `${hp} linear`).toBe(Number(linear));
      expect(f2(r.breakdown.parts.maxHealth.curve), `${hp} curve`).toBe(Number(curve.replace('+', '')));
      expect(f2(r.raw), `${hp} raw`).toBe(Number(raw));
      expect(r.cost, `${hp} cost`).toBe(dollars(price));
    }
  });

  it('every minion kind × element: raw → minionCost → minionValue; the medic ignores its element', () => {
    const rows = planTable('Minions are priced with the soldier formula');
    expect(rows.map((r) => r[0])).toEqual(['grunt', 'archer', 'runner', 'brute', 'medic']);
    const P = pricingOf(C);
    for (const row of rows) {
      const kind = row[0] as 'grunt' | 'archer' | 'runner' | 'brute' | 'medic';
      (['normal', 'fire', 'ice', 'lightning'] as const).forEach((element, i) => {
        const m = /^([\d.]+) → \$([\d,]+) → \*\*\$([\d,]+)\*\*$/.exec(row[6 + i]!)!;
        expect(m, row[6 + i]).not.toBeNull();
        const price = minionPrice(C.cost, P, kind, element);
        expect(price.minionCost, `${kind} ${element}`).toBe(Number(m[2]!.replace(',', '')));
        expect(price.minionValue, `${kind} ${element}`).toBe(Number(m[3]!.replace(',', '')));
      });
    }
  });

  it('every factory row: body raw, body, production and cost (the $2,938 one is rejected)', () => {
    const rows = planTable('Factories:');
    expect(rows.length).toBe(17);
    for (const [name, kind, element, hp, interval, e, bodyRaw, body, production, price] of rows as Array<
      [string, string, string, string, string, string, string, string, string, string]
    >) {
      const st = { ...factory(Number(hp), Number(interval)), produces: kind as 'grunt', minionElement: element as 'normal' };
      const r = computeCost(st, C.cost, pricingOf(C));
      expect(r.breakdown.production!.expected, `${name} E`).toBe(Number(e));
      expect(f2(r.breakdown.sum), `${name} body raw`).toBe(Number(bodyRaw));
      expect(r.breakdown.body, `${name} body`).toBe(dollars(body));
      expect(`${e} × $${r.breakdown.production!.minionValue} = $${r.breakdown.production!.total.toLocaleString('en-US')}`, name).toBe(production);
      expect(r.cost, name).toBe(dollars(price));
      expect(r.cost > C.caps.unitCost, `${name} rejected`).toBe(/rejected/.test(price));
    }
  });

  it('the maxed factory is over the cap; the fix names the bigger of HP and production', () => {
    const st = { ...factory(5000, 600), produces: 'runner' as const, minionElement: 'lightning' as const };
    const r = computeCost(st, C.cost);
    expect(r.cost).toBe(3026);
    // The production ($1,776) is bigger than the body's HP term ($1,200): raise the interval, or make cheaper minions.
    const fix = tooExpensiveError(st, r, C.caps.unitCost, C.cost, C.stats.bounds).fix;
    expect(fix).toMatch(/^Cost is \$3026 but the max is \$2500\. The production \(8 lightning runners × \$222\) is the biggest cost: raising productionInterval from 600 to \d+/);
    expect(fix).toContain("Making grunts instead of runners (this.produces = 'grunt') saves");
    expect(fix).toContain('Normal minions instead of lightning ones save $');
    // A fortress body is the bigger lever when the production is small.
    const body = factory(5000, 1800);
    const rb = computeCost(body, cfg({ cost: { factory: { hp: 0.3 } } }).cost);
    expect(tooExpensiveError(body, rb, C.caps.unitCost, cfg({ cost: { factory: { hp: 0.3 } } }).cost, C.stats.bounds).fix).toMatch(/most expensive stat is maxHealth/);
  });

  it('the grunt is a $296 soldier, so a factory pays $148 per expected minion', () => {
    expect(minionPrice(C.cost)).toEqual({ minionCost: 296, minionValue: 148 });
    const b = computeCost(factory(1500, 900), C.cost).breakdown;
    expect(b.formula).toBe('factory');
    expect(b.body).toBe(247);
    expect(b.production).toMatchObject({ interval: 900, minionCost: 296, minionValue: 148, expected: 5, total: 740, element: 'normal' });
    expect(b.production!.text).toBe('Production: 5 minions × $148 (half of a $296 minion, because they arrive during the battle) = $740');
    const fire = computeCost({ ...factory(1500, 900), produces: 'brute', minionElement: 'fire' }, C.cost).breakdown;
    expect(fire.production!.text).toBe('Production: 5 fire brutes × $256 (half of a $511 fire brute, because they arrive during the battle) = $1280');
  });

  it('E = min(8, floor((battleTicks − 1) / interval)) and follows the battle length', () => {
    expect([600, 720, 900, 1200, 1800].map((i) => expectedMinions(i))).toEqual([8, 7, 5, 4, 2]);
    const short = pricingOf(cfg({ timers: { battleTicks: 3600 } }));
    expect(expectedMinions(600, short)).toBe(5);
    expect(cost(factory(1500, 600), cfg({ timers: { battleTicks: 3600 } }))).toBe(247 + 5 * 148);
  });

  it('walls and factories price HP on their own curve: maxed = 2× linear, convex', () => {
    const w = computeCost(wall(7500), C.cost).breakdown.parts.maxHealth;
    expect(w.multiplier).toBeCloseTo(2, 9);
    const f = computeCost(factory(5000, 1800), C.cost).breakdown.parts.maxHealth;
    expect(f.multiplier).toBeCloseTo(2, 9);
    // Two 3750-HP walls cost less than one 7500-HP wall.
    expect(2 * cost(wall(3750))).toBeLessThan(cost(wall(7500)));
    let last = 0;
    let lastStep = 0;
    for (let hp = 500; hp <= 7500; hp += 500) {
      const raw = computeCost(wall(hp), C.cost).raw;
      if (hp > 500) expect(raw - last).toBeGreaterThan(lastStep - 1e-9);
      if (hp > 500) lastStep = raw - last;
      last = raw;
    }
  });

  it('walls and factories pay nothing for damage, range, speed, size, cooldown or the M8.8 multipliers', () => {
    for (const st of [wall(2000), factory(1500, 900)]) {
      const b = computeCost({ ...st, damage: 60, range: 300, speed: 5, attackCooldown: 10, size: 20, element: 'fire', splashRadius: 80, support: { kind: 'might', power: 50, range: 150 } }, C.cost).breakdown;
      expect(b.factor).toBe(1);
      expect(b.terms.damage + b.terms.range + b.terms.speed + b.terms.size + b.terms.heal).toBe(0);
      expect(b.cost).toBe(cost(st));
    }
    expect(sizeOf({ type: 'wall', size: 6 })).toBe(20);
    expect(sizeOf({ type: 'factory', size: 6 })).toBe(18);
  });

  it('re-pricing: factories follow the soldier coefficients, the minion stats, the element factors and the discount', () => {
    const base = cost(factory(1500, 900));
    expect(cost(factory(1500, 900), cfg({ cost: { speed: 120 } }))).toBeGreaterThan(base);
    expect(cost(factory(1500, 900), cfg({ factory: { minions: { grunt: { maxHealth: 400 } } } }))).toBeGreaterThan(base);
    expect(cost(factory(1500, 900), cfg({ cost: { factory: { minionDiscount: 1 } } }))).toBe(247 + 5 * 296);
    const fireGrunts = { ...factory(1500, 900), minionElement: 'fire' as const };
    expect(cost(fireGrunts)).toBe(1137);
    expect(cost(fireGrunts, cfg({ cost: { element: { fire: 1.5 } } }))).toBeGreaterThan(1137);
    expect(cost(factory(3000, 600), cfg({ cost: { factory: { minionDiscount: 1 } } }))).toBeGreaterThan(C.caps.unitCost);
    // Soldier and tower prices are unchanged by the building coefficients.
    const soldier: CostStats = { type: 'soldier', maxHealth: 600, damage: 50, range: 40, speed: 1.5, attackCooldown: 60, size: 10 };
    expect(cost(soldier, cfg({ cost: { wall: { hp: 1 }, factory: { hp: 1 } } }))).toBe(529);
  });
});

describe('§7 per-type stat guards', () => {
  const b = C.stats.bounds;
  const W = { name: 'Basic Wall', type: 'wall', maxHealth: 2000, color: '#8A8F98' };
  const F = { name: 'Basic Factory', type: 'factory', maxHealth: 1500, productionInterval: 900, color: '#C0A060' };
  const codes = (r: ReturnType<typeof checkStats>) => (r.ok ? [] : r.errors.map((e) => `${e.code}:${e.field}`));

  it('a wall needs only name, type, maxHealth and color; the snapshot fills the rest', () => {
    const r = checkStats(W, b);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stats).toEqual({ ...W, damage: 0, range: 0, speed: 0, attackCooldown: 0, size: 20, shape: 'square', element: 'normal', splashRadius: 0, support: null });
    expect(r.warnings).toEqual([]);
    expect(Object.isFrozen(r.stats)).toBe(true);
  });

  it('a factory needs productionInterval (integer, 600-1800) and is always size 18', () => {
    const r = checkStats(F, b);
    expect(r.ok && r.stats).toMatchObject({ productionInterval: 900, size: 18, damage: 0 });
    expect(codes(checkStats({ ...F, productionInterval: undefined }, b))).toEqual(['STAT_MISSING:productionInterval']);
    const missing = checkStats({ ...F, productionInterval: undefined }, b);
    expect(!missing.ok && missing.errors[0]!.fix).toContain('Try 900');
    expect(codes(checkStats({ ...F, productionInterval: 599 }, b))).toEqual(['STAT_OUT_OF_RANGE:productionInterval']);
    expect(codes(checkStats({ ...F, productionInterval: 1801 }, b))).toEqual(['STAT_OUT_OF_RANGE:productionInterval']);
    expect(codes(checkStats({ ...F, productionInterval: 900.5 }, b))).toEqual(['INTERVAL_NOT_INTEGER:productionInterval']);
  });

  it('wall and factory HP have their own ranges', () => {
    expect(codes(checkStats({ ...W, maxHealth: 249 }, b))).toEqual(['STAT_OUT_OF_RANGE:maxHealth']);
    expect(codes(checkStats({ ...W, maxHealth: 7501 }, b))).toEqual(['STAT_OUT_OF_RANGE:maxHealth']);
    expect(checkStats({ ...W, maxHealth: 7500 }, b).ok).toBe(true);
    expect(codes(checkStats({ ...F, maxHealth: 499 }, b))).toEqual(['STAT_OUT_OF_RANGE:maxHealth']);
    expect(codes(checkStats({ ...F, maxHealth: 5001 }, b))).toEqual(['STAT_OUT_OF_RANGE:maxHealth']);
    // Soldiers keep the 50-2500 bound.
    expect(codes(checkStats({ name: 'X', type: 'soldier', maxHealth: 2501, damage: 1, range: 20, speed: 1, attackCooldown: 60, color: '#000000' }, b))).toEqual([
      'STAT_OUT_OF_RANGE:maxHealth',
    ]);
  });

  it("buildings can't attack or move; fields they don't use are ignored with W_STAT_IGNORED", () => {
    expect(codes(checkStats({ ...W, damage: 5 }, b))).toEqual(['BUILDING_CANNOT_ATTACK:damage']);
    expect(codes(checkStats({ ...F, speed: 1 }, b))).toEqual(['BUILDING_CANNOT_MOVE:speed']);
    expect(checkStats({ ...W, damage: 0, speed: 0 }, b).ok).toBe(true);
    const r = checkStats({ ...W, range: 100, attackCooldown: 60, size: 10, productionInterval: 900 }, b);
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => `${w.code}:${w.field}`)).toEqual([
      'W_STAT_IGNORED:range',
      'W_STAT_IGNORED:attackCooldown',
      'W_STAT_IGNORED:size',
      'W_STAT_IGNORED:productionInterval',
    ]);
    expect(r.ok && r.stats).toMatchObject({ range: 0, attackCooldown: 0, size: 20 });
    expect(r.ok && 'productionInterval' in r.stats).toBe(false);
    const s = checkStats({ name: 'S', type: 'soldier', maxHealth: 500, damage: 1, range: 20, speed: 1, attackCooldown: 60, color: '#000000', productionInterval: 900 }, b);
    expect(s.ok && s.warnings.map((w) => w.code)).toEqual(['W_STAT_IGNORED']);
    expect(s.ok && 'productionInterval' in s.stats).toBe(false);
  });

  it('an unknown type lists all four types', () => {
    const r = checkStats({ ...W, type: 'castle' }, b);
    expect(!r.ok && r.errors[0]!.allowed).toEqual({ oneOf: ['soldier', 'tower', 'wall', 'factory'] });
  });
});

describe('config (§9.3 config additions)', () => {
  it('has the M8.5 defaults and config/default.json mirrors them', () => {
    expect(C.caps).toMatchObject({ maxUnitTypes: 4, maxBuildingTypes: 4, maxCopies: 12, maxFactoryCopies: 2, maxWallCopies: 12 });
    expect('maxTypes' in C.caps).toBe(false);
    expect(C.factory).toMatchObject({ maxMinionsPerFactory: 8, maxAlivePerFactory: 4, maxAlivePerPlayer: 6, maxAlivePerBattle: 40 });
    expect(C.sim.slideMemoryTicks).toBe(45);
    const json = JSON.parse(readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'));
    expect(json).toEqual(C);
  });

  it('keeps the minion inside the soldier bounds', () => {
    expect(safeParseConfig({ factory: { minion: { speed: 6 } } }).success).toBe(false);
    expect(safeParseConfig({ factory: { minion: { maxHealth: 5 } } }).success).toBe(false);
    expect(safeParseConfig({ factory: { minion: { maxHealth: 300 } } }).success).toBe(true);
    expect(safeParseConfig({ cost: { factory: { minionDiscount: 0 } } }).success).toBe(false);
  });

  it('drops the old caps.maxTypes from older config files', () => {
    const r = safeParseConfig({ caps: { maxTypes: 3, budget: 4500 } });
    expect(r.success).toBe(true);
    expect(r.success && r.data.caps).toMatchObject({ budget: 4500, maxUnitTypes: 4, maxBuildingTypes: 4 });
    expect(r.success && 'maxTypes' in r.data.caps).toBe(false);
  });
});

describe('W_TRAPPED: trappedCells (§9.3 Placement check)', () => {
  const types: Record<string, UnitType> = { w: 'wall', s: 'soldier', t: 'tower', f: 'factory' };
  const typeOf = (id: string) => types[id];
  // Duel: zone 0 is the top-left corner zone (two of its sides are the arena edge).
  const zone = mapFor('duel', 2).zones[0]!;
  const ring = (n: number, unitId = 'w') => {
    const out = [];
    for (let row = 0; row < n; row++) for (let col = 0; col < n; col++) if (row === n - 1 || col === n - 1) out.push({ unitId, col, row });
    return out;
  };

  it('a soldier sealed in by an L of walls in a corner zone is trapped; a tower never is', () => {
    const placed = [...ring(3), { unitId: 's', col: 0, row: 0 }, { unitId: 't', col: 1, row: 1 }, { unitId: 'f', col: 1, row: 0 }];
    // (0,0) is the front cell nearest the centre: the L at row 2 / col 2 does NOT seal it from the centre side.
    const trapped = trappedCells(zone, placed, typeOf);
    // Whether this L seals depends on which zone edges are arena edges; check the flood fill both ways.
    const front = trappedCells(zone, [{ unitId: 's', col: 0, row: 0 }], typeOf);
    expect(front).toEqual([]);
    expect(trapped.every((p) => p.unitId !== 't')).toBe(true);
  });

  it('a full ring of walls traps what is inside; a one-cell gap frees it', () => {
    const box = [];
    for (let row = 1; row <= 3; row++) for (let col = 1; col <= 3; col++) if (row !== 2 || col !== 2) box.push({ unitId: 'w', col, row });
    const inside = { unitId: 's', col: 2, row: 2 };
    expect(trappedCells(zone, [...box, inside], typeOf)).toEqual([inside]);
    const gate = box.filter((p) => !(p.col === 2 && p.row === 1));
    expect(trappedCells(zone, [...gate, inside], typeOf)).toEqual([]);
    expect(trappedCells(zone, [...box, { unitId: 't', col: 2, row: 2 }], typeOf)).toEqual([]);
    expect(trappedCells(zone, [...box, { unitId: 'f', col: 2, row: 2 }], typeOf)).toEqual([{ unitId: 'f', col: 2, row: 2 }]);
  });

  it('the arena edge is not an exit', () => {
    // Corner zone: the far row and far column touch the arena edge. Walls on the
    // other two sides of the far corner cell seal it.
    const far = { unitId: 's', col: 5, row: 5 };
    const walls = [
      { unitId: 'w', col: 4, row: 5 },
      { unitId: 'w', col: 5, row: 4 },
    ];
    expect(trappedCells(zone, [...walls, far], typeOf)).toEqual([far]);
  });
});

describe('the built-in minion sprite', () => {
  it('is a valid 12×12 sprite and tints with the factory colour', () => {
    const s = minionSprite('#33CC66');
    expect(s.grid).toBe(12);
    expect(s.palette.b).toBe('#33CC66');
    expect(checkSprite(s).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// M8.6: minion kinds and burst (§5.3, §6 Minion kinds)
// ---------------------------------------------------------------------------

describe('§6 minion kinds and factory prices (M8.6)', () => {
  const kindFactory = (hp: number, interval: number, produces?: 'grunt' | 'archer' | 'runner' | 'brute' | 'medic'): CostStats => ({
    ...factory(hp, interval),
    ...(produces ? { produces } : {}),
  });

  it('each kind is priced as a soldier: grunt $296/$148, archer $389/$195, runner $369/$185, brute $426/$213, medic $418/$209', () => {
    const P = pricingOf(C);
    expect(minionPrice(C.cost, P, 'grunt')).toEqual({ minionCost: 296, minionValue: 148 });
    expect(minionPrice(C.cost, P, 'archer')).toEqual({ minionCost: 389, minionValue: 195 });
    expect(minionPrice(C.cost, P, 'runner')).toEqual({ minionCost: 369, minionValue: 185 });
    expect(minionPrice(C.cost, P, 'brute')).toEqual({ minionCost: 426, minionValue: 213 });
    expect(minionPrice(C.cost, P, 'medic')).toEqual({ minionCost: 418, minionValue: 209 });
    expect(minionPrice(C.cost, P, 'medic', 'fire')).toEqual({ minionCost: 418, minionValue: 209 });
  });

  it.each([
    ['Basic Factory (produces omitted)', 1500, 900, undefined, 987],
    ['Archer Factory', 1500, 900, 'archer', 1222],
    ['Runner Factory', 1500, 900, 'runner', 1172],
    ['Brute Factory', 1500, 900, 'brute', 1312],
    ['Swarm Factory', 1500, 600, 'grunt', 1431],
    ['Archer Nest', 1500, 600, 'archer', 1807],
    ['Runner Rush', 1500, 600, 'runner', 1727],
    ['Brute Forge', 1500, 600, 'brute', 1951],
    ['Medic Tent', 1500, 900, 'medic', 1292],
  ] as const)('%s: $%#', (_name, hp, interval, produces, expected) => {
    expect(cost(kindFactory(hp, interval, produces))).toBe(expected);
  });

  it('the production line names the kind; burst never changes the price', () => {
    const b = computeCost(kindFactory(1500, 900, 'archer'), C.cost, pricingOf(C)).breakdown;
    expect(b.production).toMatchObject({ kind: 'archer', minionCost: 389, minionValue: 195, expected: 5, total: 975 });
    expect(b.production!.text).toBe('Production: 5 archers × $195 (half of a $389 archer, because they arrive during the battle) = $975');
    const withBurst = { ...kindFactory(1500, 900, 'archer'), burst: 4 } as CostStats;
    expect(cost(withBurst)).toBe(1222);
  });

  it('a kind retune re-prices only the factories of that kind', () => {
    const tuned = cfg({ factory: { minions: { runner: { speed: 2 } } } });
    expect(cost(kindFactory(1500, 900, 'runner'), tuned)).toBeLessThan(1172);
    expect(cost(kindFactory(1500, 900), tuned)).toBe(987);
    expect(cost(kindFactory(1500, 900, 'archer'), tuned)).toBe(1222);
  });

  it('a too-expensive non-grunt factory also suggests making grunts', () => {
    // Production (8 brutes, $1,704) is the bigger cost here (body 4000 HP: $838).
    const s = kindFactory(4000, 600, 'brute');
    const r = computeCost(s, C.cost, pricingOf(C));
    expect(r.cost).toBeGreaterThan(C.caps.unitCost);
    const e = tooExpensiveError(s, r, C.caps.unitCost, C.cost, C.stats.bounds, pricingOf(C));
    expect(e.fix).toMatch(/Making grunts instead of brutes \(this\.produces = 'grunt'\) saves \$520 \(\$\d+\)/);
  });

  it('config: an old factory.minion patch migrates to the grunt; kinds stay legal soldiers; burst.max <= maxAlivePerFactory', () => {
    const migrated = safeParseConfig({ factory: { minion: { maxHealth: 60 } } });
    expect(migrated.success).toBe(true);
    expect(migrated.success && migrated.data.factory.minions.grunt.maxHealth).toBe(60);
    expect(migrated.success && migrated.data.factory.minions.archer.maxHealth).toBe(120);
    // M8.8: the medic stays a pure healer inside the heal support bounds.
    expect(safeParseConfig({ factory: { minions: { medic: { damage: 5 } } } }).success).toBe(false);
    expect(safeParseConfig({ factory: { minions: { medic: { heal: 300 } } } }).success).toBe(false);
    expect(safeParseConfig({ factory: { minions: { medic: { reach: 10 } } } }).success).toBe(false);
    expect(safeParseConfig({ factory: { minions: { brute: { speed: 6 } } } }).success).toBe(false);
    expect(safeParseConfig({ factory: { minions: { archer: { range: 400 } } } }).success).toBe(false);
    expect(safeParseConfig({ factory: { minions: { brute: { wallDamageMultiplier: 9 } } } }).success).toBe(false);
    expect(safeParseConfig({ stats: { bounds: { burst: { min: 1, max: 5 } } } }).success).toBe(false);
    expect(safeParseConfig({ stats: { bounds: { burst: { min: 1, max: 5 } } }, factory: { maxAlivePerFactory: 5 } }).success).toBe(true);
    expect(safeParseConfig({ stats: { bounds: { burst: { min: 0, max: 3 } } } }).success).toBe(false);
  });

  it('checkStats: produces and burst defaults, errors and ignored fields', () => {
    const B = C.stats.bounds;
    const base = { name: 'F', type: 'factory', maxHealth: 1500, productionInterval: 900, color: '#C0A060' };
    const ok = checkStats(base, B);
    expect(ok.ok && ok.stats).toMatchObject({ produces: 'grunt', burst: 1, minionElement: 'normal' });
    const archer = checkStats({ ...base, produces: 'archer', burst: 3 }, B);
    expect(archer.ok && archer.stats).toMatchObject({ produces: 'archer', burst: 3 });
    const bad = (raw: Record<string, unknown>) => {
      const r = checkStats({ ...base, ...raw }, B);
      if (r.ok) throw new Error('expected errors');
      return r.errors[0]!;
    };
    expect(bad({ produces: 'archers' })).toMatchObject({ code: 'STAT_OUT_OF_RANGE', field: 'produces', allowed: { oneOf: ['grunt', 'archer', 'runner', 'brute', 'medic'] } });
    expect(bad({ produces: 'archers' }).fix).toContain("this.produces = 'archer'");
    expect(bad({ produces: 'Knight' }).fix).toContain("this.produces = 'brute'");
    expect(bad({ produces: 3 })).toMatchObject({ code: 'STAT_WRONG_TYPE', field: 'produces' });
    expect(bad({ burst: 0 })).toMatchObject({ code: 'STAT_OUT_OF_RANGE', field: 'burst', allowed: { min: 1, max: 4 } });
    expect(bad({ burst: 5 })).toMatchObject({ code: 'STAT_OUT_OF_RANGE', field: 'burst' });
    expect(bad({ burst: 2.5 })).toMatchObject({ code: 'BURST_NOT_INTEGER', field: 'burst' });
    expect(bad({ burst: '3' })).toMatchObject({ code: 'STAT_WRONG_TYPE', field: 'burst' });
    const soldier = checkStats({ name: 'S', type: 'soldier', maxHealth: 500, damage: 5, range: 30, speed: 1, attackCooldown: 60, color: '#112233', produces: 'archer', burst: 2 }, B);
    expect(soldier.ok).toBe(true);
    expect(soldier.warnings.map((w) => [w.code, w.field])).toEqual([['W_STAT_IGNORED', 'produces'], ['W_STAT_IGNORED', 'burst']]);
    expect(soldier.ok && 'produces' in soldier.stats).toBe(false);
  });

  it('every kind has its own 12×12 sprite, valid and tinted with the factory colour', () => {
    const looks = (['grunt', 'archer', 'runner', 'brute', 'medic'] as const).map((k) => minionSprite('#33AA55', k));
    for (const l of looks) {
      expect(checkSprite(l).ok).toBe(true);
      expect(l.palette.b).toBe('#33AA55');
    }
    expect(new Set(looks.map((l) => JSON.stringify(l.frames.idle))).size).toBe(5);
  });
});
