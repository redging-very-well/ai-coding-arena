// Fighters, living value and value destroyed per body type.
//
//   * Fighters: soldiers, towers, minions, and factories that can still make
//     a minion before time runs out (`canMake` > 0, sim/factory.ts
//     `canMakeOf`). Walls never are. A side without fighters is eliminated.
//   * Living value (timeout ranking, army bars, Iron Wall): soldier/tower =
//     unit cost; wall = $0; factory = body cost + minionValue × canMake (so
//     just the body at the time limit, and a holding factory loses value as
//     time runs out); minion = minionValue.
//   * Value destroyed (credited to the killer): a wall its full price, a
//     factory its living value at death, everything else its cost.
//   * M8.6: minions stored inside a factory count like the ones it can
//     still make: they keep it a fighter and add minionValue each to its
//     living value (so the killer of a full factory is credited them too).
//   * M8.8: a soldier or tower with damage 0 (pure support), a
//     medic minion and a factory that makes medics are NOT fighters; they
//     still count their living value while alive.

import type { BodyType, FrameDTO } from '@pixel-clash/shared';
import type { SimUnit, UnitReport } from './types.js';

/** Whether a body can ever fight (M8.8): not a wall, a damage-0 unit, a medic minion or a medic factory. */
export function canFight(u: Pick<SimUnit, 'type' | 'factory' | 'minion'> & { stats?: { damage: number } }): boolean {
  if (u.type === 'wall') return false;
  if (u.type === 'factory') return (u.factory?.kind ?? 'grunt') !== 'medic';
  if (u.type === 'minion') return (u.minion?.kind ?? 'grunt') !== 'medic';
  return (u.stats?.damage ?? 1) > 0;
}

/** Whether a living body keeps its side in the battle. */
export function isFighter(u: Pick<SimUnit, 'type' | 'factory' | 'minion'> & { stats?: { damage: number } }): boolean {
  if (!canFight(u)) return false;
  if (u.type === 'factory') return (u.factory?.canMake ?? 0) > 0 || (u.factory?.stored ?? 0) > 0;
  return true;
}

/** Living value of a body as it stands now (0 for walls). */
export function livingValueOf(u: Pick<SimUnit, 'type' | 'cost' | 'factory'>): number {
  if (u.type === 'wall') return 0;
  if (u.type === 'factory' && u.factory) return u.factory.bodyCost + u.factory.minionValue * (u.factory.canMake + u.factory.stored);
  return u.cost;
}

/** What killing this body credits. */
export function killValueOf(u: Pick<SimUnit, 'type' | 'cost' | 'factory'>): number {
  return u.type === 'wall' ? u.cost : livingValueOf(u);
}

// ---------------------------------------------------------------------------
// The same rules from a finished result + a recorded frame (Skip)
// ---------------------------------------------------------------------------

type ReportLike = Pick<UnitReport, 'instanceId' | 'playerId' | 'cost' | 'diedAtTick'> &
  Partial<Pick<UnitReport, 'type' | 'factory' | 'spawnedAtTick' | 'nonFighter'>>;

/**
 * The minions each living factory in a frame is worth (`fac`):
 * canMake + stored (minionsLeft in frames recorded before canMake).
 */
export function factoryLeftIn(frame: Pick<FrameDTO, 'fac'>): Map<string, number> {
  return new Map((frame.fac ?? []).map((f) => [f[0], (f[6] ?? f[2]) + (f[7] ?? 0)]));
}

/**
 * Whether a body was alive in the frame at time `t`. Walls are listed only
 * when their hp changed, so for them it follows from their
 * spawn and death times; everything else is alive iff it is listed.
 */
export function aliveInFrame(u: ReportLike, frame: Pick<FrameDTO, 't'>, listed: ReadonlySet<string>): boolean {
  if (listed.has(u.instanceId)) return true;
  if (u.type !== 'wall') return false;
  return (u.spawnedAtTick ?? 0) <= frame.t && (u.diedAtTick === null || u.diedAtTick > frame.t);
}

/** The ids alive in a frame (walls included, see `aliveInFrame`). */
export function aliveIdsInFrame(units: readonly ReportLike[], frame: Pick<FrameDTO, 't' | 'units'>): Set<string> {
  const listed = new Set(frame.units.map((u) => u[0]));
  const out = new Set<string>();
  for (const u of units) if (aliveInFrame(u, frame, listed)) out.add(u.instanceId);
  return out;
}

/** Living value of a reported body at a frame (it must be alive there). */
export function livingValueAt(u: ReportLike, left: ReadonlyMap<string, number>): number {
  if (u.type === 'wall') return 0;
  if (u.type === 'factory' && u.factory) return u.factory.bodyCost + u.factory.minionValue * (left.get(u.instanceId) ?? 0);
  return u.cost;
}

/** Whether a reported body (alive at the frame) was a fighter there. */
export function fighterAt(u: ReportLike, left: ReadonlyMap<string, number>): boolean {
  const t: BodyType | undefined = u.type;
  if (t === 'wall' || u.nonFighter) return false;
  if (t === 'factory') return (left.get(u.instanceId) ?? 0) > 0;
  return true;
}
