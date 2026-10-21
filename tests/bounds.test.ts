import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, checkStats, playerHintForIssue } from '@pixel-clash/shared';

const bounds = DEFAULT_CONFIG.stats.bounds;
const soldier = {
  name: ' Basic Soldier ',
  type: 'soldier',
  maxHealth: 120,
  damage: 10,
  range: 40,
  speed: 1.5,
  attackCooldown: 60,
  color: '#3399FF',
};

const codes = (raw: Record<string, unknown>) => {
  const r = checkStats(raw, bounds);
  return r.ok ? [] : r.errors.map((e) => `${e.code}:${e.field}`);
};

describe('checkStats (§7 step 6)', () => {
  it('accepts the template, trims the name, fills the shape and freezes', () => {
    const r = checkStats(soldier, bounds);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stats.name).toBe('Basic Soldier');
    expect(r.stats.shape).toBe('circle');
    expect(Object.isFrozen(r.stats)).toBe(true);
  });

  it('reports the §7 example error object for damage 999', () => {
    const r = checkStats({ ...soldier, damage: 999 }, bounds);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual([
      {
        code: 'STAT_OUT_OF_RANGE',
        field: 'damage',
        value: 999,
        allowed: { min: 0, max: 60 },
        message: 'damage is 999 but must be between 0 and 60.',
        fix: 'In the constructor set this.damage to a number from 0 to 60, e.g. this.damage = 10.',
      },
    ]);
  });

  it('never coerces, and catches non-finite values', () => {
    expect(codes({ ...soldier, maxHealth: '100' })).toEqual(['STAT_WRONG_TYPE:maxHealth']);
    expect(codes({ ...soldier, damage: Infinity })).toEqual(['STAT_NOT_FINITE:damage']);
    expect(codes({ ...soldier, damage: NaN })).toEqual(['STAT_NOT_FINITE:damage']);
    expect(codes({ ...soldier, range: -5 })).toEqual(['STAT_OUT_OF_RANGE:range']);
  });

  it('checks cooldown integer, colour, name, type, shape and missing fields', () => {
    expect(codes({ ...soldier, attackCooldown: 30.5 })).toEqual(['COOLDOWN_NOT_INTEGER:attackCooldown']);
    expect(codes({ ...soldier, color: 'red' })).toEqual(['BAD_COLOR:color']);
    expect(codes({ ...soldier, name: '   ' })).toEqual(['BAD_NAME:name']);
    expect(codes({ ...soldier, name: 'x'.repeat(25) })).toEqual(['BAD_NAME:name']);
    expect(codes({ ...soldier, name: 'a\u0007b' })).toEqual(['BAD_NAME:name']);
    expect(codes({ ...soldier, type: 'dragon' })).toEqual(['STAT_OUT_OF_RANGE:type']);
    expect(codes({ ...soldier, shape: 'star' })).toEqual(['STAT_OUT_OF_RANGE:shape']);
    const { damage: _d, ...noDamage } = soldier;
    expect(codes(noDamage)).toEqual(['STAT_MISSING:damage']);
  });

  it('towers must have speed exactly 0; soldiers 0.5-5', () => {
    expect(codes({ ...soldier, type: 'tower', speed: 1 })).toEqual(['TOWER_CANNOT_MOVE:speed']);
    expect(codes({ ...soldier, type: 'tower', speed: 0 })).toEqual([]);
    expect(codes({ ...soldier, speed: 0 })).toEqual(['STAT_OUT_OF_RANGE:speed']);
    expect(codes({ ...soldier, speed: 5.5 })).toEqual(['STAT_OUT_OF_RANGE:speed']);
  });

  it('reports every problem, not just the first', () => {
    expect(codes({ ...soldier, damage: 999, color: 'blue' })).toEqual(['STAT_OUT_OF_RANGE:damage', 'BAD_COLOR:color']);
  });
});

