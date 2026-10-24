// Support (plan §5.5, §9.4 Heals, Auras, Elimination change, M8.8): the
// heal action's rules (§5 rule 4), the 5% heal room per window shared by every
// healer, cleanse-only, no heals in sudden death, dead stays dead, auras
// (edge-to-edge radius, strongest per kind, kinds combine, never on the
// source, teammates count, disabled sources keep working), the medic minion's
// AI, damage-0 sides, and the Best Medic / Combo Master badges.

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, deepMerge, type FrameDTO, type GameConfig, type PlacementDTO, type StatsSnapshot } from '@pixel-clash/shared';
import { resolveAction } from '../packages/server/src/sim/actions.js';
import { BattleEngine, runBattle, type SimUnit } from '../packages/server/src/sim/engine.js';
import { BodyIndex, HitPipeline, noAura } from '../packages/server/src/sim/effects.js';
import { FrameRecorder } from '../packages/server/src/sim/frames.js';
import { medicAction, minionStats } from '../packages/server/src/sim/minion.js';
import { mulberry32 } from '../packages/server/src/sim/prng.js';
import { computeRoundScore } from '../packages/server/src/sim/scoring.js';
import { applyHeals, computeAuras, freshHealRoom } from '../packages/server/src/sim/support.js';
import { design, fakePlayers, idleBrain, scripted, soldierBrain, stats, type FakePlayerSpec } from './helpers/fakeRunner.js';

const C = DEFAULT_CONFIG;
const at = (col: number, row: number, unitId: string): PlacementDTO => ({ unitId, col, row });

function body(id: string, s: StatsSnapshot, over: Partial<SimUnit> = {}): SimUnit {
  const seat = Number(id[0]);
  return {
    id, playerId: `p${seat}`, seat, teamId: seat, unitId: s.name, stats: s, cost: 500, type: s.type, radius: s.size,
    x: 400, y: 400, hp: s.maxHealth, maxHp: s.maxHealth, cooldownRemaining: 0, alive: true, disabled: false, spawned: true,
    movedSinceFrame: false, firedSinceFrame: false, facingLeft: false, outsideSafeZone: false,
    damageDealt: 0, kills: 0, valueDestroyed: 0, strikes: 0, errors: [], diedAtTick: null,
    frozen: 0, burns: [], healRoom: s.maxHealth * 0.05, aura: noAura(),
    ...over,
  };
}

const MEDIC = stats({ type: 'soldier', name: 'Field Medic', maxHealth: 500, damage: 0, range: 20, support: { kind: 'heal', power: 60, range: 120 } });
const CLERIC = stats({ type: 'soldier', name: 'Cleric', damage: 40, support: { kind: 'heal', power: 40, range: 100 } });
const SOLDIER = stats({ type: 'soldier' });

