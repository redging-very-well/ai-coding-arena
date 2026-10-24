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
  it('Basic Wall: valid, $149, building snapshot (damage/range/speed/cooldown 0, size 20), no warnings', async () => {
    const r = expectOk(await run(template('basic_wall.js')));
    expect(r.unit).toMatchObject({ unitId: 'basic-wall', cost: 149 });
    expect(r.unit.stats).toEqual({
      name: 'Basic Wall', type: 'wall', maxHealth: 2000, damage: 0, range: 0, speed: 0, attackCooldown: 0,
      element: 'normal', splashRadius: 0, support: null,
      color: '#8A8F98', size: 20, shape: 'square',
    });
    expect(r.unit.stats).not.toHaveProperty('productionInterval');
    expect(r.warnings).toEqual([]);
  });

  it('Basic Factory: valid, $987 = $247 body + 5 minions × $148, size 18', async () => {
    const r = expectOk(await run(template('basic_factory.js')));
    expect(r.unit).toMatchObject({ unitId: 'basic-factory', cost: 987 });
    expect(r.unit.stats).toMatchObject({ type: 'factory', maxHealth: 1500, productionInterval: 900, damage: 0, range: 0, speed: 0, attackCooldown: 0, size: 18, minionElement: 'normal' });
    expect(r.unit.breakdown.production).toMatchObject({ expected: 5, minionValue: 148, total: 740 });
    expect(r.warnings).toEqual([]);
  });

  it('the wall-aware soldier and tower templates keep their prices and stay warning-free', async () => {
    expect(expectOk(await run(template('basic_soldier.js'))).unit.cost).toBe(529);
    const tower = expectOk(await run(template('basic_tower.js')));
    expect(tower.unit.cost).toBe(954);
    expect(tower.warnings).toEqual([]);
  });
});

describe('validator: per-type required fields and guards (§5.2, §7 steps 5-6)', () => {
  it('a wall needs only name, type, maxHealth and color (no update, no sprite → just W_NO_SPRITE)', async () => {
    const r = expectOk(await run(wall('this.maxHealth = 2000;')));
    expect(r.unit.cost).toBe(149);
    expect(codes(r)).toEqual(['W_NO_SPRITE']);
  });

  it('a wall without maxHealth: STAT_MISSING with a wall-specific fix', async () => {
    const e = errorWith(await run(wall('')), 'STAT_MISSING', 'maxHealth');
    expect(e.fix).toContain('250 to 7500');
  });

  it('a factory without productionInterval: STAT_MISSING with "Try 900"', async () => {
    const e = errorWith(await run(factory('this.maxHealth = 1500;')), 'STAT_MISSING', 'productionInterval');
    expect(e.fix).toContain('600-1800');
    expect(e.fix).toContain('900');
  });

  it('BUILDING_CANNOT_ATTACK for damage on a wall or factory; damage 0 is fine', async () => {
    errorWith(await run(wall('this.maxHealth = 2000; this.damage = 5;')), 'BUILDING_CANNOT_ATTACK', 'damage');
    errorWith(await run(factory('this.maxHealth = 1500; this.productionInterval = 900; this.damage = 10;')), 'BUILDING_CANNOT_ATTACK', 'damage');
    expectOk(await run(wall('this.maxHealth = 2000; this.damage = 0;')));
  });

  it('the W_STAT_IGNORED hints come back together with BUILDING_CANNOT_ATTACK, so every fix shows at once', async () => {
    const r = await run(wall('this.maxHealth = 2000; this.damage = 10; this.range = 50;'));
    expect(r.ok).toBe(false);
    errorWith(r, 'BUILDING_CANNOT_ATTACK', 'damage');
    expect(r.warnings.map((w) => `${w.code}:${w.field}`)).toContain('W_STAT_IGNORED:range');
  });

  it('BUILDING_CANNOT_MOVE for speed on a wall or factory', async () => {
    errorWith(await run(wall('this.maxHealth = 2000; this.speed = 1;')), 'BUILDING_CANNOT_MOVE', 'speed');
    errorWith(await run(factory('this.maxHealth = 1500; this.productionInterval = 900; this.speed = 2;')), 'BUILDING_CANNOT_MOVE', 'speed');
  });

  it('INTERVAL_NOT_INTEGER for a fractional productionInterval', async () => {
    const e = errorWith(await run(factory('this.maxHealth = 1500; this.productionInterval = 900.5;')), 'INTERVAL_NOT_INTEGER', 'productionInterval');
    expect(e.allowed).toMatchObject({ integer: true });
  });

  it.each([
    ['wall HP 249', wall('this.maxHealth = 249;'), 'maxHealth', { min: 250, max: 7500 }],
    ['wall HP 7501', wall('this.maxHealth = 7501;'), 'maxHealth', { min: 250, max: 7500 }],
    ['factory HP 499', factory('this.maxHealth = 499; this.productionInterval = 900;'), 'maxHealth', { min: 500, max: 5000 }],
    ['factory HP 5001', factory('this.maxHealth = 5001; this.productionInterval = 900;'), 'maxHealth', { min: 500, max: 5000 }],
    ['interval 599', factory('this.maxHealth = 1500; this.productionInterval = 599;'), 'productionInterval', { min: 600, max: 1800 }],
    ['interval 1801', factory('this.maxHealth = 1500; this.productionInterval = 1801;'), 'productionInterval', { min: 600, max: 1800 }],
  ])('%s → STAT_OUT_OF_RANGE with the per-type bounds', async (_label, source, field, allowed) => {
    expect(errorWith(await run(source), 'STAT_OUT_OF_RANGE', field).allowed).toEqual(allowed);
  });

  it('a 5000-HP wall (far above the soldier max of 2500) is valid: $454', async () => {
    expect(expectOk(await run(wall('this.maxHealth = 5000;'))).unit.cost).toBe(454);
  });

  it('a maxed storm-runner factory (5000 HP, interval 600) is $2,938: UNIT_TOO_EXPENSIVE naming a lever', async () => {
    const e = errorWith(await run(factory("this.maxHealth = 5000; this.productionInterval = 600; this.produces = 'runner'; this.minionElement = 'lightning';")), 'UNIT_TOO_EXPENSIVE');
    expect(e.fix).toMatch(/productionInterval|maxHealth/);
  });

  it('W_STAT_IGNORED for range, attackCooldown and size on a wall (not stored)', async () => {
    const r = expectOk(await run(wall('this.maxHealth = 2000; this.range = 40; this.attackCooldown = 60; this.size = 12;')));
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
    const e = errorWith(await run(wall('this.maxHealth = 2000; this.type = "moat";')), 'STAT_OUT_OF_RANGE', 'type');
    expect(e.allowed).toEqual({ oneOf: ['soldier', 'tower', 'wall', 'factory'] });
  });
});

