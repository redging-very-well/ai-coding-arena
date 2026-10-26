// Walls and factories in shared (M8.5; numbers of the $10,000 redesign): the
// reference price tables, the
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

const REF = readFileSync(new URL('./fixtures/economy-reference.md', import.meta.url), 'utf8');
/** The rows of the reference table that follows `marker` inside "Reference walls, minions and factories (curve k = 1)". */
function refTable(marker: string): string[][] {
  const section = REF.slice(REF.indexOf('### Reference walls, minions and factories (curve k = 1)'));
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

describe('reference walls, minions and factories (curve k = 1)', () => {
  it('every wall row of the reference table: linear, curve, raw and cost', () => {
    const rows = refTable('Walls, `raw =');
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
    const rows = refTable('Minions are priced with the soldier formula');
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

  it('every factory row: body raw, body, production and cost (the three over $3,000 are rejected)', () => {
    const rows = refTable('Factories:');
    expect(rows.length).toBe(19);
    expect(rows.filter((r) => /rejected/.test(r[9]!)).length).toBe(3);
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
    const st = { ...factory(1200, 300), produces: 'runner' as const, minionElement: 'lightning' as const };
    const r = computeCost(st, C.cost);
    expect(r.cost).toBe(5342);
    // The production ($4,092) is bigger than the body's HP term ($1,200): raise the interval, or make cheaper minions.
    const fix = tooExpensiveError(st, r, C.caps.unitCost, C.cost, C.stats.bounds).fix;
    expect(fix).toMatch(/^Cost is \$5,342 but the max is \$3,000\. The production \(12 lightning runners × \$341\) is the biggest cost: raising productionInterval from 300 to \d+/);
    expect(fix).toContain("Making grunts instead of runners (this.produces = 'grunt') saves");
    expect(fix).toContain('Normal minions instead of lightning ones save $');
    // A fortress body is the bigger lever when the production is small.
    const body = factory(1200, 1200);
    const rb = computeCost(body, cfg({ cost: { factory: { hp: 2 } } }).cost);
    expect(tooExpensiveError(body, rb, C.caps.unitCost, cfg({ cost: { factory: { hp: 2 } } }).cost, C.stats.bounds).fix).toMatch(/most expensive stat is maxHealth/);
  });

  it('the grunt is a $353 soldier, so a factory pays $177 per expected minion', () => {
    expect(minionPrice(C.cost)).toEqual({ minionCost: 353, minionValue: 177 });
    const b = computeCost(factory(360, 900), C.cost).breakdown;
    expect(b.formula).toBe('factory');
    expect(b.body).toBe(247);
    expect(b.production).toMatchObject({ interval: 900, minionCost: 353, minionValue: 177, expected: 7, total: 1239, element: 'normal' });
    expect(b.production!.text).toBe('Production: 7 minions × $177 (half of a $353 minion, because they arrive during the battle) = $1,239');
    const fire = computeCost({ ...factory(360, 900), produces: 'brute', minionElement: 'fire' }, C.cost).breakdown;
    expect(fire.production!.text).toBe('Production: 7 fire brutes × $342 (half of a $683 fire brute, because they arrive during the battle) = $2,394');
  });

  it('E = min(12, floor((battleTicks − 1) / interval)) and follows the battle length', () => {
    expect([300, 599, 600, 720, 900, 1200].map((i) => expectedMinions(i))).toEqual([12, 12, 11, 9, 7, 5]);
    const short = pricingOf(cfg({ timers: { battleTicks: 3600 } }));
    expect(expectedMinions(600, short)).toBe(5);
    expect(cost(factory(360, 600), cfg({ timers: { battleTicks: 3600 } }))).toBe(247 + 5 * 177);
  });

  it('walls and factories price HP on their own curve: maxed = 2× linear, convex', () => {
    const w = computeCost(wall(12000), C.cost).breakdown.parts.maxHealth;
    expect(w.multiplier).toBeCloseTo(2, 9);
    const f = computeCost(factory(1200, 1200), C.cost).breakdown.parts.maxHealth;
    expect(f.multiplier).toBeCloseTo(2, 9);
    // Two 6000-HP walls cost less than one 12000-HP wall.
    expect(2 * cost(wall(6000))).toBe(604);
    expect(2 * cost(wall(6000))).toBeLessThan(cost(wall(12000)));
    let last = 0;
    let lastStep = 0;
    for (let hp = 400; hp <= 12000; hp += 400) {
      const raw = computeCost(wall(hp), C.cost).raw;
      if (hp > 400) expect(raw - last).toBeGreaterThan(lastStep - 1e-9);
      if (hp > 400) lastStep = raw - last;
      last = raw;
    }
  });

  it('walls and factories pay nothing for damage, range, speed, size, cooldown or the M8.8 multipliers', () => {
    for (const st of [wall(3200), factory(360, 900)]) {
      const b = computeCost({ ...st, damage: 60, range: 300, speed: 5, attackCooldown: 10, size: 20, element: 'fire', splashRadius: 80, support: { kind: 'might', power: 50, range: 150 } }, C.cost).breakdown;
      expect(b.factor).toBe(1);
      expect(b.terms.damage + b.terms.range + b.terms.speed + b.terms.size + b.terms.heal).toBe(0);
      expect(b.cost).toBe(cost(st));
    }
    expect(sizeOf({ type: 'wall', size: 6 })).toBe(20);
    expect(sizeOf({ type: 'factory', size: 6 })).toBe(18);
  });

  it('re-pricing: factories follow the soldier coefficients, the minion stats, the element factors and the discount', () => {
    const base = cost(factory(360, 900));
    expect(base).toBe(1486);
    expect(cost(factory(360, 900), cfg({ cost: { speed: 120 } }))).toBeGreaterThan(base);
    expect(cost(factory(360, 900), cfg({ factory: { minions: { grunt: { maxHealth: 600 } } } }))).toBeGreaterThan(base);
    expect(cost(factory(360, 900), cfg({ cost: { factory: { minionDiscount: 1 } } }))).toBe(247 + 7 * 353);
    const fireGrunts = { ...factory(360, 900), minionElement: 'fire' as const };
    expect(cost(fireGrunts)).toBe(1850);
    expect(cost(fireGrunts, cfg({ cost: { element: { fire: 1.5 } } }))).toBeGreaterThan(1850);
    expect(cost(factory(360, 600), cfg({ cost: { factory: { minionDiscount: 1 } } }))).toBeGreaterThan(C.caps.unitCost);
    // Soldier and tower prices are unchanged by the building coefficients.
    const soldier: CostStats = { type: 'soldier', maxHealth: 1400, damage: 56, range: 40, speed: 1.5, attackCooldown: 60, size: 10 };
    expect(cost(soldier, cfg({ cost: { wall: { hp: 1 }, factory: { hp: 1 } } }))).toBe(807);
  });
});

describe('per-type stat guards', () => {
  const b = C.stats.bounds;
  const W = { name: 'Basic Wall', type: 'wall', maxHealth: 2000, color: '#8A8F98' };
  const F = { name: 'Basic Factory', type: 'factory', maxHealth: 360, productionInterval: 900, color: '#C0A060' };
  const codes = (r: ReturnType<typeof checkStats>) => (r.ok ? [] : r.errors.map((e) => `${e.code}:${e.field}`));

  it('a wall needs only name, type, maxHealth and color; the snapshot fills the rest', () => {
    const r = checkStats(W, b);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stats).toEqual({ ...W, damage: 0, range: 0, speed: 0, attackCooldown: 0, size: 20, shape: 'square', element: 'normal', splashRadius: 0, support: null });
    expect(r.warnings).toEqual([]);
    expect(Object.isFrozen(r.stats)).toBe(true);
  });

  it('a factory needs productionInterval (integer, 300-1200) and is always size 18', () => {
    const r = checkStats(F, b);
    expect(r.ok && r.stats).toMatchObject({ productionInterval: 900, size: 18, damage: 0 });
    expect(codes(checkStats({ ...F, productionInterval: undefined }, b))).toEqual(['STAT_MISSING:productionInterval']);
    const missing = checkStats({ ...F, productionInterval: undefined }, b);
    expect(!missing.ok && missing.errors[0]!.fix).toContain('Try 900');
    expect(codes(checkStats({ ...F, productionInterval: 299 }, b))).toEqual(['STAT_OUT_OF_RANGE:productionInterval']);
    expect(codes(checkStats({ ...F, productionInterval: 1201 }, b))).toEqual(['STAT_OUT_OF_RANGE:productionInterval']);
    expect(codes(checkStats({ ...F, productionInterval: 900.5 }, b))).toEqual(['INTERVAL_NOT_INTEGER:productionInterval']);
  });

  it('wall and factory HP have their own ranges', () => {
    expect(codes(checkStats({ ...W, maxHealth: 399 }, b))).toEqual(['STAT_OUT_OF_RANGE:maxHealth']);
    expect(codes(checkStats({ ...W, maxHealth: 12001 }, b))).toEqual(['STAT_OUT_OF_RANGE:maxHealth']);
    expect(checkStats({ ...W, maxHealth: 12000 }, b).ok).toBe(true);
    expect(codes(checkStats({ ...F, maxHealth: 119 }, b))).toEqual(['STAT_OUT_OF_RANGE:maxHealth']);
    expect(codes(checkStats({ ...F, maxHealth: 1201 }, b))).toEqual(['STAT_OUT_OF_RANGE:maxHealth']);
    expect(checkStats({ ...F, maxHealth: 1200 }, b).ok).toBe(true);
    // Soldiers keep the 80-4000 bound.
    expect(codes(checkStats({ name: 'X', type: 'soldier', maxHealth: 4001, damage: 1, range: 20, speed: 1, attackCooldown: 60, color: '#000000' }, b))).toEqual([
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

describe('config', () => {
  it('has the redesign defaults and config/default.json mirrors them', () => {
    expect(C.caps).toMatchObject({ maxUnitTypes: 4, maxBuildingTypes: 4, maxCopies: 12, maxFactoryCopies: 5, maxWallCopies: 16 });
    expect('maxTypes' in C.caps).toBe(false);
    expect(C.factory).toMatchObject({ maxMinionsPerFactory: 12, maxAlivePerFactory: 4, maxAlivePerPlayer: 12, maxAlivePerBattle: 40 });
    expect(C.sim.slideMemoryTicks).toBe(45);
    const json = JSON.parse(readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'));
    expect(json).toEqual(C);
  });

  it('keeps the minion inside the soldier bounds', () => {
    expect(safeParseConfig({ factory: { minion: { speed: 6 } } }).success).toBe(false);
    expect(safeParseConfig({ factory: { minion: { maxHealth: 50 } } }).success).toBe(false);
    expect(safeParseConfig({ factory: { minion: { maxHealth: 300 } } }).success).toBe(true);
    expect(safeParseConfig({ cost: { factory: { minionDiscount: 0 } } }).success).toBe(false);
  });

  it('drops the old caps.maxTypes from older config files', () => {
    const r = safeParseConfig({ caps: { maxTypes: 3, budget: 9000 } });
    expect(r.success).toBe(true);
    expect(r.success && r.data.caps).toMatchObject({ budget: 9000, maxUnitTypes: 4, maxBuildingTypes: 4 });
    expect(r.success && 'maxTypes' in r.data.caps).toBe(false);
  });
});

describe('W_TRAPPED: trappedCells', () => {
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
// M8.6: minion kinds and burst
// ---------------------------------------------------------------------------

describe('minion kinds and factory prices (M8.6)', () => {
  const kindFactory = (hp: number, interval: number, produces?: 'grunt' | 'archer' | 'runner' | 'brute' | 'medic'): CostStats => ({
    ...factory(hp, interval),
    ...(produces ? { produces } : {}),
  });

  it('each kind is priced as a soldier: grunt $353/$177, archer $432/$216, runner $525/$263, brute $526/$263, medic $496/$248', () => {
    const P = pricingOf(C);
    expect(minionPrice(C.cost, P, 'grunt')).toEqual({ minionCost: 353, minionValue: 177 });
    expect(minionPrice(C.cost, P, 'archer')).toEqual({ minionCost: 432, minionValue: 216 });
    expect(minionPrice(C.cost, P, 'runner')).toEqual({ minionCost: 525, minionValue: 263 });
    expect(minionPrice(C.cost, P, 'brute')).toEqual({ minionCost: 526, minionValue: 263 });
    expect(minionPrice(C.cost, P, 'medic')).toEqual({ minionCost: 496, minionValue: 248 });
    expect(minionPrice(C.cost, P, 'medic', 'fire')).toEqual({ minionCost: 496, minionValue: 248 });
  });

  it.each([
    ['Basic Factory (produces omitted)', 360, 600, undefined, 2194],
    ['Steady Factory', 360, 900, 'grunt', 1486],
    ['Steady Archers', 360, 900, 'archer', 1759],
    ['Steady Runners', 360, 900, 'runner', 2088],
    ['Steady Brutes', 360, 900, 'brute', 2088],
    ['Swarm Factory', 360, 300, 'grunt', 2371],
    ['Archer Nest', 360, 300, 'archer', 2839],
    ['Runner Rush', 360, 720, 'runner', 2614],
    ['Brute Forge', 360, 720, 'brute', 2614],
    ['Medic Tent', 360, 600, 'medic', 2975],
    ['Steady Medics', 360, 900, 'medic', 1983],
  ] as const)('%s: $%#', (_name, hp, interval, produces, expected) => {
    expect(cost(kindFactory(hp, interval, produces))).toBe(expected);
  });

  it('the production line names the kind; burst never changes the price', () => {
    const b = computeCost(kindFactory(360, 900, 'archer'), C.cost, pricingOf(C)).breakdown;
    expect(b.production).toMatchObject({ kind: 'archer', minionCost: 432, minionValue: 216, expected: 7, total: 1512 });
    expect(b.production!.text).toBe('Production: 7 archers × $216 (half of a $432 archer, because they arrive during the battle) = $1,512');
    const withBurst = { ...kindFactory(360, 900, 'archer'), burst: 4 } as CostStats;
    expect(cost(withBurst)).toBe(1759);
  });

  it('a kind retune re-prices only the factories of that kind', () => {
    const tuned = cfg({ factory: { minions: { runner: { speed: 2 } } } });
    expect(cost(kindFactory(360, 900, 'runner'), tuned)).toBeLessThan(2088);
    expect(cost(kindFactory(360, 900), tuned)).toBe(1486);
    expect(cost(kindFactory(360, 900, 'archer'), tuned)).toBe(1759);
  });

  it('a too-expensive non-grunt factory also suggests making grunts', () => {
    // Production (12 brutes, $3,156) is the bigger cost here (body 720 HP: $490).
    const s = kindFactory(720, 300, 'brute');
    const r = computeCost(s, C.cost, pricingOf(C));
    expect(r.cost).toBe(3696);
    expect(r.cost).toBeGreaterThan(C.caps.unitCost);
    const e = tooExpensiveError(s, r, C.caps.unitCost, C.cost, C.stats.bounds, pricingOf(C));
    expect(e.fix).toMatch(/Making grunts instead of brutes \(this\.produces = 'grunt'\) saves \$1,032 \(\$2,664\)/);
  });

  it('config: an old factory.minion patch migrates to the grunt; kinds stay legal soldiers; burst.max <= maxAlivePerFactory', () => {
    const migrated = safeParseConfig({ factory: { minion: { maxHealth: 100 } } });
    expect(migrated.success).toBe(true);
    expect(migrated.success && migrated.data.factory.minions.grunt.maxHealth).toBe(100);
    expect(migrated.success && migrated.data.factory.minions.archer.maxHealth).toBe(240);
    // M8.8: the medic stays a pure healer inside the heal support bounds.
    expect(safeParseConfig({ factory: { minions: { medic: { damage: 5 } } } }).success).toBe(false);
    expect(safeParseConfig({ factory: { minions: { medic: { heal: 500 } } } }).success).toBe(false);
    expect(safeParseConfig({ factory: { minions: { medic: { reach: 10 } } } }).success).toBe(false);
    expect(safeParseConfig({ factory: { minions: { brute: { speed: 6 } } } }).success).toBe(false);
    expect(safeParseConfig({ factory: { minions: { archer: { range: 200 } } } }).success).toBe(false); // soldiers stop at 160
    expect(safeParseConfig({ factory: { minions: { brute: { wallDamageMultiplier: 9 } } } }).success).toBe(false);
    expect(safeParseConfig({ stats: { bounds: { burst: { min: 1, max: 5 } } } }).success).toBe(false);
    expect(safeParseConfig({ stats: { bounds: { burst: { min: 1, max: 5 } } }, factory: { maxAlivePerFactory: 5 } }).success).toBe(true);
    expect(safeParseConfig({ stats: { bounds: { burst: { min: 0, max: 3 } } } }).success).toBe(false);
  });

  it('checkStats: produces and burst defaults, errors and ignored fields', () => {
    const B = C.stats.bounds;
    const base = { name: 'F', type: 'factory', maxHealth: 360, productionInterval: 900, color: '#C0A060' };
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
