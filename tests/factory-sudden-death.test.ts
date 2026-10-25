// Factories stop at sudden death (plan §5.2, §9.3, §17; user decision
// 2026-10-25: "No new minions once the safe circle starts shrinking, so camps
// can't out-produce a standoff"): no minion appears at or after
// suddenDeath.startTick, the timers stop and the unbuilt minions are gone;
// minions already out keep fighting; stored burst minions still leave (they
// already exist); E prices only what can be made before sudden death.

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, computeCost, deepMerge, expectedMinions, pricingOf, productionEndTick, type FrameDTO, type GameConfig, type PlacementDTO } from '@pixel-clash/shared';
import { BattleEngine } from '../packages/server/src/sim/engine.js';
import { unitTypeRules } from '../packages/server/src/services/rules.js';
import { buildGuide } from '../packages/server/src/services/guide.js';
import { design, fakePlayers, idleBrain, scripted, stats, type FakePlayerSpec } from './helpers/fakeRunner.js';

const SD = 1500;
const FACTORY = (interval: number, over: object = {}) => stats({ type: 'factory', productionInterval: interval, ...over });
const at = (col: number, row: number, unitId: string): PlacementDTO => ({ unitId, col, row });
/** Sudden death from tick 1500 of 2400, without damage (so nothing dies to the circle). */
const cfg = (patch: object = {}): GameConfig =>
  deepMerge(DEFAULT_CONFIG, {
    timers: { battleTicks: 2400 },
    suddenDeath: { startTick: SD, endTick: 2400, damagePctPerSecond: 0 },
    factory: { maxAlivePerFactory: 8, maxAlivePerPlayer: 8, stopAtSuddenDeath: true },
    ...patch,
  });

function run(specs: FakePlayerSpec[], config: GameConfig, seed = 3) {
  const { setups } = fakePlayers(specs);
  const engine = new BattleEngine({ players: setups, config, seed });
  return { engine, done: engine.run() };
}
const events = (frames: FrameDTO[]) => frames.flatMap((f) => f.events.map((e) => ({ t: f.t, e })));
const spawnTimes = (frames: FrameDTO[]) => events(frames).filter((x) => x.e.type === 'spawn' && 'factoryId' in x.e).map((x) => x.t);
const frameAtT = (frames: FrameDTO[], t: number) => frames.find((f) => f.t === t)!;
const farEnemy = (): FakePlayerSpec => ({ playerId: 'b', seat: 1, zone: 'BR', units: [design('t', stats({ type: 'tower', damage: 5 }))], placements: [at(5, 5, 't')], brains: { t: idleBrain } });
const rallyHome = scripted((self) => ({ action: 'rally', destination: { x: self.x - 60, y: self.y - 60 } }));

