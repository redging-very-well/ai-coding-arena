// §7 M8.8 (elements, splash and support, the ×5 bounds): the step-6 guards on
// the six new stats (checkStats, fast) and the real pipeline (esbuild + a
// fresh isolated-vm sandbox) for the dry run's `heal`, the new warnings and
// the snapshot.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  STAT_FIELDS,
  checkStats,
  closestElement,
  closestSupportKind,
  playerHintForIssue,
  type ValidationResult,
  type ValidationSuccess,
} from '@pixel-clash/shared';
import { validate } from '../packages/server/src/validator/validate.js';
import { badActionReason } from '../packages/server/src/validator/dryrun.js';

const B = DEFAULT_CONFIG.stats.bounds;
const SOLDIER = { name: 'S', type: 'soldier', maxHealth: 600, damage: 50, range: 40, speed: 1.5, attackCooldown: 60, color: '#3399FF' };
const WALL = { name: 'W', type: 'wall', maxHealth: 2000, color: '#888888' };
const FACTORY = { name: 'F', type: 'factory', maxHealth: 1500, productionInterval: 900, color: '#C0A060' };
const codes = (raw: Record<string, unknown>) => {
  const r = checkStats(raw, B);
  return r.ok ? [] : r.errors.map((e) => `${e.code}:${e.field}`);
};
const warn = (raw: Record<string, unknown>) => checkStats(raw, B).warnings.map((w) => `${w.code}:${w.field}`);
const err = (raw: Record<string, unknown>) => {
  const r = checkStats(raw, B);
  if (r.ok) throw new Error('expected errors');
  return r.errors[0]!;
};

