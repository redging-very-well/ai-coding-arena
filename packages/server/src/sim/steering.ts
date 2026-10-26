// Wall steering: how soldiers and minions get around walls without
// pathfinding. Deterministic, no PRNG.
//
// A body of radius r at p moves toward dest with step L = min(speed, |dest − p|):
//   1. Cast the segment p → p + L·dir against the nearby wall squares inflated
//      by r (half-side 20 + r, slab method) and take the earliest entry (ties:
//      lower wall instanceId). A wall whose inflated square already contains p
//      counts as a hit at t = 0 on its nearest face, and only if the move goes
//      deeper into it.
//   2. No hit: move. Hit: move to the contact point (minus 0.01 px), then spend
//      the rest of L sliding along the hit face. The slide is cast too and stops
//      at the next wall it would enter (an inner corner). Where the wall line it
//      slides along ends, the slide goes just past the corner and, when dest is
//      on the far side of the line, spends what is left of L turning round
//      that corner (so a body finds the end of a line and one-cell gates).
//   3. Side: the slide memory's side when a memory for that axis is active;
//      else the side whose tangent points toward dest; exactly head-on: toward
//      world.center; still tied: + (x or y).
//   4. No progress (an inner corner or the arena edge): turn back once per
//      memory and slide again; still nothing: stay this tick.
//   5. Memory {side, axis, origin, quiet, flipped}: kept while the body keeps
//      hitting faces of the same axis; every tick without a hit adds 1 to
//      `quiet`, and it is dropped after `memoryTicks` quiet ticks or when dest
//      moves more than 80 px from `origin`.
//   6. Reporting: a tick a wall stopped or turned the move sets `blockedBy`
//      and adds 1 to `blockedTicks`; a free move resets both.

import { WALL_HALF, type Point } from '@pixel-clash/shared';
import { clampBody } from './movement.js';
import type { WallGrid } from './walls.js';
import type { SimUnit, SlideMemory } from './types.js';

/** Distance kept from a wall face after a contact (px). */
export const CONTACT_EPS = 0.01;
/** A slide shorter than this made no progress. */
const MIN_PROGRESS = 0.01;
/** How far past the end of a wall line a slide stops, so the next move is clear of the corner. */
const PAST_CORNER = 0.02;
/** Dropping the memory when the destination moved this far from where it started. */
const ORIGIN_DRIFT = 80;

interface Hit {
  t: number;
  wall: SimUnit;
  /** The axis of the hit face's normal. */
  normal: 'x' | 'y';
}

const near: SimUnit[] = [];

/** Earliest entry of the move p → p + (dx, dy) into a wall square inflated by r. */
function cast(px: number, py: number, dx: number, dy: number, r: number, grid: WallGrid): Hit | null {
  const h = WALL_HALF + r;
  near.length = 0;
  grid.query(Math.min(px, px + dx) - h, Math.min(py, py + dy) - h, Math.max(px, px + dx) + h, Math.max(py, py + dy) + h, near);
  let best: Hit | null = null;
  for (const w of near) {
    const minX = w.x - h;
    const maxX = w.x + h;
    const minY = w.y - h;
    const maxY = w.y + h;
    let t: number;
    let normal: 'x' | 'y';
    if (px > minX && px < maxX && py > minY && py < maxY) {
      // Already inside the inflated square (near a corner): the nearest face
      // counts, and only if the move goes deeper through it.
      const faces: Array<[number, 'x' | 'y', number]> = [
        [px - minX, 'x', dx], // left face, inward +x
        [maxX - px, 'x', -dx], // right face, inward −x
        [py - minY, 'y', dy], // top face, inward +y
        [maxY - py, 'y', -dy], // bottom face, inward −y
      ];
      let f = faces[0]!;
      for (const g of faces) if (g[0] < f[0]) f = g;
      if (!(f[2] > 1e-12)) continue;
      t = 0;
      normal = f[1];
    } else {
      let tEnter = -Infinity;
      let tExit = Infinity;
      let enterAxis: 'x' | 'y' = 'x';
      let enterTie = false;
      // x slab
      if (dx === 0) {
        if (!(px > minX && px < maxX)) continue;
      } else {
        let t1 = (minX - px) / dx;
        let t2 = (maxX - px) / dx;
        if (t1 > t2) [t1, t2] = [t2, t1];
        tEnter = t1;
        tExit = t2;
        enterAxis = 'x';
      }
      // y slab
      if (dy === 0) {
        if (!(py > minY && py < maxY)) continue;
      } else {
        let t1 = (minY - py) / dy;
        let t2 = (maxY - py) / dy;
        if (t1 > t2) [t1, t2] = [t2, t1];
        if (t1 > tEnter) {
          tEnter = t1;
          enterAxis = 'y';
        } else if (t1 === tEnter) {
          enterTie = true;
        }
        tExit = Math.min(tExit, t2);
      }
      if (!(tEnter < tExit) || tEnter < 0 || tEnter > 1) continue;
      // Exactly through a corner: the more head-on face.
      if (enterTie) enterAxis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
      t = tEnter;
      normal = enterAxis;
    }
    if (!best || t < best.t || (t === best.t && w.id < best.wall.id)) best = { t, wall: w, normal };
  }
  return best;
}

