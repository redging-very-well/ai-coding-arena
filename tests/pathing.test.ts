// Routing round walls (SelfView.pathing, M8.7): flow fields, size classes, path smoothing, re-planning when a wall
// dies, the cheapest wall to break when there is no route, shared fields,
// minions with every order, and determinism.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  deepMerge,
  type FrameDTO,
  type GameConfig,
  type MinionOrder,
  type OtherView,
  type PlacementDTO,
  type SelfView,
} from '@pixel-clash/shared';
import { BattleEngine, type SimUnit } from '../packages/server/src/sim/engine.js';
import { Pathfinder, WALL_STEP, sizeClassOf } from '../packages/server/src/sim/pathing.js';
import { WallGrid, distanceToWall, pushOutOfWalls } from '../packages/server/src/sim/walls.js';
import { BuildingGrid } from '../packages/server/src/sim/buildings.js';
import { clampBody } from '../packages/server/src/sim/movement.js';
import { SOLDIER, design, fakePlayers, idleBrain, scripted, stats, type FakePlayerSpec } from './helpers/fakeRunner.js';

// ---------------------------------------------------------------------------
// Unit level: a Pathfinder on a bare wall grid
// ---------------------------------------------------------------------------

const ARENA = 800;
const CENTER = { x: 400, y: 400 };

function body(over: Partial<SimUnit> = {}): SimUnit {
  return {
    id: '0-0-0', playerId: 'a', seat: 0, teamId: 0, unitId: 's', stats: SOLDIER, cost: 92, type: 'soldier', radius: 10,
    x: 100, y: 100, hp: 120, maxHp: 120, cooldownRemaining: 0, alive: true, disabled: false, spawned: true,
    movedSinceFrame: false, firedSinceFrame: false, facingLeft: false, outsideSafeZone: false,
    damageDealt: 0, kills: 0, valueDestroyed: 0, strikes: 0, errors: [], diedAtTick: null,
    blockedBy: null, blockedTicks: 0, slide: null,
    ...over,
  };
}

function wallAt(col: number, row: number): SimUnit {
  return body({
    id: `w-${String(row).padStart(2, '0')}-${String(col).padStart(2, '0')}`,
    playerId: 'b', teamId: 1, seat: 1, type: 'wall', stats: stats({ type: 'wall' }), radius: 20,
    x: col * 40 + 20, y: row * 40 + 20, hp: 400, maxHp: 400, cost: 32,
  });
}

function world(cells: Array<[number, number]>, replanTicks = DEFAULT_CONFIG.sim.replanTicks) {
  const grid = new WallGrid(ARENA);
  const walls = cells.map(([c, r]) => wallAt(c, r));
  for (const w of walls) grid.add(w);
  const paths = new Pathfinder(grid, ARENA, CENTER, { replanTicks, slideMemoryTicks: DEFAULT_CONFIG.sim.slideMemoryTicks });
  return { grid, walls, paths };
}

type PathingMode = SelfView['pathing'];
interface Step { x: number; y: number; mode: PathingMode; blockedTicks: number }

/** Move like engine step 4 (routing + steering) and step 5 (wall push), recording the path. */
function walk(
  u: SimUnit,
  dest: { x: number; y: number },
  w: ReturnType<typeof world>,
  ticks: number,
  onTick?: (t: number) => void,
) {
  const path: Step[] = [];
  let maxPenetration = 0;
  let arrivedAt = -1;
  for (let t = 0; t < ticks; t++) {
    onTick?.(t);
    w.paths.move(u, dest, u.stats.speed, t);
    for (const wall of w.walls) if (wall.alive) maxPenetration = Math.max(maxPenetration, u.radius - distanceToWall(u, wall));
    if (pushOutOfWalls(u, w.grid)) clampBody(u, ARENA);
    path.push({ x: u.x, y: u.y, mode: u.pathing!, blockedTicks: u.blockedTicks ?? 0 });
    if (arrivedAt < 0 && Math.hypot(u.x - dest.x, u.y - dest.y) < 1e-6) arrivedAt = t;
  }
  return { path, maxPenetration, arrivedAt };
}

const row = (r: number, from: number, to: number, skip: number[] = []): Array<[number, number]> =>
  Array.from({ length: to - from + 1 }, (_, i) => [from + i, r] as [number, number]).filter(([c]) => !skip.includes(c));
const col = (c: number, from: number, to: number): Array<[number, number]> => Array.from({ length: to - from + 1 }, (_, i) => [c, from + i] as [number, number]);

