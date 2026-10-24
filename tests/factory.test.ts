// Factories and minions in the headless sim (plan §5.2, §9.3, M8.5):
// production timing and caps, hold, spawn spots, rally, the factory's death,
// disabled factories, minion ids and AI, credit, elimination and values.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  computeCost,
  deepMerge,
  mapFor,
  type FrameDTO,
  type GameConfig,
  type PlacementDTO,
} from '@pixel-clash/shared';
import { BattleEngine, type SimUnit } from '../packages/server/src/sim/engine.js';
import { alivePerPlayerCap, canMakeOf, spawnSpot, zoneFacingDir } from '../packages/server/src/sim/factory.js';
import { minionAction, minionStats, sidestep } from '../packages/server/src/sim/minion.js';
import { rankFromFrame } from '../packages/server/src/sim/ranking.js';
import { WallGrid } from '../packages/server/src/sim/walls.js';
import { SOLDIER, design, fakePlayers, idleBrain, scripted, stats, type FakePlayerSpec } from './helpers/fakeRunner.js';

const FACTORY = (interval = 600, over: object = {}) => stats({ type: 'factory', productionInterval: interval, ...over });
const WALL = stats({ type: 'wall' });
const at = (col: number, row: number, unitId: string): PlacementDTO => ({ unitId, col, row });
const cfg = (patch: unknown = {}, ticks = 5400): GameConfig => deepMerge(DEFAULT_CONFIG, { ...(patch as object), timers: { battleTicks: ticks } });
const noSD = { suddenDeath: { damagePctPerSecond: 0 } };

function run(specs: FakePlayerSpec[], config: GameConfig, seed = 3) {
  const { setups } = fakePlayers(specs);
  const engine = new BattleEngine({ players: setups, config, seed });
  return { engine, done: engine.run() };
}
const events = (frames: FrameDTO[]) => frames.flatMap((f) => f.events.map((e) => ({ t: f.t, e })));
const spawns = (frames: FrameDTO[]) =>
  events(frames).filter((x): x is { t: number; e: { type: 'spawn'; instanceId: string; factoryId: string; x: number; y: number } } => x.e.type === 'spawn' && 'factoryId' in x.e);
/** Max minions alive at once per factory (from the frames). */
function maxAlive(frames: FrameDTO[], factoryId: string): number {
  return Math.max(0, ...frames.map((f) => f.units.filter((u) => u[0].startsWith(`${factoryId}-m`)).length));
}

/** A far-away enemy that stays alive (no sudden death) so the battle runs to the end. */
const farEnemy = (): FakePlayerSpec => ({ playerId: 'b', seat: 1, zone: 'BR', units: [design('t', stats({ type: 'tower', damage: 5 }))], placements: [at(5, 5, 't')], brains: { t: idleBrain } });
const rallyHome = scripted((self) => ({ action: 'rally', destination: { x: self.x - 60, y: self.y - 60 } }));

