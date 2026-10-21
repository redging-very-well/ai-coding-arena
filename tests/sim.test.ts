// Headless simulation tests (plan §14 sim.test.ts), run against the fake
// runner. The real-isolate "< 2 s per battle" target is checked later in
// integration with ivmRunner.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  FRAME_FLAGS,
  assignZones,
  cellCenter,
  mapFor,
  parseConfig,
  zoneCenterOf,
  safeZoneRadius,
  type GameConfig,
  type PlacementDTO,
} from '@pixel-clash/shared';
import {
  BattleEngine,
  buildBattleReport,
  buildInstances,
  createBattleRunners,
  resultAtTick,
  runBattle,
  type BattleResult,
  type SimUnit,
} from '../packages/server/src/sim/engine.js';
import { resolveAction } from '../packages/server/src/sim/actions.js';
import { autoPlace, frontCells } from '../packages/server/src/sim/autoPlace.js';
import { frameAt } from '../packages/server/src/sim/frames.js';
import { mulberry32 } from '../packages/server/src/sim/prng.js';
import { advanceProjectiles, applyHit, moveProjectiles, resolveHits } from '../packages/server/src/sim/projectiles.js';
import { rankAtPlaybackTick, rankFromFrame, rankResult, rankStandings } from '../packages/server/src/sim/ranking.js';
import { computeRoundScore, playerMetrics, scoreRanking } from '../packages/server/src/sim/scoring.js';
import {
  FakeRunnerFactory,
  SOLDIER,
  TOWER,
  design,
  fakePlayers,
  idleBrain,
  scripted,
  soldierBrain,
  stats,
  towerBrain,
  type FakePlayerSpec,
} from './helpers/fakeRunner.js';
import type { TickResult } from '../packages/server/src/sandbox/runner.js';

/** Config with a shorter battle and (by default) no sudden death. */
function cfg(patch: Record<string, unknown> = {}, battleTicks = 600, suddenDeath = false): GameConfig {
  return parseConfig({
    timers: { battleTicks },
    ...(suddenDeath ? {} : { suddenDeath: { startTick: 100_000, endTick: 100_001 } }),
    ...patch,
  });
}

const at = (col: number, row: number, unitId: string): PlacementDTO => ({ unitId, col, row });

async function battle(specs: FakePlayerSpec[], config: GameConfig, seed = 7, kicked?: Set<string>) {
  const { setups, runners } = fakePlayers(specs, seed);
  const result = await runBattle({ players: setups, config, seed, ...(kicked ? { kickedPlayerIds: kicked } : {}) });
  return { result, runners };
}

const unit = (r: BattleResult, id: string) => r.units.find((u) => u.instanceId === id)!;
const frameUnit = (frames: { units: [string, number, number, number, number][] }, id: string) => frames.units.find((u) => u[0] === id);

const ARMY_7: PlacementDTO[] = [
  at(0, 0, 'soldier'), at(1, 0, 'soldier'), at(0, 1, 'soldier'), at(1, 1, 'soldier'),
  at(2, 0, 'tower'), at(0, 2, 'tower'), at(2, 2, 'tower'),
];
const TEMPLATE_UNITS = [design('soldier', SOLDIER), design('tower', TOWER)];
const TEMPLATE_BRAINS = { soldier: soldierBrain, tower: towerBrain };

