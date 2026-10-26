// Redesign (2026-10-24): ranged accuracy against the target's speed and the
// stronger element synergies.
//   * accuracy: a ranged shot at a body that moved this tick misses with
//     missMaxPct% × min(1, moved / speedRef), drawn from its own seeded
//     stream; a miss lands where the target was (splash still hits there);
//     melee, heals, standing targets never miss; OtherView shows moving /
//     currentSpeed;
//   * kindle: a burning body takes +kindlePct% from every hit that isn't fire;
//     brittle: a frozen body takes +brittlePct% from every hit that isn't ice
//     or fire (fire shatters); burn pulses get neither.

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, deepMerge, elementOf, splashOf, type FrameDTO, type FrameEvent, type GameConfig, type OtherView, type PlacementDTO, type StatsSnapshot } from '@pixel-clash/shared';
import { BattleEngine, missChance, type SimUnit } from '../packages/server/src/sim/engine.js';
import { BodyIndex, HitPipeline, noAura, synergyOf } from '../packages/server/src/sim/effects.js';
import { FrameRecorder } from '../packages/server/src/sim/frames.js';
import { mulberry32, type Rng } from '../packages/server/src/sim/prng.js';
import { design, fakePlayers, idleBrain, scripted, stats, type FakePlayerSpec } from './helpers/fakeRunner.js';

const C = DEFAULT_CONFIG;
const at = (col: number, row: number, unitId: string): PlacementDTO => ({ unitId, col, row });
const events = (frames: FrameDTO[]) => frames.flatMap((f) => f.events);

describe('accuracy: the miss chance', () => {
  it('is missMaxPct × min(1, moved / speedRef), 0 for a body standing still', () => {
    const cfg = deepMerge(C, { accuracy: { missMaxPct: 20, speedRef: 5 } });
    expect(missChance(0, cfg)).toBe(0);
    expect(missChance(2.5, cfg)).toBeCloseTo(0.1, 12);
    expect(missChance(5, cfg)).toBeCloseTo(0.2, 12);
    expect(missChance(7, cfg)).toBeCloseTo(0.2, 12); // haste can't push past the max
    expect(missChance(5, deepMerge(C, { accuracy: { missMaxPct: 0 } }))).toBe(0);
  });
});