describe('factory production (§5.2, §9.3 step 9b)', () => {
  it('spawns at exactly ticks I, 2I, … and stops at E; ids are `${factory}-mN`', async () => {
    const config = cfg({ ...noSD, factory: { maxAlivePerFactory: 8, maxAlivePerPlayer: 8 } });
    const { engine, done } = run(
      [{ playerId: 'a', seat: 0, zone: 'TL', units: [design('f', FACTORY(600), undefined, config)], placements: [at(2, 2, 'f')], brains: { f: rallyHome } }, farEnemy()],
      config,
    );
    const result = await done;
    const s = spawns(engine.frames);
    expect(s.map((x) => x.t)).toEqual([600, 1200, 1800, 2400, 3000, 3600, 4200, 4800]);
    expect(s.map((x) => x.e.instanceId)).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((n) => `0-2-2-m${n}`));
    const f = result.units.find((u) => u.instanceId === '0-2-2')!;
    expect(f.factory).toMatchObject({ minionsLeft: 0, minionsMade: 8, bodyCost: 247, minionValue: 148 });
    // Minions are reported under the factory's design.
    expect(result.units.filter((u) => u.type === 'minion').every((u) => u.unitId === 'f' && u.factoryId === '0-2-2')).toBe(true);
    // fac in the frames: progress, minionsLeft, ..., canMake.
    const f300 = engine.frames.find((fr) => fr.t === 300)!;
    // M8.6: then stored 0, burst 1, order 0 (attack).
    expect(f300.fac).toEqual([['0-2-2', 50, 8, expect.any(Number), expect.any(Number), 0, 8, 0, 1, 0]]);
  });

  it('at most 4 alive per factory; a full factory waits with a full timer', async () => {
    const config = cfg(noSD);
    const { engine, done } = run(
      [{ playerId: 'a', seat: 0, zone: 'TL', units: [design('f', FACTORY(600), undefined, config)], placements: [at(2, 2, 'f')], brains: { f: rallyHome } }, farEnemy()],
      config,
    );
    await done;
    expect(maxAlive(engine.frames, '0-2-2')).toBe(4);
    expect(spawns(engine.frames)).toHaveLength(4);
    const late = engine.frames.find((fr) => fr.t === 5000)!;
    expect(late.fac![0]!.slice(1, 3)).toEqual([100, 4]);
  });

  it('the per-player cap is min(6, floor(40 / players)) and two factories share it', async () => {
    expect([2, 4, 6, 7, 8].map((n) => alivePerPlayerCap(DEFAULT_CONFIG.factory, n))).toEqual([6, 6, 6, 5, 5]);
    const config = cfg(noSD);
    const { engine, done } = run(
      [
        {
          playerId: 'a', seat: 0, zone: 'TL',
          units: [design('f', FACTORY(600), undefined, config)],
          placements: [at(2, 2, 'f'), at(4, 4, 'f')],
          brains: { f: rallyHome },
        },
        farEnemy(),
      ],
      config,
    );
    await done;
    const alive = Math.max(...engine.frames.map((f) => f.units.filter((u) => u[0].includes('-m')).length));
    expect(alive).toBe(6);
  });

  it('hold freezes the timer', async () => {
    const config = cfg(noSD, 1300);
    const holdEarly = scripted((self, _e, _a, world) => (world.tick < 300 ? { action: 'hold' } : { action: 'idle' }));
    const { engine, done } = run(
      [{ playerId: 'a', seat: 0, zone: 'TL', units: [design('f', FACTORY(600), undefined, config)], placements: [at(2, 2, 'f')], brains: { f: holdEarly } }, farEnemy()],
      config,
    );
    await done;
    expect(spawns(engine.frames).map((x) => x.t)).toEqual([900]);
    expect(engine.frames.find((f) => f.t === 100)!.fac![0]![5]).toBe(1);
  });

  it('a full factory spawns on the tick a minion dies', async () => {
    // One minion at a time. The enemy tower holds fire until tick 1300, so the
    // first minion outlives the 600-tick interval: the factory is full with a full timer.
    const config = cfg({ ...noSD, factory: { maxAlivePerFactory: 1 } }, 3000);
    const killer = stats({ type: 'tower', range: 300, damage: 300, attackCooldown: 10 });
    const shoot = scripted((self, enemies, _a, world) => {
      const m = enemies.find((e) => e.type === 'minion');
      if (!m || self.cooldownRemaining > 0 || world.tick < 1300) return { action: 'idle' };
      const gap = Math.hypot(m.x - self.x, m.y - self.y) - self.radius - m.radius;
      return gap <= self.range ? { action: 'attack', targetId: m.id } : { action: 'idle' };
    });
    const rallyToTower = scripted(() => ({ action: 'rally', destination: { x: 600, y: 600 } }));
    const { engine, done } = run(
      [
        { playerId: 'a', seat: 0, zone: 'TL', units: [design('f', FACTORY(600), undefined, config)], placements: [at(0, 0, 'f')], brains: { f: rallyToTower } },
        { playerId: 'b', seat: 1, zone: 'BR', units: [design('t', killer)], placements: [at(1, 1, 't')], brains: { t: shoot } },
      ],
      config,
    );
    await done;
    const s = spawns(engine.frames);
    expect(s.length).toBeGreaterThanOrEqual(2);
    const deaths = events(engine.frames).filter((x) => x.e.type === 'death').map((x) => [(x.e as { instanceId: string }).instanceId, x.t] as const);
    const firstDeath = deaths.find(([id]) => id === '0-0-0-m1')!;
    expect(firstDeath[1]).toBeGreaterThan(1300);
    // The second minion appears in the same frame as the first one's death (the timer was full).
    expect(s[1]!.t).toBe(firstDeath[1]);
  });

  it('spawn spots: toward the rally point first, then ±45°, … skipping towers, factories and walls', () => {
    const grid = new WallGrid(800);
    const fac = { id: 'f', x: 220, y: 220, radius: 18, alive: true, type: 'factory' } as SimUnit;
    const right = spawnSpot(fac, { x: 400, y: 220 }, { x: 1, y: 1 }, 800, 8, grid, []);
    expect(right).toEqual({ x: 248, y: 220 });
    // A tower right next to it (the next cell) blocks the first spot: +45° wins.
    const tower = { id: 't', x: 260, y: 220, radius: 14, alive: true, type: 'tower' } as SimUnit;
    const spot = spawnSpot(fac, { x: 400, y: 220 }, { x: 1, y: 1 }, 800, 8, grid, [tower])!;
    expect(spot.x).toBeCloseTo(220 + 28 * Math.SQRT1_2, 5);
    expect(spot.y).toBeCloseTo(220 + 28 * Math.SQRT1_2, 5);
    // Rally = the factory itself: along the zone's facing (TL faces down-right).
    const self = spawnSpot(fac, { x: 220, y: 220 }, zoneFacingDir('TL'), 800, 8, grid, [])!;
    expect(self.x).toBeCloseTo(self.y, 9);
    expect(self.x).toBeGreaterThan(220);
    // A Lanes zone faces the other row, not the arena centre.
    const lanes = mapFor('lanes', 4);
    const top = lanes.zones.find((z) => z.facing === 'S')!;
    expect(zoneFacingDir(top)).toEqual({ x: 0, y: 1 });
    const lf = { id: 'f3', x: top.x + 20, y: top.y + 100, radius: 18, alive: true, type: 'factory' } as SimUnit;
    expect(spawnSpot(lf, { x: lf.x, y: lf.y }, zoneFacingDir(top), lanes.width, 8, grid, [])).toEqual({ x: lf.x, y: lf.y + 28 });
    expect(['TL', 'TR', 'BL', 'BR'].map((c) => zoneFacingDir(c as 'TL'))).toEqual([{ x: 1, y: 1 }, { x: -1, y: 1 }, { x: 1, y: -1 }, { x: -1, y: -1 }]);
    // Boxed in on every side by overlapping walls: no spot.
    const g2 = new WallGrid(800);
    for (const [c, r] of [[4, 4], [5, 4], [6, 4], [4, 5], [6, 5], [4, 6], [5, 6], [6, 6]] as const) {
      g2.add({ id: `w${c}${r}`, x: c * 40 + 20, y: r * 40 + 20, type: 'wall', radius: 20 } as SimUnit);
    }
    const boxed = { id: 'f2', x: 220, y: 220, radius: 18, alive: true, type: 'factory' } as SimUnit;
    expect(spawnSpot(boxed, { x: 400, y: 400 }, { x: 1, y: 1 }, 800, 8, g2, [])).toBeNull();
  });

  it('rally clamps into the arena; living minions follow the newest one', async () => {
    const config = cfg(noSD, 1500);
    const away = scripted((_s, _e, _a, world) => (world.tick < 700 ? { action: 'rally', destination: { x: -500, y: 9999 } } : { action: 'rally', destination: { x: 300, y: 100 } }));
    const { engine, done } = run(
      [{ playerId: 'a', seat: 0, zone: 'TL', units: [design('f', FACTORY(600), undefined, config)], placements: [at(2, 2, 'f')], brains: { f: away } }, farEnemy()],
      config,
    );
    await done;
    expect(engine.frames.find((f) => f.t === 650)!.fac![0]!.slice(3, 5)).toEqual([0, 800]);
    expect(engine.frames.find((f) => f.t === 800)!.fac![0]!.slice(3, 5)).toEqual([300, 100]);
    const last = engine.frames[engine.frames.length - 1]!;
    const m1 = last.units.find((u) => u[0] === '0-2-2-m1')!;
    expect(Math.hypot(m1[1] - 300, m1[2] - 100)).toBeLessThanOrEqual(DEFAULT_CONFIG.factory.rallyArriveRadius + 1);
  });

  it("destroying the factory stops production; its minions keep the last rally point", async () => {
    const config = cfg(noSD, 2400);
    const strong = stats({ type: 'soldier', maxHealth: 2500, damage: 300, attackCooldown: 10, speed: 4 });
    const hunter = scripted((self, enemies, _a, world) => {
      if (world.tick < 650) return { action: 'idle' };
      const f = enemies.find((e) => e.type === 'factory');
      if (!f) return { action: 'idle' };
      const gap = Math.hypot(f.x - self.x, f.y - self.y) - self.radius - f.radius;
      return gap <= self.range ? { action: 'attack', targetId: f.id } : { action: 'move', destination: { x: f.x, y: f.y } };
    });
    const rally = scripted(() => ({ action: 'rally', destination: { x: 120, y: 300 } }));
    const { engine, done } = run(
      [
        { playerId: 'a', seat: 0, zone: 'TL', units: [design('f', FACTORY(600), undefined, config)], placements: [at(0, 0, 'f')], brains: { f: rally } },
        { playerId: 'b', seat: 1, zone: 'BR', units: [design('s', strong)], placements: [at(0, 0, 's')], brains: { s: hunter } },
      ],
      config,
    );
    const result = await done;
    const f = result.units.find((u) => u.instanceId === '0-0-0')!;
    expect(f.survived).toBe(false);
    const after = spawns(engine.frames).filter((x) => x.t > f.diedAtTick!);
    expect(after).toEqual([]);
    expect(f.factory!.minionsMade).toBe(1);
    // Killing the factory credited its living value at death: body + its 2 unbuilt minions
    // (E = floor(2399 / 600) = 3 in this 2400-tick battle, 1 made).
    const hunterReport = result.units.find((u) => u.instanceId === '1-0-0')!;
    expect(hunterReport.kills).toBe(1);
    expect(hunterReport.valueDestroyed).toBe(247 + 2 * 148);
    // Player a still has its minion (a fighter): not eliminated.
    const m1 = result.units.find((u) => u.instanceId === '0-0-0-m1')!;
    if (m1.survived) expect(result.players.find((p) => p.playerId === 'a')!.eliminatedAtTick).toBeNull();
  });

  it('a disabled factory keeps producing toward its last rally point', async () => {
    const config = cfg(noSD, 700);
    const { setups } = fakePlayers(
      [
        {
          playerId: 'a', seat: 0, zone: 'TL', units: [design('f', FACTORY(600), undefined, config)], placements: [at(2, 2, 'f')], brains: { f: rallyHome },
          hook: (input) => (input.tick === 5 ? { status: 'crashed', outputs: [], elapsedMs: 0, slow: false, forged: 0, detail: 'boom' } : undefined),
        },
        farEnemy(),
      ],
    );
    const engine = new BattleEngine({ players: setups, config, seed: 1 });
    const result = await engine.run();
    expect(result.players[0]!.disabled).toBe(true);
    expect(spawns(engine.frames).map((x) => x.t)).toEqual([600]);
  });
});

