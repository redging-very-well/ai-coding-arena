// Factories die at sudden death (plan §9.3, §17; user 2026-10-25: "add an
// option that makes factories die at sudden death. Enable it by default"): on
// the first tick of sudden death every factory still standing is destroyed,
// credited to nobody; stored minions are lost with it; other bodies are untouched.

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, deepMerge, type GameConfig, type PlacementDTO } from '@pixel-clash/shared';
import { BattleEngine } from '../packages/server/src/sim/engine.js';
import { unitTypeRules } from '../packages/server/src/services/rules.js';
import { buildGuide } from '../packages/server/src/services/guide.js';
import { design, fakePlayers, idleBrain, scripted, stats, type FakePlayerSpec } from './helpers/fakeRunner.js';

const SD = 1500;
const at = (col: number, row: number, unitId: string): PlacementDTO => ({ unitId, col, row });
/** Sudden death from tick 1500 of 2400, without circle damage (so only the rule can kill). */
const cfg = (die: boolean): GameConfig =>
  deepMerge(DEFAULT_CONFIG, {
    timers: { battleTicks: 2400 },
    suddenDeath: { startTick: SD, endTick: 2400, damagePctPerSecond: 0 },
    factory: { dieAtSuddenDeath: die },
  });
const rallyHome = scripted((self) => ({ action: 'rally', destination: { x: self.x - 60, y: self.y - 60 } }));
const side = (config: GameConfig): FakePlayerSpec[] => [
  {
    playerId: 'a', seat: 0, zone: 'TL',
    units: [design('f', stats({ type: 'factory', productionInterval: 300 }), undefined, config), design('t', stats({ type: 'tower', damage: 5 }))],
    placements: [at(2, 2, 'f'), at(0, 0, 't')],
    brains: { f: rallyHome, t: idleBrain },
  },
  { playerId: 'b', seat: 1, zone: 'BR', units: [design('t', stats({ type: 'tower', damage: 5 }))], placements: [at(5, 5, 't')], brains: { t: idleBrain } },
];
async function run(config: GameConfig) {
  const { setups } = fakePlayers(side(config));
  const engine = new BattleEngine({ players: setups, config, seed: 3 });
  const result = await engine.run();
  return { engine, result };
}
const deathTick = (engine: BattleEngine, id: string) =>
  engine.frames.find((f) => f.events.some((e) => e.type === 'death' && 'instanceId' in e && e.instanceId === id))?.t;

describe('factories die at sudden death (§9.3)', () => {
  it('is on by default', () => {
    expect(DEFAULT_CONFIG.factory.dieAtSuddenDeath).toBe(true);
  });

  it('every factory dies on the first sudden-death tick, credited to nobody; towers and minions are untouched', async () => {
    const { engine, result } = await run(cfg(true));
    const fac = result.units.find((u) => u.instanceId === '0-2-2')!;
    expect(fac.survived).toBe(false);
    const t = deathTick(engine, '0-2-2')!;
    expect(t).toBeGreaterThanOrEqual(SD);
    expect(t).toBeLessThanOrEqual(SD + 2); // frames are recorded every 2nd tick
    // Nobody gets the factory's value.
    for (const u of result.units) expect(u.valueDestroyed ?? 0).toBe(0);
    // Both towers live on (no circle damage in this config); its minions made before sudden death still exist.
    expect(result.units.find((u) => u.instanceId === '0-0-0')!.survived).toBe(true);
    expect(result.units.find((u) => u.instanceId === '1-5-5')!.survived).toBe(true);
  });

  it('off: the factory lives on through sudden death', async () => {
    const { engine, result } = await run(cfg(false));
    expect(result.units.find((u) => u.instanceId === '0-2-2')!.survived).toBe(true);
    expect(deathTick(engine, '0-2-2')).toBeUndefined();
  });

  it('get_rules and the guide state it as a fact only when on', () => {
    const on = cfg(true);
    const off = cfg(false);
    expect(JSON.stringify(unitTypeRules(on))).toContain('is destroyed when sudden death starts');
    expect(JSON.stringify(unitTypeRules(off))).not.toContain('is destroyed when sudden death starts');
    expect(JSON.stringify(buildGuide(on))).toContain('is destroyed when sudden death starts');
    expect(JSON.stringify(buildGuide(off))).not.toContain('is destroyed when sudden death starts');
  });
});
