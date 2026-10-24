// The army budget (plan §6 Caps and rules): what a set of placements costs.
//
// Redesign (2026-10-24) "copy ramp" (config `caps.copyRamp`, off when
// `pctPerCopy` is 0): from copy `freeCopies + 1` of one design on, every
// further copy of that design costs `pctPerCopy`% more than the price, one
// step more each time (the 5th copy +X%, the 6th +2X%, …). Walls never ramp.
// A layout's cost doesn't depend on placement order.

import type { UnitType } from './contract.js';

export interface CopyRamp {
  /** Copies of one design at the plain price. */
  freeCopies: number;
  /** Extra % per copy beyond them (0 = no ramp). */
  pctPerCopy: number;
}

/** The price of the n-th copy (1-based) of a design that costs `cost`. */
export function copyCost(cost: number, n: number, type: UnitType | undefined, ramp: CopyRamp | undefined): number {
  if (!ramp || ramp.pctPerCopy <= 0 || type === 'wall' || n <= ramp.freeCopies) return cost;
  return Math.ceil(cost * (1 + ((n - ramp.freeCopies) * ramp.pctPerCopy) / 100) - 1e-9);
}

/** What `count` copies of one design cost together. */
export function copiesCost(cost: number, count: number, type: UnitType | undefined, ramp: CopyRamp | undefined): number {
  let sum = 0;
  for (let n = 1; n <= count; n++) sum += copyCost(cost, n, type, ramp);
  return sum;
}

/**
 * Total cost of a layout (unitIds of its placements); null when a unitId has
 * no price. `typeOf` tells walls apart (they never ramp).
 */
export function layoutSpent(
  unitIds: readonly string[],
  costOf: (unitId: string) => number | undefined,
  typeOf: (unitId: string) => UnitType | undefined,
  ramp: CopyRamp | undefined,
): number | null {
  const counts = new Map<string, number>();
  let sum = 0;
  for (const id of unitIds) {
    const c = costOf(id);
    if (c === undefined) return null;
    const n = (counts.get(id) ?? 0) + 1;
    counts.set(id, n);
    sum += copyCost(c, n, typeOf(id), ramp);
  }
  return sum;
}

/** What the next copy of `unitId` would cost on top of `unitIds`. */
export function nextCopyCost(unitIds: readonly string[], unitId: string, cost: number, type: UnitType | undefined, ramp: CopyRamp | undefined): number {
  let n = 1;
  for (const id of unitIds) if (id === unitId) n++;
  return copyCost(cost, n, type, ramp);
}
