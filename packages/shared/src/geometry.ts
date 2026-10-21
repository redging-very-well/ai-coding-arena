// Arena geometry (plan §9): the 800 arena and its corner zones, cell sizes,
// unit radii, range checks and the sudden-death safe circle.
//
// Map styles for 2-8 players (arena 800/1040/1200, zone tables, facing, the
// generalized zone-local cells and rotation incl. team blocks) are in maps.ts
// (§9.2). The Corner helpers here are the 4-player Corners map, whose zones
// keep the original rule: each zone is a 6×6 grid of 40 px cells, `col` runs
// along x and `row` along y, both away from the centre, so (0,0) is the cell
// nearest the arena centre.

import type { GameConfig } from './config.js';
import { DEFAULT_SIZE, type UnitType } from './contract.js';

/** The 800 arena of 2-4 players (bigger maps: `arenaSizeFor` in maps.ts, §9.2). */
export const ARENA = { width: 800, height: 800 } as const;
/** Centre of the 800 arena. An S arena's centre is (S/2, S/2). */
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

export function isValidCell(col: number, row: number): boolean {
  return (
    Number.isInteger(col) && Number.isInteger(row) && col >= 0 && row >= 0 && col < GRID_SIZE && row < GRID_SIZE
  );
}

// Zone-local cells (`cellCenter`, `cellAt`) live in maps.ts: they take a
// `Corner` (this file's 4-corner zones) or any §9.2 map zone.

/**
 * The Corner set used for n players on the 800 arena (Duel / Corners maps,
 * §9.2; other counts and styles: `mapFor` in maps.ts): 2 players TL+BR, 3 players
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

/** Clamp a point to an S×S arena (default 800). */
export function clampToArena(p: Point, arena: number = ARENA.width): Point {
  return {
    x: Math.min(arena, Math.max(0, p.x)),
    y: Math.min(arena, Math.max(0, p.y)),
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

/**
 * Whether a unit centre is outside the safe circle (and so takes sudden-death
 * damage). The circle is centred on the arena centre (default the 800 arena's).
 */
export function outsideSafeZone(p: Point, radius: number, center: Point = CENTER): boolean {
  return Math.hypot(p.x - center.x, p.y - center.y) > radius;
}

/** Sudden-death damage per tick for a unit: damagePctPerSecond% of maxHP / ticksPerSecond. */
export function suddenDeathDamagePerTick(maxHp: number, cfg: Pick<GameConfig, 'suddenDeath' | 'timers'>): number {
  return (maxHp * cfg.suddenDeath.damagePctPerSecond) / 100 / cfg.timers.ticksPerSecond;
}
