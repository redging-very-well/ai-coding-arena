// Error codes, the §7 error object format, and friendly hint templates.
//
// Errors are written for Claude first (precise `message` + actionable `fix`)
// and the player second (`playerHint`). Every validation failure is a
// `ValidationIssue`; every service failure is a `ServiceError` (§10.1).

import type { CostBreakdown } from './cost.js';
import type { SpriteSpec, StatsSnapshot } from './contract.js';

/** §7 validation pipeline failure codes, in pipeline order. */
export const VALIDATION_ERROR_CODES = [
  // 1 normalize
  'SOURCE_TOO_LARGE',
  'EMPTY_SOURCE',
  // 2 transpile
  'SYNTAX_ERROR',
  // 3 import check
  'IMPORT_NOT_ALLOWED',
  // 4 evaluate
  'NO_DEFAULT_EXPORT',
  'NOT_A_CLASS',
  'EVAL_THREW',
  'TIMEOUT',
  // 5 construct twice
  'CONSTRUCTOR_THREW',
  'STAT_MISSING',
  'STAT_IS_GETTER',
  // 6 hard guards (bounds.ts)
  'STAT_WRONG_TYPE',
  'STAT_NOT_FINITE',
  'STAT_OUT_OF_RANGE',
  'COOLDOWN_NOT_INTEGER',
  'BAD_COLOR',
  'BAD_NAME',
  'TOWER_CANNOT_MOVE',
  // M8.5 buildings (§5.2)
  'BUILDING_CANNOT_ATTACK',
  'BUILDING_CANNOT_MOVE',
  'INTERVAL_NOT_INTEGER',
  // 7 determinism
  'STATS_NOT_STABLE',
  // 8 cost
  'UNIT_TOO_EXPENSIVE',
  // 8b sprite (§5.1)
  'SPRITE_THREW',
  'SPRITE_BAD_GRID',
  'SPRITE_BAD_PALETTE',
  'SPRITE_BAD_FRAME',
  'SPRITE_TOO_MANY_FRAMES',
  'SPRITE_EMPTY',
  'SPRITE_NOT_STABLE',
  // 9 dry-run update()
  'UPDATE_MISSING',
  'UPDATE_THREW',
  'UPDATE_TIMEOUT',
  'BAD_ACTION',
] as const;
export type ValidationErrorCode = (typeof VALIDATION_ERROR_CODES)[number];

/** §7 step 10 non-fatal warnings (W_NO_SPRITE comes from step 8b). */
export const WARNING_CODES = [
  'W_NO_SPRITE',
  'W_NEVER_ATTACKS',
  'W_NEVER_MOVES',
  'W_ZERO_DAMAGE',
  'W_RETURNS_NOTHING',
  'W_SLOW',
  'W_SLOW_NO_DISCOUNT',
  'W_STAT_NEAR_MAX',
  // M8.5 buildings (§5.2, §7, §9.3)
  'W_STAT_IGNORED',
  'W_UPDATE_IGNORED',
  'W_ACTION_NOT_FOR_TYPE',
  'W_TRAPPED',
] as const;
export type WarningCode = (typeof WARNING_CODES)[number];

/** Service / API error codes (§4, §6 caps, §10). */
export const SERVICE_ERROR_CODES = [
  'PHASE_CLOSED',
  'NAME_TAKEN',
  'GAME_FULL',
  'BAD_PIN_FORMAT',
  'BAD_NAME_FORMAT',
  'BAD_LOGIN',
  'AUTH_REQUIRED',
  'KEY_INVALID',
  'ADMIN_REQUIRED',
  'RATE_LIMITED',
  'NOT_FOUND',
  'BAD_REQUEST',
  'TOO_MANY_DESIGNS',
  'TOO_MANY_TYPES',
  'TOO_MANY_COPIES',
  'OVER_BUDGET',
  'CELL_TAKEN',
  'CELL_OUT_OF_ZONE',
  'NOT_SELECTED',
  'UNIT_INVALID',
  'ARMORY_OFF',
  'ARMORY_OWN_UNIT',
  'NOT_ALL_READY',
  'NOTHING_SELECTED',
  // M8.5: only walls selected / placed (§5.2 Fighters).
  'NO_FIGHTERS',
  'NOT_ENOUGH_PLAYERS',
  'BAD_MAP_STYLE',
  'BAD_TEAM_MODE',
  'NO_TEAMS',
  'SAME_TEAM',
  'TEMPLATE_PROTECTED',
  'TEMPLATE_WOULD_BREAK',
  // Optimistic concurrency: the unit was revised since `baseVersion` (§10.3).
  'UNIT_CHANGED',
  // Claude seats and the seat terminal proxy (§11.2).
  'BAD_CLAUDE_SEAT',
  'CLAUDE_SEAT_TAKEN',
  'BAD_SEAT_SECRET',
  'TERMINAL_LOGIN_REQUIRED',
  'CLAUDE_SEAT_NOT_YOURS',
  'TERMINAL_BAD_ORIGIN',
  'CLAUDE_BOX_NOT_SET',
  'CLAUDE_BOX_DOWN',
  'SEAT_PASSWORD_WRONG',
  'TERMINAL_BUSY',
  'VALIDATION_FAILED',
  'INTERNAL',
] as const;
export type ServiceErrorCode = (typeof SERVICE_ERROR_CODES)[number];

