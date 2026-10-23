// The built-in minion (plan §5.2): its stats, its value, and its AI.
//
// Minions are made by factories (sim/factory.ts) and run this engine logic,
// never player code. The AI decides from the same start-of-tick state as the
// players' units, and its action is validated and applied exactly like
// theirs (seat, then instanceId order):
//   1. Rally R = its factory's rally point (the last one if the factory is
//      gone). If R is outside the safe circle, R = the circle's centre.
//   2. Target = the nearest living enemy that is not a wall and is within
//      `aggroRange` (120) px edge to edge of the minion, or within
//      `rallyGuardRadius` (200) px of R; ties by instanceId.
//   3. Target in range → attack it.
//   4. Blocked by an enemy wall for `impatientTicks` (120) → attack it (move
//      to it when out of range), even with a target out of range: that is how
//      minions break into a walled-in enemy.
//   5. Target out of range → move toward it. No target: more than
//      `rallyArriveRadius` (24) px from R → move to R; else idle (guard the
//      rally point).
//   Every move goes round towers and factories: a minion touching one that
//   sits (almost) exactly on its way sidesteps instead (`sidestep`), since
//   separation pushes it straight back along the centre line otherwise.

import {
  DEFAULT_CONFIG,
  edgeDistance,
  minionPrice,
  pricingOf,
  type GameConfig,
  type Point,
  type StatsSnapshotLike,
} from '@pixel-clash/shared';
import type { SimStats, SimUnit } from './types.js';

/** The minion's display name. */
export const MINION_NAME = 'Minion';

/** The minion's stats, coloured like its factory. */
export function minionStats(config: Pick<GameConfig, 'factory'>, color: string): SimStats {
  const m = config.factory.minion;
  return Object.freeze({
    name: MINION_NAME,
    type: 'minion' as const,
    maxHealth: m.maxHealth,
    damage: m.damage,
    range: m.range,
    speed: m.speed,
    attackCooldown: m.attackCooldown,
    color,
    size: m.size,
    shape: 'circle' as const,
  });
}

/** minionValue (§6): what a factory pays per minion, a minion's timeout value and value destroyed. */
export function minionValueOf(config: Pick<GameConfig, 'cost' | 'timers' | 'factory'>): number {
  return minionPrice(config.cost, pricingOf(config)).minionValue;
}

/** `battle:reveal`'s `minion` (§9.3 Frames). */
export function minionReveal(config: Pick<GameConfig, 'cost' | 'timers' | 'factory'> = DEFAULT_CONFIG): { stats: StatsSnapshotLike; value: number } {
  return { stats: minionStats(config, '#C0A060'), value: minionValueOf(config) };
}

export interface MinionWorld {
  /** Living bodies, sorted by instanceId. */
  living: readonly SimUnit[];
  safeCenter: Point;
  safeRadius: number;
  rangeTolerance: number;
  lookup: (id: string) => SimUnit | undefined;
}

/** The minion's raw action for this tick (validated by sim/actions.ts like any other). */
export function minionAction(m: SimUnit, world: MinionWorld, config: Pick<GameConfig, 'factory'>): unknown {
  const f = config.factory;
  let rally = m.minion?.factory.factory?.rally ?? world.safeCenter;
  if (Math.hypot(rally.x - world.safeCenter.x, rally.y - world.safeCenter.y) > world.safeRadius) rally = world.safeCenter;

  let target: SimUnit | undefined;
  let best = Infinity;
  for (const e of world.living) {
    if (e.teamId === m.teamId || e.type === 'wall' || !e.alive) continue;
    const gap = edgeDistance(m, e);
    if (gap > f.minion.aggroRange && Math.hypot(e.x - rally.x, e.y - rally.y) > f.rallyGuardRadius) continue;
    // Strictly nearer wins; living is in instanceId order, so ties keep the lower id.
    if (gap < best) {
      best = gap;
      target = e;
    }
  }
  // A reachable enemy always comes first.
  if (target && best <= m.stats.range + world.rangeTolerance) return { action: 'attack', targetId: target.id };

  // Smash an enemy wall that has been in the way for a while (even when
  // chasing a target: it may be walled in).
  if ((m.blockedTicks ?? 0) >= f.minion.impatientTicks && m.blockedBy) {
    const w = world.lookup(m.blockedBy);
    if (w && w.alive && w.type === 'wall' && w.teamId !== m.teamId) {
      if (edgeDistance(m, w) <= m.stats.range + world.rangeTolerance) return { action: 'attack', targetId: w.id };
      return { action: 'move', destination: { x: w.x, y: w.y } };
    }
  }
  if (target) return moveTo(m, target, world);
  if (Math.hypot(rally.x - m.x, rally.y - m.y) > f.rallyArriveRadius) return moveTo(m, rally, world);
  return { action: 'idle' };
}

/** A move toward `dest`, sidestepping a tower or factory dead ahead. */
function moveTo(m: SimUnit, dest: Point, world: MinionWorld): unknown {
  return { action: 'move', destination: sidestep(m, dest, world) ?? { x: dest.x, y: dest.y } };
}

/**
 * When the minion touches a tower or factory (of any side) whose centre lies
 * within 15% of their radii of the straight line to `dest`, ahead of it, a
 * point beside it (+90° on the side the minion already leans to, or +90°
 * from the heading when exactly in line); otherwise null. One step sideways
 * is enough: off the centre line, separation slides it round the building.
 */
export function sidestep(m: SimUnit, dest: Point, world: Pick<MinionWorld, 'living'>): Point | null {
  const len = Math.hypot(dest.x - m.x, dest.y - m.y);
  if (len < 1e-9) return null;
  const ux = (dest.x - m.x) / len;
  const uy = (dest.y - m.y) / len;
  for (const b of world.living) {
    if (!b.alive || (b.type !== 'tower' && b.type !== 'factory')) continue;
    const reach = m.radius + b.radius;
    const cx = b.x - m.x;
    const cy = b.y - m.y;
    if (Math.hypot(cx, cy) > reach + 1) continue; // not touching
    const ahead = cx * ux + cy * uy;
    if (ahead <= 0 || ahead > len + b.radius) continue; // behind, or past the destination
    const cross = ux * cy - uy * cx; // > 0: the building is to the left of the heading
    if (Math.abs(cross) > reach * 0.15) continue;
    // Step to the side away from the building (+90° when exactly in line).
    const side = cross > 0 ? -1 : 1;
    return { x: m.x - uy * side * reach, y: m.y + ux * side * reach };
  }
  return null;
}