describe('minion AI (§5.2)', () => {
  const cfgF = DEFAULT_CONFIG;
  const mk = (over: Partial<SimUnit>): SimUnit => ({
    id: 'x', playerId: 'a', seat: 0, teamId: 0, unitId: 'u', stats: SOLDIER, cost: 92, type: 'soldier', radius: 10,
    x: 0, y: 0, hp: 100, maxHp: 100, cooldownRemaining: 0, alive: true, disabled: false, spawned: true,
    movedSinceFrame: false, firedSinceFrame: false, facingLeft: false, outsideSafeZone: false,
    damageDealt: 0, kills: 0, valueDestroyed: 0, strikes: 0, errors: [], diedAtTick: null, blockedBy: null, blockedTicks: 0,
    ...over,
  });
  const factory = mk({ id: '0-0-0', type: 'factory', x: 100, y: 100, radius: 18 });
  factory.factory = { productionInterval: 600, timer: 0, minionsLeft: 3, canMake: 3, noSpot: false, made: 1, released: 1, kind: 'grunt', burst: 1, stored: 0, releaseRequested: false, order: 'attack', orderTargetId: null, storedLost: 0, rally: { x: 400, y: 400 }, holding: false, bodyCost: 247, minionValue: 147, spawnedSinceFrame: false, minionsLost: 0 };
  const minion = (over: Partial<SimUnit> = {}) =>
    mk({ id: '0-0-0-m1', type: 'minion', stats: minionStats(cfgF, '#C0A060'), radius: 8, x: 300, y: 300, minion: { factory, n: 1 }, ...over });
  const world = (living: SimUnit[], safeRadius = 570) => {
    const byId = new Map(living.map((u) => [u.id, u]));
    return { living, safeCenter: { x: 400, y: 400 }, safeRadius, rangeTolerance: 0.5, lookup: (id: string) => byId.get(id) };
  };

  it('chases the nearest non-wall enemy within 120 px of itself or 200 px of the rally point', () => {
    const m = minion();
    const near = mk({ id: '1-0-0', teamId: 1, playerId: 'b', x: 300 + 8 + 10 + 100, y: 300 }); // gap 100
    const wall = mk({ id: '1-0-1', teamId: 1, playerId: 'b', type: 'wall', radius: 20, x: 320, y: 300 });
    expect(minionAction(m, world([m, near, wall]), cfgF)).toEqual({ action: 'move', destination: { x: near.x, y: near.y } });
    const far = mk({ id: '1-0-2', teamId: 1, playerId: 'b', x: 700, y: 100 }); // far from both
    expect(minionAction(m, world([m, far]), cfgF)).toEqual({ action: 'move', destination: { x: 400, y: 400 } });
    const guard = mk({ id: '1-0-3', teamId: 1, playerId: 'b', x: 550, y: 450 }); // ~158 from the rally point
    expect(minionAction(m, world([m, guard]), cfgF)).toEqual({ action: 'move', destination: { x: 550, y: 450 } });
    const touching = mk({ id: '1-0-4', teamId: 1, playerId: 'b', x: 300 + 8 + 10 + 15, y: 300 });
    expect(minionAction(m, world([m, touching, near]), cfgF)).toEqual({ action: 'attack', targetId: '1-0-4' });
    const friend = mk({ id: '0-1-1', x: 310, y: 300 });
    expect(minionAction(m, world([m, friend]), cfgF)).toEqual({ action: 'move', destination: { x: 400, y: 400 } });
  });

  it('idles at the rally point, and uses the circle centre when the rally point is outside the safe circle', () => {
    const m = minion({ x: 405, y: 410 });
    expect(minionAction(m, world([m]), cfgF)).toEqual({ action: 'idle' });
    factory.factory!.rally = { x: 20, y: 20 };
    const n = minion({ x: 300, y: 300 });
    expect(minionAction(n, world([n], 100), cfgF)).toEqual({ action: 'move', destination: { x: 400, y: 400 } });
    factory.factory!.rally = { x: 400, y: 400 };
  });

  it('after 120 blocked ticks it smashes an ENEMY wall in the way, never a friendly one', () => {
    const enemyWall = mk({ id: '1-2-2', teamId: 1, playerId: 'b', type: 'wall', radius: 20, x: 300 + 8 + 20 + 1, y: 300 });
    const m = minion({ blockedBy: '1-2-2', blockedTicks: 120 });
    expect(minionAction(m, world([m, enemyWall]), cfgF)).toEqual({ action: 'attack', targetId: '1-2-2' });
    const early = minion({ blockedBy: '1-2-2', blockedTicks: 119 });
    expect(minionAction(early, world([early, enemyWall]), cfgF)).toEqual({ action: 'move', destination: { x: 400, y: 400 } });
    const ownWall = mk({ id: '0-2-2', type: 'wall', radius: 20, x: 329, y: 300 });
    const o = minion({ blockedBy: '0-2-2', blockedTicks: 500 });
    expect(minionAction(o, world([o, ownWall]), cfgF)).toEqual({ action: 'move', destination: { x: 400, y: 400 } });
  });

  it('impatience also beats an out-of-range target (a walled-in enemy); a target in range still comes first', () => {
    const enemyWall = mk({ id: '1-2-2', teamId: 1, playerId: 'b', type: 'wall', radius: 20, x: 300 + 8 + 20 + 1, y: 300 });
    const boxed = mk({ id: '1-3-3', teamId: 1, playerId: 'b', type: 'tower', radius: 14, x: 400, y: 300 }); // gap 78: chased
    const m = minion({ blockedBy: '1-2-2', blockedTicks: 120 });
    expect(minionAction(m, world([m, enemyWall, boxed]), cfgF)).toEqual({ action: 'attack', targetId: '1-2-2' });
    const farWall = mk({ id: '1-2-3', teamId: 1, playerId: 'b', type: 'wall', radius: 20, x: 300, y: 360 });
    const n = minion({ blockedBy: '1-2-3', blockedTicks: 300 });
    expect(minionAction(n, world([n, farWall, boxed]), cfgF)).toEqual({ action: 'move', destination: { x: 300, y: 360 } });
    const early = minion({ blockedBy: '1-2-2', blockedTicks: 119 });
    expect(minionAction(early, world([early, enemyWall, boxed]), cfgF)).toEqual({ action: 'move', destination: { x: 400, y: 300 } });
    const close = mk({ id: '1-0-5', teamId: 1, playerId: 'b', x: 300, y: 300 - 8 - 10 - 5 });
    const k = minion({ blockedBy: '1-2-2', blockedTicks: 500 });
    expect(minionAction(k, world([k, close, enemyWall, boxed]), cfgF)).toEqual({ action: 'attack', targetId: '1-0-5' });
  });

  it('sidesteps a tower or factory dead ahead instead of pushing into it forever', () => {
    const m = minion({ x: 200, y: 200 });
    const fac = mk({ id: '0-0-1', type: 'factory', radius: 18, x: 200 + 26, y: 200 }); // touching, exactly in line
    // +90° from the heading (east → south in screen coordinates).
    expect(sidestep(m, { x: 400, y: 200 }, { living: [m, fac] })).toEqual({ x: 200, y: 226 });
    // Leaning a little: it steps to the side it is already on.
    const up = mk({ id: '0-0-2', type: 'tower', radius: 14, x: 200 + 22, y: 202 });
    expect(sidestep(m, { x: 400, y: 200 }, { living: [m, up] })).toEqual({ x: 200, y: 178 });
    // Not in the way: off the line, behind, past the destination, not touching, or a soldier.
    expect(sidestep(m, { x: 400, y: 200 }, { living: [m, mk({ id: 'a', type: 'factory', radius: 18, x: 210, y: 222 })] })).toBeNull();
    expect(sidestep(m, { x: 0, y: 200 }, { living: [m, fac] })).toBeNull();
    expect(sidestep(m, { x: 205, y: 200 }, { living: [m, mk({ id: 'b', type: 'factory', radius: 18, x: 260, y: 200 })] })).toBeNull();
    expect(sidestep(m, { x: 400, y: 200 }, { living: [m, mk({ id: 'c', type: 'factory', radius: 18, x: 240, y: 200 })] })).toBeNull();
    expect(sidestep(m, { x: 400, y: 200 }, { living: [m, mk({ id: 'd', x: 218, y: 200 })] })).toBeNull();
    // minionAction uses it.
    const r = { ...factory, factory: { ...factory.factory!, rally: { x: 400, y: 200 } } } as SimUnit;
    const n = minion({ x: 200, y: 200, minion: { factory: r, n: 1 } });
    expect(minionAction(n, world([n, fac]), cfgF)).toEqual({ action: 'move', destination: { x: 200, y: 226 } });
  });
});

