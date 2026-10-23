// Movement and separation (plan §9 tick order steps 4-5).

import { ARENA, type Point } from '@pixel-clash/shared';
import type { Rng } from './prng.js';
import type { SimUnit } from './types.js';
import { pushOutOfWalls, type WallGrid } from './walls.js';

/**
 * Keep a body inside the S×S arena (default 800, §9.2). The centre is clamped
 * so the whole body stays on the field (cell centres are ≥ 20 px from the
 * edge, so placement is never affected).
 */
export function clampBody(u: Pick<SimUnit, 'x' | 'y' | 'radius'>, arena: number = ARENA.width): void {
  u.x = Math.min(arena - u.radius, Math.max(u.radius, u.x));
  u.y = Math.min(arena - u.radius, Math.max(u.radius, u.y));
}

/**
 * Move a soldier straight toward `dest` by at most `speed` px (no
 * teleporting), then clamp. Returns true if the unit actually moved.
 */
export function stepToward(u: SimUnit, dest: Point, speed: number, arena: number = ARENA.width): boolean {
  const dx = dest.x - u.x;
  const dy = dest.y - u.y;
  const dist = Math.hypot(dx, dy);
  if (dist === 0 || speed <= 0) return false;
  const before = { x: u.x, y: u.y };
  if (dist <= speed) {
    u.x = dest.x;
    u.y = dest.y;
  } else {
    u.x += (dx / dist) * speed;
    u.y += (dy / dist) * speed;
  }
  clampBody(u, arena);
  return u.x !== before.x || u.y !== before.y;
}

/** Bodies that never move: towers, factories and walls (§5.2). */
export function isFixedBody(u: Pick<SimUnit, 'type'>): boolean {
  return u.type === 'tower' || u.type === 'factory' || u.type === 'wall';
}

/** Above this many circle bodies, separation checks pairs through a 40 px spatial hash (§9.3). */
export const SPATIAL_HASH_MIN_BODIES = 64;
const HASH_CELL = 40;

/** Push one overlapping pair apart (see `separate`). */
function pushPair(a: SimUnit, b: SimUnit, rng: Rng, arena: number): void {
  const aFixed = isFixedBody(a);
  const bFixed = isFixedBody(b);
  if (aFixed && bFixed) return;

  const minDist = a.radius + b.radius;
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  // Cheap reject before the square root.
  if (Math.abs(dx) >= minDist || Math.abs(dy) >= minDist) return;
  let dist = Math.hypot(dx, dy);
  if (dist >= minDist) return;

  if (dist === 0) {
    const angle = rng() * Math.PI * 2;
    dx = Math.cos(angle);
    dy = Math.sin(angle);
    dist = 0;
  } else {
    dx /= dist;
    dy /= dist;
  }
  const overlap = minDist - dist;

  if (aFixed) {
    b.x += dx * overlap;
    b.y += dy * overlap;
    clampBody(b, arena);
  } else if (bFixed) {
    a.x -= dx * overlap;
    a.y -= dy * overlap;
    clampBody(a, arena);
  } else {
    const half = overlap / 2;
    a.x -= dx * half;
    a.y -= dy * half;
    b.x += dx * half;
    b.y += dy * half;
    clampBody(a, arena);
    clampBody(b, arena);
  }
}

/**
 * Separation (§9): `passes` relaxation passes over every overlapping pair, in
 * instanceId order. Each pair is pushed apart along the centre line until the
 * bodies just touch. Two moving bodies share the push; towers and factories
 * never move, so a soldier or minion touching one takes the full push.
 * Fixed-fixed pairs are left alone (they start in separate cells and never
 * move). Bodies at exactly the same spot are split along a direction from the
 * seeded PRNG.
 *
 * Walls (§9.3) are not circles: leave them out of `units` and pass the wall
 * grid; every pass then ends by pushing the moving bodies out of the wall
 * squares (`pushOutOfWalls`), so after the last pass no body overlaps a wall.
 * With more than 64 bodies the pairs come from a 40 px spatial hash (radii
 * are ≤ 20), still visited in the same (i, j) instanceId order.
 *
 * `units` must be the living circle bodies sorted by instanceId.
 */
export function separate(units: readonly SimUnit[], passes: number, rng: Rng, arena: number = ARENA.width, walls?: WallGrid): void {
  const hashed = units.length > SPATIAL_HASH_MIN_BODIES;
  for (let pass = 0; pass < passes; pass++) {
    if (!hashed) {
      for (let i = 0; i < units.length; i++) {
        const a = units[i]!;
        for (let j = i + 1; j < units.length; j++) pushPair(a, units[j]!, rng, arena);
      }
    } else {
      // Bucket indexes by hash cell (built at the start of the pass).
      const cols = Math.ceil(arena / HASH_CELL) + 1;
      const buckets = new Map<number, number[]>();
      const keyOf = (u: SimUnit) => Math.floor(u.y / HASH_CELL) * cols + Math.floor(u.x / HASH_CELL);
      const cellX = new Int32Array(units.length);
      const cellY = new Int32Array(units.length);
      for (let i = 0; i < units.length; i++) {
        const u = units[i]!;
        cellX[i] = Math.floor(u.x / HASH_CELL);
        cellY[i] = Math.floor(u.y / HASH_CELL);
        const k = keyOf(u);
        const b = buckets.get(k);
        if (b) b.push(i);
        else buckets.set(k, [i]);
      }
      const cand: number[] = [];
      for (let i = 0; i < units.length; i++) {
        const a = units[i]!;
        cand.length = 0;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            const b = buckets.get((cellY[i]! + oy) * cols + cellX[i]! + ox);
            if (!b) continue;
            for (const j of b) if (j > i) cand.push(j);
          }
        }
        cand.sort((x, y) => x - y);
        for (const j of cand) pushPair(a, units[j]!, rng, arena);
      }
    }
    if (walls && walls.size > 0) {
      for (const u of units) {
        if (isFixedBody(u)) continue;
        if (pushOutOfWalls(u, walls)) clampBody(u, arena);
      }
    }
  }
}