/** A tower shooting at one enemy soldier that paces up and down (or stands) for `ticks`. */
async function shootingRange(opts: { speed: number; pace: boolean; melee?: boolean; ice?: boolean; config?: GameConfig; seed?: number; ticks?: number; seenMoving?: boolean[]; missMaxPct?: number }) {
  const ticks = opts.ticks ?? 3600;
  const config: GameConfig = deepMerge(opts.config ?? C, { timers: { battleTicks: ticks }, suddenDeath: { damagePctPerSecond: 0 }, accuracy: { missMaxPct: opts.missMaxPct ?? 20, speedRef: 5 } });
  const shooter = stats({ type: opts.melee ? 'soldier' : 'tower', name: 'Shooter', maxHealth: 2000, damage: 1, range: 600, speed: opts.melee ? 0.5 : 0, attackCooldown: 10, ...(opts.ice ? { element: 'ice' as const } : {}) });
  const runner = stats({ type: 'soldier', name: 'Runner', maxHealth: 4000, damage: 1, range: 20, speed: opts.speed, attackCooldown: 60 });
  const shoot = scripted((self, enemies: OtherView[]) => {
    const e = enemies.find((x) => x.type === 'soldier');
    if (opts.seenMoving && e) opts.seenMoving.push(e.moving);
    return e && self.cooldownRemaining === 0 ? { action: 'attack', targetId: e.id } : { action: 'idle' };
  });
  const pace = scripted((self, _e, _a, world) => {
    if (!opts.pace) return { action: 'idle' };
    // Up and down a vertical line, always moving (turns before it arrives).
    const up = Math.floor(world.tick / 40) % 2 === 0;
    return { action: 'move', destination: { x: self.x, y: up ? 20 : 780 } };
  });
  const specs: FakePlayerSpec[] = [
    { playerId: 'a', seat: 0, zone: 'TL', units: [design('t', shooter)], placements: [at(4, 4, 't')], brains: { t: shoot } },
    { playerId: 'b', seat: 1, zone: 'TR', units: [design('r', runner)], placements: [at(0, 3, 'r')], brains: { r: pace } },
  ];
  // Melee: the "melee" shooter is a soldier whose range is huge but melee... no: melee is range ≤ 50, so place it touching.
  if (opts.melee) {
    specs[0]!.units = [design('t', stats({ type: 'soldier', name: 'Swordsman', maxHealth: 2000, damage: 1, range: 40, speed: 5, attackCooldown: 10 }))];
    specs[0]!.brains = {
      t: scripted((self, enemies: OtherView[]) => {
        const e = enemies.find((x) => x.type === 'soldier')!;
        const g = Math.hypot(e.x - self.x, e.y - self.y) - self.radius - e.radius;
        return g <= self.range ? (self.cooldownRemaining === 0 ? { action: 'attack', targetId: e.id } : { action: 'idle' }) : { action: 'move', destination: { x: e.x, y: e.y } };
      }),
    };
  }
  const { setups } = fakePlayers(specs, opts.seed ?? 3);
  const engine = new BattleEngine({ players: setups, config, seed: opts.seed ?? 3 });
  const result = await engine.run();
  const ev = events(engine.frames);
  const fired = ev.filter((e) => e.type === 'fire' && e.instanceId.startsWith('0-')).length;
  const misses = ev.filter((e): e is Extract<FrameEvent, { type: 'miss' }> => e.type === 'miss');
  const hits = ev.filter((e) => e.type === 'hit' && e.instanceId.startsWith('0-')).length;
  return { result, fired, misses, hits, frames: engine.frames };
}

