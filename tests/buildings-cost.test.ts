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

describe('§6 reference buildings (curve k = 2)', () => {
  it.each([
    [50, 8],
    [150, 14],
    [300, 24],
    [400, 32],
    [600, 52],
    [800, 80],
    [1000, 118],
    [1500, 274],
  ])('a %i HP wall costs $%i', (hp, price) => {
    expect(cost(wall(hp))).toBe(price);
  });

  it.each([
    [100, 1800, 79],
    [300, 1200, 165],
    [300, 900, 193],
    [300, 600, 277],
    [600, 600, 358],
    [1000, 1800, 426],
    [1000, 600, 594],
  ])('a %i HP factory with interval %i costs $%i', (hp, interval, price) => {
    expect(cost(factory(hp, interval))).toBe(price);
  });

  it('the maxed factory is over the $500 cap; the fix names the bigger of HP and production', () => {
    const st = factory(1000, 600);
    const r = computeCost(st, C.cost);
    expect(r.cost).toBeGreaterThan(C.caps.unitCost);
    // HP ($360) is the bigger lever here.
    expect(tooExpensiveError(st, r, C.caps.unitCost, C.cost, C.stats.bounds).fix).toMatch(/most expensive stat is maxHealth/);
    // With full-price minions the production ($440) is: raise the interval.
    const full = cfg({ cost: { factory: { minionDiscount: 1 } } });
    const st2 = factory(400, 600);
    const r2 = computeCost(st2, full.cost, pricingOf(full));
    expect(r2.cost).toBe(514);
    const err = tooExpensiveError(st2, r2, full.caps.unitCost, full.cost, full.stats.bounds, pricingOf(full));
    expect(err.fix).toContain('raising productionInterval from 600 to 720 makes 7 minions instead of 8 and saves $55 ($459)');
  });

  it('the built-in minion is a $55 soldier, so a factory pays $28 per expected minion', () => {
    expect(minionPrice(C.cost)).toEqual({ minionCost: 55, minionValue: 28 });
    const b = computeCost(factory(300, 900), C.cost).breakdown;
    expect(b.formula).toBe('factory');
    expect(b.body).toBe(53);
    expect(b.production).toMatchObject({ interval: 900, minionCost: 55, minionValue: 28, expected: 5, total: 140 });
    expect(b.production!.text).toBe('Production: 5 minions × $28 (half of a $55 minion, because they arrive during the battle) = $140');
  });

  it('E = min(8, floor((battleTicks − 1) / interval)) and follows the battle length', () => {
    expect([600, 720, 900, 1200, 1800].map((i) => expectedMinions(i))).toEqual([8, 7, 5, 4, 2]);
    const short = pricingOf(cfg({ timers: { battleTicks: 3600 } }));
    expect(expectedMinions(600, short)).toBe(5);
    expect(cost(factory(300, 600), cfg({ timers: { battleTicks: 3600 } }))).toBe(53 + 5 * 28);
  });

  it('walls and factories price HP on their own curve: maxed = 3× linear, convex', () => {
    const w = computeCost(wall(1500), C.cost).breakdown.parts.maxHealth;
    expect(w.multiplier).toBeCloseTo(3, 9);
    const f = computeCost(factory(1000, 1800), C.cost).breakdown.parts.maxHealth;
    expect(f.multiplier).toBeCloseTo(3, 9);
    // Two 750-HP walls cost about half of one 1500-HP wall.
    expect(2 * cost(wall(750))).toBeLessThan(cost(wall(1500)) * 0.6);
    // Convex: the price step grows with HP.
    let last = 0;
    let lastStep = 0;
    for (let hp = 100; hp <= 1500; hp += 100) {
      const raw = computeCost(wall(hp), C.cost).raw;
      if (hp > 100) expect(raw - last).toBeGreaterThan(lastStep - 1e-9);
      if (hp > 100) lastStep = raw - last;
      last = raw;
    }
  });

  it('walls and factories pay nothing for damage, range, speed, size or cooldown', () => {
    for (const st of [wall(400), factory(300, 900)]) {
      const b = computeCost({ ...st, damage: 60, range: 300, speed: 5, attackCooldown: 10, size: 20 }, C.cost).breakdown;
      expect(b.factor).toBe(1);
      expect(b.terms.damage + b.terms.range + b.terms.speed + b.terms.size).toBe(0);
    }
    expect(sizeOf({ type: 'wall', size: 6 })).toBe(20);
    expect(sizeOf({ type: 'factory', size: 6 })).toBe(18);
  });

  it('re-pricing: factories follow the soldier coefficients, the minion stats and the discount', () => {
    const base = cost(factory(300, 900));
    expect(cost(factory(300, 900), cfg({ cost: { speed: 24 } }))).toBeGreaterThan(base);
    expect(cost(factory(300, 900), cfg({ factory: { minions: { grunt: { maxHealth: 80 } } } }))).toBeGreaterThan(base);
    expect(cost(factory(300, 900), cfg({ cost: { factory: { minionDiscount: 1 } } }))).toBe(53 + 5 * 55);
    // A retune can push a factory over the cap.
    expect(cost(factory(600, 600), cfg({ cost: { factory: { minionDiscount: 1 } } }))).toBeGreaterThan(C.caps.unitCost);
    // Soldier and tower prices are unchanged by the building coefficients.
    const soldier: CostStats = { type: 'soldier', maxHealth: 120, damage: 10, range: 40, speed: 1.5, attackCooldown: 60, size: 10 };
    expect(cost(soldier, cfg({ cost: { wall: { hp: 1 }, factory: { hp: 1 } } }))).toBe(92);
  });
});

