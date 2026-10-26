// Validation of the SpriteSpec returned by a unit's
// optional sprite() method, and the fallback sprite generated
// from color + shape + type when a unit has no sprite (or it was hidden by the
// facilitator). Shared by the server (validation) and the client (fallback).
//
// Input to `checkSprite` is the JSON copy of what sprite() returned (values
// are `unknown`: player code can return anything). Errors are written for Claude
// first: every SPRITE_BAD_FRAME names the state, frame, row and col (all
// counted from 0, like array indexes) so Claude can jump straight to the bad
// pixel.

import type { Shape, SpriteFrame, SpriteSpec, UnitStats } from './contract.js';
import { DEFAULT_SHAPE } from './contract.js';
import { COLOR_RE } from './bounds.js';
import type { ValidationError, ValidationWarning } from './errors.js';

/** Allowed values of `grid`. */
export const SPRITE_GRIDS = [8, 12, 16, 24, 32] as const;
export type SpriteGrid = (typeof SPRITE_GRIDS)[number];

/** Animation states, in the order they are checked and stored. */
export const SPRITE_STATES = ['idle', 'walk', 'attack', 'hit', 'death'] as const;
export type SpriteState = (typeof SPRITE_STATES)[number];

/** Frame count limits per state. */
export const SPRITE_FRAME_LIMITS: Readonly<Record<SpriteState, { min: number; max: number }>> = {
  idle: { min: 1, max: 4 },
  walk: { min: 1, max: 4 },
  attack: { min: 1, max: 4 },
  hit: { min: 1, max: 1 },
  death: { min: 1, max: 4 },
};

/** The transparent pixel. */
export const SPRITE_TRANSPARENT = '.';
/** Max palette entries. */
export const SPRITE_MAX_PALETTE = 16;
/** Min share of opaque pixels in every idle frame. */
export const SPRITE_MIN_OPAQUE = 0.1;
/** Max size of the JSON copy of sprite()'s result. */
export const SPRITE_MAX_JSON_BYTES = 200 * 1024;
/** At most this many SPRITE_BAD_FRAME errors are reported per check (keeps the result short). */
export const SPRITE_MAX_FRAME_ERRORS = 5;

/** A palette key: one printable ASCII character except '.' (and no space). */
const PALETTE_KEY_RE = /^[!-~]$/;

export type SpriteCheckResult =
  | { ok: true; sprite: SpriteSpec }
  | { ok: false; errors: ValidationError[] };

/** A short JSON-safe preview of a bad value for `value`. */
function preview(v: unknown): unknown {
  if (typeof v === 'string') return v.length > 40 ? `${v.slice(0, 40)}…` : v;
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return v;
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return `[array of ${v.length}]`;
  return `[${typeof v}]`;
}

function kindOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return typeof v === 'object' ? 'an object' : `a ${typeof v}`;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const SHAPE_HINT =
  'sprite() must return { grid: 16, palette: { o: "#222034", b: "#3399FF" }, frames: { idle: [[ ...16 strings of 16 chars ]] } }.';

/**
 * Check a sprite (the JSON copy of sprite()'s result). On success
 * returns the normalized spec: only the known keys, palette colours in upper
 * case, empty optional states dropped.
 */
