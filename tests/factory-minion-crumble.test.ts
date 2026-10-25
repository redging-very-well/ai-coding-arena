// Minions die with their factory (plan §5, §9.3, §17; user decision 2026-10-25:
// "Try 'minions die with their factory'"): host option
// `factory.minionsDieWithFactory`. In step 9a, right after step 9 removed the
// dead, the living minions of every factory removed in step 9 crumble (factory
// by factory, instanceId order) in one `crumble` event with the factory's id.
// The unit whose hit destroyed the factory gets a kill and the minion's value
// destroyed for each; stored minions are lost as before (the factory's value at
// death already counts them). Minions show `factoryId` in every view.
//
// `factory.crumbleRadius` (user decision 2026-10-25: "Only minions NEAR the
// factory crumble"): only the minions whose centre is within that many px of
// the factory's centre (distance <= radius) crumble; the rest keep fighting.
// 0 = every minion of the factory, wherever it is (the tests above the radius
// block use 0).

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, deepMerge, type FrameDTO, type GameConfig, type OtherView, type PlacementDTO } from '@pixel-clash/shared';
import { BattleEngine } from '../packages/server/src/sim/engine.js';
import { minionValueOf, withinCrumbleRadius } from '../packages/server/src/sim/minion.js';
import { unitTypeRules } from '../packages/server/src/services/rules.js';
import { buildGuide } from '../packages/server/src/services/guide.js';
import { design, fakePlayers, idleBrain, scripted, stats, type FakePlayerSpec } from './helpers/fakeRunner.js';

const FACTORY = (interval: number, over: object = {}) => stats({ type: 'factory', productionInterval: interval, maxHealth: 120, ...over });
const at = (col: number, row: number, unitId: string): PlacementDTO => ({ unitId, col, row });
/** A 2400-tick battle without sudden death damage; the option on unless patched off; every minion crumbles unless `radius` is set. */
const cfg = (on = true, patch: object = {}, radius = 0): GameConfig =>
  deepMerge(DEFAULT_CONFIG, {
    timers: { battleTicks: 2400 },
    suddenDeath: { startTick: 2300, endTick: 2400, damagePctPerSecond: 0 },
    factory: { minionsDieWithFactory: on, crumbleRadius: radius },
    ...patch,
  });

function run(specs: FakePlayerSpec[], config: GameConfig, seed = 3) {
  const { setups } = fakePlayers(specs);
  const engine = new BattleEngine({ players: setups, config, seed });
  return { engine, done: engine.run() };
}
const events = (frames: FrameDTO[]) => frames.flatMap((f) => f.events.map((e) => ({ t: f.t, e })));
const crumbles = (frames: FrameDTO[]) =>
  events(frames)
    .filter((x) => x.e.type === 'crumble')
    .map((x) => ({ t: x.t, ...(x.e as { ids: string[]; factoryId?: string }) }));
const deathT = (frames: FrameDTO[], id: string) => events(frames).find((x) => x.e.type === 'death' && (x.e as { instanceId: string }).instanceId === id)?.t;

/** Waits until `from`, then walks to the factory with id `targetId` (or the first enemy factory) and hits only it. */
const hunter = (from: number, targetId?: string) =>
  scripted((self, enemies, _a, world) => {
    if (world.tick < from) return { action: 'idle' };
    const f = enemies.find((e) => e.type === 'factory' && (!targetId || e.id === targetId));
    if (!f) return { action: 'idle' };
    const gap = Math.hypot(f.x - self.x, f.y - self.y) - self.radius - f.radius;
    return gap <= self.range ? { action: 'attack', targetId: f.id } : { action: 'move', destination: { x: f.x, y: f.y } };
  });
const STRONG = stats({ type: 'soldier', maxHealth: 4000, damage: 240, attackCooldown: 10, speed: 4 });
/** Minions wait at home, away from the hunter's path. */
const rallyHome = scripted(() => ({ action: 'rally', destination: { x: 60, y: 60 } }));
const KEEPER = stats({ type: 'tower', damage: 5 });

/** a: factories (+ an idle tower so it stays in the battle); b: one hunter. */
function battle(config: GameConfig, opts: { factories?: string[][]; target?: string; from?: number; burst?: number; seed?: number; rally?: { x: number; y: number } } = {}) {
  const rally = opts.rally;
  const facs = opts.factories ?? [['f', '2', '2']];
  return run(
    [
      {
        playerId: 'a',
        seat: 0,
        zone: 'TL',
        units: [design('f', FACTORY(300, opts.burst ? { burst: opts.burst } : {}), undefined, config), design('k', KEEPER)],
        placements: [...facs.map(([u, c, r]) => at(Number(c), Number(r), u!)), at(0, 5, 'k')],
        brains: { f: rally ? scripted(() => ({ action: 'rally', destination: rally })) : rallyHome, k: idleBrain },
      },
      { playerId: 'b', seat: 1, zone: 'BR', units: [design('s', STRONG)], placements: [at(0, 0, 's')], brains: { s: hunter(opts.from ?? 1000, opts.target) } },
    ],
    config,
    opts.seed,
  );
}

