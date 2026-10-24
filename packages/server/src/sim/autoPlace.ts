// Auto-place (plan §9): at lock (START or Force start) a player with zero
// placements gets a layout so nobody has an empty corner:
//   1. "Copy last layout" if it is still valid (only available/valid types,
//      ≤ maxTypes types, ≤ maxCopies, distinct legal cells) and within budget;
//   2. otherwise the available types are placed greedily, cheapest first,
//      round-robin across types, into the front cells (nearest the arena
//      centre first: on a zone centred on the centre line that is the
//      middle of the front row, cols 2, 3, 1, 4, 0, 5) until nothing else
//      fits the budget.
// Zone-local cells mean the same on every map (§9.2: row 0 = the front row),
// so a last layout stays valid when the zone rotates or the map changes
// (it is copied cell for cell; on a zone centred on the centre line col 0 is
// the edge rather than the centre-most column).
//
// M8.5 (§9 Auto-place, §5.2): walls are never auto-placed, factories are
// placed after the other types (≤ maxFactoryCopies), and the type caps are
// per group (≤ maxUnitTypes soldiers, ≤ maxBuildingTypes buildings).
// `maxCopies` counts fighters; walls in a reused last layout count against
// `maxWallCopies`.

import { GRID_SIZE, groupOf, isValidCell, type Cell, type Facing, type PlacementDTO, type UnitType } from '@pixel-clash/shared';
import { compareIds } from './types.js';

export interface AutoPlaceUnit {
  unitId: string;
  /** Current rounded cost. */
  cost: number;
  /** The design's type (default 'soldier'). */
  type?: UnitType;
  /** M8.8 (§5.2 Fighters): can win a battle; default: anything but a wall (a damage-0 unit or a medic factory is not). */
  fighter?: boolean;
}

export interface AutoPlaceCaps {
  budget: number;
  /** Fighter copies (soldiers + towers + factories). */
  maxCopies: number;
  /** Legacy: a cap on types in total (before M8.5). */
  maxTypes?: number;
  maxUnitTypes?: number;
  maxBuildingTypes?: number;
  maxFactoryCopies?: number;
  maxWallCopies?: number;
}

/** Whether a set of types fits the type caps (total and per group). */
function typesFit(types: ReadonlyArray<UnitType | undefined>, caps: AutoPlaceCaps): boolean {
  if (caps.maxTypes !== undefined && types.length > caps.maxTypes) return false;
  const units = types.filter((t) => groupOf(t ?? 'soldier') === 'unit').length;
  if (caps.maxUnitTypes !== undefined && units > caps.maxUnitTypes) return false;
  if (caps.maxBuildingTypes !== undefined && types.length - units > caps.maxBuildingTypes) return false;
  return true;
}

export interface AutoPlaceInput {
  /** The player's locked selection: valid designs only (invalid ones already dropped). */
  available: readonly AutoPlaceUnit[];
  /** The player's previous round layout, if any. */
  lastLayout?: readonly PlacementDTO[] | null;
  caps: AutoPlaceCaps;
  /** The zone's facing this round (§9.2); default 'diag' (Corners/Duel). */
  facing?: Facing;
  /** The zone is centred on the arena's centre line (`zoneCentredOnLine`): its col 0 is an edge cell. */
  centred?: boolean;
  /**
   * Placements the player already made that have no fighter (walls only,
   * §9 Auto-place M8.5): they stay, and fighters are added in the free cells
   * within the remaining budget. If no fighter fits, the walls are dropped and
   * the layout is built from scratch.
   */
  existing?: readonly PlacementDTO[];
}

export interface AutoPlaceResult {
  placements: PlacementDTO[];
  source: 'last-layout' | 'greedy' | 'fill' | 'empty';
  spent: number;
}

/**
 * All zone-local cells, front first. Diagonal zones (Corners, Duel, the
 * Ring 8 / Islands 8 corners): by distance band from the centre-most cell
 * (row + col), then nearer the zone's diagonal, then by row. Zones facing
 * N/S/E/W (§9.2): the front row first (lowest row, then lowest col, which is
 * the col nearest the centre). On a N/S/E/W zone `centred` on the centre line
 * col 0 is an edge, so each row goes from the middle out: 2, 3, 1, 4, 0, 5.
 */
export function frontCells(facing: Facing = 'diag', centred = false): Cell[] {
  const cells: Cell[] = [];
  for (let row = 0; row < GRID_SIZE; row++) for (let col = 0; col < GRID_SIZE; col++) cells.push({ col, row });
  if (facing !== 'diag') {
    if (!centred) return cells; // already row-major: row, then col
    const mid = (GRID_SIZE - 1) / 2;
    return cells.sort((a, b) => a.row - b.row || Math.abs(a.col - mid) - Math.abs(b.col - mid) || a.col - b.col);
  }
  return cells.sort(
    (a, b) => a.row + a.col - (b.row + b.col) || Math.abs(a.row - a.col) - Math.abs(b.row - b.col) || a.row - b.row,
  );
}

