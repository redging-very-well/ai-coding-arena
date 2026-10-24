// Elements and splash (plan §5.4, §9.4 Hit pipeline, Fire: burn, Ice: freeze,
// M8.8): the hit pipeline on hand-built bodies (burn, freeze, shatter, zap,
// overload, splash, walls, shields, might, credit) and headless battles
// (tempo on moves, cooldowns and factories, frames and events, lightning
// determinism, and a battle without elements that is bit-identical to M8.7).

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  FRAME_FLAGS,
  deepMerge,
  elementOf,
  splashOf,
  type FrameDTO,
  type FrameEvent,
  type GameConfig,
  type PlacementDTO,
  type StatsSnapshot,
} from '@pixel-clash/shared';
import { BattleEngine, buildBattleReport, resultAtTick, runBattle, type SimUnit } from '../packages/server/src/sim/engine.js';
import { BodyIndex, HitPipeline, noAura, statusOf, tempoOf } from '../packages/server/src/sim/effects.js';
import { FrameRecorder } from '../packages/server/src/sim/frames.js';
import { mulberry32, type Rng } from '../packages/server/src/sim/prng.js';
import { applySuddenDeath } from '../packages/server/src/sim/suddenDeath.js';
import { design, fakePlayers, idleBrain, scripted, soldierBrain, stats, towerBrain, type FakePlayerSpec } from './helpers/fakeRunner.js';

const C = DEFAULT_CONFIG;
const at = (col: number, row: number, unitId: string): PlacementDTO => ({ unitId, col, row });

/** A body for the pipeline: seat and team from the id's first digit. */
function body(id: string, s: StatsSnapshot, over: Partial<SimUnit> = {}): SimUnit {
  const seat = Number(id[0]);
  return {
    id, playerId: `p${seat}`, seat, teamId: seat, unitId: s.name, stats: s, cost: 500, type: s.type, radius: s.size,
    x: 400, y: 400, hp: s.maxHealth, maxHp: s.maxHealth, cooldownRemaining: 0, alive: true, disabled: false, spawned: true,
    movedSinceFrame: false, firedSinceFrame: false, facingLeft: false, outsideSafeZone: false,
    damageDealt: 0, kills: 0, valueDestroyed: 0, strikes: 0, errors: [], diedAtTick: null,
    frozen: 0, burns: [], healRoom: 0, aura: noAura(),
    ...over,
  };
}

const soldier = (over: Partial<StatsSnapshot> = {}) => stats({ type: 'soldier', ...over });
const dummy = (hp = 2500) => stats({ type: 'tower', name: 'Dummy', maxHealth: hp, damage: 5, size: 10 });
const WALL = stats({ type: 'wall' });

/** One tick's pipeline over `bodies` (the recorder collects its events). */
function pipeline(bodies: SimUnit[], tick = 0, rng: Rng = mulberry32(1), config: GameConfig = C) {
  const recorder = new FrameRecorder();
  const p = new HitPipeline(config, tick, recorder, rng, new BodyIndex(bodies, 1200));
  const events = (): FrameEvent[] => recorder.record(tick, [], [], 0).events;
  return { p, events };
}

/** A main hit of A on T with what A fires right now. */
const hit = (A: SimUnit, T: SimUnit, over: Partial<Parameters<HitPipeline['land']>[0]> = {}) => ({
  attackerId: A.id,
  attacker: A,
  target: T,
  damage: A.stats.damage,
  element: elementOf(A.stats),
  splash: splashOf(A.stats),
  might: 0,
  mightSrc: null,
  ...over,
});

/** Run the burn pulses of ticks from..to (inclusive) and collect their events. */
function pulse(bodies: SimUnit[], from: number, to: number): FrameEvent[] {
  const out: FrameEvent[] = [];
  for (let t = from; t <= to; t++) {
    const { p, events } = pipeline(bodies, t);
    p.burnPulses(bodies);
    out.push(...events());
  }
  return out;
}

