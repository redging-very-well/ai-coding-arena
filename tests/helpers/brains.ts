// The archetype brains of the balance harness (plan §14): the CLAUDE.md
// templates as plain functions ("chase nearest", "shoot nearest", the factory
// orders, medics and banners, M8.8 hold-by-the-tower, and focus fire: "kill
// the healer first, then the casters, then the weakest").
//
// This file is SELF-CONTAINED on purpose (type imports only): it is the one
// source of the brains for both runners of the balance tooling.
//   * helpers/balance.ts `BrainRunner` imports it and calls `actFor` directly
//     (the lean in-process runner, no sandbox: the fast path);
//   * `brainUnitSource` (helpers/brainUnits.ts) reads THIS FILE's text, adds a
//     unit class whose update() calls `actFor`, and the result goes through the
//     validator's transpile into the real sandbox runners (isolated-vm, node:vm).
// tests/balance-parity.test.ts checks both give bit-identical battles. So: no
// runtime imports, no module state, and Math.random only through `rng` (inside
// the sandbox `rng` is the harness's seeded Math.random, the same mulberry32
// sequence as the lean runner's per-player PRNG).

import type { OtherView, SelfView, WorldView } from '@pixel-clash/shared';

export type Rng = () => number;
export type Action =
  | { action: 'idle' }
  | { action: 'move'; destination: { x: number; y: number } }
  | { action: 'attack'; targetId: string }
  | { action: 'heal'; targetId: string }
  | { action: 'rally'; destination: { x: number; y: number } }
  | { action: 'command'; order: 'attack' | 'defend' | 'swarm' | 'guard'; targetId?: string }
  | { action: 'release' }
  | { action: 'hold' };
export type BrainFn = (self: SelfView, enemies: OtherView[], world: WorldView, rng: Rng, allies: OtherView[]) => Action;

const gap = (a: { x: number; y: number; radius: number }, b: { x: number; y: number; radius: number }) =>
  Math.hypot(b.x - a.x, b.y - a.y) - a.radius - b.radius;

/** Other non-wall enemies a splash of radius r on `t` would reach (§5.4: centre to edge). */
const clumpAround = (t: OtherView, enemies: OtherView[], r: number): number => {
  let n = 0;
  for (const e of enemies) if (e !== t && e.type !== 'wall' && Math.hypot(e.x - t.x, e.y - t.y) - e.radius <= r) n++;
  return n;
};

/**
 * M8.8 target picks (the CLAUDE.md examples): a fire unit hits a frozen enemy
 * first (SHATTER); a splash unit hits the enemy with the most other enemies
 * round it. `reach` is how far it looks (a tower: its range; a soldier: a step
 * further). Null = no special pick (the template's nearest).
 */
function elementalPick(self: SelfView, enemies: OtherView[], reach: number): OtherView | null {
  if (self.element !== 'fire' && self.splashRadius <= 0) return null;
  let best: OtherView | null = null;
  let bestScore = -1;
  let bestGap = Infinity;
  for (const e of enemies) {
    if (e.type === 'wall') continue;
    const g = gap(self, e);
    if (g > reach) continue;
    const score = (self.element === 'fire' && e.status.frozen > 0 ? 100 : 0) + (self.splashRadius > 0 ? clumpAround(e, enemies, self.splashRadius) : 0);
    if (score > bestScore || (score === bestScore && g < bestGap)) {
      best = e;
      bestScore = score;
      bestGap = g;
    }
  }
  return best && bestScore > 0 ? best : null;
}

/**
 * "Chase nearest" (basic_soldier.js): walk to the nearest enemy that isn't a
 * wall (the nearest wall when only walls are left), hit it when in range;
 * stuck behind an enemy wall for 120 ticks: smash it (M8.5). The seed only
 * breaks near-ties (enemies within 8 px of the nearest gap), so seeds give
 * slightly different but sensible fights. M8.8: fire and splash soldiers make
 * their elemental pick among the enemies within a step of their range.
 */
const chaseNearest: BrainFn = (self, enemies, world, rng) => {
  if (enemies.length === 0) return { action: 'move', destination: world.center };
  const hit = (target: OtherView): Action => {
    if (gap(self, target) <= self.range) return self.cooldownRemaining === 0 ? { action: 'attack', targetId: target.id } : { action: 'idle' };
    return { action: 'move', destination: { x: target.x, y: target.y } };
  };
  if (self.blockedTicks >= 120) {
    const wall = enemies.find((e) => e.id === self.blockedBy);
    if (wall) return hit(wall);
  }
  const pick = elementalPick(self, enemies, self.range + 20);
  if (pick) return hit(pick);
  const fighters = enemies.filter((e) => e.type !== 'wall');
  const pool = fighters.length > 0 ? fighters : enemies;
  let best = Infinity;
  for (const e of pool) best = Math.min(best, gap(self, e));
  const near = pool.filter((e) => gap(self, e) <= best + 8);
  return hit(near[Math.floor(rng() * near.length)] ?? pool[0]!);
};

