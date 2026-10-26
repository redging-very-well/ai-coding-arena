// The built-in minion: its stats, its value, and its AI.
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
//
// M8.6: every minion has a kind (grunt, archer, runner, brute;
// stats from `factory.minions.<kind>`) and follows its factory's squad order.
// The rules above are the `attack` order. `defend` anchors on the factory
// (defendRadius), `swarm` goes for one target only, `guard` anchors on an
// ally (guardRadius). Each kind uses its own aggroRange and impatientTicks.
//
// M8.8: minions carry their factory's minionElement (their hits
// apply it; they never splash). The medic never attacks: it heals (cleansing
// burning or frozen allies first, then the lowest hp fraction) within its
// reach, walks to an ally that needs it within its aggro range, and otherwise
// moves by the order (attack / swarm: follow the nearest non-medic minion of
// its factory, else the rally point; defend: the factory; guard: the ally).
// It routes round walls like every minion but never smashes one.

import {
  DEFAULT_CONFIG,
  MINION_KIND_NAMES,
  edgeDistance,
  minionPrice,
  pricingOf,
  type Element,
  type GameConfig,
  type MinionKind,
  type MinionOrder,
  type MinionStats,
  type Point,
  type StatsSnapshotLike,
} from '@pixel-clash/shared';
import { isSupportable, needsHealing } from './effects.js';
import type { SimStats, SimUnit } from './types.js';

/** The grunt's display name (the M8.6 kinds are named after their kind). */
export const MINION_NAME = MINION_KIND_NAMES.grunt;

/** A minion's kind (older fixtures without one are grunts). */
export function kindOf(m: Pick<SimUnit, 'minion'>): MinionKind {
  return m.minion?.kind ?? 'grunt';
}

/** The config of a minion kind. */
export function kindConfig(config: Pick<GameConfig, 'factory'>, kind: MinionKind): MinionStats {
  return config.factory.minions[kind];
}

/**
 * A minion kind's stats, coloured like its factory. M8.8: its factory's
 * element (medics: normal), no splash, and the medic's heal support.
 */
export function minionStats(config: Pick<GameConfig, 'factory'>, color: string, kind: MinionKind = 'grunt', element: Element = 'normal'): SimStats {
  const m = kindConfig(config, kind);
  const medic = kind === 'medic';
  return Object.freeze({
    name: MINION_KIND_NAMES[kind],
    type: 'minion' as const,
    maxHealth: m.maxHealth,
    damage: m.damage,
    range: m.range,
    speed: m.speed,
    attackCooldown: m.attackCooldown,
    color,
    size: m.size,
    shape: 'circle' as const,
    element: medic ? 'normal' : element,
    splashRadius: 0,
    support: medic ? { kind: 'heal' as const, power: m.heal ?? 0, range: m.reach ?? 0 } : null,
  });
}

/** minionValue: what a factory pays per minion of that kind (and element), its timeout value and value destroyed. */
export function minionValueOf(config: Pick<GameConfig, 'cost' | 'timers' | 'factory' | 'suddenDeath'>, kind: MinionKind = 'grunt', element: Element = 'normal'): number {
  return minionPrice(config.cost, pricingOf(config), kind, element).minionValue;
}

/** `battle:reveal`'s `minion` / `minions[kind]`. */
export function minionReveal(
  config: Pick<GameConfig, 'cost' | 'timers' | 'factory' | 'suddenDeath'> = DEFAULT_CONFIG,
  kind: MinionKind = 'grunt',
): { stats: StatsSnapshotLike; value: number } {
  return { stats: minionStats(config, '#C0A060', kind), value: minionValueOf(config, kind) };
}

/** `battle:reveal`'s `minions`: every kind built by one of these designs (none without factories). */
export function minionsReveal(
  designs: ReadonlyArray<Pick<StatsSnapshotLike, 'type'> & { produces?: MinionKind }>,
  config: Pick<GameConfig, 'cost' | 'timers' | 'factory' | 'suddenDeath'> = DEFAULT_CONFIG,
): { minions?: Partial<Record<MinionKind, { stats: StatsSnapshotLike; value: number }>> } {
  const kinds = new Set<MinionKind>();
  for (const d of designs) if (d.type === 'factory') kinds.add(d.produces ?? 'grunt');
  if (kinds.size === 0) return {};
  return { minions: Object.fromEntries([...kinds].sort().map((k) => [k, minionReveal(config, k)])) };
}

/** Damage a hit by `attacker` deals to `target`: minions multiply hits on walls by their kind's wallDamageMultiplier. */
export function hitDamage(attacker: SimUnit, target: Pick<SimUnit, 'type'>, config: Pick<GameConfig, 'factory'>): number {
  if (attacker.type !== 'minion' || target.type !== 'wall') return attacker.stats.damage;
  return attacker.stats.damage * kindConfig(config, kindOf(attacker)).wallDamageMultiplier;
}