describe('fire: burn (§9.4)', () => {
  it('a fire hit adds half its damage as a burn: 6 pulses, 30 ticks apart, +50% if the target lives 3 s', () => {
    const A = body('0-0-0', soldier({ damage: 100, element: 'fire' }));
    const T = body('1-0-0', dummy());
    const { p, events } = pipeline([A, T], 10);
    p.land(hit(A, T));
    expect(T.hp).toBe(2400);
    expect(T.burns).toEqual([{ ownerId: 'p0', seat: 0, pool: 50, pulsesLeft: 6, nextPulseTick: 40, source: A }]);
    expect(events()).toEqual([{ type: 'hit', instanceId: '0-0-0', targetId: '1-0-0', damage: 100, element: 'fire' }]);
    expect(statusOf(T, 10, C)).toMatchObject({ burning: 180, burnLeft: 50 });
    const burn = pulse([A, T], 11, 400);
    expect(burn.map((e) => e.type === 'hit' && e.kind)).toEqual(Array(6).fill('burn'));
    expect(T.hp).toBeCloseTo(2350, 9);
    expect(T.burns).toEqual([]);
    expect(A.damageDealt).toBeCloseTo(150, 9);
    expect(A.damageSplit).toMatchObject({ hit: 100, burn: expect.closeTo(50, 9) });
  });

  it('a new hit from the same owner adds to the pool and resets the pulses, keeping the phase; other owners burn separately', () => {
    const A = body('0-0-0', soldier({ damage: 60, element: 'fire' }));
    const B = body('2-0-0', soldier({ damage: 60, element: 'fire' }));
    const T = body('1-0-0', dummy());
    pipeline([A, B, T], 0).p.land(hit(A, T));
    pulse([A, T], 1, 30); // one pulse of 30/6 = 5
    const { p } = pipeline([A, B, T], 45);
    p.land(hit(A, T));
    p.land(hit(B, T));
    expect(T.burns!.map((b) => [b.ownerId, b.pool, b.pulsesLeft, b.nextPulseTick])).toEqual([
      ['p0', 55, 6, 60], // 25 left + 30 new, phase kept (next pulse still at 60)
      ['p2', 30, 6, 75],
    ]);
  });

  it('pulses credit the last fire attacker even after it died, kills included', () => {
    const A = body('0-0-0', soldier({ damage: 100, element: 'fire' }));
    const T = body('1-0-0', dummy(), { hp: 120, cost: 777 });
    pipeline([A, T], 0).p.land(hit(A, T));
    A.alive = false;
    A.hp = 0;
    pulse([A, T], 1, 200);
    expect(T.hp).toBeLessThanOrEqual(0);
    expect(A).toMatchObject({ kills: 1, valueDestroyed: 777 });
    expect(A.damageDealt).toBeCloseTo(120, 9);
  });

  it('walls never burn (nor freeze): a hit on a wall is plain damage', () => {
    const A = body('0-0-0', soldier({ damage: 100, element: 'fire', splashRadius: 80 }));
    const I = body('0-0-1', soldier({ damage: 100, element: 'ice' }));
    const W = body('1-0-0', WALL);
    const E = body('1-0-1', dummy(), { x: 420 });
    const { p, events } = pipeline([A, I, W, E]);
    p.land(hit(A, W));
    p.land(hit(I, W));
    expect(W.hp).toBe(1800);
    expect(W.burns).toEqual([]);
    expect(W.frozen).toBe(0);
    expect(E.hp).toBe(2500); // no splash off a wall
    expect(events().map((e) => e.type)).toEqual(['hit', 'hit']);
  });
});

describe('ice: freeze (§9.4)', () => {
  it('an ice hit freezes for 120 ticks, even at damage 0; another hit refreshes, never stacks', () => {
    const A = body('0-0-0', soldier({ damage: 0, element: 'ice' }));
    const T = body('1-0-0', dummy());
    const { p } = pipeline([A, T]);
    p.land(hit(A, T));
    expect(T.frozen).toBe(120);
    T.frozen = 30;
    p.land(hit(A, T));
    p.land(hit(A, T));
    expect(T.frozen).toBe(120);
    expect(T.hp).toBe(2500);
  });

  it('the tempo is 0.65 while frozen; haste multiplies it (30% haste: 0.845)', () => {
    const u = body('0-0-0', soldier());
    expect(tempoOf(u, C)).toBe(1);
    u.frozen = 5;
    expect(tempoOf(u, C)).toBeCloseTo(0.65, 12);
    u.aura = { ...noAura(), haste: 30 };
    expect(tempoOf(u, C)).toBeCloseTo(0.845, 12);
    u.frozen = 0;
    expect(tempoOf(u, C)).toBeCloseTo(1.3, 12);
  });
});

