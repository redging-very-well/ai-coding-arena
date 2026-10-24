// The §7 validation pipeline, steps 1-10.
//
//   1 normalize        (normalize.ts)   SOURCE_TOO_LARGE, EMPTY_SOURCE
//   2 transpile        (transpile.ts)   SYNTAX_ERROR
//   3 import check     (transpile.ts)   IMPORT_NOT_ALLOWED
//   4 evaluate         harness load     NO_DEFAULT_EXPORT, NOT_A_CLASS, EVAL_THREW, TIMEOUT
//   5 construct twice  harness spawn + stats (own data properties only)
//                                       CONSTRUCTOR_THREW, STAT_MISSING, STAT_IS_GETTER
//   6 hard guards      shared checkStats()
//   7 determinism      both constructions identical -> else STATS_NOT_STABLE
//   8 cost             shared computeCost(), cap -> UNIT_TOO_EXPENSIVE (names the biggest lever)
//  8b sprite           (sprite.ts)      SPRITE_*, W_NO_SPRITE
//   9 dry-run update() (dryrun.ts)      UPDATE_MISSING, UPDATE_THREW, UPDATE_TIMEOUT, BAD_ACTION
//  10 warnings                          W_* (non-fatal)
//
// Every call gets a FRESH sandbox (isolated-vm in a child process by default,
// 32 MB), disposed afterwards. Nothing is stored here: the units service
// decides what to keep (`validateDetailed` returns the compiled code too).

import { createHash } from 'node:crypto';
import {
  STAT_FIELDS,
  SUCCESS_PLAYER_HINT,
  burstOf,
  checkStats,
  computeCost,
  expectedMinions,
  playerHintFor,
  playerHintForIssue,
  nearMaxWarnings,
  powerHighWarning,
  pricingOf,
  supportOf,
  tooExpensiveError,
  type GameConfig,
  type MinionOrder,
  type StatsSnapshot,
  type ValidationError,
  type ValidationResult,
  type ValidationWarning,
} from '@pixel-clash/shared';
import { unitFilename } from '../sandbox/harness.js';
import { ivmSessionOpener } from '../sandbox/ivmRunner.js';
import {
  DEFAULT_DEADLINE_SLACK_MS,
  asHarnessError,
  isMemoryCrash,
  parseObject,
  type CallOutcome,
  type SandboxSession,
  type SessionOpener,
} from '../sandbox/session.js';
import { LineMapper, splitInlineSourceMap } from '../sandbox/sourcemap.js';
import { locate, type Ctx } from './context.js';
import { dryRun } from './dryrun.js';
import { normalizeSource } from './normalize.js';
import { spriteStep } from './sprite.js';
import { transpile } from './transpile.js';

export interface ValidateOptions {
  /** Revise this design (§7 "Unit identity"); otherwise the id is the name's slug. */
  unitId?: string;
  /** Version number to report (the units service knows it; default 1). */
  version?: number;
  /** Sandbox to run the code in. Default: isolated-vm in a child process. */
  openSession?: SessionOpener;
  /** Run the step-9 dry-run of update() (default true). */
  dryRun?: boolean;
}

export interface ValidationDetails {
  result: ValidationResult;
  /** Normalized source (after step 1), when step 1 passed. */
  source?: string;
  /** Compiled CJS with an inline source map (what the battle runner loads), when step 3 passed. */
  compiledJs?: string;
  /** sha256 of the normalized source. */
  sha256?: string;
}

/** Seed for Math.random inside the validation sandbox. */
const VALIDATION_SEED = 0x5eed;
const DESIGN_ID = 'unit';

/** URL-safe slug of a unit name: "Swift Ninja II" -> "swift-ninja-ii". */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug || 'unit';
}

/** Validate a unit and return the §7 result body. */
export async function validate(source: unknown, opts: ValidateOptions, config: GameConfig): Promise<ValidationResult> {
  return (await validateDetailed(source, opts, config)).result;
}

