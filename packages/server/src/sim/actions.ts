// Action validation (plan §5 rule 4, §9 tick order step 3).
//
// A unit's update() result is only a request. Anything that is not a legal
// action becomes idle: undefined, unknown actions, malformed objects, moves by
// towers, attacks on allies (own units, and in team mode any teammate's,
// §9.2) / dead / unknown targets, attacks while cooling
// down, and attacks out of range. M8.5 (§5.2): `rally` and `hold` are factory
// actions; `move` is for soldiers and minions, `attack` for soldiers, towers
// and minions; any other combination idles (no strike). Walls are valid
// targets. M8.6 (§5.3): `command` (a squad order) and `release` are factory
// actions too; a command with an unknown order, or swarm/guard without a
// string targetId, is malformed (the factory keeps its previous order).
// M8.8 (§5 rule 4): `heal` needs heal support and a living ally (same teamId:
// a soldier, tower or minion, not the healer itself) in supportRange (edge
// to edge + 0.5 px) that needs it (hurt with heal room left, burning or
// frozen), cooldown 0, and no sudden death yet; otherwise it idles (no
// strike) and the cooldown is kept. Validation runs against the start-of-tick
// snapshot, the same state every unit decided on, so resolution is
// simultaneous: an attack that was in range in the snapshot fires this tick
// even if separation nudges a body afterwards.

import { clampToArena, edgeDistance, isMinionOrder, supportOf, type MinionOrder, type Point } from '@pixel-clash/shared';
import { isSupportable, needsHealing } from './effects.js';
import type { SimUnit } from './types.js';

export type IdleReason =
  | 'idle' // asked for idle (or returned nothing)
  | 'malformed' // not an object / unknown action / bad fields
  | 'tower-cannot-move' // move from a body that can't move
  | 'wrong-type' // an action this type can't do (attack from a factory, rally/hold from a fighter)
  | 'no-target' // unknown or dead target
  | 'friendly-target' // own or a teammate's unit (no friendly fire)
  | 'cooling-down'
  | 'out-of-range'
  | 'enemy-target' // heal on an enemy (M8.8)
  | 'not-healable' // heal on itself, a wall or a factory
  | 'not-needed' // heal on an ally that is full (or out of heal room) and neither burning nor frozen
  | 'heals-off' // heal from sudden death on (§5.5)
  | 'disabled'; // the acting unit is disabled or dead

export type ResolvedAction =
  | { kind: 'idle'; reason: IdleReason }
  | { kind: 'move'; destination: Point }
  | { kind: 'attack'; targetId: string }
  | { kind: 'heal'; targetId: string; power: number }
  | { kind: 'rally'; destination: Point }
  | { kind: 'command'; order: MinionOrder; targetId: string | null; destination: Point | null }
  | { kind: 'release' }
  | { kind: 'hold' };

const idle = (reason: IdleReason): ResolvedAction => ({ kind: 'idle', reason });

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** M8.8 options of `resolveAction`. */
export interface ResolveOptions {
  /** Sudden death has started: heals do nothing (§5.5). */
  healsOff?: boolean;
}

/**
 * Turn a raw sandbox action into a legal engine action.
 * `lookup` returns the unit with that instanceId (alive or not), if any.
 * Move destinations are clamped to the S×S arena (default 800).
 */
export function resolveAction(
  raw: unknown,
  actor: SimUnit,
  lookup: (instanceId: string) => SimUnit | undefined,
  rangeTolerance: number,
  arena?: number,
  opts: ResolveOptions = {},
): ResolvedAction {
  if (!actor.alive || actor.disabled) return idle('disabled');
  if (raw === undefined || raw === null) return idle('idle');
  if (!isRecord(raw)) return idle('malformed');

  switch (raw['action']) {
    case 'idle':
      return idle('idle');

    case 'move': {
      if (actor.type !== 'soldier' && actor.type !== 'minion') return idle('tower-cannot-move');
      const dest = raw['destination'];
      if (!isRecord(dest) || !finite(dest['x']) || !finite(dest['y'])) return idle('malformed');
      return { kind: 'move', destination: clampToArena({ x: dest['x'], y: dest['y'] }, arena) };
    }

    case 'rally': {
      if (actor.type !== 'factory') return idle('wrong-type');
      const dest = raw['destination'];
      if (!isRecord(dest) || !finite(dest['x']) || !finite(dest['y'])) return idle('malformed');
      return { kind: 'rally', destination: clampToArena({ x: dest['x'], y: dest['y'] }, arena) };
    }

    case 'hold':
      return actor.type === 'factory' ? { kind: 'hold' } : idle('wrong-type');

    case 'release':
      return actor.type === 'factory' ? { kind: 'release' } : idle('wrong-type');

    case 'command': {
      if (actor.type !== 'factory') return idle('wrong-type');
      const order = raw['order'];
      if (!isMinionOrder(order)) return idle('malformed');
      const targetId = raw['targetId'];
      if ((order === 'swarm' || order === 'guard') && typeof targetId !== 'string') return idle('malformed');
      let destination: Point | null = null;
      const dest = raw['destination'];
      if (order === 'attack' && dest !== undefined) {
        if (!isRecord(dest) || !finite(dest['x']) || !finite(dest['y'])) return idle('malformed');
        destination = clampToArena({ x: dest['x'], y: dest['y'] }, arena);
      }
      return { kind: 'command', order, targetId: order === 'swarm' || order === 'guard' ? (targetId as string) : null, destination };
    }

    case 'attack': {
      if (actor.type === 'factory' || actor.type === 'wall') return idle('wrong-type');
      const targetId = raw['targetId'];
      if (typeof targetId !== 'string') return idle('malformed');
      const target = lookup(targetId);
      if (!target || !target.alive) return idle('no-target');
      // Same side = friend: own units, and in team mode every teammate's (§9.2).
      if (target.playerId === actor.playerId || target.teamId === actor.teamId) return idle('friendly-target');
      if (actor.cooldownRemaining > 0) return idle('cooling-down');
      // Edge to edge with 0.5 px float tolerance (§5 rule 4).
      if (edgeDistance(actor, target) > actor.stats.range + rangeTolerance) return idle('out-of-range');
      return { kind: 'attack', targetId };
    }

    case 'heal': {
      // M8.8 (§5 rule 4): heal support only; the attack path with the side flipped.
      if (actor.type === 'factory' || actor.type === 'wall') return idle('wrong-type');
      const support = supportOf(actor.stats);
      if (!support || support.kind !== 'heal') return idle('wrong-type');
      const targetId = raw['targetId'];
      if (typeof targetId !== 'string') return idle('malformed');
      const target = lookup(targetId);
      if (!target || !target.alive) return idle('no-target');
      if (target.teamId !== actor.teamId) return idle('enemy-target');
      if (target === actor || !isSupportable(target)) return idle('not-healable');
      if (opts.healsOff) return idle('heals-off');
      if (actor.cooldownRemaining > 0) return idle('cooling-down');
      if (edgeDistance(actor, target) > support.range + rangeTolerance) return idle('out-of-range');
      if (!needsHealing(target)) return idle('not-needed');
      return { kind: 'heal', targetId, power: support.power };
    }

    default:
      return idle('malformed');
  }
}