export type ErrorCode = ValidationErrorCode | ServiceErrorCode;

/** One entry of `errors[]` / `warnings[]` in the §7 result body. */
export interface ValidationIssue<C extends string = ValidationErrorCode | WarningCode> {
  code: C;
  /** The stat (or other input) the issue is about, e.g. "damage". */
  field?: string;
  /** The offending value (JSON-safe; non-finite numbers are stringified). */
  value?: unknown;
  /** What would have been accepted, e.g. {min, max} or {oneOf: [...]}. */
  allowed?: unknown;
  message: string;
  /** Concrete instruction Claude can apply to fix the code. */
  fix: string;
  // Location info for SYNTAX_ERROR, *_THREW and BAD_ACTION.
  line?: number;
  column?: number;
  /** ~3 lines of source around `line`. */
  excerpt?: string;
  /** The thrown error's message. */
  errorMessage?: string;
  /** UNIT_TOO_EXPENSIVE only. */
  breakdown?: CostBreakdown;
  // SPRITE_* location (§5.1), all counted from 0 like array indexes.
  /** Animation state, e.g. "walk". */
  state?: string;
  /** Frame index within the state. */
  frame?: number;
  /** Row index within the frame. */
  row?: number;
  /** Column (character) index within the row. */
  col?: number;
}

export type ValidationError = ValidationIssue<ValidationErrorCode>;
export type ValidationWarning = ValidationIssue<WarningCode>;

/** Successful §7 result. */
export interface ValidationSuccess {
  ok: true;
  unit: {
    unitId: string;
    version: number;
    stats: StatsSnapshot;
    cost: number;
    breakdown: CostBreakdown;
    /** The normalized sprite (§5.1), or null when the unit has no sprite(). */
    sprite: SpriteSpec | null;
  };
  warnings: ValidationWarning[];
  playerHint: string;
}