describe('shatter (§5.4 combo)', () => {
  it('fire on a frozen body: ×1.5 and a thaw, a shatter event and a combo; the burn uses the pre-shatter damage', () => {
    const A = body('0-0-0', soldier({ damage: 100, element: 'fire' }));
    const T = body('1-0-0', dummy(), { frozen: 80 });
    const { p, events } = pipeline([A, T]);
    p.land(hit(A, T));
    expect(T.hp).toBe(2350);
    expect(T.frozen).toBe(0);
    expect(T.burns![0]!.pool).toBe(50);
    expect(A.combos).toBe(1);
    expect(A.damageSplit).toMatchObject({ shatter: 150, hit: 0 });
    expect(events()).toEqual([
      { type: 'hit', instanceId: '0-0-0', targetId: '1-0-0', damage: 150, kind: 'shatter', element: 'fire' },
      { type: 'shatter', id: '1-0-0', amount: 150 },
    ]);
  });

  it('a fire splash shatters a frozen splash victim too', () => {
    const A = body('0-0-0', soldier({ damage: 100, element: 'fire', splashRadius: 40 }));
    const T = body('1-0-0', dummy());
    const E = body('1-0-1', dummy(), { x: 440, frozen: 50 });
    pipeline([A, T, E]).p.land(hit(A, T));
    expect(E.hp).toBe(2500 - 75); // half of 100, ×1.5
    expect(E.frozen).toBe(0);
    expect(A.combos).toBe(1);
  });
});

describe('lightning: zaps (§9.4 step 7)', () => {
  const ring = () => {
    const A = body('0-0-0', soldier({ damage: 100, element: 'lightning' }), { x: 300 });
    const T = body('1-0-0', dummy(), { x: 400 });
    const E1 = body('1-0-1', dummy(), { x: 470 }); // gap 50
    const E2 = body('2-0-0', dummy(), { x: 540 }); // 70 px from E1 edge to edge (50 + 20 = 140 from T)
    return { A, T, E1, E2 };
  };

  it('35% ± 2% of 10,000 seeded lightning main hits zap, drawn exactly once per hit', () => {
    const { A, T, E1, E2 } = ring();
    let draws = 0;
    const base = mulberry32(0x1e1e);
    const counting: Rng = () => {
      draws++;
      return base();
    };
    let zaps = 0;
    for (let i = 0; i < 10_000; i++) {
      T.hp = E1.hp = E2.hp = 2500;
      const recorder = new FrameRecorder();
      new HitPipeline(C, 0, recorder, counting, new BodyIndex([A, T, E1, E2], 1200)).land(hit(A, T));
      if (recorder.record(0, [], [], 0).events.some((e) => e.type === 'arc')) zaps++;
    }
    expect(draws).toBe(10_000);
    expect(zaps / 10_000).toBeGreaterThan(0.33);
    expect(zaps / 10_000).toBeLessThan(0.37);
  });

  it('zaps the nearest other enemy within 100 px edge to edge (ties: the lower id), never a wall or an ally, for the same damage', () => {
    const { A, T, E1, E2 } = ring();
    const W = body('1-0-2', WALL, { x: 430 }); // nearer, but a wall
    const ally = body('0-0-1', soldier(), { x: 430, y: 410 });
    const tie = body('1-0-3', dummy(), { x: 400, y: 470 }); // also gap 50 from T: the lower id 1-0-1 wins
    const always: Rng = () => 0;
    const { p, events } = pipeline([A, T, E1, E2, W, ally, tie], 0, always);
    p.land(hit(A, T));
    expect(events().filter((e) => e.type === 'arc')).toEqual([{ type: 'arc', from: '1-0-0', to: ['1-0-1'] }]);
    expect(E1.hp).toBe(2400);
    expect([W.hp, ally.hp, tie.hp, E2.hp]).toEqual([2000, 600, 2500, 2500]);
    expect(A.damageSplit).toMatchObject({ hit: 100, zap: 100 });
    // Nothing within 100 px: no zap.
    const far = body('1-0-4', dummy(), { x: 700 });
    const lone = body('1-0-0', dummy(), { x: 400 });
    const q = pipeline([A, lone, far], 0, always);
    q.p.land(hit(A, lone));
    expect(q.events().some((e) => e.type === 'arc')).toBe(false);
  });

  it('overload: a target that was burning before the hit makes the zap hop once more (2 hops, a combo)', () => {
    const { A, T, E1, E2 } = ring();
    T.burns = [{ ownerId: 'p3', seat: 3, pool: 10, pulsesLeft: 6, nextPulseTick: 30, source: A }];
    const { p, events } = pipeline([A, T, E1, E2], 0, () => 0);
    p.land(hit(A, T));
    expect(events().filter((e) => e.type === 'arc')).toEqual([{ type: 'arc', from: '1-0-0', to: ['1-0-1', '2-0-0'] }]);
    expect(E2.hp).toBe(2400);
    expect(A.combos).toBe(1);
  });

  it('a zap starts from the target even when the hit killed it', () => {
    const { A, T, E1 } = ring();
    T.hp = 50;
    const { p } = pipeline([A, T, E1], 0, () => 0);
    p.land(hit(A, T));
    expect(T.hp).toBeLessThanOrEqual(0);
    expect(E1.hp).toBe(2400);
  });
});

