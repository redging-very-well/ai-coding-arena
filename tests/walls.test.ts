// Walls in the headless sim (plan §5.2, §9.3, M8.5): blocking, the
// deterministic wall slide, gates, the wall push, breaking a wall, towers and
// projectiles vs walls, sudden death, walls running no code, crumbling and
// determinism.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  deepMerge,
  cellCenter,
  FRAME_FLAGS,
  type FrameDTO,
  type GameConfig,
  type PlacementDTO,
  type ZoneRef,
} from '@pixel-clash/shared';
import { BattleEngine, resultAtTick, type SimUnit } from '../packages/server/src/sim/engine.js';
import { steerToward } from '../packages/server/src/sim/steering.js';
import { WallGrid, distanceToWall, pushOutOfWalls } from '../packages/server/src/sim/walls.js';
import { clampBody } from '../packages/server/src/sim/movement.js';
import {
  SOLDIER,
  TOWER,
  design,
  fakePlayers,
  idleBrain,
  scripted,
  soldierBrain,
  stats,
  towerBrain,
  type FakePlayerSpec,
} from './helpers/fakeRunner.js';

// ---------------------------------------------------------------------------
// Unit-level steering on a bare wall grid
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

/** A wall in arena cell (col, row). */
function wallAt(col: number, row: number, teamId = 1): SimUnit {
  return body({
    id: `w-${String(row).padStart(2, '0')}-${String(col).padStart(2, '0')}`,
    playerId: teamId === 0 ? 'a' : 'b', teamId, seat: teamId, type: 'wall', stats: stats({ type: 'wall' }), radius: 20,
    x: col * 40 + 20, y: row * 40 + 20, hp: 400, maxHp: 400, cost: 32,
  });
}

function gridOf(cells: Array<[number, number]>): { grid: WallGrid; walls: SimUnit[] } {
  const grid = new WallGrid(ARENA);
  const walls = cells.map(([c, r]) => wallAt(c, r));
  for (const w of walls) grid.add(w);
  return { grid, walls };
}

/** Steer like the engine does (step 4, then the step-5 wall push), recording the path. */
function walk(u: SimUnit, dest: { x: number; y: number }, grid: WallGrid, walls: SimUnit[], ticks: number) {
  const path: Array<{ x: number; y: number; blocked: boolean }> = [];
  let maxPenetration = 0;
  let arrivedAt = -1;
  for (let t = 0; t < ticks; t++) {
    const r = steerToward(u, dest, u.stats.speed, grid, ARENA, CENTER, DEFAULT_CONFIG.sim.slideMemoryTicks);
    for (const w of walls) maxPenetration = Math.max(maxPenetration, u.radius - distanceToWall(u, w));
    if (pushOutOfWalls(u, grid)) clampBody(u, ARENA);
    path.push({ x: u.x, y: u.y, blocked: r.blocked });
    if (arrivedAt < 0 && Math.hypot(u.x - dest.x, u.y - dest.y) < 1e-6) arrivedAt = t;
  }
  return { path, maxPenetration, arrivedAt };
}