export function checkSprite(raw: unknown): SpriteCheckResult {
  const errors: ValidationError[] = [];

  if (raw === undefined || raw === null) {
    return {
      ok: false,
      errors: [
        {
          code: 'SPRITE_EMPTY',
          field: 'sprite',
          value: preview(raw),
          message: 'sprite() returned nothing.',
          fix: `Return the sprite object from sprite(): ${SHAPE_HINT} Or delete sprite() to use a plain shape.`,
        },
      ],
    };
  }
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      errors: [
        {
          code: 'SPRITE_BAD_GRID',
          field: 'sprite',
          value: preview(raw),
          message: `sprite() returned ${kindOf(raw)}, but it must return an object.`,
          fix: SHAPE_HINT,
        },
      ],
    };
  }

  // grid
  const grid = raw.grid;
  const gridOk = typeof grid === 'number' && (SPRITE_GRIDS as readonly number[]).includes(grid);
  if (!gridOk) {
    errors.push({
      code: 'SPRITE_BAD_GRID',
      field: 'sprite.grid',
      value: preview(grid),
      allowed: { oneOf: [...SPRITE_GRIDS] },
      message: `grid is ${JSON.stringify(preview(grid))} but must be one of ${SPRITE_GRIDS.join(', ')}.`,
      fix: 'Set grid: 16 in the object sprite() returns (16 is a good size), and make every frame 16 rows of 16 characters.',
    });
  }

  // palette
  const palette = checkPalette(raw.palette, errors);

  // frames
  const framesRaw = raw.frames;
  if (!isPlainObject(framesRaw)) {
    errors.push({
      code: 'SPRITE_EMPTY',
      field: 'sprite.frames',
      value: preview(framesRaw),
      message: `frames is ${kindOf(framesRaw)}, but it must be an object with at least an idle animation.`,
      fix: 'Add frames: { idle: [ frame1, frame2 ], walk: [ frame1, frame2 ], attack: [ frame1 ] }, where each frame is an array of grid strings.',
    });
    return { ok: false, errors };
  }
  if (!gridOk) return { ok: false, errors };
  const size = grid as SpriteGrid;

  // Unknown states (a typo like "run") are errors so Claude learns the names.
  for (const key of Object.keys(framesRaw)) {
    if (framesRaw[key] !== undefined && !(SPRITE_STATES as readonly string[]).includes(key)) {
      errors.push({
        code: 'SPRITE_BAD_FRAME',
        field: `sprite.frames.${key}`,
        state: key,
        allowed: { oneOf: [...SPRITE_STATES] },
        message: `frames.${key} is not an animation the game knows.`,
        fix: `Rename frames.${key} to one of ${SPRITE_STATES.join(', ')} (a walking animation goes in walk), or remove it.`,
      });
    }
  }

  const frames: Partial<Record<SpriteState, SpriteFrame[]>> = {};
  let frameErrors = 0;
  const pushFrameError = (e: ValidationError) => {
    if (frameErrors++ < SPRITE_MAX_FRAME_ERRORS) errors.push(e);
  };

  for (const state of SPRITE_STATES) {
    const list = framesRaw[state];
    const limits = SPRITE_FRAME_LIMITS[state];
    if (state !== 'idle' && (list === undefined || (Array.isArray(list) && list.length === 0))) continue;
    if (list === undefined) {
      errors.push({
        code: 'SPRITE_EMPTY',
        field: 'sprite.frames.idle',
        state,
        message: 'frames has no idle animation. Every sprite needs at least one idle frame.',
        fix: `Add frames.idle with 1 or 2 frames: idle: [ [ ${size} strings of ${size} characters ] ]. Draw the unit standing, facing right.`,
      });
      continue;
    }
    if (!Array.isArray(list)) {
      pushFrameError({
        code: 'SPRITE_BAD_FRAME',
        field: `sprite.frames.${state}`,
        state,
        value: preview(list),
        message: `frames.${state} is ${kindOf(list)}, but it must be an array of frames.`,
        fix: `Make frames.${state} an array of frames: ${state}: [ [ "row 0", "row 1", … ] ]. Each frame is an array of ${size} strings of ${size} characters.`,
      });
      continue;
    }
    if (list.length === 0) {
      errors.push({
        code: 'SPRITE_EMPTY',
        field: 'sprite.frames.idle',
        state,
        value: [],
        allowed: limits,
        message: 'frames.idle has no frames. Every sprite needs at least one idle frame.',
        fix: `Add 1 or 2 idle frames: idle: [ [ ${size} strings of ${size} characters ] ]. Draw the unit standing, facing right.`,
      });
      continue;
    }
    if (list.length > limits.max) {
      errors.push({
        code: 'SPRITE_TOO_MANY_FRAMES',
        field: `sprite.frames.${state}`,
        state,
        value: list.length,
        allowed: limits,
        message: `frames.${state} has ${list.length} frames but the max is ${limits.max}.`,
        fix:
          limits.max === 1
            ? `Keep just 1 frame in frames.${state}.`
            : `Keep at most ${limits.max} frames in frames.${state} (2 walk frames and 1 attack frame look great). Remove the extra ones.`,
      });
      continue;
    }
    const checkedList: SpriteFrame[] = [];
    list.forEach((frame: unknown, fi: number) => {
      const f = checkFrame(frame, state, fi, size, palette, pushFrameError);
      if (f) checkedList.push(f);
    });
    if (checkedList.length === list.length) frames[state] = checkedList;
  }

  if (frameErrors > SPRITE_MAX_FRAME_ERRORS) {
    const last = errors[errors.length - 1];
    if (last) last.message += ` (${frameErrors - SPRITE_MAX_FRAME_ERRORS} more frame problems not shown.)`;
  }

  // Opacity: every idle frame must be at least 10% opaque.
  const idle = frames.idle;
  if (idle && errors.length === 0) {
    const need = Math.ceil(size * size * SPRITE_MIN_OPAQUE);
    idle.forEach((frame, fi) => {
      const opaque = frame.reduce((n, row) => n + [...row].filter((c) => c !== SPRITE_TRANSPARENT).length, 0);
      if (opaque < need) {
        errors.push({
          code: 'SPRITE_EMPTY',
          field: `sprite.frames.idle[${fi}]`,
          state: 'idle',
          frame: fi,
          value: { opaquePixels: opaque },
          allowed: { minOpaquePixels: need },
          message: `idle frame ${fi} has only ${opaque} coloured pixels out of ${size * size}; at least ${need} (10%) are needed so the unit can be seen.`,
          fix: `Draw the unit bigger in frames.idle[${fi}]: replace '.' (transparent) with palette characters so it fills most of the ${size}×${size} grid, with a dark outline.`,
        });
      }
    });
  }

  if (errors.length > 0 || !palette || !frames.idle) return { ok: false, errors };
  const sprite: SpriteSpec = { grid: size, palette, frames: { idle: frames.idle } };
  for (const state of SPRITE_STATES) {
    const f = frames[state];
    if (state !== 'idle' && f) sprite.frames[state] = f;
  }
  return { ok: true, sprite };
}