/** Validate a unit; also returns the compiled code for `submit_unit` to store. */
export async function validateDetailed(source: unknown, opts: ValidateOptions, config: GameConfig): Promise<ValidationDetails> {
  // 1. Normalize.
  const norm = normalizeSource(source, config.caps.maxSourceBytes);
  if (!norm.ok) return { result: failure([norm.error]) };
  const src = norm.source;
  const sha256 = createHash('sha256').update(src).digest('hex');

  // 2-3. Transpile + import check.
  const tr = await transpile(src);
  if (!tr.ok) return { result: failure([tr.error]), source: src, sha256 };
  const { compiledJs } = tr;
  const details = { source: src, compiledJs, sha256 };
  const ctx: Ctx = { source: src, mapper: new LineMapper(splitInlineSourceMap(compiledJs).mappings), config };

  // 4-10 run in a fresh sandbox.
  const open = opts.openSession ?? ivmSessionOpener();
  let session: SandboxSession;
  try {
    session = await open({ memoryLimitMb: config.sandbox.memoryLimitMb, seed: VALIDATION_SEED });
  } catch (err) {
    // Infrastructure failure, not the player's fault.
    throw new Error(`could not start the validation sandbox: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return { ...details, result: await runSandboxSteps(session, compiledJs, opts, ctx) };
  } finally {
    session.dispose();
  }
}

async function runSandboxSteps(
  session: SandboxSession,
  compiledJs: string,
  opts: ValidateOptions,
  ctx: Ctx,
): Promise<ValidationResult> {
  const { validation } = ctx.config.sandbox;

  // 4. Evaluate.
  const evalBudget = validation.evalBudgetMs;
  const loaded = await session.load(DESIGN_ID, unitFilename(0), compiledJs, evalBudget, {
    deadlineMs: evalBudget + DEFAULT_DEADLINE_SLACK_MS,
  });
  const loadError = evaluateError(loaded, ctx);
  if (loadError) return failure([loadError]);

  // 5. Construct twice and read the stats.
  const reads: StatRead[] = [];
  let hasUpdate = false;
  const checkIds = ['check-1', 'check-2'] as const;
  for (const instanceId of checkIds) {
    const t = validation.constructTimeoutMs;
    const spawned = await session.call('spawn', [instanceId, DESIGN_ID], t, { deadlineMs: t + DEFAULT_DEADLINE_SLACK_MS });
    const spawnErr = constructError(spawned, ctx);
    if (spawnErr) return failure([spawnErr]);
    if (spawned.kind === 'ok') hasUpdate = parseObject(spawned.value)?.hasUpdate === true;
    const st = await session.call('stats', [instanceId], t, { deadlineMs: t + DEFAULT_DEADLINE_SLACK_MS });
    const read = decodeStats(st, ctx);
    if ('error' in read) return failure([read.error]);
    reads.push(read);
  }
  const [first, second] = reads as [StatRead, StatRead];

  // 5-6. Shape of the properties + hard guards.
  const errors: ValidationError[] = [...first.shapeErrors];
  const skip = new Set(first.shapeErrors.map((e) => e.field));
  const checked = checkStats(first.raw, ctx.config.stats.bounds);
  if (!checked.ok) {
    for (const e of checked.errors) {
      if (skip.has(e.field)) continue;
      const kind = first.otherTypes.get(e.field ?? '');
      errors.push(kind ? { ...e, value: `[${kind}]` } : e);
    }
  }

  // 7. Determinism.
  const unstable = STAT_FIELDS.filter((f) => first.encoded[f] !== second.encoded[f]);
  if (unstable.length > 0) {
    const f = unstable[0]!;
    errors.push({
      code: 'STATS_NOT_STABLE',
      field: f,
      value: [displayValue(first.raw[f]), displayValue(second.raw[f])],
      message: `The stats changed between two constructions (${unstable.join(', ')}). Building the unit twice gave ${f} = ${String(displayValue(first.raw[f]))} and then ${String(displayValue(second.raw[f]))}.`,
      fix: `Set ${unstable.map((u) => `this.${u}`).join(', ')} to fixed values in the constructor. Don't use Math.random(), Date.now() or counters to pick stats.`,
    });
  }

  const stats: StatsSnapshot | undefined = checked.ok && errors.length === 0 ? checked.stats : undefined;
  // The stat hints (e.g. W_STAT_IGNORED) come back with the errors, so every fix shows at once.
  if (!stats) return failure(errors, checked.warnings);

  // 8. Cost (per type, §6; a factory's production follows the config's battle length and minion).
  const pricing = pricingOf(ctx.config);
  const priced = computeCost(stats, ctx.config.cost, pricing);
  const cap = ctx.config.caps.unitCost;
  const warnings = [...(checked.ok ? checked.warnings : []), ...statWarnings(stats, ctx.config)];
  if (!Number.isFinite(priced.raw) || priced.cost > cap) {
    errors.push(tooExpensiveError(stats, priced, cap, ctx.config.cost, ctx.config.stats.bounds, pricing));
  }

  // 8b. Sprite (reported together with the other errors, so Claude can fix
  // everything in one go).
  const sp = await spriteStep(session, checkIds, ctx);
  errors.push(...sp.errors);
  warnings.push(...sp.warnings);

  // M8.6: the squad orders a factory's update() gave in the dry run (for its card, §12.5).
  let orders: MinionOrder[] | undefined;
  // M8.8: whether a heal-support unit's update() healed in the dry run (for its card).
  let healUsed: boolean | undefined;
  // 9-10. Dry-run update() (unless sprite() took the sandbox down). Walls have
  // no code that runs in battle: an update() on one is ignored (§5.2).
  if (stats.type === 'wall') {
    if (hasUpdate) {
      warnings.push({
        code: 'W_UPDATE_IGNORED',
        field: 'update',
        message: "Walls don't think: this wall's update() is never called.",
        fix: 'Remove update() from the wall (a wall only needs name, type, maxHealth, color and a sprite).',
      });
    }
  } else if (opts.dryRun !== false && !session.disposed) {
    const dr = await dryRun(session, stats, hasUpdate, ctx);
    errors.push(...dr.errors);
    warnings.push(...dr.warnings);
    if (stats.type === 'factory') orders = dr.orders;
    healUsed = dr.healUsed;
  }
  // Pricing tips last: they are the least urgent (the player hint uses warnings[0]).
  const power = powerHighWarning(stats, priced, ctx.config.cost, ctx.config.stats.bounds, pricing);
  if (power) warnings.push(power);
  warnings.push(...nearMaxWarnings(stats, priced, ctx.config.cost, ctx.config.stats.bounds, pricing));

  if (errors.length > 0) {
    return failure(errors, warnings, Number.isFinite(priced.cost) ? priced.cost : null);
  }
  return {
    ok: true,
    unit: {
      unitId: opts.unitId ?? slugify(stats.name),
      version: opts.version ?? 1,
      stats,
      cost: priced.cost,
      breakdown: priced.breakdown,
      sprite: sp.sprite,
      ...(orders ? { orders } : {}),
      ...(healUsed !== undefined ? { healUsed } : {}),
    },
    warnings,
    playerHint: warnings[0] ? `${SUCCESS_PLAYER_HINT} ${playerHintFor(warnings[0].code)}` : SUCCESS_PLAYER_HINT,
  };
}

