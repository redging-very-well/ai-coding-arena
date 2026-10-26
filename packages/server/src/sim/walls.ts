// Wall geometry in the sim: the wall grid and the wall push.
//
// A wall's body is the axis-aligned 40×40 square of its placement cell
// (`[cx − 20, cx + 20] × [cy − 20, cy + 20]`). Zones are cell-aligned, so
// every wall fills exactly one arena cell and the engine can keep them in a
// grid `wallAt[row × cols + col]`: a position looks up only the few cells
// around it. Walls never move, so the grid only changes when a wall dies.

import { CELL_SIZE, WALL_HALF } from '@pixel-clash/shared';
import type { SimUnit } from './types.js';

export class WallGrid {
  /** Cells per side (S / 40). */
  readonly cols: number;
  private readonly cells: Array<SimUnit | undefined>;
  private count = 0;
  private changes = 0;

  constructor(readonly arena: number) {
    this.cols = Math.ceil(arena / CELL_SIZE);
    this.cells = new Array<SimUnit | undefined>(this.cols * this.cols).fill(undefined);
  }

  /** Goes up by 1 whenever a wall is added or removed (routing caches key on it). */
  get version(): number {
    return this.changes;
  }

  /** Number of living walls. */
  get size(): number {
    return this.count;
  }

  private index(col: number, row: number): number {
    return row * this.cols + col;
  }

  /** Cell (col, row) of a wall centre. */
  cellOf(w: { x: number; y: number }): { col: number; row: number } {
    return { col: Math.floor(w.x / CELL_SIZE), row: Math.floor(w.y / CELL_SIZE) };
  }

  add(w: SimUnit): void {
    const { col, row } = this.cellOf(w);
    if (col < 0 || row < 0 || col >= this.cols || row >= this.cols) throw new Error(`wall ${w.id} is outside the arena`);
    if (!this.cells[this.index(col, row)]) this.count++;
    this.cells[this.index(col, row)] = w;
    this.changes++;
  }

  remove(w: SimUnit): void {
    const { col, row } = this.cellOf(w);
    const i = this.index(col, row);
    if (this.cells[i] === w) {
      this.cells[i] = undefined;
      this.count--;
      this.changes++;
    }
  }

  /** Whether a cell holds a living wall (cells outside the arena count as free). */
  has(col: number, row: number): boolean {
    return this.at(col, row) !== undefined;
  }

  /** The living wall in a cell, if any. */
  at(col: number, row: number): SimUnit | undefined {
    if (col < 0 || row < 0 || col >= this.cols || row >= this.cols) return undefined;
    return this.cells[this.index(col, row)];
  }

  /**
   * Walls whose square may touch the rectangle [x0, x1] × [y0, y1], in cell
   * order (row, then col). Appends to `out` and returns it.
   */
  query(x0: number, y0: number, x1: number, y1: number, out: SimUnit[] = []): SimUnit[] {
    if (this.count === 0) return out;
    const c0 = Math.max(0, Math.floor(x0 / CELL_SIZE));
    const c1 = Math.min(this.cols - 1, Math.floor(x1 / CELL_SIZE));
    const r0 = Math.max(0, Math.floor(y0 / CELL_SIZE));
    const r1 = Math.min(this.cols - 1, Math.floor(y1 / CELL_SIZE));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const w = this.cells[this.index(c, r)];
        if (w) out.push(w);
      }
    }
    return out;
  }
}

/** Distance from a point to a wall's square (0 inside). */
export function distanceToWall(p: { x: number; y: number }, w: { x: number; y: number }): number {
  const qx = Math.min(w.x + WALL_HALF, Math.max(w.x - WALL_HALF, p.x));
  const qy = Math.min(w.y + WALL_HALF, Math.max(w.y - WALL_HALF, p.y));
  return Math.hypot(p.x - qx, p.y - qy);
}

/** Whether a circle overlaps a wall's square (touching is not overlapping). */
export function circleOverlapsWall(c: { x: number; y: number }, r: number, w: { x: number; y: number }): boolean {
  return distanceToWall(c, w) < r - 1e-9;
}

const scratch: SimUnit[] = [];

/**
 * Push a moving body out of every wall square it overlaps:
 * along c − q (q = the closest point of the square) by r − |c − q|; a centre
 * inside the square leaves through the nearest face (ties −x, +x, −y, +y).
 * Walls are visited in instanceId order. Returns true if the body moved.
 * The caller clamps the body to the arena afterwards.
 */
export function pushOutOfWalls(u: SimUnit, grid: WallGrid): boolean {
  if (grid.size === 0) return false;
  const r = u.radius;
  scratch.length = 0;
  const near = grid.query(u.x - r - WALL_HALF, u.y - r - WALL_HALF, u.x + r + WALL_HALF, u.y + r + WALL_HALF, scratch);
  if (near.length === 0) return false;
  if (near.length > 1) near.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let moved = false;
  for (const w of near) {
    const minX = w.x - WALL_HALF;
    const maxX = w.x + WALL_HALF;
    const minY = w.y - WALL_HALF;
    const maxY = w.y + WALL_HALF;
    const qx = Math.min(maxX, Math.max(minX, u.x));
    const qy = Math.min(maxY, Math.max(minY, u.y));
    const dx = u.x - qx;
    const dy = u.y - qy;
    const d = Math.hypot(dx, dy);
    if (d >= r) continue;
    if (d > 0) {
      const push = r - d;
      u.x += (dx / d) * push;
      u.y += (dy / d) * push;
    } else {
      // Centre inside the square (or on its edge): leave through the nearest face.
      const faces: Array<[number, 'x' | 'y', number]> = [
        [u.x - minX, 'x', minX - r],
        [maxX - u.x, 'x', maxX + r],
        [u.y - minY, 'y', minY - r],
        [maxY - u.y, 'y', maxY + r],
      ];
      let best = faces[0]!;
      for (const f of faces) if (f[0] < best[0]) best = f;
      if (best[1] === 'x') u.x = best[2];
      else u.y = best[2];
    }
    moved = true;
  }
  return moved;
}