function checkPalette(raw: unknown, errors: ValidationError[]): Record<string, string> | undefined {
  const example = 'palette: { o: "#222034", b: "#3399FF", w: "#FFFFFF" }';
  if (!isPlainObject(raw)) {
    errors.push({
      code: 'SPRITE_BAD_PALETTE',
      field: 'sprite.palette',
      value: preview(raw),
      message: `palette is ${kindOf(raw)}, but it must be an object that maps one character to a colour.`,
      fix: `Add ${example}. Each key is one character used in the frames; '.' is always transparent.`,
    });
    return undefined;
  }
  const keys = Object.keys(raw);
  if (keys.length < 1 || keys.length > SPRITE_MAX_PALETTE) {
    errors.push({
      code: 'SPRITE_BAD_PALETTE',
      field: 'sprite.palette',
      value: keys.length,
      allowed: { minEntries: 1, maxEntries: SPRITE_MAX_PALETTE },
      message: `palette has ${keys.length} colours but must have 1 to ${SPRITE_MAX_PALETTE}.`,
      fix:
        keys.length < 1
          ? `Add colours: ${example}.`
          : `Use at most ${SPRITE_MAX_PALETTE} colours: merge similar shades and remove unused palette entries.`,
    });
    return undefined;
  }
  const out: Record<string, string> = {};
  let ok = true;
  for (const key of keys) {
    const value = raw[key];
    if (!PALETTE_KEY_RE.test(key) || key === SPRITE_TRANSPARENT) {
      ok = false;
      errors.push({
        code: 'SPRITE_BAD_PALETTE',
        field: `sprite.palette`,
        value: key,
        allowed: { key: "one printable character (letter, digit or symbol), not '.' or a space" },
        message:
          key === SPRITE_TRANSPARENT
            ? "The palette uses '.' as a key, but '.' always means transparent."
            : `The palette key ${JSON.stringify(key)} must be exactly one printable character (a letter, digit or symbol).`,
        fix: `Rename palette key ${JSON.stringify(key)} to a single letter like "r", and use that letter in the frames.`,
      });
    } else if (typeof value !== 'string' || !COLOR_RE.test(value)) {
      ok = false;
      errors.push({
        code: 'SPRITE_BAD_PALETTE',
        field: `sprite.palette.${key}`,
        value: preview(value),
        allowed: { pattern: '#RRGGBB' },
        message: `palette.${key} is ${JSON.stringify(preview(value))} but must be a colour like "#33CC66".`,
        fix: `Set palette.${key} to a "#RRGGBB" colour string, e.g. "${key}": "#33CC66". Don't use colour names or short "#RGB" codes.`,
      });
    } else {
      out[key] = value.toUpperCase();
    }
  }
  return ok ? out : undefined;
}

