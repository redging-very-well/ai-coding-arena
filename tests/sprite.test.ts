// The shared checkSprite() rules and the fallback sprite.

import { describe, expect, it } from 'vitest';
import {
  SHAPES,
  SPRITE_STATES,
  VALIDATION_ERROR_CODES,
  WARNING_CODES,
  checkSprite,
  fallbackSprite,
  playerHintFor,
  noSpriteWarning,
  type SpriteSpec,
  type ValidationError,
} from '@pixel-clash/shared';

const row = (s: string, n = 8) => s.padEnd(n, '.');
const solid = (n = 8, ch = 'a') => Array.from({ length: n }, () => ch.repeat(n));
const good = (): SpriteSpec => ({ grid: 8, palette: { a: '#112233' }, frames: { idle: [solid()] } });

function errorsOf(raw: unknown): ValidationError[] {
  const r = checkSprite(raw);
  if (r.ok) throw new Error('expected errors');
  for (const e of r.errors) {
    expect(e.message.length).toBeGreaterThan(5);
    expect(e.fix.length).toBeGreaterThan(5);
  }
  return r.errors;
}
const codes = (raw: unknown) => errorsOf(raw).map((e) => e.code);

describe('checkSprite', () => {
  it('accepts every allowed grid and normalizes the spec', () => {
    for (const grid of [8, 12, 16, 24, 32] as const) {
      const r = checkSprite({ grid, palette: { a: '#aabbcc' }, frames: { idle: [solid(grid)], walk: [], extra: undefined } });
      expect(r.ok, String(grid)).toBe(true);
      if (r.ok) {
        expect(r.sprite.palette).toEqual({ a: '#AABBCC' });
        expect(Object.keys(r.sprite.frames)).toEqual(['idle']); // empty walk dropped
      }
    }
  });

  it('keeps optional states in order', () => {
    const f = solid();
    const r = checkSprite({ ...good(), frames: { death: [f], hit: [f], attack: [f], walk: [f, f], idle: [f] } });
    expect(r.ok && Object.keys(r.sprite.frames)).toEqual([...SPRITE_STATES]);
  });

  it('SPRITE_BAD_GRID: wrong grid, non-object result', () => {
    expect(codes({ ...good(), grid: 10 })).toEqual(['SPRITE_BAD_GRID']);
    expect(codes({ ...good(), grid: '16' })).toEqual(['SPRITE_BAD_GRID']);
    expect(codes([1, 2])).toEqual(['SPRITE_BAD_GRID']);
    expect(codes('pixel art')).toEqual(['SPRITE_BAD_GRID']);
  });

  it('SPRITE_EMPTY: nothing returned, no frames, empty idle, < 10% opaque', () => {
    expect(codes(undefined)).toEqual(['SPRITE_EMPTY']);
    expect(codes(null)).toEqual(['SPRITE_EMPTY']);
    expect(codes({ ...good(), frames: undefined })).toEqual(['SPRITE_EMPTY']);
    expect(codes({ ...good(), frames: { idle: [] } })).toEqual(['SPRITE_EMPTY']);
    expect(codes({ ...good(), frames: { walk: [solid()] } })).toEqual(['SPRITE_EMPTY']);
    // 8x8 = 64 px: 7 opaque pixels needed (ceil 6.4), 6 is too few.
    const six = [row('aaaaaa'), ...Array.from({ length: 7 }, () => row(''))];
    const seven = [row('aaaaaaa'), ...Array.from({ length: 7 }, () => row(''))];
    const e = errorsOf({ ...good(), frames: { idle: [solid(), six] } });
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ code: 'SPRITE_EMPTY', state: 'idle', frame: 1, value: { opaquePixels: 6 } });
    expect(checkSprite({ ...good(), frames: { idle: [seven] } }).ok).toBe(true);
  });

  it('SPRITE_BAD_PALETTE: not an object, 0 or 17 entries, bad key, bad colour', () => {
    expect(codes({ ...good(), palette: ['#112233'] })).toEqual(['SPRITE_BAD_PALETTE']);
    expect(codes({ ...good(), palette: {} })).toEqual(['SPRITE_BAD_PALETTE']);
    const many = Object.fromEntries('abcdefghijklmnopq'.split('').map((k) => [k, '#000000']));
    expect(codes({ ...good(), palette: many })).toEqual(['SPRITE_BAD_PALETTE']);
    expect(codes({ ...good(), palette: { a: '#112233', '.': '#000000' } })).toEqual(['SPRITE_BAD_PALETTE']);
    expect(codes({ ...good(), palette: { a: '#112233', ab: '#000000' } })).toEqual(['SPRITE_BAD_PALETTE']);
    expect(codes({ ...good(), palette: { a: '#112233', ' ': '#000000' } })).toEqual(['SPRITE_BAD_PALETTE']);
    const e = errorsOf({ ...good(), palette: { a: '#123' } });
    expect(e[0]).toMatchObject({ code: 'SPRITE_BAD_PALETTE', field: 'sprite.palette.a', value: '#123' });
    // 16 entries is fine.
    const sixteen = Object.fromEntries('abcdefghijklmnop'.split('').map((k) => [k, '#000000']));
    expect(checkSprite({ ...good(), palette: sixteen }).ok).toBe(true);
  });

  it('SPRITE_BAD_FRAME: location fields for rows, cols, chars and types', () => {
    const shortRows = solid().slice(0, 7);
    expect(errorsOf({ ...good(), frames: { idle: [shortRows] } })[0]).toMatchObject({ code: 'SPRITE_BAD_FRAME', state: 'idle', frame: 0, value: { rows: 7 } });
    const longRow = solid();
    longRow[5] = 'aaaaaaaaa';
    expect(errorsOf({ ...good(), frames: { idle: [solid()], walk: [solid(), longRow] } })[0]).toMatchObject({
      code: 'SPRITE_BAD_FRAME', state: 'walk', frame: 1, row: 5, col: 8,
    });
    const badChar = solid();
    badChar[4] = 'aaaaaZaa';
    expect(errorsOf({ ...good(), frames: { idle: [badChar] } })[0]).toMatchObject({
      code: 'SPRITE_BAD_FRAME', state: 'idle', frame: 0, row: 4, col: 5, value: 'Z',
    });
    const numRow: unknown[] = solid();
    numRow[2] = 12345678;
    expect(errorsOf({ ...good(), frames: { idle: [numRow] } })[0]).toMatchObject({ code: 'SPRITE_BAD_FRAME', row: 2 });
    expect(errorsOf({ ...good(), frames: { idle: ['aaaaaaaa'] } })[0]).toMatchObject({ code: 'SPRITE_BAD_FRAME', frame: 0 });
    expect(errorsOf({ ...good(), frames: { idle: [solid()], walk: 'run' } })[0]).toMatchObject({ code: 'SPRITE_BAD_FRAME', state: 'walk' });
    expect(errorsOf({ ...good(), frames: { idle: [solid()], run: [solid()] } })[0]).toMatchObject({ code: 'SPRITE_BAD_FRAME', state: 'run' });
  });

  it('caps the number of SPRITE_BAD_FRAME errors', () => {
    const bad = solid().map(() => 'zzzzzzzz');
    const e = errorsOf({ ...good(), frames: { idle: [bad, bad, bad, bad], walk: [bad, bad, bad, bad] } });
    expect(e).toHaveLength(5);
    expect(e[4]?.message).toContain('3 more frame problems');
  });

  it('SPRITE_TOO_MANY_FRAMES: per-state limits (hit is 1)', () => {
    const f = solid();
    expect(codes({ ...good(), frames: { idle: [f, f, f, f, f] } })).toEqual(['SPRITE_TOO_MANY_FRAMES']);
    expect(codes({ ...good(), frames: { idle: [f], hit: [f, f] } })).toEqual(['SPRITE_TOO_MANY_FRAMES']);
    expect(checkSprite({ ...good(), frames: { idle: [f, f, f, f], walk: [f, f, f, f], hit: [f] } }).ok).toBe(true);
  });

  it('codes, warning and player hint are registered', () => {
    for (const c of ['SPRITE_THREW', 'SPRITE_BAD_GRID', 'SPRITE_BAD_PALETTE', 'SPRITE_BAD_FRAME', 'SPRITE_TOO_MANY_FRAMES', 'SPRITE_EMPTY', 'SPRITE_NOT_STABLE']) {
      expect(VALIDATION_ERROR_CODES).toContain(c);
    }
    expect(WARNING_CODES).toContain('W_NO_SPRITE');
    expect(playerHintFor('W_NO_SPRITE')).toBe('Ask your AI helper to draw a pixel-art sprite for your unit!');
    expect(noSpriteWarning().code).toBe('W_NO_SPRITE');
  });
});