/**
 * How far (≥ 0) a slide from `pos` along `axis` in direction `side` may go
 * before it passes the end of the wall line whose face it is sliding along:
 * the hit wall and its neighbours in the same row (horizontal face) or
 * column (vertical face) form one face.
 */
function supportLeft(pos: number, wall: SimUnit, axis: 'x' | 'y', side: 1 | -1, r: number, grid: WallGrid): number {
  const { col, row } = grid.cellOf(wall);
  let last = wall;
  for (let k = 1; k < grid.cols; k++) {
    const next = axis === 'x' ? grid.at(col + side * k, row) : grid.at(col, row + side * k);
    if (!next) break;
    last = next;
  }
  const end = (axis === 'x' ? last.x : last.y) + side * (WALL_HALF + r);
  return Math.max(0, side * (end - pos) + PAST_CORNER);
}

/** Move the body by up to `d` along an axis, stopping at the first wall it would enter. Returns the distance moved. */
function castMove(u: SimUnit, axis: 'x' | 'y', sign: number, d: number, grid: WallGrid): number {
  if (d <= 0) return 0;
  const hit = cast(u.x, u.y, axis === 'x' ? sign * d : 0, axis === 'y' ? sign * d : 0, u.radius, grid);
  const go = hit ? Math.max(0, hit.t * d - CONTACT_EPS) : d;
  if (axis === 'x') u.x += sign * go;
  else u.y += sign * go;
  return go;
}

/**
 * Slide from the body's position along `axis` by up to `dist`; returns the
 * distance actually moved. `inward` is the direction (±1 along the other axis)
 * from the body into the wall; with `hug`, a slide that reaches the end of the
 * wall line turns round its corner with what is left.
 */
function slide(
  u: SimUnit,
  wall: SimUnit,
  axis: 'x' | 'y',
  side: 1 | -1,
  dist: number,
  grid: WallGrid,
  arena: number,
  inward: number,
  hug: boolean,
): number {
  const x0 = u.x;
  const y0 = u.y;
  const support = supportLeft(axis === 'x' ? u.x : u.y, wall, axis, side, u.radius, grid);
  const want = Math.min(dist, support);
  const went = castMove(u, axis, side, want, grid);
  if (hug && support < dist && went >= want - 1e-9) {
    castMove(u, axis === 'x' ? 'y' : 'x', inward, dist - went, grid);
  }
  clampBody(u, arena);
  return Math.hypot(u.x - x0, u.y - y0);
}

export interface SteerResult {
  /** The body's position changed. */
  moved: boolean;
  /** A wall stopped or turned the move. */
  blocked: boolean;
}

/**
 * Whether a body of radius `r` can move in a straight line from `p` to `q`
 * without entering a wall square inflated by `r` (line of sight for
 * planning and path smoothing).
 */
export function segmentClear(p: Point, q: Point, r: number, grid: WallGrid): boolean {
  if (grid.size === 0) return true;
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  if (dx === 0 && dy === 0) return true;
  return cast(p.x, p.y, dx, dy, r, grid) === null;
}

/** What one steering step did (before the blocked bookkeeping). */
export interface SteerStep {
  /** The body's position changed. */
  moved: boolean;
  /** The wall that stopped or turned the move, else null. */
  wall: SimUnit | null;
  /** How far the body got this tick (px). */
  progress: number;
  /** The step it tried: min(speed, distance to dest). */
  step: number;
}

/**
 * Move a soldier or minion toward `dest` by at most `speed` px, sliding along
 * walls, then clamp to the arena. Updates `blockedBy`,
 * `blockedTicks` and the slide memory.
 */