describe('battles', () => {
  it('two template armies face off and a winner is produced (fast with the fake runner)', async () => {
    const started = performance.now();
    const { result } = await battle(
      [
        { playerId: 'a', seat: 0, zone: 'TL', units: TEMPLATE_UNITS, placements: ARMY_7, brains: TEMPLATE_BRAINS },
        // b: the same 4 soldiers, but only its back-corner tower, which sudden death reaches first.
        { playerId: 'b', seat: 1, zone: 'BR', units: TEMPLATE_UNITS, placements: [...ARMY_7.slice(0, 4), at(2, 2, 'tower')], brains: TEMPLATE_BRAINS },
      ],
      DEFAULT_CONFIG,
    );
    const ms = performance.now() - started;
    expect(result.ranking).toHaveLength(2);
    expect(result.ranking[0]!.place).toBe(1);
    expect(result.ranking[1]!.place).toBe(2);
    // 2 players: place points 1/0 (§9 Points: 1st gets P − 1).
    expect(result.ranking[0]!.placePoints).toBe(1);
    expect(result.ranking[1]!.placePoints).toBe(0);
    expect(result.ranking[0]!.badges).toContain('lastStanding');
    expect(result.units.some((u) => u.kills > 0)).toBe(true);
    expect(ms).toBeLessThan(2000);
  });

  it('two identical mirrored units die on the same tick and share 1st place', async () => {
    const units = [design('s', SOLDIER)];
    const { result } = await battle(
      [
        { playerId: 'a', seat: 0, zone: 'TL', units, placements: [at(0, 0, 's')], brains: { s: soldierBrain } },
        { playerId: 'b', seat: 1, zone: 'BR', units, placements: [at(0, 0, 's')], brains: { s: soldierBrain } },
      ],
      cfg({}, 5400),
    );
    expect(result.endReason).toBe('elimination');
    const [a, b] = result.players;
    expect(a!.eliminatedAtTick).not.toBeNull();
    expect(a!.eliminatedAtTick).toBe(b!.eliminatedAtTick);
    expect(unit(result, '0-0-0').diedAtTick).toBe(unit(result, '1-0-0').diedAtTick);
    // Equal everything (2 players): 1 place + 1 damage (2 × 2/4) + 1 value (round(1 × 2/4)) each, and every badge but Iron Wall shared.
    expect(result.ranking.map((r) => [r.place, r.placePoints, r.damageBonus, r.valueBonus, r.pointsGained])).toEqual([[1, 1, 1, 1, 3], [1, 1, 1, 1, 3]]);
    expect(result.ranking[0]!.badges).toEqual(['lastStanding', 'biggestHitter', 'giantSlayer']);
  });

  it('first-strike timing: fires the first tick it is in range, then every attackCooldown ticks', async () => {
    const wall = stats({ type: 'tower', name: 'Wall', maxHealth: 500, damage: 0 });
    const { setups, runners } = fakePlayers([
      { playerId: 'a', seat: 0, zone: 'TL', units: [design('s', SOLDIER)], placements: [at(0, 0, 's')], brains: { s: soldierBrain } },
      { playerId: 'b', seat: 1, zone: 'BR', units: [design('w', wall)], placements: [at(0, 0, 'w')], brains: { w: idleBrain } },
    ]);
    const ra = runners.get('a')!;
    ra.recordInputs = true;
    await runBattle({ players: setups, config: cfg({}, 600), seed: 1 });

    const ins = ra.inputs;
    // The first tick where the soldier (cooldown 0) sees the wall in range.
    const k = ins.findIndex((i) => {
      const s = i.selves[0]!;
      const e = i.enemies[0]!;
      return Math.hypot(e.x - s.x, e.y - s.y) - s.radius - e.radius <= s.range;
    });
    expect(k).toBeGreaterThan(0);
    expect(ins[k]!.selves[0]!.cooldownRemaining).toBe(0);
    const enemyHp = (t: number) => ins[t]!.enemies[0]!.hp;
    expect(enemyHp(k)).toBe(500);
    // Melee hits instantly on tick k; cooldown set to 60, already 59 at the next tick start.
    expect(enemyHp(k + 1)).toBe(490);
    expect(ins[k + 1]!.selves[0]!.cooldownRemaining).toBe(59);
    expect(ins[k + 60]!.selves[0]!.cooldownRemaining).toBe(0);
    expect(enemyHp(k + 60)).toBe(490);
    expect(enemyHp(k + 61)).toBe(480);
    expect(enemyHp(k + 121)).toBe(470);
  });

  it('a range-20 soldier damages a tower (edge-to-edge range, bodies never touch)', async () => {
    const shorty = stats({ type: 'soldier', name: 'Shorty', range: 20 });
    const wall = stats({ type: 'tower', name: 'Wall', maxHealth: 500, damage: 0 });
    const { result } = await battle(
      [
        { playerId: 'a', seat: 0, zone: 'TL', units: [design('s', shorty)], placements: [at(0, 0, 's')], brains: { s: soldierBrain } },
        { playerId: 'b', seat: 1, zone: 'BR', units: [design('w', wall)], placements: [at(0, 0, 'w')], brains: { w: idleBrain } },
      ],
      cfg({}, 900),
    );
    expect(unit(result, '0-0-0').damageDealt).toBeGreaterThan(0);
    expect(unit(result, '1-0-0').hp).toBeLessThan(500);
  });

  it('timeout: survivors are ranked by the full cost of their living units', async () => {
    const t = design('t', TOWER); // $198
    const s = design('s', SOLDIER); // $92
    const { result } = await battle(
      [
        { playerId: 'a', seat: 0, zone: 'TL', units: [s], placements: [at(0, 0, 's'), at(1, 0, 's'), at(2, 0, 's')], brains: { s: idleBrain } },
        { playerId: 'b', seat: 1, zone: 'TR', units: [t], placements: [at(0, 0, 't'), at(1, 0, 't')], brains: { t: idleBrain } },
        { playerId: 'c', seat: 2, zone: 'BR', units: [t], placements: [at(0, 0, 't')], brains: { t: idleBrain } },
      ],
      cfg({}, 120),
    );
    expect(result.endReason).toBe('timeout');
    expect(result.endTick).toBe(120);
    expect(result.ranking.map((r) => [r.playerId, r.place, r.pointsGained, r.livingCost])).toEqual([
      ['b', 1, 2, 396], // 3 players: place points 2/1/0
      ['a', 2, 1, 276],
      ['c', 3, 0, 198],
    ]);
  });

  it('out-of-range attack → idle (no damage, cooldown untouched)', async () => {
    const attackAll = scripted((_self, enemies) => ({ action: 'attack', targetId: enemies[0]?.id }));
    const { setups, runners } = fakePlayers([
      { playerId: 'a', seat: 0, zone: 'TL', units: [design('s', SOLDIER)], placements: [at(0, 0, 's')], brains: { s: attackAll } },
      { playerId: 'b', seat: 1, zone: 'BR', units: [design('t', TOWER)], placements: [at(5, 5, 't')], brains: { t: idleBrain } },
    ]);
    runners.get('a')!.recordInputs = true;
    const result = await runBattle({ players: setups, config: cfg({}, 60), seed: 1 });
    expect(unit(result, '1-5-5').hp).toBe(150);
    expect(unit(result, '0-0-0').damageDealt).toBe(0);
    expect(runners.get('a')!.inputs.every((i) => i.selves[0]!.cooldownRemaining === 0)).toBe(true);
    expect(result.frames.flatMap((f) => f.events).some((e) => e.type === 'fire')).toBe(false);
  });

  it('a teleport move is clamped to speed per tick and to the arena', async () => {
    const fast = stats({ type: 'soldier', speed: 2 });
    const teleport = scripted(() => ({ action: 'move', destination: { x: -5000, y: 99999 } }));
    const { result } = await battle(
      [
        { playerId: 'a', seat: 0, zone: 'TL', units: [design('s', fast)], placements: [at(0, 0, 's')], brains: { s: teleport } },
        { playerId: 'b', seat: 1, zone: 'BR', units: [design('t', TOWER)], placements: [at(5, 5, 't')], brains: { t: idleBrain } },
      ],
      cfg({}, 1000),
    );
    const start = cellCenter('TL', 0, 0);
    const f2 = frameUnit(frameAt(result.frames, 2)!, '0-0-0')!;
    expect(Math.hypot(f2[1] - start.x, f2[2] - start.y)).toBeCloseTo(4, 1); // 2 ticks × speed 2
    expect(f2[4] & FRAME_FLAGS.MOVING).toBeTruthy();
    // Destination clamped to (0, 800); the body stays fully inside the arena.
    const last = frameUnit(result.frames.at(-1)!, '0-0-0')!;
    expect(last[1]).toBeCloseTo(10, 5);
    expect(last[2]).toBeCloseTo(790, 5);
  });

  it('no friendly fire: attacking an ally idles', async () => {
    const hitAlly = scripted((_self, _enemies, allies) => ({ action: 'attack', targetId: allies[0]?.id }));
    const { result } = await battle(
      [
        { playerId: 'a', seat: 0, zone: 'TL', units: [design('s', SOLDIER)], placements: [at(0, 0, 's'), at(1, 0, 's')], brains: { s: hitAlly } },
        { playerId: 'b', seat: 1, zone: 'BR', units: [design('t', TOWER)], placements: [at(5, 5, 't')], brains: { t: idleBrain } },
      ],
      cfg({}, 120),
    );
    expect(unit(result, '0-0-0').hp).toBe(120);
    expect(unit(result, '0-0-1').hp).toBe(120);
    expect(result.units.every((u) => u.damageDealt === 0)).toBe(true);
  });

  it('a tower move is ignored', async () => {
    const walk = scripted(() => ({ action: 'move', destination: { x: 400, y: 400 } }));
    const { result } = await battle(
      [
        { playerId: 'a', seat: 0, zone: 'TL', units: [design('t', TOWER)], placements: [at(0, 0, 't')], brains: { t: walk } },
        { playerId: 'b', seat: 1, zone: 'BR', units: [design('t', TOWER)], placements: [at(0, 0, 't')], brains: { t: idleBrain } },
      ],
      cfg({}, 60),
    );
    const start = cellCenter('TL', 0, 0);
    for (const f of result.frames) {
      const u = frameUnit(f, '0-0-0')!;
      expect([u[1], u[2]]).toEqual([start.x, start.y]);
    }
  });

  it('sudden death damages units outside the safe circle only', async () => {
    const config = cfg(
      { suddenDeath: { startTick: 0, endTick: 100, startRadius: 570, endRadius: 60, damagePctPerSecond: 4 } },
      120,
      true,
    );
    const dash = stats({ type: 'soldier', name: 'Dash', speed: 5 });
    const toCenter = scripted(() => ({ action: 'move', destination: { x: 400, y: 400 } }));
    const { result } = await battle(
      [
        { playerId: 'a', seat: 0, zone: 'TL', units: [design('t', TOWER)], placements: [at(0, 0, 't')], brains: { t: idleBrain } },
        { playerId: 'b', seat: 1, zone: 'BR', units: [design('d', dash)], placements: [at(0, 0, 'd')], brains: { d: toCenter } },
      ],
      config,
    );
    // The tower sits still at its cell centre: count the ticks it was outside.
    const p = cellCenter('TL', 0, 0);
    const d = Math.hypot(p.x - 400, p.y - 400);
    let outside = 0;
    for (let k = 0; k < 120; k++) if (d > safeZoneRadius(k, config.suddenDeath)) outside++;
    expect(outside).toBeGreaterThan(0);
    expect(unit(result, '0-0-0').hp).toBeCloseTo(150 - (outside * 150 * 0.04) / 60, 9);
    expect(unit(result, '1-0-0').hp).toBe(120); // walked into the middle in time
    const last = result.frames.at(-1)!;
    expect(frameUnit(last, '0-0-0')![4] & FRAME_FLAGS.OUTSIDE_SAFE_ZONE).toBeTruthy();
    expect(last.safeZoneRadius).toBe(60);
  });

  it('shuffled placement order + the same seed + fake runner gives identical frames', async () => {
    const corners = ['TL', 'TR', 'BR', 'BL'] as const;
    const run = async (shuffleSeed: number) => {
      const rng = mulberry32(shuffleSeed);
      const shuffle = <T>(xs: T[]) => {
        const a = [...xs];
        for (let i = a.length - 1; i > 0; i--) {
          const j = Math.floor(rng() * (i + 1));
          [a[i], a[j]] = [a[j]!, a[i]!];
        }
        return a;
      };
      const specs = corners.map((zone, seat) => ({
        playerId: `p${seat}`,
        seat,
        zone,
        units: TEMPLATE_UNITS,
        placements: shuffle(ARMY_7),
        brains: TEMPLATE_BRAINS,
      }));
      return battle(shuffle(specs), DEFAULT_CONFIG, 42);
    };
    const a = await run(1);
    const b = await run(2);
    expect(JSON.stringify(b.result.frames)).toBe(JSON.stringify(a.result.frames));
    expect(b.result.ranking).toEqual(a.result.ranking);
    expect(a.result.frames[0]!.t).toBe(0);
    expect(a.result.frames[1]!.t).toBe(2);
    expect(a.result.frames.at(-1)!.t).toBe(a.result.endTick);
  }, 20_000); // two full 4-player battles: CPU-bound, slow when test files run in parallel
});

describe('ranking and points', () => {
  const S = DEFAULT_CONFIG.scoring;
  /** Place points only (no metrics): the §9 formula, 1st gets P − 1 down to 0. */
  const placePoints = (placings: ReturnType<typeof rankStandings>) =>
    computeRoundScore(placings, [], S).map((s) => ({ ...placings.find((p) => p.playerId === s.playerId)!, pointsGained: s.total }));

  it('2 players: winner 1, loser 0', () => {
    const r = placePoints(
      rankStandings(
        [
          { playerId: 'a', seat: 0, livingCost: 0, eliminatedAtTick: 900 },
          { playerId: 'b', seat: 1, livingCost: 200, eliminatedAtTick: null },
        ],
      ),
    );
    expect(r.map((e) => [e.playerId, e.place, e.pointsGained])).toEqual([['b', 1, 1], ['a', 2, 0]]);
  });

  it('3 players with a tie for 2nd: 2, 1, 1', () => {
    const r = placePoints(
      rankStandings(
        [
          { playerId: 'a', seat: 0, livingCost: 300, eliminatedAtTick: null },
          { playerId: 'b', seat: 1, livingCost: 300, eliminatedAtTick: null },
          { playerId: 'c', seat: 2, livingCost: 500, eliminatedAtTick: null },
        ],
      ),
    );
    expect(r.map((e) => [e.playerId, e.place, e.pointsGained])).toEqual([['c', 1, 2], ['a', 2, 1], ['b', 2, 1]]);
  });

  it('4 players: tie for 1st skips 2nd; eliminated ranked by elimination tick', () => {
    const r = placePoints(
      rankStandings(
        [
          { playerId: 'a', seat: 0, livingCost: 0, eliminatedAtTick: 50 },
          { playerId: 'b', seat: 1, livingCost: 400, eliminatedAtTick: null },
          { playerId: 'c', seat: 2, livingCost: 0, eliminatedAtTick: 100 },
          { playerId: 'd', seat: 3, livingCost: 400, eliminatedAtTick: null },
        ],
      ),
    );
    expect(r.map((e) => [e.playerId, e.place, e.pointsGained])).toEqual([
      ['b', 1, 3],
      ['d', 1, 3],
      ['c', 3, 1],
      ['a', 4, 0],
    ]);
  });

  it('4 players: same elimination tick shares a place', () => {
    const r = placePoints(
      rankStandings(
        [
          { playerId: 'a', seat: 0, livingCost: 100, eliminatedAtTick: null },
          { playerId: 'b', seat: 1, livingCost: 0, eliminatedAtTick: 70 },
          { playerId: 'c', seat: 2, livingCost: 0, eliminatedAtTick: 70 },
          { playerId: 'd', seat: 3, livingCost: 0, eliminatedAtTick: 20 },
        ],
      ),
    );
    expect(r.map((e) => [e.place, e.pointsGained])).toEqual([[1, 3], [2, 2], [2, 2], [4, 0]]);
  });

  it('everyone eliminated on the same tick: all share 1st', () => {
    const r = placePoints(
      rankStandings(
        ['a', 'b', 'c'].map((playerId, seat) => ({ playerId, seat, livingCost: 0, eliminatedAtTick: 300 })),
      ),
    );
    expect(r.every((e) => e.place === 1 && e.pointsGained === 2)).toBe(true); // 3 players: 1st = 2
  });

  it('a player kicked mid-battle is excluded from ranking and points', async () => {
    const t = design('t', TOWER);
    const s = design('s', SOLDIER);
    const specs: FakePlayerSpec[] = [
      { playerId: 'player', seat: 0, zone: 'TL', units: [t], placements: [at(0, 0, 't'), at(1, 0, 't'), at(0, 1, 't')], brains: { t: idleBrain } },
      { playerId: 'b', seat: 1, zone: 'TR', units: [s], placements: [at(0, 0, 's')], brains: { s: idleBrain } },
      { playerId: 'c', seat: 2, zone: 'BR', units: [t], placements: [at(0, 0, 't')], brains: { t: idleBrain } },
    ];
    const { result } = await battle(specs, cfg({}, 60), 3, new Set(['player']));
    // 2 ranked players (the kicked one doesn't count): 1 / 0.
    expect(result.ranking.map((r) => [r.playerId, r.place, r.pointsGained])).toEqual([['c', 1, 1], ['b', 2, 0]]);
    // The kick can also land after the sim finished: re-rank the same result.
    const plain = rankResult(result);
    expect(plain[0]!.playerId).toBe('player');
    expect(scoreRanking(rankResult(result, new Set(['player'])), playerMetrics(result), S)).toEqual(result.ranking);
    // The kicked player's units still fought (they are in the frames and the report).
    expect(result.units.filter((u) => u.playerId === 'player')).toHaveLength(3);
  });
});