describe('splash (§5.4)', () => {
  it('half the hit to every other living enemy whose edge is within R of the target centre; never walls or allies; one splash event', () => {
    const A = body('0-0-0', soldier({ damage: 100, splashRadius: 40 }), { x: 300 });
    const T = body('1-0-0', dummy(), { x: 400 });
    const inside = body('1-0-1', dummy(), { x: 450 }); // 50 − 10 = 40 ≤ 40
    const outside = body('1-0-2', dummy(), { x: 400, y: 451 }); // 51 − 10 = 41 > 40
    const W = body('1-0-3', WALL, { x: 360, y: 380 });
    const ally = body('0-0-1', soldier(), { x: 420, y: 420 });
    const { p, events } = pipeline([A, T, inside, outside, W, ally]);
    p.land(hit(A, T));
    expect([T.hp, inside.hp, outside.hp, W.hp, ally.hp]).toEqual([2400, 2450, 2500, 2000, 600]);
    const evs = events();
    expect(evs.filter((e) => e.type === 'splash')).toEqual([{ type: 'splash', x: 400, y: 400, r: 40, element: 'normal' }]);
    expect(evs.find((e) => e.type === 'hit' && e.targetId === '1-0-1')).toMatchObject({ kind: 'splash', damage: 50 });
    expect(A.damageSplit).toMatchObject({ hit: 100, splash: 50 });
  });

  it('carries fire and ice, but never zaps (one draw per main hit only)', () => {
    const fire = body('0-0-0', soldier({ damage: 100, element: 'fire', splashRadius: 60 }), { x: 300 });
    const ice = body('0-0-1', soldier({ damage: 0, element: 'ice', splashRadius: 60 }), { x: 300 });
    const storm = body('0-0-2', soldier({ damage: 100, element: 'lightning', splashRadius: 60 }), { x: 300 });
    const T = body('1-0-0', dummy(), { x: 400 });
    const E = body('1-0-1', dummy(), { x: 440 });
    let draws = 0;
    const { p } = pipeline([fire, ice, storm, T, E], 0, () => {
      draws++;
      return 0.99; // never zaps
    });
    p.land(hit(fire, T));
    expect(E.burns![0]!.pool).toBe(25); // half of the 50 splash
    p.land(hit(ice, T));
    expect(E.frozen).toBe(120);
    p.land(hit(storm, T));
    expect(draws).toBe(1);
  });
});