function checkFrame(
  frame: unknown,
  state: SpriteState,
  fi: number,
  size: number,
  palette: Record<string, string> | undefined,
  report: (e: ValidationError) => void,
): SpriteFrame | undefined {
  const where = `frames.${state}[${fi}]`;
  const base = { code: 'SPRITE_BAD_FRAME' as const, state, frame: fi };
  if (!Array.isArray(frame)) {
    report({
      ...base,
      field: `sprite.${where}`,
      value: preview(frame),
      message: `${where} is ${kindOf(frame)}, but a frame must be an array of ${size} strings.`,
      fix: `Make ${where} an array of ${size} strings, each exactly ${size} characters long (one character per pixel, '.' = transparent).`,
    });
    return undefined;
  }
  if (frame.length !== size) {
    report({
      ...base,
      field: `sprite.${where}`,
      value: { rows: frame.length },
      allowed: { rows: size },
      message: `${where} has ${frame.length} rows but grid is ${size}, so it needs exactly ${size} rows.`,
      fix: `${frame.length < size ? 'Add' : 'Remove'} rows in ${where} so it has exactly ${size} strings (or change grid to match).`,
    });
    return undefined;
  }
  const rows: string[] = [];
  for (let r = 0; r < size; r++) {
    const row: unknown = frame[r];
    if (typeof row !== 'string') {
      report({
        ...base,
        row: r,
        field: `sprite.${where}[${r}]`,
        value: preview(row),
        message: `${where} row ${r} is ${kindOf(row)}, but each row must be a string.`,
        fix: `Write row ${r} of ${where} as a string of ${size} characters, e.g. "${'.'.repeat(size)}".`,
      });
      return undefined;
    }
    if (row.length !== size) {
      report({
        ...base,
        row: r,
        col: Math.min(row.length, size),
        field: `sprite.${where}[${r}]`,
        value: preview(row),
        allowed: { length: size },
        message: `${where} row ${r} is ${row.length} characters long but must be exactly ${size} (rows and cols count from 0).`,
        fix: `${row.length < size ? 'Add' : 'Remove'} ${Math.abs(size - row.length)} character(s) in row ${r} of ${where} so it is exactly ${size} long. Pad with '.' for transparent.`,
      });
      return undefined;
    }
    if (palette) {
      for (let c = 0; c < size; c++) {
        const ch = row[c]!;
        if (ch !== SPRITE_TRANSPARENT && !Object.hasOwn(palette, ch)) {
          report({
            ...base,
            row: r,
            col: c,
            field: `sprite.${where}[${r}]`,
            value: ch,
            allowed: { oneOf: [SPRITE_TRANSPARENT, ...Object.keys(palette)] },
            message: `${where} row ${r} col ${c} uses ${JSON.stringify(ch)}, which is not in the palette (rows and cols count from 0).`,
            fix: `Add ${JSON.stringify(ch)} to the palette with a "#RRGGBB" colour, or change that pixel to a palette character or '.' (transparent).`,
          });
          return undefined;
        }
      }
    }
    rows.push(row);
  }
  return rows;
}