/**
 * Focus fire (2026-10-24, the exploit search's ice-splash combo army): what a
 * player's "kill the healer first" unit does. Among the enemies it can reach
 * (not walls): healers first, then the other support units and the ice or
 * splash casters, then the one with the least HP; ties go to the nearer one.
 * Null when nothing is in reach.
 */
const focusRank = (e: OtherView): number => (e.support?.kind === 'heal' ? 0 : e.support !== null || e.element === 'ice' || e.splashRadius > 0 ? 1 : 2);
function focusPick(self: SelfView, enemies: OtherView[], reach: number): OtherView | null {
  let best: OtherView | null = null;
  let bestRank = Infinity;
  let bestHp = Infinity;
  let bestGap = Infinity;
  for (const e of enemies) {
    if (e.type === 'wall') continue;
    const g = gap(self, e);
    if (g > reach) continue;
    const rank = focusRank(e);
    if (rank < bestRank || (rank === bestRank && (e.hp < bestHp || (e.hp === bestHp && g < bestGap)))) {
      best = e;
      bestRank = rank;
      bestHp = e.hp;
      bestGap = g;
    }
  }
  return best;
}

/** How far past its range a focus soldier looks for a better target (a short walk). */
const FOCUS_LOOK = 80;

/**
 * Focus soldiers: like the template, but inside range + FOCUS_LOOK they go for
 * the focus pick (healer, support, ice or splash caster, else the weakest)
 * instead of the nearest; fire and splash soldiers still make their elemental
 * pick first. Nothing in reach: chase the nearest like the template.
 */
const chaseFocus: BrainFn = (self, enemies, world, rng, allies) => {
  if (enemies.length === 0 || self.blockedTicks >= 120 || elementalPick(self, enemies, self.range + 20)) return chaseNearest(self, enemies, world, rng, allies);
  const pick = focusPick(self, enemies, self.range + FOCUS_LOOK);
  if (!pick) return chaseNearest(self, enemies, world, rng, allies);
  if (gap(self, pick) <= self.range) return self.cooldownRemaining === 0 ? { action: 'attack', targetId: pick.id } : { action: 'idle' };
  return { action: 'move', destination: { x: pick.x, y: pick.y } };
};

/**
 * M8.8 "hold" soldiers (an army built round a tower, like Blizzard + fire):
 * stay by the nearest own tower and fight what comes within 160 px of it, so
 * the tower's freeze and the soldiers' fire land on the same enemies. With no
 * tower left they chase like the template.
 */
const HOLD_RADIUS = 160;
const holdNearTower = (chase: BrainFn): BrainFn => (self, enemies, world, rng, allies) => {
  let anchor: OtherView | null = null;
  let best = Infinity;
  for (const a of allies) {
    if (a.type !== 'tower') continue;
    const d = Math.hypot(a.x - self.x, a.y - self.y);
    if (d < best) {
      best = d;
      anchor = a;
    }
  }
  if (!anchor) return chase(self, enemies, world, rng, allies);
  const near = enemies.filter((e) => e.type !== 'wall' && Math.hypot(e.x - anchor.x, e.y - anchor.y) - e.radius <= HOLD_RADIUS);
  if (near.length > 0) return chase(self, near, world, rng, allies);
  if (gap(self, anchor) > 30) return { action: 'move', destination: { x: anchor.x, y: anchor.y } };
  return { action: 'idle' };
};

const HOLD_NEAREST = holdNearTower(chaseNearest);
const HOLD_FOCUS = holdNearTower(chaseFocus);

/** A body a heal can land on (§5.5: never walls or factories). */
const healable = (a: OtherView): boolean => a.type !== 'wall' && a.type !== 'factory';
/** §5.5: hurt with heal room left, or burning, or frozen. */
const needsHeal = (a: OtherView): boolean => a.status.burning > 0 || a.status.frozen > 0 || (a.hp < a.maxHp && a.status.healRoom > 0);

/**
 * CLAUDE.md Field Medic: cleanse burning or frozen allies first, then heal the
 * most hurt one (lowest hp fraction) in reach. Null when there is nobody to heal.
 */