function failure(errors: ValidationError[], warnings: ValidationWarning[] = [], cost: number | null = null): ValidationResult {
  const first = errors[0];
  return {
    ok: false,
    errors,
    warnings,
    cost,
    playerHint: first ? playerHintForIssue(first) : 'Something went wrong. Ask Claude to check the unit.',
  };
}

// ---------------------------------------------------------------------------
// Thrown errors, located in the player's source
// ---------------------------------------------------------------------------

const at = (loc: { line?: number }) => (loc.line !== undefined ? ` on line ${loc.line}` : '');

function memoryMessage(ctx: Ctx): string {
  return `ran out of memory (the limit is ${ctx.config.sandbox.memoryLimitMb} MB)`;
}

const MEMORY_FIX =
  "Don't build huge arrays, strings, maps or objects, and don't let them grow forever. Keep only the little data the unit needs.";

/** Step 4 outcome -> error (undefined when the design loaded). */
function evaluateError(out: CallOutcome, ctx: Ctx): ValidationError | undefined {
  const budget = ctx.config.sandbox.validation.evalBudgetMs;
  switch (out.kind) {
    case 'timeout':
      return {
        code: 'TIMEOUT',
        field: 'source',
        allowed: { maxMs: budget },
        message: `Loading the file took longer than ${budget} ms. Code at the top level of the file never finished.`,
        fix: 'Remove endless loops (while (true), for (;;)) and heavy work from the top level of the file. Only the class should be there.',
      };
    case 'crashed': {
      const errorMessage = isMemoryCrash(out.detail) ? memoryMessage(ctx) : out.detail;
      return {
        code: 'EVAL_THREW',
        errorMessage,
        message: `The file crashed while loading: ${errorMessage}.`,
        fix: isMemoryCrash(out.detail) ? MEMORY_FIX : 'Remove code at the top level of the file that could crash; keep only the class.',
      };
    }
    case 'error':
      return {
        code: 'EVAL_THREW',
        errorMessage: out.message,
        message: `The file could not be loaded: ${out.message}`,
        fix: 'Make sure the file contains only the unit class, exported with `export default class … {}`.',
      };
    case 'ok': {
      const r = parseObject(out.value);
      if (r?.ok === true) return undefined;
      if (r?.kind === 'no-default') {
        return {
          code: 'NO_DEFAULT_EXPORT',
          field: 'source',
          message: 'The file has no default export, so the game cannot find the unit.',
          fix: 'Export the unit class as the default export: `export default class MyUnit { constructor() { … } update(self, enemies, allies, world) { … } }`.',
        };
      }
      if (r?.kind === 'not-a-class') {
        const type = typeof r.type === 'string' ? r.type : 'value';
        return {
          code: 'NOT_A_CLASS',
          field: 'source',
          value: type,
          allowed: { type: 'class' },
          message: `The default export is a ${type === 'function' ? 'function that cannot be used with new (an arrow function or method)' : type}, but it must be a class.`,
          fix: 'Change it to `export default class MyUnit { constructor() { this.name = …; … } update(self, enemies, allies, world) { … } }`.',
        };
      }
      const err = asHarnessError(r?.error);
      const loc = locate(err, ctx);
      return {
        code: 'EVAL_THREW',
        ...loc,
        message: `The file threw an error while loading${at(loc)}: ${err.message}`,
        fix: `Code at the top level of the file runs once when the unit loads. Fix the error${at(loc)} or move that code into the constructor or update().`,
      };
    }
  }
}

