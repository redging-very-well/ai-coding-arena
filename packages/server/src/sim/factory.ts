// Factory production.
//
// Each living factory, in instanceId order: unless it returned `hold` this
// tick, its timer goes up by 1 (to at most productionInterval). When the timer
// is full it makes one minion if (a) it has minions left, (b) fewer than
// `maxAlivePerFactory` of its minions are alive, (c) its owner has fewer than
// min(maxAlivePerPlayer, floor(maxAlivePerBattle / players)) minions alive
// (counting minions spawned earlier in this step), and (d) a spawn spot is
// free; otherwise it waits with a full timer and tries again every tick.
// A disabled factory keeps producing toward its last rally point: production
// is engine-side, only its update() naps. A dead factory makes nothing.
//
// M8.6: a minion that doesn't complete the
// factory's burst waits inside (`stored`, no spawn spot needed); the one
// that completes it leaves together with the stored ones. Stored minions
// count toward the alive caps, leave early on `release`, and leave on their
// own when the store can't grow (caps full, nothing left to make, no time).

import { FACTORY_RADIUS, zoneAxes, type FactoryConfig, type Point, type ZoneRef } from '@pixel-clash/shared';
import { circleOverlapsWall, type WallGrid } from './walls.js';
import type { FactoryState, SimUnit } from './types.js';

/** The alive-minion cap per player. */
export function alivePerPlayerCap(factory: Pick<FactoryConfig, 'maxAlivePerPlayer' | 'maxAlivePerBattle'>, players: number): number {
  return Math.min(factory.maxAlivePerPlayer, Math.floor(factory.maxAlivePerBattle / Math.max(1, players)));
}

/**
 * The zone's facing as a direction: out of the front edge for N/S/E/W
 * zones, diagonally towards the corner nearest the arena centre for corner
 * zones (the same arrow as the /play placement grid).
 */
export function zoneFacingDir(zone: ZoneRef): Point {
  const facing = typeof zone === 'string' ? 'diag' : zone.facing;
  if (facing === 'S') return { x: 0, y: 1 };
  if (facing === 'N') return { x: 0, y: -1 };
  if (facing === 'E') return { x: 1, y: 0 };
  if (facing === 'W') return { x: -1, y: 0 };
  // col/row grow away from the centre on a corner zone, so the facing is the other way.
  const a = zoneAxes(zone);
  return a.colAxis === 'x' ? { x: -a.colSign, y: -a.rowSign } : { x: -a.rowSign, y: -a.colSign };
}

/**
 * How many more minions a factory can make before time runs out: spawns
 * happen when the timer is full, at most one per tick, and one at the time
 * limit itself doesn't count (E = floor((battleTicks − 1) / interval)), so
 * min(minionsLeft, floor((timer + ticksLeft − 1) / interval)). A factory that
 * holds, or whose spawn spots are all covered, runs out of time: its timer is
 * frozen (a covered factory counts as an empty timer). It is 0 at the time
 * limit, so unbuilt minions are never worth anything there.
 */
export function canMakeOf(f: Pick<FactoryState, 'minionsLeft' | 'timer' | 'productionInterval' | 'noSpot'>, ticksLeft: number): number {
  const timer = f.noSpot ? 0 : f.timer;
  return Math.max(0, Math.min(f.minionsLeft, Math.floor((timer + ticksLeft - 1) / f.productionInterval)));
}

/** The 8 spawn directions (degrees) relative to the rally direction, in the order they are tried. */
const SPAWN_ANGLES = [0, 45, -45, 90, -90, 135, -135, 180];

/**
 * The spawn spot for a factory's next minion: 8 candidates
 * 18 + minionRadius + 2 px from the factory centre, starting toward the rally
 * point (or along the zone's facing, `zoneFacingDir`, when the rally point
 * is the factory itself). The first one inside the arena that overlaps no wall square and no
 * tower or factory wins; null when none is free.
 */
export function spawnSpot(
  fac: SimUnit,
  rally: Point,
  facing: Point,
  arena: number,
  minionRadius: number,
  grid: WallGrid,
  buildings: readonly SimUnit[],
): Point | null {
  return spawnSpots(fac, rally, facing, arena, minionRadius, grid, buildings, 1)[0] ?? null;
}

/**
 * Spots for `count` minions leaving together: the
 * free candidates of `spawnSpot` in its order, cycling when fewer are free
 * than minions leave (separation spreads them). Empty when none is free.
 */
export function spawnSpots(
  fac: SimUnit,
  rally: Point,
  facing: Point,
  arena: number,
  minionRadius: number,
  grid: WallGrid,
  buildings: readonly SimUnit[],
  count: number,
): Point[] {
  const free: Point[] = [];
  let dx = rally.x - fac.x;
  let dy = rally.y - fac.y;
  if (Math.hypot(dx, dy) < 1e-9) {
    dx = facing.x;
    dy = facing.y;
  }
  const theta = Math.hypot(dx, dy) < 1e-9 ? 0 : Math.atan2(dy, dx);
  const dist = FACTORY_RADIUS + minionRadius + 2;
  const near: SimUnit[] = [];
  for (const deg of SPAWN_ANGLES) {
    const a = theta + (deg * Math.PI) / 180;
    // Rounded to 1e-6 so the spot doesn't depend on the last bits of cos/sin.
    const x = Math.round((fac.x + Math.cos(a) * dist) * 1e6) / 1e6;
    const y = Math.round((fac.y + Math.sin(a) * dist) * 1e6) / 1e6;
    if (x < minionRadius || y < minionRadius || x > arena - minionRadius || y > arena - minionRadius) continue;
    near.length = 0;
    grid.query(x - minionRadius - 20, y - minionRadius - 20, x + minionRadius + 20, y + minionRadius + 20, near);
    if (near.some((w) => circleOverlapsWall({ x, y }, minionRadius, w))) continue;
    if (buildings.some((b) => b.alive && Math.hypot(b.x - x, b.y - y) < b.radius + minionRadius - 1e-9)) continue;
    free.push({ x, y });
    if (free.length >= count) break;
  }
  if (free.length === 0) return [];
  const out: Point[] = [];
  for (let i = 0; i < count; i++) out.push(free[i % free.length]!);
  return out;
}