function healPick(self: SelfView, allies: OtherView[]): Action | null {
  const s = self.support;
  if (!s || s.kind !== 'heal' || self.cooldownRemaining > 0) return null;
  let best: OtherView | null = null;
  let bestKey = Infinity;
  for (const a of allies) {
    if (a.id === self.id || !healable(a) || !needsHeal(a) || gap(self, a) > s.range) continue;
    const key = (a.status.burning + a.status.frozen > 0 ? 0 : 1) + a.hp / a.maxHp;
    if (key < bestKey) {
      best = a;
      bestKey = key;
    }
  }
  return best ? { action: 'heal', targetId: best.id } : null;
}

/** The nearest ally that fights (a soldier, tower or minion without support; else any ally that isn't a wall or factory). */
function nearestFighter(self: SelfView, allies: OtherView[]): OtherView | null {
  let best: OtherView | null = null;
  let bestKey = Infinity;
  for (const a of allies) {
    if (a.id === self.id || !healable(a)) continue;
    const key = (a.support === null ? 0 : 100_000) + Math.hypot(a.x - self.x, a.y - self.y);
    if (key < bestKey) {
      best = a;
      bestKey = key;
    }
  }
  return best;
}

/**
 * M8.8 support soldiers (the CLAUDE.md medic and banner): heal first; else
 * stay with the nearest fighting ally (inside half the support range, so the
 * aura or heal reaches it), hitting enemies that come close if it has damage.
 */
const supportSoldier: BrainFn = (self, enemies, world, rng, allies) => {
  const heal = healPick(self, allies);
  if (heal) return heal;
  const friend = nearestFighter(self, allies);
  if (!friend) return self.damage > 0 ? chaseNearest(self, enemies, world, rng, allies) : { action: 'move', destination: world.center };
  if (self.damage > 0) {
    let target: OtherView | null = null;
    let best = Infinity;
    for (const e of enemies) {
      const g = gap(self, e);
      if (e.type !== 'wall' && g < best) {
        best = g;
        target = e;
      }
    }
    if (target && best <= self.range) return self.cooldownRemaining === 0 ? { action: 'attack', targetId: target.id } : { action: 'idle' };
    if (target && best <= self.range + 40 && gap(self, friend) <= (self.support?.range ?? 0)) return { action: 'move', destination: { x: target.x, y: target.y } };
  }
  if (gap(self, friend) > (self.support?.range ?? 40) / 2) return { action: 'move', destination: { x: friend.x, y: friend.y } };
  return { action: 'idle' };
};

/**
 * basic_tower.js: shoot the nearest enemy in range; a wall only when nothing
 * else is in range. M8.8: a healing tower heals first; fire and splash towers
 * make their elemental pick.
 */
const shootNearest: BrainFn = (self, enemies, _world, _rng, allies) => {
  if (self.cooldownRemaining > 0) return { action: 'idle' };
  const heal = healPick(self, allies);
  if (heal) return heal;
  const pick = elementalPick(self, enemies, self.range);
  if (pick) return { action: 'attack', targetId: pick.id };
  let target: OtherView | null = null;
  let best = Infinity;
  let wall: OtherView | null = null;
  let bestWall = Infinity;
  for (const e of enemies) {
    const g = gap(self, e);
    if (g > self.range) continue;
    if (e.type === 'wall') {
      if (g < bestWall) {
        bestWall = g;
        wall = e;
      }
    } else if (g < best) {
      best = g;
      target = e;
    }
  }
  const t = target ?? wall;
  return t ? { action: 'attack', targetId: t.id } : { action: 'idle' };
};

/** A focus tower: heal first, the elemental pick, else the focus pick in range, else shoot the nearest (walls last). */
const shootFocus: BrainFn = (self, enemies, world, rng, allies) => {
  if (self.cooldownRemaining > 0 || healPick(self, allies) || elementalPick(self, enemies, self.range)) return shootNearest(self, enemies, world, rng, allies);
  const pick = focusPick(self, enemies, self.range);
  return pick ? { action: 'attack', targetId: pick.id } : shootNearest(self, enemies, world, rng, allies);
};

/** basic_factory.js: rally the minions on the nearest enemy that isn't a wall (else the centre). */
const rallyNearest: BrainFn = (self, enemies, world) => {
  let spot = world.center;
  let best = Infinity;
  for (const e of enemies) {
    if (e.type === 'wall') continue;
    const d = Math.hypot(e.x - self.x, e.y - self.y);
    if (d < best) {
      best = d;
      spot = { x: e.x, y: e.y };
    }
  }
  return { action: 'rally', destination: spot };
};

/** A factory that never builds: it holds every tick. */
const holdForever: BrainFn = () => ({ action: 'hold' });

