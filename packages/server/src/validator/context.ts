// Shared bits of the validation pipeline: the per-call context and locating
// a thrown error in the player's original source.

import type { GameConfig, ValidationError } from '@pixel-clash/shared';
import type { HarnessError } from '../sandbox/session.js';
import { findUnitFrame, type LineMapper } from '../sandbox/sourcemap.js';
import { excerptAround } from './normalize.js';

export interface Ctx {
  /** Normalized source (step 1). */
  source: string;
  /** Maps compiled positions back to `source`. */
  mapper: LineMapper;
  config: GameConfig;
  /** "Show enemy names to units" is on: the practice worlds carry names too. */
  names?: PracticeNames;
}

/** Names for the practice worlds when "Show enemy names to units" is on. */
export interface PracticeNames {
  /** The player's own name (their bodies' ownerName). */
  me: string;
  /** Team mode: bodies also carry teamName. */
  teams: boolean;
}

/** line/column/excerpt/errorMessage for an error thrown by unit code. */
export function locate(err: HarnessError, ctx: Ctx): Pick<ValidationError, 'line' | 'column' | 'excerpt' | 'errorMessage'> {
  const frame = findUnitFrame(err.stack);
  if (!frame) return { errorMessage: err.message };
  const pos = ctx.mapper.map(frame.pos);
  return { line: pos.line, column: pos.column, excerpt: excerptAround(ctx.source, pos.line), errorMessage: err.message };
}