describe('minions die with their factory (§9.3)', () => {
  it('is off by default', () => {
    expect(DEFAULT_CONFIG.factory.minionsDieWithFactory).toBe(false);
    // The radius a host gets by turning it on (§14 "Only minions near the factory crumble").
    expect(DEFAULT_CONFIG.factory.crumbleRadius).toBe(120);
  });

  it("the factory's living minions crumble in the tick it dies, in one event naming the factory", async () => {
    const config = cfg();
    const { engine, done } = battle(config);
    const result = await done;
    const fac = result.units.find((u) => u.instanceId === '0-2-2')!;
    expect(fac.survived).toBe(false);
    const died = fac.diedAtTick!;
    expect(deathT(engine.frames, '0-2-2')).toBe(died);
    const minions = result.units.filter((u) => u.instanceId.startsWith('0-2-2-m'));
    expect(minions.length).toBeGreaterThanOrEqual(3);
    const c = crumbles(engine.frames);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ t: died, factoryId: '0-2-2' });
    expect(c[0]!.ids).toEqual(minions.filter((m) => m.diedAtTick === died).map((m) => m.instanceId).sort());
    // Every minion alive when the factory fell dies with it: none survives, none lives past it.
    for (const m of minions) {
      expect(m.survived).toBe(false);
      expect(m.diedAtTick!).toBeLessThanOrEqual(died);
    }
    const after = engine.frames.find((f) => f.t >= died)!;
    expect(after.units.some((u) => u[0].startsWith('0-2-2-m'))).toBe(false);
    expect(fac.factory!.minionsLost).toBe(minions.length);
  });

  it('credits the unit that destroyed the factory with a kill and the value of each crumbled minion', async () => {
    const bOn = battle(cfg(true));
    const bOff = battle(cfg(false));
    const on = { engine: bOn.engine, result: await bOn.done };
    const off = { engine: bOff.engine, result: await bOff.done };
    const killer = (r: typeof on.result) => r.units.find((u) => u.instanceId === '1-0-0')!;
    // Off: the hunter killed only the factory (it never hits minions).
    expect(killer(off.result).kills).toBe(1);
    const crumbled = crumbles(on.engine.frames)[0]!.ids.length;
    expect(crumbled).toBeGreaterThanOrEqual(3);
    expect(killer(on.result).kills).toBe(1 + crumbled);
    expect(killer(on.result).valueDestroyed).toBe(killer(off.result).valueDestroyed + crumbled * minionValueOf(cfg()));
    // No damage credit for the crumble: damage dealt is the same.
    expect(killer(on.result).damageDealt).toBe(killer(off.result).damageDealt);
  });

  it("stored minions are lost as before (not in the crumble), and only that factory's minions crumble", async () => {
    const config = cfg();
    // Two factories with burst 4 (3 stored at tick 1000: 300, 600, 900), the hunter goes for the one at
    // col 4, row 2 (instanceId seat-row-col).
    const { engine, done } = battle(config, { factories: [['f', '2', '2'], ['f', '4', '2']], burst: 4, from: 950, target: '0-2-4' });
    const result = await done;
    const hit = result.units.find((u) => u.instanceId === '0-2-4')!;
    const other = result.units.find((u) => u.instanceId === '0-2-2')!;
    expect(hit.survived).toBe(false);
    expect(hit.factory!.storedLost).toBeGreaterThan(0);
    const lost = events(engine.frames).filter((x) => x.e.type === 'lost');
    expect(lost.map((x) => x.e)).toEqual([{ type: 'lost', factoryId: '0-2-4', count: hit.factory!.storedLost }]);
    // The other factory and its minions carry on.
    expect(other.survived).toBe(true);
    expect(other.factory!.minionsMade).toBeGreaterThan(0);
    const c = crumbles(engine.frames);
    for (const x of c) expect(x.ids.every((id) => id.startsWith('0-2-4-m'))).toBe(true);
    expect(result.units.filter((u) => u.instanceId.startsWith('0-2-2-m')).some((m) => m.survived)).toBe(true);
  });

  it('a minion shows its factoryId to enemies and allies (other bodies have none)', async () => {
    const config = cfg();
    const seen: OtherView[] = [];
    const watcher = scripted((_s, enemies) => {
      for (const e of enemies) if (e.type === 'minion' || seen.length < 5) seen.push(e);
      return { action: 'idle' };
    });
    const { done } = run(
      [
        { playerId: 'a', seat: 0, zone: 'TL', units: [design('f', FACTORY(300), undefined, config), design('k', KEEPER)], placements: [at(2, 2, 'f'), at(0, 5, 'k')], brains: { f: rallyHome, k: idleBrain } },
        { playerId: 'b', seat: 1, zone: 'BR', units: [design('t', KEEPER)], placements: [at(0, 0, 't')], brains: { t: watcher } },
      ],
      deepMerge(config, { timers: { battleTicks: 700 } }),
    );
    await done;
    const minion = seen.find((e) => e.type === 'minion');
    expect(minion?.factoryId).toBe('0-2-2');
    expect(seen.filter((e) => e.type !== 'minion').every((e) => !('factoryId' in e))).toBe(true);
  });

  it('off: minions outlive their factory, and with no factory destroyed on and off play the same frames', async () => {
    const { engine, done } = battle(cfg(false));
    const result = await done;
    expect(crumbles(engine.frames).filter((c) => c.factoryId)).toEqual([]);
    expect(result.units.filter((u) => u.instanceId.startsWith('0-2-2-m')).some((m) => m.survived)).toBe(true);
    // The hunter never comes: on and off are frame for frame identical.
    const [a, b] = [battle(cfg(true), { from: 99_999 }), battle(cfg(false), { from: 99_999 })];
    await Promise.all([a.done, b.done]);
    expect(JSON.stringify(a.engine.frames)).toBe(JSON.stringify(b.engine.frames));
  });

  it('get_rules and the guide state the rule only when it is on', () => {
    const off = unitTypeRules(DEFAULT_CONFIG).factories as { text: string; minionsDieWithFactory: boolean };
    expect(off.minionsDieWithFactory).toBe(false);
    expect(off.text).toContain('its minions keep going');
    const onCfg = deepMerge(DEFAULT_CONFIG, { factory: { minionsDieWithFactory: true, crumbleRadius: 0 } });
    const on = unitTypeRules(onCfg).factories as typeof off;
    expect(on.minionsDieWithFactory).toBe(true);
    expect(on.text).toContain('crumble with it in the same tick');
    expect(on.text).not.toContain('its minions keep going');
    const text = (g: unknown) => JSON.stringify(g);
    expect(text(buildGuide(onCfg))).toContain('its minions crumble with it');
    expect(text(buildGuide(DEFAULT_CONFIG))).not.toContain('its minions crumble with it');
  });

  it('is deterministic', async () => {
    const make = () => battle(cfg(), { factories: [['f', '2', '2'], ['f', '4', '2']], burst: 2, seed: 7 });
    const r1 = make();
    const r2 = make();
    await Promise.all([r1.done, r2.done]);
    expect(crumbles(r1.engine.frames).length).toBeGreaterThan(0);
    expect(JSON.stringify(r1.engine.frames)).toBe(JSON.stringify(r2.engine.frames));
  });
});