/** CLAUDE.md example: archers that guard the nearest own tower (else stay home). Needs the allies. */
const guardTower: BrainFn = (self, _enemies, _world, _rng, allies) => {
  let tower: OtherView | null = null;
  let best = Infinity;
  for (const a of allies) {
    if (a.type !== 'tower') continue;
    const d = Math.hypot(a.x - self.x, a.y - self.y);
    if (d < best) {
      best = d;
      tower = a;
    }
  }
  return tower ? { action: 'command', order: 'guard', targetId: tower.id } : { action: 'command', order: 'defend' };
};

/** M8.8 CLAUDE.md example: "medics with command guard on your tank": guard the toughest own soldier (else stay home). */
const guardTank: BrainFn = (self, _enemies, _world, _rng, allies) => {
  let tank: OtherView | null = null;
  for (const a of allies) {
    if (a.type !== 'soldier') continue;
    if (!tank || a.maxHp > tank.maxHp || (a.maxHp === tank.maxHp && Math.hypot(a.x - self.x, a.y - self.y) < Math.hypot(tank.x - self.x, tank.y - self.y))) tank = a;
  }
  return tank ? { action: 'command', order: 'guard', targetId: tank.id } : { action: 'command', order: 'defend' };
};

/** CLAUDE.md example: everyone at the weakest enemy that isn't a wall (lowest hp, then id). */
const swarmWeakest: BrainFn = (_self, enemies) => {
  let weakest: OtherView | null = null;
  for (const e of enemies) {
    if (e.type === 'wall') continue;
    if (!weakest || e.hp < weakest.hp) weakest = e;
  }
  return weakest ? { action: 'command', order: 'swarm', targetId: weakest.id } : { action: 'command', order: 'attack' };
};

/** CLAUDE.md example: brutes swarm the enemy wall nearest the factory, then hunt like the template. */
const swarmWall: BrainFn = (self, enemies, world, rng) => {
  let wall: OtherView | null = null;
  let best = Infinity;
  for (const e of enemies) {
    if (e.type !== 'wall') continue;
    const d = Math.hypot(e.x - self.x, e.y - self.y);
    if (d < best) {
      best = d;
      wall = e;
    }
  }
  return wall ? { action: 'command', order: 'swarm', targetId: wall.id } : rallyNearest(self, enemies, world, rng, []);
};

/** Keep the minions home. */
const defendHome: BrainFn = () => ({ action: 'command', order: 'defend' });

/** M8.8: how an army's fighting soldiers play: chase nearest (the template) or hold by their towers. */
export type SoldierBrain = 'chase' | 'hold';

/** Who an army's fighters shoot: the nearest (the templates) or the focus pick. */
export type Targeting = 'nearest' | 'focus';

export type FactoryBrain = 'rally' | 'guard' | 'guardTank' | 'swarm' | 'breach' | 'defend';


const FACTORY_BRAINS: Record<FactoryBrain, BrainFn> = {
  rally: rallyNearest,
  guard: guardTower,
  guardTank,
  swarm: swarmWeakest,
  breach: swarmWall,
  defend: defendHome,
};

/** How an army's brains play (the archetype's options). */
export interface BrainOptions {
  /** The factories hold every tick (they never build: the dormant-factory turtle). */
  holdFactories?: boolean;
  /** M8.6: the factories' order brain (default: rally on the nearest enemy, the template); M8.8: or one per factory design. */
  factoryBrain?: FactoryBrain | Partial<Record<string, FactoryBrain>>;
  /** M8.8: the fighting soldiers' brain (default: chase nearest, the template). */
  soldierBrain?: SoldierBrain;
  /**
   * Who the fighting soldiers and towers shoot (2026-10-24): 'nearest' (default, the
   * templates) or 'focus' (healers, then support and ice/splash casters, then the
   * weakest in reach: focusPick).
   */
  targeting?: Targeting;
}

/** The action of one instance: the brain for its type (tower, factory, support soldier, fighting soldier). */
export function actFor(self: SelfView, enemies: OtherView[], allies: OtherView[], world: WorldView, rng: Rng, opts: BrainOptions): Action {
  const fbs = opts.factoryBrain ?? 'rally';
  const fb: FactoryBrain = typeof fbs === 'string' ? fbs : (fbs[self.unitId] ?? 'rally');
  const factory = opts.holdFactories === true ? holdForever : FACTORY_BRAINS[fb];
  const focus = opts.targeting === 'focus';
  const chase = focus ? chaseFocus : chaseNearest;
  const soldier = opts.soldierBrain === 'hold' ? (focus ? HOLD_FOCUS : HOLD_NEAREST) : chase;
  const brain = self.type === 'tower' ? (focus ? shootFocus : shootNearest) : self.type === 'factory' ? factory : self.support ? supportSoldier : soldier;
  return brain(self, enemies, world, rng, allies);
}