/** Step 5 spawn outcome -> error (undefined when constructed). */
function constructError(out: CallOutcome, ctx: Ctx): ValidationError | undefined {
  const t = ctx.config.sandbox.validation.constructTimeoutMs;
  switch (out.kind) {
    case 'timeout':
      return {
        code: 'TIMEOUT',
        field: 'constructor',
        allowed: { maxMs: t },
        message: `The constructor took longer than ${t} ms.`,
        fix: 'The constructor should only set the stats and a few fields. Remove loops and heavy work from it (no while (true)).',
      };
    case 'crashed': {
      const errorMessage = isMemoryCrash(out.detail) ? memoryMessage(ctx) : out.detail;
      return {
        code: 'CONSTRUCTOR_THREW',
        field: 'constructor',
        errorMessage,
        message: `The constructor crashed: ${errorMessage}.`,
        fix: isMemoryCrash(out.detail) ? MEMORY_FIX : 'Simplify the constructor so it only sets the stats.',
      };
    }
    case 'error':
      return {
        code: 'CONSTRUCTOR_THREW',
        field: 'constructor',
        errorMessage: out.message,
        message: `The constructor failed: ${out.message}`,
        fix: 'Simplify the constructor so it only sets the stats.',
      };
    case 'ok': {
      const r = parseObject(out.value);
      if (r?.ok === true) return undefined;
      const err = asHarnessError(r?.error);
      const loc = locate(err, ctx);
      return {
        code: 'CONSTRUCTOR_THREW',
        field: 'constructor',
        ...loc,
        message: `The constructor threw an error${at(loc)}: ${err.message}`,
        fix: `Fix the constructor${at(loc)}. It should set the stats to plain values without throwing: this.name, this.type, this.maxHealth and this.color, plus this.damage, this.range, this.speed and this.attackCooldown for a soldier or tower (optionally this.size), or this.productionInterval for a factory.`,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Step 5: decoding the harness stats() reply
// ---------------------------------------------------------------------------

interface StatRead {
  /** Own data property values (decoded), for checkStats. */
  raw: Record<string, unknown>;
  /** Canonical encoding per field, for the determinism check. */
  encoded: Record<string, string>;
  /** STAT_IS_GETTER / inherited STAT_MISSING errors. */
  shapeErrors: ValidationError[];
  /** Fields holding objects/functions/symbols…, by typeof (for the error `value`). */
  otherTypes: Map<string, string>;
}

function decodeValue(v: unknown): { value: unknown; other?: string } {
  if (!v || typeof v !== 'object') return { value: undefined };
  const o = v as Record<string, unknown>;
  if ('num' in o) return { value: typeof o.num === 'number' ? o.num : Number(o.num) };
  if ('str' in o) return { value: String(o.str) };
  if ('bool' in o) return { value: o.bool === true };
  if ('null' in o) return { value: null };
  if ('undef' in o) return { value: undefined };
  const type = typeof o.other === 'string' ? o.other : 'object';
  // A stand-in with the right typeof, so checkStats reports the real type.
  const standIn: Record<string, unknown> = {
    object: {},
    function: () => undefined,
    symbol: Symbol('value'),
    bigint: 0n,
  };
  return { value: standIn[type] ?? {}, other: type };
}

function decodeStats(out: CallOutcome, ctx: Ctx): StatRead | { error: ValidationError } {
  if (out.kind !== 'ok') {
    const err = constructError(out, ctx);
    return { error: err ?? { code: 'CONSTRUCTOR_THREW', message: 'Reading the stats failed.', fix: 'Set the stats as plain values in the constructor.' } };
  }
  const r = parseObject(out.value);
  if (r?.ok !== true || !r.fields || typeof r.fields !== 'object') {
    const err = asHarnessError(r?.error);
    const loc = locate(err, ctx);
    return {
      error: {
        code: 'CONSTRUCTOR_THREW',
        field: 'constructor',
        ...loc,
        message: `Reading the unit's stats threw an error: ${err.message}`,
        fix: 'Set the stats as plain data properties in the constructor (this.damage = 10), not through getters, setters or a Proxy.',
      },
    };
  }
  const fields = r.fields as Record<string, unknown>;
  const raw: Record<string, unknown> = {};
  const encoded: Record<string, string> = {};
  const shapeErrors: ValidationError[] = [];
  const otherTypes = new Map<string, string>();
  for (const field of STAT_FIELDS) {
    const entry = (fields[field] ?? {}) as { kind?: unknown; v?: unknown };
    encoded[field] = JSON.stringify(entry);
    if (entry.kind === 'data') {
      const d = decodeValue(entry.v);
      raw[field] = d.value;
      if (d.other) otherTypes.set(field, d.other);
    } else if (entry.kind === 'getter') {
      shapeErrors.push({
        code: 'STAT_IS_GETTER',
        field,
        message: `${field} is a getter or setter, but stats must be plain values.`,
        fix: `Remove "get ${field}()" / "set ${field}()" and set the value in the constructor instead, e.g. this.${field} = ${exampleFor(field)};.`,
      });
    } else if (entry.kind === 'inherited' && field !== 'shape') {
      shapeErrors.push({
        code: 'STAT_MISSING',
        field,
        message: `${field} is inherited (from a parent class or prototype), but stats must be set on the unit itself.`,
        fix: `Set it directly in the constructor: this.${field} = ${exampleFor(field)};.`,
      });
    }
  }
  return { raw, encoded, shapeErrors, otherTypes };
}

function exampleFor(field: string): string {
  const eg: Record<string, string> = {
    name: '"Swift Ninja"',
    type: '"soldier"',
    maxHealth: '600',
    damage: '50',
    range: '40',
    speed: '1.5',
    attackCooldown: '60',
    productionInterval: '900',
    produces: "'archer'",
    minionElement: "'fire'",
    burst: '3',
    element: "'ice'",
    splashRadius: '40',
    support: "'heal'",
    supportPower: '60',
    supportRange: '120',
    color: '"#33CC66"',
    size: '10',
    shape: '"circle"',
  };
  return eg[field] ?? '…';
}

function displayValue(v: unknown): unknown {
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
  if (typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') return `[${typeof v}]`;
  return v;
}

// ---------------------------------------------------------------------------
// Step 10 warnings that only need the stats
// ---------------------------------------------------------------------------

function statWarnings(stats: StatsSnapshot, config: GameConfig): ValidationWarning[] {
  const out: ValidationWarning[] = [];
  if (stats.type === 'factory') {
    // M8.6 (§7 step 10): a burst bigger than the minions it makes never fills up.
    const made = expectedMinions(stats.productionInterval ?? 0, pricingOf(config));
    const burst = burstOf(stats);
    if (burst > 1 && burst > made) {
      out.push({
        code: 'W_BURST_NEVER_FULL',
        field: 'burst',
        value: burst,
        allowed: { max: made },
        message: `This factory makes only ${made} minion${made === 1 ? '' : 's'} per battle, so a burst of ${burst} never fills up: they leave when it runs out.`,
        fix: `Lower this.burst to ${Math.max(1, made)}, or make minions faster (a smaller this.productionInterval, e.g. 900 makes 7).`,
      });
    }
  }
  // Walls and factories can't attack (§5.2): no damage or cooldown advice for them.
  if (stats.type === 'wall' || stats.type === 'factory') return out;
  // M8.8: a pure support unit (a medic, a banner, a healing shrine) has damage 0 on purpose.
  if (stats.damage === 0 && !supportOf(stats)) {
    out.push({
      code: 'W_ZERO_DAMAGE',
      field: 'damage',
      value: 0,
      message:
        'damage is 0, so this unit can never hurt anything. Fire, lightning and splash scale with damage, so they do nothing at damage 0 (ice still freezes). ' +
        "A side with only damage-0 units left is out of the battle.",
      fix: 'If it should fight, set this.damage to a number above 0, e.g. this.damage = 50.',
    });
  }
  const ref = config.cost.referenceCooldown;
  if (stats.attackCooldown > ref) {
    out.push({
      code: 'W_SLOW_NO_DISCOUNT',
      field: 'attackCooldown',
      value: stats.attackCooldown,
      allowed: { recommendedMax: ref },
      message: `attackCooldown is ${stats.attackCooldown}. Attacking slower than once per second doesn't make it cheaper.`,
      fix: `Set attackCooldown to ${ref} for free extra damage.`,
    });
  }
  return out;
}