describe('zones, auto-place and skip', () => {
  it('zone rotation over 3 rounds gives each of 3 players the middle seat (TR) once', () => {
    const ids = ['ann', 'bob', 'cat'];
    const middle = [1, 2, 3].map((round) => [...assignZones(ids, round)].find(([, z]) => z === 'TR')![0]);
    expect(new Set(middle)).toEqual(new Set(ids));
  });

  it('auto-place for an empty player: greedy cheapest-first round-robin into the front cells', () => {
    const r = autoPlace({
      available: [{ unitId: 'tower', cost: 179 }, { unitId: 'soldier', cost: 100 }],
      caps: { budget: 1000, maxCopies: 12, maxTypes: 3 },
    });
    expect(r.source).toBe('greedy');
    expect(r.placements.map((p) => p.unitId)).toEqual(['soldier', 'tower', 'soldier', 'tower', 'soldier', 'tower', 'soldier']);
    expect(r.spent).toBe(937);
    expect(r.placements[0]).toMatchObject({ col: 0, row: 0 });
    const front = frontCells().slice(0, 7);
    expect(r.placements.map((p) => [p.col, p.row])).toEqual(front.map((c) => [c.col, c.row]));
  });

  it('auto-place copies the last layout when still valid, else falls back to greedy', () => {
    const caps = { budget: 1000, maxCopies: 12, maxTypes: 3 };
    const available = [{ unitId: 's', cost: 100 }, { unitId: 't', cost: 179 }];
    const last = [at(3, 3, 't'), at(2, 2, 's')];
    expect(autoPlace({ available, lastLayout: last, caps })).toMatchObject({ source: 'last-layout', spent: 279, placements: last });
    // References a unit that is no longer available → greedy.
    expect(autoPlace({ available, lastLayout: [at(0, 0, 'gone')], caps }).source).toBe('greedy');
    // Over budget after a re-price → greedy.
    expect(autoPlace({ available: [{ unitId: 's', cost: 600 }], lastLayout: [at(2, 2, 's'), at(3, 3, 's')], caps }).source).toBe('greedy');
    // Nothing affordable → empty.
    expect(autoPlace({ available: [{ unitId: 'x', cost: 2000 }], caps }).source).toBe('empty');
  });

  it('a force-started battle with an auto-placed player runs', async () => {
    const auto = autoPlace({ available: [{ unitId: 'soldier', cost: 100 }, { unitId: 'tower', cost: 179 }], caps: { budget: 1000, maxCopies: 12, maxTypes: 3 } });
    const factory = new FakeRunnerFactory(TEMPLATE_BRAINS);
    const config = cfg({}, 300);
    const runners = await createBattleRunners(
      factory,
      [
        { playerId: 'a', seat: 0, units: [] },
        { playerId: 'b', seat: 1, units: [] },
      ],
      config,
      5,
    );
    const result = await runBattle({
      players: [
        { playerId: 'a', seat: 0, zone: 'TL', units: TEMPLATE_UNITS, placements: ARMY_7, runner: runners.get('a')! },
        { playerId: 'b', seat: 1, zone: 'BR', units: TEMPLATE_UNITS, placements: auto.placements, runner: runners.get('b')! },
      ],
      config,
      seed: 5,
    });
    expect(result.units.filter((u) => u.playerId === 'b')).toHaveLength(7);
    expect(result.frames[0]!.units).toHaveLength(14);
    expect([...runners.values()].every((r) => r.disposed)).toBe(true);
  });

  it('skip ranks from the frame at the playback tick, not the sim lead', async () => {
    const reaper = stats({ type: 'soldier', name: 'Reaper', maxHealth: 500, damage: 60, speed: 5, attackCooldown: 10 });
    const { result } = await battle(
      [
        { playerId: 'a', seat: 0, zone: 'TL', units: [design('s', SOLDIER)], placements: [at(0, 0, 's'), at(1, 0, 's'), at(0, 1, 's')], brains: { s: idleBrain } },
        { playerId: 'b', seat: 1, zone: 'BR', units: [design('r', reaper, 250)], placements: [at(0, 0, 'r')], brains: { r: soldierBrain } },
      ],
      cfg({}, 5400),
    );
    // At the end the reaper has won.
    expect(result.endReason).toBe('elimination');
    expect(result.ranking[0]!.playerId).toBe('b');
    // Early on, a still has $276 on the field vs b's $250: a leads.
    const early = rankAtPlaybackTick(result.frames, 11, result);
    expect(early.map((r) => [r.playerId, r.place, r.livingCost])).toEqual([['a', 1, 276], ['b', 2, 250]]);
    // After the first kill a is down to $184: b leads.
    const firstDeath = result.units.filter((u) => u.playerId === 'a').map((u) => u.diedAtTick!).sort((x, y) => x - y)[0]!;
    const mid = rankFromFrame(frameAt(result.frames, firstDeath + 2)!, result);
    expect(mid.map((r) => [r.playerId, r.livingCost])).toEqual([['b', 250], ['a', 184]]);
  });

  it('stop() ends the sim early on a frame of the final state', async () => {
    const { setups } = fakePlayers([
      { playerId: 'a', seat: 0, zone: 'TL', units: TEMPLATE_UNITS, placements: ARMY_7, brains: TEMPLATE_BRAINS },
      { playerId: 'b', seat: 1, zone: 'BR', units: TEMPLATE_UNITS, placements: ARMY_7, brains: TEMPLATE_BRAINS },
    ]);
    const engine = new BattleEngine({
      players: setups,
      config: DEFAULT_CONFIG,
      seed: 1,
      onFrame: (f) => {
        if (f.t === 100) engine.stop();
      },
    });
    const result = await engine.run();
    expect(result.endReason).toBe('stopped');
    expect(result.endTick).toBe(100);
    expect(engine.frames.at(-1)!.t).toBe(100);
  });
});