describe('step 6: element, splashRadius, support, supportPower, supportRange, minionElement', () => {
  it('the snapshot always has element, splashRadius and support (factories also minionElement)', () => {
    const s = checkStats(SOLDIER, B);
    expect(s.ok && s.stats).toMatchObject({ element: 'normal', splashRadius: 0, support: null });
    const full = checkStats({ ...SOLDIER, element: 'fire', splashRadius: 40, support: 'might', supportPower: 30, supportRange: 100 }, B);
    expect(full.ok && full.stats).toMatchObject({ element: 'fire', splashRadius: 40, support: { kind: 'might', power: 30, range: 100 } });
    const f = checkStats({ ...FACTORY, produces: 'brute', minionElement: 'fire' }, B);
    expect(f.ok && f.stats).toMatchObject({ produces: 'brute', minionElement: 'fire', element: 'normal', splashRadius: 0, support: null });
    const w = checkStats(WALL, B);
    expect(w.ok && w.stats).toMatchObject({ element: 'normal', splashRadius: 0, support: null });
    expect(w.ok && 'minionElement' in w.stats).toBe(false);
    // The harness reads the same fields (mirrors STAT_FIELDS).
    expect(STAT_FIELDS).toEqual(expect.arrayContaining(['element', 'splashRadius', 'support', 'supportPower', 'supportRange', 'minionElement']));
  });

  it('element and minionElement: wrong type, unknown (with the near-miss fix)', () => {
    expect(err({ ...SOLDIER, element: 3 })).toMatchObject({ code: 'STAT_WRONG_TYPE', field: 'element' });
    const e = err({ ...SOLDIER, element: 'lightening' });
    expect(e).toMatchObject({ code: 'STAT_OUT_OF_RANGE', field: 'element', allowed: { oneOf: ['normal', 'fire', 'ice', 'lightning'] } });
    expect(e.fix).toContain("this.element = 'lightning'");
    expect(err({ ...SOLDIER, element: 'Frost' }).fix).toContain("this.element = 'ice'");
    expect(err({ ...FACTORY, minionElement: 'flames' }).fix).toContain("this.minionElement = 'fire'");
    expect(closestElement('ELECTRIC')).toBe('lightning');
    expect(closestElement('banana')).toBeUndefined();
    expect(playerHintForIssue(e)).toMatch(/normal, fire, ice and lightning/);
  });

  it('splashRadius 0-80; NaN, −1 and 81 are refused', () => {
    expect(codes({ ...SOLDIER, splashRadius: 80 })).toEqual([]);
    expect(codes({ ...SOLDIER, splashRadius: 81 })).toEqual(['STAT_OUT_OF_RANGE:splashRadius']);
    expect(codes({ ...SOLDIER, splashRadius: -1 })).toEqual(['STAT_OUT_OF_RANGE:splashRadius']);
    expect(codes({ ...SOLDIER, splashRadius: NaN })).toEqual(['STAT_NOT_FINITE:splashRadius']);
    expect(codes({ ...SOLDIER, splashRadius: '40' })).toEqual(['STAT_WRONG_TYPE:splashRadius']);
  });

  it('support: one kind (near-miss fix), with supportPower and supportRange inside the bounds of that kind', () => {
    const e = err({ ...SOLDIER, support: 'healing', supportPower: 60, supportRange: 120 });
    expect(e).toMatchObject({ code: 'STAT_OUT_OF_RANGE', field: 'support', allowed: { oneOf: ['heal', 'haste', 'might', 'shield'] } });
    expect(e.fix).toContain("this.support = 'heal'");
    expect(closestSupportKind('armour')).toBe('shield');
    expect(closestSupportKind('Speed')).toBe('haste');
    expect(codes({ ...SOLDIER, support: 'heal', supportPower: 250, supportRange: 200 })).toEqual([]);
    expect(codes({ ...SOLDIER, support: 'heal', supportPower: 251, supportRange: 200 })).toEqual(['STAT_OUT_OF_RANGE:supportPower']);
    expect(codes({ ...SOLDIER, support: 'heal', supportPower: 60, supportRange: 19 })).toEqual(['STAT_OUT_OF_RANGE:supportRange']);
    expect(codes({ ...SOLDIER, support: 'shield', supportPower: 41, supportRange: 80 })).toEqual(['STAT_OUT_OF_RANGE:supportPower']);
    expect(codes({ ...SOLDIER, support: 'might', supportPower: 50, supportRange: 151 })).toEqual(['STAT_OUT_OF_RANGE:supportRange']);
    expect(err({ ...SOLDIER, support: 'shield', supportPower: 41, supportRange: 80 }).allowed).toEqual({ min: 5, max: 40 });
  });

  it('support without power or range → STAT_MISSING with an example for that kind; power or range without support → W_STAT_IGNORED', () => {
    const r = checkStats({ ...SOLDIER, support: 'heal' }, B);
    expect(!r.ok && r.errors.map((x) => `${x.code}:${x.field}`)).toEqual(['STAT_MISSING:supportPower', 'STAT_MISSING:supportRange']);
    expect(!r.ok && r.errors[0]!.fix).toBe('this.supportPower = 60; this.supportRange = 120; // heal 60 HP, reach 120 px');
    expect(warn({ ...SOLDIER, supportPower: 30 })).toEqual(['W_STAT_IGNORED:supportPower']);
  });

  it('the per-type table: walls ignore all six; factories ignore element/splash/support (fixes point at minionElement / medics); soldiers ignore minionElement', () => {
    expect(warn({ ...WALL, element: 'fire', splashRadius: 20, support: 'heal', minionElement: 'ice' })).toEqual([
      'W_STAT_IGNORED:minionElement',
      'W_STAT_IGNORED:element',
      'W_STAT_IGNORED:splashRadius',
      'W_STAT_IGNORED:support',
    ]);
    const f = checkStats({ ...FACTORY, element: 'fire', support: 'heal' }, B);
    expect(f.warnings.find((w) => w.field === 'element')!.fix).toContain('this.minionElement');
    expect(f.warnings.find((w) => w.field === 'support')!.fix).toContain("this.produces = 'medic'");
    const medic = checkStats({ ...FACTORY, produces: 'medic', minionElement: 'fire' }, B);
    expect(medic.ok && medic.stats.minionElement).toBe('normal');
    expect(medic.warnings.map((w) => [w.field, w.fix.includes('medics never attack')])).toEqual([['minionElement', true]]);
    expect(warn({ ...SOLDIER, minionElement: 'fire' })).toEqual(['W_STAT_IGNORED:minionElement']);
  });

  it('fuzz: an element that is an object, getters and odd values never crash and never pass', () => {
    for (const v of [{}, [], null, true, 1, Symbol('x'), () => 'fire', 'FIRE ', '']) {
      const r = checkStats({ ...SOLDIER, element: v }, B);
      if (v === 'FIRE ') expect(r.ok).toBe(false);
      else expect(r.ok, String(typeof v)).toBe(false);
    }
    for (const v of [{}, NaN, Infinity, -0.001, 80.0001]) expect(checkStats({ ...SOLDIER, splashRadius: v }, B).ok).toBe(false);
  });

  it('the ×5 bounds: HP 50-2500, damage 0-300, walls 250-7500, factories 500-5000', () => {
    expect(codes({ ...SOLDIER, maxHealth: 49 })).toEqual(['STAT_OUT_OF_RANGE:maxHealth']);
    expect(codes({ ...SOLDIER, maxHealth: 2501 })).toEqual(['STAT_OUT_OF_RANGE:maxHealth']);
    expect(codes({ ...SOLDIER, damage: 301 })).toEqual(['STAT_OUT_OF_RANGE:damage']);
    expect(err({ ...SOLDIER, damage: 999 }).message).toBe('damage is 999 but must be between 0 and 300.');
    expect(codes({ ...WALL, maxHealth: 249 })).toEqual(['STAT_OUT_OF_RANGE:maxHealth']);
    expect(codes({ ...WALL, maxHealth: 7501 })).toEqual(['STAT_OUT_OF_RANGE:maxHealth']);
    expect(codes({ ...FACTORY, maxHealth: 499 })).toEqual(['STAT_OUT_OF_RANGE:maxHealth']);
    expect(codes({ ...FACTORY, maxHealth: 5001 })).toEqual(['STAT_OUT_OF_RANGE:maxHealth']);
  });
});

