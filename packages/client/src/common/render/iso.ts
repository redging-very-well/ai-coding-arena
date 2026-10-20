// Isometric projection, depth sort and floor tiles (plan §12). Shared by
// /screen, the /play battle view and the replay.
//
// The sim is top-down on an 800×800 arena. The view is a 2:1 isometric
// projection of it:
//     screenX = (x − y) · k        screenY = (x + y) · k / 2
// so the arena becomes a diamond 1600k wide and 800k tall, with arena (0,0)
// at the top vertex, (800,0) on the right, (0,800) on the left and (800,800)
// at the bottom. `k` is the fit-to-canvas zoom.
//
// Everything here is DOM-free (pure maths and RGBA buffers) so it can be unit
// tested in Node; render/canvas.ts and render/arena.ts put it on a canvas.

import { ARENA, CELL_SIZE, CENTER, zoneRect, type Corner, type SpriteSpec } from '@pixel-clash/shared';
import { hexToRgb, mixRgb, type Rgb } from '../seats.js';
import { createImage, setPixel, type PixelImage } from './pixels.js';

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

export interface ScreenPoint {
  sx: number;
  sy: number;
}

/** Arena point → screen offset from the projected arena origin (0,0). */
export function isoProject(x: number, y: number, k: number): ScreenPoint {
  return { sx: (x - y) * k, sy: ((x + y) * k) / 2 };
}

/** Inverse of `isoProject` (screen offset → ground-plane arena point). */
export function isoUnproject(sx: number, sy: number, k: number): { x: number; y: number } {
  const diff = sx / k; // x − y
  const sum = (2 * sy) / k; // x + y
  return { x: (sum + diff) / 2, y: (sum - diff) / 2 };
}

/** A fitted view: where the arena sits on a canvas and at what zoom. */
export interface IsoView {
  /** Projection factor k (screen px per arena px along screen X, per axis). */
  k: number;
  /**
   * Billboard zoom: screen px per arena px of a ground-plane circle's width
   * (= k·√2). A unit of radius `size` gets a ground ring 2·size·zoom wide and
   * a sprite of the same width (plan §5.1).
   */
  zoom: number;
  /** Canvas position of arena (0,0) (the diamond's top vertex). */
  originX: number;
  originY: number;
  /** Canvas size the view was fitted to (CSS px). */
  width: number;
  height: number;
}

export interface FitOptions {
  /** Screen margin on every side (CSS px). Default 8. */
  margin?: number;
  /** Arena-px band around the diamond kept visible for edge props. Default 48. */
  pad?: number;
  /** Extra room above the top vertex for tall sprites and HP bars (arena px). Default 64. */
  top?: number;
  /** Extra room below the bottom vertex for the floor's cliff edge (arena px). Default FLOOR_CLIFF_WORLD. */
  bottom?: number;
  /**
   * Snap the zoom so the floor's pixel art scales by a whole (or half, below
   * 2×) number: crisper pixels, slightly smaller arena. Default false.
   */
  pixelSnap?: boolean;
}

/** Fit the whole arena (plus props and headroom) into a canvas, centred. */
export function fitIso(width: number, height: number, opts: FitOptions = {}): IsoView {
  const margin = opts.margin ?? 8;
  const pad = opts.pad ?? 48;
  const top = opts.top ?? 64;
  const bottom = opts.bottom ?? FLOOR_CLIFF_WORLD;
  // Content box in "k units": width (1600 + 4·pad), height (800 + 2·pad + top + bottom).
  const unitsW = ARENA.width + ARENA.height + 4 * pad;
  const unitsH = (ARENA.width + ARENA.height) / 2 + 2 * pad + top + bottom;
  let k = Math.max(0.01, Math.min((width - 2 * margin) / unitsW, (height - 2 * margin) / unitsH));
  if (opts.pixelSnap) k = snapZoom(k);
  const contentH = unitsH * k;
  return {
    k,
    zoom: k * Math.SQRT2,
    // The diamond is symmetric about x: the top vertex sits on the centre line.
    originX: width / 2 + ((ARENA.height - ARENA.width) / 2) * k,
    originY: (height - contentH) / 2 + (pad + top) * k,
    width,
    height,
  };
}

/** Snap k so the floor bitmap (drawn at FLOOR_K) scales by n (≥ 2) or n/2 (< 2). */
export function snapZoom(k: number): number {
  const s = k / FLOOR_K;
  if (s >= 2) return Math.floor(s) * FLOOR_K;
  if (s >= 0.5) return (Math.floor(s * 2) / 2) * FLOOR_K;
  return k;
}

