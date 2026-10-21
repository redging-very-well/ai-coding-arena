// Integration (plan §16 M2 acceptance): the REAL path end to end.
//   starter-kit templates → validator (§7) → StatsSnapshot + compiledJs
//   → ivmRunner (isolates in child processes, §8) → BattleEngine (§9).
//
// Checks: a template-vs-template battle produces a ranking, a 5400-tick
// battle finishes in < 2 s of wall time, and the per-tick cost (p50/p99) of
// a 4-player × 8-unit battle and of the §9.2 / §14 load shape (8 players × 12
// copies = 96 units on Ring 8 and as 4v4 on Lanes 8, 1200 arena) stays within
// the 8 ms p99 budget.

import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  assignMapZones,
  assignTeamZones,
  assignZones,
  autoBalance,
  cellCenter,
  mapFor,
  parseConfig,
  type GameConfig,
  type MapLayout,
  type MapStyle,
  type PlacementDTO,
  type TeamMode,
  type ZoneRef,
} from '@pixel-clash/shared';
import { validateDetailed } from '../packages/server/src/validator/validate.js';
import { createIvmRunnerFactory } from '../packages/server/src/sandbox/ivmRunner.js';
import type { RunnerUnitDesign } from '../packages/server/src/sandbox/runner.js';
import {
  BattleEngine,
  buildInstances,
  createBattleRunners,
  designFor,
  type BattlePlayerSetup,
  type BattleResult,
  type BattleUnitDesign,
  runBattle,
} from '../packages/server/src/sim/engine.js';
import { fakePlayers, soldierBrain, towerBrain } from './helpers/fakeRunner.js';

const TEMPLATE_DIR = new URL('../packages/starter-kit/units/', import.meta.url);
const ivm = createIvmRunnerFactory();

/** A design as the units service would store it after submit_unit. */
interface StoredDesign {
  battle: BattleUnitDesign;
  runner: RunnerUnitDesign;
}

/** Validate a source through the real §7 pipeline (fresh isolate), like submit_unit does. */
async function submit(source: string, config: GameConfig): Promise<StoredDesign> {
  const d = await validateDetailed(source, {}, config);
  if (!d.result.ok) throw new Error(`validation failed: ${JSON.stringify(d.result.errors)}`);
  expect(d.compiledJs).toBeTypeOf('string');
  const { unitId, stats } = d.result.unit;
  const battle = designFor(unitId, stats, config);
  // The engine reprices from config; it must agree with the validator.
  expect(battle.cost).toBe(d.result.unit.cost);
  return { battle, runner: { unitId, compiledJs: d.compiledJs!, stats } };
}

const template = (file: string) => readFileSync(new URL(file, TEMPLATE_DIR), 'utf8');

interface PlayerSpec {
  playerId: string;
  seat: number;
  zone: ZoneRef;
  teamId?: number;
  designs: StoredDesign[];
  placements: PlacementDTO[];
}

/** Create real ivm runners and run one battle; returns the result and timings. */
async function realBattle(specs: PlayerSpec[], config: GameConfig, seed: number, map?: Pick<MapLayout, 'style' | 'width'>) {
  const runners = await createBattleRunners(
    ivm,
    specs.map((s) => ({ playerId: s.playerId, seat: s.seat, units: s.designs.map((d) => d.runner) })),
    config,
    seed,
  );
  for (const r of runners.values()) expect([...r.loadErrors]).toEqual([]);

  const players: BattlePlayerSetup[] = specs.map((s) => ({
    playerId: s.playerId,
    seat: s.seat,
    zone: s.zone,
    ...(s.teamId !== undefined ? { teamId: s.teamId } : {}),
    units: s.designs.map((d) => d.battle),
    placements: s.placements,
    runner: runners.get(s.playerId)!,
  }));

  // Per-tick wall time of the whole sim step: from the first runner call of
  // tick k to the first runner call of tick k+1 (or the end of the battle).
  const tickMs: number[] = [];
  let tickStart = 0;
  let pendingTick = -1;
  for (const p of players) {
    const r = p.runner;
    const orig = r.tick.bind(r);
    r.tick = async (input) => {
      if (input.tick !== pendingTick) {
        if (pendingTick >= 0) tickMs.push(performance.now() - tickStart);
        pendingTick = input.tick;
        tickStart = performance.now();
      }
      return orig(input);
    };
  }

  const engine = new BattleEngine({ players, config, seed, ...(map ? { map } : {}) });
  const t0 = performance.now();
  const result = await engine.run();
  const wallMs = performance.now() - t0;
  if (pendingTick >= 0) tickMs.push(performance.now() - tickStart);
  for (const r of runners.values()) expect(r.disposed).toBe(true);
  return { result, frames: engine.frames, wallMs, tickMs };
}