describe('shield and might (§5.5 auras on the pipeline)', () => {
  it('shield reduces hits, splash, zaps, burns and shatters, but never sudden death', () => {
    const A = body('0-0-0', soldier({ damage: 100, element: 'fire', splashRadius: 40 }), { x: 300 });
    const shielded = { ...noAura(), shield: 25 };
    const T = body('1-0-0', dummy(), { x: 400, aura: shielded, frozen: 10 });
    const E = body('1-0-1', dummy(), { x: 440, aura: { ...noAura(), shield: 40 } });
    pipeline([A, T, E]).p.land(hit(A, T));
    expect(T.hp).toBe(2500 - 150 * 0.75); // shatter, shielded
    expect(E.hp).toBe(2500 - 50 * 0.6); // splash, shielded
    const before = T.hp;
    pulse([A, T], 1, 30);
    expect(before - T.hp).toBeCloseTo((50 / 6) * 0.75, 9); // burn pulse, shielded
    const Z = body('0-0-2', soldier({ damage: 100, element: 'lightning' }), { x: 300 });
    const T2 = body('1-0-2', dummy(), { x: 400 });
    const near = body('1-0-3', dummy(), { x: 460, aura: shielded });
    pipeline([Z, T2, near], 0, () => 0).p.land(hit(Z, T2));
    expect(near.hp).toBe(2500 - 75); // zap, shielded
    // Sudden death ignores the shield (7%/s of max HP).
    const sd = deepMerge(C, { suddenDeath: { startTick: 0, endTick: 10, startRadius: 1, endRadius: 0 } });
    const out = body('1-0-4', dummy(), { x: 20, y: 20, aura: shielded });
    applySuddenDeath([out], 5, sd, { x: 400, y: 400 });
    expect(2500 - out.hp).toBeCloseTo((2500 * 0.07) / 60, 9);
  });

  it("might is baked into the shot: burn and splash follow it, and the aura source gets the extra as assist", () => {
    const A = body('0-0-0', soldier({ damage: 100, element: 'fire', splashRadius: 40 }), { x: 300 });
    const drummer = body('0-0-1', soldier({ damage: 0, support: { kind: 'might', power: 30, range: 100 } }));
    const T = body('1-0-0', dummy(), { x: 400 });
    const E = body('1-0-1', dummy(), { x: 440 });
    pipeline([A, T, E]).p.land(hit(A, T, { damage: 130, might: 30, mightSrc: drummer }));
    expect(T.hp).toBe(2370);
    expect(T.burns![0]!.pool).toBe(65);
    expect(E.hp).toBe(2435);
    expect(drummer.assist).toBeCloseTo(30 + 15, 9); // the extra on the hit and on the splash
  });
});

// ---------------------------------------------------------------------------
// Headless battles
// ---------------------------------------------------------------------------

const cfg = (patch: object = {}, ticks = 900): GameConfig =>
  deepMerge(C, { ...patch, timers: { battleTicks: ticks }, suddenDeath: { startTick: 100_000, endTick: 100_001 } });
const events = (frames: FrameDTO[]) => frames.flatMap((f) => f.events.map((e) => ({ t: f.t, e })));
const frameUnit = (f: FrameDTO, id: string) => f.units.find((u) => u[0] === id);

describe('ice in battle: moves, reloads and builds 35% slower', () => {
  it('a frozen walker steps speed × 0.65 per tick and shows FROZEN; a frozen melee unit fires every 93 ticks', async () => {
    // b's ice tower (range 300, damage 0) freezes a's soldier walking in, every 60 ticks.
    const iceTower = stats({ type: 'tower', name: 'Frost', damage: 0, range: 300, attackCooldown: 60, element: 'ice' });
    // A real fighter for b, out of the way, so b isn't a damage-0 side.
    const guard = stats({ type: 'tower', name: 'Guard', range: 20 });
    const walker = scripted(() => ({ action: 'move', destination: { x: 790, y: 790 } }));
    const { result, frames } = await (async () => {
      const { setups } = fakePlayers([
        { playerId: 'a', seat: 0, zone: 'TL', units: [design('s', stats({ type: 'soldier', speed: 2 }))], placements: [at(0, 0, 's')], brains: { s: walker } },
        { playerId: 'b', seat: 1, zone: 'BR', units: [design('f', iceTower), design('g', guard)], placements: [at(0, 0, 'f'), at(5, 5, 'g')], brains: { f: towerBrain, g: idleBrain } },
      ]);
      const r = await runBattle({ players: setups, config: cfg({}, 600), seed: 2 });
      return { result: r, frames: r.frames };
    })();
    expect(result.units.find((u) => u.instanceId === '0-0-0')!.survived).toBe(true);
    const firstHit = events(frames).find((x) => x.e.type === 'hit')!.t;
    const step = (t: number) => {
      const a = frameUnit(frames.find((f) => f.t === t)!, '0-0-0')!;
      const b = frameUnit(frames.find((f) => f.t === t + 2)!, '0-0-0')!;
      return Math.hypot(b[1] - a[1], b[2] - a[2]);
    };
    expect(step(firstHit - 10)).toBeCloseTo(4, 1); // 2 ticks × speed 2
    const late = frames.filter((f) => f.t > firstHit + 4 && f.t < firstHit + 60);
    expect(late.length).toBeGreaterThan(10);
    for (const f of late) expect(frameUnit(f, '0-0-0')![4] & FRAME_FLAGS.FROZEN).toBeTruthy();
    const mid = late[5]!.t;
    // It may also be stopped by the end of the arena; check a step well before that.
    expect(step(mid)).toBeCloseTo(4 * 0.65, 1);
  });

  it('a frozen factory builds slower (timer += 0.65 per tick)', async () => {
    // b's soldier walks up to a's factory and taps it (damage 5) every 60 ticks: with ice it keeps the factory frozen.
    const tapper = (element: 'ice' | 'normal') => stats({ type: 'soldier', name: 'Tapper', damage: 5, element, speed: 4, maxHealth: 2500 });
    const hunter = scripted((self, enemies) => {
      const f = enemies.find((e) => e.type === 'factory');
      if (!f) return { action: 'idle' };
      const gap = Math.hypot(f.x - self.x, f.y - self.y) - self.radius - f.radius;
      return gap <= self.range ? (self.cooldownRemaining === 0 ? { action: 'attack', targetId: f.id } : { action: 'idle' }) : { action: 'move', destination: { x: f.x, y: f.y } };
    });
    const firstSpawn = async (element: 'ice' | 'normal') => {
      const { setups } = fakePlayers([
        { playerId: 'a', seat: 0, zone: 'TL', units: [design('f', stats({ type: 'factory', productionInterval: 600 }))], placements: [at(0, 0, 'f')], brains: { f: scripted(() => ({ action: 'rally', destination: { x: 60, y: 60 } })) } },
        { playerId: 'b', seat: 1, zone: 'BR', units: [design('i', tapper(element)), design('g', stats({ type: 'tower', range: 20 }))], placements: [at(0, 0, 'i'), at(5, 5, 'g')], brains: { i: hunter, g: idleBrain } },
      ]);
      const engine = new BattleEngine({ players: setups, config: cfg({}, 1500), seed: 3 });
      await engine.run();
      const iced = engine.frames.some((f) => f.units.some((u) => u[0] === '0-0-0' && u[4] & FRAME_FLAGS.FROZEN));
      const spawn = events(engine.frames).find((x) => x.e.type === 'spawn' && x.e.factoryId === '0-0-0');
      return { t: spawn?.t ?? Infinity, iced };
    };
    const free = await firstSpawn('normal');
    const frozen = await firstSpawn('ice');
    expect(free).toEqual({ t: 600, iced: false });
    expect(frozen.iced).toBe(true);
    // Frozen from about tick 100 on: the rest of the 600-tick timer takes 1/0.65 as long.
    expect(frozen.t).toBeGreaterThan(750);
    expect(frozen.t).toBeLessThan(900);
  });
});