describe("the heal action (§5 rule 4)", () => {
  const lookupOf = (...units: SimUnit[]) => (id: string) => units.find((u) => u.id === id);
  const heal = (targetId: unknown) => ({ action: 'heal', targetId });

  it('heals a hurt ally in reach (edge to edge + 0.5), sharing the attack cooldown', () => {
    const m = body('0-0-0', MEDIC);
    const ally = body('0-0-1', SOLDIER, { x: 400 + 10 + 10 + 120.4, hp: 300 });
    const r = resolveAction(heal(ally.id), m, lookupOf(m, ally), 0.5);
    expect(r).toEqual({ kind: 'heal', targetId: '0-0-1', power: 60 });
    // A teammate's unit is an ally too (same teamId, another owner).
    const mate = body('2-0-0', SOLDIER, { teamId: 0, x: 430, hp: 1 });
    expect(resolveAction(heal(mate.id), m, lookupOf(m, mate), 0.5).kind).toBe('heal');
  });

  it('idles (no strike, cooldown kept) on anything else', () => {
    const m = body('0-0-0', MEDIC);
    const hurt = (over: Partial<SimUnit> = {}) => body('0-0-1', SOLDIER, { x: 430, hp: 300, ...over });
    const reason = (actor: SimUnit, raw: unknown, ...others: SimUnit[]) => {
      const r = resolveAction(raw, actor, lookupOf(actor, ...others), 0.5);
      return r.kind === 'idle' ? r.reason : r.kind;
    };
    expect(reason(m, heal(hurt().id), hurt())).toBe('heal');
    expect(reason(m, heal(42))).toBe('malformed');
    expect(reason(m, heal('nope'))).toBe('no-target');
    expect(reason(m, heal('1-0-0'), body('1-0-0', SOLDIER, { x: 430, hp: 1 }))).toBe('enemy-target');
    expect(reason(m, heal(m.id))).toBe('not-healable');
    expect(reason(m, heal('0-0-2'), body('0-0-2', stats({ type: 'wall' }), { x: 430, hp: 1 }))).toBe('not-healable');
    expect(reason(m, heal('0-0-2'), body('0-0-2', stats({ type: 'factory' }), { x: 430, hp: 1 }))).toBe('not-healable');
    expect(reason(m, heal('0-0-1'), hurt({ x: 700 }))).toBe('out-of-range');
    expect(reason({ ...m, cooldownRemaining: 0.3 }, heal('0-0-1'), hurt())).toBe('cooling-down');
    expect(reason(m, heal('0-0-1'), hurt({ hp: 600 }))).toBe('not-needed'); // full
    expect(reason(m, heal('0-0-1'), hurt({ healRoom: 0 }))).toBe('not-needed'); // this window's room is used
    // Burning or frozen allies always "need" it (a cleanse), even at full HP.
    expect(reason(m, heal('0-0-1'), hurt({ hp: 600, frozen: 5 }))).toBe('heal');
    // No heal support (or a factory) → wrong type; sudden death → heals off.
    expect(reason(body('0-0-3', SOLDIER), heal('0-0-1'), hurt())).toBe('wrong-type');
    expect(resolveAction(heal('0-0-1'), m, lookupOf(m, hurt()), 0.5, 800, { healsOff: true })).toEqual({ kind: 'idle', reason: 'heals-off' });
  });
});

