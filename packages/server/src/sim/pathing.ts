// Routing round walls (M8.7): soldiers and
// minions walk round walls when an open way exists. Player code is unchanged
// (`move` + destination); the engine plans a waypoint and the wall steering
// (sim/steering.ts) moves the body toward it. Deterministic, no PRNG.
//
//   * Grid: the 40 px arena cells. Walls block cells. Buildings (towers and
//     factories, which never move and sit on cell centres) are solid too
//     (redesign 2026-10-24): a building's cell is never entered on the way
//     (only as the destination), diagonals never cut past one, and every
//     line-of-sight check sees its real circle inflated by the moving body's
//     radius, so a gap between two buildings is used only when the body fits.
//     Buildings are never "the wall to break": when buildings close every
//     open way, the body follows the walls-only field instead (it walks up to
//     them; an enemy building in the way is then hit by normal targeting, and
//     separation slides it round its own).
//   * Size classes: radius ≤ 18 routes on cell nodes (one-cell gaps fit),
//     19-20 on 2×2 nodes at cell corners (needs a two-cell gap). 8 neighbours,
//     a diagonal only when both orthogonal neighbours are open.
//   * Flow fields: Dijkstra from the destination node, integer costs 10 / 14,
//     entering a wall node (not the destination) +WALL_STEP, so a walled-off
//     destination still leads to the cheapest wall to break. Shared by every
//     body with the same (size class, destination node), cached in an LRU and
//     rebuilt when the wall grid's version changed. The cache never changes
//     results: a field is a pure function of (walls, key).
//   * Plans: direct when the straight segment is clear; else follow the field
//     downhill for up to LOOKAHEAD nodes and steer to the furthest one in
//     sight (path smoothing). No route: walk to the wall to break and press on
//     it. Re-plan on reaching the waypoint, else at most every `replanTicks`.
//   * Blocked: a tick counts only when a wall stopped the body (pressing on
//     its no-route wall, or < 25% of its step made).

import { CELL_SIZE, type Point } from '@pixel-clash/shared';
import { markBlocked, segmentClear, steerStep, type SteerResult } from './steering.js';
import { distanceToWall, type WallGrid } from './walls.js';
import { BuildingGrid } from './buildings.js';
import type { PathingMode, RoutePlan, SimUnit } from './types.js';

/** Bodies up to this radius fit a one-cell gap. */
export const ONE_CELL_MAX_RADIUS = 18;
/** Extra cost of entering a wall node: more than any open route on a 30×30 grid. */
export const WALL_STEP = 100_000;
/** Field nodes followed ahead for path smoothing. */
export const LOOKAHEAD = 8;
/** Clearance added to the radius for line-of-sight checks (px). */
export const CLEARANCE = 0.5;
/** Flow fields kept (LRU). */
export const PATH_CACHE_SIZE = 64;
/** A wall hit that left less than this share of the step counts as blocked. */
export const PROGRESS_SHARE = 0.25;

const STRAIGHT = 10;
const DIAGONAL = 14;
const UNREACHED = 0x7fffffff;
/** Heap keys are distance × KEY + node index (node index < 900 < KEY). */
const KEY = 4096;
// Neighbour order: N, E, S, W, NE, SE, SW, NW (ties keep the first).
const DC = [0, 1, 0, -1, 1, 1, -1, -1] as const;
const DR = [-1, 0, 1, 0, -1, 1, 1, -1] as const;

/** The size class of a body: 1 = cell nodes, 2 = 2×2 nodes. */
export function sizeClassOf(radius: number): 1 | 2 {
  return radius <= ONE_CELL_MAX_RADIUS ? 1 : 2;
}

interface Field {
  version: number;
  dist: Int32Array;
}

interface Layer {
  version: number;
  /** Nodes per side. */
  n: number;
  /** 1 = the node holds a wall. */
  blocked: Uint8Array;
  /** 1 = the node holds a building (tower or factory): never entered on the way, never cut past diagonally. */
  solid: Uint8Array;
  /** Whether `solid` is in use (the walls-only layer leaves it all 0). */
  withBuildings: boolean;
}