/** Arena point → canvas point for a fitted view. */
export function toScreen(view: IsoView, x: number, y: number): ScreenPoint {
  const p = isoProject(x, y, view.k);
  return { sx: view.originX + p.sx, sy: view.originY + p.sy };
}

/** Canvas point → arena ground point (may be outside the arena). */
export function toWorld(view: IsoView, sx: number, sy: number): { x: number; y: number } {
  return isoUnproject(sx - view.originX, sy - view.originY, view.k);
}

/**
 * A ground-plane circle of arena radius r projects to an axis-aligned ellipse
 * with these radii (rx = r·k·√2, ry = rx / 2).
 */
export function isoEllipse(r: number, k: number): { rx: number; ry: number } {
  const rx = r * k * Math.SQRT2;
  return { rx, ry: rx / 2 };
}

/** Billboard width of a unit with body radius `size` (plan §5.1: 2·size, times the zoom). */
export function billboardWidth(size: number, view: Pick<IsoView, 'zoom'>): number {
  return 2 * size * view.zoom;
}

// ---------------------------------------------------------------------------
// Depth sort
// ---------------------------------------------------------------------------

export interface DepthItem {
  x: number;
  y: number;
  /** Tie-breaker for a stable, deterministic order (instance id, prop id). */
  key?: string;
}

/** Painter's order: back (small x + y) first. Ties: smaller x, then key. */
export function depthCompare(a: DepthItem, b: DepthItem): number {
  return a.x + a.y - (b.x + b.y) || a.x - b.x || (a.key ?? '').localeCompare(b.key ?? '');
}

/** A new array sorted back-to-front by x + y (plan §12). */
export function depthSort<T extends DepthItem>(items: readonly T[]): T[] {
  return [...items].sort(depthCompare);
}

// ---------------------------------------------------------------------------
// Floor tiles (pixel art, generated in code)
// ---------------------------------------------------------------------------

/**
 * The floor bitmap is drawn at this projection factor: a 40 px cell becomes a
 * 32×16 px diamond tile. It is scaled up with nearest-neighbour to the view.
 */
export const FLOOR_K = 0.4;
/** Height of the arena's cliff edge in floor pixels. */
export const FLOOR_CLIFF_PX = 10;
/** The same in arena px (fit uses it for bottom room). */
export const FLOOR_CLIFF_WORLD = FLOOR_CLIFF_PX / FLOOR_K;

export interface FloorZone {
  corner: Corner;
  /** "#RRGGBB" seat colour. */
  color: string;
}

export interface FloorOptions {
  /** Corner bases to tint (seat colours). */
  zones?: readonly FloorZone[];
  /** Seed for the speckle pattern (keep it constant for a stable look). */
  seed?: number;
}

export interface FloorBitmap {
  image: PixelImage;
  /** Projection factor of the bitmap (FLOOR_K). */
  k: number;
  /** Bitmap pixel position of arena (0,0). */
  originX: number;
  originY: number;
}

const FLOOR = {
  tileA: hexToRgb('#4A4E6A'),
  tileB: hexToRgb('#444862'),
  grout: hexToRgb('#30334A'),
  light: hexToRgb('#5A5F7F'),
  dark: hexToRgb('#3A3D56'),
  lip: hexToRgb('#6A6F92'),
  centre: hexToRgb('#535877'),
  cliffLeft: hexToRgb('#262838'),
  cliffRight: hexToRgb('#31344A'),
  mortar: hexToRgb('#1A1B27'),
} as const;

/** Small deterministic integer hash → [0, 1). */
export function hash01(a: number, b: number, c = 0): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function inRect(x: number, y: number, r: { x: number; y: number; width: number; height: number }): boolean {
  return x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
}

/**
 * Colour of an arena ground point on the floor (no cliff): checkered stone
 * tiles, one per 40 px cell, with grout lines, speckles, a lighter lip at the
 * arena edge, a faint centre ring and seat-tinted corner zones.
 */