export function steerToward(
  u: SimUnit,
  dest: Point,
  speed: number,
  grid: WallGrid,
  arena: number,
  center: Point,
  memoryTicks: number,
): SteerResult {
  const s = steerStep(u, dest, speed, grid, arena, center, memoryTicks);
  if (!s.wall) {
    u.blockedBy = null;
    u.blockedTicks = 0;
    return { moved: s.moved, blocked: false };
  }
  markBlocked(u, s.wall.id);
  return { moved: s.moved, blocked: true };
}

/** A wall stopped the body this tick (rule 6): blockedBy, blockedTicks and the report maximum. */
export function markBlocked(u: SimUnit, wallId: string): void {
  u.blockedBy = wallId;
  u.blockedTicks = (u.blockedTicks ?? 0) + 1;
  u.blockedTicksMax = Math.max(u.blockedTicksMax ?? 0, u.blockedTicks);
}

/**
 * The steering step of `steerToward` (rules 1-5: move, slide, memory)
 * without the blocked bookkeeping, so the routing layer can decide what
 * counts as blocked.
 */
export function steerStep(
  u: SimUnit,
  dest: Point,
  speed: number,
  grid: WallGrid,
  arena: number,
  center: Point,
  memoryTicks: number,
): SteerStep {
  const x0 = u.x;
  const y0 = u.y;
  const dx = dest.x - u.x;
  const dy = dest.y - u.y;
  const dist = Math.hypot(dx, dy);

  // Age / drop the slide memory.
  let mem: SlideMemory | null = u.slide ?? null;
  if (mem && Math.hypot(dest.x - mem.origin.x, dest.y - mem.origin.y) > ORIGIN_DRIFT) mem = null;

  const L = Math.min(speed, dist);
  const result = (wall: SimUnit | null): SteerStep => ({
    moved: u.x !== x0 || u.y !== y0,
    wall,
    progress: Math.hypot(u.x - x0, u.y - y0),
    step: L,
  });
  const free = (): SteerStep => {
    if (mem) {
      mem.quiet += 1;
      if (mem.quiet > memoryTicks) mem = null;
    }
    u.slide = mem;
    return result(null);
  };

  if (dist === 0 || speed <= 0) return free();
  const ux = dx / dist;
  const uy = dy / dist;
  const hit = grid.size > 0 ? cast(u.x, u.y, ux * L, uy * L, u.radius, grid) : null;
  if (!hit) {
    if (dist <= speed) {
      u.x = dest.x;
      u.y = dest.y;
    } else {
      u.x += ux * L;
      u.y += uy * L;
    }
    clampBody(u, arena);
    return free();
  }

  // Move to the contact point, then slide along the hit face.
  const travel = Math.max(0, hit.t * L - CONTACT_EPS);
  u.x += ux * travel;
  u.y += uy * travel;
  const rest = L - travel;
  const axis: 'x' | 'y' = hit.normal === 'x' ? 'y' : 'x';

  if (mem && mem.axis === axis) {
    mem.quiet = 0;
  } else {
    const toward = axis === 'x' ? dest.x - u.x : dest.y - u.y;
    let side: 1 | -1;
    if (Math.abs(toward) >= 1e-9) side = toward > 0 ? 1 : -1;
    else {
      const c = axis === 'x' ? center.x - u.x : center.y - u.y;
      side = c < 0 ? -1 : 1;
    }
    mem = { side, axis, origin: { x: dest.x, y: dest.y }, quiet: 0, flipped: false };
  }

  if (rest > 0) {
    // Into the wall = from the body toward the wall's centre, across the hit face.
    const inward = hit.normal === 'x' ? (hit.wall.x > u.x ? 1 : -1) : hit.wall.y > u.y ? 1 : -1;
    const across = hit.normal === 'x' ? dest.x - u.x : dest.y - u.y;
    const hug = across * inward > 0;
    const progress = slide(u, hit.wall, axis, mem.side, rest, grid, arena, inward, hug);
    if (progress < Math.min(MIN_PROGRESS, rest / 2) && !mem.flipped) {
      // A dead end (inner corner or the arena edge): turn back once.
      mem.flipped = true;
      mem.side = mem.side === 1 ? -1 : 1;
      slide(u, hit.wall, axis, mem.side, rest, grid, arena, inward, hug);
    }
  } else {
    clampBody(u, arena);
  }

  u.slide = mem;
  return result(hit.wall);
}