describe('flow fields', () => {
  it('size classes: radius ≤ 18 routes on cells, 19-20 on 2×2 nodes', () => {
    expect([6, 10, 18].map(sizeClassOf)).toEqual([1, 1, 1]);
    expect([18.5, 19, 20].map(sizeClassOf)).toEqual([2, 2, 2]);
  });

  it('distances: 10 straight, 14 diagonal; a wall node costs WALL_STEP to enter; the goal wall itself does not', () => {
    const { paths } = world([[10, 5]]);
    const f = paths.field(1, paths.nodeOf({ x: 420, y: 420 }, 1)).dist;
    const at = (c: number, r: number) => f[r * 20 + c]!;
    expect(at(10, 10)).toBe(0);
    expect(at(11, 10)).toBe(10);
    expect(at(11, 11)).toBe(14);
    // Entering the wall node (10, 5) costs WALL_STEP; its own distance is the way on from it.
    expect(at(10, 5)).toBe(5 * 10);
    expect(at(10, 4)).toBeLessThan(WALL_STEP); // round it
    expect(at(10, 4)).toBeGreaterThan(6 * 10);
    // The destination is the wall itself: no penalty to reach it.
    const g = paths.field(1, paths.nodeOf({ x: 420, y: 220 }, 1)).dist;
    expect(g[6 * 20 + 10]).toBe(10);
    expect(g[5 * 20 + 10]).toBe(0);
  });

  it('never cuts a wall corner diagonally', () => {
    // (5,4) and (4,5) are walls: (4,4) → (5,5) can't squeeze between their corners.
    const { paths } = world([[5, 4], [4, 5]]);
    const f = paths.field(1, paths.nodeOf({ x: 220, y: 220 }, 1)).dist;
    expect(f[4 * 20 + 4]).toBeGreaterThan(14);
    expect(f[4 * 20 + 4]).toBeLessThan(WALL_STEP);
  });

  it('2×2 nodes: a one-cell gap is closed for size 19-20, a two-cell gap is open', () => {
    const one = world(row(10, 0, 19, [9]));
    const big = one.paths.field(2, one.paths.nodeOf({ x: 400, y: 600 }, 2)).dist;
    expect(big[one.paths.nodeOf({ x: 400, y: 200 }, 2)]!).toBeGreaterThanOrEqual(WALL_STEP);
    const small = one.paths.field(1, one.paths.nodeOf({ x: 400, y: 600 }, 1)).dist;
    expect(small[one.paths.nodeOf({ x: 400, y: 200 }, 1)]!).toBeLessThan(WALL_STEP);
    const two = world(row(10, 0, 19, [9, 10]));
    const open = two.paths.field(2, two.paths.nodeOf({ x: 400, y: 600 }, 2)).dist;
    expect(open[two.paths.nodeOf({ x: 400, y: 200 }, 2)]!).toBeLessThan(WALL_STEP);
  });

  it('fields are cached per destination cell and rebuilt when a wall dies', () => {
    const w = world([[10, 10], [11, 10]]);
    const goal = w.paths.nodeOf({ x: 430, y: 500 }, 1);
    const a = w.paths.field(1, goal);
    expect(w.paths.field(1, goal)).toBe(a);
    expect(w.paths.stats).toMatchObject({ built: 1, hits: 1 });
    w.grid.remove(w.walls[0]!);
    const b = w.paths.field(1, goal);
    expect(b).not.toBe(a);
    expect(w.paths.stats.built).toBe(2);
    // A cache of 2 evicts the least recently used field, and a rebuilt field is identical.
    const small = new Pathfinder(w.grid, ARENA, CENTER, { replanTicks: 10, slideMemoryTicks: 45, cacheSize: 2 });
    const f1 = small.field(1, 1);
    small.field(1, 2);
    small.field(1, 3);
    const again = small.field(1, 1);
    expect(again).not.toBe(f1);
    expect([...again.dist]).toEqual([...f1.dist]);
  });
});