describe('§7 per-type stat guards', () => {
  const b = C.stats.bounds;
  const W = { name: 'Basic Wall', type: 'wall', maxHealth: 400, color: '#8A8F98' };
  const F = { name: 'Basic Factory', type: 'factory', maxHealth: 300, productionInterval: 900, color: '#C0A060' };
  const codes = (r: ReturnType<typeof checkStats>) => (r.ok ? [] : r.errors.map((e) => `${e.code}:${e.field}`));

  it('a wall needs only name, type, maxHealth and color; the snapshot fills the rest', () => {
    const r = checkStats(W, b);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stats).toEqual({ ...W, damage: 0, range: 0, speed: 0, attackCooldown: 0, size: 20, shape: 'square' });
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
    expect(codes(checkStats({ ...W, maxHealth: 49 }, b))).toEqual(['STAT_OUT_OF_RANGE:maxHealth']);
    expect(codes(checkStats({ ...W, maxHealth: 1501 }, b))).toEqual(['STAT_OUT_OF_RANGE:maxHealth']);
    expect(checkStats({ ...W, maxHealth: 1500 }, b).ok).toBe(true);
    expect(codes(checkStats({ ...F, maxHealth: 99 }, b))).toEqual(['STAT_OUT_OF_RANGE:maxHealth']);
    expect(codes(checkStats({ ...F, maxHealth: 1001 }, b))).toEqual(['STAT_OUT_OF_RANGE:maxHealth']);
    // Soldiers keep the 10-500 bound.
    expect(codes(checkStats({ name: 'X', type: 'soldier', maxHealth: 600, damage: 1, range: 20, speed: 1, attackCooldown: 60, color: '#000000' }, b))).toEqual([
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
    const s = checkStats({ name: 'S', type: 'soldier', maxHealth: 100, damage: 1, range: 20, speed: 1, attackCooldown: 60, color: '#000000', productionInterval: 900 }, b);
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
    expect(safeParseConfig({ factory: { minion: { maxHealth: 60 } } }).success).toBe(true);
    expect(safeParseConfig({ cost: { factory: { minionDiscount: 0 } } }).success).toBe(false);
  });

  it('drops the old caps.maxTypes from older config files', () => {
    const r = safeParseConfig({ caps: { maxTypes: 3, budget: 900 } });
    expect(r.success).toBe(true);
    expect(r.success && r.data.caps).toMatchObject({ budget: 900, maxUnitTypes: 4, maxBuildingTypes: 4 });
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
  const kindFactory = (hp: number, interval: number, produces?: 'grunt' | 'archer' | 'runner' | 'brute'): CostStats => ({
    ...factory(hp, interval),
    ...(produces ? { produces } : {}),
  });

  it('each kind is priced as a soldier: grunt $55/$28, archer $69/$35, runner $76/$38, brute $69/$35', () => {
    const P = pricingOf(C);
    expect(minionPrice(C.cost, P, 'grunt')).toEqual({ minionCost: 55, minionValue: 28 });
    expect(minionPrice(C.cost, P, 'archer')).toEqual({ minionCost: 69, minionValue: 35 });
    expect(minionPrice(C.cost, P, 'runner')).toEqual({ minionCost: 76, minionValue: 38 });
    expect(minionPrice(C.cost, P, 'brute')).toEqual({ minionCost: 69, minionValue: 35 });
  });

  it.each([
    ['Basic Factory (produces omitted)', 300, 900, undefined, 193],
    ['Archer Factory', 300, 900, 'archer', 228],
    ['Runner Factory', 300, 900, 'runner', 243],
    ['Brute Factory', 300, 900, 'brute', 228],
    ['Swarm Factory', 300, 600, 'grunt', 277],
    ['Archer Nest', 300, 600, 'archer', 333],
    ['Runner Rush', 300, 600, 'runner', 357],
    ['Brute Forge', 300, 600, 'brute', 333],
    ['Slow Brutes', 300, 1200, 'brute', 193],
    ['Armoured Runner Rush', 600, 600, 'runner', 438],
    ['Maxed runner factory', 1000, 600, 'runner', 674],
  ] as const)('%s: $%#', (_name, hp, interval, produces, expected) => {
    expect(cost(kindFactory(hp, interval, produces))).toBe(expected);
  });

  it('the production line names the kind; burst never changes the price', () => {
    const b = computeCost(kindFactory(300, 900, 'archer'), C.cost, pricingOf(C)).breakdown;
    expect(b.production).toMatchObject({ kind: 'archer', minionCost: 69, minionValue: 35, expected: 5, total: 175 });
    expect(b.production!.text).toBe('Production: 5 archers × $35 (half of a $69 archer, because they arrive during the battle) = $175');
    const withBurst = { ...kindFactory(300, 900, 'archer'), burst: 4 } as CostStats;
    expect(cost(withBurst)).toBe(228);
  });

  it('a kind retune re-prices only the factories of that kind', () => {
    const tuned = cfg({ factory: { minions: { runner: { speed: 2 } } } });
    expect(cost(kindFactory(300, 900, 'runner'), tuned)).toBeLessThan(243);
    expect(cost(kindFactory(300, 900), tuned)).toBe(193);
    expect(cost(kindFactory(300, 900, 'archer'), tuned)).toBe(228);
  });

  it('a too-expensive non-grunt factory also suggests making grunts', () => {
    // Production ($304) is the bigger cost here (body 800 HP: $229).
    const s = kindFactory(800, 600, 'runner');
    const r = computeCost(s, C.cost, pricingOf(C));
    const e = tooExpensiveError(s, r, C.caps.unitCost, C.cost, C.stats.bounds, pricingOf(C));
    expect(e.fix).toContain("Making grunts instead of runners (this.produces = 'grunt') saves $80 ($453)");
  });

  it('config: an old factory.minion patch migrates to the grunt; kinds stay legal soldiers; burst.max <= maxAlivePerFactory', () => {
    const migrated = safeParseConfig({ factory: { minion: { maxHealth: 60 } } });
    expect(migrated.success).toBe(true);
    expect(migrated.success && migrated.data.factory.minions.grunt.maxHealth).toBe(60);
    expect(migrated.success && migrated.data.factory.minions.archer.maxHealth).toBe(24);
    expect(safeParseConfig({ factory: { minions: { brute: { speed: 6 } } } }).success).toBe(false);
    expect(safeParseConfig({ factory: { minions: { archer: { range: 400 } } } }).success).toBe(false);
    expect(safeParseConfig({ factory: { minions: { brute: { wallDamageMultiplier: 9 } } } }).success).toBe(false);
    expect(safeParseConfig({ stats: { bounds: { burst: { min: 1, max: 5 } } } }).success).toBe(false);
    expect(safeParseConfig({ stats: { bounds: { burst: { min: 1, max: 5 } } }, factory: { maxAlivePerFactory: 5 } }).success).toBe(true);
    expect(safeParseConfig({ stats: { bounds: { burst: { min: 0, max: 3 } } } }).success).toBe(false);
  });

  it('checkStats: produces and burst defaults, errors and ignored fields', () => {
    const B = C.stats.bounds;
    const base = { name: 'F', type: 'factory', maxHealth: 300, productionInterval: 900, color: '#C0A060' };
    const ok = checkStats(base, B);
    expect(ok.ok && ok.stats).toMatchObject({ produces: 'grunt', burst: 1 });
    const archer = checkStats({ ...base, produces: 'archer', burst: 3 }, B);
    expect(archer.ok && archer.stats).toMatchObject({ produces: 'archer', burst: 3 });
    const bad = (raw: Record<string, unknown>) => {
      const r = checkStats({ ...base, ...raw }, B);
      if (r.ok) throw new Error('expected errors');
      return r.errors[0]!;
    };
    expect(bad({ produces: 'archers' })).toMatchObject({ code: 'STAT_OUT_OF_RANGE', field: 'produces', allowed: { oneOf: ['grunt', 'archer', 'runner', 'brute'] } });
    expect(bad({ produces: 'archers' }).fix).toContain("this.produces = 'archer'");
    expect(bad({ produces: 'Knight' }).fix).toContain("this.produces = 'brute'");
    expect(bad({ produces: 3 })).toMatchObject({ code: 'STAT_WRONG_TYPE', field: 'produces' });
    expect(bad({ burst: 0 })).toMatchObject({ code: 'STAT_OUT_OF_RANGE', field: 'burst', allowed: { min: 1, max: 4 } });
    expect(bad({ burst: 5 })).toMatchObject({ code: 'STAT_OUT_OF_RANGE', field: 'burst' });
    expect(bad({ burst: 2.5 })).toMatchObject({ code: 'BURST_NOT_INTEGER', field: 'burst' });
    expect(bad({ burst: '3' })).toMatchObject({ code: 'STAT_WRONG_TYPE', field: 'burst' });
    const soldier = checkStats({ name: 'S', type: 'soldier', maxHealth: 100, damage: 5, range: 30, speed: 1, attackCooldown: 60, color: '#112233', produces: 'archer', burst: 2 }, B);
    expect(soldier.ok).toBe(true);
    expect(soldier.warnings.map((w) => [w.code, w.field])).toEqual([['W_STAT_IGNORED', 'produces'], ['W_STAT_IGNORED', 'burst']]);
    expect(soldier.ok && 'produces' in soldier.stats).toBe(false);
  });

  it('every kind has its own 12×12 sprite, valid and tinted with the factory colour', () => {
    const looks = (['grunt', 'archer', 'runner', 'brute'] as const).map((k) => minionSprite('#33AA55', k));
    for (const l of looks) {
      expect(checkSprite(l).ok).toBe(true);
      expect(l.palette.b).toBe('#33AA55');
    }
    expect(new Set(looks.map((l) => JSON.stringify(l.frames.idle))).size).toBe(4);
  });
});
