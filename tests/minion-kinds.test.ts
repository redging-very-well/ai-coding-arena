// Minion kinds, squad orders and burst in the headless sim
// (M8.6): per-kind stats and behaviour, the four orders and their
// fallbacks, the store and release of a burst, caps, loss on the factory's
// death, and determinism.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  MINION_KIND_NAMES,
  deepMerge,
  type FrameDTO,
  type FrameEvent,
  type GameConfig,
  type MinionKind,
  type MinionOrder,
  type OtherView,
  type PlacementDTO,
} from '@pixel-clash/shared';
import { BattleEngine, type FactoryState, type SimUnit } from '../packages/server/src/sim/engine.js';
import { resolveAction } from '../packages/server/src/sim/actions.js';
import { minionAction, minionStats, minionsReveal } from '../packages/server/src/sim/minion.js';
import { isFighter, livingValueOf } from '../packages/server/src/sim/value.js';
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
type SpawnEv = { type: 'spawn'; instanceId: string; factoryId: string; x: number; y: number; kind?: MinionKind };
const spawns = (frames: FrameDTO[]) => events(frames).filter((x): x is { t: number; e: SpawnEv } => x.e.type === 'spawn' && 'factoryId' in x.e);
const ofType = <T extends FrameEvent['type']>(frames: FrameDTO[], type: T) =>
  events(frames).filter((x): x is { t: number; e: Extract<FrameEvent, { type: T }> } => x.e.type === type);
const frameAtT = (frames: FrameDTO[], t: number) => frames.find((f) => f.t === t)!;

/** A far-away enemy tower that never shoots and stays alive (no sudden death), so the battle runs on. */
const farEnemy = (): FakePlayerSpec => ({ playerId: 'b', seat: 1, zone: 'BR', units: [design('t', stats({ type: 'tower', damage: 5 }))], placements: [at(5, 5, 't')], brains: { t: idleBrain } });
const rallyHome = scripted((self) => ({ action: 'rally', destination: { x: self.x - 60, y: self.y - 60 } }));
const factoryOf = (engine: BattleEngine, id: string): SimUnit => (engine as unknown as { byId: Map<string, SimUnit> }).byId.get(id)!;