describe('routing round walls', () => {
  it('corner trap: an L between the unit and its destination: it walks round, never piling into the corner', () => {
    // The L's inside corner faces the unit (walls along col 12 rows 6-10 and row 10 cols 7-12).
    const w = world([...col(12, 6, 10), ...row(10, 7, 11)]);
    const u = body({ x: 300, y: 260 });
    const dest = { x: 560, y: 520 };
    const { path, arrivedAt, maxPenetration } = walk(u, dest, w, 600);
    expect(maxPenetration).toBeLessThanOrEqual(0.01);
    expect(arrivedAt).toBeGreaterThan(0);
    // Straight-line distance ~364 px at 1.5 px/tick is 243 ticks; the way round is a bit longer.
    expect(arrivedAt).toBeLessThan(400);
    expect(path.some((p) => p.mode === 'detour')).toBe(true);
    expect(Math.max(...path.map((p) => p.blockedTicks))).toBeLessThan(10);
  });

  it('U opening away from the target: the unit walks out of the cup and round', () => {
    // Cup: cols 8 and 12 (rows 7-11) and the bottom row 11; open to the north.
    const w = world([...col(8, 7, 10), ...col(12, 7, 10), ...row(11, 8, 12)]);
    const u = body({ x: 420, y: 340 }); // inside the cup
    const dest = { x: 420, y: 640 }; // straight below the bottom
    const { path, arrivedAt, maxPenetration } = walk(u, dest, w, 900);
    expect(maxPenetration).toBeLessThanOrEqual(0.01);
    expect(arrivedAt).toBeGreaterThan(0);
    expect(arrivedAt).toBeLessThan(500);
    // It left through the opening (above row 7) before going down the side.
    expect(Math.min(...path.map((p) => p.y))).toBeLessThan(7 * 40);
    expect(Math.max(...path.map((p) => p.blockedTicks))).toBeLessThan(10);
  });

  it('a one-cell gap lets size 10 through; size 20 takes the long way round', () => {
    // Row 10 from col 0 to col 17 with a gate at col 9; cols 18-19 are a two-cell way round.
    const cells = row(10, 0, 17, [9]);
    const small = world(cells);
    const s = body({ x: 300, y: 300 });
    const through = walk(s, { x: 300, y: 600 }, small, 600);
    expect(through.arrivedAt).toBeGreaterThan(0);
    const crossing = through.path.find((p) => p.y > 400)!;
    expect(crossing.x).toBeGreaterThan(9 * 40);
    expect(crossing.x).toBeLessThan(10 * 40);

    const big = world(cells);
    const b = body({ x: 300, y: 300, radius: 20, stats: stats({ type: 'soldier', size: 20 }) });
    const round = walk(b, { x: 300, y: 600 }, big, 1200);
    expect(round.maxPenetration).toBeLessThanOrEqual(0.01);
    expect(round.arrivedAt).toBeGreaterThan(0);
    const bigCrossing = round.path.find((p) => p.y > 400)!;
    expect(bigCrossing.x).toBeGreaterThan(18 * 40);
    expect(round.path.every((p) => p.mode !== 'no-route')).toBe(true);
  });

  it('size 20 with the long way sealed: no route, it presses on a wall of the row (to smash it)', () => {
    const w = world(row(10, 0, 19, [9]));
    const b = body({ x: 300, y: 300, radius: 20, stats: stats({ type: 'soldier', size: 20 }) });
    const { path, maxPenetration } = walk(b, { x: 300, y: 600 }, w, 400);
    expect(maxPenetration).toBeLessThanOrEqual(0.01);
    expect(path.at(-1)!.mode).toBe('no-route');
    expect(b.blockedTicks).toBeGreaterThan(120);
    expect(b.blockedBy).toMatch(/^w-10-/);
    // It stands still against that wall, not sliding along the row.
    const tail = path.slice(-100);
    expect(Math.max(...tail.map((p) => p.x)) - Math.min(...tail.map((p) => p.x))).toBeLessThan(0.01);
  });

  it('a wall destroyed mid-route: the unit takes the new shorter way within replanTicks', () => {
    // Row 10 from col 0 to col 17: the way round is at the far right. Wall (2,10) dies at tick 60.
    const w = world(row(10, 0, 17));
    const u = body({ x: 100, y: 300 });
    const dest = { x: 100, y: 600 };
    let xAtBreak = 0;
    const { path, arrivedAt } = walk(u, dest, w, 900, (t) => {
      if (t === 60) {
        const gone = w.walls.find((x) => x.id === 'w-10-02')!;
        gone.alive = false;
        w.grid.remove(gone);
        xAtBreak = u.x;
      }
    });
    expect(xAtBreak).toBeGreaterThan(150); // it had started the long way right
    expect(arrivedAt).toBeGreaterThan(0);
    // It came back and crossed row 10 through the fresh gap.
    const crossing = path.find((p) => p.y > 420)!;
    expect(crossing.x).toBeGreaterThan(80);
    expect(crossing.x).toBeLessThan(120);
    // It turned round within replanTicks (+1) of the break.
    const turned = path.findIndex((p, i) => i > 60 && p.x < path[i - 1]!.x - 0.5);
    expect(turned).toBeGreaterThan(60);
    expect(turned).toBeLessThanOrEqual(60 + DEFAULT_CONFIG.sim.replanTicks + 1);
  });

  it('a destination inside a sealed ring: the unit goes to the ring wall on the cheapest way in and presses on it', () => {
    // Ring round cell (10, 10); the unit is far to the west.
    const ring: Array<[number, number]> = [[9, 9], [10, 9], [11, 9], [9, 10], [11, 10], [9, 11], [10, 11], [11, 11]];
    const w = world(ring);
    const u = body({ x: 100, y: 420 });
    const { path } = walk(u, { x: 420, y: 420 }, w, 400);
    expect(path.at(-1)!.mode).toBe('no-route');
    // The west wall (9, 10): one wall to break, the shortest way. Not a corner wall it bumped into.
    expect(u.blockedBy).toBe('w-10-09');
    expect(u.blockedTicks).toBeGreaterThan(100);
  });

  it('is deterministic: the same inputs give the same path', () => {
    const run = () => walk(body({ x: 300, y: 260 }), { x: 560, y: 520 }, world([...col(12, 6, 10), ...row(10, 7, 11)]), 400).path;
    expect(run()).toEqual(run());
  });
});

