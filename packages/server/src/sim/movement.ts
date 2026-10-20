// Movement and separation (plan §9 tick order steps 4-5).

import { ARENA, type Point } from '@pixel-clash/shared';
import type { Rng } from './prng.js';
import type { SimUnit } from './types.js';

/**
 * Keep a body inside the arena. The centre is clamped so the whole body stays
 * on the 800×800 field (cell centres are ≥ 20 px from the edge, so placement
 * is never affected).
 */
export function clampBody(u: Pick<SimUnit, 'x' | 'y' | 'radius'>): void {
  u.x = Math.min(ARENA.width - u.radius, Math.max(u.radius, u.x));
  u.y = Math.min(ARENA.height - u.radius, Math.max(u.radius, u.y));
}

/**
 * Move a soldier straight toward `dest` by at most `speed` px (no
 * teleporting), then clamp. Returns true if the unit actually moved.
 */
export function stepToward(u: SimUnit, dest: Point, speed: number): boolean {
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
  clampBody(u);
  return u.x !== before.x || u.y !== before.y;
}

/**
 * Separation (§9): `passes` relaxation passes over every overlapping pair, in
 * instanceId order. Each pair is pushed apart along the centre line until the
 * bodies just touch. Two soldiers share the push; a tower never moves, so a
 * soldier touching a tower takes the full push. Tower-tower pairs are left
 * alone (they start in separate cells and never move). Bodies at exactly the
 * same spot are split along a direction from the seeded PRNG.
 *
 * `units` must be the living units sorted by instanceId.
 */
export function separate(units: readonly SimUnit[], passes: number, rng: Rng): void {
  for (let pass = 0; pass < passes; pass++) {
    for (let i = 0; i < units.length; i++) {
      const a = units[i]!;
      for (let j = i + 1; j < units.length; j++) {
        const b = units[j]!;
        const aFixed = a.type === 'tower';
        const bFixed = b.type === 'tower';
        if (aFixed && bFixed) continue;

        const minDist = a.radius + b.radius;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        // Cheap reject before the square root.
        if (Math.abs(dx) >= minDist || Math.abs(dy) >= minDist) continue;
        let dist = Math.hypot(dx, dy);
        if (dist >= minDist) continue;

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
          clampBody(b);
        } else if (bFixed) {
          a.x -= dx * overlap;
          a.y -= dy * overlap;
          clampBody(a);
        } else {
          const half = overlap / 2;
          a.x -= dx * half;
          a.y -= dy * half;
          b.x += dx * half;
          b.y += dy * half;
          clampBody(a);
          clampBody(b);
        }
      }
    }
  }
}