describe('minions in the sim: walls and buildings in the way (§5.2)', () => {
  it('break into an enemy boxed in by its own walls', async () => {
    const config = cfg(noSD, 3000);
    const ring = [[1, 1], [2, 1], [3, 1], [1, 2], [3, 2], [1, 3], [2, 3], [3, 3]].map(([c, r]) => at(c!, r!, 'w'));
    const rallyOnTower = scripted((_s, enemies) => {
      const t = enemies.find((e) => e.type === 'tower')!;
      return { action: 'rally', destination: { x: t.x, y: t.y } };
    });
    const { done } = run(
      [
        { playerId: 'a', seat: 0, zone: 'TL', units: [design('f', FACTORY(600), undefined, config)], placements: [at(0, 0, 'f')], brains: { f: rallyOnTower } },
        {
          playerId: 'b', seat: 1, zone: 'BR',
          units: [design('w', stats({ type: 'wall', maxHealth: 250 })), design('t', stats({ type: 'tower', damage: 5 }))],
          placements: [...ring, at(2, 2, 't')], brains: { t: idleBrain },
        },
      ],
      config,
    );
    const result = await done;
    expect(result.endReason).toBe('elimination');
    expect(result.units.filter((u) => u.type === 'wall').some((u) => !u.survived)).toBe(true);
    expect(result.players.find((p) => p.playerId === 'b')!.eliminatedAtTick).not.toBeNull();
  });

  it('get round their own factory when it sits exactly between them and the rally point', async () => {
    // Rally behind the factory (the zone corner), then ahead of it (the arena centre): same diagonal.
    const config = cfg(noSD, 4200);
    const behindThenAhead = scripted((_s, _e, _a, w) => ({ action: 'rally', destination: w.tick < 2600 ? { x: 20, y: 20 } : { x: 400, y: 400 } }));
    const { engine, done } = run(
      [{ playerId: 'a', seat: 0, zone: 'TL', units: [design('f', FACTORY(600), undefined, config)], placements: [at(2, 2, 'f')], brains: { f: behindThenAhead } }, farEnemy()],
      config,
    );
    await done;
    const last = engine.frames[engine.frames.length - 1]!;
    const ms = last.units.filter((u) => u[0].startsWith('0-2-2-m'));
    expect(ms.length).toBeGreaterThanOrEqual(3);
    for (const u of ms) expect(Math.hypot(u[1] - 400, u[2] - 400)).toBeLessThan(60);
  });
});