// ---------------------------------------------------------------------------
// Buildings in routing (redesign 2026-10-24): towers and factories are solid
// ---------------------------------------------------------------------------

function towerAt(col: number, row: number, radius = 14, type: 'tower' | 'factory' = 'tower', team = 1): SimUnit {
  return body({
    id: `t-${String(row).padStart(2, '0')}-${String(col).padStart(2, '0')}`,
    playerId: team === 0 ? 'a' : 'b', teamId: team, seat: team, type, stats: stats({ type, size: radius }), radius,
    x: col * 40 + 20, y: row * 40 + 20, hp: 600, maxHp: 600, cost: 500,
  });
}

function bworld(walls: Array<[number, number]>, towers: SimUnit[]) {
  const grid = new WallGrid(ARENA);
  const ws = walls.map(([c, r]) => wallAt(c, r));
  for (const w of ws) grid.add(w);
  const buildings = new BuildingGrid(ARENA);
  for (const t of towers) buildings.add(t);
  const paths = new Pathfinder(grid, ARENA, CENTER, { replanTicks: DEFAULT_CONFIG.sim.replanTicks, slideMemoryTicks: DEFAULT_CONFIG.sim.slideMemoryTicks, buildings });
  return { grid, walls: ws, paths, buildings, towers };
}

/** Like `walk`, plus the deepest overlap with any building circle (the routing must keep clear of them). */
function bwalk(u: SimUnit, dest: { x: number; y: number }, w: ReturnType<typeof bworld>, ticks: number, onTick?: (t: number) => void) {
  const path: Step[] = [];
  let overlap = 0;
  let arrivedAt = -1;
  for (let t = 0; t < ticks; t++) {
    onTick?.(t);
    w.paths.move(u, dest, u.stats.speed, t);
    if (pushOutOfWalls(u, w.grid)) clampBody(u, ARENA);
    for (const b of w.towers) if (b.alive) overlap = Math.max(overlap, u.radius + b.radius - Math.hypot(u.x - b.x, u.y - b.y));
    path.push({ x: u.x, y: u.y, mode: u.pathing!, blockedTicks: u.blockedTicks ?? 0 });
    if (arrivedAt < 0 && Math.hypot(u.x - dest.x, u.y - dest.y) < 1e-6) arrivedAt = t;
  }
  return { path, overlap, arrivedAt };
}

