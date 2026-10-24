// Buildings in routing (redesign 2026-10-24, plan §9.3 Routing round walls
// and buildings): towers and factories never move and stand on their cell
// centre, one per cell, so the router keeps them in a cell grid like the
// walls. Unlike walls they are circles: line-of-sight checks use their real
// radius inflated by the moving body's radius, so a gap between two
// buildings is used only when the body fits through it.

import { CELL_SIZE, type Point } from '@pixel-clash/shared';
import type { SimUnit } from './types.js';

/** A building is a tower or a factory (walls have their own grid). */
export function isRoutingBuilding(u: Pick<SimUnit, 'type'>): boolean {
  return u.type === 'tower' || u.type === 'factory';
}

export class BuildingGrid {
  /** Cells per side (S / 40). */
  readonly cols: number;
  private readonly cells: Array<SimUnit | undefined>;
  /** The living buildings, in the order they were added (instanceId order in the engine). */
  private readonly list: SimUnit[] = [];
  private changes = 0;

  constructor(readonly arena: number) {
    this.cols = Math.ceil(arena / CELL_SIZE);
    this.cells = new Array<SimUnit | undefined>(this.cols * this.cols).fill(undefined);
  }

  /** Goes up by 1 whenever a building is added or removed (routing caches key on it). */
  get version(): number {
    return this.changes;
  }

  get size(): number {
    return this.list.length;
  }

  private index(b: Point): number {
    const col = Math.floor(b.x / CELL_SIZE);
    const row = Math.floor(b.y / CELL_SIZE);
    if (col < 0 || row < 0 || col >= this.cols || row >= this.cols) return -1;
    return row * this.cols + col;
  }

  add(b: SimUnit): void {
    const i = this.index(b);
    if (i < 0) throw new Error(`building ${b.id} is outside the arena`);
    if (this.cells[i] === b) return;
    if (this.cells[i]) this.remove(this.cells[i]!);
    this.cells[i] = b;
    this.list.push(b);
    this.changes++;
  }

  remove(b: SimUnit): void {
    const i = this.index(b);
    if (i < 0 || this.cells[i] !== b) return;
    this.cells[i] = undefined;
    this.list.splice(this.list.indexOf(b), 1);
    this.changes++;
  }

  /** Whether a cell holds a living building (cells outside the arena count as free). */
  has(col: number, row: number): boolean {
    if (col < 0 || row < 0 || col >= this.cols || row >= this.cols) return false;
    return this.cells[row * this.cols + col] !== undefined;
  }

  /**
   * Whether a body of clearance radius `r` can move in a straight line from
   * `p` to `q` without entering a building's circle inflated by `r`. A
   * building that holds `q` (the destination is that building) is skipped; a
   * body already inside an inflated circle is stopped by it only when the
   * move goes deeper in.
   */
  segmentClear(p: Point, q: Point, r: number): boolean {
    if (this.list.length === 0) return true;
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return true;
    const minX = Math.min(p.x, q.x);
    const maxX = Math.max(p.x, q.x);
    const minY = Math.min(p.y, q.y);
    const maxY = Math.max(p.y, q.y);
    for (const b of this.list) {
      const R = b.radius + r;
      if (b.x + R < minX || b.x - R > maxX || b.y + R < minY || b.y - R > maxY) continue;
      // The destination is this building (chasing a tower): it is the target, not an obstacle.
      if (Math.hypot(q.x - b.x, q.y - b.y) < b.radius + 0.5) continue;
      const ex = b.x - p.x;
      const ey = b.y - p.y;
      const inside = ex * ex + ey * ey < R * R;
      if (inside) {
        // Already touching it: only a move that goes deeper counts.
        if (ex * dx + ey * dy > 1e-9) return false;
        continue;
      }
      // Closest point of the segment to the centre.
      let t = (ex * dx + ey * dy) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = p.x + dx * t - b.x;
      const cy = p.y + dy * t - b.y;
      if (cx * cx + cy * cy < R * R) return false;
    }
    return true;
  }
}