describe('wall steering (§9.3)', () => {
  it('a soldier walking straight into a wall never overlaps it and reports blockedBy/blockedTicks', () => {
    // A long wall row 10 from the left edge to col 17: the soldier at col 5 walks straight down into it.
    const { grid, walls } = gridOf(Array.from({ length: 18 }, (_, c) => [c, 10] as [number, number]));
    const u = body({ x: 5 * 40 + 20, y: 200 });
    const dest = { x: 5 * 40 + 20, y: 700 };
    let blockedSeen = 0;
    let maxPen = 0;
    for (let t = 0; t < 600; t++) {
      const r = steerToward(u, dest, 1.5, grid, ARENA, CENTER, 45);
      for (const w of walls) maxPen = Math.max(maxPen, u.radius - distanceToWall(u, w));
      if (r.blocked) {
        blockedSeen++;
        expect(u.blockedBy).toMatch(/^w-10-/);
        expect(u.blockedTicks).toBeGreaterThan(0);
      }
      if (u.y > 420) break; // went round the free end (col 18-19)
    }
    expect(maxPen).toBeLessThanOrEqual(0.01);
    expect(blockedSeen).toBeGreaterThan(10);
  });

  it('slides round a single wall to a destination right behind it', () => {
    const { grid, walls } = gridOf([[10, 10]]);
    const u = body({ x: 420, y: 300 });
    const { maxPenetration, arrivedAt, path } = walk(u, { x: 420, y: 500 }, grid, walls, 400);
    expect(maxPenetration).toBeLessThanOrEqual(0.01);
    expect(arrivedAt).toBeGreaterThan(0);
    expect(path.some((p) => p.blocked)).toBe(true);
  });

  it('gets round a 3-wall line to a destination behind it within 300 ticks', () => {
    const { grid, walls } = gridOf([[9, 10], [10, 10], [11, 10]]);
    const u = body({ x: 400, y: 300 });
    const { maxPenetration, arrivedAt } = walk(u, { x: 410, y: 520 }, grid, walls, 300);
    expect(maxPenetration).toBeLessThanOrEqual(0.01);
    expect(arrivedAt).toBeGreaterThan(0);
    expect(arrivedAt).toBeLessThan(300);
  });

  it('destination exactly behind the middle of a 5-wall line: the slide never reverses', () => {
    const { grid, walls } = gridOf([[8, 10], [9, 10], [10, 10], [11, 10], [12, 10]]);
    const u = body({ x: 420, y: 300 }); // straight above the middle wall's centre
    const dest = { x: 420, y: 560 };
    const { path, arrivedAt, maxPenetration } = walk(u, dest, grid, walls, 600);
    expect(maxPenetration).toBeLessThanOrEqual(0.01);
    expect(arrivedAt).toBeGreaterThan(0);
    // While sliding along the line (above it), x moves one way only.
    const along = path.filter((p) => p.y < 400 - 10 + 0.5 && p.blocked);
    expect(along.length).toBeGreaterThan(5);
    const dx = along.slice(1).map((p, i) => p.x - along[i]!.x);
    const signs = new Set(dx.filter((d) => Math.abs(d) > 1e-9).map(Math.sign));
    expect(signs.size).toBe(1);
  });

  it('a line touching the arena edge: turns back once, then goes round the other end', () => {
    // Row 10 from the left edge to col 12; the body starts above col 3 and the
    // destination is straight below it: the tie-break slides it toward the
    // centre... make the first slide go left (dest slightly left) into the edge.
    const { grid, walls } = gridOf(Array.from({ length: 13 }, (_, c) => [c, 10] as [number, number]));
    const u = body({ x: 100, y: 300 });
    const dest = { x: 90, y: 600 };
    const { path, arrivedAt, maxPenetration } = walk(u, dest, grid, walls, 1500);
    expect(maxPenetration).toBeLessThanOrEqual(0.01);
    expect(arrivedAt).toBeGreaterThan(0);
    // It reached the left edge, then went right past col 12 (x > 13·40) before coming down.
    expect(Math.min(...path.map((p) => p.x))).toBeLessThanOrEqual(10 + 1e-6);
    expect(Math.max(...path.map((p) => p.x))).toBeGreaterThan(13 * 40);
    expect(u.slide?.flipped ?? true).toBe(true);
  });

  it('a diagonal wall line and an L corner block like solid walls', () => {
    // Diagonal (no gaps between corners): nothing gets through between the squares.
    const diag = gridOf([[6, 6], [7, 7], [8, 8], [9, 9], [10, 10], [11, 11], [12, 12]]);
    const u = body({ x: 11 * 40, y: 7 * 40 }); // above-right of the diagonal
    const crossed = walk(u, { x: 7 * 40, y: 11 * 40 }, diag.grid, diag.walls, 900);
    expect(crossed.maxPenetration).toBeLessThanOrEqual(0.01);
    // Every point of the path stays on its side of the diagonal or went round an end.
    for (const p of crossed.path) {
      const onLine = p.x >= 6 * 40 - 10 && p.x <= 13 * 40 + 10 && p.y >= 6 * 40 - 10 && p.y <= 13 * 40 + 10;
      if (onLine) expect(p.x - p.y).toBeGreaterThan(-12);
    }
    // L corner: the body walks into the inner corner and still gets out to a destination beyond.
    const L = gridOf([[8, 10], [9, 10], [10, 10], [10, 9], [10, 8]]);
    const v = body({ x: 340, y: 340 }); // inside the L's pocket
    const out = walk(v, { x: 500, y: 520 }, L.grid, L.walls, 900);
    expect(out.maxPenetration).toBeLessThanOrEqual(0.01);
    expect(out.arrivedAt).toBeGreaterThan(0);
  });

  it('a one-cell gate lets a size-10 body through and stops a size-20 one', () => {
    // A full row 10 across the arena except a gate at col 9.
    const cells = Array.from({ length: 20 }, (_, c) => [c, 10] as [number, number]).filter(([c]) => c !== 9);
    const small = gridOf(cells);
    const s = body({ x: 300, y: 300 });
    const through = walk(s, { x: 300, y: 600 }, small.grid, small.walls, 900);
    expect(through.maxPenetration).toBeLessThanOrEqual(0.01);
    expect(through.arrivedAt).toBeGreaterThan(0);
    const big = gridOf(cells);
    const b = body({ x: 300, y: 300, radius: 20, stats: stats({ type: 'soldier', size: 20 }) });
    const stuck = walk(b, { x: 300, y: 600 }, big.grid, big.walls, 900);
    expect(stuck.maxPenetration).toBeLessThanOrEqual(0.01);
    expect(Math.max(...stuck.path.map((p) => p.y))).toBeLessThan(400);
  });

  it('is deterministic: the same inputs give the same path', () => {
    const run = () => {
      const { grid, walls } = gridOf([[8, 10], [9, 10], [10, 10], [11, 10], [12, 10]]);
      return walk(body({ x: 420, y: 300 }), { x: 420, y: 560 }, grid, walls, 300).path;
    };
    expect(run()).toEqual(run());
  });

  it('the wall push moves an overlapping body out through the nearest face', () => {
    const { grid } = gridOf([[10, 10]]);
    const u = body({ x: 402, y: 420 }); // inside the square, nearest the left face
    expect(pushOutOfWalls(u, grid)).toBe(true);
    expect(u.x).toBeCloseTo(400 - 10, 9);
    const v = body({ x: 395, y: 395 }); // overlaps the top-left corner
    pushOutOfWalls(v, grid);
    expect(distanceToWall(v, { x: 420, y: 420 })).toBeCloseTo(10, 9);
  });
});