/** A small deterministic string hash (staggers the first re-plan by instanceId). */
function hashId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class Pathfinder {
  /** Fields built and cache hits (tests and diagnostics). */
  readonly stats = { built: 0, hits: 0, plans: 0 };
  private readonly cache = new Map<number, Field>();
  private readonly layers = new Map<number, Layer>();
  private readonly heap: number[] = [];
  /** Towers and factories (redesign: solid for routing). Empty when none are given. */
  private readonly buildings: BuildingGrid;

  constructor(
    private readonly grid: WallGrid,
    private readonly arena: number,
    private readonly center: Point,
    private readonly opts: { replanTicks: number; slideMemoryTicks: number; cacheSize?: number; buildings?: BuildingGrid },
  ) {
    this.buildings = opts.buildings ?? new BuildingGrid(arena);
  }

  /** Walls and buildings together: a field or layer stamped with an older version is stale. */
  private get version(): number {
    return this.grid.version + this.buildings.version;
  }

  /**
   * Move a soldier or minion toward `dest` for this tick (engine step 4):
   * plan (or keep) a route, steer to its waypoint, and update `pathing`,
   * `blockedBy` and `blockedTicks`.
   */
  move(u: SimUnit, dest: Point, speed: number, tick: number): SteerResult {
    let plan = u.route ?? null;
    const reached = plan?.waypoint ? Math.hypot(plan.waypoint.x - u.x, plan.waypoint.y - u.y) <= Math.max(speed, 0.5) : false;
    if (!plan || tick >= plan.nextPlan || reached) {
      const first = !plan;
      plan = this.plan(u, dest);
      plan.nextPlan = tick + (first ? 1 + (hashId(u.id) % this.opts.replanTicks) : this.opts.replanTicks);
      u.route = plan;
    }
    u.pathing = plan.mode;

    // No route: press on the wall to break once touching it (don't slide along the ring).
    if (plan.press >= 0) {
      const wall = this.touchingWall(u, plan.press);
      if (wall) {
        markBlocked(u, wall.id);
        return { moved: false, blocked: true };
      }
    }

    const s = steerStep(u, plan.waypoint ?? dest, speed, this.grid, this.arena, this.center, this.opts.slideMemoryTicks);
    if (s.wall && s.step > 1e-6 && s.progress < PROGRESS_SHARE * s.step) {
      markBlocked(u, s.wall.id);
      return { moved: s.moved, blocked: true };
    }
    u.blockedBy = null;
    u.blockedTicks = 0;
    return { moved: s.moved, blocked: false };
  }

  /** A route plan for `u` toward `dest`; nextPlan is set by the caller. */
  plan(u: Pick<SimUnit, 'x' | 'y' | 'radius'>, dest: Point): RoutePlan {
    this.stats.plans++;
    const direct: RoutePlan = { mode: 'direct', waypoint: null, press: -1, nextPlan: 0 };
    if (this.grid.size === 0 && this.buildings.size === 0) return direct;
    const k = sizeClassOf(u.radius);
    const r = u.radius + CLEARANCE;
    const n = this.grid.cols - k + 1;
    const n0 = this.nodeOf(u, k, n);
    const goal = this.nodeOf(dest, k, n);
    if (n0 === goal || this.clear(u, dest, r, true)) return direct;

    // Walls and buildings first; when buildings close every open way, the
    // walls-only field (buildings are never the wall to break).
    let withBuildings = this.buildings.size > 0;
    let layer = this.layer(k, withBuildings);
    let field = this.field(k, goal, withBuildings);
    if (withBuildings && field.dist[n0]! >= WALL_STEP) {
      withBuildings = false;
      layer = this.layer(k, false);
      field = this.field(k, goal, false);
    }
    const mode: PathingMode = field.dist[n0]! >= WALL_STEP ? 'no-route' : 'detour';
    // Follow the field downhill.
    const chain: number[] = [n0];
    let cur = n0;
    for (let i = 0; i < LOOKAHEAD && cur !== goal; i++) {
      const next = this.downhill(cur, field.dist, layer, goal);
      if (next < 0) break;
      chain.push(next);
      if (layer.blocked[next]) break; // a wall node (to break) or the destination wall
      cur = next;
    }
    const next = chain[1];
    if (next === undefined) return direct;
    if (layer.blocked[next]) {
      // The destination is that wall (smash it): straight at it. Else it is the wall to break.
      if (next === goal) return direct;
      return { mode, waypoint: this.nodePos(next, k, layer.n), press: next, nextPlan: 0 };
    }
    // Path smoothing: the furthest open node in sight.
    let best = 1;
    for (let i = 2; i < chain.length; i++) {
      const node = chain[i]!;
      if (layer.blocked[node] || !this.clear(u, this.nodePos(node, k, layer.n), r, withBuildings)) break;
      best = i;
    }
    return { mode, waypoint: this.nodePos(chain[best]!, k, layer.n), press: -1, nextPlan: 0 };
  }

  /**
   * Line of sight for a body of clearance radius `r` from `p` to `q`: no wall
   * square and (with `withBuildings`) no building circle in the way, each
   * inflated by `r` (a building that is the destination itself is skipped).
   */
  private clear(p: Point, q: Point, r: number, withBuildings: boolean): boolean {
    if (!segmentClear(p, q, r, this.grid)) return false;
    return !withBuildings || this.buildings.segmentClear(p, q, r);
  }

  /** The flow field toward `goal` for size class `k` (cached). */
  field(k: 1 | 2, goal: number, withBuildings = this.buildings.size > 0): Field {
    const key = (withBuildings ? 4 : 0) * KEY * KEY + k * KEY * KEY + goal;
    const version = this.version;
    const hit = this.cache.get(key);
    if (hit && hit.version === version) {
      this.stats.hits++;
      // Most recently used goes last.
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const field: Field = { version, dist: this.dijkstra(k, goal, withBuildings) };
    this.stats.built++;
    this.cache.delete(key);
    this.cache.set(key, field);
    const cap = this.opts.cacheSize ?? PATH_CACHE_SIZE;
    while (this.cache.size > cap) this.cache.delete(this.cache.keys().next().value!);
    return field;
  }

  /** The node of a point: its cell (class 1) or the nearest cell corner (class 2). */
  nodeOf(p: Point, k: 1 | 2, n = this.grid.cols - k + 1): number {
    const f = (v: number) => {
      const i = k === 1 ? Math.floor(v / CELL_SIZE) : Math.round(v / CELL_SIZE) - 1;
      return Math.min(n - 1, Math.max(0, i));
    };
    return f(p.y) * n + f(p.x);
  }

  /** A node's position: the cell centre (class 1) or the cell corner (class 2). */
  nodePos(i: number, k: 1 | 2, n = this.grid.cols - k + 1): Point {
    const c = i % n;
    const r = (i - c) / n;
    return { x: (c + k / 2) * CELL_SIZE, y: (r + k / 2) * CELL_SIZE };
  }

  /** Which nodes hold a wall (and, with buildings, a building), for size class `k` at the current version. */
  private layer(k: 1 | 2, withBuildings = this.buildings.size > 0): Layer {
    const version = this.version;
    const id = k + (withBuildings ? 4 : 0);
    const old = this.layers.get(id);
    if (old && old.version === version) return old;
    const cols = this.grid.cols;
    const n = cols - k + 1;
    const blocked = old && old.n === n ? old.blocked : new Uint8Array(n * n);
    const solid = old && old.n === n ? old.solid : new Uint8Array(n * n);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        let b = 0;
        let s = 0;
        for (let dr = 0; dr < k; dr++) {
          for (let dc = 0; dc < k; dc++) {
            if (this.grid.has(c + dc, r + dr)) b = 1;
            else if (withBuildings && this.buildings.has(c + dc, r + dr)) s = 1;
          }
        }
        blocked[r * n + c] = b;
        solid[r * n + c] = b ? 0 : s;
      }
    }
    const layer = { version, n, blocked, solid, withBuildings };
    this.layers.set(id, layer);
    return layer;
  }

  /** Whether the step from node (c, r) by direction d is legal (in the grid; diagonals need both orthogonals open). */
  private legal(c: number, r: number, d: number, layer: Layer): boolean {
    const n = layer.n;
    const c2 = c + DC[d]!;
    const r2 = r + DR[d]!;
    if (c2 < 0 || r2 < 0 || c2 >= n || r2 >= n) return false;
    if (d < 4) return true;
    const a = r * n + c2;
    const b = r2 * n + c;
    return !layer.blocked[a] && !layer.blocked[b] && !layer.solid[a] && !layer.solid[b];
  }

  /** The next node downhill from `cur` (lowest distance + step cost; -1 when none). */
  private downhill(cur: number, dist: Int32Array, layer: Layer, goal: number): number {
    const n = layer.n;
    const c = cur % n;
    const r = (cur - c) / n;
    let best = -1;
    let bestCost = Infinity;
    for (let d = 0; d < 8; d++) {
      if (!this.legal(c, r, d, layer)) continue;
      const b = (r + DR[d]!) * n + c + DC[d]!;
      const db = dist[b]!;
      if (db === UNREACHED) continue;
      // A building's node is only ever the destination (never a node on the way).
      if (layer.solid[b] && b !== goal) continue;
      const cost = db + (d < 4 ? STRAIGHT : DIAGONAL) + (layer.blocked[b] && b !== goal ? WALL_STEP : 0);
      if (cost < bestCost) {
        bestCost = cost;
        best = b;
      }
    }
    return best;
  }

  /** Dijkstra from `goal` over the class-k nodes. */
  private dijkstra(k: 1 | 2, goal: number, withBuildings: boolean): Int32Array {
    const layer = this.layer(k, withBuildings);
    const n = layer.n;
    const dist = new Int32Array(n * n).fill(UNREACHED);
    const heap = this.heap;
    heap.length = 0;
    dist[goal] = 0;
    heapPush(heap, goal);
    while (heap.length > 0) {
      const key = heapPop(heap);
      const b = key % KEY;
      const db = (key - b) / KEY;
      if (db > dist[b]!) continue;
      // Moving a → b costs the step plus WALL_STEP when b is a wall (not the goal).
      const pen = layer.blocked[b] && b !== goal ? WALL_STEP : 0;
      const c = b % n;
      const r = (b - c) / n;
      for (let d = 0; d < 8; d++) {
        if (!this.legal(c, r, d, layer)) continue;
        const a = (r + DR[d]!) * n + c + DC[d]!;
        const da = db + (d < 4 ? STRAIGHT : DIAGONAL) + pen;
        if (da < dist[a]!) {
          dist[a] = da;
          // A building's node gets a distance (a body standing in its cell
          // can leave it) but the field never runs on through it.
          if (!layer.solid[a]) heapPush(heap, da * KEY + a);
        }
      }
    }
    return dist;
  }

  /** A wall of the press node's block that the body touches (nearest first, ties lower id), else undefined. */
  private touchingWall(u: SimUnit, node: number): SimUnit | undefined {
    const k = sizeClassOf(u.radius);
    const n = this.grid.cols - k + 1;
    const c = node % n;
    const r = (node - c) / n;
    let best: SimUnit | undefined;
    let bestD = Infinity;
    for (let dr = 0; dr < k; dr++) {
      for (let dc = 0; dc < k; dc++) {
        const w = this.grid.at(c + dc, r + dr);
        if (!w) continue;
        const d = distanceToWall(u, w);
        if (d > u.radius + CLEARANCE) continue;
        if (d < bestD || (d === bestD && best && w.id < best.id)) {
          bestD = d;
          best = w;
        }
      }
    }
    return best;
  }
}

function heapPush(h: number[], v: number): void {
  let i = h.length;
  h.push(v);
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (h[p]! <= v) break;
    h[i] = h[p]!;
    i = p;
  }
  h[i] = v;
}

function heapPop(h: number[]): number {
  const top = h[0]!;
  const last = h.pop()!;
  if (h.length > 0) {
    let i = 0;
    const len = h.length;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= len) break;
      const rr = l + 1;
      const m = rr < len && h[rr]! < h[l]! ? rr : l;
      if (h[m]! >= last) break;
      h[i] = h[m]!;
      i = m;
    }
    h[i] = last;
  }
  return top;
}
