// Unit sprites (plan §5.1): bake SpriteSpec frames into crisp, seat-outlined
// bitmaps, and pick the animation pose of each unit from frame flags/events.
//
//   * Baking: each frame is rasterized at grid resolution, upscaled with
//     nearest-neighbour by a whole number, padded and given a seat-coloured
//     outline around the opaque pixels. Mirrored copies (facing left) are made
//     lazily. Missing states fall back per the contract: walk/attack → idle,
//     hit → a white flash of idle, death → a fade-out of idle.
//   * Hidden or missing sprites use `fallbackSprite(stats)` from shared.
//   * Animation (8 fps): `walk` while MOVING, `attack` for 250 ms after the
//     unit fires, `hit` for 100 ms after it takes damage, `death` once and
//     then fade. Priority death > hit > attack > walk > idle.
//
// DOM-free: the cache is generic over the bitmap type, and arena.ts passes a
// PixelImage → canvas converter (render/canvas.ts). Tests pass identity.

import {
  FRAME_FLAGS,
  fallbackSprite,
  type FrameEvent,
  type SpriteFrame,
  type SpriteSpec,
  type StatsSnapshot,
} from '@pixel-clash/shared';
import { hexToRgb, type Rgb } from '../seats.js';
import { createImage, flashImage, mirrorImage, outlineImage, padImage, scaleNearest, type PixelImage } from './pixels.js';

export type AnimState = 'idle' | 'walk' | 'attack' | 'hit' | 'death';
export const ANIM_STATES: readonly AnimState[] = ['idle', 'walk', 'attack', 'hit', 'death'];

/** Sprite animation rate (plan §5.1). */
export const ANIM_FPS = 8;
export const ANIM_FRAME_MS = 1000 / ANIM_FPS;
export const ATTACK_MS = 250;
export const HIT_MS = 100;
/** Fade-out after the death frames (or instead of them). */
export const DEATH_FADE_MS = 600;

// ---------------------------------------------------------------------------
// Spec resolution and rasterizing
// ---------------------------------------------------------------------------

/** The spec to draw: the unit's own sprite, or the fallback when missing/hidden. */
export function resolveSprite(unit: {
  sprite: SpriteSpec | null | undefined;
  spriteHidden?: boolean | undefined;
  stats: Pick<StatsSnapshot, 'color' | 'type' | 'shape'>;
}): SpriteSpec {
  if (unit.sprite && !unit.spriteHidden) return unit.sprite;
  return fallbackSprite(unit.stats);
}

/** One frame at grid resolution (1 px per sprite pixel). Unknown keys stay transparent. */
export function rasterizeFrame(spec: SpriteSpec, rows: SpriteFrame): PixelImage {
  const n = spec.grid;
  const img = createImage(n, n);
  const colors = new Map<string, Rgb>();
  for (const [key, hex] of Object.entries(spec.palette)) colors.set(key, hexToRgb(hex));
  for (let y = 0; y < n; y++) {
    const row = rows[y] ?? '';
    for (let x = 0; x < n; x++) {
      const c = colors.get(row[x] ?? '.');
      if (!c) continue;
      const i = (y * n + x) * 4;
      img.data[i] = c[0];
      img.data[i + 1] = c[1];
      img.data[i + 2] = c[2];
      img.data[i + 3] = 255;
    }
  }
  return img;
}

/** How a state is drawn: which frames, and whether as a flash or a fade. */
export interface StateFrames {
  frames: SpriteFrame[];
  /** Draw as a white flash (hit fallback). */
  flash: boolean;
  /** No death frames: fade the idle frame out instead. */
  fadeOnly: boolean;
}

/** Contract fallbacks: walk/attack → idle, hit → flash of idle, death → fade of idle. */
export function stateFrames(spec: SpriteSpec, state: AnimState): StateFrames {
  const idle = spec.frames.idle;
  const own = spec.frames[state];
  if (own && own.length > 0) return { frames: own, flash: false, fadeOnly: false };
  switch (state) {
    case 'hit':
      return { frames: idle.slice(0, 1), flash: true, fadeOnly: false };
    case 'death':
      return { frames: idle.slice(0, 1), flash: false, fadeOnly: true };
    default:
      return { frames: idle, flash: false, fadeOnly: false };
  }
}

/** Integer upscale so the baked grid is at least `drawWidth` px wide (capped). */
export function chooseBakeScale(grid: number, drawWidth: number, maxScale = 8): number {
  return Math.max(1, Math.min(maxScale, Math.ceil(drawWidth / grid)));
}