describe('heals (§9.4 step 7b)', () => {
  it('heal amount = min(power, missing HP, heal room); the room is shared by every healer', () => {
    const a = body('0-0-0', MEDIC);
    const b = body('0-0-1', MEDIC);
    const t = body('0-0-2', SOLDIER, { hp: 100 }); // room 30
    const rec = new FrameRecorder();
    applyHeals([{ healer: a, target: t, power: 60 }, { healer: b, target: t, power: 60 }], rec);
    expect(t.hp).toBe(130);
    expect(t.healRoom).toBe(0);
    expect([a.healing, b.healing]).toEqual([30, 0]);
    expect(rec.record(0, [], [], 0).events).toEqual([
      { type: 'heal', from: '0-0-0', to: '0-0-2', amount: 30 },
      { type: 'heal', from: '0-0-1', to: '0-0-2', amount: 0 },
    ]);
  });

  it('a burning or frozen ally is only cleansed (every burn and the freeze), never healed in the same beam', () => {
    const m = body('0-0-0', MEDIC);
    const t = body('0-0-1', SOLDIER, { hp: 100, frozen: 50, burns: [{ ownerId: 'p1', seat: 1, pool: 20, pulsesLeft: 3, nextPulseTick: 30, source: body('1-0-0', SOLDIER) }] });
    const rec = new FrameRecorder();
    applyHeals([{ healer: m, target: t, power: 60 }], rec);
    expect(t).toMatchObject({ hp: 100, frozen: 0, burns: [] });
    expect(m.cleanses).toBe(1);
    expect(m.healing ?? 0).toBe(0);
    expect(rec.record(0, [], [], 0).events).toEqual([{ type: 'cleanse', from: '0-0-0', to: '0-0-1' }]);
  });

  it('dead stays dead: the hits of the tick land first, a body at ≤ 0 hp is not healed', () => {
    const m = body('0-0-0', MEDIC);
    const t = body('0-0-1', SOLDIER, { hp: 40 });
    const enemy = body('1-0-0', stats({ type: 'soldier', damage: 50 }));
    new HitPipeline(C, 0, new FrameRecorder(), mulberry32(1), new BodyIndex([m, t, enemy], 800)).land({
      attackerId: enemy.id, attacker: enemy, target: t, damage: 50, element: 'normal', splash: 0, might: 0, mightSrc: null,
    });
    applyHeals([{ healer: m, target: t, power: 60 }], new FrameRecorder());
    expect(t.hp).toBeLessThanOrEqual(0);
    expect(m.healing ?? 0).toBe(0);
  });

  it('the heal room is 5% of max HP per window, 0 for walls and factories and from sudden death', () => {
    expect(freshHealRoom({ type: 'soldier', maxHp: 600 }, 0, C)).toBe(30);
    expect(freshHealRoom({ type: 'minion', maxHp: 150 }, 600, C)).toBe(7.5);
    expect(freshHealRoom({ type: 'wall', maxHp: 2000 }, 0, C)).toBe(0);
    expect(freshHealRoom({ type: 'factory', maxHp: 1500 }, 0, C)).toBe(0);
    expect(freshHealRoom({ type: 'soldier', maxHp: 600 }, C.suddenDeath.startTick, C)).toBe(0);
  });

  it('in battle: a medic heals at most 5% per second, and nothing from sudden death on (the action idles, keeping its cooldown)', async () => {
    // b's sniper wounds a's soldier; a's medic stands next to it and heals whatever it can.
    const config: GameConfig = deepMerge(C, { timers: { battleTicks: 900 }, suddenDeath: { startTick: 600, endTick: 100_000, damagePctPerSecond: 0 } });
    // The soldier walks into the sniper's range; the medic follows it and heals it whenever it can.
    const walker = scripted(() => ({ action: 'move', destination: { x: 440, y: 220 } }));
    const healBrain = scripted((self, _e, allies) => {
      const s = allies.find((a) => a.id !== self.id && a.type === 'soldier');
      if (!s) return { action: 'idle' };
      const gap = Math.hypot(s.x - self.x, s.y - self.y) - s.radius - self.radius;
      if (gap > 100) return { action: 'move', destination: { x: s.x, y: s.y } };
      return s.hp < s.maxHp && self.cooldownRemaining === 0 ? { action: 'heal', targetId: s.id } : { action: 'idle' };
    });
    const sniper = stats({ type: 'tower', name: 'Sniper', damage: 100, range: 300, attackCooldown: 60 });
    const sniperBrain = scripted((self, enemies) => {
      const t = enemies.find((e) => e.name === 'Basic Soldier');
      return t && self.cooldownRemaining === 0 && Math.hypot(t.x - self.x, t.y - self.y) - t.radius - self.radius <= self.range
        ? { action: 'attack', targetId: t.id }
        : { action: 'idle' };
    });
    const { setups, runners } = fakePlayers([
      { playerId: 'a', seat: 0, zone: 'TL', units: [design('s', stats({ type: 'soldier', maxHealth: 2500 })), design('m', MEDIC)], placements: [at(0, 0, 's'), at(1, 0, 'm')], brains: { s: walker, m: healBrain } },
      { playerId: 'b', seat: 1, zone: 'TR', units: [design('t', sniper)], placements: [at(0, 0, 't')], brains: { t: sniperBrain } },
    ]);
    runners.get('a')!.recordInputs = true;
    const engine = new BattleEngine({ players: setups, config, seed: 4 });
    const result = await engine.run();
    const heals = engine.frames.flatMap((f) => f.events.map((e) => ({ t: f.t, e }))).filter((x) => x.e.type === 'heal');
    expect(heals.length).toBeGreaterThan(3);
    // Never more than 5% of 2500 (125 HP) restored in one 60-tick window, and none from tick 600.
    const perWindow = new Map<number, number>();
    for (const h of heals) {
      const amount = (h.e as { amount: number }).amount;
      const w = Math.floor((h.t - 1) / 60);
      perWindow.set(w, (perWindow.get(w) ?? 0) + amount);
      expect(h.t).toBeLessThanOrEqual(600);
    }
    for (const v of perWindow.values()) expect(v).toBeLessThanOrEqual(125 + 1e-9);
    const medic = result.units.find((u) => u.instanceId === '0-0-1')!;
    expect(medic.healing).toBeGreaterThan(0);
    expect(medic.healer).toBe(true);
    // From tick 600 the heal idles and keeps the cooldown at 0 (it never "fires").
    const late = runners.get('a')!.inputs.filter((i) => i.tick > 650).map((i) => i.selves.find((s) => s.id === '0-0-1')!);
    expect(late.every((s) => s.cooldownRemaining === 0 && s.status.healRoom === 0)).toBe(true);
    // Healing never counts as damage.
    expect(result.ranking.find((r) => r.playerId === 'a')!.damage).toBe(0);
  });
});

