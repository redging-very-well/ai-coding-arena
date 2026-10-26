// Hits and homing projectiles (tick order steps 6-7).
//
// Range ≤ meleeMaxRange (50) is melee: the hit lands instantly when the unit
// fires. Longer ranges spawn a homing projectile that flies 10 px/tick toward
// the target's current position and always hits while the target lives; it
// vanishes if the target dies first. The projectile carries the damage fixed
// at fire time and still lands if the shooter dies in the meantime.
//
// Credit: the attacker is credited the
// EFFECTIVE damage, min(hit, target hp before the hit), when the hit lands
// (projectiles on impact), and on a kill the victim's value (its full
// unit cost; a factory its living value at death). Hits in
// one tick (melee swipes and projectile impacts together) resolve in attacker
// instanceId order (= seat, then instanceId), so exactly one attacker gets
// each kill; a later hit on a target already at ≤ 0 hp deals nothing (a
// projectile fizzles).

import type { Element } from '@pixel-clash/shared';
import { compareIds, type Projectile, type SimUnit } from './types.js';
import { killValueOf } from './value.js';

/** What one hit did, for events and the report. */
export interface HitOutcome {
  /** Damage actually removed from the target (capped at its remaining hp). */
  dealt: number;
  /** This hit took the target from > 0 hp to ≤ 0 hp. */
  killed: boolean;
}

/**
 * Apply `damage` from `attacker` (which may already be dead) to `target`.
 * Credits the effective damage, and on a kill the kill and the victim's full
 * cost, to the attacker. A target already at ≤ 0 hp takes nothing.
 */
export function applyHit(attacker: SimUnit | undefined, target: SimUnit, damage: number): HitOutcome {
  const before = target.hp;
  if (before <= 0) return { dealt: 0, killed: false };
  target.hp -= damage;
  const dealt = Math.max(0, Math.min(damage, before));
  const killed = target.hp <= 0;
  if (attacker) {
    attacker.damageDealt += dealt;
    if (killed) {
      target.killedBy = attacker;
      attacker.kills += 1;
      // Walls their full price, factories their living value at death.
      attacker.valueDestroyed += killValueOf(target);
    }
  }
  return { dealt, killed };
}

/** A hit waiting to land this tick: a melee swipe (step 6) or a projectile impact (step 7). */
export interface PendingHit {
  /** Attacker instanceId (seat, then instanceId order). */
  attackerId: string;
  target: SimUnit;
  damage: number;
  /** The projectile, or undefined for a melee hit. */
  projectile?: Projectile;
  /** M8.8, melee hits (a projectile carries its own): the element, splash and might at fire time. */
  element?: Element;
  splash?: number;
  might?: number;
  mightSrc?: SimUnit | null;
}

/**
 * Move every projectile by `speed` px toward its target. A projectile arrives
 * when the remaining gap to the target's body is within one step; arrivals are
 * returned (not applied) so the caller can resolve them with the tick's melee
 * hits. A shot whose target is gone or at ≤ 0 hp fizzles.
 */
export function moveProjectiles(
  projectiles: readonly Projectile[],
  lookup: (instanceId: string) => SimUnit | undefined,
  speed: number,
): { remaining: Projectile[]; arrived: PendingHit[] } {
  const remaining: Projectile[] = [];
  const arrived: PendingHit[] = [];
  for (const p of projectiles) {
    if (p.miss) {
      // A miss flies to a fixed spot and lands there whatever happened to the target.
      const dx = p.miss.x - p.x;
      const dy = p.miss.y - p.y;
      const dist = Math.hypot(dx, dy);
      const target = lookup(p.targetId);
      if (dist <= speed) {
        p.x = p.miss.x;
        p.y = p.miss.y;
        if (target) arrived.push({ attackerId: p.ownerId, target, damage: p.damage, projectile: p });
        continue;
      }
      p.x += (dx / dist) * speed;
      p.y += (dy / dist) * speed;
      remaining.push(p);
      continue;
    }
    const target = lookup(p.targetId);
    // The target died (this tick or earlier): the shot fizzles.
    if (!target || !target.alive || target.hp <= 0) continue;

    const dx = target.x - p.x;
    const dy = target.y - p.y;
    const dist = Math.hypot(dx, dy);
    if (dist - target.radius <= speed) {
      arrived.push({ attackerId: p.ownerId, target, damage: p.damage, projectile: p });
      continue;
    }
    p.x += (dx / dist) * speed;
    p.y += (dy / dist) * speed;
    remaining.push(p);
  }
  return { remaining, arrived };
}

/**
 * Land one tick's hits (melee and projectile together) in attacker order:
 * attacker instanceId (= seat, then instanceId), then projectile id, so the
 * first owner in seat order gets each kill. A projectile
 * whose target an earlier hit took to ≤ 0 hp fizzles; a melee swipe still
 * lands (dealing nothing).
 */
export function resolveHits(hits: readonly PendingHit[], onHit: (hit: PendingHit) => void): void {
  const ordered = hits.slice().sort((a, b) => compareIds(a.attackerId, b.attackerId) || (a.projectile?.id ?? 0) - (b.projectile?.id ?? 0));
  for (const h of ordered) {
    if (h.projectile && !h.projectile.miss && h.target.hp <= 0) continue;
    onHit(h);
  }
}

/**
 * Advance every projectile and land this step's arrivals in attacker order
 * (see moveProjectiles / resolveHits). Returns the projectiles still in flight.
 */
export function advanceProjectiles(
  projectiles: readonly Projectile[],
  lookup: (instanceId: string) => SimUnit | undefined,
  speed: number,
  onHit: (p: Projectile, target: SimUnit) => void,
): Projectile[] {
  const { remaining, arrived } = moveProjectiles(projectiles, lookup, speed);
  resolveHits(arrived, (h) => onHit(h.projectile!, h.target));
  return remaining;
}