// ---------------------------------------------------------------------------
// The real pipeline
// ---------------------------------------------------------------------------

const run = (source: string) => validate(source, {}, DEFAULT_CONFIG);
function expectOk(r: ValidationResult): ValidationSuccess {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.errors, null, 2)}`);
  return r;
}
const unit = (fields: string, update: string) => `export default class U {
  constructor() {
    this.name = 'Test Unit'; this.type = 'soldier'; this.maxHealth = 500; this.range = 20; this.speed = 1.5;
    this.attackCooldown = 60; this.color = '#33CC66'; this.size = 10;
    ${fields}
  }
  update(self, enemies, allies, world) { ${update} }
}`;
const MEDIC_UPDATE = `
  const gap = (a, b) => Math.hypot(b.x - a.x, b.y - a.y) - a.radius - b.radius;
  const need = allies.filter(a => a.id !== self.id && a.type !== 'wall' && a.type !== 'factory' && gap(self, a) <= self.support.range
    && (a.status.burning > 0 || a.status.frozen > 0 || (a.hp < a.maxHp && a.status.healRoom > 0)));
  need.sort((a, b) => (b.status.burning + b.status.frozen > 0) - (a.status.burning + a.status.frozen > 0) || a.hp / a.maxHp - b.hp / b.maxHp);
  if (need[0] && self.cooldownRemaining === 0) return { action: 'heal', targetId: need[0].id };
  if (enemies.length) return { action: 'move', destination: { x: enemies[0].x, y: enemies[0].y } };
  return { action: 'move', destination: world.center };`;

describe('the dry run and step 10 (M8.8)', () => {
  it('the CLAUDE.md Field Medic validates: $759, heal support stored, healUsed, no W_ZERO_DAMAGE', async () => {
    const r = expectOk(await run(unit("this.damage = 0; this.support = 'heal'; this.supportPower = 60; this.supportRange = 120;", MEDIC_UPDATE)));
    expect(r.unit.cost).toBe(759);
    expect(r.unit.stats.support).toEqual({ kind: 'heal', power: 60, range: 120 });
    expect(r.unit.healUsed).toBe(true);
    const codes = r.warnings.map((w) => w.code);
    expect(codes).not.toContain('W_ZERO_DAMAGE');
    expect(codes).not.toContain('W_HEAL_NEVER_USED');
    expect(r.unit.breakdown.heal!.text).toBe('Heal 60 HP up to 120 px away: $382.64 (faster healing costs more)');
  });

  it('W_HEAL_NEVER_USED when a heal-support unit never heals; views carry status, element, splash and support', async () => {
    const probe = `
      const s = self.status;
      if (typeof s.burning !== 'number' || typeof s.healRoom !== 'number' || self.element !== 'normal' || self.splashRadius !== 0) throw new Error('bad self');
      for (const o of [...enemies, ...allies]) if (!o.status || !('support' in o) || typeof o.element !== 'string') throw new Error('bad view');
      return { action: 'move', destination: world.center };`;
    const r = expectOk(await run(unit("this.damage = 0; this.support = 'heal'; this.supportPower = 60; this.supportRange = 120;", probe)));
    expect(r.unit.healUsed).toBe(false);
    const w = r.warnings.find((x) => x.code === 'W_HEAL_NEVER_USED')!;
    expect(w.fix).toContain("{ action: 'heal', targetId }");
  });

  it('the practice worlds have a burning ally and a frozen enemy', async () => {
    const burning = await run(unit('this.damage = 50;', "if (allies.some((a) => a.status.burning > 0)) throw new Error('burning ally'); return { action: 'idle' };"));
    expect(!burning.ok && burning.errors[0]!.message).toContain('burning ally');
    const frozen = await run(unit('this.damage = 50;', "if (enemies.some((e) => e.status.frozen > 0)) throw new Error('frozen enemy'); return { action: 'idle' };"));
    expect(!frozen.ok && frozen.errors[0]!.message).toContain('frozen enemy');
  });

  it("a malformed heal is BAD_ACTION with the shape in the fix; heal without heal support is W_ACTION_NOT_FOR_TYPE", async () => {
    expect(badActionReason({ action: 'heal' })).toMatch(/heal needs targetId/);
    expect(badActionReason({ action: 'heal', targetId: 'x' })).toBeUndefined();
    const bad = await run(unit("this.damage = 0; this.support = 'heal'; this.supportPower = 60; this.supportRange = 120;", "return { action: 'heal' };"));
    expect(!bad.ok && bad.errors[0]).toMatchObject({ code: 'BAD_ACTION' });
    expect(!bad.ok && bad.errors[0]!.fix).toContain("{ action: 'heal', targetId: friend.id }");
    const notHealer = expectOk(await run(unit('this.damage = 50;', "return allies.length ? { action: 'heal', targetId: allies[0].id } : { action: 'move', destination: world.center };")));
    expect(notHealer.warnings.find((w) => w.code === 'W_ACTION_NOT_FOR_TYPE')!.fix).toContain("this.support = 'heal'");
  });

  it('W_POWER_HIGH for a brick; W_ZERO_DAMAGE gains the elements line', async () => {
    const brick = expectOk(await run(unit('this.maxHealth = 1750; this.damage = 265; this.size = 16;', "return enemies.length ? { action: 'attack', targetId: enemies[0].id } : { action: 'move', destination: world.center };")));
    expect(brick.unit.cost).toBe(2463);
    const w = brick.warnings.find((x) => x.code === 'W_POWER_HIGH')!;
    expect(w.message).toContain('×1.37');
    expect(w.fix).toMatch(/drops the power factor from ×1\.37 to ×1\.25/);
    const zero = expectOk(await run(unit("this.damage = 0; this.element = 'ice';", "return { action: 'move', destination: world.center };")));
    expect(zero.warnings.find((x) => x.code === 'W_ZERO_DAMAGE')!.message).toContain('ice still freezes');
  });
});