export interface MinionWorld {
  /** Living bodies, sorted by instanceId. */
  living: readonly SimUnit[];
  safeCenter: Point;
  safeRadius: number;
  rangeTolerance: number;
  lookup: (id: string) => SimUnit | undefined;
  /** M8.8: sudden death has started, so heals do nothing. */
  healsOff?: boolean;
}

/** A living enemy of `m` with this id (walls included), else undefined. */
function enemyById(m: SimUnit, id: string | null | undefined, world: MinionWorld): SimUnit | undefined {
  if (!id) return undefined;
  const e = world.lookup(id);
  return e && e.alive && e.teamId !== m.teamId ? e : undefined;
}

/** A living ally of `m` (same side) with this id, else undefined. */
function allyById(m: SimUnit, id: string | null | undefined, world: MinionWorld): SimUnit | undefined {
  if (!id) return undefined;
  const a = world.lookup(id);
  return a && a.alive && a.teamId === m.teamId ? a : undefined;
}

/**
 * The order a minion follows this tick: its factory's, with the
 * fallbacks applied (a swarm without a living enemy target is an attack, a
 * guard without a living ally a defend). The engine already applies them at
 * the start of each tick; this keeps the AI safe on its own.
 */
export function effectiveOrder(m: SimUnit, world: MinionWorld): { order: MinionOrder; target?: SimUnit } {
  const f = m.minion?.factory.factory;
  const order = f?.order ?? 'attack';
  if (order === 'swarm') {
    const t = enemyById(m, f?.orderTargetId, world);
    return t ? { order, target: t } : { order: 'attack' };
  }
  if (order === 'guard') {
    const a = allyById(m, f?.orderTargetId, world);
    return a ? { order, target: a } : { order: 'defend' };
  }
  return { order };
}

/** Keep `p` inside the safe circle: a point outside it becomes the circle's centre. */
function insideSafe(p: Point, world: MinionWorld): Point {
  return Math.hypot(p.x - world.safeCenter.x, p.y - world.safeCenter.y) > world.safeRadius ? world.safeCenter : p;
}

/**
 * The nearest living non-wall enemy (edge to edge from the minion) that
 * `near` accepts; ties keep the lower instanceId (living is sorted).
 */
function nearestEnemy(m: SimUnit, world: MinionWorld, near: (e: SimUnit, gap: number) => boolean): { target?: SimUnit; gap: number } {
  let target: SimUnit | undefined;
  let best = Infinity;
  for (const e of world.living) {
    if (e.teamId === m.teamId || e.type === 'wall' || !e.alive) continue;
    const gap = edgeDistance(m, e);
    if (!near(e, gap)) continue;
    // Strictly nearer wins; living is in instanceId order, so ties keep the lower id.
    if (gap < best) {
      best = gap;
      target = e;
    }
  }
  return target ? { target, gap: best } : { gap: best };
}

/**
 * The impatience rule: blocked by an enemy wall for the
 * kind's `impatientTicks` → attack it (move to it when out of range). Null
 * when it doesn't apply, or when the wall is `skip` (the swarm target itself).
 */
function smashBlockingWall(m: SimUnit, world: MinionWorld, impatientTicks: number, skip?: SimUnit): unknown {
  if ((m.blockedTicks ?? 0) < impatientTicks || !m.blockedBy) return null;
  const w = world.lookup(m.blockedBy);
  if (!w || !w.alive || w.type !== 'wall' || w.teamId === m.teamId || w === skip) return null;
  if (edgeDistance(m, w) <= m.stats.range + world.rangeTolerance) return { action: 'attack', targetId: w.id };
  return { action: 'move', destination: { x: w.x, y: w.y } };
}