/** Total cost of a layout, or null if it references an unavailable unit. */
function layoutCost(layout: readonly PlacementDTO[], costs: ReadonlyMap<string, number>): number | null {
  let total = 0;
  for (const p of layout) {
    const c = costs.get(p.unitId);
    if (c === undefined) return null;
    total += c;
  }
  return total;
}

/** Whether a previous layout can be reused as-is this round. */
export function isLayoutUsable(
  layout: readonly PlacementDTO[],
  available: readonly AutoPlaceUnit[],
  caps: AutoPlaceCaps,
): boolean {
  if (layout.length === 0) return false;
  const costs = new Map(available.map((u) => [u.unitId, u.cost]));
  const typeOf = new Map(available.map((u) => [u.unitId, u.type ?? 'soldier']));
  const cost = layoutCost(layout, costs);
  if (cost === null || cost > caps.budget) return false;
  const kinds = layout.map((p) => typeOf.get(p.unitId) ?? 'soldier');
  const walls = kinds.filter((t) => t === 'wall').length;
  const factories = kinds.filter((t) => t === 'factory').length;
  if (layout.length - walls > caps.maxCopies) return false;
  if (walls > (caps.maxWallCopies ?? Infinity)) return false;
  if (factories > (caps.maxFactoryCopies ?? Infinity)) return false;
  // A layout of walls only (M8.8: or only pure support) has no fighter: not usable (§5.2 Fighters).
  const fighter = new Map(available.map((u) => [u.unitId, u.fighter ?? (u.type ?? 'soldier') !== 'wall']));
  if (walls === layout.length || !layout.some((p) => fighter.get(p.unitId))) return false;
  const used = [...new Set(layout.map((p) => p.unitId))].map((id) => typeOf.get(id));
  if (!typesFit(used, caps)) return false;
  const cells = new Set<string>();
  for (const p of layout) {
    if (!isValidCell(p.col, p.row)) return false;
    const key = `${p.col},${p.row}`;
    if (cells.has(key)) return false;
    cells.add(key);
  }
  return true;
}

export function autoPlace(input: AutoPlaceInput): AutoPlaceResult {
  const { available, caps } = input;
  if (input.existing && input.existing.length > 0) {
    const costs = new Map(available.map((u) => [u.unitId, u.cost]));
    const kept = input.existing.filter((p) => costs.has(p.unitId) && isValidCell(p.col, p.row));
    const keptCost = layoutCost(kept, costs) ?? 0;
    const taken = new Set(kept.map((p) => `${p.col},${p.row}`));
    const res = greedy(input, keptCost, taken);
    if (res.placements.length > 0) {
      const placements = [...kept.map((p) => ({ unitId: p.unitId, col: p.col, row: p.row })), ...res.placements];
      return { placements, source: 'fill', spent: keptCost + res.spent };
    }
    // No fighter fits next to the walls: start over without them.
    return autoPlace({ ...input, existing: [] });
  }
  const last = input.lastLayout;
  if (last && isLayoutUsable(last, available, caps)) {
    const placements = last.map((p) => ({ unitId: p.unitId, col: p.col, row: p.row }));
    const costs = new Map(available.map((u) => [u.unitId, u.cost]));
    return { placements, source: 'last-layout', spent: layoutCost(placements, costs) ?? 0 };
  }

  const res = greedy(input, 0, new Set());
  return { placements: res.placements, source: res.placements.length > 0 ? 'greedy' : 'empty', spent: res.spent };
}

/**
 * Greedy fill: cheapest first (ties by unitId), never walls, factories last,
 * within the type caps, into the free front cells (`taken` cells skipped),
 * starting from `alreadySpent` of the budget.
 */
function greedy(input: AutoPlaceInput, alreadySpent: number, taken: ReadonlySet<string>): { placements: PlacementDTO[]; spent: number } {
  const { available, caps } = input;
  const sorted = [...new Map(available.map((u) => [u.unitId, u])).values()]
    .filter((u) => u.type !== 'wall')
    .sort((a, b) => Number(a.type === 'factory') - Number(b.type === 'factory') || a.cost - b.cost || compareIds(a.unitId, b.unitId));
  const types: AutoPlaceUnit[] = [];
  for (const u of sorted) if (typesFit([...types, u].map((t) => t.type), caps)) types.push(u);
  const cells = frontCells(input.facing, input.centred).filter((c) => !taken.has(`${c.col},${c.row}`));
  const placements: PlacementDTO[] = [];
  let spent = 0;
  let factories = 0;
  let placedSomething = true;
  while (placedSomething && placements.length < Math.min(caps.maxCopies, cells.length)) {
    placedSomething = false;
    for (const t of types) {
      if (placements.length >= Math.min(caps.maxCopies, cells.length)) break;
      if (alreadySpent + spent + t.cost > caps.budget) continue;
      if (t.type === 'factory' && factories >= (caps.maxFactoryCopies ?? Infinity)) continue;
      const cell = cells[placements.length]!;
      placements.push({ unitId: t.unitId, col: cell.col, row: cell.row });
      spent += t.cost;
      if (t.type === 'factory') factories++;
      placedSomething = true;
    }
  }
  return { placements, spent };
}