describe('accuracy in battle', () => {
  it('a standing target is never missed', async () => {
    const r = await shootingRange({ speed: 2.5, pace: false });
    expect(r.fired).toBeGreaterThan(300);
    expect(r.misses).toHaveLength(0);
  });

  it('a moving target is missed at the formula rate (speed 2.5: 10% ± 4%), and every miss lands where it was', async () => {
    const r = await shootingRange({ speed: 2.5, pace: true });
    expect(r.fired).toBeGreaterThan(300);
    const rate = r.misses.length / r.fired;
    expect(rate).toBeGreaterThan(0.06);
    expect(rate).toBeLessThan(0.14);
    const report = r.result.units.find((u) => u.instanceId.startsWith('0-'))!;
    expect(report.misses).toBe(r.misses.length);
    expect(r.result.units.find((u) => u.instanceId.startsWith('1-'))!.dodges).toBe(r.misses.length);
    // The runner paces on a vertical line: a miss lands on that line.
    const runnerX = r.frames[0]!.units.find((u) => u[0].startsWith('1-'))![1];
    for (const m of r.misses) expect(Math.abs(m.x - runnerX)).toBeLessThan(1);
  });

  it('a fast target (speed 5) is missed about twice as often (20% ± 5%)', async () => {
    const r = await shootingRange({ speed: 5, pace: true });
    const rate = r.misses.length / r.fired;
    expect(rate).toBeGreaterThan(0.15);
    expect(rate).toBeLessThan(0.25);
  });

  it('ice makes it easier to hit: a frozen runner moves 35% slower, so fewer shots miss', async () => {
    const plain = await shootingRange({ speed: 5, pace: true, seed: 9 });
    const ice = await shootingRange({ speed: 5, pace: true, ice: true, seed: 9 });
    expect(ice.misses.length / ice.fired).toBeLessThan(plain.misses.length / plain.fired - 0.04);
  });

  it('melee never misses', async () => {
    const r = await shootingRange({ speed: 2.5, pace: true, melee: true, ticks: 1800 });
    expect(r.fired).toBeGreaterThan(20);
    expect(r.misses).toHaveLength(0);
  });

  it('views show moving and currentSpeed', async () => {
    const seen: boolean[] = [];
    await shootingRange({ speed: 2.5, pace: true, ticks: 300, seenMoving: seen });
    expect(seen[0]).toBe(false); // nobody has moved before tick 0
    expect(seen.slice(1, 30).every(Boolean)).toBe(true);
    expect(seen.some((m) => !m)).toBe(true); // it stops at the arena edge before turning
  });

  it('is deterministic (its own stream): the same seed gives the same misses, another seed different ones', async () => {
    const a = await shootingRange({ speed: 2.5, pace: true, seed: 4, ticks: 1200 });
    const b = await shootingRange({ speed: 2.5, pace: true, seed: 4, ticks: 1200 });
    const c = await shootingRange({ speed: 2.5, pace: true, seed: 5, ticks: 1200 });
    expect(JSON.stringify(b.frames)).toBe(JSON.stringify(a.frames));
    expect(JSON.stringify(c.misses)).not.toBe(JSON.stringify(a.misses));
  });

  it('missMaxPct 0 switches it off', async () => {
    const r = await shootingRange({ speed: 5, pace: true, ticks: 1200, missMaxPct: 0 });
    expect(r.fired).toBeGreaterThan(0);
    expect(r.misses).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Pipeline level: a miss's splash, and the synergies
// ---------------------------------------------------------------------------

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
const dummy = (hp = 4000) => stats({ type: 'tower', name: 'Dummy', maxHealth: hp, damage: 5, size: 10 });

function pipeline(bodies: SimUnit[], tick = 0, rng: Rng = mulberry32(1), config: GameConfig = C) {
  const recorder = new FrameRecorder();
  const p = new HitPipeline(config, tick, recorder, rng, new BodyIndex(bodies, 1200));
  const evs = (): FrameEvent[] => recorder.record(tick, [], [], 0).events;
  return { p, events: evs };
}
const hit = (A: SimUnit, T: SimUnit, over: Partial<Parameters<HitPipeline['land']>[0]> = {}) => ({
  attackerId: A.id, attacker: A, target: T, damage: A.stats.damage, element: elementOf(A.stats), splash: splashOf(A.stats), might: 0, mightSrc: null, ...over,
});

describe('a miss lands on the ground', () => {
  it('no direct hit and no zap, but its splash hits every enemy near the spot (the old target too) with its element', () => {
    const A = body('0-0-0', soldier({ damage: 100, splashRadius: 40, element: 'ice' }));
    const T = body('1-0-0', dummy(), { x: 410, y: 400 }); // moved 10 px on since the shot
    const E = body('1-0-1', dummy(), { x: 380, y: 400 });
    const F = body('1-0-2', dummy(), { x: 500, y: 400 }); // too far
    const rng = mulberry32(1);
    let draws = 0;
    const counted: Rng = () => (draws++, rng());
    const { p, events: evs } = pipeline([A, T, E, F], 0, counted);
    p.landMiss({ attackerId: A.id, attacker: A, targetId: T.id, at: { x: 400, y: 400 }, damage: 100, element: 'ice', splash: 40, might: 0, mightSrc: null });
    expect(T.hp).toBe(4000 - 50);
    expect(E.hp).toBe(4000 - 50);
    expect(F.hp).toBe(4000);
    expect(T.frozen).toBe(C.elements.ice.ticks);
    expect(draws).toBe(0);
    const e = evs();
    expect(e[0]).toEqual({ type: 'miss', instanceId: '0-0-0', targetId: '1-0-0', x: 400, y: 400 });
    expect(e.filter((x) => x.type === 'hit').every((x) => x.type === 'hit' && x.kind === 'splash')).toBe(true);
  });

  it('a miss without splash does nothing but the miss event', () => {
    const A = body('0-0-0', soldier({ damage: 100, element: 'lightning' }));
    const T = body('1-0-0', dummy());
    const { p, events: evs } = pipeline([A, T]);
    p.landMiss({ attackerId: A.id, attacker: A, targetId: T.id, at: { x: 400, y: 400 }, damage: 100, element: 'lightning', splash: 0, might: 0, mightSrc: null });
    expect(T.hp).toBe(4000);
    expect(evs()).toHaveLength(1);
  });
});

describe('synergies: kindle and brittle', () => {
  const K = 1 + C.elements.kindlePct / 100;
  const B = 1 + C.elements.brittlePct / 100;

  it('the rule: kindle for non-fire hits on a burning body, brittle for non-ice, non-fire hits on a frozen one', () => {
    const burning = { burns: [{}] as SimUnit['burns'], frozen: 0 };
    const frozen = { burns: [], frozen: 30 };
    const both = { burns: [{}] as SimUnit['burns'], frozen: 30 };
    expect(synergyOf('normal', burning, C.elements)).toEqual({ factor: K, name: 'kindle' });
    expect(synergyOf('fire', burning, C.elements)).toEqual({ factor: 1, name: null });
    expect(synergyOf('lightning', frozen, C.elements)).toEqual({ factor: B, name: 'brittle' });
    expect(synergyOf('ice', frozen, C.elements)).toEqual({ factor: 1, name: null });
    expect(synergyOf('fire', frozen, C.elements)).toEqual({ factor: 1, name: null }); // shatter instead
    expect(synergyOf('normal', both, C.elements)).toEqual({ factor: K * B, name: 'both' });
    expect(synergyOf('ice', both, C.elements)).toEqual({ factor: K, name: 'kindle' });
  });

  it('a normal hit on a burning body deals +kindlePct% (and says so in the hit event); burn pulses get no bonus', () => {
    const F = body('0-0-0', soldier({ damage: 100, element: 'fire' }));
    const N = body('0-0-1', soldier({ damage: 100 }));
    const T = body('1-0-0', dummy());
    const { p, events: evs } = pipeline([F, N, T]);
    p.land(hit(F, T));
    expect(T.hp).toBe(3900); // the fire hit itself: no kindle
    p.land(hit(N, T));
    expect(T.hp).toBeCloseTo(3900 - 100 * K, 9);
    expect(evs().find((e) => e.type === 'hit' && e.instanceId === '0-0-1')).toMatchObject({ combo: 'kindle' });
  });

  it('a normal hit on a frozen body deals +brittlePct%; an ice hit doesn\'t; a fire hit shatters (not brittle)', () => {
    const I = body('0-0-0', soldier({ damage: 100, element: 'ice' }));
    const N = body('0-0-1', soldier({ damage: 100 }));
    const F = body('0-0-2', soldier({ damage: 100, element: 'fire' }));
    const T = body('1-0-0', dummy());
    const { p } = pipeline([I, N, F, T]);
    p.land(hit(I, T));
    p.land(hit(I, T));
    expect(T.hp).toBe(3800);
    p.land(hit(N, T));
    expect(T.hp).toBeCloseTo(3800 - 100 * B, 9);
    const before = T.hp;
    p.land(hit(F, T));
    expect(before - T.hp).toBeCloseTo(100 * (1 + C.elements.shatterPct / 100), 9);
    expect(T.frozen).toBe(0);
  });

  it('a lightning zap onto a burning body is kindled', () => {
    const L = body('0-0-0', soldier({ damage: 100, element: 'lightning' }));
    const T = body('1-0-0', dummy());
    const Z = body('1-0-1', dummy(), { x: 440, burns: [{ ownerId: 'p2', seat: 2, pool: 10, pulsesLeft: 6, nextPulseTick: 999, source: L }] });
    const { p } = pipeline([L, T, Z], 0, () => 0); // always zaps
    p.land(hit(L, T));
    expect(Z.hp).toBeCloseTo(4000 - 100 * K, 9);
  });
});