describe('minion kinds', () => {
  it('each kind has its config stats, its name in views and on reports, and rides on spawn events', async () => {
    const config = cfg(noSD, 700);
    const kinds: MinionKind[] = ['grunt', 'archer', 'runner', 'brute'];
    for (const kind of kinds) {
      const { engine, done } = run(
        [{ playerId: 'a', seat: 0, zone: 'TL', units: [design('f', FACTORY(600, { produces: kind }), undefined, config)], placements: [at(2, 2, 'f')], brains: { f: rallyHome } }, farEnemy()],
        config,
      );
      const result = await done;
      const s = spawns(engine.frames);
      expect(s.map((x) => x.e.kind)).toEqual([kind]);
      const m = result.units.find((u) => u.type === 'minion')!;
      const k = DEFAULT_CONFIG.factory.minions[kind];
      expect(m.unitName).toBe(MINION_KIND_NAMES[kind]);
      const body = factoryOf(engine, m.instanceId);
      expect(body.radius).toBe(k.size);
      expect(body.stats).toMatchObject({ maxHealth: k.maxHealth, damage: k.damage, range: k.range, speed: k.speed, attackCooldown: k.attackCooldown });
      // Its cost (value) is its kind's minionValue: grunt 177, archer 216, runner 263, brute 263 (redesign).
      expect(m.cost).toBe({ grunt: 177, archer: 216, runner: 263, brute: 263, medic: 248 }[kind]);
      const f = result.units.find((u) => u.type === 'factory')!;
      expect(f.factory!.minionValue).toBe(m.cost);
    }
  });

  it('the reveal lists every kind fielded', () => {
    const r = minionsReveal([FACTORY(600, { produces: 'archer' }), FACTORY(900), SOLDIER], DEFAULT_CONFIG);
    expect(Object.keys(r.minions!)).toEqual(['archer', 'grunt']);
    expect(r.minions!.archer!.value).toBe(216);
    expect(r.minions!.archer!.stats.name).toBe('Archer');
    expect(minionsReveal([SOLDIER])).toEqual({});
  });

  it('archers shoot homing projectiles from about 110 px and never melee', async () => {
    const config = cfg(noSD, 1500);
    const target = stats({ type: 'tower', damage: 5, maxHealth: 2500 });
    const { engine, done } = run(
      [
        { playerId: 'a', seat: 0, zone: 'TL', units: [design('f', FACTORY(600, { produces: 'archer' }), undefined, config)], placements: [at(0, 0, 'f')], brains: { f: scripted(() => ({ action: 'command', order: 'attack', destination: { x: 580, y: 580 } })) } },
        { playerId: 'b', seat: 1, zone: 'BR', units: [design('t', target)], placements: [at(0, 0, 't')], brains: { t: idleBrain } },
      ],
      config,
    );
    await done;
    const fires = ofType(engine.frames, 'fire').filter((x) => x.e.instanceId.includes('-m'));
    expect(fires.length).toBeGreaterThan(0);
    expect(fires.every((x) => x.e.melee === false)).toBe(true);
    // The first shot was fired from range, not from contact.
    const first = fires[0]!;
    const before = engine.frames.filter((f) => f.t <= first.t).at(-1)!;
    const m = before.units.find((u) => u[0] === first.e.instanceId)!;
    const gap = Math.hypot(m[1] - 580, m[2] - 580) - 7 - 14;
    expect(gap).toBeGreaterThan(80);
    expect(gap).toBeLessThanOrEqual(110.5 + 3);
    expect(engine.frames.some((f) => f.projectiles.length > 0)).toBe(true);
  });

  it('runners outrun grunts to a far rally point', async () => {
    const config = cfg(noSD, 1100);
    const reach = async (kind: MinionKind) => {
      const { engine, done } = run(
        [{ playerId: 'a', seat: 0, zone: 'TL', units: [design('f', FACTORY(600, { produces: kind }), undefined, config)], placements: [at(0, 0, 'f')], brains: { f: scripted(() => ({ action: 'rally', destination: { x: 700, y: 220 } })) } }, farEnemy()],
        config,
      );
      await done;
      const f = engine.frames.find((fr) => fr.units.some((u) => u[0] === '0-0-0-m1' && Math.hypot(u[1] - 700, u[2] - 220) < 30));
      return f?.t ?? Infinity;
    };
    const runner = await reach('runner');
    const grunt = await reach('grunt');
    expect(runner).toBeLessThan(grunt);
    expect(runner - 600).toBeLessThan((grunt - 600) * 0.7);
  });

  it('brutes deal ×3 on walls only, and one brute breaks a Basic Wall in about 33 s', async () => {
    const config = cfg(noSD, 6000);
    const basicWall = stats({ type: 'wall', maxHealth: 3200 }); // the Basic Wall template
    const target = stats({ type: 'tower', damage: 5, maxHealth: 2500 });
    // Swarm the wall first, then (when it is gone) the order falls back to attack the tower.
    const brain = scripted((_s, enemies) => {
      const w = enemies.find((e) => e.type === 'wall');
      return w ? { action: 'command', order: 'swarm', targetId: w.id } : { action: 'command', order: 'attack', destination: { x: 580, y: 580 } };
    });
    const { engine, done } = run(
      [
        { playerId: 'a', seat: 0, zone: 'TL', units: [design('f', FACTORY(1800, { produces: 'brute' }), undefined, config)], placements: [at(0, 0, 'f')], brains: { f: brain } },
        { playerId: 'b', seat: 1, zone: 'BR', units: [design('w', basicWall), design('t', target)], placements: [at(0, 0, 'w'), at(2, 0, 't')], brains: { t: idleBrain } },
      ],
      config,
    );
    const result = await done;
    const hits = ofType(engine.frames, 'hit').filter((x) => x.e.instanceId === '0-0-0-m1');
    const onWall = hits.filter((x) => x.e.targetId === '1-0-0');
    // 32 × 3 = 96 per hit: ceil(3200 / 96) = 34 hits, one a second.
    expect(onWall.length).toBe(34);
    expect(onWall.slice(0, -1).every((x) => x.e.damage === 96)).toBe(true);
    const span = onWall.at(-1)!.t - onWall[0]!.t;
    expect(span).toBe(33 * 60);
    const wall = result.units.find((u) => u.instanceId === '1-0-0')!;
    expect(wall.survived).toBe(false);
    const onTower = hits.filter((x) => x.e.targetId === '1-0-2');
    expect(onTower.length).toBeGreaterThan(0);
    expect(onTower.every((x) => x.e.damage === 32)).toBe(true); // ×1 on anything but walls
  });
});

// ---------------------------------------------------------------------------
// The minion AI per order, on hand-built bodies
// ---------------------------------------------------------------------------