describe('auras (§5.5)', () => {
  const drummer = (power: number, range = 100, kind: 'haste' | 'might' | 'shield' = 'might') =>
    stats({ type: 'soldier', name: `${kind} ${power}`, damage: 0, support: { kind, power, range } });

  it('edge-to-edge radius; the strongest per kind (ties: the lower source id); kinds combine; never on the source, walls or factories', () => {
    const d1 = body('0-0-0', drummer(30));
    const d2 = body('0-0-1', drummer(20), { x: 420 });
    const banner = body('0-0-2', drummer(25, 100, 'haste'), { x: 440 });
    const near = body('0-0-3', SOLDIER, { x: 400 + 10 + 10 + 100 }); // gap exactly 100
    const far = body('0-0-4', SOLDIER, { x: 400 + 10 + 10 + 100.5 });
    const wall = body('0-0-5', stats({ type: 'wall' }), { x: 430 });
    const fac = body('0-0-6', stats({ type: 'factory' }), { x: 360 });
    const enemy = body('1-0-0', SOLDIER, { x: 410 });
    const mate = body('2-0-0', SOLDIER, { teamId: 0, x: 410 });
    const all = [d1, d2, banner, near, far, wall, fac, enemy, mate];
    computeAuras(all);
    expect(near.aura).toMatchObject({ might: 30, mightSrc: d1, haste: 25 });
    expect(far.aura!.might).toBe(20); // out of d1's reach (gap 100.5), inside d2's
    expect(d1.aura).toMatchObject({ might: 20, haste: 25 }); // not its own, but the others'
    expect(d2.aura!.might).toBe(30);
    expect(mate.aura).toMatchObject({ might: 30, haste: 25 }); // teammates count
    expect(enemy.aura).toMatchObject({ might: 0, haste: 0 });
    expect(wall.aura).toMatchObject({ might: 0 });
    expect(fac.aura).toMatchObject({ might: 0 });
    // Equal strengths: the lower source instanceId is kept.
    const e1 = body('0-1-0', drummer(30));
    const e2 = body('0-1-1', drummer(30));
    const t = body('0-1-2', SOLDIER, { x: 420 });
    computeAuras([e1, e2, t]);
    expect(t.aura!.mightSrc).toBe(e1);
    // A disabled source keeps its aura (no code needed).
    const off = body('0-2-0', drummer(40, 100, 'shield'), { disabled: true });
    const u = body('0-2-1', SOLDIER, { x: 430 });
    computeAuras([off, u]);
    expect(u.aura!.shield).toBe(40);
  });

  it('in battle: a might drummer next to a soldier makes its hits 30% stronger (shown as MIGHTY)', async () => {
    const config: GameConfig = deepMerge(C, { timers: { battleTicks: 600 }, suddenDeath: { startTick: 100_000, endTick: 100_001 } });
    const follower = scripted((self, _e, allies) => {
      const s = allies.find((a) => a.name === 'Basic Soldier');
      return s ? { action: 'move', destination: { x: s.x, y: s.y } } : { action: 'idle' };
    });
    const { setups } = fakePlayers([
      { playerId: 'a', seat: 0, zone: 'TL', units: [design('s', SOLDIER), design('d', drummer(30))], placements: [at(0, 0, 's'), at(1, 0, 'd')], brains: { s: soldierBrain, d: follower } },
      { playerId: 'b', seat: 1, zone: 'BR', units: [design('t', stats({ type: 'tower', maxHealth: 2500, damage: 5 }))], placements: [at(0, 0, 't')], brains: { t: idleBrain } },
    ]);
    const engine = new BattleEngine({ players: setups, config, seed: 1 });
    const result = await engine.run();
    const hits = engine.frames.flatMap((f) => f.events).filter((e) => e.type === 'hit' && e.instanceId === '0-0-0');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((e) => e.type === 'hit' && e.damage === 65)).toBe(true);
    expect(engine.frames.some((f: FrameDTO) => f.units.some((u) => u[0] === '0-0-0' && u[4] & 1024))).toBe(true);
    expect(result.units.find((u) => u.instanceId === '0-0-1')!.assist).toBeCloseTo(15 * hits.length, 6);
  });
});