describe('routing round towers and factories (redesign: buildings are solid)', () => {
  it('a unit behind a single tower walks round it instead of pushing into it', () => {
    const w = bworld([], [towerAt(10, 10, 20)]);
    const u = body({ x: 420, y: 300 });
    const { path, overlap, arrivedAt } = bwalk(u, { x: 420, y: 560 }, w, 400);
    expect(arrivedAt).toBeGreaterThan(0);
    expect(overlap).toBeLessThanOrEqual(0.01);
    expect(path.some((p) => p.mode === 'detour')).toBe(true);
    expect(path.every((p) => p.mode !== 'no-route')).toBe(true);
  });

  it('a line of towers with gaps too small: it routes the long way round the line', () => {
    // Size-18 towers in row 10, cols 3-16: neighbours leave 4 px gaps.
    const towers = Array.from({ length: 14 }, (_, i) => towerAt(3 + i, 10, 18));
    const w = bworld([], towers);
    const u = body({ x: 420, y: 300 });
    const { path, overlap, arrivedAt } = bwalk(u, { x: 420, y: 560 }, w, 900);
    expect(arrivedAt).toBeGreaterThan(0);
    expect(overlap).toBeLessThanOrEqual(0.01);
    const crossing = path.find((p) => p.y > 420)!;
    expect(crossing.x < 3 * 40 || crossing.x > 17 * 40).toBe(true);
  });

  it('a gap big enough between two towers: it walks straight through', () => {
    // Size-6 towers at cols 10 and 11 leave 28 px: a size-10 body (20 px) fits; the line round is long.
    const towers = [...Array.from({ length: 7 }, (_, i) => towerAt(3 + i, 10, 20)), towerAt(10, 10, 6), towerAt(11, 10, 6), ...Array.from({ length: 6 }, (_, i) => towerAt(12 + i, 10, 20))];
    const w = bworld([], towers);
    const u = body({ x: 440, y: 300 });
    const { path, overlap, arrivedAt } = bwalk(u, { x: 440, y: 560 }, w, 400);
    expect(arrivedAt).toBeGreaterThan(0);
    expect(arrivedAt).toBeLessThan(200); // 260 px at 1.5 px/tick: straight through
    expect(overlap).toBeLessThanOrEqual(0.01);
    expect(path.every((p) => p.mode === 'direct')).toBe(true);
    // A size-16 body (32 px) doesn't fit the 28 px gap: it goes round.
    const big = body({ x: 440, y: 300, radius: 16, stats: stats({ type: 'soldier', size: 16 }) });
    const round = bwalk(big, { x: 440, y: 560 }, bworld([], towers.map((t) => ({ ...t }))), 900);
    expect(round.overlap).toBeLessThanOrEqual(0.01);
    expect(round.arrivedAt).toBeGreaterThan(200);
  });

  it('a tower in the line dies: the unit takes the new shorter way within replanTicks', () => {
    const towers = Array.from({ length: 16 }, (_, i) => towerAt(2 + i, 10, 18));
    const w = bworld([], towers);
    const u = body({ x: 100, y: 300 });
    const { path, arrivedAt } = bwalk(u, { x: 100, y: 600 }, w, 900, (t) => {
      if (t === 40) {
        const gone = towers[0]!; // (2, 10)
        gone.alive = false;
        w.buildings.remove(gone);
      }
    });
    expect(arrivedAt).toBeGreaterThan(0);
    const crossing = path.find((p) => p.y > 420)!;
    expect(crossing.x).toBeLessThan(3 * 40);
    expect(arrivedAt).toBeLessThan(400);
  });

  it('buildings never trap: boxed in by own buildings it still heads for the destination (never no-route)', () => {
    // A ring of factories round cell (10, 10), the unit inside.
    const ring: Array<[number, number]> = [[9, 9], [10, 9], [11, 9], [9, 10], [11, 10], [9, 11], [10, 11], [11, 11]];
    const w = bworld([], ring.map(([c, r]) => towerAt(c, r, 18, 'factory', 0)));
    const u = body({ x: 420, y: 420 });
    const { path } = bwalk(u, { x: 420, y: 700 }, w, 60);
    expect(path.every((p) => p.mode !== 'no-route')).toBe(true);
    expect(u.blockedTicks ?? 0).toBe(0);
    expect(path.at(-1)!.y).toBeGreaterThan(420); // it pressed toward the gap (separation slides it out in battle)
  });

  it('chasing a tower: the tower itself is the destination, not an obstacle', () => {
    const w = bworld([], [towerAt(10, 10, 14)]);
    const plan = w.paths.plan({ x: 420, y: 200, radius: 10 }, { x: 420, y: 420 });
    expect(plan.mode).toBe('direct');
  });

  it('buildings are solid only between walls too: a wall line with a tower in its gap is no-route for walls, but the tower is never the wall to break', () => {
    const w = bworld(row(10, 0, 19, [9]), [towerAt(9, 10, 14)]);
    const u = body({ x: 300, y: 300 });
    const { path } = bwalk(u, { x: 300, y: 600 }, w, 300);
    // The only open way is the tower's cell: it heads there (walls-only field), never presses on a wall.
    expect(path.every((p) => p.mode !== 'no-route')).toBe(true);
    // (no separation here: it walks into the tower's cell, the gate, and on; in battle separation slides it round)
    const crossing = path.find((p) => p.y > 410)!;
    expect(Math.abs(crossing.x - 380)).toBeLessThan(20);
  });

  it('is deterministic with buildings', () => {
    const run = () => bwalk(body({ x: 420, y: 300 }), { x: 420, y: 560 }, bworld([], Array.from({ length: 14 }, (_, i) => towerAt(3 + i, 10, 18))), 400).path;
    expect(run()).toEqual(run());
  });
});