export function floorColorAt(x: number, y: number, zones: readonly FloorZone[], seed = 0): Rgb {
  const W = ARENA.width;
  const H = ARENA.height;
  const cx = Math.floor(x / CELL_SIZE);
  const cy = Math.floor(y / CELL_SIZE);
  const u = x - cx * CELL_SIZE;
  const v = y - cy * CELL_SIZE;
  const px = 1 / FLOOR_K; // arena px per floor pixel (2.5)

  let c: Rgb = (cx + cy) % 2 === 0 ? FLOOR.tileA : FLOOR.tileB;
  // Per-tile variation and speckles (stable per seed).
  const tileShade = hash01(cx, cy, seed) * 0.12 - 0.06;
  c = mixRgb(c, tileShade > 0 ? FLOOR.light : FLOOR.dark, Math.abs(tileShade) * 3);
  const sp = hash01(Math.floor(x / px), Math.floor(y / px), seed + 7);
  if (sp < 0.05) c = FLOOR.dark;
  else if (sp > 0.965) c = FLOOR.light;
  // Centre ring (cosmetic): cells within 2 of the centre are a touch lighter.
  const dc = Math.hypot(x - CENTER.x, y - CENTER.y);
  if (dc < 70) c = mixRgb(c, FLOOR.centre, 0.6);
  if (Math.abs(dc - 70) < px * 0.9) c = FLOOR.lip;
  // Grout on the tile's back edges (top-left / top-right in iso).
  const grout = u < px || v < px;
  if (grout) c = mixRgb(c, FLOOR.grout, 0.75);

  for (const z of zones) {
    const r = zoneRect(z.corner);
    if (!inRect(x, y, r)) continue;
    const seat = hexToRgb(z.color);
    const border =
      x - r.x < px * 1.5 || r.x + r.width - x <= px * 1.5 || y - r.y < px * 1.5 || r.y + r.height - y <= px * 1.5;
    c = border ? mixRgb(c, seat, 0.85) : mixRgb(c, seat, grout ? 0.22 : 0.32);
  }
  // Raised lip along the arena's outer edge.
  if (x < px || y < px || x >= W - px || y >= H - px) c = mixRgb(c, FLOOR.lip, 0.7);
  return c;
}

/**
 * Generate the floor bitmap: the diamond of 20×20 iso tiles plus a stone
 * cliff under the two front edges. Transparent outside. Pure (no DOM).
 */
export function renderFloor(opts: FloorOptions = {}): FloorBitmap {
  const zones = opts.zones ?? [];
  const seed = opts.seed ?? 1;
  const k = FLOOR_K;
  const originX = ARENA.height * k; // left vertex at x = 0
  const width = Math.ceil((ARENA.width + ARENA.height) * k);
  const height = Math.ceil(((ARENA.width + ARENA.height) * k) / 2) + FLOOR_CLIFF_PX;
  const img = createImage(width, height);
  const maxLift = FLOOR_CLIFF_PX / k; // in arena px

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const { x, y } = isoUnproject(px + 0.5 - originX, py + 0.5, k);
      if (x >= 0 && y >= 0 && x < ARENA.width && y < ARENA.height) {
        setPixel(img, px, py, floorColorAt(x, y, zones, seed));
        continue;
      }
      // Cliff: lifting this pixel by t arena px (h = t·k screen px up) lands
      // on the arena's front edge (x = 800 or y = 800).
      const t = Math.max(x, y) - ARENA.width;
      if (t < 0 || t > maxLift || Math.min(x, y) - t < 0) continue;
      const leftFace = y >= x; // the y = 800 edge faces bottom-left
      const along = leftFace ? x - t : y - t;
      const depthPx = t * k;
      const row = Math.floor(depthPx / 3.5);
      const joint = Math.floor(along * k + (row % 2) * 4) % 8 === 0;
      let c = leftFace ? FLOOR.cliffLeft : FLOOR.cliffRight;
      if (depthPx < 1) c = FLOOR.lip;
      else if (joint || depthPx % 3.5 < 1) c = mixRgb(c, FLOOR.mortar, 0.6);
      // Fade the bottom of the cliff into the background.
      const fade = depthPx > FLOOR_CLIFF_PX - 3 ? 0.55 : 1;
      setPixel(img, px, py, c, Math.round(255 * fade));
    }
  }
  return { image: img, k, originX, originY: 0 };
}

// ---------------------------------------------------------------------------
// Cosmetic edge props (outside the arena; no gameplay effect)
// ---------------------------------------------------------------------------

export type PropKind = 'rock' | 'crystal' | 'banner' | 'bush';

export interface EdgeProp extends DepthItem {
  key: string;
  kind: PropKind;
  /** Billboard radius in arena px (drawn 2·size·zoom wide, like units). */
  size: number;
}

/**
 * Deterministic props along the two back edges (x < 0 or y < 0), so they
 * never cover a unit, plus a banner at each side corner.
 */
