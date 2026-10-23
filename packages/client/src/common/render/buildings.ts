// Buildings and minions on the iso arena (plan §12.5), DOM-free so tests can
// run it:
//
//   * Walls are iso blocks: the 40×40 cell footprint extruded upwards, the top
//     face in the wall's colour (lighter), the two visible sides darker and
//     textured with the wall sprite's idle frame (nearest-neighbour, one tile
//     per side), a seat-coloured outline round the top face and crack
//     overlays below 66% and 33% HP. `renderWallBlock` rasterizes one block
//     into a PixelImage; arena.ts bakes it once per design, seat, crack level
//     and zoom, so 96 walls cost one drawImage each.
//   * Factories get a production ring on the ground (`productionRing`).
//   * Minions are engine-made bodies with ids `${factoryId}-mN` (§9.3): they
//     take their owner, seat and tint from their factory.

import { MINION_SPRITE, WALL_HALF, minionSprite, type FrameFactory, type SpriteSpec } from '@pixel-clash/shared';
import { hexToRgb, mixRgb, type Rgb } from '../seats.js';
import { createImage, type PixelImage } from './pixels.js';
import { isoUnproject } from './iso.js';

// ---------------------------------------------------------------------------
// Minions
// ---------------------------------------------------------------------------

/** The factory instanceId of a minion id ("2-0-3-m4" → "2-0-3"), or null for any other id. */
export function minionFactoryId(instanceId: string): string | null {
  const m = /^(.+)-m\d+$/.exec(instanceId);
  return m ? m[1]! : null;
}