describe('validator: dry run per type (§7 step 9)', () => {
  it("a wall's update() is never called: W_UPDATE_IGNORED, even for an endless loop", async () => {
    const r = expectOk(await run(wall('this.maxHealth = 2000;', 'update() { while (true) {} }')));
    expect(codes(r)).toContain('W_UPDATE_IGNORED');
  });

  it('a factory sees self.factory (5 minions left, rally = centre) and may rally or hold', async () => {
    const r = expectOk(
      await run(
        factory(
          'this.maxHealth = 1500; this.productionInterval = 900;',
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
    const e = errorWith(await run(factory('this.maxHealth = 1500; this.productionInterval = 900;', null)), 'UPDATE_MISSING');
    expect(e.fix).toContain('rally');
  });

  it('a factory rally without a destination: BAD_ACTION listing the factory actions', async () => {
    const e = errorWith(await run(factory('this.maxHealth = 1500; this.productionInterval = 900;', "return { action: 'rally' };")), 'BAD_ACTION');
    expect(JSON.stringify(e.allowed)).toContain('rally');
    expect(e.fix).toContain('hold');
  });

  it('W_ACTION_NOT_FOR_TYPE both ways: a factory that moves, a soldier that rallies', async () => {
    const f = expectOk(await run(factory('this.maxHealth = 1500; this.productionInterval = 900;', "return { action: 'move', destination: world.center };")));
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
      await run(factory('this.maxHealth = 1500; this.productionInterval = 900;', "return { action: 'attack', targetId: enemies[0] && enemies[0].id };")),
      'BAD_ACTION',
    );
    expect(e.message).toContain("a factory can't attack, it only tells its minions where to go");
    expect(e.message).not.toContain('targetId');
    expect(e.fix).toContain("{ action: 'rally'");
  });

  it('a too-tough wall or factory suggests its starter health as the example', async () => {
    expect(errorWith(await run(wall('this.maxHealth = 9000;')), 'STAT_OUT_OF_RANGE', 'maxHealth').fix).toContain('this.maxHealth = 2000');
    expect(errorWith(await run(factory('this.maxHealth = 9000; this.productionInterval = 900;')), 'STAT_OUT_OF_RANGE', 'maxHealth').fix).toContain(
      'this.maxHealth = 1500',
    );
  });

  it('a too-expensive factory has no "before the factor" (buildings have no cooldown factor)', async () => {
    const e = errorWith(await run(factory("this.maxHealth = 5000; this.productionInterval = 600; this.produces = 'runner'; this.minionElement = 'lightning';")), 'UNIT_TOO_EXPENSIVE');
    expect(e.fix).toContain('The most expensive stat is maxHealth: 5000 costs $1200 (');
    expect(e.fix).not.toContain('before the factor');
  });

  it('an unknown type only asks for the type, not for soldier stats a wall never needs', async () => {
    const r = await run(wall('this.maxHealth = 2000; this.type = "gate";'));
    expect(r.ok).toBe(false);
    expect((r as ValidationFailure).errors.map((e) => `${e.code}:${e.field}`)).toEqual(['STAT_OUT_OF_RANGE:type']);
  });
});

// ---------------------------------------------------------------------------
// M8.6: minion kinds, squad orders and burst (§5.3, §7)
// ---------------------------------------------------------------------------

describe('validator: produces, burst and squad orders (M8.6)', () => {
  it('produces and burst are stored on the snapshot (defaults grunt / 1); the price follows the kind only', async () => {
    const plain = expectOk(await run(factory('this.maxHealth = 1500; this.productionInterval = 900;')));
    expect(plain.unit.stats).toMatchObject({ produces: 'grunt', burst: 1 });
    expect(plain.unit.cost).toBe(987);
    const archers = expectOk(await run(factory("this.maxHealth = 1500; this.productionInterval = 900; this.produces = 'archer'; this.burst = 3;")));
    expect(archers.unit.stats).toMatchObject({ produces: 'archer', burst: 3 });
    expect(archers.unit.cost).toBe(1222);
    expect(archers.unit.breakdown.production!.text).toContain('5 archers × $195');
  });

  it('a wrong produces names the closest kind; burst must be a whole number 1-4', async () => {
    const e = errorWith(await run(factory("this.maxHealth = 1500; this.productionInterval = 900; this.produces = 'archers';")), 'STAT_OUT_OF_RANGE', 'produces');
    expect(e.fix).toContain("this.produces = 'archer'");
    const f = expectFail(await run(factory("this.maxHealth = 1500; this.productionInterval = 900; this.produces = 'archers';")));
    expect(f.playerHint).toMatch(/grunts, archers, runners, brutes or medics/);
    errorWith(await run(factory('this.maxHealth = 1500; this.productionInterval = 900; this.produces = 2;')), 'STAT_WRONG_TYPE', 'produces');
    errorWith(await run(factory('this.maxHealth = 1500; this.productionInterval = 900; this.burst = 5;')), 'STAT_OUT_OF_RANGE', 'burst');
    errorWith(await run(factory('this.maxHealth = 1500; this.productionInterval = 900; this.burst = 0;')), 'STAT_OUT_OF_RANGE', 'burst');
    errorWith(await run(factory('this.maxHealth = 1500; this.productionInterval = 900; this.burst = 2.5;')), 'BURST_NOT_INTEGER', 'burst');
    errorWith(await run(factory("this.maxHealth = 1500; this.productionInterval = 900; this.burst = '3';")), 'STAT_WRONG_TYPE', 'burst');
  });

  it('W_BURST_NEVER_FULL when the factory makes fewer minions than its burst', async () => {
    const r = expectOk(await run(factory('this.maxHealth = 1500; this.productionInterval = 1800; this.burst = 4;')));
    const w = r.warnings.find((x) => x.code === 'W_BURST_NEVER_FULL')!;
    expect(w.message).toContain('only 2 minions');
    expect(w.fix).toContain('this.burst to 2');
    expect(codes(expectOk(await run(factory('this.maxHealth = 1500; this.productionInterval = 900; this.burst = 4;'))))).not.toContain('W_BURST_NEVER_FULL');
  });

  it('a factory may command and release; the orders it gave are recorded', async () => {
    const body = `
      if (self.factory.stored >= 2) return { action: 'release' };
      const t = allies.find((a) => a.type === 'tower');
      if (world.tick === 0 && t) return { action: 'command', order: 'guard', targetId: t.id };
      const e = enemies.find((x) => x.type !== 'wall');
      if (e) return { action: 'command', order: 'swarm', targetId: e.id };
      return { action: 'command', order: 'defend' };`;
    const r = expectOk(await run(factory("this.maxHealth = 1500; this.productionInterval = 900; this.produces = 'runner'; this.burst = 4;", body)));
    expect(r.unit.orders).toEqual(['guard', 'defend', 'swarm']);
    expect(codes(r)).not.toContain('W_ORDER_TARGET');
    expect(codes(r)).not.toContain('W_ACTION_NOT_FOR_TYPE');
    // The template (rally only) records attack.
    expect(expectOk(await run(template('basic_factory.js'))).unit.orders).toEqual(['attack']);
  });

  it('self.factory shows the M8.6 fields in the practice battles', async () => {
    const body = `
      const f = self.factory;
      if (f.stored !== 0 || f.burst !== 3 || f.produces !== 'brute' || f.order !== 'attack' || f.orderTargetId !== null) throw new Error('bad view ' + JSON.stringify(f));
      return { action: 'command', order: 'attack', destination: world.center };`;
    expectOk(await run(factory("this.maxHealth = 1500; this.productionInterval = 900; this.produces = 'brute'; this.burst = 3;", body)));
  });

  it('BAD_ACTION for an unknown order and for swarm/guard without a targetId, with the right shape in the fix', async () => {
    const unknown = errorWith(await run(factory('this.maxHealth = 1500; this.productionInterval = 900;', "return { action: 'command', order: 'charge' };")), 'BAD_ACTION');
    expect(unknown.errorMessage).toContain("'attack', 'defend', 'swarm', 'guard'");
    const swarm = errorWith(await run(factory('this.maxHealth = 1500; this.productionInterval = 900;', "return { action: 'command', order: 'swarm', targetId: enemies.length ? enemies[0].id : undefined };")), 'BAD_ACTION');
    expect(swarm.errorMessage).toContain('swarm needs targetId');
    expect(swarm.fix).toContain("return { action: 'command', order: 'attack' } instead");
    const guard = errorWith(await run(factory('this.maxHealth = 1500; this.productionInterval = 900;', "return { action: 'command', order: 'guard' };")), 'BAD_ACTION');
    expect(guard.fix).toContain("order: 'defend'");
    const dest = errorWith(await run(factory('this.maxHealth = 1500; this.productionInterval = 900;', "return { action: 'command', order: 'attack', destination: { x: 'a', y: 1 } };")), 'BAD_ACTION');
    expect(dest.errorMessage).toContain('finite numbers');
  });

  it('W_ORDER_TARGET for a swarm on an ally or a guard on an enemy; W_ACTION_NOT_FOR_TYPE for a soldier that commands', async () => {
    const r = expectOk(await run(factory('this.maxHealth = 1500; this.productionInterval = 900;', "return allies.length > 1 ? { action: 'command', order: 'swarm', targetId: allies[1].id } : { action: 'idle' };")));
    expect(codes(r)).toContain('W_ORDER_TARGET');
    const g = expectOk(await run(factory('this.maxHealth = 1500; this.productionInterval = 900;', "return enemies.length ? { action: 'command', order: 'guard', targetId: enemies[0].id } : { action: 'command', order: 'guard', targetId: self.id };")));
    expect(codes(g)).toContain('W_ORDER_TARGET');
    const soldier = `export default class S {
      constructor() { this.name = 'S'; this.type = 'soldier'; this.maxHealth = 500; this.damage = 25; this.range = 30; this.speed = 1; this.attackCooldown = 60; this.color = '#112233'; }
      update(self, enemies) { return enemies.length ? { action: 'release' } : { action: 'command', order: 'defend' }; }
    }`;
    expect(codes(expectOk(await run(soldier)))).toContain('W_ACTION_NOT_FOR_TYPE');
  });

  it('the three CLAUDE.md factory examples validate cleanly', async () => {
    const md = readFileSync(new URL('../packages/starter-kit/CLAUDE.md.tmpl', import.meta.url), 'utf8');
    const part = md.slice(md.indexOf('### Factories: minion kinds, orders and burst'));
    const blocks = [...part.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]!).slice(0, 3);
    expect(blocks).toHaveLength(3);
    for (const block of blocks) {
      const ctor = /\/\/ constructor: (.*)/.exec(block)![1]!;
      const update = block.slice(block.indexOf('update('));
      const src = `export default class F {
        constructor() { this.name = 'Example'; this.type = 'factory'; this.maxHealth = 1500; this.productionInterval = 900; this.color = '#C0A060'; ${ctor} }
        ${update}
      }`;
      const r = expectOk(await run(src));
      expect(codes(r).filter((c) => c !== 'W_NO_SPRITE')).toEqual([]);
    }
  });
});