describe('fallbackSprite', () => {
  it('is a valid, deterministic 16x16 sprite for every type and shape', () => {
    for (const type of ['soldier', 'tower'] as const) {
      for (const shape of [...SHAPES, undefined]) {
        const s = fallbackSprite({ color: '#33cc66', type, shape });
        const r = checkSprite(JSON.parse(JSON.stringify(s)));
        expect(r.ok, `${type}/${String(shape)}`).toBe(true);
        expect(s.grid).toBe(16);
        expect(s.frames.idle).toHaveLength(2);
        expect(s.frames.attack).toHaveLength(1);
        expect(fallbackSprite({ color: '#33cc66', type, shape })).toEqual(s);
      }
    }
    expect(fallbackSprite({ color: '#33CC66', type: 'soldier' }).frames.walk).toHaveLength(2);
  });

  it('uses the unit colour, a darker outline, and differs by shape', () => {
    const s = fallbackSprite({ color: '#3399FF', type: 'soldier', shape: 'circle' });
    expect(s.palette.c).toBe('#3399FF');
    const lum = (hex: string) => [1, 3, 5].reduce((n, i) => n + Number.parseInt(hex.slice(i, i + 2), 16), 0);
    expect(lum(s.palette.o!)).toBeLessThan(lum('#3399FF') / 3);
    const sq = fallbackSprite({ color: '#3399FF', type: 'soldier', shape: 'square' });
    expect(sq.frames.idle[0]).not.toEqual(s.frames.idle[0]);
    // A bad colour (should never reach here) still gives a valid sprite.
    expect(checkSprite(fallbackSprite({ color: 'red', type: 'tower' })).ok).toBe(true);
  });
});

describe('harness sprite limit', () => {
  it('MAX_SPRITE_JSON mirrors SPRITE_MAX_JSON_BYTES', async () => {
    const { MAX_SPRITE_JSON } = await import('../packages/server/src/sandbox/harness.js');
    const { SPRITE_MAX_JSON_BYTES } = await import('@pixel-clash/shared');
    expect(MAX_SPRITE_JSON).toBe(SPRITE_MAX_JSON_BYTES);
  });
});