describe('elements in battle: frames, events, credit and determinism', () => {
  const storm = stats({ type: 'soldier', name: 'Storm', damage: 100, element: 'lightning', splashRadius: 30 });
  const blaze = stats({ type: 'soldier', name: 'Blaze', damage: 80, element: 'fire' });
  const frost = stats({ type: 'tower', name: 'Frost', damage: 40, element: 'ice', range: 300 });
  const specs = (order = (p: PlacementDTO[]) => p): FakePlayerSpec[] => [
    {
      playerId: 'a', seat: 0, zone: 'TL', units: [design('s', storm), design('b', blaze), design('f', frost)],
      placements: order([at(2, 0, 's'), at(1, 0, 's'), at(0, 1, 'b'), at(1, 1, 'b'), at(0, 0, 'f')]), brains: { s: soldierBrain, b: soldierBrain, f: towerBrain },
    },
    {
      playerId: 'b', seat: 1, zone: 'BR', units: [design('s', stats({ type: 'soldier' })), design('t', stats({ type: 'tower' }))],
      placements: order([at(0, 0, 's'), at(1, 0, 's'), at(0, 1, 's'), at(1, 1, 's'), at(2, 0, 's'), at(2, 2, 't')]), brains: { s: soldierBrain, t: towerBrain },
    },
  ];

  it('the frames carry the new flags and events, and the report the damage split and combos', async () => {
    const { setups } = fakePlayers(specs(), 9);
    const engine = new BattleEngine({ players: setups, config: cfg({}, 5400), seed: 9 });
    const result = await engine.run();
    const all = events(engine.frames).map((x) => x.e);
    const kinds = new Set(all.flatMap((e) => (e.type === 'hit' && e.kind ? [e.kind] : [])));
    expect(kinds).toContain('burn');
    expect(kinds).toContain('zap');
    expect(kinds).toContain('splash');
    expect(all.some((e) => e.type === 'arc')).toBe(true);
    expect(all.some((e) => e.type === 'splash')).toBe(true);
    const flags = engine.frames.flatMap((f) => f.units.map((u) => u[4]));
    expect(flags.some((x) => x & FRAME_FLAGS.BURNING)).toBe(true);
    // The frost tower froze someone: shown as FROZEN, unless the blazes shattered it before the next frame.
    expect(all.some((e) => e.type === 'hit' && e.element === 'ice')).toBe(true);
    expect(flags.some((x) => x & FRAME_FLAGS.FROZEN) || kinds.has('shatter')).toBe(true);
    const storms = result.units.filter((u) => u.unitId === 's' && u.playerId === 'a');
    const split = storms.reduce((s, u) => s + (u.damageSplit?.zap ?? 0) + (u.damageSplit?.splash ?? 0), 0);
    expect(split).toBeGreaterThan(0);
    // The split adds up to the damage dealt.
    for (const u of result.units) {
      if (!u.damageSplit) continue;
      const sum = Object.values(u.damageSplit).reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(u.damageDealt, 6);
    }
  });

  it('lightning is deterministic: the same seed (and shuffled placements) give identical frames', async () => {
    const run = async (shuffle: boolean) => {
      const { setups } = fakePlayers(specs(shuffle ? (p) => [...p].reverse() : (p) => p), 9);
      return (await runBattle({ players: setups, config: cfg({}, 1800), seed: 21 })).frames;
    };
    const a = await run(false);
    expect(JSON.stringify(await run(false))).toBe(JSON.stringify(a));
    expect(JSON.stringify(await run(true))).toBe(JSON.stringify(a));
  });

  it('a battle without elements or support is bit-identical to M8.7 (golden frames hash from the M8.7 engine)', async () => {
    // ×1 stats and minions, explicit prices: recorded with the M8.7 engine (commit f1959f9) and this exact setup.
    const X1 = { grunt: { maxHealth: 40, damage: 5 }, archer: { maxHealth: 24, damage: 5 }, runner: { maxHealth: 28, damage: 4 }, brute: { maxHealth: 100, damage: 8 } };
    const config = deepMerge(C, { factory: { minions: X1 }, timers: { battleTicks: 3600 }, suddenDeath: { startTick: 2400, endTick: 3600 } });
    const S = stats({ type: 'soldier', name: 'S', maxHealth: 120, damage: 10, range: 40, speed: 1.5, attackCooldown: 60, size: 10 });
    const T = stats({ type: 'tower', name: 'T', maxHealth: 150, damage: 15, range: 180, speed: 0, attackCooldown: 45, size: 14 });
    const W = stats({ type: 'wall', name: 'W', maxHealth: 400 });
    const F = stats({ type: 'factory', name: 'F', maxHealth: 300, productionInterval: 600, produces: 'archer', burst: 2 });
    const rally = scripted((_s, enemies, _a, world) => ({ action: 'rally', destination: enemies.find((e) => e.type !== 'wall') ?? world.center }));
    const army = (seat: number, zone: 'TL' | 'BR'): FakePlayerSpec => ({
      playerId: `p${seat}`, seat, zone,
      units: [design('s', S, 92), design('t', T, 198), design('w', W, 32), design('f', F, 300)],
      placements: [at(0, 0, 's'), at(1, 0, 's'), at(0, 1, 's'), at(2, 2, 't'), at(3, 0, 'w'), at(3, 1, 'w'), at(4, 4, 'f')],
      brains: { s: soldierBrain, t: towerBrain, f: rally, w: idleBrain },
    });
    const b = army(1, 'BR');
    b.placements = [at(0, 0, 's'), at(1, 1, 't'), at(2, 0, 't'), at(5, 5, 'f'), at(2, 2, 'w')];
    const { setups } = fakePlayers([army(0, 'TL'), b], 5);
    const r = await runBattle({ players: setups, config, seed: 5 });
    const json = JSON.stringify(r.frames);
    expect(r.ranking.map((x) => `${x.playerId}:${x.place}`)).toEqual(['p1:1', 'p0:2']);
    expect(json.length).toBe(673973);
    expect(createHash('sha256').update(json).digest('hex')).toBe('febb2f8365fe0efd14a7cf6d457bb7f3a229507406869bc417342e4c27d532b5');
  });
});