/** Outline thickness (baked px) for a bake scale: thin but visible on a projector. */
export function outlineWidthFor(scale: number): number {
  return Math.max(1, Math.min(3, Math.round(scale / 2)));
}

export interface BakeOptions {
  /** Whole-number nearest-neighbour upscale. */
  scale: number;
  /** Outline colour (seat colour), or null for none (props). */
  outline: Rgb | null;
  /** Outline thickness in baked px; default outlineWidthFor(scale). */
  outlineWidth?: number;
  flash?: boolean;
  mirror?: boolean;
}

/**
 * Bake one frame: rasterize, upscale, pad by the outline width, outline.
 * The result is (grid·scale + 2·pad)² px; the sprite's own pixels start at
 * (pad, pad).
 */
export function bakeFrame(spec: SpriteSpec, rows: SpriteFrame, opts: BakeOptions): PixelImage {
  const pad = opts.outline ? (opts.outlineWidth ?? outlineWidthFor(opts.scale)) : 0;
  let img = scaleNearest(rasterizeFrame(spec, rows), opts.scale);
  if (opts.flash) img = flashImage(img);
  img = padImage(img, pad);
  if (opts.outline) outlineImage(img, opts.outline, pad);
  return opts.mirror ? mirrorImage(img) : img;
}

// ---------------------------------------------------------------------------
// Cache of baked sprites
// ---------------------------------------------------------------------------

export interface BakedSprite<C> {
  grid: number;
  scale: number;
  /** Outline padding on each side, in baked px. */
  pad: number;
  /** Baked bitmap size (square). */
  size: number;
  /** Frame lookup with contract fallbacks; mirrored copies are baked lazily. */
  frame(state: AnimState, index: number, mirror: boolean): C;
  frameCount(state: AnimState): number;
  /** Whether `death` is a fade-only fallback. */
  fadeOnlyDeath: boolean;
}

/** Bakes and memoizes sprites per (key, outline colour, scale). */
export class SpriteCache<C> {
  private readonly entries = new Map<string, BakedSprite<C>>();

  constructor(
    private readonly toBitmap: (img: PixelImage) => C,
    private readonly maxEntries = 256,
  ) {}