// ---------------------------------------------------------------------------
// Engine-level
// ---------------------------------------------------------------------------

const WALL = stats({ type: 'wall' });
const cfg = (patch: unknown = {}, ticks = 5400): GameConfig => deepMerge(DEFAULT_CONFIG, { ...(patch as object), timers: { battleTicks: ticks } });

function engineOf(specs: FakePlayerSpec[], config: GameConfig, seed = 7) {
  const { setups, runners } = fakePlayers(specs);
  return { engine: new BattleEngine({ players: setups, config, seed }), runners };
}

const at = (col: number, row: number, unitId: string): PlacementDTO => ({ unitId, col, row });
const allEvents = (frames: FrameDTO[]) => frames.flatMap((f) => f.events.map((e) => ({ t: f.t, e })));

describe('walls in battle (§9.3)', () => {
  it('walls run no code: never spawned in the sandbox, never disabled, never act', async () => {
    const { engine } = engineOf(
      [
        { playerId: 'a', seat: 0, zone: 'TL', units: [design('w', WALL), design('s', SOLDIER)], placements: [at(0, 0, 'w'), at(1, 1, 's')], brains: { s: idleBrain } },
        { playerId: 'b', seat: 1, zone: 'BR', units: [design('s', SOLDIER)], placements: [at(0, 0, 's')], brains: { s: idleBrain } },
      ],
      cfg({}, 60),
    );
    const result = await engine.run();
    const w = result.units.find((u) => u.instanceId === '0-0-0')!;
    expect(w).toMatchObject({ type: 'wall', disabled: false, errors: [], survived: true, livingValue: 0, cost: 32 });
    // Walls are listed in the first frame, then only when their hp changes.
    expect(engine.frames[0]!.units.some((u) => u[0] === '0-0-0')).toBe(true);
    expect(engine.frames.slice(1).some((f) => f.units.some((u) => u[0] === '0-0-0'))).toBe(false);
  });

  it("own walls block their own soldiers; a gate lets them out", async () => {
    // Corner TL: (0,0) is the front cell nearest the centre. A soldier at (1,1) boxed by
    // walls on every side but the arena edge can't reach the centre.
    const ring: PlacementDTO[] = [];
    for (const [c, r] of [[0, 0], [1, 0], [2, 0], [0, 1], [2, 1], [0, 2], [1, 2], [2, 2]] as const) ring.push(at(c, r, 'w'));
    const toCenter = scripted((_self, _e, _a, world) => ({ action: 'move', destination: world.center }));
    const spec = (placements: PlacementDTO[]): FakePlayerSpec[] => [
      { playerId: 'a', seat: 0, zone: 'TL', units: [design('w', WALL), design('s', SOLDIER)], placements: [...placements, at(1, 1, 's')], brains: { s: toCenter } },
      { playerId: 'b', seat: 1, zone: 'BR', units: [design('t', TOWER)], placements: [at(5, 5, 't')], brains: { t: idleBrain } },
    ];
    const boxed = engineOf(spec(ring), cfg({ suddenDeath: { damagePctPerSecond: 0 } }, 600));
    await boxed.engine.run();
    const last = boxed.engine.frames[boxed.engine.frames.length - 1]!;
    const s = last.units.find((u) => u[0] === '0-1-1')!;
    const home = cellCenter('TL', 1, 1);
    expect(Math.hypot(s[1] - home.x, s[2] - home.y)).toBeLessThan(25);
    expect(s[4] & FRAME_FLAGS.BLOCKED).toBeTruthy();
    // Opening the diagonal cell (0,0) is no gate: (1,0) and (0,1) touch at their corners.
    const diagonal = engineOf(spec(ring.filter((p) => !(p.col === 0 && p.row === 0))), cfg({ suddenDeath: { damagePctPerSecond: 0 } }, 600));
    await diagonal.engine.run();
    const d = diagonal.engine.frames[diagonal.engine.frames.length - 1]!.units.find((u) => u[0] === '0-1-1')!;
    expect(Math.hypot(d[1] - home.x, d[2] - home.y)).toBeLessThan(25);
    // Opening the side cell (1,0) is: it walks out toward the centre.
    const gated = engineOf(spec(ring.filter((p) => !(p.col === 1 && p.row === 0))), cfg({ suddenDeath: { damagePctPerSecond: 0 } }, 600));
    await gated.engine.run();
    const g = gated.engine.frames[gated.engine.frames.length - 1]!.units.find((u) => u[0] === '0-1-1')!;
    expect(Math.hypot(g[1] - 400, g[2] - 400)).toBeLessThan(60);
  });

  it("an enemy soldier breaks through a wall: it smashes the wall after 120 blocked ticks and gets value destroyed", async () => {
    // B walls itself in completely (a full box round its tower); A's soldier comes for the tower.
    const box: PlacementDTO[] = [];
    for (let c = 2; c <= 5; c++) box.push(at(c, 2, 'w'));
    for (let r = 3; r <= 5; r++) box.push(at(2, r, 'w'));
    const smasher = scripted((self, enemies) => {
      const tower = enemies.find((e) => e.type === 'tower');
      // The template rule: smash the enemy wall in the way once blocked for 120 ticks (while it stands).
      const blocking = enemies.find((e) => e.id === self.blockedBy && e.type === 'wall');
      if (blocking && self.blockedTicks >= 120) return { action: 'attack', targetId: blocking.id };
      if (!tower) return { action: 'idle' };
      const gap = Math.hypot(tower.x - self.x, tower.y - self.y) - self.radius - tower.radius;
      if (gap <= self.range) return { action: 'attack', targetId: tower.id };
      return { action: 'move', destination: { x: tower.x, y: tower.y } };
    });
    const strong = stats({ type: 'soldier', damage: 60, attackCooldown: 10, speed: 3, maxHealth: 500 });
    const { engine } = engineOf(
      [
        { playerId: 'a', seat: 0, zone: 'TL', units: [design('s', strong)], placements: [at(0, 0, 's')], brains: { s: smasher } },
        { playerId: 'b', seat: 1, zone: 'BR', units: [design('w', WALL), design('t', stats({ type: 'tower', damage: 0 }))], placements: [...box, at(4, 4, 't')], brains: { t: idleBrain } },
      ],
      cfg({ suddenDeath: { damagePctPerSecond: 0 } }),
    );
    const result = await engine.run();
    const walls = result.units.filter((u) => u.type === 'wall');
    const broken = walls.filter((w) => !w.survived);
    expect(broken.length).toBeGreaterThanOrEqual(1);
    const a = result.units.find((u) => u.instanceId === '0-0-0')!;
    // The tower died too (elimination), and every wall killed credited its full price ($32).
    expect(result.endReason).toBe('elimination');
    expect(a.kills).toBeGreaterThanOrEqual(2);
    const towerCost = result.units.find((u) => u.type === 'tower')!.cost;
    expect(a.valueDestroyed).toBe(towerCost + 32 * (a.kills - 1));
    // B's leftover walls crumbled at the elimination, credited to nobody.
    const crumble = allEvents(engine.frames).find((x) => x.e.type === 'crumble');
    expect(crumble).toBeDefined();
    expect(walls.filter((w) => w.survived)).toEqual([]);
  });

  it('ranged attackers shoot walls, and projectiles fly over walls to targets behind them', async () => {
    // B's soldier stands behind B's own walls; A's ranged soldier walks up and shoots either.
    const ranged = stats({ type: 'soldier', range: 200, damage: 30, attackCooldown: 30, speed: 3 });
    const approachThen = (pick: 'wall' | 'soldier') =>
      scripted((self, enemies) => {
        const target = enemies.find((e) => e.type === pick);
        if (!target) return { action: 'idle' };
        const gap = Math.hypot(target.x - self.x, target.y - self.y) - self.radius - target.radius;
        if (gap <= self.range) return { action: 'attack', targetId: target.id };
        return { action: 'move', destination: { x: target.x, y: target.y } };
      });
    for (const pick of ['wall', 'soldier'] as const) {
      const { engine } = engineOf(
        [
          { playerId: 'a', seat: 0, zone: 'TL', units: [design('r', ranged)], placements: [at(0, 0, 'r')], brains: { r: approachThen(pick) } },
          {
            playerId: 'b', seat: 1, zone: 'BR',
            units: [design('w', WALL), design('s', SOLDIER)],
            placements: [at(0, 0, 'w'), at(1, 0, 'w'), at(0, 1, 'w'), at(2, 0, 'w'), at(0, 2, 'w'), at(1, 1, 's')],
            brains: { s: scripted(() => ({ action: 'idle' })) },
          },
        ],
        cfg({ suddenDeath: { damagePctPerSecond: 0 } }, 1200),
      );
      const result = await engine.run();
      const hits = allEvents(engine.frames).filter((x) => x.e.type === 'hit' && x.e.instanceId === '0-0-0');
      expect(hits.length).toBeGreaterThan(0);
      const targetIds = new Set(hits.map((x) => (x.e as { targetId: string }).targetId));
      if (pick === 'wall') expect([...targetIds].every((id) => result.units.find((u) => u.instanceId === id)?.type === 'wall')).toBe(true);
      else expect(targetIds.has('1-1-1')).toBe(true); // shot over the walls
    }
  });

  it('walls take sudden-death damage (7% of max HP per second outside the circle)', async () => {
    const { engine } = engineOf(
      [
        { playerId: 'a', seat: 0, zone: 'TL', units: [design('w', stats({ type: 'wall', maxHealth: 1500 })), design('s', SOLDIER)], placements: [at(5, 5, 'w'), at(0, 0, 's')], brains: { s: idleBrain } },
        { playerId: 'b', seat: 1, zone: 'BR', units: [design('s', SOLDIER)], placements: [at(0, 0, 's')], brains: { s: idleBrain } },
      ],
      cfg({ suddenDeath: { startTick: 10, endTick: 20, endRadius: 10 } }, 200),
    );
    const result = await engine.run();
    const w = result.units.find((u) => u.instanceId === '0-5-5')!;
    expect(w.hp).toBeLessThan(1500);
    // Its hp changes, so it is listed in the frames again.
    expect(engine.frames.slice(1).some((f) => f.units.some((u) => u[0] === '0-5-5'))).toBe(true);
  });

  it('a side with only walls left is eliminated on that tick and its walls crumble (credited to nobody)', async () => {
    // B: a weak soldier and 3 walls; A's strong soldier kills the soldier.
    const strong = stats({ type: 'soldier', damage: 60, attackCooldown: 10, speed: 4, maxHealth: 500 });
    const weak = stats({ type: 'soldier', maxHealth: 10 });
    const killer = scripted((self, enemies) => {
      const s = enemies.find((e) => e.type === 'soldier');
      if (!s) return { action: 'idle' };
      const gap = Math.hypot(s.x - self.x, s.y - self.y) - self.radius - s.radius;
      return gap <= self.range ? { action: 'attack', targetId: s.id } : { action: 'move', destination: { x: s.x, y: s.y } };
    });
    const { engine } = engineOf(
      [
        { playerId: 'a', seat: 0, zone: 'TL', units: [design('s', strong)], placements: [at(0, 0, 's')], brains: { s: killer } },
        { playerId: 'b', seat: 1, zone: 'BR', units: [design('w', WALL), design('s', weak)], placements: [at(5, 5, 'w'), at(4, 5, 'w'), at(5, 4, 'w'), at(0, 0, 's')], brains: { s: idleBrain } },
      ],
      cfg(),
    );
    const result = await engine.run();
    expect(result.endReason).toBe('elimination');
    const b = result.players.find((p) => p.playerId === 'b')!;
    const soldierDied = result.units.find((u) => u.instanceId === '1-0-0')!.diedAtTick!;
    expect(b.eliminatedAtTick).toBe(soldierDied);
    expect(result.endTick).toBe(soldierDied);
    const walls = result.units.filter((u) => u.type === 'wall');
    expect(walls.every((w) => !w.survived && w.diedAtTick === soldierDied)).toBe(true);
    const crumble = allEvents(engine.frames).find((x) => x.e.type === 'crumble')!;
    expect(crumble.e).toEqual({ type: 'crumble', ids: ['1-4-5', '1-5-4', '1-5-5'] });
    // Nobody is credited for crumbled walls.
    const a = result.units.find((u) => u.instanceId === '0-0-0')!;
    expect(a.kills).toBe(1);
    expect(a.valueDestroyed).toBe(result.units.find((u) => u.instanceId === '1-0-0')!.cost);
    expect(result.ranking.map((r) => r.playerId)).toEqual(['a', 'b']);
  });

  it('a player who places only walls is out at the start', async () => {
    const { engine } = engineOf(
      [
        { playerId: 'a', seat: 0, zone: 'TL', units: [design('s', SOLDIER)], placements: [at(0, 0, 's')], brains: { s: idleBrain } },
        { playerId: 'b', seat: 1, zone: 'BR', units: [design('w', WALL)], placements: [at(0, 0, 'w'), at(1, 0, 'w')], brains: {} },
      ],
      cfg(),
    );
    const result = await engine.run();
    expect(result.endTick).toBe(0);
    expect(result.players.find((p) => p.playerId === 'b')!.eliminatedAtTick).toBe(0);
    expect(engine.frames).toHaveLength(1);
    expect(engine.frames[0]!.events).toContainEqual({ type: 'crumble', ids: ['1-0-0', '1-0-1'] });
    expect(engine.frames[0]!.units.map((u) => u[0])).toEqual(['0-0-0']);
  });

  it('timeout: walls are worth $0 of living value', async () => {
    const { engine } = engineOf(
      [
        { playerId: 'a', seat: 0, zone: 'TL', units: [design('s', SOLDIER), design('w', WALL)], placements: [at(0, 0, 's'), ...[1, 2, 3, 4, 5].map((c) => at(c, 0, 'w'))], brains: { s: idleBrain } },
        { playerId: 'b', seat: 1, zone: 'BR', units: [design('t', TOWER)], placements: [at(0, 0, 't')], brains: { t: idleBrain } },
      ],
      cfg({ suddenDeath: { damagePctPerSecond: 0 } }, 120),
    );
    const result = await engine.run();
    expect(result.endReason).toBe('timeout');
    const a = result.players.find((p) => p.playerId === 'a')!;
    expect(a.livingCost).toBe(92);
    // The tower ($198) beats a soldier + 5 walls ($92 + $0).
    expect(result.ranking[0]!.playerId).toBe('b');
  });

  it('Skip: a frame that omits unchanged walls still counts them alive (resultAtTick / rankFromFrame)', async () => {
    const { engine } = engineOf(
      [
        { playerId: 'a', seat: 0, zone: 'TL', units: [design('s', SOLDIER), design('w', WALL)], placements: [at(0, 0, 's'), at(1, 0, 'w'), at(2, 0, 'w')], brains: { s: idleBrain } },
        { playerId: 'b', seat: 1, zone: 'BR', units: [design('t', TOWER)], placements: [at(0, 0, 't')], brains: { t: idleBrain } },
      ],
      cfg({ suddenDeath: { damagePctPerSecond: 0 } }, 200),
    );
    const result = await engine.run();
    const frame = engine.frames.find((f) => f.t === 100)!;
    expect(frame.units.some((u) => u[0] === '0-0-1')).toBe(false);
    const trimmed = resultAtTick(result, engine.countersAt(100), frame, 100);
    expect(trimmed.units.find((u) => u.instanceId === '0-0-1')).toMatchObject({ survived: true, livingValue: 0 });
    expect(trimmed.players.find((p) => p.playerId === 'a')!.livingCost).toBe(92);
    expect(trimmed.players.find((p) => p.playerId === 'a')!.livingUnits).toBe(3);
  });

  it('is deterministic with shuffled placement order', async () => {
    const placements = [at(0, 0, 's'), at(1, 0, 'w'), at(2, 0, 'w'), at(0, 1, 'w'), at(1, 1, 's'), at(3, 3, 'w')];
    const run = async (order: PlacementDTO[]) => {
      const { engine } = engineOf(
        [
          { playerId: 'a', seat: 0, zone: 'TL', units: [design('s', SOLDIER), design('w', WALL)], placements: order, brains: { s: soldierBrain } },
          { playerId: 'b', seat: 1, zone: 'BR', units: [design('s', SOLDIER), design('w', WALL), design('t', TOWER)], placements: [at(0, 0, 'w'), at(1, 0, 'w'), at(1, 1, 't'), at(2, 2, 's')], brains: { s: soldierBrain, t: towerBrain } },
        ],
        cfg({}, 1500),
      );
      await engine.run();
      return engine.frames;
    };
    const a = await run(placements);
    const b = await run([...placements].reverse());
    expect(b).toEqual(a);
  });
});