// ---------------------------------------------------------------------------
// Engine level
// ---------------------------------------------------------------------------

const WALL = stats({ type: 'wall' });
const at = (c: number, r: number, unitId: string): PlacementDTO => ({ unitId, col: c, row: r });
const cfg = (patch: unknown = {}, ticks = 5400): GameConfig => deepMerge(DEFAULT_CONFIG, { ...(patch as object), timers: { battleTicks: ticks } });
const noSD = { suddenDeath: { damagePctPerSecond: 0 } };
const allEvents = (frames: FrameDTO[]) => frames.flatMap((f) => f.events.map((e) => ({ t: f.t, e })));
const gap = (a: { x: number; y: number; radius: number }, b: { x: number; y: number; radius: number }) => Math.hypot(b.x - a.x, b.y - a.y) - a.radius - b.radius;

/** basic_soldier.js: smash an enemy wall that stopped it for 120 ticks, else chase the nearest non-wall enemy. */
const templateSoldier = (seen?: Array<{ t: number; pathing: SelfView['pathing'] }>) =>
  scripted((self, enemies: OtherView[], _a, w) => {
    seen?.push({ t: w.tick, pathing: self.pathing });
    const hit = (e: OtherView) =>
      gap(self, e) <= self.range ? (self.cooldownRemaining === 0 ? { action: 'attack', targetId: e.id } : { action: 'idle' }) : { action: 'move', destination: { x: e.x, y: e.y } };
    if (self.blockedTicks >= 120) {
      const wall = enemies.find((e) => e.id === self.blockedBy);
      if (wall) return hit(wall);
    }
    let target: OtherView | null = null;
    for (const e of enemies) if (e.type !== 'wall' && (!target || gap(self, e) < gap(self, target))) target = e;
    return target ? hit(target) : { action: 'idle' };
  });

function engineOf(specs: FakePlayerSpec[], config: GameConfig, seed = 5) {
  const { setups } = fakePlayers(specs);
  return new BattleEngine({ players: setups, config, seed });
}

// BR zone (Corners 800): zone-local (c, r) is arena cell (14 + c, 14 + r).
// An L whose inside corner faces the north-west (the way attackers come from
// TL): col 17 rows 14-16 and row 16 cols 14-16. The tower sits behind it at
// arena cell (18, 17).
const L_WALLS = [at(3, 0, 'w'), at(3, 1, 'w'), at(3, 2, 'w'), at(0, 2, 'w'), at(1, 2, 'w'), at(2, 2, 'w')];
const TARGET = stats({ type: 'tower', damage: 5, maxHealth: 1000 });