describe('sandbox policy (runner envelope → strikes, disable, report)', () => {
  const twoPlayers = (aBrains: FakePlayerSpec['brains'], hook?: FakePlayerSpec['hook'], aPlacements = [at(0, 0, 's'), at(1, 0, 's')]): FakePlayerSpec[] => [
    { playerId: 'a', seat: 0, zone: 'TL', units: [design('s', SOLDIER)], placements: aPlacements, brains: aBrains, ...(hook ? { hook } : {}) },
    { playerId: 'b', seat: 1, zone: 'BR', units: [design('t', stats({ type: 'tower', maxHealth: 500, damage: 0 }))], placements: [at(0, 0, 't')], brains: { t: idleBrain } },
  ];
  const ok = (outputs: TickResult['outputs'] = []): TickResult => ({ status: 'ok', outputs, elapsedMs: 1, slow: false, forged: 0 });

  it('a unit that throws idles, collects strikes and is disabled at the limit; the report names it', async () => {
    let calls = 0;
    const thrower = scripted(() => {
      calls++;
      throw new Error('boom');
    });
    const { result } = await battle(
      [
        { ...twoPlayers({})[0]!, units: [design('s', SOLDIER), design('x', SOLDIER)], placements: [at(0, 0, 'x'), at(1, 0, 's')], brains: { x: thrower, s: soldierBrain } },
        twoPlayers({})[1]!,
      ],
      cfg({}, 600),
    );
    const bad = unit(result, '0-0-0');
    expect(calls).toBe(30);
    expect(bad.strikes).toBe(30);
    expect(bad.disabled).toBe(true);
    expect(bad.disabledReason).toBe('errors');
    expect(unit(result, '0-0-1').disabled).toBe(false);
    expect(unit(result, '0-0-1').damageDealt).toBeGreaterThan(0);
    const report = buildBattleReport(result, 'a', 1);
    expect(report.errors).toHaveLength(30);
    expect(report.errors[0]).toMatchObject({ unitId: 'x', instanceId: '0-0-0', unitName: 'Basic Soldier', tick: 0, message: 'boom' });
    expect(report.disabled).toBe(1);
    expect(report.strikes).toBe(30);
    const disables = result.frames.flatMap((f) => f.events).filter((e) => e.type === 'disable');
    expect(disables).toEqual([{ type: 'disable', instanceId: '0-0-0', reason: 'errors' }]);
    expect(frameUnit(result.frames.at(-1)!, '0-0-0')![4] & FRAME_FLAGS.DISABLED).toBeTruthy();
  });

  it("a culprit's first timeout idles the tick and is reported, but doesn't disable it", async () => {
    const hook = (input: { tick: number }) =>
      input.tick === 5 ? { status: 'timeout' as const, outputs: [], elapsedMs: 26, slow: false, forged: 0, culprit: '0-0-0' } : undefined;
    const { result } = await battle(twoPlayers({ s: soldierBrain }, hook), cfg({}, 600));
    const zappy = unit(result, '0-0-0');
    expect(zappy.disabled).toBe(false);
    expect(zappy.strikes).toBe(1);
    expect(zappy.errors).toEqual([{ tick: 5, message: expect.stringMatching(/^Basic Soldier took too long once/) }]);
    expect(zappy.damageDealt).toBeGreaterThan(0);
    expect(result.players[0]!.timeouts).toBe(1);
    expect(result.players[0]!.disabled).toBe(false);
    expect(buildBattleReport(result, 'a', 1)).toMatchObject({ disabled: 0, strikes: 1 });
  });

  it("a culprit's second timeout disables only it; the other units keep acting", async () => {
    const hook = (input: { tick: number }) =>
      input.tick === 5 || input.tick === 9
        ? { status: 'timeout' as const, outputs: [], elapsedMs: 12, slow: false, forged: 0, culprit: '0-0-0' }
        : undefined;
    const { result } = await battle(twoPlayers({ s: soldierBrain }, hook), cfg({}, 600));
    expect(unit(result, '0-0-0').disabledReason).toBe('timeout');
    expect(unit(result, '0-0-0').errors.map((e) => e.tick)).toEqual([5, 9]);
    expect(unit(result, '0-0-0').strikes).toBe(2);
    const disables = result.frames.flatMap((f) => f.events).filter((e) => e.type === 'disable');
    expect(disables).toEqual([{ type: 'disable', instanceId: '0-0-0', reason: 'timeout' }]);
    expect(unit(result, '0-0-1').disabled).toBe(false);
    expect(unit(result, '0-0-1').damageDealt).toBeGreaterThan(0);
    expect(result.players[0]!.timeouts).toBe(2);
    expect(result.players[0]!.disabled).toBe(false);
  });

  it('host stalls (the sandbox process was frozen) idle the tick but blame nobody and count toward no limit', async () => {
    // 6 host-stall timeouts, 3+ in a row, naming a culprit: none of them is the player's code.
    const hook = (input: { tick: number }) =>
      input.tick >= 5 && input.tick < 11
        ? { status: 'timeout' as const, outputs: [], elapsedMs: 40, slow: false, forged: 0, culprit: '0-0-0', hostStall: true }
        : undefined;
    const { result } = await battle(twoPlayers({ s: soldierBrain }, hook), cfg({}, 600));
    expect(result.players[0]).toMatchObject({ disabled: false, timeouts: 0, playerStrikes: 0 });
    expect(unit(result, '0-0-0')).toMatchObject({ disabled: false, strikes: 0, errors: [] });
    expect(result.players[0]!.incidents.map((i) => [i.tick, i.kind])).toEqual([5, 6, 7, 8, 9, 10].map((t) => [t, 'timeout']));
    expect(unit(result, '0-0-0').damageDealt).toBeGreaterThan(0);
  });

  it('timeouts 3 in a row disable the whole player', async () => {
    const hook = (input: { tick: number }) =>
      input.tick >= 5 && input.tick < 8 ? { status: 'timeout' as const, outputs: [], elapsedMs: 12, slow: false, forged: 0 } : undefined;
    const { result } = await battle(twoPlayers({ s: soldierBrain }, hook), cfg({}, 60));
    expect(result.players[0]).toMatchObject({ disabled: true, disabledReason: 'player-timeouts', timeouts: 3 });
    expect(result.units.filter((u) => u.playerId === 'a').every((u) => u.disabled)).toBe(true);
    // Disabled units still stand on the field.
    expect(frameUnit(result.frames.at(-1)!, '0-0-0')).toBeDefined();
  });

  it('2 copies of a looping design both nap; the player is NOT disabled and the soldiers keep acting', async () => {
    // Real loop semantics: units run in order, so the first looper still acting hangs the tick (A, A, B, B).
    const loopers = new Set(['0-0-0', '0-0-1']);
    const hook = (input: { selves: { id: string }[] }) => {
      const c = input.selves.find((s) => loopers.has(s.id));
      return c ? { status: 'timeout' as const, outputs: [], elapsedMs: 13, slow: false, forged: 0, culprit: c.id } : undefined;
    };
    const { result } = await battle(
      [
        {
          ...twoPlayers({})[0]!,
          units: [design('L', SOLDIER), design('s', SOLDIER)],
          placements: [at(0, 0, 'L'), at(1, 0, 'L'), at(2, 0, 's'), at(0, 1, 's')],
          brains: { L: soldierBrain, s: soldierBrain },
          hook,
        },
        twoPlayers({})[1]!,
      ],
      cfg({}, 600),
    );
    expect(result.players[0]).toMatchObject({ disabled: false, timeouts: 4 });
    expect(unit(result, '0-0-0')).toMatchObject({ disabled: true, disabledReason: 'timeout' });
    expect(unit(result, '0-0-1')).toMatchObject({ disabled: true, disabledReason: 'timeout' });
    for (const id of ['0-0-2', '0-1-0']) {
      expect(unit(result, id).disabled).toBe(false);
      expect(unit(result, id).damageDealt).toBeGreaterThan(0);
    }
    expect(unit(result, '0-0-0').errors.map((e) => e.message)).toEqual([
      expect.stringMatching(/^Basic Soldier took too long once/),
      expect.stringMatching(/^Basic Soldier took too long again .*taking a nap/),
    ]);
  });

  it('timeoutsToDisable 1: the first timeout disables the culprit and the message does not say "again"', async () => {
    const hook = (input: { tick: number }) =>
      input.tick === 0 ? { status: 'timeout' as const, outputs: [], elapsedMs: 13, slow: false, forged: 0, culprit: '0-0-0' } : undefined;
    const { result } = await battle(twoPlayers({ s: soldierBrain }, hook), cfg({ sandbox: { battle: { timeoutsToDisable: 1 } } }, 60));
    const u = unit(result, '0-0-0');
    expect(u.disabledReason).toBe('timeout');
    expect(u.errors).toHaveLength(1);
    expect(u.errors[0]!.message).toMatch(/^Basic Soldier took too long \(/);
    expect(u.errors[0]!.message).not.toContain('again');
  });

  it('a crash disables all of the player\'s units for the rest of the battle', async () => {
    const hook = (input: { tick: number }) =>
      input.tick === 3 ? { status: 'crashed' as const, outputs: [], elapsedMs: 30, slow: false, forged: 0, detail: 'oom' } : undefined;
    const { result, runners } = await battle(twoPlayers({ s: soldierBrain }, hook), cfg({}, 60));
    expect(result.players[0]).toMatchObject({ disabled: true, disabledReason: 'crashed' });
    expect(runners.get('a')!.disposed).toBe(true);
    expect(buildBattleReport(result, 'a', 2).errors.some((e) => e.unitName === '(all units)' && e.message.includes('oom'))).toBe(true);
  });

  it('forged output is a player strike; bad output idles the whole tick', async () => {
    const hook = (input: { tick: number }) => {
      if (input.tick === 1) return { ...ok(), forged: 2 };
      if (input.tick === 2) return { status: 'bad-output' as const, outputs: [], elapsedMs: 1, slow: false, forged: 0 };
      return undefined;
    };
    const { result } = await battle(twoPlayers({ s: soldierBrain }, hook), cfg({}, 60));
    expect(result.players[0]!.playerStrikes).toBe(2);
    expect(result.players[0]!.incidents.map((i) => i.kind)).toEqual(['forged', 'bad-output']);
  });

  it('slow strikes disable the slowest unit first, then the player', async () => {
    const hook = (input: { selves: { id: string }[] }) => {
      const slowest = input.selves.find((s) => s.id === '0-0-0') ? '0-0-0' : input.selves[0]?.id;
      return { ...ok(input.selves.map((s) => ({ instanceId: s.id, action: { action: 'idle' } }))), slow: true, elapsedMs: 15, ...(slowest ? { slowestInstanceId: slowest } : {}) };
    };
    const { result } = await battle(twoPlayers({ s: idleBrain }, hook), cfg({}, 120));
    expect(unit(result, '0-0-0').disabledReason).toBe('slow');
    expect(unit(result, '0-0-1').disabledReason).toBe('player-slow');
    expect(result.players[0]!.disabled).toBe(true);
  });
});

describe('action validation', () => {
  const mk = (over: Partial<SimUnit>): SimUnit => ({
    id: '0-0-0', playerId: 'a', seat: 0, teamId: 0, unitId: 's', stats: SOLDIER, cost: 100, type: 'soldier', radius: 10,
    x: 100, y: 100, hp: 120, maxHp: 120, cooldownRemaining: 0, alive: true, disabled: false, spawned: true,
    movedSinceFrame: false, firedSinceFrame: false, facingLeft: false, outsideSafeZone: false, damageDealt: 0, kills: 0, valueDestroyed: 0, strikes: 0, errors: [], diedAtTick: null,
    ...over,
  });
  const me = mk({});
  const tower = mk({ id: '0-0-1', type: 'tower', radius: 14, stats: TOWER });
  // Edge gap exactly range + 0.5 → still in range; a hair more → out.
  const edge = mk({ id: '1-0-0', playerId: 'b', seat: 1, teamId: 1, x: 100 + 10 + 10 + 40.5, y: 100 });
  const beyond = mk({ id: '1-0-1', playerId: 'b', seat: 1, teamId: 1, x: 100 + 10 + 10 + 40.51, y: 100 });
  const ally = mk({ id: '0-1-0', x: 110, y: 100 });
  const dead = mk({ id: '1-1-1', playerId: 'b', seat: 1, teamId: 1, alive: false, x: 105 });
  const units = new Map([edge, beyond, ally, dead].map((u) => [u.id, u]));
  const look = (id: string) => units.get(id);
  const r = (raw: unknown, actor = me) => resolveAction(raw, actor, look, 0.5);

  it('turns illegal requests into idle with a reason', () => {
    expect(r({ action: 'attack', targetId: '1-0-0' })).toEqual({ kind: 'attack', targetId: '1-0-0' });
    expect(r({ action: 'attack', targetId: '1-0-1' })).toEqual({ kind: 'idle', reason: 'out-of-range' });
    expect(r({ action: 'attack', targetId: '0-1-0' })).toEqual({ kind: 'idle', reason: 'friendly-target' });
    expect(r({ action: 'attack', targetId: '1-1-1' })).toEqual({ kind: 'idle', reason: 'no-target' });
    expect(r({ action: 'attack', targetId: 'nope' })).toEqual({ kind: 'idle', reason: 'no-target' });
    expect(r({ action: 'attack', targetId: '1-0-0' }, mk({ cooldownRemaining: 1 }))).toEqual({ kind: 'idle', reason: 'cooling-down' });
    expect(r({ action: 'move', destination: { x: 1, y: 2 } }, tower)).toEqual({ kind: 'idle', reason: 'tower-cannot-move' });
    expect(r({ action: 'move', destination: { x: NaN, y: 2 } })).toEqual({ kind: 'idle', reason: 'malformed' });
    expect(r({ action: 'move', destination: { x: '1', y: 2 } })).toEqual({ kind: 'idle', reason: 'malformed' });
    expect(r({ action: 'move', destination: { x: -50, y: 900 } })).toEqual({ kind: 'move', destination: { x: 0, y: 800 } });
    expect(r(undefined)).toEqual({ kind: 'idle', reason: 'idle' });
    expect(r({})).toEqual({ kind: 'idle', reason: 'malformed' });
    expect(r('attack')).toEqual({ kind: 'idle', reason: 'malformed' });
    expect(r([{ action: 'idle' }])).toEqual({ kind: 'idle', reason: 'malformed' });
    expect(r({ action: 'fly' })).toEqual({ kind: 'idle', reason: 'malformed' });
    expect(r({ action: 'attack', targetId: '1-0-0' }, mk({ disabled: true }))).toEqual({ kind: 'idle', reason: 'disabled' });
  });

  it('instances are `${seat}-${row}-${col}` at zone cell centres, sorted', () => {
    const inst = buildInstances({ seat: 2, zone: 'BR', units: [design('s', SOLDIER)], placements: [at(3, 1, 's'), at(0, 0, 's')] });
    expect(inst.map((i) => i.instanceId)).toEqual(['2-0-0', '2-1-3']);
    expect(inst[0]).toMatchObject(cellCenter('BR', 0, 0));
    expect(() => buildInstances({ seat: 0, zone: 'TL', units: [], placements: [at(0, 0, 's')] })).toThrow();
    expect(() => buildInstances({ seat: 0, zone: 'TL', units: [design('s', SOLDIER)], placements: [at(0, 0, 's'), at(0, 0, 's')] })).toThrow();
  });
});

describe('size, facing and frame flags (§5 size, §9 Radii/Frames)', () => {
  it("a unit's radius is its size stat: views, range and frames use it", async () => {
    const big = stats({ type: 'soldier', name: 'Big', size: 20 });
    const small = stats({ type: 'tower', name: 'Small', size: 6 });
    const { setups, runners } = fakePlayers([
      { playerId: 'a', seat: 0, zone: 'TL', units: [design('b', big)], placements: [at(0, 0, 'b')], brains: { b: idleBrain } },
      { playerId: 'b', seat: 1, zone: 'BR', units: [design('s', small)], placements: [at(0, 0, 's')], brains: { s: idleBrain } },
    ]);
    runners.get('a')!.recordInputs = true;
    await runBattle({ players: setups, config: cfg({}, 4), seed: 1 });
    const first = runners.get('a')!.inputs[0]!;
    expect(first.selves[0]!.radius).toBe(20);
    expect(first.enemies[0]!.radius).toBe(6);
    expect(first.allies[0]!.radius).toBe(20);
    // Edge-to-edge range uses the size: just in range with radius 20, out with 10.
    const me = { id: '0-0-0', playerId: 'a', seat: 0, teamId: 0, unitId: 'b', stats: big, cost: 0, type: 'soldier' as const, x: 100, y: 100, hp: 120, maxHp: 120, cooldownRemaining: 0, alive: true, disabled: false, spawned: true, movedSinceFrame: false, firedSinceFrame: false, facingLeft: false, outsideSafeZone: false, damageDealt: 0, kills: 0, valueDestroyed: 0, strikes: 0, errors: [], diedAtTick: null };
    const target = { ...me, id: '1-0-0', playerId: 'b', seat: 1, teamId: 1, radius: 6, x: 100 + 20 + 6 + 40 };
    const look = (id: string) => (id === target.id ? target : undefined);
    expect(resolveAction({ action: 'attack', targetId: '1-0-0' }, { ...me, radius: 20 }, look, 0.5).kind).toBe('attack');
    expect(resolveAction({ action: 'attack', targetId: '1-0-0' }, { ...me, radius: 10 }, look, 0.5).kind).toBe('idle');
  });

  it('a big unit is clamped to the arena by its own size', async () => {
    const big = stats({ type: 'soldier', name: 'Big', size: 20, speed: 5 });
    const corner = scripted(() => ({ action: 'move', destination: { x: 0, y: 0 } }));
    const { result } = await battle(
      [
        { playerId: 'a', seat: 0, zone: 'TL', units: [design('b', big)], placements: [at(0, 0, 'b')], brains: { b: corner } },
        { playerId: 'b', seat: 1, zone: 'BR', units: [design('t', TOWER)], placements: [at(5, 5, 't')], brains: { t: idleBrain } },
      ],
      cfg({}, 200),
    );
    const last = frameUnit(result.frames.at(-1)!, '0-0-0')!;
    expect(last[1]).toBeCloseTo(20, 5);
    expect(last[2]).toBeCloseTo(20, 5);
  });

  it('FACING_LEFT: starts facing the centre, follows horizontal moves and the target side', async () => {
    // Seat a (TL) walks left after tick 10; seat b (BR) starts facing left, then walks right.
    const leftLater = scripted((self, _e, _a, world) =>
      world.tick < 10 ? { action: 'idle' } : { action: 'move', destination: { x: 0, y: self.y } },
    );
    const right = scripted((self) => ({ action: 'move', destination: { x: 800, y: self.y } }));
    const { result } = await battle(
      [
        { playerId: 'a', seat: 0, zone: 'TL', units: [design('s', SOLDIER)], placements: [at(0, 0, 's')], brains: { s: leftLater } },
        { playerId: 'b', seat: 1, zone: 'BR', units: [design('s', SOLDIER)], placements: [at(0, 0, 's')], brains: { s: right } },
      ],
      cfg({}, 30),
    );
    const flag = (t: number, id: string) => frameUnit(result.frames.find((f) => f.t === t)!, id)![4] & FRAME_FLAGS.FACING_LEFT;
    expect(flag(0, '0-0-0')).toBe(0); // TL faces right (towards the centre)
    expect(flag(0, '1-0-0')).toBeTruthy(); // BR faces left (towards the centre)
    expect(flag(8, '0-0-0')).toBe(0);
    expect(flag(20, '0-0-0')).toBeTruthy(); // walked left
    expect(flag(20, '1-0-0')).toBe(0); // walked right

    // Firing turns the unit towards its target.
    const tower = stats({ type: 'tower', name: 'T', range: 300 });
    const { result: r2 } = await battle(
      [
        { playerId: 'a', seat: 0, zone: 'TL', units: [design('t', tower)], placements: [at(0, 0, 't')], brains: { t: idleBrain } },
        { playerId: 'b', seat: 1, zone: 'TR', units: [design('t', tower)], placements: [at(0, 0, 't')], brains: { t: towerBrain } },
      ],
      cfg({}, 4),
    );
    // TR's (0,0) cell faces the centre (left) and its target (TL) is also left.
    expect(frameUnit(r2.frames.at(-1)!, '1-0-0')![4] & FRAME_FLAGS.FACING_LEFT).toBeTruthy();
  });

  it.each([0, 1])('MOVING covers the whole frame interval (moves only on ticks of parity %i)', async (parity) => {
    const sometimes = scripted((self, _e, _a, world) =>
      world.tick % 2 === parity ? { action: 'move', destination: { x: self.x + 50, y: self.y } } : { action: 'idle' },
    );
    const { result } = await battle(
      [
        { playerId: 'a', seat: 0, zone: 'TL', units: [design('s', SOLDIER)], placements: [at(0, 0, 's')], brains: { s: sometimes } },
        { playerId: 'b', seat: 1, zone: 'BR', units: [design('t', TOWER)], placements: [at(5, 5, 't')], brains: { t: idleBrain } },
      ],
      cfg({}, 20),
    );
    const frames = result.frames.filter((f) => f.t > 0);
    expect(frames.length).toBeGreaterThan(5);
    for (const f of frames) expect(frameUnit(f, '0-0-0')![4] & FRAME_FLAGS.MOVING, `t=${f.t}`).toBeTruthy();
    // And a unit that never moves never shows MOVING.
    for (const f of frames) expect(frameUnit(f, '1-5-5')![4] & FRAME_FLAGS.MOVING).toBe(0);
  });
});

describe('scoring metrics (§9 Damage metric, Value destroyed, Skip)', () => {
  const REAPER = stats({ type: 'soldier', name: 'Reaper', maxHealth: 500, damage: 60, speed: 5, attackCooldown: 10 });

  it('effective damage: a 60-damage hit on a 10-hp unit counts 10 (no overkill), plus the kill and its full cost', async () => {
    const twig = stats({ type: 'soldier', name: 'Twig', maxHealth: 10 });
    const twigCost = design('t', twig).cost;
    const { result } = await battle(
      [
        { playerId: 'a', seat: 0, zone: 'TL', units: [design('r', REAPER, 250)], placements: [at(0, 0, 'r')], brains: { r: soldierBrain } },
        { playerId: 'b', seat: 1, zone: 'BR', units: [design('t', twig)], placements: [at(0, 0, 't')], brains: { t: idleBrain } },
      ],
      cfg({}, 900),
    );
    expect(result.endReason).toBe('elimination');
    const reaper = unit(result, '0-0-0');
    expect(reaper).toMatchObject({ damageDealt: 10, kills: 1, valueDestroyed: twigCost });
    const hits = result.frames.flatMap((f) => f.events).filter((e) => e.type === 'hit');
    expect(hits).toEqual([{ type: 'hit', instanceId: '0-0-0', targetId: '1-0-0', damage: 10 }]);
    expect(playerMetrics(result)).toEqual([
      { playerId: 'a', damage: 10, valueDestroyed: twigCost, kills: 1, livingValue: 250 },
      { playerId: 'b', damage: 0, valueDestroyed: 0, kills: 0, livingValue: 0 },
    ]);
    // 2 players: a gets 1 place + 1 damage + 1 value; b nothing.
    expect(result.ranking.map((r) => [r.playerId, r.placePoints, r.damageBonus, r.valueBonus, r.pointsGained])).toEqual([
      ['a', 1, 1, 1, 3],
      ['b', 0, 0, 0, 0],
    ]);
    expect(result.ranking[0]!.badges).toEqual(['lastStanding', 'biggestHitter', 'giantSlayer', 'ironWall']);
    expect(buildBattleReport(result, 'a', 1)).toMatchObject({ damageDealt: 10, kills: 1, valueDestroyed: twigCost, livingValue: 250 });
    expect(buildBattleReport(result, 'a', 1).score).toMatchObject({ place: 1, total: 3 });
  });

  it('a projectile is credited on impact, not when fired', async () => {
    const archer = stats({ type: 'soldier', name: 'Archer', range: 150 });
    const wall = stats({ type: 'tower', name: 'Wall', maxHealth: 500, damage: 0 });
    const { setups } = fakePlayers([
      { playerId: 'a', seat: 0, zone: 'TL', units: [design('s', archer)], placements: [at(0, 0, 's')], brains: { s: soldierBrain } },
      { playerId: 'b', seat: 1, zone: 'BR', units: [design('w', wall)], placements: [at(0, 0, 'w')], brains: { w: idleBrain } },
    ]);
    const engine = new BattleEngine({ players: setups, config: cfg({}, 600), seed: 1 });
    await engine.run();
    const firstT = (type: string) => engine.frames.find((f) => f.events.some((e) => e.type === type))!.t;
    const fired = firstT('fire');
    const landed = firstT('hit');
    expect(landed).toBeGreaterThan(fired); // ~13 ticks of flight at 10 px/tick
    expect(engine.frames.find((f) => f.t === fired)!.projectiles).toHaveLength(1);
    expect(engine.countersAt(fired).units.get('0-0-0')?.damageDealt ?? 0).toBe(0);
    expect(engine.metricsAt(landed - 2)[0]!.damage).toBe(0);
    expect(engine.countersAt(landed).units.get('0-0-0')!.damageDealt).toBe(10);
    expect(engine.metricsAt(landed)[0]!.damage).toBe(10);
  });

  it('a same-tick double kill goes to the lower seat (seat, then instanceId order), not the projectile order', () => {
    const mk = (id: string, playerId: string, hp: number, cost = 100): SimUnit => ({
      id, playerId, seat: Number(id[0]), teamId: Number(id[0]), unitId: 'u', stats: TOWER, cost, type: 'tower', radius: 10,
      x: 400, y: 400, hp, maxHp: 150, cooldownRemaining: 0, alive: true, disabled: false, spawned: true,
      movedSinceFrame: false, firedSinceFrame: false, facingLeft: false, outsideSafeZone: false,
      damageDealt: 0, kills: 0, valueDestroyed: 0, strikes: 0, errors: [], diedAtTick: null,
    });
    const target = mk('2-0-0', 'c', 8, 190);
    const shooters = new Map([mk('0-1-1', 'a', 150), mk('1-0-0', 'b', 150), target].map((u) => [u.id, u]));
    // Both shots arrive this step; seat 1's was fired first (lower projectile id).
    const shots = [
      { id: 1, x: 395, y: 400, ownerId: '1-0-0', targetId: '2-0-0', damage: 15 },
      { id: 2, x: 405, y: 400, ownerId: '0-1-1', targetId: '2-0-0', damage: 15 },
    ];
    const landed: string[] = [];
    const left = advanceProjectiles(shots, (id) => shooters.get(id), 10, (p, t) => {
      landed.push(p.ownerId);
      applyHit(shooters.get(p.ownerId), t, p.damage);
    });
    expect(left).toEqual([]);
    expect(landed).toEqual(['0-1-1']); // the second shot fizzles: the target is already at ≤ 0 hp
    expect(shooters.get('0-1-1')).toMatchObject({ damageDealt: 8, kills: 1, valueDestroyed: 190 });
    expect(shooters.get('1-0-0')).toMatchObject({ damageDealt: 0, kills: 0, valueDestroyed: 0 });
    // A melee hit on a target already at ≤ 0 hp deals nothing and gets no kill.
    expect(applyHit(shooters.get('1-0-0'), target, 15)).toEqual({ dealt: 0, killed: false });
  });

  it('melee and projectile hits of one tick resolve together in seat order: a seat-1 shot beats a seat-2 swipe', () => {
    const mk = (id: string, playerId: string, hp: number, cost = 100): SimUnit => ({
      id, playerId, seat: Number(id[0]), teamId: Number(id[0]), unitId: 'u', stats: TOWER, cost, type: 'tower', radius: 10,
      x: 400, y: 400, hp, maxHp: 150, cooldownRemaining: 0, alive: true, disabled: false, spawned: true,
      movedSinceFrame: false, firedSinceFrame: false, facingLeft: false, outsideSafeZone: false,
      damageDealt: 0, kills: 0, valueDestroyed: 0, strikes: 0, errors: [], diedAtTick: null,
    });
    const target = mk('3-0-0', 'd', 8, 190);
    const units = new Map([mk('1-0-0', 'b', 150), mk('2-0-0', 'c', 150), target].map((u) => [u.id, u]));
    // Step 6 queues seat 2's melee swipe; step 7's seat-1 projectile arrives the same tick.
    const melee = { attackerId: '2-0-0', target, damage: 15 };
    const moved = moveProjectiles([{ id: 1, x: 395, y: 400, ownerId: '1-0-0', targetId: '3-0-0', damage: 15 }], (id) => units.get(id), 10);
    expect(moved.remaining).toEqual([]);
    const landed: string[] = [];
    resolveHits([melee, ...moved.arrived], (h) => {
      landed.push(h.attackerId);
      applyHit(units.get(h.attackerId), h.target, h.damage);
    });
    // Seat 1 lands first and gets the kill; seat 2's swipe still lands but deals nothing.
    expect(landed).toEqual(['1-0-0', '2-0-0']);
    expect(units.get('1-0-0')).toMatchObject({ damageDealt: 8, kills: 1, valueDestroyed: 190 });
    expect(units.get('2-0-0')).toMatchObject({ damageDealt: 0, kills: 0, valueDestroyed: 0 });
  });

  it('same-tick melee kills are deterministic: mirrored units each get their own kill', async () => {
    const units = [design('s', SOLDIER)];
    const run = async () =>
      (
        await battle(
          [
            { playerId: 'a', seat: 0, zone: 'TL', units, placements: [at(0, 0, 's')], brains: { s: soldierBrain } },
            { playerId: 'b', seat: 1, zone: 'BR', units, placements: [at(0, 0, 's')], brains: { s: soldierBrain } },
          ],
          cfg({}, 5400),
        )
      ).result;
    const r1 = await run();
    const r2 = await run();
    expect(r1.units.map((u) => [u.instanceId, u.damageDealt, u.kills, u.valueDestroyed])).toEqual([
      ['0-0-0', 120, 1, 92],
      ['1-0-0', 120, 1, 92],
    ]);
    expect(r2.ranking).toEqual(r1.ranking);
  });

  it('sudden-death damage and deaths credit nobody', async () => {
    const config = cfg({ suddenDeath: { startTick: 0, endTick: 60, startRadius: 10, endRadius: 0, damagePctPerSecond: 100 } }, 600, true);
    const { result } = await battle(
      [
        { playerId: 'a', seat: 0, zone: 'TL', units: TEMPLATE_UNITS, placements: ARMY_7, brains: { soldier: idleBrain, tower: idleBrain } },
        { playerId: 'b', seat: 1, zone: 'BR', units: TEMPLATE_UNITS, placements: ARMY_7, brains: { soldier: idleBrain, tower: idleBrain } },
      ],
      config,
    );
    expect(result.endReason).toBe('elimination');
    expect(result.units.every((u) => !u.survived)).toBe(true);
    expect(result.units.every((u) => u.damageDealt === 0 && u.kills === 0 && u.valueDestroyed === 0)).toBe(true);
    expect(result.frames.flatMap((f) => f.events).some((e) => e.type === 'hit')).toBe(false);
    for (const r of result.ranking) {
      expect(r).toMatchObject({ damage: 0, damageBonus: 0, valueDestroyed: 0, valueBonus: 0 });
      expect(r.badges.filter((b) => b !== 'lastStanding')).toEqual([]);
    }
  });

  it('Skip scores with the metrics at the playback tick, not the sim lead', async () => {
    const { setups } = fakePlayers([
      { playerId: 'a', seat: 0, zone: 'TL', units: [design('s', SOLDIER)], placements: [at(0, 0, 's'), at(1, 0, 's'), at(0, 1, 's')], brains: { s: idleBrain } },
      { playerId: 'b', seat: 1, zone: 'BR', units: [design('r', REAPER, 250)], placements: [at(0, 0, 'r')], brains: { r: soldierBrain } },
    ]);
    const engine = new BattleEngine({ players: setups, config: cfg({}, 5400), seed: 7 });
    const result = await engine.run();
    expect(result.endReason).toBe('elimination');
    const finalB = playerMetrics(result)[1]!;
    expect(finalB).toMatchObject({ kills: 3, valueDestroyed: 276 });

    // At the start nothing has happened yet.
    expect(engine.metricsAt(0)).toEqual([
      { playerId: 'a', damage: 0, valueDestroyed: 0, kills: 0, livingValue: 276 },
      { playerId: 'b', damage: 0, valueDestroyed: 0, kills: 0, livingValue: 250 },
    ]);

    // Just after the first kill: one kill, $92, and less damage than at the end.
    const firstDeath = result.units.filter((u) => u.playerId === 'a').map((u) => u.diedAtTick!).sort((x, y) => x - y)[0]!;
    const frame = frameAt(engine.frames, firstDeath + 2)!;
    const mid = engine.metricsAt(frame.t);
    expect(mid[1]).toMatchObject({ kills: 1, valueDestroyed: 92, livingValue: 250 });
    expect(mid[1]!.damage).toBeLessThan(finalB.damage);
    expect(mid[0]!.livingValue).toBe(184);
    // The same as trimming the result to that tick (what the battle service does on Skip).
    const trimmed = resultAtTick(result, engine.countersAt(frame.t), new Set(frame.units.map((u) => u[0])), frame.t);
    expect(playerMetrics(trimmed)).toEqual(mid);

    // Scored at the playback tick: b leads on living value and gets every bonus.
    const ranking = scoreRanking(rankFromFrame(frame, result), mid, DEFAULT_CONFIG.scoring);
    expect(ranking.map((r) => [r.playerId, r.place, r.placePoints, r.damageBonus, r.valueBonus, r.pointsGained, r.valueDestroyed])).toEqual([
      ['b', 1, 1, 1, 1, 3, 92],
      ['a', 2, 0, 0, 0, 0, 0],
    ]);
    expect(ranking[0]!.badges).toEqual(['lastStanding', 'biggestHitter', 'giantSlayer', 'ironWall']);
    // The report of the trimmed result carries the score at that tick.
    expect(buildBattleReport(trimmed, 'b', 1, ranking)).toMatchObject({ kills: 1, valueDestroyed: 92, score: { total: 3 } });
  });
});

describe('maps: variable arena (§9.2)', () => {
  it('Ring 5 on the 1040 arena: world size, centre, style, scaled safe zone and the zone centre as myCorner', async () => {
    const map = mapFor('ring', 5);
    const specs: FakePlayerSpec[] = map.zones.map((zone, seat) => ({
      playerId: `p${seat}`, seat, zone, units: [design('w', TOWER)], placements: [at(0, 0, 'w')], brains: { w: idleBrain },
    }));
    const { setups, runners } = fakePlayers(specs);
    runners.get('p2')!.recordInputs = true;
    const result = await runBattle({ players: setups, map, config: cfg({}, 4, true), seed: 1 });
    const world = runners.get('p2')!.inputs[0]!.world;
    expect(world).toMatchObject({ width: 1040, height: 1040, mapStyle: 'ring', center: { x: 520, y: 520 }, myCorner: zoneCenterOf(map.zones[2]!) });
    expect(world.safeZone).toEqual({ x: 520, y: 520, radius: 741 });
    expect(result.frames[0]!.safeZoneRadius).toBe(741);
    // Instances sit at the zone's (0,0) cell: the front cell nearest the centre.
    expect(result.frames[0]!.units.find((u) => u[0] === '2-0-0')!.slice(1, 3)).toEqual([cellCenter(map.zones[2]!, 0, 0).x, cellCenter(map.zones[2]!, 0, 0).y]);
  });

  it('moves are clamped to the bigger arena, not to 800', async () => {
    const map = mapFor('ring', 7);
    const runner = scripted(() => ({ action: 'move', destination: { x: 5000, y: 5000 } }));
    const fast = stats({ type: 'soldier', speed: 5 });
    const specs: FakePlayerSpec[] = map.zones.map((zone, seat) => ({
      playerId: `p${seat}`, seat, zone, units: [design('s', fast)], placements: [at(0, 0, 's')], brains: { s: seat === 0 ? runner : idleBrain },
    }));
    const { result } = await battle(specs, cfg({}, 400));
    const last = result.frames.at(-1)!.units.find((u) => u[0] === '0-0-0')!;
    expect(last[1]).toBeGreaterThan(800);
    expect(last[1]).toBeLessThanOrEqual(1200 - 10);
    expect(last[2]).toBeLessThanOrEqual(1200 - 10);
  });

  it('sudden death is centred on the arena centre of the map', async () => {
    const map = mapFor('ring', 8);
    // Ring 8 corner zones (679 px out) are outside the shrunk circle at the end; edge zones too, but the centre isn't 400,400.
    const specs: FakePlayerSpec[] = map.zones.map((zone, seat) => ({
      playerId: `p${seat}`, seat, zone, units: [design('w', stats({ type: 'tower', maxHealth: 500 }))], placements: [at(0, 0, 'w')], brains: { w: idleBrain },
    }));
    const { result } = await battle(specs, cfg({ suddenDeath: { startTick: 0, endTick: 10, startRadius: 570, endRadius: 500, damagePctPerSecond: 4 } }, 30, true));
    // Scaled ×1.5: end radius 750. Edge zones' (0,0) cells are ~380 px from (600,600) → safe; corners ~ 537 px → safe too;
    // nothing is hurt because the circle sits on (600,600). Centred on (400,400) the right/bottom zones would bleed.
    expect(result.frames.at(-1)!.safeZoneRadius).toBe(750);
    expect(result.units.every((u) => u.hp === 500)).toBe(true);
  });

  it('players\' zones must agree on the arena size', () => {
    const big = mapFor('ring', 5).zones[0]!;
    const { setups } = fakePlayers([
      { playerId: 'a', seat: 0, zone: 'TL', units: [design('w', TOWER)], placements: [at(0, 0, 'w')], brains: { w: idleBrain } },
      { playerId: 'b', seat: 1, zone: big, units: [design('w', TOWER)], placements: [at(0, 0, 'w')], brains: { w: idleBrain } },
    ]);
    expect(() => new BattleEngine({ players: setups, config: cfg(), seed: 1 })).toThrow(/arena size/);
  });
});

describe('teams (§9.2)', () => {
  const REAPER = stats({ type: 'soldier', name: 'Reaper', maxHealth: 500, damage: 60, speed: 5, attackCooldown: 10 });
  const twig = stats({ type: 'soldier', name: 'Twig', maxHealth: 10 });
  const wall = stats({ type: 'tower', name: 'Wall', maxHealth: 500, damage: 0 });
  const corners = mapFor('corners', 4);
  /** 2v2 on Corners: team 0 = a (TL) + d (TR), team 1 = b (BR) + c (BL). */
  const twoVsTwo = (brains: Record<string, FakePlayerSpec['brains']>, units: Record<string, ReturnType<typeof design>>): FakePlayerSpec[] => [
    { playerId: 'a', seat: 0, teamId: 0, zone: corners.zones[0]!, units: [units.a!], placements: [at(0, 0, units.a!.unitId)], brains: brains.a! },
    { playerId: 'b', seat: 1, teamId: 1, zone: corners.zones[2]!, units: [units.b!], placements: [at(0, 0, units.b!.unitId)], brains: brains.b! },
    { playerId: 'c', seat: 2, teamId: 1, zone: corners.zones[3]!, units: [units.c!], placements: [at(0, 0, units.c!.unitId)], brains: brains.c! },
    { playerId: 'd', seat: 3, teamId: 0, zone: corners.zones[1]!, units: [units.d!], placements: [at(0, 0, units.d!.unitId)], brains: brains.d! },
  ];

  it('views: teamId on Self/OtherView; allies = all of the team\'s units, enemies = the other team only', async () => {
    const w = design('w', wall);
    const idle = { w: idleBrain };
    const { setups, runners } = fakePlayers(twoVsTwo({ a: idle, b: idle, c: idle, d: idle }, { a: w, b: w, c: w, d: w }));
    runners.get('a')!.recordInputs = true;
    runners.get('b')!.recordInputs = true;
    await runBattle({ players: setups, map: corners, config: cfg({}, 2), seed: 1 });
    const a = runners.get('a')!.inputs[0]!;
    expect(a.selves.map((s) => [s.id, s.teamId])).toEqual([['0-0-0', 0]]);
    expect(a.allies.map((o) => [o.id, o.ownerId, o.teamId])).toEqual([['0-0-0', 'a', 0], ['3-0-0', 'd', 0]]);
    expect(a.enemies.map((o) => [o.id, o.teamId])).toEqual([['1-0-0', 1], ['2-0-0', 1]]);
    expect(a.world.mapStyle).toBe('corners');
    const b = runners.get('b')!.inputs[0]!;
    expect(b.allies.map((o) => o.id)).toEqual(['1-0-0', '2-0-0']);
    expect(b.enemies.map((o) => o.id)).toEqual(['0-0-0', '3-0-0']);
  });

  it('free-for-all: teamId = seat, so allies are only your own units', async () => {
    const w = design('w', wall);
    const { setups, runners } = fakePlayers([
      { playerId: 'a', seat: 0, zone: 'TL', units: [w], placements: [at(0, 0, 'w'), at(1, 0, 'w')], brains: { w: idleBrain } },
      { playerId: 'b', seat: 1, zone: 'TR', units: [w], placements: [at(0, 0, 'w')], brains: { w: idleBrain } },
      { playerId: 'c', seat: 2, zone: 'BR', units: [w], placements: [at(0, 0, 'w')], brains: { w: idleBrain } },
    ]);
    runners.get('c')!.recordInputs = true;
    await runBattle({ players: setups, config: cfg({}, 2), seed: 1 });
    const c = runners.get('c')!.inputs[0]!;
    expect(c.selves[0]!.teamId).toBe(2);
    expect(c.allies.map((o) => o.id)).toEqual(['2-0-0']);
    expect(c.enemies.map((o) => [o.id, o.teamId])).toEqual([['0-0-0', 0], ['0-0-1', 0], ['1-0-0', 1]]);
  });

  it('no friendly fire: attacking a teammate\'s unit idles and deals nothing', async () => {
    // d's long-range tower tries to shoot its teammate a (in range on the shared edge).
    const sniper = design('s', stats({ type: 'tower', name: 'Sniper', range: 300, damage: 60, attackCooldown: 10 }));
    const w = design('w', wall);
    const traitor = scripted((_self, _enemies, allies) => {
      const mate = allies.find((o) => o.ownerId !== 'd');
      return mate ? { action: 'attack', targetId: mate.id } : { action: 'idle' };
    });
    const idle = { w: idleBrain };
    const { result } = await battle(twoVsTwo({ a: idle, b: idle, c: idle, d: { s: traitor } }, { a: w, b: w, c: w, d: sniper }), cfg({}, 120));
    expect(unit(result, '0-0-0').hp).toBe(500);
    expect(unit(result, '3-0-0').damageDealt).toBe(0);
    expect(result.frames.flatMap((f) => f.events).some((e) => e.type === 'fire')).toBe(false);
  });

  it('a team is eliminated with its last unit; the battle ends when one team is left; every member shares the place', async () => {
    const r = design('r', REAPER);
    const t = design('t', twig);
    const w = design('w', wall);
    const { result } = await battle(
      twoVsTwo({ a: { r: soldierBrain }, b: { t: idleBrain }, c: { t: idleBrain }, d: { w: idleBrain } }, { a: r, b: t, c: t, d: w }),
      cfg({}, 3000),
    );
    expect(result.endReason).toBe('elimination');
    const b = result.players.find((p) => p.playerId === 'b')!;
    const c = result.players.find((p) => p.playerId === 'c')!;
    expect(b.eliminatedAtTick).not.toBeNull();
    expect(c.eliminatedAtTick).not.toBeNull();
    // The battle ended on the tick the team's LAST unit died, not the first.
    expect(result.endTick).toBe(Math.max(b.eliminatedAtTick!, c.eliminatedAtTick!));
    expect(b.eliminatedAtTick).not.toBe(c.eliminatedAtTick);
    expect(result.players.map((p) => p.teamId)).toEqual([0, 1, 1, 0]);
    // 4 players, 2 teams: place points 3 / 0 for every member; d did nothing but still gets Last Standing.
    expect(result.ranking.map((x) => [x.playerId, x.teamId, x.place, x.placePoints])).toEqual([
      ['a', 0, 1, 3],
      ['d', 0, 1, 3],
      ['b', 1, 2, 0],
      ['c', 1, 2, 0],
    ]);
    expect(result.ranking.find((x) => x.playerId === 'd')!.badges).toContain('lastStanding');
    expect(result.ranking.find((x) => x.playerId === 'a')!).toMatchObject({ damageBonus: 2, valueBonus: 1 }); // individual, P = 4
    expect(result.ranking.find((x) => x.playerId === 'd')!).toMatchObject({ damageBonus: 0, valueBonus: 0 });
    expect(result.teams).toEqual([
      { teamId: 0, place: 1, placePoints: 3, livingCost: r.cost + w.cost, eliminatedAtTick: null, members: ['a', 'd'] },
      { teamId: 1, place: 2, placePoints: 0, livingCost: 0, eliminatedAtTick: result.endTick, members: ['b', 'c'] },
    ]);
  });

  it('a member whose units all died keeps watching: the team fights on until its last unit', async () => {
    // Team 1's c (BL, nearest) is a twig the reaper kills first; b's wall keeps team 1 alive until the time limit.
    const r = design('r', REAPER);
    const t = design('t', twig);
    const w = design('w', wall);
    const { result } = await battle(
      twoVsTwo({ a: { r: soldierBrain }, b: { w: idleBrain }, c: { t: idleBrain }, d: { w: idleBrain } }, { a: r, b: w, c: t, d: w }),
      cfg({}, 150),
    );
    expect(result.players.find((p) => p.playerId === 'c')!.eliminatedAtTick).not.toBeNull();
    expect(result.players.find((p) => p.playerId === 'b')!.eliminatedAtTick).toBeNull();
    expect(result.endReason).toBe('timeout');
    expect(result.teams!.map((x) => [x.teamId, x.eliminatedAtTick])).toEqual([[0, null], [1, null]]);
  });

  it('timeout: teams are ranked by team living cost (the sum over members)', async () => {
    const tower = design('t', TOWER); // $198
    const soldier = design('s', SOLDIER); // $92
    const idle = { t: idleBrain, s: idleBrain };
    // Team 0: a tower + d soldier = $290. Team 1: two towers = $396.
    const { result } = await battle(twoVsTwo({ a: idle, b: idle, c: idle, d: idle }, { a: tower, b: tower, c: tower, d: soldier }), cfg({}, 60));
    expect(result.endReason).toBe('timeout');
    expect(result.teams!.map((x) => [x.teamId, x.place, x.livingCost, x.placePoints])).toEqual([
      [1, 1, 396, 3],
      [0, 2, 290, 0],
    ]);
    // Individually a ($198) out-values d ($92) and b, c ($198) but team 0 still comes 2nd.
    expect(result.ranking.map((x) => [x.playerId, x.place])).toEqual([['b', 1], ['c', 1], ['a', 2], ['d', 2]]);
  });

  it('kicked members do not count towards the team living cost', async () => {
    const tower = design('t', TOWER);
    const big = design('b', stats({ type: 'tower', name: 'Big', maxHealth: 500 }));
    const idle = { t: idleBrain, b: idleBrain };
    // d's big tower would put team 0 ahead, but d was kicked: team 0 = a's $198 vs team 1's $396.
    const { result } = await battle(twoVsTwo({ a: idle, b: idle, c: idle, d: idle }, { a: tower, b: tower, c: tower, d: big }), cfg({}, 30), 7, new Set(['d']));
    expect(result.ranking.map((x) => [x.playerId, x.place, x.placePoints])).toEqual([['b', 1, 2], ['c', 1, 2], ['a', 2, 0]]);
  });

  it('teamIds must be given to every player or to none', () => {
    const w = design('w', wall);
    const { setups } = fakePlayers([
      { playerId: 'a', seat: 0, teamId: 0, zone: 'TL', units: [w], placements: [at(0, 0, 'w')], brains: { w: idleBrain } },
      { playerId: 'b', seat: 1, zone: 'BR', units: [w], placements: [at(0, 0, 'w')], brains: { w: idleBrain } },
    ]);
    expect(() => new BattleEngine({ players: setups, config: cfg(), seed: 1 })).toThrow(/teamId/);
  });

  it('free-for-all battles carry no team data', async () => {
    const { result } = await battle(
      [
        { playerId: 'a', seat: 0, zone: 'TL', units: [design('w', wall)], placements: [at(0, 0, 'w')], brains: { w: idleBrain } },
        { playerId: 'b', seat: 1, zone: 'BR', units: [design('w', wall)], placements: [at(0, 0, 'w')], brains: { w: idleBrain } },
      ],
      cfg({}, 4),
    );
    expect(result.teams).toBeUndefined();
    expect(result.ranking.every((r) => r.teamId === undefined)).toBe(true);
    expect(result.players.every((p) => p.teamId === undefined)).toBe(true);
  });
});

describe('auto-place on straight-facing zones (§9.2)', () => {
  it('front cells: diag keeps the diagonal bands; N/S/E/W fill the front row first', () => {
    expect(frontCells().slice(0, 3)).toEqual([{ col: 0, row: 0 }, { col: 1, row: 0 }, { col: 0, row: 1 }]);
    expect(frontCells('S').slice(0, 7)).toEqual([
      { col: 0, row: 0 }, { col: 1, row: 0 }, { col: 2, row: 0 }, { col: 3, row: 0 }, { col: 4, row: 0 }, { col: 5, row: 0 }, { col: 0, row: 1 },
    ]);
    const r = autoPlace({ available: [{ unitId: 's', cost: 92 }], caps: { budget: 1000, maxCopies: 12, maxTypes: 3 }, facing: 'W' });
    expect(r.placements.every((p) => p.row <= 1)).toBe(true);
    expect(r.placements).toHaveLength(10);
  });

  it('on a zone centred on the centre line the front row fills from the middle out', () => {
    expect(frontCells('S', true).slice(0, 7).map((c) => [c.col, c.row])).toEqual([[2, 0], [3, 0], [1, 0], [4, 0], [0, 0], [5, 0], [2, 1]]);
    const r = autoPlace({ available: [{ unitId: 's', cost: 100 }], caps: { budget: 300, maxCopies: 12, maxTypes: 3 }, facing: 'S', centred: true });
    expect(r.placements.map((p) => p.col)).toEqual([2, 3, 1]);
  });
});
