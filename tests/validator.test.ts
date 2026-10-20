// §14 validator.test.ts (core set, M1): good units, one bad fixture per §7
// error code, and the core malicious fixtures. Every case runs the real
// pipeline: esbuild + a fresh isolated-vm sandbox in a child process.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  parseConfig,
  type ValidationError,
  type ValidationFailure,
  type ValidationResult,
  type ValidationSuccess,
} from '@pixel-clash/shared';
import { validate, validateDetailed, slugify } from '../packages/server/src/validator/validate.js';
import { extractFencedBlocks, normalizeSource } from '../packages/server/src/validator/normalize.js';
import { badActionReason } from '../packages/server/src/validator/dryrun.js';

const FIX = new URL('./fixtures/units/', import.meta.url);
const fixture = (path: string) => readFileSync(new URL(path, FIX), 'utf8');
const template = (file: string) =>
  readFileSync(new URL(`../packages/starter-kit/units/${file}`, import.meta.url), 'utf8');

const cfg = DEFAULT_CONFIG;
const run = (source: unknown, opts = {}) => validate(source, opts, cfg);

function expectOk(r: ValidationResult): ValidationSuccess {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.errors, null, 2)}`);
  return r;
}
function expectFail(r: ValidationResult): ValidationFailure {
  if (r.ok) throw new Error(`expected failure, got ok: ${JSON.stringify(r.unit)}`);
  return r;
}
/**
 * The first error with `code`, asserting the §7 error shape (message + fix),
 * and optionally its `field` and a key fragment of its `fix`.
 */
function errorWith(r: ValidationResult, code: string, want: { field?: string | null; fix?: string | RegExp } = {}): ValidationError {
  const f = expectFail(r);
  const e = f.errors.find((x) => x.code === code);
  if (!e) throw new Error(`expected ${code}, got ${JSON.stringify(f.errors.map((x) => x.code))}`);
  expect(e.message.length).toBeGreaterThan(5);
  expect(e.fix.length).toBeGreaterThan(5);
  expect(typeof f.kidHint).toBe('string');
  if (want.field !== undefined) expect(e.field ?? null).toBe(want.field);
  if (typeof want.fix === 'string') expect(e.fix).toContain(want.fix);
  else if (want.fix) expect(e.fix).toMatch(want.fix);
  return e;
}

/** 1-based line of the update() method definition in `source`. */
const updateDefLine = (source: string) => source.split('\n').findIndex((l) => /^\s*(async\s+)?update\s*\(/.test(l)) + 1;

/** The Basic Soldier template with update()'s body replaced. */
const soldierWithUpdate = (body: string) =>
  template('basic_soldier.js').replace('  update(self, enemies, allies, world) {\n', `  update(self, enemies, allies, world) {\n    ${body}\n`);

describe('validator: good units', () => {
  it('Basic Soldier template: $92, success shape', async () => {
    const r = expectOk(await run(template('basic_soldier.js')));
    expect(r.unit).toMatchObject({ unitId: 'basic-soldier', version: 1, cost: 92 });
    expect(r.unit.stats).toEqual({
      name: 'Basic Soldier', type: 'soldier', maxHealth: 120, damage: 10, range: 40,
      speed: 1.5, attackCooldown: 60, color: '#3399FF', size: 10, shape: 'circle',
    });
    expect(Object.isFrozen(r.unit.stats)).toBe(true);
    expect(r.unit.breakdown).toMatchObject({ factor: 1, cost: 92 });
    expect(r.unit.breakdown.sum).toBeCloseTo(91.1403084, 6);
    expect(r.unit.breakdown.parts.maxHealth.text).toBe('maxHealth 120 costs $33.46: $30 base + $3.46 for being at 24% of the max');
    expect(r.warnings).toEqual([]);
    expect(r.kidHint).toMatch(/ready/);
  });

  it('Basic Tower template: $198', async () => {
    const r = expectOk(await run(template('basic_tower.js')));
    expect(r.unit.cost).toBe(198);
    expect(r.unit.stats.size).toBe(14);
    expect(r.unit.stats.shape).toBe('square');
  });

  it.each([
    ['big_tank.js', 462],
    ['sniper_tower.js', 305],
    ['speedy_scout.js', 451],
    ['laser_sniper.js', 306],
    ['cheapest_tower.js', 17],
  ])('reference unit %s costs $%i', async (file, cost) => {
    const r = expectOk(await run(fixture(`good/${file}`)));
    expect(r.unit.cost).toBe(cost);
  });

  it('size: read from the unit, priced, and bounded to 6-20', async () => {
    const big = expectOk(await run(template('basic_soldier.js').replace('this.size = 10;', 'this.size = 20;')));
    expect(big.unit.stats.size).toBe(20);
    expect(big.unit.cost).toBe(110);
    const tooBig = await run(template('basic_soldier.js').replace('this.size = 10;', 'this.size = 21;'));
    const e = errorWith(tooBig, 'STAT_OUT_OF_RANGE', { field: 'size', fix: 'this.size' });
    expect(e.allowed).toEqual({ min: 6, max: 20 });
    const omitted = expectOk(await run(template('basic_tower.js').replace(/\n.*this\.size = 14;.*/, '')));
    expect(omitted.unit.stats.size).toBe(14);
    expect(omitted.unit.cost).toBe(198);
  });

  it('Slow Sniper (CD 90): valid, same $305 price, W_SLOW_NO_DISCOUNT', async () => {
    const r = expectOk(await run(fixture('good/slow_sniper.js')));
    expect(r.unit.cost).toBe(305);
    const w = r.warnings.find((x) => x.code === 'W_SLOW_NO_DISCOUNT');
    expect(w?.fix).toBe('Set attackCooldown to 60 for free extra damage.');
    expect(w?.message).toContain("Attacking slower than once per second doesn't make it cheaper.");
  });

  it('Big Tank (maxHealth 500, size 20): valid, with a W_STAT_NEAR_MAX tip per near-max stat', async () => {
    const r = expectOk(await run(fixture('good/big_tank.js')));
    const near = r.warnings.filter((w) => w.code === 'W_STAT_NEAR_MAX');
    expect(near.map((w) => w.field)).toEqual(['maxHealth', 'size']);
    expect(near[0]).toMatchObject({ value: 500, allowed: { max: 500, ratio: 1 } });
    expect(near[0]!.message).toBe('maxHealth is at 100% of max and costs 3× its normal price; two medium units usually beat one maxed one.');
    expect(near[0]!.fix).toBe("If you don't need it this high, set this.maxHealth to 300: that saves $246 (cost $216) to spend on another unit.");
    // Basic templates stay well below 80% of every max: no tip.
    expect(expectOk(await run(template('basic_tower.js'))).warnings).toEqual([]);
  });

  it('a stat at 96% of max: the tip says how much more it costs', async () => {
    const r = expectOk(await run(template('basic_soldier.js').replace('this.maxHealth = 120;', 'this.maxHealth = 480;')));
    const w = r.warnings.find((x) => x.code === 'W_STAT_NEAR_MAX');
    expect(w?.message).toBe('maxHealth is at 96% of max and costs 2.84× its normal price; two medium units usually beat one maxed one.');
    expect(r.kidHint).toContain('Two medium units usually beat one giant one!');
  });

  it('cheapest tower (damage 0) gets W_ZERO_DAMAGE', async () => {
    const r = expectOk(await run(fixture('good/cheapest_tower.js')));
    expect(r.warnings.map((w) => w.code)).toContain('W_ZERO_DAMAGE');
  });

  it('accepts TypeScript syntax', async () => {
    const r = expectOk(await run(fixture('good/typescript_unit.js')));
    expect(r.unit.stats.name).toBe('Typed Trooper');
    expect(r.unit.cost).toBe(92); // size omitted: priced at the soldier default 10
  });

  it('accepts a unit wrapped in markdown fences with prose around it (CRLF too)', async () => {
    const md = [
      "Here's your unit! It's a soldier that charges.",
      '',
      '```javascript',
      template('basic_soldier.js'),
      '```',
      '',
      'Paste it into units/charger.js and submit it.',
    ].join('\r\n');
    const r = expectOk(await run(md));
    expect(r.unit.cost).toBe(92);
  });

  it('uses the given unitId for a revision, even after a rename', async () => {
    const src = template('basic_soldier.js').replace("'Basic Soldier'", "'Swift Ninja II'");
    const r = expectOk(await run(src, { unitId: 'swift-ninja', version: 3 }));
    expect(r.unit).toMatchObject({ unitId: 'swift-ninja', version: 3 });
    expect(r.unit.stats.name).toBe('Swift Ninja II');
  });

  it('validateDetailed returns compiled CJS with an inline source map and the sha256', async () => {
    const d = await validateDetailed(template('basic_soldier.js'), {}, cfg);
    expect(d.result.ok).toBe(true);
    expect(d.compiledJs).toMatch(/module\.exports/);
    expect(d.compiledJs).toMatch(/sourceMappingURL=data:application\/json;base64,/);
    expect(d.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('slugify', () => {
    expect(slugify('Swift Ninja II')).toBe('swift-ninja-ii');
    expect(slugify('  Ünïcode — Tank!! ')).toBe('unicode-tank');
    expect(slugify('!!!')).toBe('unit');
  });
});

describe('validator: step 1 normalize', () => {
  it('SOURCE_TOO_LARGE over 64 KB (§7 step 1)', async () => {
    const e = errorWith(await run(`// ${'x'.repeat(64 * 1024)}\n${template('basic_soldier.js')}`), 'SOURCE_TOO_LARGE', {
      field: 'source',
    });
    expect(e.allowed).toEqual({ maxBytes: 65536 });
  });

  it('a 30 KB unit (sprites take room) passes step 1', async () => {
    const r = expectOk(await run(`// ${'x'.repeat(30 * 1024)}\n${template('basic_soldier.js')}`));
    expect(r.unit.cost).toBe(92);
  });

  it('EMPTY_SOURCE for blank text and for an empty fence', async () => {
    errorWith(await run('   \n\t'), 'EMPTY_SOURCE', { field: 'source' });
    errorWith(await run('Sure!\n```js\n```\n'), 'EMPTY_SOURCE', { field: 'source' });
    errorWith(await run(undefined), 'EMPTY_SOURCE', { field: 'source' });
  });

  it('picks the fenced block with the default export', () => {
    const blocks = extractFencedBlocks('a\n```bash\nnpm test\n```\n```ts\nexport default class A {}\n```\n');
    expect(blocks).toHaveLength(2);
    const n = normalizeSource('a\n```bash\nnpm test\n```\n```ts\nexport default class A {}\n```\n', 20480);
    expect(n).toEqual({ ok: true, source: 'export default class A {}\n' });
  });
});

describe('validator: bad fixtures (one per error code)', () => {
  it('SYNTAX_ERROR has line, column, excerpt and errorMessage', async () => {
    const e = errorWith(await run(fixture('bad/syntax_error.js')), 'SYNTAX_ERROR');
    expect(e.line).toBe(4);
    expect(e.column).toBeGreaterThan(1);
    expect(e.excerpt).toContain('this.damage = (10;');
    expect(e.errorMessage).toBeTruthy();
  });

  it('SYNTAX_ERROR column counts characters, not UTF-8 bytes', async () => {
    const line = "    this.name = 'héllo wörld'; this.x = (1;";
    const src = `export default class A {\n  constructor() {\n${line}\n  }\n}\n`;
    const e = errorWith(await run(src), 'SYNTAX_ERROR');
    expect(e.line).toBe(3);
    expect(e.column).toBe(line.indexOf('(1;') + 3); // the ';' (1-based)
  });

  it.each(['import_from.js', 'dynamic_import.js', 'require.js'])('IMPORT_NOT_ALLOWED: %s', async (file) => {
    const e = errorWith(await run(fixture(`bad/${file}`)), 'IMPORT_NOT_ALLOWED');
    expect(e.line).toBeGreaterThan(0);
    expect(e.fix).toMatch(/Remove every import/);
  });

  it('NO_DEFAULT_EXPORT', async () => {
    errorWith(await run(fixture('bad/no_default_export.js')), 'NO_DEFAULT_EXPORT', { field: 'source', fix: 'export default class' });
  });

  it.each(['not_a_class.js', 'arrow_default.js'])('NOT_A_CLASS: %s', async (file) => {
    errorWith(await run(fixture(`bad/${file}`)), 'NOT_A_CLASS', { field: 'source', fix: 'export default class' });
  });

  it('EVAL_THREW points at the line in the original source', async () => {
    const e = errorWith(await run(fixture('bad/eval_threw.js')), 'EVAL_THREW', { fix: 'top level' });
    expect(e.line).toBe(2);
    expect(e.excerpt).toContain('table[0]');
    expect(e.errorMessage).toMatch(/TypeError/);
  });

  it('CONSTRUCTOR_THREW points at the line in the original source', async () => {
    const e = errorWith(await run(fixture('bad/constructor_threw.js')), 'CONSTRUCTOR_THREW', { field: 'constructor', fix: 'Fix the constructor' });
    expect(e.line).toBe(5);
    expect(e.column).toBeGreaterThan(0);
    expect(e.excerpt).toContain('this.config.hp');
  });

  it('STAT_MISSING', async () => {
    const e = errorWith(await run(fixture('bad/stat_missing.js')), 'STAT_MISSING');
    expect(e.field).toBe('color');
    expect(e.fix).toContain('this.color');
  });

  it('STAT_IS_GETTER', async () => {
    const e = errorWith(await run(fixture('bad/stat_is_getter.js')), 'STAT_IS_GETTER');
    expect(e.field).toBe('damage');
    expect(e.fix).toContain('this.damage');
  });

  it('STAT_OUT_OF_RANGE: damage 999 (the §7 example)', async () => {
    const r = expectFail(await run(fixture('bad/stat_out_of_range.js')));
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
    expect(r.cost).toBeNull();
    expect(r.warnings).toEqual([]);
    expect(r.kidHint).toBe('Whoa, that unit hits WAY too hard! Ask Claude to lower its damage.');
  });

  it('STAT_OUT_OF_RANGE: -5', async () => {
    const e = errorWith(await run(fixture('bad/negative_stat.js')), 'STAT_OUT_OF_RANGE');
    expect(e).toMatchObject({ field: 'maxHealth', value: -5 });
  });

  it('STAT_WRONG_TYPE: "100" is not coerced', async () => {
    const e = errorWith(await run(fixture('bad/stat_wrong_type.js')), 'STAT_WRONG_TYPE');
    expect(e).toMatchObject({ field: 'maxHealth', value: '100' });
  });

  it.each([
    ['stat_not_finite.js', 'Infinity'],
    ['stat_nan.js', 'NaN'],
  ])('STAT_NOT_FINITE: %s', async (file, value) => {
    const e = errorWith(await run(fixture(`bad/${file}`)), 'STAT_NOT_FINITE');
    expect(e).toMatchObject({ field: 'maxHealth', value });
  });

  it('COOLDOWN_NOT_INTEGER', async () => {
    errorWith(await run(fixture('bad/cooldown_not_integer.js')), 'COOLDOWN_NOT_INTEGER', {
      field: 'attackCooldown',
      fix: 'whole number',
    });
  });

  it('BAD_COLOR', async () => {
    const e = errorWith(await run(fixture('bad/bad_color.js')), 'BAD_COLOR');
    expect(e).toMatchObject({ field: 'color', value: 'red' });
  });

  it('BAD_NAME', async () => {
    const e = errorWith(await run(fixture('bad/bad_name.js')), 'BAD_NAME');
    expect(e.field).toBe('name');
  });

  it('TOWER_CANNOT_MOVE', async () => {
    const e = errorWith(await run(fixture('bad/tower_cannot_move.js')), 'TOWER_CANNOT_MOVE');
    expect(e).toMatchObject({ field: 'speed', value: 2 });
  });

  it('STATS_NOT_STABLE (Math.random in the constructor)', async () => {
    const e = errorWith(await run(fixture('bad/stats_not_stable.js')), 'STATS_NOT_STABLE', { field: 'maxHealth', fix: /Math\.random/ });
    expect(Array.isArray(e.value) && e.value).toHaveLength(2);
    expect((e.value as unknown[])[0]).not.toEqual((e.value as unknown[])[1]);
  });

  it('UNIT_TOO_EXPENSIVE: Scout with cooldown 10 gives the exact §7 fix text', async () => {
    const r = expectFail(await run(fixture('bad/too_expensive.js')));
    const e = errorWith(r, 'UNIT_TOO_EXPENSIVE');
    expect(e.fix).toBe(
      'Cost is $902 but the max is $500. The ×6 cooldown factor is the biggest cost: raising attackCooldown from 10 to 20 makes it ×3 ($451). ' +
        'The most expensive stat is speed: 4 costs $109.44 before the factor ($48 base + $61.44 for being 80% of the max). ' +
        'Lowering speed from 4 to 2 saves $467 ($435).',
    );
    expect(e.breakdown).toMatchObject({ sum: 150.172, factor: 6, cost: 902 });
    expect(r.cost).toBe(902);
  });

  it('UNIT_TOO_EXPENSIVE: everything maxed ($6216)', async () => {
    const r = expectFail(await run(fixture('bad/everything_maxed.js')));
    errorWith(r, 'UNIT_TOO_EXPENSIVE');
    expect(r.cost).toBe(6216);
  });

  it('UPDATE_MISSING', async () => {
    errorWith(await run(fixture('bad/update_missing.js')), 'UPDATE_MISSING', { field: 'update', fix: 'Add an update(' });
  });

  it('UPDATE_THREW with the original line', async () => {
    const e = errorWith(await run(fixture('bad/update_threw.js')), 'UPDATE_THREW', { field: 'update', fix: 'around line 14' });
    expect(e.line).toBe(14);
    expect(e.excerpt).toContain('target.id');
    expect(e.errorMessage).toMatch(/TypeError/);
  });

  it('BAD_ACTION', async () => {
    const src = fixture('bad/bad_action.js');
    const e = errorWith(await run(src), 'BAD_ACTION', { field: 'update', fix: "{ action: 'idle' }" });
    expect(e.value).toEqual({ action: 'charge', speed: 'fast' });
    expect(e.line).toBe(updateDefLine(src));
    expect(e.line).toBe(12);
    expect(e.excerpt).toContain('update() {');
    expect(e.errorMessage).toMatch(/"action" must be/);
  });

  it.each([
    ['null', 'return null;', 'null'],
    ['attack without a string id', "return { action: 'attack', targetId: 5 };", 'targetId'],
    ['NaN destination', "return { action: 'move', destination: { x: NaN, y: 1 } };", 'finite numbers'],
  ])('BAD_ACTION on a template-based unit (%s) points at the update() definition, not a comment', async (_label, body, reason) => {
    const src = soldierWithUpdate(body);
    const e = errorWith(await run(src), 'BAD_ACTION', { field: 'update' });
    expect(e.line).toBe(updateDefLine(src));
    expect(src.split('\n')[e.line! - 1]).toBe('  update(self, enemies, allies, world) {');
    expect(e.excerpt).toContain('update(self, enemies, allies, world) {');
    expect(e.column).toBe(3);
    expect(e.errorMessage).toContain(reason);
  });

  it('UPDATE_THREW for a thrown non-Error falls back to the update() line', async () => {
    const src = soldierWithUpdate('throw 42;');
    const e = errorWith(await run(src), 'UPDATE_THREW', { field: 'update' });
    expect(e.errorMessage).toBe('threw 42');
    expect(e.line).toBe(updateDefLine(src));
    expect(e.excerpt).toContain('update(self, enemies, allies, world) {');
  });

  it('badActionReason', () => {
    expect(badActionReason(undefined)).toBeUndefined();
    expect(badActionReason({ action: 'idle' })).toBeUndefined();
    expect(badActionReason({ action: 'attack', targetId: '1-0-0' })).toBeUndefined();
    expect(badActionReason({ action: 'move', destination: { x: 1, y: 2 } })).toBeUndefined();
    expect(badActionReason({ action: 'move', destination: { x: 'a', y: 2 } })).toBeTruthy();
    expect(badActionReason({ action: 'attack' })).toBeTruthy();
    expect(badActionReason(null)).toBeTruthy();
    expect(badActionReason('attack')).toBeTruthy();
  });
});

describe('validator: warnings (§7 step 10)', () => {
  const codes = (r: ValidationResult) => expectOk(r).warnings.map((w) => w.code);

  it('W_NEVER_ATTACKS and W_NEVER_MOVES for a soldier that always idles', async () => {
    const r = expectOk(await run(soldierWithUpdate("return { action: 'idle' };")));
    expect(r.warnings.map((w) => w.code)).toEqual(['W_NEVER_ATTACKS', 'W_NEVER_MOVES']);
    expect(r.warnings[0]).toMatchObject({ field: 'update', fix: expect.stringContaining("action: 'attack'") });
    expect(r.warnings[1]).toMatchObject({ field: 'update', fix: expect.stringContaining("action: 'move'") });
    expect(r.kidHint).toMatch(/never attacks/);
  });

  it('W_NEVER_MOVES alone for a soldier that attacks but never walks', async () => {
    const body = "if (enemies.length > 0) return { action: 'attack', targetId: enemies[0].id }; return { action: 'idle' };";
    expect(codes(await run(soldierWithUpdate(body)))).toEqual(['W_NEVER_MOVES']);
  });

  it('W_RETURNS_NOTHING when update() sometimes returns undefined', async () => {
    const r = expectOk(await run(soldierWithUpdate('if (enemies.length === 0) return undefined;')));
    expect(r.warnings.map((w) => w.code)).toEqual(['W_RETURNS_NOTHING']);
    expect(r.warnings[0]).toMatchObject({ field: 'update', fix: expect.stringContaining("{ action: 'idle' }") });
  });

  it('W_SLOW when update() is slower than the warning limit', async () => {
    // A roomy per-call timeout so a slow machine can't turn this into UPDATE_TIMEOUT.
    const slowCfg = parseConfig({ sandbox: { validation: { slowUpdateWarnMs: 1, dryRunCallTimeoutMs: 500 } } });
    const body = 'let s = 0; for (let i = 0; i < 2e7; i++) s += i % 7; if (s < 0) return undefined;';
    const r = expectOk(await validate(soldierWithUpdate(body), {}, slowCfg));
    const w = r.warnings.find((x) => x.code === 'W_SLOW');
    expect(w).toMatchObject({ field: 'update', allowed: { maxMs: 1 }, fix: expect.stringContaining('cheaper') });
    expect(w?.value as number).toBeGreaterThan(1);
  });
});

describe('validator: malicious fixtures', () => {
  it('while(true) at the top level -> TIMEOUT within the budget', async () => {
    const t = performance.now();
    const e = errorWith(await run(fixture('malicious/loop_toplevel.js')), 'TIMEOUT', { field: 'source', fix: 'endless loops' });
    expect(e.allowed).toEqual({ maxMs: 1000 });
    expect(performance.now() - t).toBeLessThan(3000);
  });

  it('while(true) in the constructor -> TIMEOUT (50 ms)', async () => {
    const e = errorWith(await run(fixture('malicious/loop_constructor.js')), 'TIMEOUT', { field: 'constructor', fix: 'while (true)' });
    expect(e).toMatchObject({ field: 'constructor', allowed: { maxMs: 50 } });
  });

  it('while(true) in update -> UPDATE_TIMEOUT', async () => {
    const e = errorWith(await run(fixture('malicious/loop_update.js')), 'UPDATE_TIMEOUT', { field: 'update', fix: 'endless loops' });
    expect(e.allowed).toEqual({ maxMs: 20 });
  });

  it('a 500 MB array is a clean error, and the server stays healthy', async () => {
    const r = expectFail(await run(fixture('malicious/huge_array.js')));
    expect(['EVAL_THREW', 'TIMEOUT']).toContain(r.errors[0]?.code);
    // The host process is fine and the next validation works.
    expectOk(await run(template('basic_soldier.js')));
  });

  it('memory exhaustion in update -> UPDATE_THREW (out of memory)', async () => {
    const r = expectFail(await run(fixture('malicious/array_bomb.js')));
    expect(['UPDATE_THREW', 'UPDATE_TIMEOUT']).toContain(r.errors[0]?.code);
  });

  it('getter stats -> STAT_IS_GETTER', async () => {
    const r = expectFail(await run(fixture('malicious/getter_stats.js')));
    const fields = r.errors.filter((e) => e.code === 'STAT_IS_GETTER').map((e) => e.field);
    expect(fields.sort()).toEqual(['damage', 'maxHealth']);
  });

  it('random stats -> STATS_NOT_STABLE', async () => {
    errorWith(await run(fixture('malicious/random_stats.js')), 'STATS_NOT_STABLE');
  });

  it('globalThis.constructor.constructor("return process")() -> EVAL_THREW (no process exists)', async () => {
    const e = errorWith(await run(fixture('malicious/constructor_escape.js')), 'EVAL_THREW', { field: null });
    expect(e.errorMessage).toMatch(/process is not defined/);
    expect(e.line).toBe(2);
  });

  it('process.exit / fetch in update -> UPDATE_THREW (they do not exist)', async () => {
    const e = errorWith(await run(fixture('malicious/process_exit.js')), 'UPDATE_THREW');
    expect(e.errorMessage).toMatch(/process is not defined/);
  });

  it('fetch at the top level -> EVAL_THREW', async () => {
    const e = errorWith(await run(fixture('malicious/fetch.js')), 'EVAL_THREW');
    expect(e.errorMessage).toMatch(/fetch is not defined/);
  });

  it('deep recursion -> EVAL_THREW (RangeError)', async () => {
    const e = errorWith(await run(fixture('malicious/deep_recursion.js')), 'EVAL_THREW');
    expect(e.errorMessage).toMatch(/RangeError/);
  });

  it('Object.prototype pollution: inherited stats are STAT_MISSING', async () => {
    const e = errorWith(await run(fixture('malicious/proto_pollution.js')), 'STAT_MISSING');
    expect(e.field).toBe('damage');
    expect(e.message).toMatch(/inherited/);
  });

  it('throwing a non-Error -> CONSTRUCTOR_THREW with the thrown value', async () => {
    const e = errorWith(await run(fixture('malicious/throw_non_error.js')), 'CONSTRUCTOR_THREW');
    expect(e.errorMessage).toBe('threw "boom"');
  });

  it.each(['async_update.js', 'returns_promise.js'])('%s -> BAD_ACTION (Promise)', async (file) => {
    const e = errorWith(await run(fixture(`malicious/${file}`)), 'BAD_ACTION');
    expect(e.value).toBe('Promise');
  });

  it('a getter-laden returned object -> UPDATE_THREW', async () => {
    const e = errorWith(await run(fixture('malicious/getter_action.js')), 'UPDATE_THREW');
    expect(e.errorMessage).toMatch(/gotcha/);
  });

  it('an infinite microtask chain -> UPDATE_TIMEOUT', async () => {
    errorWith(await run(fixture('malicious/microtask_loop.js')), 'UPDATE_TIMEOUT');
  });

  it.each([
    ['wasm_memory.js', /WebAssembly is not defined/],
    ['resizable_buffer.js', /resiz/i],
    ['growable_sab.js', /SharedArrayBuffer is not defined/],
  ])('memory the isolate limit cannot count (%s) -> EVAL_THREW', async (file, re) => {
    const t = performance.now();
    const e = errorWith(await run(fixture(`malicious/${file}`)), 'EVAL_THREW');
    expect(e.errorMessage).toMatch(re);
    expect(performance.now() - t).toBeLessThan(3000);
  });

  it('a 12 MB thrown message comes back bounded (UPDATE_THREW)', async () => {
    const r = expectFail(await run(fixture('malicious/tojson_bomb.js')));
    const e = errorWith(r, 'UPDATE_THREW', { field: 'update' });
    expect(e.errorMessage).toMatch(/^Error: AAAA/);
    expect(e.errorMessage!.length).toBeLessThanOrEqual(310);
    expect(JSON.stringify(r).length).toBeLessThan(10_000);
  });

  it('a microtask at the top level cannot reach the harness (no __load/__tick)', async () => {
    const r = expectFail(await run(fixture('malicious/design_swap.js')));
    // It has no stats, so it fails there; the point is it doesn't crash or escape.
    expect(r.errors[0]?.code).toBe('STAT_MISSING');
  });

  it('this.damage = 9999 inside update() does not change the snapshot', async () => {
    const r = expectOk(await run(fixture('malicious/stat_mutation.js')));
    expect(r.unit.stats.damage).toBe(10);
    expect(r.unit.stats.maxHealth).toBe(120);
  });

  it('harness tampering at load time does not break validation', async () => {
    const r = expectOk(await run(fixture('malicious/tick_hijack.js')));
    expect(r.unit.cost).toBe(92);
  });

  it('the validator honours config (bounds/caps)', async () => {
    const tight = parseConfig({ caps: { unitCost: 91 } });
    const r = expectFail(await validate(template('basic_soldier.js'), {}, tight));
    expect(r.errors[0]?.code).toBe('UNIT_TOO_EXPENSIVE');
  });
});

describe('validator: sprites (§7 step 8b)', () => {
  it('templates: the stored sprite is the normalized 16x16 spec (idle 2, walk 2, attack 1)', async () => {
    for (const file of ['basic_soldier.js', 'basic_tower.js']) {
      const r = expectOk(await run(template(file)));
      const s = r.unit.sprite;
      expect(s, file).not.toBeNull();
      expect(s!.grid).toBe(16);
      expect(s!.frames.idle).toHaveLength(2);
      expect(s!.frames.walk).toHaveLength(2);
      expect(s!.frames.attack).toHaveLength(1);
      expect(r.warnings.map((w) => w.code)).not.toContain('W_NO_SPRITE');
    }
  });

  it('a good 8x8 sprite is stored with upper-case palette colours', async () => {
    const r = expectOk(await run(fixture('good/pixel_bat.js')));
    expect(r.unit.sprite?.grid).toBe(8);
    expect(r.unit.sprite?.palette).toEqual({ o: '#1A1428', g: '#33CC66', w: '#FFFFFF' });
    expect(r.unit.sprite?.frames.walk).toHaveLength(2);
    expect(r.warnings).toEqual([]);
  });

  it('missing sprite() -> W_NO_SPRITE (still valid, sprite null)', async () => {
    const r = expectOk(await run(fixture('good/speedy_scout.js')));
    expect(r.unit.sprite).toBeNull();
    const w = r.warnings.find((x) => x.code === 'W_NO_SPRITE');
    expect(w?.fix).toMatch(/sprite\(\)/);
    expect(r.kidHint).toContain('Ask Claude to draw a pixel-art sprite for your unit!');
  });

  it('SPRITE_BAD_FRAME: wrong row length names state, frame, row and col', async () => {
    const e = errorWith(await run(fixture('bad/sprite_row_length.js')), 'SPRITE_BAD_FRAME', { fix: 'exactly 8' });
    expect(e).toMatchObject({ state: 'walk', frame: 1, row: 3, col: 7, field: 'sprite.frames.walk[1][3]' });
  });

  it('SPRITE_BAD_FRAME: unknown palette char', async () => {
    const e = errorWith(await run(fixture('bad/sprite_unknown_char.js')), 'SPRITE_BAD_FRAME', { fix: 'palette' });
    expect(e).toMatchObject({ state: 'idle', frame: 0, row: 2, col: 3, value: 'x' });
  });

  it('SPRITE_TOO_MANY_FRAMES: 9 walk frames', async () => {
    const e = errorWith(await run(fixture('bad/sprite_too_many_frames.js')), 'SPRITE_TOO_MANY_FRAMES', { field: 'sprite.frames.walk' });
    expect(e).toMatchObject({ state: 'walk', value: 9, allowed: { min: 1, max: 4 } });
  });

  it('SPRITE_EMPTY: an all-transparent idle frame', async () => {
    const e = errorWith(await run(fixture('bad/sprite_empty_idle.js')), 'SPRITE_EMPTY', { fix: 'frames.idle[0]' });
    expect(e).toMatchObject({ state: 'idle', frame: 0, value: { opaquePixels: 0 }, allowed: { minOpaquePixels: 7 } });
  });

  it('SPRITE_BAD_GRID and SPRITE_BAD_PALETTE', async () => {
    const g = errorWith(await run(fixture('bad/sprite_bad_grid.js')), 'SPRITE_BAD_GRID', { field: 'sprite.grid', fix: 'grid: 16' });
    expect(g.value).toBe(10);
    const p = errorWith(await run(fixture('bad/sprite_bad_palette.js')), 'SPRITE_BAD_PALETTE', { field: 'sprite.palette.g', fix: '#RRGGBB' });
    expect(p.value).toBe('green');
  });

  it('SPRITE_THREW points at the line in the original source', async () => {
    const src = fixture('bad/sprite_threw.js');
    const e = errorWith(await run(src), 'SPRITE_THREW', { field: 'sprite' });
    expect(e.errorMessage).toContain('out of ink');
    expect(src.split('\n')[e.line! - 1]).toContain("throw new Error('out of ink')");
  });

  it('a 300 KB sprite -> SPRITE_THREW (max 200 KB)', async () => {
    const e = errorWith(await run(fixture('bad/sprite_huge.js')), 'SPRITE_THREW', { field: 'sprite' });
    expect(e.allowed).toEqual({ maxBytes: 200 * 1024 });
    expect((e.value as { bytes: number }).bytes).toBeGreaterThan(300 * 1024);
  });

  it('random pixels -> SPRITE_NOT_STABLE', async () => {
    errorWith(await run(fixture('malicious/sprite_random.js')), 'SPRITE_NOT_STABLE', { fix: 'Math.random' });
  });

  it('while(true) in sprite() -> SPRITE_THREW (50 ms), then the update() dry-run still runs', async () => {
    const t0 = performance.now();
    const r = await run(fixture('malicious/sprite_loop.js'));
    const e = errorWith(r, 'SPRITE_THREW', { field: 'sprite' });
    expect(e.allowed).toEqual({ maxMs: 50 });
    expect(expectFail(r).errors.map((x) => x.code)).toEqual(['SPRITE_THREW']);
    expect(performance.now() - t0).toBeLessThan(5000);
    expectOk(await run(template('basic_soldier.js')));
  });

  it('a throwing toJSON -> SPRITE_THREW', async () => {
    const e = errorWith(await run(fixture('malicious/sprite_tojson.js')), 'SPRITE_THREW');
    expect(e.errorMessage).toContain('no copy for you');
  });

  it('sprite errors are reported together with a cost error', async () => {
    const src = fixture('bad/sprite_bad_grid.js').replace('this.attackCooldown = 60;', 'this.attackCooldown = 10;').replace('this.speed = 1.5;', 'this.speed = 5;');
    const r = expectFail(await run(src));
    expect(r.errors.map((e) => e.code)).toEqual(['UNIT_TOO_EXPENSIVE', 'SPRITE_BAD_GRID']);
  });

  it('size 5 and 21 -> STAT_OUT_OF_RANGE', async () => {
    for (const size of [5, 21]) {
      const r = await run(template('basic_soldier.js').replace('this.size = 10;', `this.size = ${size};`));
      expect(errorWith(r, 'STAT_OUT_OF_RANGE', { field: 'size' }).value).toBe(size);
    }
  });
});