describe('credit, values and elimination with factories (§9.3)', () => {
  it("minion kills credit the factory's owner and its design (damage, KOs, value)", async () => {
    const config = cfg(noSD, 2000);
    const weak = stats({ type: 'soldier', maxHealth: 50, damage: 5 });
    const { done } = run(
      [
        { playerId: 'a', seat: 0, zone: 'TL', units: [design('f', FACTORY(600), undefined, config)], placements: [at(0, 0, 'f')], brains: { f: scripted(() => ({ action: 'rally', destination: { x: 560, y: 560 } })) } },
        { playerId: 'b', seat: 1, zone: 'BR', units: [design('s', weak), design('t', stats({ type: 'tower', damage: 5 }))], placements: [at(0, 0, 's'), at(5, 5, 't')], brains: { s: idleBrain, t: idleBrain } },
      ],
      config,
    );
    const result = await done;
    const minions = result.units.filter((u) => u.type === 'minion');
    const kills = minions.reduce((n, u) => n + u.kills, 0);
    expect(kills).toBeGreaterThanOrEqual(1);
    expect(minions.every((u) => u.playerId === 'a' && u.unitId === 'f')).toBe(true);
    const a = result.ranking.find((r) => r.playerId === 'a')!;
    expect(a.kills).toBeGreaterThanOrEqual(1);
    expect(a.valueDestroyed).toBeGreaterThanOrEqual(computeCost(weak, config.cost).cost);
  });

  it('a side with only a spent factory is eliminated; with minions left to make it is not', async () => {
    // a: a factory that can make exactly 1 minion in a 1300-tick battle (interval 1200 → E = 1).
    const config = cfg(noSD, 1300);
    const strong = stats({ type: 'soldier', maxHealth: 2500, damage: 300, attackCooldown: 10, speed: 4 });
    const minionHunter = scripted((self, enemies) => {
      const m = enemies.find((e) => e.type === 'minion');
      if (!m) return { action: 'idle' };
      const gap = Math.hypot(m.x - self.x, m.y - self.y) - self.radius - m.radius;
      return gap <= self.range ? { action: 'attack', targetId: m.id } : { action: 'move', destination: { x: m.x, y: m.y } };
    });
    const { engine, done } = run(
      [
        { playerId: 'a', seat: 0, zone: 'TL', units: [design('f', FACTORY(1200), undefined, config)], placements: [at(0, 0, 'f')], brains: { f: scripted(() => ({ action: 'rally', destination: { x: 400, y: 400 } })) } },
        { playerId: 'b', seat: 1, zone: 'BR', units: [design('s', strong)], placements: [at(0, 0, 's')], brains: { s: minionHunter } },
      ],
      config,
    );
    const result = await done;
    // Until tick 1200 the factory (1 minion left) keeps a alive.
    const minion = result.units.find((u) => u.instanceId === '0-0-0-m1')!;
    expect(minion.spawnedAtTick).toBe(1200);
    expect(minion.survived).toBe(false);
    const a = result.players.find((p) => p.playerId === 'a')!;
    expect(a.eliminatedAtTick).toBe(minion.diedAtTick);
    expect(result.endReason).toBe('elimination');
    // The spent factory crumbled with the elimination, credited to nobody.
    const crumble = events(engine.frames).find((x) => x.e.type === 'crumble');
    expect(crumble?.e).toEqual({ type: 'crumble', ids: ['0-0-0'] });
    expect(result.units.find((u) => u.instanceId === '0-0-0')!.survived).toBe(false);
  });

  it('timeout living value: factory body + $148 per unbuilt minion, minion $148, wall $0 (also from a frame)', async () => {
    const config = cfg(noSD, 1300);
    const { engine, done } = run(
      [
        { playerId: 'a', seat: 0, zone: 'TL', units: [design('f', FACTORY(600), undefined, config), design('w', WALL)], placements: [at(2, 2, 'f'), at(5, 5, 'w')], brains: { f: rallyHome } },
        farEnemy(),
      ],
      config,
    );
    const result = await done;
    // E = floor(1299 / 600) = 2 (priced for this battle length); both made by the end.
    const a = result.players.find((p) => p.playerId === 'a')!;
    expect(a.livingCost).toBe(247 + 0 * 148 + 2 * 148);
    // From the frame at t = 700: 1 minion made, 1 left.
    const frame = engine.frames.find((f) => f.t === 700)!;
    const placing = rankFromFrame(frame, result).find((p) => p.playerId === 'a')!;
    expect(placing.livingCost).toBe(247 + 1 * 148 + 1 * 148);
    expect(engine.metricsAt(700).find((m) => m.playerId === 'a')!.livingValue).toBe(247 + 2 * 148);
  });
});