describe('routing in battle', () => {
  it('corner trap: soldiers route round an L, kill the tower behind it and never smash a wall', async () => {
    const seen: Array<{ t: number; pathing: SelfView['pathing'] }> = [];
    const engine = engineOf(
      [
        { playerId: 'a', seat: 0, zone: 'TL', units: [design('s', SOLDIER)], placements: [at(0, 0, 's')], brains: { s: templateSoldier(seen) } },
        { playerId: 'b', seat: 1, zone: 'BR', units: [design('w', WALL), design('t', TARGET)], placements: [...L_WALLS, at(4, 3, 't')], brains: { t: idleBrain } },
      ],
      cfg(noSD, 2400),
    );
    const result = await engine.run();
    expect(result.endReason).toBe('elimination');
    const soldier = result.units.find((u) => u.instanceId === '0-0-0')!;
    expect(soldier.kills).toBe(1);
    expect(soldier.blockedTicksMax ?? 0).toBeLessThan(120);
    const wallIds = new Set(result.units.filter((u) => u.type === 'wall').map((u) => u.instanceId));
    expect(allEvents(engine.frames).some((x) => x.e.type === 'hit' && wallIds.has((x.e as { targetId: string }).targetId))).toBe(false);
    expect(seen.some((s) => s.pathing === 'detour')).toBe(true);
    expect(seen[0]!.pathing).toBe('direct'); // before the first move
  });

  it('a target inside a sealed ring: the soldier smashes the ring wall on the cheapest way in, then kills the target', async () => {
    // Ring round BR local (2, 2): the attacker comes from the north-west.
    const ring: PlacementDTO[] = [];
    for (const [c, r] of [[1, 1], [2, 1], [3, 1], [1, 2], [3, 2], [1, 3], [2, 3], [3, 3]] as const) ring.push(at(c, r, 'w'));
    const seen: Array<{ t: number; pathing: SelfView['pathing'] }> = [];
    const strong = stats({ type: 'soldier', damage: 300, attackCooldown: 10, speed: 3, maxHealth: 2500 });
    const engine = engineOf(
      [
        { playerId: 'a', seat: 0, zone: 'TL', units: [design('s', strong)], placements: [at(0, 0, 's')], brains: { s: templateSoldier(seen) } },
        { playerId: 'b', seat: 1, zone: 'BR', units: [design('w', WALL), design('t', TARGET)], placements: [...ring, at(2, 2, 't')], brains: { t: idleBrain } },
      ],
      cfg(noSD, 3000),
    );
    const result = await engine.run();
    expect(result.endReason).toBe('elimination');
    expect(seen.some((s) => s.pathing === 'no-route')).toBe(true);
    // The first wall it hit is an edge-middle wall (one wall between it and the
    // tower), not a ring corner: (2,1) north or (1,2) west, ids `${seat}-${row}-${col}`.
    const firstHit = allEvents(engine.frames).find((x) => x.e.type === 'hit' && x.e.instanceId === '0-0-0')!;
    expect(['1-1-2', '1-2-1']).toContain((firstHit.e as { targetId: string }).targetId);
    // Exactly one wall broken (the rest crumbled at the elimination): it walked through the hole it made.
    const wallIds = new Set(result.units.filter((u) => u.type === 'wall').map((u) => u.instanceId));
    const hitWalls = new Set(allEvents(engine.frames).flatMap((x) => (x.e.type === 'hit' && wallIds.has(x.e.targetId) ? [x.e.targetId] : [])));
    expect(hitWalls.size).toBe(1);
  });

  it('buildings in battle: soldiers behind their own tower line and minions from behind a tower row reach the enemy, never stuck', async () => {
    // TL zone: a row of own size-20 towers on row 1 (cols 0-5, solid), soldiers and a factory behind it on row 2-3.
    const wallTower = stats({ type: 'tower', size: 20, damage: 0, maxHealth: 2500 });
    const fac = stats({ type: 'factory', maxHealth: 375, productionInterval: 600 });
    const towers = [0, 1, 2, 3, 4, 5].map((c) => at(c, 1, 'tw'));
    const engine = engineOf(
      [
        {
          playerId: 'a', seat: 0, zone: 'TL',
          units: [design('s', SOLDIER), design('tw', wallTower), design('f', fac)],
          placements: [...towers, at(0, 2, 's'), at(2, 2, 's'), at(4, 3, 'f')],
          brains: { s: templateSoldier(), tw: idleBrain, f: idleBrain },
        },
        { playerId: 'b', seat: 1, zone: 'BR', units: [design('t', TARGET)], placements: [at(0, 0, 't')], brains: { t: idleBrain } },
      ],
      cfg(noSD, 3600),
    );
    const result = await engine.run();
    const soldiers = result.units.filter((u) => u.unitId === 's' && u.type !== 'minion' && u.playerId === 'a');
    expect(soldiers.reduce((n, u) => n + u.damageDealt, 0)).toBeGreaterThan(0);
    expect(result.units.find((u) => u.instanceId.startsWith('1-'))!.survived).toBe(false);
  });

  it('many soldiers chasing one target share one flow field (cache hits)', async () => {
    const twelve: PlacementDTO[] = [];
    for (let i = 0; i < 12; i++) twelve.push(at(i % 6, Math.floor(i / 6), 's'));
    const engine = engineOf(
      [
        { playerId: 'a', seat: 0, zone: 'TL', units: [design('s', SOLDIER)], placements: twelve, brains: { s: templateSoldier() } },
        { playerId: 'b', seat: 1, zone: 'BR', units: [design('w', WALL), design('t', stats({ type: 'tower', damage: 5, maxHealth: 2500 }))], placements: [...L_WALLS, at(4, 3, 't')], brains: { t: idleBrain } },
      ],
      cfg(noSD, 600),
    );
    await engine.run();
    const { built, hits } = engine.pathStats;
    // One destination cell (the tower), no wall died: one field for everyone.
    expect(built).toBe(1);
    expect(hits).toBeGreaterThan(11);
  });

  it('minions route round walls with every order (attack, defend, swarm, guard)', async () => {
    // A's factory sits at TL local (1, 1) = arena (180, 180). A's own L (arena
    // col 3 rows 1-3, row 3 cols 1-2) closes the north-west pocket on the east
    // and south; B's soldier walks into the pocket to (100, 100) and waits:
    // 113 px from the factory, behind the L. Minions leave on the factory's
    // south-east side and must go round through the gaps at (3, 0) or (0, 3).
    const ownL = [at(2, 4, 'w'), at(2, 3, 'w'), at(2, 2, 'w'), at(4, 2, 'w'), at(3, 2, 'w')];
    const hide = { x: 100, y: 100 };
    for (const order of ['attack', 'defend', 'swarm', 'guard'] as MinionOrder[]) {
      const factory = scripted((self, enemies) => {
        const intruder = enemies.find((e) => e.type === 'soldier');
        if (order === 'attack') return { action: 'rally', destination: hide };
        if (order === 'defend') return { action: 'command', order: 'defend' };
        if (order === 'guard') return { action: 'command', order: 'guard', targetId: self.id };
        return intruder ? { action: 'command', order: 'swarm', targetId: intruder.id } : { action: 'idle' };
      });
      const config = cfg(noSD, 2000);
      const engine = engineOf(
        [
          { playerId: 'a', seat: 0, zone: 'TL', units: [design('f', stats({ type: 'factory', productionInterval: 600 }), undefined, config), design('w', WALL)], placements: [at(1, 1, 'f'), ...ownL], brains: { f: factory } },
          {
            playerId: 'b', seat: 1, zone: 'BR', units: [design('s', stats({ type: 'soldier', maxHealth: 2500 })), design('t', stats({ type: 'tower', damage: 5 }))], placements: [at(0, 0, 's'), at(5, 5, 't')],
            brains: { s: scripted(() => ({ action: 'move', destination: hide })), t: idleBrain },
          },
        ],
        config,
      );
      const result = await engine.run();
      const hits = allEvents(engine.frames).filter((x) => x.e.type === 'hit' && x.e.instanceId.includes('-m') && (x.e as { targetId: string }).targetId === '1-0-0');
      expect(hits.length, order).toBeGreaterThan(0);
      // No wall was hit, and the intruder really sat in the pocket.
      const wallIds = new Set(result.units.filter((u) => u.type === 'wall').map((u) => u.instanceId));
      expect(allEvents(engine.frames).some((x) => x.e.type === 'hit' && wallIds.has((x.e as { targetId: string }).targetId)), order).toBe(false);
      const last = engine.frames.find((f) => f.t >= 600)!.units.find((u) => u[0] === '1-0-0')!;
      expect(Math.hypot(last[1] - hide.x, last[2] - hide.y), order).toBeLessThan(5);
    }
  });

  it('determinism: the same seed twice and shuffled placements give identical frames', async () => {
    const make = (shuffle: boolean) => {
      const config = cfg({}, 1500);
      const aPl = [at(0, 0, 's'), at(1, 0, 's'), at(0, 1, 's'), at(2, 2, 'f')];
      const bPl = [...L_WALLS, at(4, 3, 't'), at(5, 5, 's')];
      return engineOf(
        [
          { playerId: 'a', seat: 0, zone: 'TL', units: [design('s', SOLDIER), design('f', stats({ type: 'factory', productionInterval: 600 }), undefined, config)], placements: shuffle ? [...aPl].reverse() : aPl, brains: { s: templateSoldier(), f: scripted(() => ({ action: 'rally', destination: { x: 740, y: 700 } })) } },
          { playerId: 'b', seat: 1, zone: 'BR', units: [design('w', WALL), design('t', TARGET), design('s', SOLDIER)], placements: shuffle ? [...bPl].reverse() : bPl, brains: { t: idleBrain, s: templateSoldier() } },
        ],
        config,
        11,
      );
    };
    const a = make(false);
    const b = make(false);
    const c = make(true);
    await Promise.all([a.run(), b.run(), c.run()]);
    expect(a.frames.length).toBeGreaterThan(10);
    expect(JSON.stringify(b.frames)).toBe(JSON.stringify(a.frames));
    expect(JSON.stringify(c.frames)).toBe(JSON.stringify(a.frames));
  });
});
