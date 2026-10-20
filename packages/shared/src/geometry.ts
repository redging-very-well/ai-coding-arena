// Arena geometry (plan §9): arena size, corner zones, zone-local cells,
// per-round zone assignment, unit radii, range checks and the sudden-death
// safe circle.
//
// Zone-local cells: each zone is a 6×6 grid of 40 px cells. `col`/`row` are
// mirrored per corner so that (0,0) is always the cell nearest the arena
// centre; `col` runs along x (away from the centre), `row` along y (away from
// the centre). This keeps "Copy last layout" meaningful when zones rotate.

import type { GameConfig } from './config.js';
import { DEFAULT_SIZE, type UnitType } from './contract.js';

export const ARENA = { width: 800, height: 800 } as const;
export const CENTER = { x: 400, y: 400 } as const;
export const ZONE_SIZE = 240;
export const CELL_SIZE = 40;
export const GRID_SIZE = 6; // ZONE_SIZE / CELL_SIZE

/**
 * DEFAULT body radius per unit type. A unit's real radius is its `size` stat
 * (§9 Radii), which defaults to these values when the unit doesn't set it.
 */
export const UNIT_RADIUS: Readonly<Record<UnitType, number>> = DEFAULT_SIZE;

/** Default radius for a type (only used when no `size` is known). */
export function radiusFor(type: UnitType): number {
  return UNIT_RADIUS[type];
}

export type Corner = 'TL' | 'TR' | 'BR' | 'BL';
export const CORNERS: readonly Corner[] = ['TL', 'TR', 'BR', 'BL'];

export interface Point {
  x: number;
  y: number;
}
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Cell {
  col: number;
  row: number;
}

/** Arena-space rectangle of a corner zone. */
export function zoneRect(corner: Corner): Rect {
  const right = corner === 'TR' || corner === 'BR';
  const bottom = corner === 'BL' || corner === 'BR';
  return {
    x: right ? ARENA.width - ZONE_SIZE : 0,
    y: bottom ? ARENA.height - ZONE_SIZE : 0,
    width: ZONE_SIZE,
    height: ZONE_SIZE,
  };
}