describe('the medic minion (§5.5)', () => {
  const config = C;
  const fac = (order: 'attack' | 'defend' | 'swarm' | 'guard' = 'attack', orderTargetId: string | null = null): SimUnit =>
    body('0-0-9', stats({ type: 'factory', produces: 'medic' }), {
      x: 100, y: 100,
      factory: {
        productionInterval: 900, timer: 0, minionsLeft: 5, canMake: 5, noSpot: false, made: 1, released: 1, kind: 'medic', burst: 1, stored: 0,
        releaseRequested: false, order, orderTargetId, storedLost: 0, rally: { x: 600, y: 100 }, holding: false, bodyCost: 247, minionValue: 205,
        spawnedSinceFrame: false, minionsLost: 0,
      },
    });
  const medic = (f: SimUnit, over: Partial<SimUnit> = {}) =>
    body('0-0-9-m1', minionStats(config, '#ffffff', 'medic') as StatsSnapshot, { type: 'minion', minion: { factory: f, n: 1, kind: 'medic' }, ...over });
  const world = (living: SimUnit[], healsOff = false) => ({ living, safeCenter: { x: 400, y: 400 }, safeRadius: 9999, rangeTolerance: 0.5, lookup: (id: string) => living.find((u) => u.id === id), healsOff });

  it('is a preset healer: 150 HP, damage 0, heal 40 within 60 px, priced as a $410 soldier ($205 per minion)', () => {
    const s = minionStats(config, '#ffffff', 'medic');
    expect(s).toMatchObject({ name: 'Medic', maxHealth: 150, damage: 0, range: 20, speed: 1.4, size: 7, element: 'normal', support: { kind: 'heal', power: 40, range: 60 } });
    expect(minionStats(config, '#ffffff', 'medic', 'fire').element).toBe('normal'); // medics ignore minionElement
    expect(minionStats(config, '#ffffff', 'grunt', 'fire').element).toBe('fire');
  });

  it('heals burning or frozen allies first, then the lowest hp fraction, then the lower id; never attacks', () => {
    const f = fac();
    const m = medic(f, { x: 300, y: 300 });
    const lowHp = body('0-0-1', SOLDIER, { x: 330, y: 300, hp: 100 });
    const burning = body('0-0-2', SOLDIER, { x: 300, y: 330, hp: 590, burns: [{ ownerId: 'p1', seat: 1, pool: 5, pulsesLeft: 1, nextPulseTick: 9, source: lowHp }] });
    const enemy = body('1-0-0', SOLDIER, { x: 320, y: 300 });
    expect(medicAction(m, world([m, lowHp, burning, enemy]), config)).toEqual({ action: 'heal', targetId: '0-0-2' });
    burning.burns = [];
    expect(medicAction(m, world([m, lowHp, burning, enemy]), config)).toEqual({ action: 'heal', targetId: '0-0-1' });
    // Reloading next to a patient: wait. Patient out of reach but within aggro (150): walk to it.
    expect(medicAction({ ...m, cooldownRemaining: 12 }, world([m, lowHp]), config)).toEqual({ action: 'idle' });
    const away = body('0-0-1', SOLDIER, { x: 440, y: 300, hp: 100 });
    expect(medicAction(m, world([m, away]), config)).toMatchObject({ action: 'move', destination: { x: 440, y: 300 } });
    // From sudden death on it doesn't try to heal.
    expect(medicAction(m, world([m, lowHp], true), config)).not.toMatchObject({ action: 'heal' });
  });

  it('otherwise moves by the order: attack follows a non-medic minion of its factory, else the rally point; defend stays home; guard follows the ally', () => {
    const f = fac();
    const m = medic(f, { x: 300, y: 300 });
    const grunt = body('0-0-9-m2', minionStats(config, '#fff', 'grunt') as StatsSnapshot, { type: 'minion', minion: { factory: f, n: 2, kind: 'grunt' }, x: 360, y: 300 });
    expect(medicAction(m, world([m, grunt]), config)).toMatchObject({ action: 'move', destination: { x: 360, y: 300 } });
    expect(medicAction(m, world([m]), config)).toMatchObject({ action: 'move', destination: { x: 600, y: 100 } });
    expect(medicAction(medic(fac('defend'), { x: 300, y: 300 }), world([m]), config)).toMatchObject({ action: 'move', destination: { x: 100, y: 100 } });
    const tank = body('0-0-1', SOLDIER, { x: 500, y: 500 });
    const g = fac('guard', '0-0-1');
    expect(medicAction(medic(g, { x: 300, y: 300 }), world([tank]), config)).toMatchObject({ action: 'move', destination: { x: 500, y: 500 } });
  });
});

