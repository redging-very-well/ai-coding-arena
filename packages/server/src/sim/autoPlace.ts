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

import { GRID_SIZE, isValidCell, type Cell, type Facing, type PlacementDTO } from '@pixel-clash/shared';
import { compareIds } from './types.js';

export interface AutoPlaceUnit {
  unitId: string;
  /** Current rounded cost. */
  cost: number;
}

export interface AutoPlaceCaps {
  budget: number;
  maxCopies: number;
  maxTypes: number;
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
}

export interface AutoPlaceResult {
  placements: PlacementDTO[];
  source: 'last-layout' | 'greedy' | 'empty';
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
  if (layout.length === 0 || layout.length > caps.maxCopies) return false;
  const costs = new Map(available.map((u) => [u.unitId, u.cost]));
  const cost = layoutCost(layout, costs);
  if (cost === null || cost > caps.budget) return false;
  if (new Set(layout.map((p) => p.unitId)).size > caps.maxTypes) return false;
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
  const last = input.lastLayout;
  if (last && isLayoutUsable(last, available, caps)) {
    const placements = last.map((p) => ({ unitId: p.unitId, col: p.col, row: p.row }));
    const costs = new Map(available.map((u) => [u.unitId, u.cost]));
    return { placements, source: 'last-layout', spent: layoutCost(placements, costs) ?? 0 };
  }

  // Greedy: cheapest first (ties by unitId), at most maxTypes types.
  const types = [...new Map(available.map((u) => [u.unitId, u])).values()]
    .sort((a, b) => a.cost - b.cost || compareIds(a.unitId, b.unitId))
    .slice(0, caps.maxTypes);
  const cells = frontCells(input.facing, input.centred);
  const placements: PlacementDTO[] = [];
  let spent = 0;
  let placedSomething = true;
  while (placedSomething && placements.length < Math.min(caps.maxCopies, cells.length)) {
    placedSomething = false;
    for (const t of types) {
      if (placements.length >= Math.min(caps.maxCopies, cells.length)) break;
      if (spent + t.cost > caps.budget) continue;
      const cell = cells[placements.length]!;
      placements.push({ unitId: t.unitId, col: cell.col, row: cell.row });
      spent += t.cost;
      placedSomething = true;
    }
  }
  return { placements, source: placements.length > 0 ? 'greedy' : 'empty', spent };
}