/** Centre of a corner zone (`world.myCorner`). */
export function zoneCenter(corner: Corner): Point {
  const r = zoneRect(corner);
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/**
 * Which way zone-local col/row grow in arena space for a corner: +1 means the
 * arena coordinate increases with col/row. Left zones grow leftwards (−x) so
 * col 0 hugs the centre; top zones grow upwards (−y).
 */
function axisSigns(corner: Corner): { sx: 1 | -1; sy: 1 | -1 } {
  const right = corner === 'TR' || corner === 'BR';
  const bottom = corner === 'BL' || corner === 'BR';
  return { sx: right ? 1 : -1, sy: bottom ? 1 : -1 };
}

export function isValidCell(col: number, row: number): boolean {
  return (
    Number.isInteger(col) && Number.isInteger(row) && col >= 0 && row >= 0 && col < GRID_SIZE && row < GRID_SIZE
  );
}

/** Arena-space centre of zone-local cell (col,row). Throws on an invalid cell. */
export function cellCenter(corner: Corner, col: number, row: number): Point {
  if (!isValidCell(col, row)) throw new RangeError(`cell (${col},${row}) is outside the ${GRID_SIZE}x${GRID_SIZE} zone`);
  const r = zoneRect(corner);
  const { sx, sy } = axisSigns(corner);
  // Edge of the zone nearest the centre, then step outwards cell by cell.
  const innerX = sx === 1 ? r.x : r.x + r.width;
  const innerY = sy === 1 ? r.y : r.y + r.height;
  return {
    x: innerX + sx * (col * CELL_SIZE + CELL_SIZE / 2),
    y: innerY + sy * (row * CELL_SIZE + CELL_SIZE / 2),
  };
}

/** Inverse of `cellCenter`: the zone-local cell containing an arena point, or null. */
export function cellAt(corner: Corner, x: number, y: number): Cell | null {
  const r = zoneRect(corner);
  if (x < r.x || x >= r.x + r.width || y < r.y || y >= r.y + r.height) return null;
  const { sx, sy } = axisSigns(corner);
  const dx = sx === 1 ? x - r.x : r.x + r.width - x;
  const dy = sy === 1 ? y - r.y : r.y + r.height - y;
  const col = Math.min(GRID_SIZE - 1, Math.floor(dx / CELL_SIZE));
  const row = Math.min(GRID_SIZE - 1, Math.floor(dy / CELL_SIZE));
  return { col, row };
}

/**
 * The set of zones used for n players (§9): 2 players TL+BR, 3 players
 * TL/TR/BR (TR is the "middle" seat next to both others), 4 players all
 * (clockwise).
 */
export function zoneSetFor(playerCount: number): readonly Corner[] {
  switch (playerCount) {
    case 1:
      return ['TL'];
    case 2:
      return ['TL', 'BR'];
    case 3:
      return ['TL', 'TR', 'BR'];
    case 4:
      return ['TL', 'TR', 'BR', 'BL'];
    default:
      throw new RangeError(`unsupported player count ${playerCount} (1-4)`);
  }
}

/**
 * Per-round zone assignment (§9): active players in join order get
 * `zoneSet[(i + round) % n]`. Returns a map playerId → corner.
 */
export function assignZones(playerIdsInJoinOrder: readonly string[], round: number): Map<string, Corner> {
  const n = playerIdsInJoinOrder.length;
  const set = zoneSetFor(n);
  const out = new Map<string, Corner>();
  playerIdsInJoinOrder.forEach((id, i) => {
    out.set(id, set[(((i + round) % n) + n) % n]!);
  });
  return out;
}

/** Instance id of a placed copy: `${seat}-${row}-${col}` (zone-local cell). */
export function instanceIdFor(seat: number, row: number, col: number): string {
  return `${seat}-${row}-${col}`;
}

/** Edge-to-edge gap between two bodies (negative when overlapping). */
export function edgeDistance(
  a: { x: number; y: number; radius: number },
  b: { x: number; y: number; radius: number },
): number {
  return Math.hypot(b.x - a.x, b.y - a.y) - a.radius - b.radius;
}

/**
 * Engine range check: in range when the edge gap ≤ range + tolerance
 * (§5 rule 4; tolerance defaults to config `sim.rangeTolerance`, 0.5).
 */
export function inRange(
  self: { x: number; y: number; radius: number; range: number },
  other: { x: number; y: number; radius: number },
  tolerance = 0.5,
): boolean {
  return edgeDistance(self, other) <= self.range + tolerance;
}

/** Clamp a point to the arena. */
export function clampToArena(p: Point): Point {
  return {
    x: Math.min(ARENA.width, Math.max(0, p.x)),
    y: Math.min(ARENA.height, Math.max(0, p.y)),
  };
}

/**
 * Safe-circle radius at a tick (§9 sudden death): `startRadius` until
 * `startTick`, then shrinking linearly to `endRadius` at `endTick`.
 */
export function safeZoneRadius(tick: number, sd: GameConfig['suddenDeath']): number {
  if (tick <= sd.startTick) return sd.startRadius;
  if (tick >= sd.endTick) return sd.endRadius;
  const t = (tick - sd.startTick) / (sd.endTick - sd.startTick);
  return sd.startRadius + (sd.endRadius - sd.startRadius) * t;
}

/** Whether a unit centre is outside the safe circle (and so takes sudden-death damage). */
export function outsideSafeZone(p: Point, radius: number): boolean {
  return Math.hypot(p.x - CENTER.x, p.y - CENTER.y) > radius;
}

/** Sudden-death damage per tick for a unit: damagePctPerSecond% of maxHP / ticksPerSecond. */
export function suddenDeathDamagePerTick(maxHp: number, cfg: Pick<GameConfig, 'suddenDeath' | 'timers'>): number {
  return (maxHp * cfg.suddenDeath.damagePctPerSecond) / 100 / cfg.timers.ticksPerSecond;
}