  /**
   * Baked sprite for `spec`. `key` must identify the spec (e.g.
   * `${playerId}/${unitId}@${version}` or 'prop:rock'); the same key with a
   * different spec returns the stale bake, so include a version.
   */
  get(key: string, spec: SpriteSpec, outline: string | null, scale: number): BakedSprite<C> {
    const id = `${key}|${outline ?? '-'}|${scale}`;
    const hit = this.entries.get(id);
    if (hit) {
      // LRU refresh.
      this.entries.delete(id);
      this.entries.set(id, hit);
      return hit;
    }
    const baked = bakeSprite(spec, outline ? hexToRgb(outline) : null, scale, this.toBitmap);
    this.entries.set(id, baked);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return baked;
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

/** Bake every state of a spec (normal orientation eagerly, mirrored lazily). */
export function bakeSprite<C>(spec: SpriteSpec, outline: Rgb | null, scale: number, toBitmap: (img: PixelImage) => C): BakedSprite<C> {
  const pad = outline ? outlineWidthFor(scale) : 0;
  const states = new Map<AnimState, StateFrames>();
  for (const s of ANIM_STATES) states.set(s, stateFrames(spec, s));
  const cache = new Map<string, C>();
  const frame = (state: AnimState, index: number, mirror: boolean): C => {
    const sf = states.get(state)!;
    const i = ((index % sf.frames.length) + sf.frames.length) % sf.frames.length;
    const id = `${state}:${i}:${mirror ? 1 : 0}`;
    let c = cache.get(id);
    if (c === undefined) {
      c = toBitmap(bakeFrame(spec, sf.frames[i]!, { scale, outline, outlineWidth: pad, flash: sf.flash, mirror }));
      cache.set(id, c);
    }
    return c;
  };
  // Bake the facing-right frames up front so the first battle frame is smooth.
  for (const s of ANIM_STATES) {
    const n = states.get(s)!.frames.length;
    for (let i = 0; i < n; i++) frame(s, i, false);
  }
  return {
    grid: spec.grid,
    scale,
    pad,
    size: spec.grid * scale + 2 * pad,
    frame,
    frameCount: (s) => states.get(s)!.frames.length,
    fadeOnlyDeath: states.get('death')!.fadeOnly,
  };
}

// ---------------------------------------------------------------------------
// Animation state machine
// ---------------------------------------------------------------------------

export interface AnimPose {
  state: AnimState;
  /** Frame index within the state (wraps with frameCount). */
  frame: number;
  /** Face left (draw mirrored). */
  mirror: boolean;
  /** 1 = opaque; fades to 0 after death. */
  alpha: number;
  /** DISABLED flag: frozen and napping (💤 bubble). */
  napping: boolean;
  /** Dead and fully faded: stop drawing. */
  gone: boolean;
}

/**
 * Per-instance animation state. Feed it the unit's frame flags (`update`) and
 * the battle events (`onEvent`) with a monotonic clock in ms (wall clock or
 * playback clock), then ask for the `pose`.
 */
export class UnitAnimator {
  private moving = false;
  private facingLeft = false;
  private disabled = false;
  private attackAt = Number.NEGATIVE_INFINITY;
  private hitAt = Number.NEGATIVE_INFINITY;
  private deathAt: number | null = null;
  private walkSince = 0;
  /** Desynchronizes idle loops between copies of the same design. */
  private readonly phase: number;

  constructor(readonly instanceId: string) {
    let h = 0;
    for (let i = 0; i < instanceId.length; i++) h = (h * 31 + instanceId.charCodeAt(i)) | 0;
    this.phase = (Math.abs(h) % 8) * ANIM_FRAME_MS;
  }

  /** Apply the frame flags (FrameUnit[4]). */
  update(flags: number, now: number): void {
    const moving = (flags & FRAME_FLAGS.MOVING) !== 0;
    if (moving && !this.moving) this.walkSince = now;
    this.moving = moving;
    this.facingLeft = (flags & FRAME_FLAGS.FACING_LEFT) !== 0;
    this.disabled = (flags & FRAME_FLAGS.DISABLED) !== 0;
  }

  /** React to a battle event (ignores events about other instances). */
  onEvent(ev: FrameEvent, now: number): void {
    switch (ev.type) {
      case 'fire':
        if (ev.instanceId === this.instanceId) this.attackAt = now;
        break;
      case 'hit':
        if (ev.targetId === this.instanceId) this.hitAt = now;
        break;
      case 'death':
        if (ev.instanceId === this.instanceId && this.deathAt === null) this.deathAt = now;
        break;
      case 'disable':
        if (ev.instanceId === this.instanceId) this.disabled = true;
        break;
      default:
        break;
    }
  }

  get dead(): boolean {
    return this.deathAt !== null;
  }

  /** Undo a death (used when a replay is scrubbed backwards). */
  reset(): void {
    this.deathAt = null;
    this.attackAt = Number.NEGATIVE_INFINITY;
    this.hitAt = Number.NEGATIVE_INFINITY;
    this.moving = false;
    this.disabled = false;
  }

  pose(now: number, frameCount: (s: AnimState) => number, fadeOnlyDeath = false): AnimPose {
    const base = { mirror: this.facingLeft, alpha: 1, napping: false, gone: false };
    if (this.deathAt !== null) {
      const elapsed = Math.max(0, now - this.deathAt);
      const n = frameCount('death');
      const playMs = fadeOnlyDeath ? 0 : n * ANIM_FRAME_MS;
      const frame = fadeOnlyDeath ? 0 : Math.min(n - 1, Math.floor(elapsed / ANIM_FRAME_MS));
      const fadeT = Math.max(0, elapsed - playMs) / DEATH_FADE_MS;
      const alpha = Math.max(0, 1 - fadeT);
      return { ...base, state: 'death', frame, alpha, gone: alpha <= 0 };
    }
    if (this.disabled) return { ...base, state: 'idle', frame: 0, napping: true };
    if (now - this.hitAt < HIT_MS) return { ...base, state: 'hit', frame: 0 };
    if (now - this.attackAt < ATTACK_MS) {
      const frame = Math.min(frameCount('attack') - 1, Math.floor((now - this.attackAt) / ANIM_FRAME_MS));
      return { ...base, state: 'attack', frame };
    }
    if (this.moving) {
      return { ...base, state: 'walk', frame: Math.floor((now - this.walkSince) / ANIM_FRAME_MS) % frameCount('walk') };
    }
    return { ...base, state: 'idle', frame: Math.floor((now + this.phase) / ANIM_FRAME_MS) % frameCount('idle') };
  }
}
