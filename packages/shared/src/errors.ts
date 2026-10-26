// Error codes, the error object format, and friendly hint templates.
//
// Errors are written for Claude first (precise `message` + actionable `fix`)
// and the player second (`playerHint`). Every validation failure is a
// `ValidationIssue`; every service failure is a `ServiceError`.

import { money, type CostBreakdown } from './cost.js';
import type { MinionOrder, SpriteSpec, StatsSnapshot } from './contract.js';

/** Validation pipeline failure codes, in pipeline order. */
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
  // M8.5 buildings
  'BUILDING_CANNOT_ATTACK',
  'BUILDING_CANNOT_MOVE',
  'INTERVAL_NOT_INTEGER',
  // M8.6 minion kinds, orders and burst
  'BURST_NOT_INTEGER',
  // 7 determinism
  'STATS_NOT_STABLE',
  // 8 cost
  'UNIT_TOO_EXPENSIVE',
  // 8b sprite
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

/** Step 10 non-fatal warnings (W_NO_SPRITE comes from step 8b). */
export const WARNING_CODES = [
  'W_NO_SPRITE',
  'W_NEVER_ATTACKS',
  'W_NEVER_MOVES',
  'W_ZERO_DAMAGE',
  'W_RETURNS_NOTHING',
  'W_SLOW',
  'W_SLOW_NO_DISCOUNT',
  'W_STAT_NEAR_MAX',
  // M8.5 buildings
  'W_STAT_IGNORED',
  'W_UPDATE_IGNORED',
  'W_ACTION_NOT_FOR_TYPE',
  // Minion code
  'W_MINION_IGNORED',
  'W_TRAPPED',
  // M8.6
  'W_ORDER_TARGET',
  'W_BURST_NEVER_FULL',
  // M8.8 elements, splash and support
  'W_HEAL_NEVER_USED',
  'W_POWER_HIGH',
] as const;
export type WarningCode = (typeof WARNING_CODES)[number];

/** Service / API error codes. */
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
  // The match setting "Walls allowed" is off: wall designs can't be picked, placed or borrowed.
  'WALLS_OFF',
  'NOT_ALL_READY',
  'NOTHING_SELECTED',
  // M8.5: only walls selected / placed.
  'NO_FIGHTERS',
  'NOT_ENOUGH_PLAYERS',
  'BAD_MAP_STYLE',
  'BAD_TEAM_MODE',
  'NO_TEAMS',
  'SAME_TEAM',
  // Moving the last player off a team: every team keeps ≥ 1 player.
  'LAST_MEMBER',
  'TEMPLATE_PROTECTED',
  'TEMPLATE_WOULD_BREAK',
  // Optimistic concurrency: the unit was revised since `baseVersion`.
  'UNIT_CHANGED',
  // Claude seats and the seat terminal proxy.
  'BAD_CLAUDE_SEAT',
  'CLAUDE_SEAT_TAKEN',
  // The admin turned that AI seat off: never assigned or pickable.
  'CLAUDE_SEAT_OFF',
  'BAD_SEAT_SECRET',
  // A shared agent login pasted in /admin has the wrong shape.
  'BAD_AGENT_CREDENTIAL',
  'TERMINAL_LOGIN_REQUIRED',
  'CLAUDE_SEAT_NOT_YOURS',
  'TERMINAL_BAD_ORIGIN',
  'AI_SESSION_HOST_NOT_SET',
  'AI_SESSION_HOST_DOWN',
  'SEAT_PASSWORD_WRONG',
  'TERMINAL_BUSY',
  'VALIDATION_FAILED',
  'INTERNAL',
] as const;
export type ServiceErrorCode = (typeof SERVICE_ERROR_CODES)[number];

export type ErrorCode = ValidationErrorCode | ServiceErrorCode;

/** One entry of `errors[]` / `warnings[]` in the result body. */
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
  // SPRITE_* location, all counted from 0 like array indexes.
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

/** Successful result. */
export interface ValidationSuccess {
  ok: true;
  unit: {
    unitId: string;
    version: number;
    stats: StatsSnapshot;
    cost: number;
    breakdown: CostBreakdown;
    /** The normalized sprite, or null when the unit has no sprite(). */
    sprite: SpriteSpec | null;
    /** M8.6 factories: the squad orders update() gave in the dry run, in first-seen order. */
    orders?: MinionOrder[];
    /** M8.8 heal support: whether update() returned { action: 'heal' } in the dry run. */
    healUsed?: boolean;
  };
  warnings: ValidationWarning[];
  playerHint: string;
}