/** SPRITE_NOT_STABLE: two calls of sprite() gave different results. */
export function spriteNotStableError(): ValidationError {
  return {
    code: 'SPRITE_NOT_STABLE',
    field: 'sprite',
    message: 'sprite() returned a different picture when it was called a second time.',
    fix: "Make sprite() return the same fixed object every time: write the frames out as string literals and don't use Math.random(), Date.now() or counters in sprite().",
  };
}

/** SPRITE_THREW for a JSON copy over the size limit. */
export function spriteTooLargeError(bytes: number): ValidationError {
  return {
    code: 'SPRITE_THREW',
    field: 'sprite',
    value: { bytes },
    allowed: { maxBytes: SPRITE_MAX_JSON_BYTES },
    errorMessage: `the sprite is ${Math.round(bytes / 1024)} KB as JSON`,
    message: `sprite() returned ${Math.round(bytes / 1024)} KB of data but the max is ${SPRITE_MAX_JSON_BYTES / 1024} KB.`,
    fix: 'Return only { grid, palette, frames } from sprite(), with grid 16 or 24, at most 4 frames per animation and no extra data.',
  };
}

/** The W_NO_SPRITE warning for a unit without sprite(). */
export function noSpriteWarning(): ValidationWarning {
  return {
    code: 'W_NO_SPRITE',
    field: 'sprite',
    message: 'The unit has no sprite() method, so it is drawn as a plain coloured shape.',
    fix: 'Add a sprite() method that returns { grid: 16, palette: {...}, frames: { idle: [...], walk: [...], attack: [...] } }: draw it facing right, with a dark outline, 2 idle, 2 walk and 1 attack frame.',
  };
}

// ---------------------------------------------------------------------------
// Fallback sprite: generated from color + shape + type.
// ---------------------------------------------------------------------------

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex([r, g, b]: [number, number, number]): string {
  const h = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
}
/** Mix `hex` toward `to` by `t` (0..1). */
function mix(hex: string, to: [number, number, number], t: number): string {
  const c = hexToRgb(hex);
  return rgbToHex([c[0] + (to[0] - c[0]) * t, c[1] + (to[1] - c[1]) * t, c[2] + (to[2] - c[2]) * t]);
}

type Canvas = string[][];
const blank = (n: number): Canvas => Array.from({ length: n }, () => Array<string>(n).fill('.'));
const toFrame = (c: Canvas): SpriteFrame => c.map((r) => r.join(''));

/** Is (x, y) inside `shape` drawn in the box [x0..x1] × [y0..y1] (pixel centres)? */
function inShape(shape: Shape, x: number, y: number, x0: number, y0: number, x1: number, y1: number): boolean {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const rx = (x1 - x0) / 2 + 0.5;
  const ry = (y1 - y0) / 2 + 0.5;
  const dx = (x - cx) / rx;
  const dy = (y - cy) / ry;
  switch (shape) {
    case 'circle':
      return dx * dx + dy * dy <= 1;
    case 'square':
      return Math.abs(dx) <= 1 && Math.abs(dy) <= 1;
    case 'diamond':
      return Math.abs(dx) + Math.abs(dy) <= 1.05;
    case 'triangle': {
      // Apex at the top, flat base at the bottom.
      const t = (dy + 1) / 2; // 0 at top, 1 at bottom
      return t >= 0 && t <= 1 && Math.abs(dx) <= t + 0.08;
    }
  }
}

/** Fill a shaded, outlined body: outline 'o', base 'c', highlight 'h', shade 's'. */
function drawBody(c: Canvas, shape: Shape, x0: number, y0: number, x1: number, y1: number): void {
  const n = c.length;
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < n && y < n && inShape(shape, x, y, x0, y0, x1, y1);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!inside(x, y)) continue;
      const edge = !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1);
      const row = c[y]!;
      if (edge) row[x] = 'o';
      else if (x - cx + (y - cy) < -(x1 - x0) * 0.35) row[x] = 'h';
      else if (x - cx + (y - cy) > (x1 - x0) * 0.35) row[x] = 's';
      else row[x] = 'c';
    }
  }
}

