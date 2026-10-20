// §7 steps 9-10: dry-run update() in the validation sandbox.
//
// Three synthetic worlds, 5 ticks each, one fresh copy per world, each call
// limited to `sandbox.validation.dryRunCallTimeoutMs` (20 ms):
//   A. no enemies (one ally nearby)
//   B. one enemy in range, measured edge to edge like the engine, cooldown ready
//   C. three enemies far away in the opposite corner
// update() must not throw or time out, and each return must be a valid Action
// or undefined. The results also feed the non-fatal warnings.

import {
  ARENA,
  CENTER,
  UNIT_RADIUS,
  sizeOf,
  zoneCenter,
  type OtherView,
  type SelfView,
  type StatsSnapshot,
  type UnitType,
  type ValidationError,
  type ValidationWarning,
  type WorldView,
} from '@pixel-clash/shared';
import {
  DEFAULT_DEADLINE_SLACK_MS,
  asHarnessError,
  capMessage,
  encodeTickInput,
  isMemoryCrash,
  parseObject,
  parseTickOutput,
  type CallOutcome,
  type SandboxSession,
} from '../sandbox/session.js';
import type { TickInput } from '../sandbox/runner.js';
import { locate, type Ctx } from './context.js';
import { excerptAround } from './normalize.js';

export interface DryRunResult {
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

const TICKS_PER_WORLD = 5;
const ME = 'you';
const ENEMY = 'enemy';

function other(id: string, ownerId: string, type: UnitType, x: number, y: number): OtherView {
  const radius = UNIT_RADIUS[type];
  return { id, ownerId, type, name: type === 'tower' ? 'Enemy Tower' : 'Enemy Soldier', x, y, radius, hp: 100, maxHp: 100, range: 40 };
}

interface World {
  label: string;
  enemies: OtherView[];
  allies: OtherView[];
  /** World B: the unit should attack. */
  expectAttack: boolean;
}

function worlds(stats: StatsSnapshot, self: { x: number; y: number; radius: number }): World[] {
  // Enemy B sits along +x with an edge-to-edge gap of half the range (always in range).
  const gap = stats.range / 2;
  const bx = self.x + self.radius + UNIT_RADIUS.soldier + gap;
  return [
    { label: 'no enemies', enemies: [], allies: [other('ally-1', ME, 'soldier', self.x + 40, self.y)], expectAttack: false },
    { label: 'one enemy in range', enemies: [other('enemy-1', ENEMY, 'soldier', bx, self.y)], allies: [], expectAttack: true },
    {
      label: 'three enemies far away',
      enemies: [
        other('enemy-2', ENEMY, 'soldier', 680, 680),
        other('enemy-3', ENEMY, 'tower', 700, 620),
        other('enemy-4', ENEMY, 'soldier', 620, 700),
      ],
      allies: [],
      expectAttack: false,
    },
  ];
}

/** Why a returned value is not a valid Action, or undefined when it is one (or undefined). */
export function badActionReason(a: unknown): string | undefined {
  if (a === undefined) return undefined;
  if (a === null || typeof a !== 'object' || Array.isArray(a)) return `it returned ${a === null ? 'null' : Array.isArray(a) ? 'an array' : typeof a}, not an action object`;
  const o = a as Record<string, unknown>;
  switch (o.action) {
    case 'idle':
      return undefined;
    case 'attack':
      return typeof o.targetId === 'string' ? undefined : 'an attack needs targetId set to an enemy id (a string)';
    case 'move': {
      const d = o.destination as Record<string, unknown> | undefined;
      if (!d || typeof d !== 'object') return 'a move needs destination: { x, y }';
      if (typeof d.x !== 'number' || typeof d.y !== 'number' || !Number.isFinite(d.x) || !Number.isFinite(d.y)) {
        return 'a move destination needs finite numbers x and y';
      }
      return undefined;
    }
    default:
      return `"action" must be "idle", "move" or "attack" (got ${JSON.stringify(o.action) ?? 'nothing'})`;
  }
}

/** A method definition `update(` (optionally async), or a property `update =` / `update:`. */
const UPDATE_DEF_RE = /^\s*(?:(?:public|async|static)\s+)*update\s*(?:\(|=|:)/;

/**
 * The line where update() is DEFINED (not merely mentioned, e.g. in a
 * comment), to point BAD_ACTION and location-less errors somewhere useful.
 */
export function updateLine(source: string): number | undefined {
  const idx = source.split('\n').findIndex((l) => {
    const t = l.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return false;
    return UPDATE_DEF_RE.test(l);
  });
  return idx >= 0 ? idx + 1 : undefined;
}

/** line/column/excerpt of the update() definition (or nothing if not found). */
function updateLocation(source: string): { line?: number; column?: number; excerpt?: string } {
  const line = updateLine(source);
  if (line === undefined) return {};
  const text = source.split('\n')[line - 1] ?? '';
  return { line, column: text.search(/\S/) + 1, excerpt: excerptAround(source, line) };
}

/** The error message of a failed spawn outcome, for `errorMessage`. */
function spawnFailureMessage(out: CallOutcome): string {
  switch (out.kind) {
    case 'timeout':
      return 'the constructor took too long';
    case 'error':
      return capMessage(out.message);
    case 'crashed':
      return capMessage(out.detail);
    case 'ok': {
      const r = parseObject(out.value);
      return r?.kind === 'threw' ? asHarnessError(r.error).message : `could not build the unit (${String(r?.kind ?? 'bad reply')})`;
    }
  }
}

function preview(v: unknown): unknown {
  try {
    const s = JSON.stringify(v);
    return s !== undefined && s.length > 200 ? `${s.slice(0, 200)}…` : v;
  } catch {
    return String(v);
  }
}

export async function dryRun(session: SandboxSession, stats: StatsSnapshot, hasUpdate: boolean, ctx: Ctx): Promise<DryRunResult> {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];
  if (!hasUpdate) {
    errors.push({
      code: 'UPDATE_MISSING',
      field: 'update',
      message: 'The unit has no update() method, so it would never do anything in battle.',
      fix: 'Add an update(self, enemies, allies, world) method to the class that returns an action, e.g. return { action: "attack", targetId: enemies[0].id }.',
    });
    return { errors, warnings };
  }

  const { dryRunCallTimeoutMs: callMs, slowUpdateWarnMs } = ctx.config.sandbox.validation;
  const corner = zoneCenter('TL');
  const radius = sizeOf(stats); // the unit's own size, like in battle (§9 Radii)
  const battleTicks = ctx.config.timers.battleTicks;
  let returnedNothing = false;
  let moved = false;
  let attackedWhenAble = true;
  let slowestMs = 0;

  for (const [w, world] of worlds(stats, { ...corner, radius }).entries()) {
    const instanceId = `dry-${w}`;
    const spawned = await session.call('spawn', [instanceId, 'unit'], ctx.config.sandbox.validation.constructTimeoutMs, {
      deadlineMs: ctx.config.sandbox.validation.constructTimeoutMs + DEFAULT_DEADLINE_SLACK_MS,
    });
    if (spawned.kind !== 'ok' || parseObject(spawned.value)?.ok !== true) {
      // The constructor passed twice already; treat a late failure as a throw.
      const errorMessage = spawnFailureMessage(spawned);
      errors.push({
        code: 'UPDATE_THREW',
        field: 'update',
        ...updateLocation(ctx.source),
        errorMessage,
        message: `The unit could not be built for the practice battle: ${errorMessage}`,
        fix: 'Make the constructor simple and deterministic: it should only set fields, the same way every time.',
      });
      return { errors, warnings };
    }
    let attacked = false;
    for (let t = 0; t < TICKS_PER_WORLD; t++) {
      const self: SelfView = {
        id: instanceId,
        unitId: 'unit',
        ownerId: ME,
        type: stats.type,
        name: stats.name,
        x: corner.x,
        y: corner.y,
        radius,
        hp: stats.maxHealth,
        maxHp: stats.maxHealth,
        damage: stats.damage,
        range: stats.range,
        speed: stats.speed,
        attackCooldown: stats.attackCooldown,
        cooldownRemaining: 0,
      };
      const worldView: WorldView = {
        width: ARENA.width,
        height: ARENA.height,
        tick: t,
        ticksLeft: battleTicks - t,
        myCorner: { x: corner.x, y: corner.y },
        center: { x: CENTER.x, y: CENTER.y },
        safeZone: { x: CENTER.x, y: CENTER.y, radius: ctx.config.suddenDeath.startRadius },
      };
      const input: TickInput = {
        tick: t,
        nowMs: (t * 1000) / ctx.config.timers.ticksPerSecond,
        selves: [self],
        enemies: world.enemies,
        allies: [{ id: self.id, ownerId: ME, type: self.type, name: self.name, x: self.x, y: self.y, radius, hp: self.hp, maxHp: self.maxHp, range: self.range }, ...world.allies],
        world: worldView,
      };
      const out = await session.call('tick', [encodeTickInput(input)], callMs, { deadlineMs: callMs + DEFAULT_DEADLINE_SLACK_MS });
      if (out.kind === 'timeout') {
        errors.push({
          code: 'UPDATE_TIMEOUT',
          field: 'update',
          allowed: { maxMs: callMs },
          message: `update() took longer than ${callMs} ms in a practice battle (${world.label}). In a real battle each player's whole army gets ${ctx.config.sandbox.battle.hardTimeoutMs} ms per tick.`,
          fix: 'Make update() fast: no endless loops (while (true)), no huge loops over big arrays. Look at the enemies list once and decide.',
        });
        return { errors, warnings };
      }
      if (out.kind !== 'ok') {
        const detail = capMessage(out.kind === 'crashed' ? out.detail : out.message);
        const errorMessage = isMemoryCrash(detail) ? `ran out of memory (the limit is ${ctx.config.sandbox.memoryLimitMb} MB)` : detail;
        errors.push({
          code: 'UPDATE_THREW',
          field: 'update',
          ...updateLocation(ctx.source),
          errorMessage,
          message: `update() crashed in a practice battle (${world.label}): ${errorMessage}.`,
          fix: "Don't build huge arrays, strings or maps in update(), and don't let stored data grow every tick.",
        });
        return { errors, warnings };
      }
      const parsed = parseTickOutput(out.value, [self]);
      const entry = parsed.outputs[0];
      if (!parsed.ok || !entry) {
        const errorMessage = capMessage(parsed.detail ?? 'update() produced no result');
        errors.push({
          code: 'UPDATE_THREW',
          field: 'update',
          ...updateLocation(ctx.source),
          errorMessage,
          message: `update() produced no result in a practice battle (${world.label}): ${errorMessage}.`,
          fix: 'Return an action object from update().',
        });
        return { errors, warnings };
      }
      slowestMs = Math.max(slowestMs, entry.ms ?? 0);
      if ('error' in entry) {
        const stack = parsed.stacks.get(instanceId);
        const located = locate(asHarnessError({ message: entry.error.message, ...(stack ? { stack } : {}) }), ctx);
        // No stack frame (e.g. `throw 42`): point at update() itself.
        const loc = located.line !== undefined ? located : { ...updateLocation(ctx.source), ...located };
        errors.push({
          code: 'UPDATE_THREW',
          field: 'update',
          ...loc,
          message: `update() threw an error${loc.line !== undefined ? ` on line ${loc.line}` : ''} in a practice battle (${world.label}): ${entry.error.message}`,
          fix: `Fix update()${loc.line !== undefined ? ` around line ${loc.line}` : ''}. Remember enemies can be an empty array, so check enemies.length before using enemies[0].`,
        });
        return { errors, warnings };
      }
      const where = updateLocation(ctx.source);
      if (parsed.promises.has(instanceId)) {
        errors.push({
          code: 'BAD_ACTION',
          field: 'update',
          ...where,
          value: 'Promise',
          errorMessage: 'update() returned a Promise',
          message: 'update() returned a Promise. update must not be async: the game never waits for it, so the unit would always idle.',
          fix: 'Remove "async" (and any await) from update() and return the action directly.',
        });
        return { errors, warnings };
      }
      const reason = badActionReason(entry.action);
      if (reason) {
        errors.push({
          code: 'BAD_ACTION',
          field: 'update',
          ...where,
          value: preview(entry.action),
          allowed: { oneOf: ["{ action: 'idle' }", "{ action: 'move', destination: { x, y } }", "{ action: 'attack', targetId }"] },
          errorMessage: reason,
          message: `update() returned something that is not a valid action in a practice battle (${world.label}): ${reason}.`,
          fix: "Return exactly one of { action: 'idle' }, { action: 'move', destination: { x: number, y: number } } or { action: 'attack', targetId: enemy.id }.",
        });
        return { errors, warnings };
      }
      const action = entry.action as { action?: string } | undefined;
      if (action === undefined) returnedNothing = true;
      if (action?.action === 'move') moved = true;
      if (action?.action === 'attack') attacked = true;
    }
    if (world.expectAttack && !attacked) attackedWhenAble = false;
  }

  if (!attackedWhenAble && stats.damage > 0) {
    warnings.push({
      code: 'W_NEVER_ATTACKS',
      field: 'update',
      message: 'In a practice battle an enemy was in range and the attack was ready, but update() never attacked.',
      fix: "When an enemy is in range (gap between the bodies <= self.range) and self.cooldownRemaining === 0, return { action: 'attack', targetId: enemy.id }.",
    });
  }
  if (stats.type === 'soldier' && !moved) {
    warnings.push({
      code: 'W_NEVER_MOVES',
      field: 'update',
      message: 'This soldier never moved in the practice battles (even with enemies far away).',
      fix: "Soldiers can move: return { action: 'move', destination: { x: enemy.x, y: enemy.y } } to walk towards an enemy that is out of range.",
    });
  }
  if (returnedNothing) {
    warnings.push({
      code: 'W_RETURNS_NOTHING',
      field: 'update',
      message: 'update() sometimes returns nothing (undefined), which means idle.',
      fix: "Return an action every time; use { action: 'idle' } when the unit should wait.",
    });
  }
  if (slowestMs > slowUpdateWarnMs) {
    warnings.push({
      code: 'W_SLOW',
      field: 'update',
      value: slowestMs,
      allowed: { maxMs: slowUpdateWarnMs },
      message: `update() took about ${slowestMs} ms in a practice battle. With many copies the army may get too slow.`,
      fix: 'Make update() cheaper: avoid nested loops and big temporary arrays.',
    });
  }
  return { errors, warnings };
}