describe('factories that never build (§9.3 canMake)', () => {
  it('canMake = min(minionsLeft, floor((timer + ticksLeft − 1) / interval)); a covered factory counts an empty timer', () => {
    const f = { minionsLeft: 8, timer: 0, productionInterval: 600, noSpot: false };
    expect(canMakeOf(f, 5400)).toBe(8); // = E at the start
    expect(canMakeOf({ ...f, minionsLeft: 7, timer: 0 }, 5400 - 600)).toBe(7); // unhindered: steady between spawns
    expect(canMakeOf({ ...f, minionsLeft: 7, timer: 599 }, 5400 - 1199)).toBe(7);
    expect(canMakeOf({ ...f, timer: 0 }, 1200)).toBe(1); // held: only what still fits
    expect(canMakeOf({ ...f, timer: 0 }, 600)).toBe(0);
    expect(canMakeOf({ ...f, timer: 600 }, 1)).toBe(1); // full timer: can spawn on the last tick
    expect(canMakeOf({ ...f, timer: 600 }, 0)).toBe(0); // nothing at the time limit
    expect(canMakeOf({ ...f, timer: 600, noSpot: true }, 600)).toBe(0);
    expect(canMakeOf({ ...f, minionsLeft: 0, timer: 600 }, 5000)).toBe(0);
  });

  it('a factory that holds forever loses its unbuilt minions over time and its side is out once it can no longer build one', async () => {
    const config = cfg(noSD);
    const hold = scripted(() => ({ action: 'hold' }));
    const { engine, done } = run(
      [{ playerId: 'a', seat: 0, zone: 'TL', units: [design('f', FACTORY(600), undefined, config), design('w', WALL)], placements: [at(2, 2, 'f'), at(0, 0, 'w')], brains: { f: hold } }, farEnemy()],
      config,
    );
    const result = await done;
    expect(spawns(engine.frames)).toEqual([]);
    // Full value at the start, then it shrinks as the time to build runs out.
    expect(engine.metricsAt(0).find((m) => m.playerId === 'a')!.livingValue).toBe(247 + 8 * 148);
    expect(engine.metricsAt(4000).find((m) => m.playerId === 'a')!.livingValue).toBe(247 + 2 * 148);
    const a = result.players.find((p) => p.playerId === 'a')!;
    expect(a.eliminatedAtTick).toBe(4800);
    expect(result.endReason).toBe('elimination');
    expect(result.ranking.find((r) => r.playerId === 'b')!.place).toBe(1);
  });

  it('a factory walled in by its own walls (no spawn spot) counts as stalled too', async () => {
    const config = cfg(noSD);
    const ring = [[1, 1], [2, 1], [3, 1], [1, 2], [3, 2], [1, 3], [2, 3], [3, 3]].map(([c, r]) => at(c!, r!, 'w'));
    const { engine, done } = run(
      [{ playerId: 'a', seat: 0, zone: 'TL', units: [design('f', FACTORY(600), undefined, config), design('w', WALL)], placements: [at(2, 2, 'f'), ...ring], brains: { f: rallyHome } }, farEnemy()],
      config,
    );
    const result = await done;
    expect(spawns(engine.frames)).toEqual([]);
    expect(result.players.find((p) => p.playerId === 'a')!.eliminatedAtTick).toBe(4800);
  });

  it('at the time limit a factory is worth its body only', async () => {
    // Capped at 1 alive and the minion stays alive: the factory never gets to build the rest.
    const config = cfg({ ...noSD, factory: { maxAlivePerFactory: 1 } }, 1900);
    const { done } = run(
      [{ playerId: 'a', seat: 0, zone: 'TL', units: [design('f', FACTORY(600), undefined, config)], placements: [at(2, 2, 'f')], brains: { f: rallyHome } }, farEnemy()],
      config,
    );
    const result = await done;
    const f = result.units.find((u) => u.instanceId === '0-2-2')!;
    expect(f.factory).toMatchObject({ minionsLeft: 2, canMake: 0 });
    expect(f.livingValue).toBe(247);
    expect(result.players.find((p) => p.playerId === 'a')!.livingCost).toBe(247 + 148);
  });
});

describe('performance smoke (the full worst case runs in the timing pass)', () => {
  it('8 players × (10 soldiers + 2 factories + 12 walls) run deterministically', async () => {
    const { buildingsWorstCase } = await import('./helpers/buildingsLoad.js');
    const a = await buildingsWorstCase({ ticks: 120, seed: 5 });
    const b = await buildingsWorstCase({ ticks: 120, seed: 5 });
    expect(a.frames).toEqual(b.frames);
    expect(a.result.units.filter((u) => u.type === 'wall')).toHaveLength(96);
    expect(a.result.units.filter((u) => u.type === 'factory')).toHaveLength(16);
  }, 60_000);
});