export function edgeProps(seed = 1): EdgeProp[] {
  const out: EdgeProp[] = [];
  const kinds: PropKind[] = ['rock', 'bush', 'crystal', 'rock', 'bush'];
  let i = 0;
  for (let s = 30; s < ARENA.width - 20; s += 62) {
    for (const edge of ['top', 'left'] as const) {
      const r = hash01(s, edge === 'top' ? 1 : 2, seed);
      if (r < 0.25) continue; // gaps
      const off = 14 + hash01(s, 3, seed + i) * 22;
      const along = s + (hash01(s, 4, seed) - 0.5) * 24;
      const kind = kinds[Math.floor(hash01(s, edge === 'top' ? 5 : 6, seed) * kinds.length)]!;
      const size = kind === 'crystal' ? 9 : kind === 'rock' ? 8 + hash01(s, 7, seed) * 5 : 9;
      out.push({
        key: `prop-${i++}`,
        kind,
        size,
        x: edge === 'top' ? along : -off,
        y: edge === 'top' ? -off : along,
      });
    }
  }
  out.push({ key: 'banner-top', kind: 'banner', size: 12, x: -18, y: -18 });
  out.push({ key: 'banner-right', kind: 'banner', size: 12, x: ARENA.width + 10, y: -22 });
  out.push({ key: 'banner-left', kind: 'banner', size: 12, x: -22, y: ARENA.height + 10 });
  return out;
}

/** 12×12 pixel-art props, as SpriteSpecs so the sprite baker draws them. */
function art(rows: string[]): string[] {
  return rows.map((r) => r.padEnd(12, '.').slice(0, 12));
}

export const PROP_SPRITES: Readonly<Record<PropKind, SpriteSpec>> = {
  rock: {
    grid: 12,
    palette: { o: '#1B1C28', g: '#6C7088', h: '#9196B0', d: '#4A4D62' },
    frames: {
      idle: [
        art([
          '............',
          '............',
          '............',
          '............',
          '....oooo....',
          '...ohhggo...',
          '..ohhgggdo..',
          '..oggggddo..',
          '.oggggdddgo.',
          '.ogdggdddddo',
          '.oddddddddo.',
          '..oooooooo..',
        ]),
      ],
    },
  },
  bush: {
    grid: 12,
    palette: { o: '#10241A', g: '#2E7D4F', h: '#58B26F', d: '#1D5636', b: '#E8D45A' },
    frames: {
      idle: [
        art([
          '............',
          '............',
          '............',
          '....ooo.....',
          '...ohhgo.oo.',
          '..ohhgggohho',
          '.ohgggbgggdo',
          '.oggdgggdggo',
          'ohgggdggggdo',
          'ogddggdgdddo',
          '.oddddddddo.',
          '..oooooooo..',
        ]),
      ],
    },
  },
  crystal: {
    grid: 12,
    palette: { o: '#1A1030', c: '#7B5CFF', h: '#C3B2FF', w: '#FFFFFF', d: '#4A2FB0', g: '#4A4D62' },
    frames: {
      idle: [
        art([
          '.....oo.....',
          '....ohco....',
          '....ohco.o..',
          '...ohwcdoho.',
          '...ohccdoco.',
          '.o.ohccdocdo',
          'ohoohccdocdo',
          'ocdohccdocdo',
          'ocdohccdooo.',
          '.oogggggggo.',
          '.ogggggggggo',
          '..ooooooooo.',
        ]),
        art([
          '.....oo.....',
          '....ohco....',
          '....owco.o..',
          '...ohhcdoho.',
          '...ohccdoho.',
          '.o.ohccdocdo',
          'ohoohccdocdo',
          'ohdohccdocdo',
          'ocdohccdooo.',
          '.oogggggggo.',
          '.ogggggggggo',
          '..ooooooooo.',
        ]),
      ],
    },
  },
  banner: {
    grid: 12,
    palette: { o: '#1A1020', p: '#8A6A4A', r: '#D0384A', h: '#FF7A7A', y: '#F4D35E', d: '#7A1A2A' },
    frames: {
      idle: [
        art([
          '.oo.........',
          '.opoooooo...',
          '.oprhhrrro..',
          '.oprryyrro..',
          '.opryyyyro..',
          '.oprryyrro..',
          '.oprrrrrdo..',
          '.oprdrrddo..',
          '.opodoodo...',
          '.op.o..o....',
          'oppo........',
          'oooo........',
        ]),
        art([
          '.oo.........',
          '.opooooooo..',
          '.oprhhrrrro.',
          '.oprryyrrro.',
          '.opryyyyrro.',
          '.oprryyrrro.',
          '.oprrrrrrdo.',
          '.oprdrrdddo.',
          '.opoddoodo..',
          '.op.oo..o...',
          'oppo........',
          'oooo........',
        ]),
      ],
    },
  },
};
