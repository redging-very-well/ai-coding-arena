// Fighters, living value and value destroyed per body type (plan §9.3).
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

import type { BodyType, FrameDTO } from '@pixel-clash/shared';
import type { SimUnit, UnitReport } from './types.js';

/** Whether a living body keeps its side in the battle. */
export function isFighter(u: Pick<SimUnit, 'type' | 'factory'>): boolean {
  if (u.type === 'wall') return false;
  if (u.type === 'factory') return (u.factory?.canMake ?? 0) > 0;
  return true;
}

/** Living value of a body as it stands now (0 for walls). */
export function livingValueOf(u: Pick<SimUnit, 'type' | 'cost' | 'factory'>): number {
  if (u.type === 'wall') return 0;
  if (u.type === 'factory' && u.factory) return u.factory.bodyCost + u.factory.minionValue * u.factory.canMake;
  return u.cost;
}

/** What killing this body credits (§9.3 Value destroyed). */
export function killValueOf(u: Pick<SimUnit, 'type' | 'cost' | 'factory'>): number {
  return u.type === 'wall' ? u.cost : livingValueOf(u);
}

// ---------------------------------------------------------------------------
// The same rules from a finished result + a recorded frame (Skip, §9 Skip)
// ---------------------------------------------------------------------------

type ReportLike = Pick<UnitReport, 'instanceId' | 'playerId' | 'cost' | 'diedAtTick'> &
  Partial<Pick<UnitReport, 'type' | 'factory' | 'spawnedAtTick'>>;

/** canMake per living factory in a frame (`fac`, §9.3 Frames; minionsLeft in frames recorded before it). */
export function factoryLeftIn(frame: Pick<FrameDTO, 'fac'>): Map<string, number> {
  return new Map((frame.fac ?? []).map((f) => [f[0], f[6] ?? f[2]]));
}

/**
 * Whether a body was alive in the frame at time `t`. Walls are listed only
 * when their hp changed (§9.3 Frames), so for them it follows from their
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
  if (t === 'wall') return false;
  if (t === 'factory') return (left.get(u.instanceId) ?? 0) > 0;
  return true;
}