function percentile(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
}

/**
 * No unit misbehaved: templates must never throw or get disabled. With
 * `maxTimeouts`, up to that many hard timeouts (a host GC/scheduler stall
 * under load) are tolerated across the battle; each must be the forgiven
 * first one ("…took too long once", §8), so nothing gets disabled. The
 * players tick in lockstep, so ONE host stall can time out every player that
 * was ticking at that moment: one stall's worth is one timeout per player.
 * (Stalls the sandbox detects itself are `hostStall` ticks and not counted.)
 */
function expectCleanRun(result: BattleResult, { maxTimeouts = 0 } = {}): void {
  const timeouts = result.players.reduce((n, p) => n + p.timeouts, 0);
  expect(timeouts).toBeLessThanOrEqual(maxTimeouts);
  for (const p of result.players) {
    expect(p.disabled, `${p.playerId} disabled: ${p.disabledReason}`).toBe(false);
    expect(p.playerStrikes).toBe(0);
  }
  const stalls = result.units.flatMap((u) => u.errors).filter((e) => / took too long once/.test(e.message));
  expect(stalls.length).toBeLessThanOrEqual(timeouts);
  for (const u of result.units) {
    expect(u.errors.filter((e) => !/ took too long once/.test(e.message)), `${u.instanceId} errors`).toEqual([]);
    expect(u.disabled, `${u.instanceId} disabled: ${u.disabledReason}`).toBe(false);
  }
}

const at = (col: number, row: number, unitId: string): PlacementDTO => ({ unitId, col, row });

