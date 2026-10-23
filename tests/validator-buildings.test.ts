// §7 per type (M8.5, §5.2): walls and factories through the real validation
// pipeline (esbuild + a fresh isolated-vm sandbox), plus the practice worlds
// with an enemy wall and minion.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type ValidationError, type ValidationFailure, type ValidationResult, type ValidationSuccess } from '@pixel-clash/shared';
import { validate } from '../packages/server/src/validator/validate.js';

const template = (file: string) => readFileSync(new URL(`../packages/starter-kit/units/${file}`, import.meta.url), 'utf8');
const run = (source: string) => validate(source, {}, DEFAULT_CONFIG);

function expectOk(r: ValidationResult): ValidationSuccess {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.errors, null, 2)}`);
  return r;
}
function expectFail(r: ValidationResult): ValidationFailure {
  if (r.ok) throw new Error(`expected failure, got ok: ${JSON.stringify(r.unit)}`);
  return r;
}
function errorWith(r: ValidationResult, code: string, field?: string): ValidationError {
  const f = expectFail(r);
  const e = f.errors.find((x) => x.code === code && (field === undefined || x.field === field));
  if (!e) throw new Error(`expected ${code}${field ? ` on ${field}` : ''}, got ${JSON.stringify(f.errors.map((x) => [x.code, x.field]))}`);
  expect(e.message.length).toBeGreaterThan(5);
  expect(e.fix.length).toBeGreaterThan(5);
  expect(f.playerHint.length).toBeGreaterThan(5);
  return e;
}
const codes = (r: ValidationResult) => r.warnings.map((w) => w.code);

/** A wall class with the given constructor lines (and optional extra members). */
const wall = (fields: string, extra = '') => `export default class W {
  constructor() {
    this.name = 'Test Wall';
    this.type = 'wall';
    this.color = '#888888';
    ${fields}
  }
  ${extra}
}`;

/** A factory class with the given constructor lines and update() body. */
const factory = (fields: string, update: string | null = "return { action: 'rally', destination: world.center };") => `export default class F {
  constructor() {
    this.name = 'Test Factory';
    this.type = 'factory';
    this.color = '#C0A060';
    ${fields}
  }
  ${update === null ? '' : `update(self, enemies, allies, world) { ${update} }`}
}`;

describe('validator: wall and factory templates', () => {
  it('Basic Wall: valid, $32, building snapshot (damage/range/speed/cooldown 0, size 20), no warnings', async () => {
    const r = expectOk(await run(template('basic_wall.js')));
    expect(r.unit).toMatchObject({ unitId: 'basic-wall', cost: 32 });
    expect(r.unit.stats).toEqual({
      name: 'Basic Wall', type: 'wall', maxHealth: 400, damage: 0, range: 0, speed: 0, attackCooldown: 0,
      color: '#8A8F98', size: 20, shape: 'square',
    });
    expect(r.unit.stats).not.toHaveProperty('productionInterval');
    expect(r.warnings).toEqual([]);
  });

  it('Basic Factory: valid, $193 = $53 body + 5 minions × $28, size 18', async () => {
    const r = expectOk(await run(template('basic_factory.js')));
    expect(r.unit).toMatchObject({ unitId: 'basic-factory', cost: 193 });
    expect(r.unit.stats).toMatchObject({ type: 'factory', maxHealth: 300, productionInterval: 900, damage: 0, range: 0, speed: 0, attackCooldown: 0, size: 18 });
    expect(r.unit.breakdown.production).toMatchObject({ expected: 5, minionValue: 28, total: 140 });
    expect(r.warnings).toEqual([]);
  });

  it('the wall-aware soldier and tower templates keep their prices and stay warning-free', async () => {
    expect(expectOk(await run(template('basic_soldier.js'))).unit.cost).toBe(92);
    const tower = expectOk(await run(template('basic_tower.js')));
    expect(tower.unit.cost).toBe(198);
    expect(tower.warnings).toEqual([]);
  });
});

describe('validator: per-type required fields and guards (§5.2, §7 steps 5-6)', () => {
  it('a wall needs only name, type, maxHealth and color (no update, no sprite → just W_NO_SPRITE)', async () => {
    const r = expectOk(await run(wall('this.maxHealth = 400;')));
    expect(r.unit.cost).toBe(32);
    expect(codes(r)).toEqual(['W_NO_SPRITE']);
  });

  it('a wall without maxHealth: STAT_MISSING with a wall-specific fix', async () => {
    const e = errorWith(await run(wall('')), 'STAT_MISSING', 'maxHealth');
    expect(e.fix).toContain('50 to 1500');
  });

  it('a factory without productionInterval: STAT_MISSING with "Try 900"', async () => {
    const e = errorWith(await run(factory('this.maxHealth = 300;')), 'STAT_MISSING', 'productionInterval');
    expect(e.fix).toContain('600-1800');
    expect(e.fix).toContain('900');
  });

  it('BUILDING_CANNOT_ATTACK for damage on a wall or factory; damage 0 is fine', async () => {
    errorWith(await run(wall('this.maxHealth = 400; this.damage = 5;')), 'BUILDING_CANNOT_ATTACK', 'damage');
    errorWith(await run(factory('this.maxHealth = 300; this.productionInterval = 900; this.damage = 10;')), 'BUILDING_CANNOT_ATTACK', 'damage');
    expectOk(await run(wall('this.maxHealth = 400; this.damage = 0;')));
  });

  it('the W_STAT_IGNORED hints come back together with BUILDING_CANNOT_ATTACK, so every fix shows at once', async () => {
    const r = await run(wall('this.maxHealth = 400; this.damage = 10; this.range = 50;'));
    expect(r.ok).toBe(false);
    errorWith(r, 'BUILDING_CANNOT_ATTACK', 'damage');
    expect(r.warnings.map((w) => `${w.code}:${w.field}`)).toContain('W_STAT_IGNORED:range');
  });

  it('BUILDING_CANNOT_MOVE for speed on a wall or factory', async () => {
    errorWith(await run(wall('this.maxHealth = 400; this.speed = 1;')), 'BUILDING_CANNOT_MOVE', 'speed');
    errorWith(await run(factory('this.maxHealth = 300; this.productionInterval = 900; this.speed = 2;')), 'BUILDING_CANNOT_MOVE', 'speed');
  });

  it('INTERVAL_NOT_INTEGER for a fractional productionInterval', async () => {
    const e = errorWith(await run(factory('this.maxHealth = 300; this.productionInterval = 900.5;')), 'INTERVAL_NOT_INTEGER', 'productionInterval');
    expect(e.allowed).toMatchObject({ integer: true });
  });

  it.each([
    ['wall HP 49', wall('this.maxHealth = 49;'), 'maxHealth', { min: 50, max: 1500 }],
    ['wall HP 1501', wall('this.maxHealth = 1501;'), 'maxHealth', { min: 50, max: 1500 }],
    ['factory HP 99', factory('this.maxHealth = 99; this.productionInterval = 900;'), 'maxHealth', { min: 100, max: 1000 }],
    ['factory HP 1001', factory('this.maxHealth = 1001; this.productionInterval = 900;'), 'maxHealth', { min: 100, max: 1000 }],
    ['interval 599', factory('this.maxHealth = 300; this.productionInterval = 599;'), 'productionInterval', { min: 600, max: 1800 }],
    ['interval 1801', factory('this.maxHealth = 300; this.productionInterval = 1801;'), 'productionInterval', { min: 600, max: 1800 }],
  ])('%s → STAT_OUT_OF_RANGE with the per-type bounds', async (_label, source, field, allowed) => {
    expect(errorWith(await run(source), 'STAT_OUT_OF_RANGE', field).allowed).toEqual(allowed);
  });

  it('a 1000-HP wall (far above the soldier max of 500) is valid: $118', async () => {
    expect(expectOk(await run(wall('this.maxHealth = 1000;'))).unit.cost).toBe(118);
  });

  it('a maxed factory (1000 HP, interval 600) is $594: UNIT_TOO_EXPENSIVE naming a lever', async () => {
    const e = errorWith(await run(factory('this.maxHealth = 1000; this.productionInterval = 600;')), 'UNIT_TOO_EXPENSIVE');
    expect(e.fix).toMatch(/productionInterval|maxHealth/);
  });

  it('W_STAT_IGNORED for range, attackCooldown and size on a wall (not stored)', async () => {
    const r = expectOk(await run(wall('this.maxHealth = 400; this.range = 40; this.attackCooldown = 60; this.size = 12;')));
    const ignored = r.warnings.filter((w) => w.code === 'W_STAT_IGNORED').map((w) => w.field);
    expect(ignored.sort()).toEqual(['attackCooldown', 'range', 'size']);
    expect(r.unit.stats).toMatchObject({ range: 0, attackCooldown: 0, size: 20 });
  });

  it('W_STAT_IGNORED for productionInterval on a soldier', async () => {
    const src = template('basic_soldier.js').replace("this.color = '#3399FF';", "this.color = '#3399FF'; this.productionInterval = 900;");
    const r = expectOk(await run(src));
    expect(r.warnings.find((w) => w.code === 'W_STAT_IGNORED')?.field).toBe('productionInterval');
    expect(r.unit.stats).not.toHaveProperty('productionInterval');
  });

  it('an unknown type lists the four allowed types', async () => {
    const e = errorWith(await run(wall('this.maxHealth = 400; this.type = "moat";')), 'STAT_OUT_OF_RANGE', 'type');
    expect(e.allowed).toEqual({ oneOf: ['soldier', 'tower', 'wall', 'factory'] });
  });
});

describe('validator: dry run per type (§7 step 9)', () => {
  it("a wall's update() is never called: W_UPDATE_IGNORED, even for an endless loop", async () => {
    const r = expectOk(await run(wall('this.maxHealth = 400;', 'update() { while (true) {} }')));
    expect(codes(r)).toContain('W_UPDATE_IGNORED');
  });

  it('a factory sees self.factory (5 minions left, rally = centre) and may rally or hold', async () => {
    const r = expectOk(
      await run(
        factory(
          'this.maxHealth = 300; this.productionInterval = 900;',
          `const f = self.factory;
           if (!f || f.minionsLeft !== 5 || f.rally.x !== world.center.x || f.productionInterval !== 900) throw new Error('no factory view');
           if (self.blockedBy !== null || self.blockedTicks !== 0) throw new Error('no blocked fields');
           return world.tick % 2 === 0 ? { action: 'hold' } : { action: 'rally', destination: { x: 10, y: 20 } };`,
        ),
      ),
    );
    expect(codes(r)).not.toContain('W_ACTION_NOT_FOR_TYPE');
    expect(codes(r)).not.toContain('W_NEVER_ATTACKS');
  });

  it('a factory without update(): UPDATE_MISSING with a rally fix', async () => {
    const e = errorWith(await run(factory('this.maxHealth = 300; this.productionInterval = 900;', null)), 'UPDATE_MISSING');
    expect(e.fix).toContain('rally');
  });

  it('a factory rally without a destination: BAD_ACTION listing the factory actions', async () => {
    const e = errorWith(await run(factory('this.maxHealth = 300; this.productionInterval = 900;', "return { action: 'rally' };")), 'BAD_ACTION');
    expect(JSON.stringify(e.allowed)).toContain('rally');
    expect(e.fix).toContain('hold');
  });

  it('W_ACTION_NOT_FOR_TYPE both ways: a factory that moves, a soldier that rallies', async () => {
    const f = expectOk(await run(factory('this.maxHealth = 300; this.productionInterval = 900;', "return { action: 'move', destination: world.center };")));
    expect(codes(f)).toContain('W_ACTION_NOT_FOR_TYPE');
    const s = expectOk(
      await run(template('basic_soldier.js').replace('  update(self, enemies, allies, world) {\n', "  update(self, enemies, allies, world) {\n    return { action: 'rally', destination: world.center };\n")),
    );
    expect(codes(s)).toContain('W_ACTION_NOT_FOR_TYPE');
  });

  it('the practice worlds include an enemy wall and an enemy minion', async () => {
    const src = template('basic_soldier.js').replace(
      '  update(self, enemies, allies, world) {\n',
      `  update(self, enemies, allies, world) {
    const w = enemies.find((e) => e.type === 'wall');
    const m = enemies.find((e) => e.type === 'minion');
    if (w && m && w.radius === 20 && w.range === 0 && m.radius === 8) throw new Error('saw a wall and a minion');
`,
    );
    const e = errorWith(await run(src), 'UPDATE_THREW');
    expect(e.message).toContain('saw a wall and a minion');
  });

  it('the wall-aware soldier template still moves and attacks in the practice worlds', async () => {
    const r = expectOk(await run(template('basic_soldier.js')));
    expect(codes(r)).not.toContain('W_NEVER_MOVES');
    expect(codes(r)).not.toContain('W_NEVER_ATTACKS');
  });
});

describe('validator: fix texts for walls and factories (real-Claude dry run, M8.5 QA)', () => {
  it("a factory's broken attack says what a factory can do, not how to aim", async () => {
    const e = errorWith(
      await run(factory('this.maxHealth = 300; this.productionInterval = 900;', "return { action: 'attack', targetId: enemies[0] && enemies[0].id };")),
      'BAD_ACTION',
    );
    expect(e.message).toContain("a factory can't attack, it only tells its minions where to go");
    expect(e.message).not.toContain('targetId');
    expect(e.fix).toContain("{ action: 'rally'");
  });

  it('a too-tough wall or factory suggests its starter health as the example', async () => {
    expect(errorWith(await run(wall('this.maxHealth = 3000;')), 'STAT_OUT_OF_RANGE', 'maxHealth').fix).toContain('this.maxHealth = 400');
    expect(errorWith(await run(factory('this.maxHealth = 5000; this.productionInterval = 900;')), 'STAT_OUT_OF_RANGE', 'maxHealth').fix).toContain(
      'this.maxHealth = 300',
    );
  });

  it('a too-expensive factory has no "before the factor" (buildings have no cooldown factor)', async () => {
    const e = errorWith(await run(factory('this.maxHealth = 1000; this.productionInterval = 600;')), 'UNIT_TOO_EXPENSIVE');
    expect(e.fix).toContain('The most expensive stat is maxHealth: 1000 costs $360 (');
    expect(e.fix).not.toContain('before the factor');
  });

  it('an unknown type only asks for the type, not for soldier stats a wall never needs', async () => {
    const r = await run(wall('this.maxHealth = 400; this.type = "gate";'));
    expect(r.ok).toBe(false);
    expect((r as ValidationFailure).errors.map((e) => `${e.code}:${e.field}`)).toEqual(['STAT_OUT_OF_RANGE:type']);
  });
});