/** Failed §7 result (HTTP 422 body, MCP isError result). */
export interface ValidationFailure {
  ok: false;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  cost: number | null;
  playerHint: string;
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

/** §10.1 service error. */
export interface ServiceError {
  code: ErrorCode;
  message: string;
  hint?: string;
  details?: Record<string, unknown>;
}

/** §10.1 service result. */
export type Result<T> = { ok: true; data: T } | { ok: false; error: ServiceError };

export const ok = <T>(data: T): Result<T> => ({ ok: true, data });
export const fail = (
  code: ErrorCode,
  message: string,
  extra: { hint?: string; details?: Record<string, unknown> } = {},
): Result<never> => ({ ok: false, error: { code, message, ...extra } });

/** Suggested HTTP status per service error code (validation failures are 422). */
export function httpStatusFor(code: ErrorCode): number {
  switch (code) {
    case 'AUTH_REQUIRED':
    case 'KEY_INVALID':
    case 'BAD_LOGIN':
    case 'TERMINAL_LOGIN_REQUIRED':
      return 401;
    case 'ADMIN_REQUIRED':
    case 'CLAUDE_SEAT_NOT_YOURS':
    case 'TERMINAL_BAD_ORIGIN':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'NAME_TAKEN':
    case 'GAME_FULL':
    case 'PHASE_CLOSED':
    case 'CELL_TAKEN':
    case 'NOT_ALL_READY':
    case 'NOTHING_SELECTED':
    case 'NO_FIGHTERS':
    case 'NOT_ENOUGH_PLAYERS':
    case 'NO_TEAMS':
    case 'SAME_TEAM':
    case 'TEMPLATE_PROTECTED':
    case 'TEMPLATE_WOULD_BREAK':
    case 'UNIT_CHANGED':
    case 'CLAUDE_SEAT_TAKEN':
      return 409;
    case 'RATE_LIMITED':
      return 429;
    case 'INTERNAL':
      return 500;
    case 'CLAUDE_BOX_DOWN':
    case 'SEAT_PASSWORD_WRONG':
      return 502;
    case 'CLAUDE_BOX_NOT_SET':
    case 'TERMINAL_BUSY':
      return 503;
    default:
      return (VALIDATION_ERROR_CODES as readonly string[]).includes(code) ||
        code === 'VALIDATION_FAILED'
        ? 422
        : 400;
  }
}

// ---------------------------------------------------------------------------
// Player hints: one short, cheerful sentence per code. `{field}` is replaced
// with a friendly stat name.
// ---------------------------------------------------------------------------

const FRIENDLY_FIELD: Record<string, string> = {
  name: 'name',
  type: 'type',
  maxHealth: 'health',
  damage: 'damage',
  range: 'range',
  speed: 'speed',
  attackCooldown: 'attack speed',
  color: 'colour',
  size: 'size',
  shape: 'shape',
  productionInterval: 'building speed',
};

const PLAYER_HINTS: Record<ValidationErrorCode | WarningCode, string> = {
  SOURCE_TOO_LARGE: 'That unit is HUGE! Ask Claude to make the code shorter.',
  EMPTY_SOURCE: "Oops, there's no code yet! Ask Claude to write your unit.",
  SYNTAX_ERROR: "There's a typo in the code. Ask Claude to fix it!",
  IMPORT_NOT_ALLOWED: "Units can't use code from other files. Ask Claude to keep it all in one file.",
  NO_DEFAULT_EXPORT: "The game can't find your unit in the code. Ask Claude to fix it!",
  NOT_A_CLASS: "The code isn't shaped like a unit yet. Ask Claude to fix it!",
  EVAL_THREW: 'The code crashed when the game loaded it. Ask Claude to fix it!',
  TIMEOUT: 'The code took too long to load. Ask Claude to look for a loop that never ends.',
  CONSTRUCTOR_THREW: 'Your unit crashed while being built. Ask Claude to fix it!',
  STAT_MISSING: 'Your unit is missing its {field}! Ask Claude to add it.',
  STAT_IS_GETTER: 'Your unit needs plain numbers for its stats. Ask Claude to fix its {field}.',
  STAT_WRONG_TYPE: "Your unit's {field} looks wrong. Ask Claude to fix it.",
  STAT_NOT_FINITE: "Your unit's {field} isn't a real number. Ask Claude to fix it.",
  STAT_OUT_OF_RANGE: "Your unit's {field} is too big or too small! Ask Claude to change it.",
  COOLDOWN_NOT_INTEGER: 'Attack speed must be a whole number. Ask Claude to fix it.',
  BAD_COLOR: 'That colour code looks wrong. Ask Claude to pick a colour like #33CC66.',
  BAD_NAME: 'Your unit needs a name from 1 to 24 letters. Ask Claude to rename it.',
  TOWER_CANNOT_MOVE: "Towers can't move! Ask Claude to set the tower's speed to 0.",
  BUILDING_CANNOT_ATTACK: "Walls and factories can't attack! Ask Claude to remove the damage, or make a tower instead.",
  BUILDING_CANNOT_MOVE: "Walls and factories can't move! Ask Claude to remove the speed.",
  INTERVAL_NOT_INTEGER: 'The factory needs a whole number of ticks between minions. Ask Claude to fix it.',
  STATS_NOT_STABLE: 'Your unit changes its stats every time. Ask Claude to use fixed numbers.',
  UNIT_TOO_EXPENSIVE: 'Your unit costs too much! Ask Claude to make it cheaper.',
  SPRITE_THREW: "Drawing your unit's picture crashed. Ask Claude to fix it!",
  SPRITE_BAD_GRID: "Your unit's picture is the wrong size. Ask Claude to fix it!",
  SPRITE_BAD_PALETTE: "Your unit's picture uses a colour the game doesn't know. Ask Claude to fix it!",
  SPRITE_BAD_FRAME: "Your unit's picture has a mistake in it. Ask Claude to fix it!",
  SPRITE_TOO_MANY_FRAMES: "Your unit's animation is too long. Ask Claude to use fewer pictures.",
  SPRITE_EMPTY: "Your unit's picture is blank! Ask Claude to draw something.",
  SPRITE_NOT_STABLE: "Your unit's picture changes every time. Ask Claude to draw it the same way each time.",
  UPDATE_MISSING: "Your unit doesn't know what to do in battle. Ask Claude to give it some moves!",
  UPDATE_THREW: 'Your unit crashed during a practice battle. Ask Claude to fix it!',
  UPDATE_TIMEOUT: 'Your unit thinks too slowly. Ask Claude to help it think faster!',
  BAD_ACTION: "Your unit gave an order the game doesn't understand. Ask Claude to fix it.",
  W_NO_SPRITE: 'Ask Claude to draw a pixel-art sprite for your unit!',
  W_NEVER_ATTACKS: "Heads up: your unit never attacks, even when an enemy is close!",
  W_NEVER_MOVES: 'Heads up: your soldier never moves.',
  W_ZERO_DAMAGE: 'Heads up: your unit does 0 damage.',
  W_RETURNS_NOTHING: "Heads up: sometimes your unit can't decide what to do.",
  W_SLOW: 'Heads up: your unit thinks a bit slowly.',
  W_SLOW_NO_DISCOUNT:
    "Tip: attacking slower than once a second doesn't make it cheaper. Ask Claude to make it attack once a second.",
  W_STAT_NEAR_MAX: 'Tip: a maxed-out stat costs up to 3 times as much. Two medium units usually beat one giant one!',
  W_STAT_IGNORED: "Heads up: this kind of unit doesn't use its {field}, so the game ignores it.",
  W_UPDATE_IGNORED: "Heads up: walls don't think, so the game never runs this wall's update().",
  W_ACTION_NOT_FOR_TYPE: "Heads up: your unit sometimes gives an order its type can't do, so it waits instead.",
  W_TRAPPED: 'Walled in! Leave a gap so your unit can get out.',
};

/** Player hint for a code, with `{field}` filled in. */
export function playerHintFor(code: ValidationErrorCode | WarningCode, field?: string): string {
  const name = field ? (FRIENDLY_FIELD[field] ?? field) : 'stats';
  return PLAYER_HINTS[code].replaceAll('{field}', name);
}

/** Special-cased hints that read better than the generic templates. */
export function playerHintForIssue(issue: ValidationIssue): string {
  // Enum fields: "too big or too small" makes no sense for a word.
  if (issue.code === 'STAT_OUT_OF_RANGE' && issue.field === 'type') {
    return 'Your unit must be a soldier, tower, wall or factory. Ask Claude to fix its type.';
  }
  if (issue.code === 'STAT_OUT_OF_RANGE' && issue.field === 'shape') {
    return 'Your unit must be a circle, square, triangle or diamond. Ask Claude to fix its shape.';
  }
  const { min, max } = (issue.allowed ?? {}) as { min?: number; max?: number };
  const value = typeof issue.value === 'number' && Number.isFinite(issue.value) ? issue.value : undefined;
  const n = (v: number) => String(Math.round(v * 100) / 100);
  if (issue.code === 'STAT_OUT_OF_RANGE' && issue.field === 'damage' && value !== undefined && max !== undefined && value > max) {
    return 'Whoa, that unit hits WAY too hard! Ask Claude to lower its damage.';
  }
  // Attack speed is a cooldown: a small number means fast, so say it in words.
  if (issue.code === 'STAT_OUT_OF_RANGE' && issue.field === 'attackCooldown' && value !== undefined) {
    if (min !== undefined && value < min) return 'Your unit attacks too fast! Ask Claude to slow it down a little.';
    if (max !== undefined && value > max) return 'Your unit attacks too slowly! Ask Claude to speed it up.';
  }
  // Concrete numbers: "Your unit's range is too big! (500, the max is 300)".
  if (issue.code === 'STAT_OUT_OF_RANGE' && issue.field && value !== undefined) {
    const name = FRIENDLY_FIELD[issue.field] ?? issue.field;
    if (max !== undefined && value > max) return `Your unit's ${name} is too big! (${n(value)}, the max is ${n(max)}) Ask Claude to lower it.`;
    if (min !== undefined && value < min) return `Your unit's ${name} is too small! (${n(value)}, the min is ${n(min)}) Ask Claude to raise it.`;
  }
  if (issue.code === 'UNIT_TOO_EXPENSIVE' && value !== undefined && max !== undefined) {
    return `Your unit costs too much! ($${value}, the max is $${max}) Ask Claude to make it cheaper.`;
  }
  return playerHintFor(issue.code, issue.field);
}

export const SUCCESS_PLAYER_HINT =
  'Your unit is ready! Find it in My Units on your Pixel Clash page.';