/** Failed result (HTTP 422 body, MCP isError result). */
export interface ValidationFailure {
  ok: false;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  cost: number | null;
  playerHint: string;
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

/** A service error (REST and MCP return the same object). */
export interface ServiceError {
  code: ErrorCode;
  message: string;
  hint?: string;
  details?: Record<string, unknown>;
}

/** A service result. */
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
    case 'WALLS_OFF':
    case 'NOT_ENOUGH_PLAYERS':
    case 'NO_TEAMS':
    case 'SAME_TEAM':
    case 'LAST_MEMBER':
    case 'TEMPLATE_PROTECTED':
    case 'TEMPLATE_WOULD_BREAK':
    case 'UNIT_CHANGED':
    case 'CLAUDE_SEAT_TAKEN':
    case 'CLAUDE_SEAT_OFF':
      return 409;
    case 'RATE_LIMITED':
      return 429;
    case 'INTERNAL':
      return 500;
    case 'AI_SESSION_HOST_DOWN':
    case 'SEAT_PASSWORD_WRONG':
      return 502;
    case 'AI_SESSION_HOST_NOT_SET':
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
  produces: 'minion kind',
  burst: 'burst',
  element: 'element',
  minionElement: 'minion element',
  splashRadius: 'splash',
  support: 'support',
  supportPower: 'support power',
  supportRange: 'support range',
};