describe('only minions near the factory crumble (factory.crumbleRadius)', () => {
  // The factory (centre 140, 140) rallies its minions far away (60, 700): at its death
  // (the hunter starts at tick 1150, so about tick 1290) three minions are 540-575 px
  // away and the newest one about 106 px from it.
  const FAR = { x: 60, y: 700 };
  const FROM = 1150;
  const near = (radius: number, on = true) => battle(cfg(on, { sim: { frameEveryTicks: 1 } }, radius), { rally: FAR, from: FROM });
  /** The factory's minions alive when it died, with their distance to it (from the option-off battle, identical up to then). */
  async function atDeath() {
    const { engine, done } = near(0, false);
    const result = await done;
    const fac = result.units.find((u) => u.instanceId === '0-2-2')!;
    const died = fac.diedAtTick!;
    const before = engine.frames.find((f) => f.t === died - 1)!.units.find((u) => u[0] === '0-2-2')!;
    const frame = engine.frames.find((f) => f.t === died)!;
    const minions = frame.units.filter((u) => u[0].startsWith('0-2-2-m')).map((u) => ({ id: u[0], d: Math.hypot(u[1] - before[1], u[2] - before[2]) }));
    return { died, minions };
  }

  it('crumbles only the minions within the radius; the ones further out keep fighting', async () => {
    const { died, minions } = await atDeath();
    const inside = minions.filter((m) => m.d <= 200).map((m) => m.id);
    const outside = minions.filter((m) => m.d > 200).map((m) => m.id);
    expect(inside.length).toBeGreaterThan(0);
    expect(outside.length).toBeGreaterThan(0);
    const { engine, done } = near(200);
    const result = await done;
    expect(result.units.find((u) => u.instanceId === '0-2-2')!.diedAtTick).toBe(died);
    const c = crumbles(engine.frames);
    expect(c).toEqual([{ t: died, type: 'crumble', ids: [...inside].sort(), factoryId: '0-2-2' }]);
    // The ones out of reach are still alive after the crumble (nothing else attacks them here).
    for (const id of outside) expect(result.units.find((u) => u.instanceId === id)!.survived).toBe(true);
    const later = engine.frames.find((f) => f.t === died + 60)!;
    expect(later.units.filter((u) => u[0].startsWith('0-2-2-m')).map((u) => u[0]).sort()).toEqual([...outside].sort());
  });

  it('the boundary: a minion exactly at the radius crumbles, one just past it does not; 0 means every minion', async () => {
    const { minions } = await atDeath();
    const nearest = minions.reduce((a, b) => (b.d < a.d ? b : a));
    // Frame positions are rounded to 0.01 px, so step 0.05 px either side of the measured distance.
    const runIds = async (r: number) => {
      const b = near(r);
      await b.done;
      return crumbles(b.engine.frames).flatMap((c) => c.ids);
    };
    expect(await runIds(nearest.d + 0.05)).toEqual([nearest.id]);
    expect(await runIds(nearest.d - 0.05)).toEqual([]);
    expect((await runIds(0)).sort()).toEqual(minions.map((m) => m.id).sort());
    expect((await runIds(10_000)).sort()).toEqual(minions.map((m) => m.id).sort());
    // Exactly on the radius counts as inside (distance <= radius).
    expect(withinCrumbleRadius({ x: 100, y: 0 }, { x: 0, y: 0 }, 100)).toBe(true);
    expect(withinCrumbleRadius({ x: 60, y: 80 }, { x: 0, y: 0 }, 100)).toBe(true);
    expect(withinCrumbleRadius({ x: 100.001, y: 0 }, { x: 0, y: 0 }, 100)).toBe(false);
    expect(withinCrumbleRadius({ x: 5000, y: 5000 }, { x: 0, y: 0 }, 0)).toBe(true);
  });

  it('credits the killer only for the minions that crumbled', async () => {
    const bOn = near(200);
    const bOff = near(200, false);
    const [on, off] = await Promise.all([bOn.done, bOff.done]);
    const killer = (r: typeof on) => r.units.find((u) => u.instanceId === '1-0-0')!;
    const crumbled = crumbles(bOn.engine.frames).flatMap((c) => c.ids).length;
    expect(crumbled).toBeGreaterThan(0);
    expect(killer(on).kills).toBe(killer(off).kills + crumbled);
    expect(killer(on).valueDestroyed).toBe(killer(off).valueDestroyed + crumbled * minionValueOf(cfg()));
    expect(killer(on).damageDealt).toBe(killer(off).damageDealt);
  });

  it('get_rules and the guide state the radius only when the option is on', () => {
    type F = { text: string; minionsDieWithFactory: boolean; crumbleRadius?: number };
    const on = deepMerge(DEFAULT_CONFIG, { factory: { minionsDieWithFactory: true, crumbleRadius: 170 } });
    const off = deepMerge(DEFAULT_CONFIG, { factory: { minionsDieWithFactory: false, crumbleRadius: 170 } });
    const all = deepMerge(DEFAULT_CONFIG, { factory: { minionsDieWithFactory: true, crumbleRadius: 0 } });
    const rOn = unitTypeRules(on).factories as F;
    expect(rOn.crumbleRadius).toBe(170);
    expect(rOn.text).toContain('its minions within 170 px of it (centre to centre) crumble with it in the same tick');
    expect(rOn.text).toContain('its minions further away keep fighting');
    const rOff = unitTypeRules(off).factories as F;
    expect(rOff.crumbleRadius).toBeUndefined();
    expect(rOff.text).not.toContain('170 px');
    const rAll = unitTypeRules(all).factories as F;
    expect(rAll.text).toContain('its minions out on the field crumble with it');
    const g = (c: GameConfig) => JSON.stringify(buildGuide(c));
    expect(g(on)).toContain('the ones within 170 px of it (centre to centre) die the same tick');
    expect(g(off)).not.toContain('170 px');
    expect(g(all)).toContain('the ones out on the field die the same tick');
  });

  it('is deterministic, and off plays the same frames whatever the radius', async () => {
    const [a, b] = [near(200), near(200)];
    await Promise.all([a.done, b.done]);
    expect(JSON.stringify(a.engine.frames)).toBe(JSON.stringify(b.engine.frames));
    const [x, y] = [near(0, false), near(200, false)];
    await Promise.all([x.done, y.done]);
    expect(JSON.stringify(x.engine.frames)).toBe(JSON.stringify(y.engine.frames));
  });
});
