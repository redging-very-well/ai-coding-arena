// §7 step 6: hard guards on the stats read from a constructed unit.
//
// Input is the JSON-copied bag of own data properties produced by step 5
// (values are `unknown`: kid code can set anything). No coercion: the string
// "100" is STAT_WRONG_TYPE, not 100. Every problem found is reported (not just
// the first), each as a §7 error object with code/field/value/allowed/message/fix.

import type { StatBounds } from './config.js';
import {
  DEFAULT_SHAPE,
  DEFAULT_SIZE,
  SHAPES,
  UNIT_TYPES,
  type Shape,
  type StatsSnapshot,
  type UnitType,
} from './contract.js';
import type { ValidationError } from './errors.js';

export const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/;

export type StatsCheckResult =
  | { ok: true; stats: StatsSnapshot }
  | { ok: false; errors: ValidationError[] };

/** JSON-safe rendering of an arbitrary value for the `value` field. */
function safeValue(v: unknown): unknown {
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
  if (typeof v === 'bigint' || typeof v === 'symbol' || typeof v === 'function') return String(v);
  if (typeof v === 'undefined') return 'undefined';
  return v;
}

/** An example value inside the allowed range, for `fix` texts. */
function example(field: string, min: number, max: number): number {
  const preferred: Record<string, number> = {
    maxHealth: 120,
    damage: 10,
    range: 40,
    speed: 1.5,
    attackCooldown: 60,
    size: 10,
  };
  const p = preferred[field];
  if (p !== undefined && p >= min && p <= max) return p;
  return min;
}

function wrongType(field: string, value: unknown, expected: string, fix: string): ValidationError {
  return {
    code: 'STAT_WRONG_TYPE',
    field,
    value: safeValue(value),
    allowed: { type: expected },
    message: `${field} must be a ${expected} but it is ${value === null ? 'null' : typeof value}${
      typeof value === 'string' ? ` ("${value}")` : ''
    }.`,
    fix,
  };
}

/**
 * Check one numeric stat: typeof number, finite, within [min, max].
 * Returns the number when valid, or pushes an error and returns undefined.
 */
function checkNumber(
  errors: ValidationError[],
  field: string,
  value: unknown,
  range: { min: number; max: number },
  opts: { integer?: boolean; fix?: string } = {},
): number | undefined {
  const eg = example(field, range.min, range.max);
  const setFix =
    opts.fix ?? `In the constructor set this.${field} to a number from ${range.min} to ${range.max}, e.g. this.${field} = ${eg}.`;
  if (typeof value !== 'number') {
    errors.push(wrongType(field, value, 'number', `${setFix} Use a plain number, not text or a calculation result that might be undefined.`));
    return undefined;
  }
  if (!Number.isFinite(value)) {
    errors.push({
      code: 'STAT_NOT_FINITE',
      field,
      value: safeValue(value),
      allowed: { min: range.min, max: range.max },
      message: `${field} is ${String(value)}, which is not a real number.`,
      fix: setFix,
    });
    return undefined;
  }
  if (value < range.min || value > range.max) {
    errors.push({
      code: 'STAT_OUT_OF_RANGE',
      field,
      value,
      allowed: { min: range.min, max: range.max },
      message: `${field} is ${value} but must be between ${range.min} and ${range.max}.`,
      fix: setFix,
    });
    return undefined;
  }
  if (opts.integer && !Number.isInteger(value)) {
    const rounded = Math.min(range.max, Math.max(range.min, Math.round(value)));
    errors.push({
      code: 'COOLDOWN_NOT_INTEGER',
      field,
      value,
      allowed: { min: range.min, max: range.max, integer: true },
      message: `${field} is ${value} but must be a whole number of ticks.`,
      fix: `In the constructor set this.${field} to a whole number, e.g. this.${field} = ${rounded}.`,
    });
    return undefined;
  }
  return value;
}

/**
 * Run the §7 step-6 guards on raw stats. On success returns a frozen
 * `StatsSnapshot` with the trimmed name and the size and shape filled in.
 *
 * Missing fields (`undefined`) are reported as STAT_MISSING so this function
 * is safe to call on its own; the validator's step 5 normally catches them first.
 */