const PLAYER_HINTS: Record<ValidationErrorCode | WarningCode, string> = {
  SOURCE_TOO_LARGE: 'That unit is HUGE! Ask your AI helper to make the code shorter.',
  EMPTY_SOURCE: "Oops, there's no code yet! Ask your AI helper to write your unit.",
  SYNTAX_ERROR: "There's a typo in the code. Ask your AI helper to fix it!",
  IMPORT_NOT_ALLOWED: "Units can't use code from other files. Ask your AI helper to keep it all in one file.",
  NO_DEFAULT_EXPORT: "The game can't find your unit in the code. Ask your AI helper to fix it!",
  NOT_A_CLASS: "The code isn't shaped like a unit yet. Ask your AI helper to fix it!",
  EVAL_THREW: 'The code crashed when the game loaded it. Ask your AI helper to fix it!',
  TIMEOUT: 'The code took too long to load. Ask your AI helper to look for a loop that never ends.',
  CONSTRUCTOR_THREW: 'Your unit crashed while being built. Ask your AI helper to fix it!',
  STAT_MISSING: 'Your unit is missing its {field}! Ask your AI helper to add it.',
  STAT_IS_GETTER: 'Your unit needs plain numbers for its stats. Ask your AI helper to fix its {field}.',
  STAT_WRONG_TYPE: "Your unit's {field} looks wrong. Ask your AI helper to fix it.",
  STAT_NOT_FINITE: "Your unit's {field} isn't a real number. Ask your AI helper to fix it.",
  STAT_OUT_OF_RANGE: "Your unit's {field} is too big or too small! Ask your AI helper to change it.",
  COOLDOWN_NOT_INTEGER: 'Attack speed must be a whole number. Ask your AI helper to fix it.',
  BAD_COLOR: 'That colour code looks wrong. Ask your AI helper to pick a colour like #33CC66.',
  BAD_NAME: 'Your unit needs a name from 1 to 24 letters. Ask your AI helper to rename it.',
  TOWER_CANNOT_MOVE: "Towers can't move! Ask your AI helper to set the tower's speed to 0.",
  BUILDING_CANNOT_ATTACK: "Walls and factories can't attack! Ask your AI helper to remove the damage, or make a tower instead.",
  BUILDING_CANNOT_MOVE: "Walls and factories can't move! Ask your AI helper to remove the speed.",
  INTERVAL_NOT_INTEGER: 'The factory needs a whole number of ticks between minions. Ask your AI helper to fix it.',
  BURST_NOT_INTEGER: 'A burst must be a whole number of minions (1 to 4). Ask your AI helper to fix it.',
  STATS_NOT_STABLE: 'Your unit changes its stats every time. Ask your AI helper to use fixed numbers.',
  UNIT_TOO_EXPENSIVE: 'Your unit costs too much! Ask your AI helper to make it cheaper.',
  SPRITE_THREW: "Drawing your unit's picture crashed. Ask your AI helper to fix it!",
  SPRITE_BAD_GRID: "Your unit's picture is the wrong size. Ask your AI helper to fix it!",
  SPRITE_BAD_PALETTE: "Your unit's picture uses a colour the game doesn't know. Ask your AI helper to fix it!",
  SPRITE_BAD_FRAME: "Your unit's picture has a mistake in it. Ask your AI helper to fix it!",
  SPRITE_TOO_MANY_FRAMES: "Your unit's animation is too long. Ask your AI helper to use fewer pictures.",
  SPRITE_EMPTY: "Your unit's picture is blank! Ask your AI helper to draw something.",
  SPRITE_NOT_STABLE: "Your unit's picture changes every time. Ask your AI helper to draw it the same way each time.",
  UPDATE_MISSING: "Your unit doesn't know what to do in battle. Ask your AI helper to give it some moves!",
  UPDATE_THREW: 'Your unit crashed during a practice battle. Ask your AI helper to fix it!',
  UPDATE_TIMEOUT: 'Your unit thinks too slowly. Ask your AI helper to help it think faster!',
  BAD_ACTION: "Your unit gave an order the game doesn't understand. Ask your AI helper to fix it.",
  W_NO_SPRITE: 'Ask your AI helper to draw a pixel-art sprite for your unit!',
  W_NEVER_ATTACKS: "Heads up: your unit never attacks, even when an enemy is close!",
  W_NEVER_MOVES: 'Heads up: your soldier never moves.',
  W_ZERO_DAMAGE: 'Heads up: your unit does 0 damage.',
  W_RETURNS_NOTHING: "Heads up: sometimes your unit can't decide what to do.",
  W_SLOW: 'Heads up: your unit thinks a bit slowly.',
  W_SLOW_NO_DISCOUNT:
    "Heads up: attacking slower than once a second doesn't make a unit any cheaper.",
  W_STAT_NEAR_MAX: 'Heads up: a stat near its max costs up to 2 times its normal price.',
  W_STAT_IGNORED: "Heads up: this kind of unit doesn't use its {field}, so the game ignores it.",
  W_UPDATE_IGNORED: "Heads up: walls don't think, so the game never runs this wall's update().",
  W_ACTION_NOT_FOR_TYPE: "Heads up: your unit sometimes gives an order its type can't do, so it waits instead.",
  W_MINION_IGNORED: "Heads up: only factories have minions, so the game never runs this unit's minion code.",
  W_TRAPPED: 'Walled in! Leave a gap so your unit can get out.',
  W_ORDER_TARGET: 'Heads up: your factory sometimes points its minions at the wrong side (swarm an enemy, guard a friend).',
  W_BURST_NEVER_FULL: "Heads up: this factory never makes enough minions to fill its burst, so they leave when it runs out.",
  W_HEAL_NEVER_USED: "Heads up: your healer never healed anyone in the practice battles. Ask your AI helper to make it heal hurt friends!",
  W_POWER_HIGH: 'Heads up: a unit that is very tough AND very strong costs extra (up to 3 times).',
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
    return 'Your unit must be a soldier, tower, wall or factory. Ask your AI helper to fix its type.';
  }
  if (issue.code === 'STAT_OUT_OF_RANGE' && issue.field === 'produces') {
    return 'A factory can build grunts, archers, runners, brutes or medics. Ask your AI helper to pick one of those.';
  }
  if (issue.code === 'STAT_OUT_OF_RANGE' && (issue.field === 'element' || issue.field === 'minionElement')) {
    return 'The elements are normal, fire, ice and lightning. Ask your AI helper to pick one of those.';
  }
  if (issue.code === 'STAT_OUT_OF_RANGE' && issue.field === 'support') {
    return 'A unit can support with heal, haste, might or shield. Ask your AI helper to pick one of those.';
  }
  if (issue.code === 'STAT_OUT_OF_RANGE' && issue.field === 'shape') {
    return 'Your unit must be a circle, square, triangle or diamond. Ask your AI helper to fix its shape.';
  }
  const { min, max } = (issue.allowed ?? {}) as { min?: number; max?: number };
  const value = typeof issue.value === 'number' && Number.isFinite(issue.value) ? issue.value : undefined;
  const n = (v: number) => String(Math.round(v * 100) / 100);
  if (issue.code === 'STAT_OUT_OF_RANGE' && issue.field === 'damage' && value !== undefined && max !== undefined && value > max) {
    return 'Whoa, that unit hits WAY too hard! Ask your AI helper to lower its damage.';
  }
  // Attack speed is a cooldown: a small number means fast, so say it in words.
  if (issue.code === 'STAT_OUT_OF_RANGE' && issue.field === 'attackCooldown' && value !== undefined) {
    if (min !== undefined && value < min) return 'Your unit attacks too fast! Ask your AI helper to slow it down a little.';
    if (max !== undefined && value > max) return 'Your unit attacks too slowly! Ask your AI helper to speed it up.';
  }
  // Concrete numbers: "Your unit's range is too big! (500, the max is 300)".
  if (issue.code === 'STAT_OUT_OF_RANGE' && issue.field && value !== undefined) {
    const name = FRIENDLY_FIELD[issue.field] ?? issue.field;
    if (max !== undefined && value > max) return `Your unit's ${name} is too big! (${n(value)}, the max is ${n(max)}) Ask your AI helper to lower it.`;
    if (min !== undefined && value < min) return `Your unit's ${name} is too small! (${n(value)}, the min is ${n(min)}) Ask your AI helper to raise it.`;
  }
  if (issue.code === 'UNIT_TOO_EXPENSIVE' && value !== undefined && max !== undefined) {
    return `Your unit costs too much! (${money(value)}, the max is ${money(max)}) Ask your AI helper to make it cheaper.`;
  }
  return playerHintFor(issue.code, issue.field);
}

export const SUCCESS_PLAYER_HINT =
  'Your unit is ready! Find it in My Units on your Pixel Clash page.';