/** The minion look tinted with its factory's colour, and its bake key. */
export function minionLook(factoryColor: string): { spec: SpriteSpec; key: string } {
  const color = /^#[0-9a-fA-F]{6}$/.test(factoryColor) ? factoryColor.toUpperCase() : (MINION_SPRITE.palette.b ?? '#C0A060');
  return { spec: minionSprite(color), key: `minion:${color}` };
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

export interface ProductionRing {
  /** 0-1 share of the ring filled (the next minion's progress). */
  frac: number;
  /** Grey: holding, or no minions left to make. */
  idle: boolean;
  minionsLeft: number;
  holding: boolean;
  rally: { x: number; y: number };
}

/** The ground ring of a factory from its `fac` entry (§9.3 Frames). */
export function productionRing(f: FrameFactory): ProductionRing {
  const [, progress, minionsLeft, rx, ry, holding] = f;
  const done = minionsLeft <= 0;
  return {
    frac: done ? 1 : Math.max(0, Math.min(1, progress / 100)),
    idle: done || holding === 1,
    minionsLeft,
    holding: holding === 1,
    rally: { x: rx, y: ry },
  };
}

// ---------------------------------------------------------------------------
// Walls
// ---------------------------------------------------------------------------

/** Height of a wall block in arena px, drawn with the billboard zoom (§12.5: 28 logical px). */
export const WALL_HEIGHT = 28;

/** Crack overlay level: 0 above 66% HP, 1 below, 2 below 33% (§12.5). */
export function wallCrackLevel(hp: number, maxHp: number): 0 | 1 | 2 {
  const f = maxHp > 0 ? hp / maxHp : 1;
  if (f < 1 / 3) return 2;
  if (f < 2 / 3) return 1;
  return 0;
}

export interface WallBlockOptions {
  /** Wall sprite (its idle frame textures the faces). */
  spec: SpriteSpec;
  /** The wall's "#RRGGBB" colour. */
  color: string;
  /** Top-edge outline colour (seat or team colour), or null. */
  outline: string | null;
  /** Bake projection factor: image px per arena px along screen X (view.k × devicePixelRatio). */
  k: number;
  /** Block height in image px. */
  height: number;
  /** Crack level (wallCrackLevel). */
  crack: 0 | 1 | 2;
  /** Outline thickness in image px (default 2). */
  outlineWidth?: number;
}

export interface WallBlockImage {
  image: PixelImage;
  /** Image position of the block's ground centre (the cell centre on the floor). */
  groundX: number;
  groundY: number;
}

type Face = 'top' | 'left' | 'right';

/** Crack polylines per face in texture space (u, v ∈ [0, 1]); level 2 adds the second set. */
const CRACKS: Record<1 | 2, Partial<Record<Face, Array<Array<[number, number]>>>>> = {
  1: {
    left: [[[0.3, 0], [0.38, 0.25], [0.3, 0.45], [0.42, 0.7]]],
    top: [[[0.6, 0.05], [0.55, 0.3], [0.68, 0.45]]],
  },
  2: {
    right: [[[0.7, 0], [0.62, 0.3], [0.75, 0.55], [0.66, 0.85], [0.72, 1]]],
    left: [[[0.75, 1], [0.68, 0.7], [0.8, 0.5]]],
    top: [[[0.15, 0.6], [0.35, 0.65], [0.45, 0.85]]],
  },
};

const CRACK_RGB: Rgb = [24, 22, 30];
const EDGE_RGB: Rgb = [8, 7, 14];
const WHITE: Rgb = [255, 255, 255];

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l = dx * dx + dy * dy;
  const t = l > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Whether texture point (u, v) of `face` lies on a crack at this level. */
export function onCrack(face: Face, u: number, v: number, level: 0 | 1 | 2, width = 0.035): boolean {
  for (let l = 1; l <= level; l++) {
    for (const line of CRACKS[l as 1 | 2][face] ?? []) {
      for (let i = 0; i + 1 < line.length; i++) {
        const [ax, ay] = line[i]!;
        const [bx, by] = line[i + 1]!;
        if (segDist(u, v, ax, ay, bx, by) < width) return true;
      }
    }
  }
  return false;
}

/** The sprite's idle frame as a texture lookup (null = transparent). */
function textureOf(spec: SpriteSpec): (u: number, v: number) => Rgb | null {
  const rows = spec.frames.idle[0] ?? [];
  const colors = new Map<string, Rgb>();
  for (const [key, hex] of Object.entries(spec.palette)) colors.set(key, hexToRgb(hex));
  const n = spec.grid;
  return (u, v) => {
    const x = Math.min(n - 1, Math.max(0, Math.floor(u * n)));
    const y = Math.min(n - 1, Math.max(0, Math.floor(v * n)));
    return colors.get(rows[y]?.[x] ?? '.') ?? null;
  };
}

/**
 * Rasterize one wall block. The image holds the top face (a 2:1 diamond
 * 80k wide and 40k tall) lifted by `height`, and the two front sides below it.
 */
export function renderWallBlock(o: WallBlockOptions): WallBlockImage {
  const k = Math.max(0.05, o.k);
  const h = Math.max(1, o.height);
  const half = WALL_HALF;
  const pad = 1;
  const w = Math.ceil(4 * half * k) + 2 * pad;
  const ht = Math.ceil(2 * half * k + h) + 2 * pad;
  const img = createImage(w, ht);
  const gx = pad + 2 * half * k;
  const gy = pad + h + half * k;
  const base = hexToRgb(o.color);
  const tex = textureOf(o.spec);
  const outline = o.outline ? hexToRgb(o.outline) : null;
  const ow = o.outlineWidth ?? 2;
  const topBase = mixRgb(base, WHITE, 0.25);
  const put = (x: number, y: number, c: Rgb) => {
    const i = (y * w + x) * 4;
    img.data[i] = c[0];
    img.data[i + 1] = c[1];
    img.data[i + 2] = c[2];
    img.data[i + 3] = 255;
  };
  for (let py = 0; py < ht; py++) {
    for (let px = 0; px < w; px++) {
      const sx = px + 0.5 - gx;
      const sy = py + 0.5 - gy;
      // Top face: the ground diamond lifted by h.
      const top = isoUnproject(sx, sy + h, k);
      if (Math.abs(top.x) <= half && Math.abs(top.y) <= half) {
        const u = (top.x + half) / (2 * half);
        const v = (top.y + half) / (2 * half);
        const t = tex(u, v);
        let c = t ? mixRgb(topBase, t, 0.3) : topBase;
        if (onCrack('top', u, v, o.crack)) c = CRACK_RGB;
        // Distance to the top face's edge in image px (≈ 0.9 k per arena px across a diamond edge).
        const edge = (half - Math.max(Math.abs(top.x), Math.abs(top.y))) * k * 0.9;
        if (outline && edge < ow) c = outline;
        put(px, py, c);
        continue;
      }
      // Left side (the y = +half plane, facing bottom-left).
      if (sx <= 0 && sx >= -4 * half * k) {
        const dx = sx / k + half;
        const lift = ((dx + half) * k) / 2 - sy;
        if (lift >= 0 && lift <= h) {
          const u = (dx + half) / (2 * half);
          const v = 1 - lift / h;
          const t = tex(u, v);
          let c = mixRgb(t ?? base, EDGE_RGB, 0.22);
          if (onCrack('left', u, v, o.crack)) c = CRACK_RGB;
          put(px, py, c);
          continue;
        }
      }
      // Right side (the x = +half plane, facing bottom-right): darker.
      if (sx >= 0 && sx <= 4 * half * k) {
        const dy = half - sx / k;
        const lift = ((half + dy) * k) / 2 - sy;
        if (lift >= 0 && lift <= h) {
          const u = 1 - (dy + half) / (2 * half);
          const v = 1 - lift / h;
          const t = tex(u, v);
          let c = mixRgb(t ?? base, EDGE_RGB, 0.4);
          if (onCrack('right', u, v, o.crack)) c = CRACK_RGB;
          put(px, py, c);
        }
      }
    }
  }
  darkenSilhouette(img);
  return { image: img, groundX: gx, groundY: gy };
}

/** Darken the opaque pixels on the block's outer edge so it reads against the floor. */
function darkenSilhouette(img: PixelImage): void {
  const { width: w, height: h, data } = img;
  const opaque = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && data[(y * w + x) * 4 + 3]! > 0;
  const edge: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!opaque(x, y)) continue;
      if (!opaque(x - 1, y) || !opaque(x + 1, y) || !opaque(x, y - 1) || !opaque(x, y + 1)) edge.push((y * w + x) * 4);
    }
  }
  for (const i of edge) {
    data[i] = Math.round(data[i]! * 0.45);
    data[i + 1] = Math.round(data[i + 1]! * 0.45);
    data[i + 2] = Math.round(data[i + 2]! * 0.45);
  }
}
