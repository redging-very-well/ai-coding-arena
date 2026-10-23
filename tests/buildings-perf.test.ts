// Timing pass (plan §9.3 Performance, §14 `test:perf` addition, M8.5): the
// buildings worst case with REAL isolates. 8 players on Ring 8 (1200 arena),
// each with 10 soldiers + 2 Swarm Factories (12 code-running fighters) + 12
// walls, minions up to the cap (5 per player, 40 in all), every update()
// looping over all enemies. Shortened to 1,900 ticks: each factory is priced
// for E = 3 minions (at 600, 1,200 and 1,800), so the players reach their
// alive cap (5 each with 8 players) by the end.
// Target unchanged: sim p99 < 8 ms/tick.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deepMerge, DEFAULT_CONFIG, type GameConfig } from '@pixel-clash/shared';
import { validateDetailed } from '../packages/server/src/validator/validate.js';
import { createIvmRunnerFactory } from '../packages/server/src/sandbox/ivmRunner.js';
import type { RunnerUnitDesign } from '../packages/server/src/sandbox/runner.js';
import { BattleEngine, createBattleRunners, designFor, type BattleUnitDesign } from '../packages/server/src/sim/engine.js';
import { worstCasePlacements, worstCaseSpecs } from './helpers/buildingsLoad.js';

const ivm = createIvmRunnerFactory();
const TICKS = 1900;

const SOLDIER_SRC = readFileSync(new URL('../packages/starter-kit/units/basic_soldier.js', import.meta.url), 'utf8');
const FACTORY_SRC = `
export default class SwarmFactory {
  constructor() {
    this.name = 'Swarm Factory';
    this.type = 'factory';
    this.maxHealth = 300;
    this.productionInterval = 600;
    this.color = '#C0A060';
  }
  update(self, enemies, allies, world) {
    let spot = world.center;
    let best = Infinity;
    for (const e of enemies) {
      if (e.type === 'wall') continue;
      const d = Math.hypot(e.x - self.x, e.y - self.y);
      if (d < best) { best = d; spot = { x: e.x, y: e.y }; }
    }
    return { action: 'rally', destination: spot };
  }
}`;
const WALL_SRC = `
export default class BasicWall {
  constructor() {
    this.name = 'Basic Wall';
    this.type = 'wall';
    this.maxHealth = 400;
    this.color = '#8A8F98';
  }
}`;

async function submit(source: string, config: GameConfig, unitId: string): Promise<{ battle: BattleUnitDesign; runner: RunnerUnitDesign }> {
  const d = await validateDetailed(source, { unitId }, config);
  if (!d.result.ok) throw new Error(`validation failed: ${JSON.stringify(d.result.errors)}`);
  const { stats } = d.result.unit;
  const battle = designFor(unitId, stats, config);
  expect(battle.cost).toBe(d.result.unit.cost);
  return { battle, runner: { unitId, compiledJs: d.compiledJs!, stats } };
}

function percentile(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
}

describe('buildings worst case (M8.5 timing)', () => {
  it('8p × (10 soldiers + 2 Swarm Factories + 12 walls) on Ring 8: sim p99 < 8 ms/tick', async () => {
    const config: GameConfig = deepMerge(DEFAULT_CONFIG, { timers: { battleTicks: TICKS } });
    const [soldier, factory, wall] = await Promise.all([
      submit(SOLDIER_SRC, config, 's'),
      submit(FACTORY_SRC, config, 'f'),
      submit(WALL_SRC, config, 'w'),
    ]);
    expect(factory!.battle.cost).toBe(53 + 3 * 28); // E = floor(1899 / 600) = 3: priced for this battle length
    const { layout, specs } = worstCaseSpecs();
    const designs = [soldier!, factory!, wall!];
    const runners = await createBattleRunners(
      ivm,
      specs.map((s) => ({ playerId: s.playerId, seat: s.seat, units: designs.map((d) => d.runner) })),
      config,
      42,
    );
    for (const r of runners.values()) expect([...r.loadErrors]).toEqual([]);
    const engine = new BattleEngine({
      players: specs.map((s) => ({
        playerId: s.playerId,
        seat: s.seat,
        zone: s.zone,
        units: designs.map((d) => d.battle),
        placements: worstCasePlacements(),
        runner: runners.get(s.playerId)!,
      })),
      config,
      seed: 42,
      map: { style: layout.style, width: layout.width },
    });
    const t0 = performance.now();
    const result = await engine.run();
    const wallMs = performance.now() - t0;
    const tickMs = engine.tickMs;
    const p50 = percentile(tickMs, 50);
    const p99 = percentile(tickMs, 99);
    const bodies = Math.max(...engine.frames.map((f) => f.units.length));
    const minions = Math.max(...engine.frames.map((f) => f.units.filter((u) => u[0].includes('-m')).length));
    console.log(
      `[buildings-perf] ${result.units.length} bodies (${minions} minions max at once), ${result.endTick} ticks (${result.endReason}) in ${wallMs.toFixed(0)} ms; ` +
        `tick p50 ${p50.toFixed(3)} ms, p99 ${p99.toFixed(3)} ms, max ${Math.max(...tickMs).toFixed(2)} ms; biggest frame ${bodies} units`,
    );
    expect(result.units.filter((u) => u.type === 'wall')).toHaveLength(96);
    expect(minions).toBeGreaterThan(0);
    for (const p of result.players) expect(p.disabled, `${p.playerId} ${p.disabledReason}`).toBe(false);
    // §9.3 Performance: target unchanged, sim p99 < 8 ms/tick.
    expect(p99).toBeLessThan(8);
  }, 180_000);
});