describe('factories stop at sudden death (§9.3)', () => {
  it('the production window ends at suddenDeath.startTick (or the battle end), and E counts only what fits in it', () => {
    // Off by default: factories build until the end of the battle, priced as before.
    expect(DEFAULT_CONFIG.factory.stopAtSuddenDeath).toBe(false);
    expect(productionEndTick(DEFAULT_CONFIG)).toBe(DEFAULT_CONFIG.timers.battleTicks);
    expect(pricingOf(DEFAULT_CONFIG).productionTicks).toBe(DEFAULT_CONFIG.timers.battleTicks);
    expect(productionEndTick(deepMerge(DEFAULT_CONFIG, { factory: { stopAtSuddenDeath: true } }))).toBe(DEFAULT_CONFIG.suddenDeath.startTick);
    expect(productionEndTick(cfg())).toBe(SD);
    // Sudden death after the end of the battle: the battle end limits production.
    expect(productionEndTick(deepMerge(DEFAULT_CONFIG, { factory: { stopAtSuddenDeath: true }, timers: { battleTicks: 900 }, suddenDeath: { startTick: 100_000, endTick: 100_001 } }))).toBe(900);
    // floor((1500 - 1) / interval), capped at maxMinionsPerFactory.
    const P = pricingOf(cfg());
    expect([300, 400, 500, 750, 1200].map((i) => expectedMinions(i, P))).toEqual([4, 3, 2, 1, 1]);
    const f = FACTORY(300);
    const prod = computeCost(f, cfg().cost, P).breakdown.production!;
    expect(prod.expected).toBe(4);
    expect(prod.text).toBe('Production: 4 minions (what it can make before sudden death) × $177 (half of a $353 minion) = $708');
    // On with the default 120 s battle (sudden death at 75 s): E = min(12, floor(4499 / interval)).
    const on = pricingOf(deepMerge(DEFAULT_CONFIG, { factory: { stopAtSuddenDeath: true } }));
    expect([300, 374, 375, 600, 720, 900, 1200].map((i) => expectedMinions(i, on))).toEqual([12, 12, 11, 7, 6, 4, 3]);
  });

  it('no minion appears at or after sudden death: spawns at I, 2I, … < startTick, then the timer stops for good', async () => {
    const config = cfg();
    const { engine, done } = run([{ playerId: 'a', seat: 0, zone: 'TL', units: [design('f', FACTORY(300), undefined, config)], placements: [at(2, 2, 'f')], brains: { f: rallyHome } }, farEnemy()], config);
    const result = await done;
    expect(spawnTimes(engine.frames)).toEqual([300, 600, 900, 1200]);
    // Frames from sudden death: no minions left, nothing it can make, the "done" ring (progress 100).
    for (const t of [SD, 1800, 2398]) {
      const fac = frameAtT(engine.frames, t).fac![0]!;
      expect([fac[1], fac[2], fac[6]], `t=${t}`).toEqual([100, 0, 0]);
    }
    expect(result.units.find((u) => u.instanceId === '0-2-2')!.factory).toMatchObject({ minionsLeft: 0, minionsMade: 4, canMake: 0 });
  });

  it('a factory with minions still to make (it held) loses them at sudden death', async () => {
    const config = cfg();
    // Holds until tick 900: E = 4, but only 2 fit before 1500 (1200, and 1500 is too late).
    const holdEarly = scripted((self, _e, _a, world) => (world.tick < 900 ? { action: 'hold' } : { action: 'rally', destination: { x: self.x - 60, y: self.y - 60 } }));
    const { engine, done } = run([{ playerId: 'a', seat: 0, zone: 'TL', units: [design('f', FACTORY(300), undefined, config)], placements: [at(2, 2, 'f')], brains: { f: holdEarly } }, farEnemy()], config);
    const result = await done;
    expect(spawnTimes(engine.frames)).toEqual([1200]);
    expect(result.units.find((u) => u.instanceId === '0-2-2')!.factory).toMatchObject({ minionsMade: 1, minionsLeft: 0, canMake: 0 });
  });

  it('self.factory.producing turns false (and minionsLeft 0) once no minion can appear before sudden death', async () => {
    const config = cfg();
    const seen: Array<{ t: number; producing: boolean; left: number }> = [];
    const brain = scripted((self, _e, _a, world) => {
      seen.push({ t: world.tick, producing: self.factory!.producing, left: self.factory!.minionsLeft });
      return { action: 'rally', destination: { x: self.x - 60, y: self.y - 60 } };
    });
    const { done } = run([{ playerId: 'a', seat: 0, zone: 'TL', units: [design('f', FACTORY(400), undefined, config)], placements: [at(2, 2, 'f')], brains: { f: brain } }, farEnemy()], config);
    await done;
    expect(seen.find((v) => v.t === 0)).toEqual({ t: 0, producing: true, left: 3 });
    expect(seen.find((v) => v.t === SD - 2)).toMatchObject({ producing: true });
    expect(seen.find((v) => v.t === SD - 1)).toMatchObject({ producing: false, left: 0 });
    expect(seen.filter((v) => v.t >= SD).every((v) => !v.producing && v.left === 0)).toBe(true);
  });

  it('minions already out keep fighting after sudden death', async () => {
    const config = cfg();
    const target = stats({ type: 'tower', damage: 0, maxHealth: 4000 });
    const rallyAtTower = scripted((self, enemies) => {
      const t = enemies.find((e) => e.type === 'tower');
      return t ? { action: 'rally', destination: { x: t.x, y: t.y } } : { action: 'rally', destination: { x: self.x, y: self.y } };
    });
    const { engine, done } = run(
      [
        { playerId: 'a', seat: 0, zone: 'TL', units: [design('f', FACTORY(300), undefined, config)], placements: [at(2, 2, 'f')], brains: { f: rallyAtTower } },
        // A damage-0 tower is no fighter, so a damage-5 tower that never shoots keeps side b in the battle.
        { playerId: 'b', seat: 1, zone: 'BR', units: [design('t', target), design('k', stats({ type: 'tower', damage: 5 }))], placements: [at(3, 3, 't'), at(5, 5, 'k')], brains: { t: idleBrain, k: idleBrain } },
      ],
      config,
    );
    await done;
    const hpAt = (t: number) => frameAtT(engine.frames, t).units.find((u) => u[0] === '1-3-3')?.[3] ?? 0;
    expect(spawnTimes(engine.frames).every((t) => t < SD)).toBe(true);
    const minionsAfter = frameAtT(engine.frames, 2000).units.filter((u) => u[0].includes('-m')).length;
    expect(minionsAfter).toBe(4);
    expect(hpAt(2000)).toBeLessThan(hpAt(SD));
  });

  it('stored burst minions already exist: they leave together once the store can no longer fill before sudden death', async () => {
    const config = cfg();
    // Burst 4 at interval 300 after holding until tick 300: 3 are made (600, 900, 1200) and the 4th
    // would come at 1500, too late, so the three leave together on the next tick.
    const holdEarly = scripted((self, _e, _a, world) => (world.tick < 300 ? { action: 'hold' } : { action: 'rally', destination: { x: self.x - 60, y: self.y - 60 } }));
    const { engine, done } = run([{ playerId: 'a', seat: 0, zone: 'TL', units: [design('f', FACTORY(300, { burst: 4 }), undefined, config)], placements: [at(2, 2, 'f')], brains: { f: holdEarly } }, farEnemy()], config);
    const result = await done;
    expect(spawnTimes(engine.frames)).toEqual([1202, 1202, 1202]);
    expect(events(engine.frames).filter((x) => x.e.type === 'release').map((x) => [x.t, (x.e as { count: number }).count])).toEqual([[1202, 3]]);
    expect(result.units.find((u) => u.instanceId === '0-2-2')!.factory).toMatchObject({ minionsMade: 3, minionsLeft: 0, stored: 0, storedLost: 0 });
  });

  it('after sudden death a factory with nothing stored is no fighter: a side left with only factories is out', async () => {
    const config = cfg({ suddenDeath: { startTick: SD, endTick: 2400, damagePctPerSecond: 0 } });
    // Side a: one factory whose minions never come out (it holds the whole battle); b: an idle tower.
    const hold = scripted(() => ({ action: 'hold' }));
    const { done } = run([{ playerId: 'a', seat: 0, zone: 'TL', units: [design('f', FACTORY(300), undefined, config)], placements: [at(2, 2, 'f')], brains: { f: hold } }, farEnemy()], config);
    const result = await done;
    const a = result.units.find((u) => u.instanceId === '0-2-2')!;
    expect(a.factory).toMatchObject({ minionsMade: 0, canMake: 0 });
    expect(result.endTick).toBeLessThanOrEqual(SD);
    expect(result.endReason).not.toBe("timeout");
  });

  it('off (the default): production runs to the end of the battle and producing stays true', async () => {
    const config = cfg({ factory: { maxAlivePerFactory: 8, maxAlivePerPlayer: 8, stopAtSuddenDeath: false } });
    const seen: boolean[] = [];
    const brain = scripted((self) => {
      seen.push(self.factory!.producing);
      return { action: 'rally', destination: { x: self.x - 60, y: self.y - 60 } };
    });
    const { engine, done } = run([{ playerId: 'a', seat: 0, zone: 'TL', units: [design('f', FACTORY(400), undefined, config)], placements: [at(2, 2, 'f')], brains: { f: brain } }, farEnemy()], config);
    await done;
    expect(spawnTimes(engine.frames)).toEqual([400, 800, 1200, 1600, 2000]);
    expect(seen.every((p) => p)).toBe(true);
  });

  it('get_rules and the guide state the option and its facts only when it is on', () => {
    const off = unitTypeRules(DEFAULT_CONFIG).factories as { text: string; stopAtSuddenDeath: boolean; minionsPerBattle: Record<string, number> };
    expect(off.stopAtSuddenDeath).toBe(false);
    expect(off.text).not.toMatch(/sudden death/);
    const onCfg = deepMerge(DEFAULT_CONFIG, { factory: { stopAtSuddenDeath: true } });
    const on = unitTypeRules(onCfg).factories as typeof off;
    expect(on.stopAtSuddenDeath).toBe(true);
    expect(on.text).toContain('Factories stop building at sudden death (75 s)');
    expect(on.minionsPerBattle['1200']).toBe(3);
    const text = (g: unknown) => JSON.stringify(g);
    expect(text(buildGuide(onCfg))).toContain('Factories stop building at sudden death (75 s)');
    expect(text(buildGuide(DEFAULT_CONFIG))).not.toContain('Factories stop building at sudden death');
  });

  it('is deterministic', async () => {
    const config = cfg();
    const make = () =>
      run([{ playerId: 'a', seat: 0, zone: 'TL', units: [design('f', FACTORY(400, { burst: 2 }), undefined, config)], placements: [at(2, 2, 'f'), at(4, 4, 'f')], brains: { f: rallyHome } }, farEnemy()], config, 7);
    const r1 = make();
    const r2 = make();
    await Promise.all([r1.done, r2.done]);
    expect(JSON.stringify(r1.engine.frames)).toBe(JSON.stringify(r2.engine.frames));
  });
});