describe('squad orders: the minion AI', () => {
  const mk = (over: Partial<SimUnit>): SimUnit => ({
    id: 'x', playerId: 'a', seat: 0, teamId: 0, unitId: 'u', stats: SOLDIER, cost: 92, type: 'soldier', radius: 10,
    x: 0, y: 0, hp: 100, maxHp: 100, cooldownRemaining: 0, alive: true, disabled: false, spawned: true,
    movedSinceFrame: false, firedSinceFrame: false, facingLeft: false, outsideSafeZone: false,
    damageDealt: 0, kills: 0, valueDestroyed: 0, strikes: 0, errors: [], diedAtTick: null, blockedBy: null, blockedTicks: 0,
    ...over,
  });
  const facState = (order: MinionOrder, orderTargetId: string | null = null): FactoryState => ({
    productionInterval: 600, timer: 0, minionsLeft: 3, canMake: 3, noSpot: false, made: 1, released: 1, kind: 'grunt', burst: 1, stored: 0,
    releaseRequested: false, order, orderTargetId, storedLost: 0, rally: { x: 400, y: 400 }, holding: false, bodyCost: 53, minionValue: 28,
    spawnedSinceFrame: false, minionsLost: 0,
  });
  const setup = (order: MinionOrder, targetId: string | null = null, kind: MinionKind = 'grunt') => {
    const factory = mk({ id: '0-0-0', type: 'factory', x: 100, y: 100, radius: 18 });
    factory.factory = facState(order, targetId);
    const minion = (over: Partial<SimUnit> = {}) =>
      mk({ id: '0-0-0-m1', type: 'minion', stats: minionStats(DEFAULT_CONFIG, '#C0A060', kind), radius: DEFAULT_CONFIG.factory.minions[kind].size, x: 300, y: 300, minion: { factory, n: 1, kind }, ...over });
    return { factory, minion };
  };
  const world = (living: SimUnit[], safeRadius = 570) => {
    const byId = new Map(living.map((u) => [u.id, u]));
    return { living, safeCenter: { x: 400, y: 400 }, safeRadius, rangeTolerance: 0.5, lookup: (id: string) => byId.get(id) };
  };
  const enemy = (id: string, x: number, y: number, over: Partial<SimUnit> = {}) => mk({ id, playerId: 'b', seat: 1, teamId: 1, x, y, ...over });
  const act = (m: SimUnit, w: ReturnType<typeof world>) => minionAction(m, w, DEFAULT_CONFIG) as { action: string; targetId?: string; destination?: { x: number; y: number } };

  it('defend: fights enemies within 160 px of the factory, else goes home and waits there', () => {
    const { factory, minion } = setup('defend');
    const m = minion({ x: 130, y: 130 });
    const near = enemy('1-0-0', 220, 150); // 125 px from the factory
    const far = enemy('1-0-1', 135, 135 + 200); // close to the minion but 236 px from the factory
    expect(act(m, world([factory, m, near, far]))).toMatchObject({ action: 'move', destination: { x: 220, y: 150 } });
    // Only the far one: it is ignored (attack order would chase it, aggro 120), the minion waits at home.
    expect(act(m, world([factory, m, far]))).toEqual({ action: 'idle' });
    const away = minion({ x: 300, y: 300 });
    expect(act(away, world([factory, away, far])).action).toBe('move');
    expect(act(away, world([factory, away, far])).destination).toEqual({ x: 100, y: 100 });
  });

  it('swarm: every minion goes for the one target past nearer enemies, walls included', () => {
    const target = enemy('1-5-5', 700, 700);
    const { factory, minion } = setup('swarm', target.id);
    const m = minion();
    const nearer = enemy('1-0-0', 320, 300); // in melee range of the minion
    expect(act(m, world([factory, m, nearer, target]))).toMatchObject({ action: 'move', destination: { x: 700, y: 700 } });
    // In range of the target: attack it.
    const close = minion({ x: 700 - 20, y: 700 });
    expect(act(close, world([factory, close, target]))).toEqual({ action: 'attack', targetId: target.id });
    // A wall can be the swarm target.
    const w = enemy('1-1-1', 340, 300, { type: 'wall', radius: 20, stats: WALL });
    const s2 = setup('swarm', w.id);
    const m2 = s2.minion();
    expect(act(m2, world([s2.factory, m2, w]))).toEqual({ action: 'attack', targetId: w.id });
  });

  it('swarm on a dead target or an ally acts as attack; guard on a dead ally or an enemy acts as defend', () => {
    const dead = enemy('1-5-5', 700, 700, { alive: false });
    const a = setup('swarm', dead.id);
    const m = a.minion({ x: 400, y: 400 });
    // Attack: idles at the rally point (400, 400) with no enemy near.
    expect(act(m, world([a.factory, m, dead]))).toEqual({ action: 'idle' });
    const g = setup('guard', '1-5-5');
    const gm = g.minion({ x: 300, y: 300 });
    const foe = enemy('1-5-5', 500, 500);
    // Defend: back to the factory (100, 100).
    expect(act(gm, world([g.factory, gm, foe])).destination).toEqual({ x: 100, y: 100 });
  });

  it('guard: follows the ally, fights enemies within 120 px of it, waits next to it', () => {
    const ally = mk({ id: '0-1-1', type: 'tower', x: 500, y: 300, radius: 14, stats: stats({ type: 'tower' }) });
    const { factory, minion } = setup('guard', ally.id);
    const m = minion({ x: 300, y: 300 });
    expect(act(m, world([factory, m, ally])).destination).toEqual({ x: 500, y: 300 });
    const next = minion({ x: 500 - 14 - 8 - 10, y: 300 });
    expect(act(next, world([factory, next, ally]))).toEqual({ action: 'idle' });
    const threat = enemy('1-0-0', 600, 330); // 104 px from the ally
    expect(act(next, world([factory, next, ally, threat])).destination).toEqual({ x: 600, y: 330 });
    const notThreat = enemy('1-0-0', 640, 300); // 140 px from the ally
    expect(act(next, world([factory, next, ally, notThreat]))).toEqual({ action: 'idle' });
  });

  it('brutes lose patience with a blocking enemy wall after 30 ticks, grunts after 120', () => {
    const w = enemy('1-1-1', 400, 300, { type: 'wall', radius: 20, stats: WALL });
    const b = setup('attack', null, 'brute');
    const brute = b.minion({ x: 300, y: 300, blockedBy: w.id, blockedTicks: 30 });
    expect(act(brute, world([b.factory, brute, w]))).toEqual({ action: 'move', destination: { x: 400, y: 300 } });
    const g = setup('attack');
    const grunt = g.minion({ x: 300, y: 300, blockedBy: w.id, blockedTicks: 30 });
    // Rally (400, 400) is 141 px away: it walks there instead.
    expect(act(grunt, world([g.factory, grunt, w])).destination).toEqual({ x: 400, y: 400 });
  });

  it('command/release: shapes the engine accepts; malformed commands and other types idle', () => {
    const fac = mk({ id: '0-0-0', type: 'factory', radius: 18 });
    const sol = mk({ id: '0-0-1', type: 'soldier' });
    const look = () => undefined;
    expect(resolveAction({ action: 'command', order: 'defend' }, fac, look, 0.5)).toEqual({ kind: 'command', order: 'defend', targetId: null, destination: null });
    expect(resolveAction({ action: 'command', order: 'swarm', targetId: 'x' }, fac, look, 0.5)).toMatchObject({ kind: 'command', order: 'swarm', targetId: 'x' });
    expect(resolveAction({ action: 'command', order: 'attack', destination: { x: -5, y: 900 } }, fac, look, 0.5)).toMatchObject({ destination: { x: 0, y: 800 } });
    expect(resolveAction({ action: 'release' }, fac, look, 0.5)).toEqual({ kind: 'release' });
    for (const bad of [{ action: 'command', order: 'charge' }, { action: 'command', order: 'swarm' }, { action: 'command', order: 'guard', targetId: 7 }, { action: 'command', order: 'attack', destination: { x: NaN, y: 1 } }]) {
      expect(resolveAction(bad, fac, look, 0.5)).toEqual({ kind: 'idle', reason: 'malformed' });
    }
    expect(resolveAction({ action: 'command', order: 'defend' }, sol, look, 0.5)).toEqual({ kind: 'idle', reason: 'wrong-type' });
    expect(resolveAction({ action: 'release' }, sol, look, 0.5)).toEqual({ kind: 'idle', reason: 'wrong-type' });
  });
});