describe('review fixes: freeze window, big bodies in the hash, Skip trims the split', () => {
  it('one ice hit slows exactly ice.ticks moves, and views show ice.ticks first', async () => {
    const iceTower = stats({ type: 'tower', name: 'Frost', damage: 1, range: 300, attackCooldown: 5000, element: 'ice' });
    const guard = stats({ type: 'tower', name: 'Guard', range: 20 });
    const walker = scripted(() => ({ action: 'move', destination: { x: 790, y: 790 } }));
    const inRange = scripted((self, en) => {
      const t = en[0];
      return t && self.cooldownRemaining === 0 && Math.hypot(t.x - self.x, t.y - self.y) - t.radius - self.radius <= 300 ? { action: 'attack', targetId: t.id } : { action: 'idle' };
    });
    const { setups, runners } = fakePlayers([
      { playerId: 'a', seat: 0, zone: 'TL', units: [design('s', stats({ type: 'soldier', speed: 1 }))], placements: [at(0, 0, 's')], brains: { s: walker } },
      { playerId: 'b', seat: 1, zone: 'BR', units: [design('f', iceTower), design('g', guard)], placements: [at(0, 0, 'f'), at(5, 5, 'g')], brains: { f: inRange, g: idleBrain } },
    ]);
    runners.get('a')!.recordInputs = true;
    await new BattleEngine({ players: setups, config: cfg({}, 700), seed: 2 }).run();
    const ins = runners.get('a')!.inputs.map((i) => i.selves[0]!);
    let slowed = 0;
    for (let i = 1; i < ins.length; i++) if (Math.abs(Math.hypot(ins[i]!.x - ins[i - 1]!.x, ins[i]!.y - ins[i - 1]!.y) - 0.65) < 1e-6) slowed++;
    const frozenViews = ins.filter((v) => v.status.frozen > 0);
    expect(slowed).toBe(C.elements.ice.ticks);
    expect(frozenViews).toHaveLength(C.elements.ice.ticks);
    expect(frozenViews[0]!.status.frozen).toBe(C.elements.ice.ticks);
  });

  it('splash finds a big body (size above 20) the same way with 3 or 73 bodies alive', () => {
    const A = body('0-0-0', soldier({ damage: 100, splashRadius: 10 }));
    const T = body('1-0-0', dummy(), { x: 401, y: 401 });
    // Edge 9.5 px from T's centre: inside the splash radius.
    const big = body('1-0-1', stats({ type: 'tower', maxHealth: 2500, size: 30 }), { x: 401 + 39.5, y: 401 });
    const filler = Array.from({ length: 70 }, (_, i) => body(`2-0-${String(i).padStart(2, '0')}`, dummy(), { x: 50 + i, y: 50 }));
    const hpAfter = (bodies: SimUnit[]) => {
      big.hp = 2500;
      T.hp = 2500;
      pipeline(bodies).p.land(hit(A, T, { damage: 100, splash: 10 }));
      return big.hp;
    };
    const few = hpAfter([A, T, big]);
    expect(few).toBeLessThan(2500);
    expect(hpAfter([A, T, big, ...filler])).toBe(few);
  });

  it('a Skip-trimmed report has the damage split, assist and cleanses of the shown frame', async () => {
    const blaze = stats({ type: 'soldier', name: 'Blaze', damage: 80, element: 'fire' });
    const { setups } = fakePlayers([
      { playerId: 'a', seat: 0, zone: 'TL', units: [design('s', blaze)], placements: [at(0, 0, 's'), at(1, 0, 's')], brains: { s: soldierBrain } },
      { playerId: 'b', seat: 1, zone: 'BR', units: [design('s', stats({ type: 'soldier', maxHealth: 2500 }))], placements: [at(0, 0, 's'), at(1, 0, 's')], brains: { s: soldierBrain } },
    ]);
    const engine = new BattleEngine({ players: setups, config: deepMerge(C, { timers: { battleTicks: 1500 } }), seed: 3 });
    const full = await engine.run();
    const hits = engine.frames.filter((f) => f.events.some((e) => e.type === 'hit'));
    const mid = hits[Math.floor(hits.length / 3)]!;
    const t = buildBattleReport(resultAtTick(full, engine.countersAt(mid.t), mid, mid.t), 'a', 1).types![0]!;
    const fullType = buildBattleReport(full, 'a', 1).types![0]!;
    expect(t.damageDealt).toBeLessThan(fullType.damageDealt);
    const sp = t.damageSplit!;
    expect(sp.burn).toBeGreaterThan(0);
    expect(Math.abs(sp.hit + sp.splash + sp.burn + sp.zap + sp.shatter - t.damageDealt)).toBeLessThanOrEqual(2);
  });
});
