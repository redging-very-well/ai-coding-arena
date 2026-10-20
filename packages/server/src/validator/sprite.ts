// §7 step 8b: the unit's optional sprite() (§5.1).
//
// sprite() is called twice in the validation sandbox, once on each of the two
// copies constructed in step 5 (50 ms each). The harness JSON-copies each
// result (max 200 KB); the two copies must be identical (SPRITE_NOT_STABLE)
// and the spec must pass the shared checkSprite(). Without sprite() the unit
// gets the W_NO_SPRITE warning and the client draws the fallback sprite.

import {
  checkSprite,
  noSpriteWarning,
  spriteNotStableError,
  spriteTooLargeError,
  type SpriteSpec,
  type ValidationError,
  type ValidationWarning,
} from '@pixel-clash/shared';
import { DEFAULT_DEADLINE_SLACK_MS, asHarnessError, isMemoryCrash, parseObject, type CallOutcome, type SandboxSession } from '../sandbox/session.js';
import { locate, type Ctx } from './context.js';

/** Time limit of one sprite() call (§7 step 8b). */
export const SPRITE_CALL_TIMEOUT_MS = 50;

export interface SpriteStepResult {
  /** The normalized spec, or null when the unit has no sprite() or it failed. */
  sprite: SpriteSpec | null;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

type CallRead = { kind: 'none' } | { kind: 'json'; json: string } | { kind: 'error'; error: ValidationError };

/** Run step 8b on the two copies spawned in step 5. */
export async function spriteStep(session: SandboxSession, instanceIds: readonly [string, string], ctx: Ctx): Promise<SpriteStepResult> {
  const reads: CallRead[] = [];
  for (const id of instanceIds) {
    const t = SPRITE_CALL_TIMEOUT_MS;
    const out = await session.call('sprite', [id], t, { deadlineMs: t + DEFAULT_DEADLINE_SLACK_MS });
    const read = decode(out, ctx);
    if (read.kind === 'error') return { sprite: null, errors: [read.error], warnings: [] };
    reads.push(read);
  }
  const [a, b] = reads as [CallRead, CallRead];
  if (a.kind === 'none' && b.kind === 'none') return { sprite: null, errors: [], warnings: [noSpriteWarning()] };
  if (a.kind !== 'json' || b.kind !== 'json' || a.json !== b.json) {
    return { sprite: null, errors: [spriteNotStableError()], warnings: [] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(a.json) as unknown;
  } catch {
    raw = undefined;
  }
  const checked = checkSprite(raw);
  return checked.ok ? { sprite: checked.sprite, errors: [], warnings: [] } : { sprite: null, errors: checked.errors, warnings: [] };
}

function decode(out: CallOutcome, ctx: Ctx): CallRead {
  const threw = (errorMessage: string, message: string, fix: string): CallRead => ({
    kind: 'error',
    error: { code: 'SPRITE_THREW', field: 'sprite', errorMessage, message, fix },
  });
  const plainFix =
    'sprite() should only return a fixed object literal { grid, palette, frames } with the frames written out as strings. Remove loops and other work from it.';
  switch (out.kind) {
    case 'timeout':
      return {
        kind: 'error',
        error: {
          code: 'SPRITE_THREW',
          field: 'sprite',
          allowed: { maxMs: SPRITE_CALL_TIMEOUT_MS },
          errorMessage: `timed out after ${SPRITE_CALL_TIMEOUT_MS} ms`,
          message: `sprite() took longer than ${SPRITE_CALL_TIMEOUT_MS} ms.`,
          fix: plainFix,
        },
      };
    case 'crashed': {
      const memory = isMemoryCrash(out.detail);
      const detail = memory ? `ran out of memory (the limit is ${ctx.config.sandbox.memoryLimitMb} MB)` : out.detail;
      return threw(detail, `sprite() crashed: ${detail}.`, plainFix);
    }
    case 'error':
      return threw(out.message, `Calling sprite() failed: ${out.message}`, plainFix);
    case 'ok': {
      const r = parseObject(out.value);
      if (r?.ok === true && r.none === true) return { kind: 'none' };
      if (r?.ok === true && (typeof r.json === 'string' || r.json === null)) {
        return { kind: 'json', json: typeof r.json === 'string' ? r.json : 'null' };
      }
      if (r?.kind === 'too-big') {
        return { kind: 'error', error: spriteTooLargeError(typeof r.length === 'number' ? r.length : 0) };
      }
      const err = asHarnessError(r?.error);
      const loc = locate(err, ctx);
      const at = loc.line !== undefined ? ` on line ${loc.line}` : '';
      return {
        kind: 'error',
        error: {
          code: 'SPRITE_THREW',
          field: 'sprite',
          ...loc,
          message: `sprite() threw an error${at}: ${err.message}`,
          fix: `Fix sprite()${at} so it returns { grid, palette, frames } without throwing. The result must be plain data (strings, numbers, arrays, objects), no BigInt or circular references.`,
        },
      };
    }
  }
}