describe('damage-0 sides are eliminated (§9.4 Elimination change)', () => {
  it('a side of only damage-0 units (or a medic-only factory) is out at once and its bodies crumble', async () => {
    const config: GameConfig = deepMerge(C, { timers: { battleTicks: 600 } });
    const run = async (b: FakePlayerSpec) => {
      const { setups } = fakePlayers([{ playerId: 'a', seat: 0, zone: 'TL', units: [design('s', SOLDIER)], placements: [at(0, 0, 's')], brains: { s: idleBrain } }, b]);
      return runBattle({ players: setups, config, seed: 1 });
    };
    const medics = await run({ playerId: 'b', seat: 1, zone: 'BR', units: [design('m', MEDIC), design('w', stats({ type: 'wall' }))], placements: [at(0, 0, 'm'), at(1, 0, 'w')], brains: { m: idleBrain } });
    expect(medics.endReason).toBe('elimination');
    expect(medics.endTick).toBe(0);
    expect(medics.frames[0]!.events).toContainEqual({ type: 'crumble', ids: ['1-0-0', '1-0-1'] });
    expect(medics.ranking.map((r) => [r.playerId, r.place])).toEqual([['a', 1], ['b', 2]]);
    const tent = await run({ playerId: 'b', seat: 1, zone: 'BR', units: [design('f', stats({ type: 'factory', produces: 'medic' }))], placements: [at(0, 0, 'f')], brains: { f: idleBrain } });
    expect(tent.endTick).toBe(0);
    // With an attacker beside them, support units keep fighting and count their living value.
    const mixed = await run({ playerId: 'b', seat: 1, zone: 'BR', units: [design('m', MEDIC, 751), design('c', CLERIC)], placements: [at(0, 0, 'm'), at(1, 0, 'c')], brains: { m: idleBrain, c: idleBrain } });
    expect(mixed.endReason).toBe('timeout');
    expect(mixed.players.find((p) => p.playerId === 'b')!.livingCost).toBeGreaterThan(751);
    expect(mixed.units.find((u) => u.instanceId === '1-0-0')!.nonFighter).toBe(true);
  });
});

describe('badges: Best Medic and Combo Master (§9 Badges, M8.8)', () => {
  const m = (playerId: string, damage: number, healing?: number, combos?: number) => ({
    playerId, damage, valueDestroyed: 0, kills: 0, livingValue: 0, ...(healing !== undefined ? { healing } : {}), ...(combos !== undefined ? { combos } : {}),
  });
  const pl = (playerId: string, place: number) => ({ playerId, place });

  it('go to the most healing / combos; ties share; a badge needs a value > 0; no points', () => {
    const rows = computeRoundScore([pl('a', 1), pl('b', 2), pl('c', 3)], [m('a', 100, 50, 2), m('b', 10, 80, 2), m('c', 0, 80, 0)], C.scoring);
    const by = Object.fromEntries(rows.map((r) => [r.playerId, r]));
    expect(by.a!.badges).toEqual(['lastStanding', 'biggestHitter', 'comboMaster']);
    expect(by.b!.badges).toEqual(['bestMedic', 'comboMaster']);
    expect(by.c!.badges).toEqual(['bestMedic']);
    // Healing never gives points: the damage bonus follows damage only.
    expect(by.c!.total).toBe(by.c!.placePoints);
    const none = computeRoundScore([pl('a', 1), pl('b', 2)], [m('a', 5, 0, 0), m('b', 5)], C.scoring);
    expect(none.flatMap((r) => r.badges)).not.toContain('bestMedic');
    expect(none.flatMap((r) => r.badges)).not.toContain('comboMaster');
  });
});