describe('size (§5 bounds: optional, 6-20, type default)', () => {
  it('fills the type default when omitted and keeps a legal size', () => {
    const s = checkStats(soldier, bounds);
    const t = checkStats({ ...soldier, type: 'tower', speed: 0 }, bounds);
    const big = checkStats({ ...soldier, size: 20 }, bounds);
    expect(s.ok && s.stats.size).toBe(10);
    expect(t.ok && t.stats.size).toBe(14);
    expect(big.ok && big.stats.size).toBe(20);
    expect(checkStats({ ...soldier, size: 6 }, bounds).ok).toBe(true);
  });

  it('rejects out-of-range, non-finite and wrong-type sizes', () => {
    expect(codes({ ...soldier, size: 21 })).toEqual(['STAT_OUT_OF_RANGE:size']);
    expect(codes({ ...soldier, size: 5.9 })).toEqual(['STAT_OUT_OF_RANGE:size']);
    expect(codes({ ...soldier, size: NaN })).toEqual(['STAT_NOT_FINITE:size']);
    expect(codes({ ...soldier, size: '10' })).toEqual(['STAT_WRONG_TYPE:size']);
    const r = checkStats({ ...soldier, size: 99 }, bounds);
    expect(!r.ok && r.errors[0]).toMatchObject({ allowed: { min: 6, max: 20 }, fix: expect.stringContaining('this.size') });
  });
});

describe('review regressions', () => {
  it('counts name length in characters (code points), not UTF-16 units', () => {
    const thirteen = '🔥'.repeat(13);
    const ok = checkStats({ ...soldier, name: thirteen }, bounds);
    expect(ok.ok).toBe(true);
    const r = checkStats({ ...soldier, name: '🔥'.repeat(25) }, bounds);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toMatchObject({ code: 'BAD_NAME' });
    expect(r.errors[0]!.message).toContain('it is 25 characters');
  });

  it('player hints for enum fields and the tower speed fix make sense', () => {
    const type = checkStats({ ...soldier, type: 'wizard' }, bounds);
    const shape = checkStats({ ...soldier, shape: 'star' }, bounds);
    expect(!type.ok && playerHintForIssue(type.errors[0]!)).toBe('Your unit must be a soldier or a tower. Ask Claude to fix its type.');
    expect(!shape.ok && playerHintForIssue(shape.errors[0]!)).toMatch(/circle, square, triangle or diamond/);
    const tower = checkStats({ ...soldier, type: 'tower', speed: NaN }, bounds);
    expect(!tower.ok && tower.errors[0]).toMatchObject({ code: 'STAT_NOT_FINITE', field: 'speed', fix: 'Towers never move: set this.speed = 0.' });
    const towerStr = checkStats({ ...soldier, type: 'tower', speed: 'zero' }, bounds);
    expect(!towerStr.ok && towerStr.errors[0]!.fix).toContain('Towers never move: set this.speed = 0.');
  });

  it('player hints for numbers out of range are concrete (§12.4)', () => {
    const hint = (stats: Record<string, unknown>) => {
      const r = checkStats({ ...soldier, ...stats }, bounds);
      return !r.ok && playerHintForIssue(r.errors[0]!);
    };
    const maxRange = bounds.range.max;
    expect(hint({ range: maxRange + 100 })).toBe(`Your unit's range is too big! (${maxRange + 100}, the max is ${maxRange}) Ask Claude to lower it.`);
    expect(hint({ damage: bounds.damage.max + 1 })).toMatch(/WAY too hard/);
    expect(hint({ attackCooldown: bounds.attackCooldown.min - 1 })).toMatch(/attacks too fast/);
    expect(playerHintForIssue({ code: 'UNIT_TOO_EXPENSIVE', field: 'cost', value: 612, allowed: { max: 500 }, message: '', fix: '' })).toBe(
      'Your unit costs too much! ($612, the max is $500) Ask Claude to make it cheaper.',
    );
  });
});