export function checkStats(raw: Readonly<Record<string, unknown>>, bounds: StatBounds): StatsCheckResult {
  const errors: ValidationError[] = [];

  const required = ['name', 'type', 'maxHealth', 'damage', 'range', 'speed', 'attackCooldown', 'color'];
  for (const field of required) {
    if (raw[field] === undefined) {
      errors.push({
        code: 'STAT_MISSING',
        field,
        message: `The unit does not set ${field}.`,
        fix: `In the constructor add this.${field} = …; as a plain data property (see the contract).`,
      });
    }
  }
  const has = (f: string) => raw[f] !== undefined;

  // name: string, 1-24 chars after trim, no control chars.
  let name: string | undefined;
  if (has('name')) {
    const v = raw.name;
    const { min, max } = bounds.nameLength;
    if (typeof v !== 'string') {
      errors.push(wrongType('name', v, 'string', `In the constructor set this.name to text, e.g. this.name = "Swift Ninja".`));
    } else {
      const trimmed = v.trim();
      // Count code points, not UTF-16 units, so an emoji is one character.
      const length = [...trimmed].length;
      if (length < min || length > max || CONTROL_CHARS_RE.test(trimmed)) {
        errors.push({
          code: 'BAD_NAME',
          field: 'name',
          value: v,
          allowed: { minLength: min, maxLength: max, controlChars: false },
          message: `name must be ${min}-${max} characters (after trimming spaces) with no control characters; it is ${length} characters.`,
          fix: `In the constructor set this.name to a short name of ${min}-${max} characters, e.g. this.name = "Swift Ninja".`,
        });
      } else {
        name = trimmed;
      }
    }
  }

  // type: 'soldier' | 'tower'.
  let type: UnitType | undefined;
  if (has('type')) {
    const v = raw.type;
    if (typeof v !== 'string') {
      errors.push(wrongType('type', v, 'string', `In the constructor set this.type = "soldier" or this.type = "tower".`));
    } else if (!(UNIT_TYPES as readonly string[]).includes(v)) {
      errors.push({
        code: 'STAT_OUT_OF_RANGE',
        field: 'type',
        value: v,
        allowed: { oneOf: [...UNIT_TYPES] },
        message: `type is "${v}" but must be "soldier" or "tower".`,
        fix: `In the constructor set this.type = "soldier" (moves) or this.type = "tower" (never moves).`,
      });
    } else {
      type = v as UnitType;
    }
  }

  const maxHealth = has('maxHealth') ? checkNumber(errors, 'maxHealth', raw.maxHealth, bounds.maxHealth) : undefined;
  const damage = has('damage') ? checkNumber(errors, 'damage', raw.damage, bounds.damage) : undefined;
  const range = has('range') ? checkNumber(errors, 'range', raw.range, bounds.range) : undefined;
  const attackCooldown = has('attackCooldown')
    ? checkNumber(errors, 'attackCooldown', raw.attackCooldown, bounds.attackCooldown, { integer: true })
    : undefined;

  // speed: towers exactly 0, soldiers within soldierSpeed.
  let speed: number | undefined;
  if (has('speed')) {
    const v = raw.speed;
    if (type === 'tower' && typeof v === 'number' && Number.isFinite(v) && v !== 0) {
      errors.push({
        code: 'TOWER_CANNOT_MOVE',
        field: 'speed',
        value: v,
        allowed: { equals: 0 },
        message: `This unit is a tower, so speed must be 0, but it is ${v}.`,
        fix: `In the constructor set this.speed = 0 for a tower, or change this.type to "soldier" if it should move.`,
      });
    } else if (type === 'tower') {
      speed = checkNumber(errors, 'speed', v, { min: 0, max: 0 }, { fix: 'Towers never move: set this.speed = 0.' });
    } else {
      // Unknown or soldier type: check against soldier bounds.
      speed = checkNumber(errors, 'speed', v, bounds.soldierSpeed);
    }
  }

  // color: "#RRGGBB".
  let color: string | undefined;
  if (has('color')) {
    const v = raw.color;
    if (typeof v !== 'string') {
      errors.push(wrongType('color', v, 'string', `In the constructor set this.color to a hex colour string, e.g. this.color = "#33CC66".`));
    } else if (!COLOR_RE.test(v)) {
      errors.push({
        code: 'BAD_COLOR',
        field: 'color',
        value: v,
        allowed: { pattern: '#RRGGBB' },
        message: `color is "${v}" but must look like "#RRGGBB" (a # and 6 hex digits).`,
        fix: `In the constructor set this.color to a hex colour like this.color = "#33CC66" (no colour names, no 3-digit codes).`,
      });
    } else {
      color = v;
    }
  }

  // size: optional body radius; the type default applies when it is omitted.
  const size = has('size') ? checkNumber(errors, 'size', raw.size, bounds.size) : undefined;

  // shape: optional.
  let shape: Shape | undefined;
  if (has('shape')) {
    const v = raw.shape;
    if (typeof v !== 'string') {
      errors.push(wrongType('shape', v, 'string', `Remove this.shape or set it to one of: ${SHAPES.join(', ')}.`));
    } else if (!(SHAPES as readonly string[]).includes(v)) {
      errors.push({
        code: 'STAT_OUT_OF_RANGE',
        field: 'shape',
        value: v,
        allowed: { oneOf: [...SHAPES] },
        message: `shape is "${v}" but must be one of ${SHAPES.join(', ')}.`,
        fix: `Set this.shape to one of: ${SHAPES.map((s) => `"${s}"`).join(', ')} (or remove it).`,
      });
    } else {
      shape = v as Shape;
    }
  }

  if (
    errors.length > 0 ||
    name === undefined ||
    type === undefined ||
    maxHealth === undefined ||
    damage === undefined ||
    range === undefined ||
    speed === undefined ||
    attackCooldown === undefined ||
    color === undefined
  ) {
    return { ok: false, errors };
  }

  const stats: StatsSnapshot = Object.freeze({
    name,
    type,
    maxHealth,
    damage,
    range,
    speed,
    attackCooldown,
    color,
    size: size ?? DEFAULT_SIZE[type],
    shape: shape ?? DEFAULT_SHAPE[type],
  });
  return { ok: true, stats };
}