/** The minion's raw action for this tick (validated by sim/actions.ts like any other). */
export function minionAction(m: SimUnit, world: MinionWorld, config: Pick<GameConfig, 'factory'>): unknown {
  if (kindOf(m) === 'medic') return medicAction(m, world, config);
  const f = config.factory;
  const kind = kindConfig(config, kindOf(m));
  const reach = m.stats.range + world.rangeTolerance;
  const fac = m.minion?.factory;
  const { order, target: focus } = effectiveOrder(m, world);

  if (order === 'swarm' && focus) {
    // One target for the whole squad, wherever it is (walls included).
    if (edgeDistance(m, focus) <= reach) return { action: 'attack', targetId: focus.id };
    return smashBlockingWall(m, world, kind.impatientTicks, focus) ?? moveTo(m, focus, world);
  }

  // The anchor the minions stay round, and which enemies count as near it.
  let anchor: Point;
  let arrive: (d: number) => boolean;
  let near: (e: SimUnit, gap: number) => boolean;
  if (order === 'guard' && focus) {
    anchor = focus;
    arrive = (d) => d <= focus.radius + m.radius + f.guardArriveGap;
    near = (e) => Math.hypot(e.x - focus.x, e.y - focus.y) <= f.guardRadius;
  } else if (order === 'defend') {
    const home = insideSafe(fac ? { x: fac.x, y: fac.y } : world.safeCenter, world);
    anchor = home;
    arrive = (d) => d <= f.defendArriveRadius;
    near = (e) => Math.hypot(e.x - home.x, e.y - home.y) <= f.defendRadius;
  } else {
    // attack (M8.5 rules 1-5).
    const rally = insideSafe(fac?.factory?.rally ?? world.safeCenter, world);
    anchor = rally;
    arrive = (d) => d <= f.rallyArriveRadius;
    near = (e, gap) => gap <= kind.aggroRange || Math.hypot(e.x - rally.x, e.y - rally.y) <= f.rallyGuardRadius;
  }

  const { target, gap } = nearestEnemy(m, world, near);
  // A reachable enemy always comes first.
  if (target && gap <= reach) return { action: 'attack', targetId: target.id };
  // Smash an enemy wall that has been in the way for a while (even when
  // chasing a target: it may be walled in).
  const smash = smashBlockingWall(m, world, kind.impatientTicks);
  if (smash) return smash;
  if (target) return moveTo(m, target, world);
  if (!arrive(Math.hypot(anchor.x - m.x, anchor.y - m.y))) return moveTo(m, anchor, world);
  return { action: 'idle' };
}

/**
 * The medic's AI: heal the ally that needs it most within reach
 * (burning or frozen first, then the lowest hp / maxHp, then the lower
 * instanceId) when the cooldown is ready; else walk to such an ally within
 * aggro range; else move by the order. Never attacks, never smashes walls.
 */
export function medicAction(m: SimUnit, world: MinionWorld, config: Pick<GameConfig, 'factory'>): unknown {
  const f = config.factory;
  const kind = kindConfig(config, 'medic');
  const reach = (kind.reach ?? 0) + world.rangeTolerance;
  if (!world.healsOff) {
    let inReach: SimUnit | undefined;
    let inReachKey = Infinity;
    let near: SimUnit | undefined;
    let nearKey = Infinity;
    for (const a of world.living) {
      if (a === m || !a.alive || a.teamId !== m.teamId || !isSupportable(a) || !needsHealing(a)) continue;
      // Burning or frozen first (key < 1), then the lowest hp fraction (living is in instanceId order: ties keep the lower id).
      const key = ((a.burns?.length ?? 0) > 0 || (a.frozen ?? 0) > 0 ? -2 : 0) + a.hp / a.maxHp;
      const gap = edgeDistance(m, a);
      if (gap <= reach && key < inReachKey) {
        inReachKey = key;
        inReach = a;
      }
      if (gap <= kind.aggroRange && key < nearKey) {
        nearKey = key;
        near = a;
      }
    }
    if (inReach && m.cooldownRemaining <= 0) return { action: 'heal', targetId: inReach.id };
    // In reach but reloading: wait by it.
    if (inReach) return { action: 'idle' };
    if (near) return moveTo(m, near, world);
  }
  const fac = m.minion?.factory;
  const { order, target: focus } = effectiveOrder(m, world);
  const keepClose = (a: SimUnit) => Math.hypot(a.x - m.x, a.y - m.y) <= a.radius + m.radius + f.guardArriveGap;
  if (order === 'guard' && focus) return keepClose(focus) ? { action: 'idle' } : moveTo(m, focus, world);
  if (order === 'defend') {
    const home = insideSafe(fac ? { x: fac.x, y: fac.y } : world.safeCenter, world);
    return Math.hypot(home.x - m.x, home.y - m.y) <= f.defendArriveRadius ? { action: 'idle' } : moveTo(m, home, world);
  }
  // attack and swarm: follow the nearest living non-medic minion of my factory, else the rally point.
  let buddy: SimUnit | undefined;
  let best = Infinity;
  for (const u of world.living) {
    if (u === m || !u.alive || u.minion?.factory !== fac || kindOf(u) === 'medic') continue;
    const d = Math.hypot(u.x - m.x, u.y - m.y);
    if (d < best) {
      best = d;
      buddy = u;
    }
  }
  if (buddy) return keepClose(buddy) ? { action: 'idle' } : moveTo(m, buddy, world);
  const rally = insideSafe(fac?.factory?.rally ?? world.safeCenter, world);
  return Math.hypot(rally.x - m.x, rally.y - m.y) <= f.rallyArriveRadius ? { action: 'idle' } : moveTo(m, rally, world);
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

/**
 * factory.crumbleRadius (tick step 9a): does a minion centred at `m` crumble with the factory centred at
 * `fac`? Centre-to-centre distance <= radius; radius 0 = every minion, wherever.
 */
export function withinCrumbleRadius(m: { x: number; y: number }, fac: { x: number; y: number }, radius: number): boolean {
  return radius <= 0 || (m.x - fac.x) ** 2 + (m.y - fac.y) ** 2 <= radius * radius;
}