// ---------------------------------------------------------------------------
// Orders in battle
// ---------------------------------------------------------------------------

describe('squad orders in battle', () => {
  it('rally = attack; a swarm whose target dies falls back to attack on the next tick, visible in self.factory', async () => {
    const config = cfg(noSD, 2000);
    const seen: Array<{ t: number; order: string; target: string | null }> = [];
    const brain = scripted((self, enemies, _a, world) => {
      seen.push({ t: world.tick, order: self.factory!.order, target: self.factory!.orderTargetId });
      if (world.tick === 0) return { action: 'rally', destination: { x: 300, y: 300 } };
      if (world.tick === 1) {
        const s = enemies.find((e) => e.type === 'soldier')!;
        return { action: 'command', order: 'swarm', targetId: s.id };
      }
      return { action: 'idle' };
    });
    // The enemy soldier dies at tick 900 by a scripted friendly-fire-free trick: our tower kills it.
    const killer = stats({ type: 'tower', range: 300, damage: 300, attackCooldown: 10 });
    const shoot = scripted((self, enemies, _a, world) => {
      const s = enemies.find((e) => e.type === 'soldier');
      if (!s || world.tick < 900 || self.cooldownRemaining > 0) return { action: 'idle' };
      return { action: 'attack', targetId: s.id };
    });
    const { engine, done } = run(
      [
        { playerId: 'a', seat: 0, zone: 'TL', units: [design('f', FACTORY(600), undefined, config), design('k', killer)], placements: [at(2, 2, 'f'), at(0, 0, 'k')], brains: { f: brain, k: shoot } },
        { playerId: 'b', seat: 1, zone: 'BR', units: [design('s', stats({ type: 'soldier', maxHealth: 500 })), design('t', stats({ type: 'tower', damage: 5 }))], placements: [at(0, 0, 's'), at(5, 5, 't')], brains: { s: scripted(() => ({ action: 'move', destination: { x: 420, y: 420 } })), t: idleBrain } },
      ],
      config,
    );
    const result = await done;
    expect(seen[0]).toEqual({ t: 0, order: 'attack', target: null });
    expect(seen[2]).toMatchObject({ order: 'swarm', target: '1-0-0' });
    const died = result.units.find((u) => u.instanceId === '1-0-0')!.diedAtTick!;
    expect(died).toBeGreaterThan(900);
    // The tick after the death the factory sees attack again.
    expect(seen.find((s) => s.t === died)).toEqual({ t: died, order: 'attack', target: null });
    expect(seen.find((s) => s.t === died - 1)!.order).toBe('swarm');
    // Frames carry the order code: 2 (swarm) before, 0 (attack) after.
    const before = engine.frames.filter((f) => f.t < died && f.t > 2).at(-1)!;
    expect(before.fac![0]![9]).toBe(2);
    expect(engine.frames.find((f) => f.t > died + 2)!.fac![0]![9]).toBe(0);
  });

  it('swarm on an ally and guard on an enemy fall back at once; malformed commands keep the order', async () => {
    const config = cfg(noSD, 700);
    const seen: string[] = [];
    const brain = scripted((self, enemies, allies, world) => {
      seen.push(self.factory!.order);
      if (world.tick === 0) return { action: 'command', order: 'defend' };
      if (world.tick === 1) return { action: 'command', order: 'charge' } as never;
      if (world.tick === 2) return { action: 'command', order: 'swarm', targetId: allies[0]!.id };
      if (world.tick === 3) return { action: 'command', order: 'guard', targetId: enemies[0]!.id };
      if (world.tick === 4) return { action: 'command', order: 'guard', targetId: self.id };
      return { action: 'idle' };
    });
    const own = stats({ type: 'tower', damage: 5 });
    const { done } = run(
      [{ playerId: 'a', seat: 0, zone: 'TL', units: [design('f', FACTORY(600), undefined, config), design('k', own)], placements: [at(2, 2, 'f'), at(5, 5, 'k')], brains: { f: brain, k: idleBrain } }, farEnemy()],
      config,
    );
    await done;
    expect(seen.slice(0, 6)).toEqual(['attack', 'defend', 'defend', 'attack', 'defend', 'guard']);
  });

  it('defend keeps the minions near the factory for the whole battle', async () => {
    const config = cfg(noSD, 3000);
    const { engine, done } = run(
      [{ playerId: 'a', seat: 0, zone: 'TL', units: [design('f', FACTORY(600), undefined, config)], placements: [at(0, 0, 'f')], brains: { f: scripted(() => ({ action: 'command', order: 'defend' })) } }, farEnemy()],
      config,
    );
    await done;
    const fx = 220;
    let maxD = 0;
    for (const f of engine.frames) for (const u of f.units) if (u[0].includes('-m')) maxD = Math.max(maxD, Math.hypot(u[1] - fx, u[2] - fx));
    expect(maxD).toBeGreaterThan(0);
    expect(maxD).toBeLessThanOrEqual(DEFAULT_CONFIG.factory.defendArriveRadius + 30);
    // The flag (focus) sits on the factory, order code 1.
    expect(frameAtT(engine.frames, 1000).fac![0]!.slice(3, 5)).toEqual([fx, fx]);
    expect(frameAtT(engine.frames, 1000).fac![0]![9]).toBe(1);
  });

  it('guard follows a moving ally; when the ally dies the order becomes defend', async () => {
    const config = cfg(noSD, 2400);
    const runnerSoldier = stats({ type: 'soldier', maxHealth: 300, speed: 1 });
    const walker = scripted((_s, _e, _a, world) => ({ action: 'move', destination: world.tick < 1500 ? { x: 400, y: 150 } : { x: 400, y: 150 } }));
    const brain = scripted((self, _e, allies) => {
      const s = allies.find((a) => a.type === 'soldier');
      return s ? { action: 'command', order: 'guard', targetId: s.id } : { action: 'idle' };
    });
    const killer = stats({ type: 'tower', range: 300, damage: 300, attackCooldown: 10 });
    const shoot = scripted((self, enemies, _a, world) => {
      const s = enemies.find((e) => e.type === 'soldier');
      if (!s || world.tick < 1700 || self.cooldownRemaining > 0) return { action: 'idle' };
      const gap = Math.hypot(s.x - self.x, s.y - self.y) - self.radius - s.radius;
      return gap <= self.range ? { action: 'attack', targetId: s.id } : { action: 'idle' };
    });
    const { engine, done } = run(
      [
        { playerId: 'a', seat: 0, zone: 'TL', units: [design('f', FACTORY(600), undefined, config), design('s', runnerSoldier)], placements: [at(2, 2, 'f'), at(0, 0, 's')], brains: { f: brain, s: walker } },
        { playerId: 'b', seat: 1, zone: 'TR', units: [design('k', killer)], placements: [at(0, 0, 'k')], brains: { k: shoot } },
      ],
      config,
    );
    const result = await done;
    // At t = 1400 the minion stands next to the soldier, wherever it went.
    const f1400 = frameAtT(engine.frames, 1400);
    const sol = f1400.units.find((u) => u[0] === '0-0-0')!;
    const m1 = f1400.units.find((u) => u[0] === '0-2-2-m1')!;
    expect(Math.hypot(m1[1] - sol[1], m1[2] - sol[2])).toBeLessThan(10 + 8 + 16 + 12);
    expect(f1400.fac![0]![9]).toBe(3);
    const died = result.units.find((u) => u.instanceId === '0-0-0')!.diedAtTick;
    expect(died).not.toBeNull();
    expect(engine.frames.find((f) => f.t > died! + 2)!.fac![0]![9]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Burst
// ---------------------------------------------------------------------------

describe('burst: store and release', () => {
  it('burst 3 stores two minions inside and releases three together at 3I; stored ones are invisible', async () => {
    const config = cfg(noSD, 2000);
    let maxSeenMinions = 0;
    const watcher = scripted((_s, enemies, _a, world) => {
      if (world.tick < 1800) maxSeenMinions = Math.max(maxSeenMinions, enemies.filter((e: OtherView) => e.type === 'minion').length);
      return { action: 'idle' };
    });
    const views: Array<{ t: number; stored: number; alive: number; burst: number }> = [];
    const brain = scripted((self, _e, _a, world) => {
      views.push({ t: world.tick, stored: self.factory!.stored, alive: self.factory!.minionsAlive, burst: self.factory!.burst });
      return { action: 'rally', destination: { x: self.x - 60, y: self.y - 60 } };
    });
    const { engine, done } = run(
      [
        { playerId: 'a', seat: 0, zone: 'TL', units: [design('f', FACTORY(600, { burst: 3 }), undefined, config)], placements: [at(2, 2, 'f')], brains: { f: brain } },
        { playerId: 'b', seat: 1, zone: 'BR', units: [design('t', stats({ type: 'tower', damage: 5 }))], placements: [at(5, 5, 't')], brains: { t: watcher } },
      ],
      config,
    );
    await done;
    const s = spawns(engine.frames);
    expect(s.map((x) => [x.t, x.e.instanceId])).toEqual([[1800, '0-2-2-m1'], [1800, '0-2-2-m2'], [1800, '0-2-2-m3']]);
    expect(ofType(engine.frames, 'release').map((x) => [x.t, x.e.factoryId, x.e.count])).toEqual([[1800, '0-2-2', 3]]);
    expect(maxSeenMinions).toBe(0);
    expect(views.find((v) => v.t === 1300)).toEqual({ t: 1300, stored: 2, alive: 0, burst: 3 });
    expect(views.find((v) => v.t === 1850)).toMatchObject({ stored: 0, alive: 3 });
    // Frames: stored and burst ride on fac; no stored minion is a frame unit.
    expect(frameAtT(engine.frames, 1300).fac![0]!.slice(7, 9)).toEqual([2, 3]);
    expect(frameAtT(engine.frames, 1300).units.some((u) => u[0].includes('-m'))).toBe(false);
  });

  it('release sends the stored minions out early', async () => {
    const config = cfg(noSD, 1500);
    const brain = scripted((self) => (self.factory!.stored >= 2 ? { action: 'release' } : { action: 'rally', destination: { x: self.x - 60, y: self.y - 60 } }));
    const { engine, done } = run([{ playerId: 'a', seat: 0, zone: 'TL', units: [design('f', FACTORY(600, { burst: 4 }), undefined, config)], placements: [at(2, 2, 'f')], brains: { f: brain } }, farEnemy()], config);
    await done;
    // Asked for at tick 1200, out at time 1201 (frames are every 2nd tick: the frame at 1202).
    expect(spawns(engine.frames).map((x) => [x.t, x.e.instanceId])).toEqual([[1202, '0-2-2-m1'], [1202, '0-2-2-m2']]);
    expect(ofType(engine.frames, 'release').map((x) => x.e.count)).toEqual([2]);
  });

  it('a full alive cap releases what is stored: two burst-4 factories share the per-player cap of 6 without deadlock', async () => {
    const config = cfg(noSD, 2400);
    const { engine, done } = run(
      [{ playerId: 'a', seat: 0, zone: 'TL', units: [design('f', FACTORY(600, { burst: 4 }), undefined, config)], placements: [at(2, 2, 'f'), at(4, 4, 'f')], brains: { f: rallyHome } }, farEnemy()],
      config,
    );
    await done;
    const s = spawns(engine.frames);
    expect(s.length).toBe(6);
    // Both stores reach 3 at time 1800 (6 = the cap), then both release on the next tick (frame 1802).
    expect(new Set(s.map((x) => x.t))).toEqual(new Set([1802]));
    const alive = Math.max(...engine.frames.map((f) => f.units.filter((u) => u[0].includes('-m')).length));
    expect(alive).toBe(6);
    // Stored + alive never exceeded the cap.
    for (const f of engine.frames) {
      const out = f.units.filter((u) => u[0].includes('-m')).length;
      const stored = (f.fac ?? []).reduce((a, x) => a + (x[7] ?? 0), 0);
      expect(out + stored).toBeLessThanOrEqual(6);
    }
  });

  it('the per-factory cap counts stored minions: a burst of 4 waits until all 4 are gone', async () => {
    const config = cfg(noSD, 5400);
    const { engine, done } = run([{ playerId: 'a', seat: 0, zone: 'TL', units: [design('f', FACTORY(600, { burst: 4 }), undefined, config)], placements: [at(2, 2, 'f')], brains: { f: rallyHome } }, farEnemy()], config);
    await done;
    expect(spawns(engine.frames).map((x) => x.t)).toEqual([2400, 2400, 2400, 2400]);
    // Afterwards the four are alive, so nothing is stored and the timer waits full.
    expect(frameAtT(engine.frames, 4000).fac![0]!.slice(1, 3)).toEqual([100, 4]);
    expect(frameAtT(engine.frames, 4000).fac![0]![7]).toBe(0);
  });

  it('with nothing left to make (or no time) the store empties itself', async () => {
    const config = cfg(noSD, 5400);
    // Interval 1800: E = 2, so a burst of 4 never fills: both leave once the 2nd is made.
    const { engine, done } = run([{ playerId: 'a', seat: 0, zone: 'TL', units: [design('f', FACTORY(1800, { burst: 4 }), undefined, config)], placements: [at(2, 2, 'f')], brains: { f: rallyHome } }, farEnemy()], config);
    await done;
    expect(spawns(engine.frames).map((x) => x.t)).toEqual([3602, 3602]);
    // Interval 600 with burst 4 in a 2000-tick battle: 3 can be made, the 3rd is the last in time.
    const short = cfg(noSD, 2000);
    const r2 = run([{ playerId: 'a', seat: 0, zone: 'TL', units: [design('f', FACTORY(600, { burst: 4 }), undefined, short)], placements: [at(2, 2, 'f')], brains: { f: rallyHome } }, farEnemy()], short);
    await r2.done;
    expect(spawns(r2.engine.frames).map((x) => x.t)).toEqual([1802, 1802, 1802]);
  });

  it("the factory's death loses its stored minions (credited to the killer as value)", async () => {
    const config = cfg(noSD, 2400);
    const strong = stats({ type: 'soldier', maxHealth: 2500, damage: 300, attackCooldown: 10, speed: 4 });
    const hunter = scripted((self, enemies, _a, world) => {
      if (world.tick < 1300) return { action: 'idle' };
      const f = enemies.find((e) => e.type === 'factory');
      if (!f) return { action: 'idle' };
      const gap = Math.hypot(f.x - self.x, f.y - self.y) - self.radius - f.radius;
      return gap <= self.range ? { action: 'attack', targetId: f.id } : { action: 'move', destination: { x: f.x, y: f.y } };
    });
    const { engine, done } = run(
      [
        { playerId: 'a', seat: 0, zone: 'TL', units: [design('f', FACTORY(600, { burst: 4 }), undefined, config), design('k', stats({ type: 'tower', damage: 5 }))], placements: [at(0, 0, 'f'), at(5, 5, 'k')], brains: { f: rallyHome, k: idleBrain } },
        { playerId: 'b', seat: 1, zone: 'BR', units: [design('s', strong)], placements: [at(0, 0, 's')], brains: { s: hunter } },
      ],
      config,
    );
    const result = await done;
    const f = result.units.find((u) => u.instanceId === '0-0-0')!;
    expect(f.survived).toBe(false);
    expect(spawns(engine.frames)).toEqual([]);
    expect(f.factory).toMatchObject({ minionsMade: 2, minionsLost: 2, storedLost: 2, stored: 0 });
    expect(ofType(engine.frames, 'lost').map((x) => [x.e.factoryId, x.e.count])).toEqual([['0-0-0', 2]]);
    // Value destroyed: body $167 + $177 × (canMake 1 + stored 2) in this 2400-tick battle (E = 3).
    expect(result.units.find((u) => u.instanceId === '1-0-0')!.valueDestroyed).toBe(167 + 177 * 3);
  });

  it('stored minions keep a factory a fighter and count in its living value', () => {
    const fac = (canMake: number, stored: number) => ({ type: 'factory' as const, cost: 0, factory: { canMake, stored, bodyCost: 53, minionValue: 28 } as FactoryState });
    expect(isFighter(fac(0, 0))).toBe(false);
    expect(isFighter(fac(0, 2))).toBe(true);
    expect(livingValueOf(fac(1, 2))).toBe(53 + 3 * 28);
  });

  it('burst 1 is frame-identical to a factory without burst (M8.5 behaviour)', async () => {
    const config = cfg(noSD, 3000);
    const go = async (f: ReturnType<typeof FACTORY>) => {
      const { engine, done } = run([{ playerId: 'a', seat: 0, zone: 'TL', units: [design('f', f, undefined, config)], placements: [at(2, 2, 'f'), at(4, 4, 'f')], brains: { f: rallyHome } }, farEnemy()], config);
      await done;
      return JSON.stringify(engine.frames);
    };
    const plain = { ...FACTORY(600) } as Record<string, unknown>;
    delete plain.burst;
    delete plain.produces;
    expect(await go(FACTORY(600, { burst: 1, produces: 'grunt' }))).toBe(await go(plain as ReturnType<typeof FACTORY>));
  });
});

describe('determinism with kinds, orders and bursts', () => {
  it('shuffled placements give identical frames', async () => {
    const config = cfg({}, 2400);
    const smart = scripted((self, enemies, allies, world) => {
      if (self.factory!.stored >= 2 && world.tick % 2 === 0) return { action: 'release' };
      const weakest = enemies.filter((e) => e.type !== 'wall').sort((a, b) => a.hp - b.hp || (a.id < b.id ? -1 : 1))[0];
      if (world.tick % 400 < 200 && weakest) return { action: 'command', order: 'swarm', targetId: weakest.id };
      const t = allies.find((a) => a.type === 'tower');
      return t ? { action: 'command', order: 'guard', targetId: t.id } : { action: 'command', order: 'defend' };
    });
    const units = (seat: number) => [
      design('fa', FACTORY(600, { produces: 'archer', burst: 2 }), undefined, config),
      design('fr', FACTORY(600, { produces: seat ? 'brute' : 'runner', burst: 4 }), undefined, config),
      design('t', stats({ type: 'tower' })),
      design('s', SOLDIER),
      design('w', WALL),
    ];
    const place = (rev: boolean): PlacementDTO[] => {
      const p = [at(1, 2, 'fa'), at(3, 2, 'fr'), at(2, 3, 't'), at(0, 0, 's'), at(1, 0, 'w'), at(3, 0, 'w')];
      return rev ? p.reverse() : p;
    };
    const go = async (rev: boolean) => {
      const { engine, done } = run(
        [
          { playerId: 'a', seat: 0, zone: 'TL', units: units(0), placements: place(rev), brains: { fa: smart, fr: smart, t: idleBrain, s: idleBrain } },
          { playerId: 'b', seat: 1, zone: 'BR', units: units(1), placements: place(!rev), brains: { fa: smart, fr: smart, t: idleBrain, s: idleBrain } },
        ],
        config,
        11,
      );
      await done;
      return engine.frames;
    };
    const a = await go(false);
    const b = await go(true);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    // The mix really ran: kinds, a release, and the orders.
    const kinds = new Set(spawns(a).map((x) => x.e.kind));
    expect(kinds).toEqual(new Set(['archer', 'runner', 'brute']));
    expect(ofType(a, 'release').length).toBeGreaterThan(0);
  }, 30_000); // two 2400-tick battles of factories and walls: allow for a busy machine
});