function put(c: Canvas, x: number, y: number, ch: string): void {
  const row = c[y];
  if (row && x >= 0 && x < row.length) row[x] = ch;
}

/** Draw an eye looking right near the body's right side (soldiers only). */
function drawEye(c: Canvas, x: number, y: number): void {
  put(c, x, y, 'w');
  put(c, x + 1, y, 'k');
  put(c, x, y + 1, 'w');
  put(c, x + 1, y + 1, 'k');
}

/**
 * The fallback sprite for a unit without a (visible) sprite: a 16×16 shaded
 * shape in the unit's colour with a dark outline, facing right. Soldiers get
 * an eye and feet (walking feet alternate); towers stand on a stone base.
 * Deterministic: the same stats always give the same sprite.
 */
export function fallbackSprite(stats: Pick<UnitStats, 'color' | 'type'> & { shape?: Shape | undefined }): SpriteSpec {
  const color = COLOR_RE.test(stats.color) ? stats.color.toUpperCase() : '#888888';
  const shape = stats.shape ?? DEFAULT_SHAPE[stats.type];
  const black: [number, number, number] = [16, 12, 24];
  const white: [number, number, number] = [255, 255, 255];
  const palette: Record<string, string> = {
    o: mix(color, black, 0.8),
    c: color,
    h: mix(color, white, 0.45),
    s: mix(color, black, 0.3),
    w: '#FFFFFF',
    k: '#140C1C',
    g: '#8A8F98',
    d: '#4A4E57',
    y: '#FFF6A8',
  };
  const N = 16;

  if (stats.type === 'tower') {
    const base = (c: Canvas) => {
      for (let y = 11; y < 16; y++) {
        for (let x = 2; x < 14; x++) {
          const edge = y === 11 || y === 15 || x === 2 || x === 13;
          put(c, x, y, edge ? 'd' : (x + (y % 2) * 2) % 4 === 0 ? 'd' : 'g');
        }
      }
    };
    const tower = (glow: boolean, spark: boolean) => {
      const c = blank(N);
      base(c);
      drawBody(c, shape, 3, 1, 12, 11);
      if (spark) put(c, 5, 4, 'w');
      if (glow) {
        put(c, 7, 0, 'y');
        put(c, 8, 0, 'y');
        put(c, 13, 5, 'y');
        put(c, 14, 6, 'y');
        put(c, 13, 6, 'y');
      }
      return toFrame(c);
    };
    return {
      grid: 16,
      palette,
      frames: { idle: [tower(false, false), tower(false, true)], attack: [tower(true, true)] },
    };
  }

  const soldier = (dy: number, feet: 'stand' | 'a' | 'b', dx = 0, slash = false) => {
    const c = blank(N);
    drawBody(c, shape, 3 + dx, 1 + dy, 12 + dx, 12 + dy);
    drawEye(c, 9 + dx, 5 + dy);
    const feetX: Record<typeof feet, [number, number]> = { stand: [5, 9], a: [4, 10], b: [6, 8] };
    for (const fx of feetX[feet]) {
      put(c, fx, 13, 'o');
      put(c, fx + 1, 13, 'o');
      put(c, fx, 14, 'o');
      put(c, fx + 1, 14, 'o');
    }
    if (slash) {
      put(c, 14, 4, 'y');
      put(c, 15, 5, 'y');
      put(c, 14, 6, 'w');
      put(c, 15, 7, 'y');
    }
    return toFrame(c);
  };
  return {
    grid: 16,
    palette,
    frames: {
      idle: [soldier(0, 'stand'), soldier(1, 'stand')],
      walk: [soldier(0, 'a'), soldier(1, 'b')],
      attack: [soldier(0, 'stand', 1, true)],
    },
  };
}