describe('integration: validator → ivm runner → engine (M2 acceptance)', () => {
  let soldier: StoredDesign;
  let tower: StoredDesign;

  beforeAll(async () => {
    [soldier, tower] = await Promise.all([
      submit(template('basic_soldier.js'), DEFAULT_CONFIG),
      submit(template('basic_tower.js'), DEFAULT_CONFIG),
    ]);
  });

  it('validates both templates into snapshots the engine accepts', () => {
    expect(soldier.battle).toMatchObject({ unitId: 'basic-soldier', cost: 92 });
    expect(tower.battle).toMatchObject({ unitId: 'basic-tower', cost: 198 });
    expect(soldier.battle.stats).toMatchObject({ type: 'soldier', maxHealth: 120, damage: 10, range: 40, speed: 1.5, attackCooldown: 60 });
    expect(tower.battle.stats).toMatchObject({ type: 'tower', maxHealth: 150, damage: 15, range: 180, speed: 0, attackCooldown: 45 });
  });

  // 4 soldiers in the front cells, 3 towers just behind: $962 per side.
  const S = () => soldier.battle.unitId;
  const T = () => tower.battle.unitId;
  const army = (): PlacementDTO[] => [
    at(0, 0, S()), at(1, 0, S()), at(0, 1, S()), at(1, 1, S()),
    at(2, 0, T()), at(0, 2, T()), at(2, 2, T()),
  ];

  it('template vs template (4 soldiers + 3 towers each) runs 5400 ticks in < 2 s and produces a ranking', async () => {
    const config = DEFAULT_CONFIG;
    const zones = assignZones(['a', 'b'], 0);
    const specs: PlayerSpec[] = ['a', 'b'].map((id, seat) => ({
      playerId: id,
      seat,
      zone: zones.get(id)!,
      designs: [soldier, tower],
      placements: army(),
    }));
    expect(specs.map((s) => s.zone)).toEqual(['TL', 'BR']);
    // Geometry: every instance sits in its own zone.
    for (const s of specs) {
      const inst = buildInstances({ seat: s.seat, zone: s.zone, units: s.designs.map((d) => d.battle), placements: s.placements });
      expect(inst).toHaveLength(7);
      expect(inst[0]).toMatchObject({ instanceId: `${s.seat}-0-0`, ...cellCenter(s.zone, 0, 0) });
    }

    const { result, frames, wallMs, tickMs } = await realBattle(specs, config, 1234);
    console.log(
      `[integration] 2p template battle: ${result.endTick} ticks (${result.endReason}) in ${wallMs.toFixed(0)} ms; ` +
        `tick p50 ${percentile(tickMs, 50).toFixed(3)} ms, p99 ${percentile(tickMs, 99).toFixed(3)} ms; ` +
        `ranking ${JSON.stringify(result.ranking.map((r) => [r.playerId, r.place]))}`,
    );

    expectCleanRun(result);
    // The mirrored armies fight in the middle and the towers outlast the
    // shrinking circle, so the battle runs the full 90 s (§9 sudden death).
    expect(result.endTick).toBe(config.timers.battleTicks);
    expect(result.endReason).toBe('timeout');
    expect(wallMs).toBeLessThan(2000);
    // Combat really happened through the sandbox.
    // (The towers sit too far back to reach the melee in the middle.)
    expect(result.units.some((u) => u.damageDealt > 0 && u.unitId === S())).toBe(true);
    expect(result.units.some((u) => u.kills > 0)).toBe(true);
    // A ranking for both players with valid places and points.
    expect(result.ranking.map((r) => r.playerId).sort()).toEqual(['a', 'b']);
    for (const r of result.ranking) expect([1, 2]).toContain(r.place);
    expect(frames[0]!.t).toBe(0);
    expect(frames[frames.length - 1]!.t).toBe(result.endTick);
    expect(frames.length).toBe(config.timers.battleTicks / config.sim.frameEveryTicks + 1);

    // Parity: the fake runner's template brains (used by sim.test.ts) mirror
    // the real templates, so the same battle must be bit-identical. This
    // pins the runner ⇄ engine contract (views, ally filtering, action shape).
    const fake = fakePlayers(
      specs.map((s) => ({
        playerId: s.playerId,
        seat: s.seat,
        zone: s.zone,
        units: s.designs.map((d) => d.battle),
        placements: s.placements,
        brains: { [S()]: soldierBrain, [T()]: towerBrain },
      })),
      1234,
    );
    const fakeRun = await runBattle({ players: fake.setups, config, seed: 1234 });
    expect(fakeRun.frames).toEqual(frames);
    expect(fakeRun.ranking).toEqual(result.ranking);
  }, 30_000);

  it('a stronger army wins outright (elimination) with a single winner', async () => {
    const config = DEFAULT_CONFIG;
    const specs: PlayerSpec[] = [
      { playerId: 'strong', seat: 0, zone: 'TL', designs: [soldier, tower], placements: army() },
      // Two soldiers, no towers.
      { playerId: 'weak', seat: 1, zone: 'BR', designs: [soldier], placements: [at(0, 0, S()), at(1, 0, S())] },
    ];
    const { result, wallMs } = await realBattle(specs, config, 99);
    console.log(`[integration] 2p uneven battle: ${result.endTick} ticks (${result.endReason}) in ${wallMs.toFixed(0)} ms`);
    expectCleanRun(result);
    expect(result.endReason).toBe('elimination');
    expect(result.ranking).toEqual([
      // 2 players: place points 1/0 (§9 Points: 1st gets P − 1).
      expect.objectContaining({ playerId: 'strong', place: 1, placePoints: 1 }),
      expect.objectContaining({ playerId: 'weak', place: 2, placePoints: 0 }),
    ]);
  }, 30_000);

  it('4 players × 8 units: logs sim ms/tick (p50/p99)', async () => {
    // §14 load test shape: 8 units each, update() loops over all enemies.
    const config: GameConfig = parseConfig({});
    const zones = assignZones(['p0', 'p1', 'p2', 'p3'], 0);
    const eight = (): PlacementDTO[] => [
      at(0, 0, S()), at(1, 0, S()), at(0, 1, S()), at(1, 1, S()), at(2, 0, S()),
      at(2, 1, T()), at(1, 2, T()), at(0, 2, T()),
    ];
    // 5 soldiers ($500) + 3 towers ($537) is over $1000; fine here, the
    // engine does not enforce the budget (the round service does).
    const specs: PlayerSpec[] = ['p0', 'p1', 'p2', 'p3'].map((id, seat) => ({
      playerId: id,
      seat,
      zone: zones.get(id)!,
      designs: [soldier, tower],
      placements: eight(),
    }));
    const { result, wallMs, tickMs } = await realBattle(specs, config, 4242);
    const p50 = percentile(tickMs, 50);
    const p99 = percentile(tickMs, 99);
    console.log(
      `[integration] 4p×8 battle: ${result.endTick} ticks (${result.endReason}) in ${wallMs.toFixed(0)} ms ` +
        `(${(wallMs / Math.max(1, result.endTick)).toFixed(3)} ms/tick avg); tick p50 ${p50.toFixed(3)} ms, p99 ${p99.toFixed(3)} ms, ` +
        `max ${Math.max(...tickMs).toFixed(2)} ms`,
    );
    // One stall (GC/scheduler) may cross the 12 ms hard timeout under load;
    // §8 forgives a culprit's first timeout, so it must not disable anything.
    expectCleanRun(result, { maxTimeouts: specs.length });
    expect(result.ranking).toHaveLength(4);
    expect(tickMs.length).toBe(result.endTick);
    // §14 load-test budget: sim p99 < 8 ms/tick.
    expect(p99).toBeLessThan(8);
  }, 60_000);

  // §9.2 Performance / §14 loadtest: 8 players × 12 copies = 96 units on the
  // 1200 arena, every update() looping over all enemies; once free-for-all on
  // Ring 8 and once as 4v4 on Lanes 8 (allies/enemies serialised once per side).
  const twelve = (): PlacementDTO[] => [
    ...[0, 1, 2, 3, 4, 5].map((c) => at(c, 0, S())),
    at(0, 1, S()), at(1, 1, S()),
    at(2, 1, T()), at(3, 1, T()), at(0, 2, T()), at(1, 2, T()),
  ];
  const ids8 = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
  const loadSpecs = (style: MapStyle, mode: TeamMode): { specs: PlayerSpec[]; layout: MapLayout } => {
    const layout = mapFor(style, 8);
    const teams = autoBalance(ids8, mode);
    const zones = teams ? assignTeamZones(layout, teams, 1) : assignMapZones(layout, ids8, 1);
    const teamOf = new Map(teams?.flatMap((t) => t.members.map((m) => [m, t.teamId] as const)) ?? []);
    const specs = ids8.map((id, seat) => ({
      playerId: id,
      seat,
      zone: zones.get(id)!,
      ...(teamOf.has(id) ? { teamId: teamOf.get(id)! } : {}),
      designs: [soldier, tower],
      placements: twelve(),
    }));
    return { specs, layout };
  };

  for (const [style, mode, label] of [
    ['ring', 'ffa', '8p×12 Ring 8 free-for-all'],
    ['lanes', 'teams2', '8p×12 Lanes 8 4v4'],
  ] as const) {
    it(`${label}: sim p99 < 8 ms/tick (96 units, 1200 arena)`, async () => {
      const config: GameConfig = parseConfig({});
      const { specs, layout } = loadSpecs(style, mode);
      expect(layout.width).toBe(1200);
      const { result, wallMs, tickMs } = await realBattle(specs, config, 8812, { style, width: layout.width });
      const p50 = percentile(tickMs, 50);
      const p99 = percentile(tickMs, 99);
      console.log(
        `[integration] ${label}: ${result.units.length} units, ${result.endTick} ticks (${result.endReason}) in ${wallMs.toFixed(0)} ms ` +
          `(${(wallMs / Math.max(1, result.endTick)).toFixed(3)} ms/tick avg); tick p50 ${p50.toFixed(3)} ms, p99 ${p99.toFixed(3)} ms, ` +
          `max ${Math.max(...tickMs).toFixed(2)} ms`,
      );
      expect(result.units).toHaveLength(96);
      expectCleanRun(result, { maxTimeouts: specs.length });
      if (mode === 'ffa') expect(result.teams).toBeUndefined();
      else expect(result.teams?.map((t) => t.members.length)).toEqual([4, 4]);
      expect(result.ranking).toHaveLength(8);
      expect(tickMs.length).toBe(result.endTick);
      // §9.2 Performance: sim p99 < 8 ms/tick with 8 players × 12 copies.
      expect(p99).toBeLessThan(8);
    }, 120_000);
  }
});
