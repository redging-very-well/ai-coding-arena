// The headless battle engine (plan §9).
//
// The engine owns all game rules. It talks to player code only through the
// PlayerRunner interface (sandbox/runner.ts) and owns the sandbox POLICY:
// strike counting, disabling culprit units / whole players, and the report.
//
// Tick k (0-based) follows §9 exactly:
//   1) decrement every cooldownRemaining (not below 0), then build the views
//      from the start-of-tick state;
//   2) call every player's runner in parallel (Promise.all), then apply the
//      results in seat order, then instanceId order;
//   3) validate the actions (against the start-of-tick snapshot);
//   4) apply moves for all soldiers;
//   5) separation;
//   6) fire attacks (melee hits are queued; ranged attacks spawn projectiles);
//      firing sets cooldownRemaining = attackCooldown;
//   7) advance projectiles (including the ones just fired), then land this
//      tick's melee hits and projectile impacts together in seat, then
//      instanceId order (§9 Value destroyed);
//   8) apply sudden-death damage;
//   9) remove the dead (hp ≤ 0);
//  10) check elimination.
// After tick k the sim time is k+1; a frame is recorded whenever the time is a
// multiple of `sim.frameEveryTicks`, and always at the end.
//
// The sim "runs ahead": `run()` loops as fast as the runners allow, pushing
// frames to `frames` / `onFrame`. Playback, result release and Skip are the
// battle service's job; `stop()` ends the loop early.
//
// Maps and teams (§9.2): the arena is S×S (800 / 1040 / 1200, from
// `BattleOptions.map` or the zones), and the sudden-death radii are scaled by
// S/800. Free-for-all every player is their own side (teamId = seat); in team
// mode (every setup has a `teamId`) `allies` are all of the team's units,
// attacking a teammate idles, a team is eliminated with its last unit, the
// battle ends when ≤ 1 side has units, and sides are ranked (team living cost
// on timeout).

import {
  ARENA,
  arenaCenter,
  cellCenter,
  computeCost,
  instanceIdFor,
  scaleSuddenDeath,
  sizeOf,
  zoneCenterOf,
  type BattleReportDTO,
  type FrameDTO,
  type GameConfig,
  type MapLayout,
  type MapStyle,
  type OtherView,
  type PlayerMetricsDTO,
  type Point,
  type RankingEntryDTO,
  type SelfView,
  type WorldView,
  type ZoneRef,
} from '@pixel-clash/shared';
import {
  isUnitError,
  runnerLimitsFromConfig,
  type PlayerRunner,
  type RunnerFactory,
  type RunnerLimits,
  type RunnerUnitDesign,
  type TickInput,
  type TickResult,
} from '../sandbox/runner.js';
import { createSplitRunner, needsSplit } from '../sandbox/splitRunner.js';
import { timedOutOnceMessage } from '../sandbox/strikes.js';
import { resolveAction, type ResolvedAction } from './actions.js';
import { FrameRecorder, frameAt } from './frames.js';
import { separate, stepToward } from './movement.js';
import { deriveSeed, mulberry32, type Rng } from './prng.js';
import { applyHit, moveProjectiles, resolveHits, type PendingHit } from './projectiles.js';
import { rankResult } from './ranking.js';
import { playerMetrics, roundScoreOf, scoreRanking, sumMetrics, teamRoundRanking } from './scoring.js';
import { applySuddenDeath, safeRadiusAt } from './suddenDeath.js';
import {
  compareIds,
  type BattleEndReason,
  type BattlePlayerSetup,
  type BattleResult,
  type BattleUnitDesign,
  type CountersAtTick,
  type DisableReason,
  type PlayerIncident,
  type PlayerOutcome,
  type Projectile,
  type SimUnit,
  type UnitCounters,
  type UnitReport,
} from './types.js';

export * from './types.js';

/** Errors kept per unit in the report (a unit is disabled after 30 throws anyway). */
const MAX_ERRORS_PER_UNIT = 40;
/** Player-level incidents kept per player. */
const MAX_INCIDENTS_PER_PLAYER = 40;

// ---------------------------------------------------------------------------
// Helpers for the battle service
// ---------------------------------------------------------------------------

/**
 * Runner limits from config (§8 table). Delegates to the sandbox's own helper
 * so the two can't drift (it also carries `loadTimeoutMs`, the per-design
 * evaluation budget, which the runner otherwise defaults).
 */
export function runnerLimitsFrom(config: GameConfig): RunnerLimits {
  return runnerLimitsFromConfig(config.sandbox);
}

/**
 * Create one fresh runner per player (in parallel). The sandbox PRNG seed is
 * `battleSeed + seat` (§8). A player who fields borrowed Armory units gets a
 * split runner: each borrowed design in a sandbox of its own (§9.1). If any creation fails, the runners already made
 * are disposed and the error is rethrown.
 */
export async function createBattleRunners(
  factory: RunnerFactory,
  players: ReadonlyArray<{ playerId: string; seat: number; units: readonly RunnerUnitDesign[] }>,
  config: GameConfig,
  battleSeed: number,
): Promise<Map<string, PlayerRunner>> {
  const limits = runnerLimitsFrom(config);
  const settled = await Promise.allSettled(
    players.map((p) => {
      const player = { playerId: p.playerId, seat: p.seat, seed: battleSeed + p.seat };
      // Borrowed Armory units get sandboxes of their own (§9.1 Source).
      return needsSplit(p.units) ? createSplitRunner(factory, player, p.units, limits) : factory.create(player, p.units, limits);
    }),
  );
  const out = new Map<string, PlayerRunner>();
  let failure: unknown;
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') out.set(players[i]!.playerId, s.value);
    else failure ??= s.reason;
  });
  if (failure !== undefined) {
    for (const r of out.values()) r.dispose();
    throw failure;
  }
  return out;
}

/** A placed copy resolved to arena coordinates. */
export interface PlacedInstance {
  instanceId: string;
  unitId: string;
  x: number;
  y: number;
}

/**
 * Resolve zone-local placements to instances (`${seat}-${row}-${col}` at the
 * cell centre), sorted by instanceId. Throws on unknown units or a reused cell
 * (the round service validates placements before lock).
 */
export function buildInstances(player: Pick<BattlePlayerSetup, 'seat' | 'zone' | 'units' | 'placements'>): PlacedInstance[] {
  const known = new Set(player.units.map((u) => u.unitId));
  const seen = new Set<string>();
  const out: PlacedInstance[] = [];
  for (const p of player.placements) {
    if (!known.has(p.unitId)) throw new Error(`placement uses unit ${p.unitId} which seat ${player.seat} does not field`);
    const instanceId = instanceIdFor(player.seat, p.row, p.col);
    if (seen.has(instanceId)) throw new Error(`two placements share cell ${instanceId}`);
    seen.add(instanceId);
    const { x, y } = cellCenter(player.zone, p.col, p.row);
    out.push({ instanceId, unitId: p.unitId, x, y });
  }
  return out.sort((a, b) => compareIds(a.instanceId, b.instanceId));
}

/** Convenience for tests and bots: a design with its cost computed from config. */
export function designFor(unitId: string, stats: BattleUnitDesign['stats'], config: GameConfig): BattleUnitDesign {
  return { unitId, stats, cost: computeCost(stats, config.cost).cost };
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface BattleOptions {
  players: readonly BattlePlayerSetup[];
  /**
   * The battle's map (§9.2): arena size and style for `world`. Omitted: the
   * arena is taken from the players' map zones (800 for Corners), and the
   * style is Duel for ≤ 2 players, else Corners.
   */
  map?: Pick<MapLayout, 'style' | 'width'>;
  /** Config; `suddenDeath` radii are the 800-arena values (scaled by S/800 here). */
  config: GameConfig;
  /** Battle seed (integer). The engine's own PRNG is derived from it. */
  seed: number;
  /** Called synchronously for every recorded frame, in order. */
  onFrame?: (frame: FrameDTO) => void;
  /** Players kicked during this battle; excluded from `result.ranking` (§4). */
  kickedPlayerIds?: ReadonlySet<string>;
  /**
   * Yield to the event loop every N ticks (default 30) so a fast runner that
   * resolves synchronously can't starve HTTP/WS handling. 0 = never.
   */
  yieldEveryTicks?: number;
}

interface PlayerState {
  setup: BattlePlayerSetup;
  runner: PlayerRunner;
  /** All the player's units, sorted by instanceId (dead ones stay for reports). */
  units: SimUnit[];
  eliminatedAtTick: number | null;
  playerStrikes: number;
  /** Every hard timeout (reported); host stalls (`TickResult.hostStall`) are not counted. */
  timeouts: number;
  /** Timeouts without a culprit that can still be blamed (they count toward the player limits, §8). */
  playerTimeouts: number;
  timeoutsInARow: number;
  /** Hard timeouts blamed on each of this player's instances (via `__current`). */
  unitTimeouts: Map<string, number>;
  slowStrikes: number;
  slowUnitDisabled: boolean;
  disabled: boolean;
  disabledReason?: DisableReason;
  incidents: PlayerIncident[];
}

/** A validated action waiting for steps 4-6, in seat/instanceId order. */
interface PendingAction {
  unit: SimUnit;
  action: ResolvedAction;
}

export class BattleEngine {
  readonly frames: FrameDTO[];
  /** Arena side S (§9.2). */
  readonly arena: number;
  readonly mapStyle: MapStyle;
  /** Team mode: every setup carries a teamId. */
  readonly teamMode: boolean;
  /** The config with sudden death scaled to this arena. */
  private readonly config: GameConfig;
  private readonly center: Point;
  private readonly players: PlayerState[];
  /** Every unit, sorted by instanceId. */
  private readonly units: SimUnit[];
  private readonly byId = new Map<string, SimUnit>();
  private readonly recorder = new FrameRecorder();
  private readonly rng: Rng;
  private readonly onFrame: ((frame: FrameDTO) => void) | undefined;
  private readonly kicked: ReadonlySet<string>;
  private readonly yieldEvery: number;

  /** Per-unit counters at each frame where they changed (for `countersAt`). */
  private readonly unitCounterLog = new Map<string, Array<UnitCounters & { t: number }>>();
  /** Per-player strikes at each frame where they changed. */
  private readonly playerStrikeLog = new Map<string, Array<{ t: number; strikes: number }>>();

  /** Wall time of every completed tick in ms (sandbox calls included): the §14 "sim ms/tick" (diagnostics, load test). */
  readonly tickMs: number[] = [];

  private projectiles: Projectile[] = [];
  private nextProjectileId = 1;
  /** Completed ticks. */
  private time = 0;
  private stopRequested = false;
  private started = false;

  constructor(opts: BattleOptions) {
    this.arena = arenaOf(opts);
    this.center = arenaCenter(this.arena);
    this.mapStyle = opts.map?.style ?? (opts.players.length <= 2 ? 'duel' : 'corners');
    this.config = { ...opts.config, suddenDeath: scaleSuddenDeath(opts.config.suddenDeath, this.arena) };
    const withTeam = opts.players.filter((p) => p.teamId !== undefined).length;
    if (withTeam !== 0 && withTeam !== opts.players.length) throw new Error('give a teamId to every player or to none');
    this.teamMode = withTeam > 0;
    this.rng = mulberry32(deriveSeed(opts.seed, 0x51));
    this.onFrame = opts.onFrame;
    this.kicked = opts.kickedPlayerIds ?? new Set();
    this.yieldEvery = opts.yieldEveryTicks ?? 30;
    this.frames = this.recorder.frames;

    const seats = new Set<number>();
    const ids = new Set<string>();
    this.players = [...opts.players]
      .sort((a, b) => a.seat - b.seat)
      .map((setup) => {
        if (seats.has(setup.seat)) throw new Error(`duplicate seat ${setup.seat}`);
        if (ids.has(setup.playerId)) throw new Error(`duplicate player ${setup.playerId}`);
        seats.add(setup.seat);
        ids.add(setup.playerId);
        const designs = new Map(setup.units.map((u) => [u.unitId, u]));
        const units = buildInstances(setup).map((inst) => this.makeUnit(setup, designs.get(inst.unitId)!, inst));
        return {
          setup,
          runner: setup.runner,
          units,
          eliminatedAtTick: null,
          playerStrikes: 0,
          timeouts: 0,
          playerTimeouts: 0,
          timeoutsInARow: 0,
          unitTimeouts: new Map(),
          slowStrikes: 0,
          slowUnitDisabled: false,
          disabled: false,
          incidents: [],
        };
      });
    this.units = this.players.flatMap((p) => p.units).sort((a, b) => compareIds(a.id, b.id));
    for (const u of this.units) this.byId.set(u.id, u);
  }

  /** Completed ticks so far (the sim's lead time). */
  get currentTick(): number {
    return this.time;
  }

  /**
   * Every unit's report counters as they were at recorded frame time `t`
   * (Skip ranks and reports from the frame the players were shown, §9).
   */
  countersAt(t: number): CountersAtTick {
    const units = new Map<string, UnitCounters>();
    for (const [id, log] of this.unitCounterLog) {
      const e = lastAtOrBefore(log, t);
      if (e) units.set(id, { damageDealt: e.damageDealt, kills: e.kills, valueDestroyed: e.valueDestroyed, strikes: e.strikes, disabled: e.disabled });
    }
    const playerStrikes = new Map<string, number>();
    for (const [id, log] of this.playerStrikeLog) {
      const e = lastAtOrBefore(log, t);
      if (e) playerStrikes.set(id, e.strikes);
    }
    return { units, playerStrikes };
  }

  /**
   * Every player's scoring metrics (§9) as of the recorded frame at or before
   * `t`: damage, kills and value destroyed from the logged counters, living
   * army value from that frame's units. Skip scores from this (§9 Skip / kick).
   */
  metricsAt(t: number): PlayerMetricsDTO[] {
    const counters = this.countersAt(t);
    const frame = frameAt(this.frames, t) ?? this.frames[0];
    const alive = new Set(frame?.units.map((u) => u[0]) ?? []);
    return sumMetrics(
      this.players.map((p) => p.setup.playerId),
      this.units.map((u) => {
        const c = counters.units.get(u.id);
        return {
          playerId: u.playerId,
          cost: u.cost,
          alive: alive.has(u.id),
          damageDealt: c?.damageDealt ?? 0,
          kills: c?.kills ?? 0,
          valueDestroyed: c?.valueDestroyed ?? 0,
        };
      }),
    );
  }

  /** Ask the loop to end after the current tick (Skip). `run()` then resolves with endReason 'stopped'. */
  stop(): void {
    this.stopRequested = true;
  }

  /** Spawn everything, run until the battle ends, dispose the runners and return the result. Call once. */
  async run(): Promise<BattleResult> {
    if (this.started) throw new Error('BattleEngine.run() called twice');
    this.started = true;
    const battleTicks = this.config.timers.battleTicks;
    const frameEvery = this.config.sim.frameEveryTicks;
    let endReason: BattleEndReason = 'timeout';

    try {
      await this.spawnAll();
      this.emitFrame();

      if (this.checkElimination()) {
        endReason = 'elimination';
      } else {
        while (this.time < battleTicks) {
          if (this.stopRequested) {
            endReason = 'stopped';
            break;
          }
          const t0 = performance.now();
          await this.step(this.time);
          this.tickMs.push(performance.now() - t0);
          this.time += 1;
          const ended = this.checkElimination();
          if (ended || this.time % frameEvery === 0 || this.time === battleTicks) this.emitFrame();
          if (ended) {
            endReason = 'elimination';
            break;
          }
          if (this.yieldEvery > 0 && this.time % this.yieldEvery === 0) {
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
        }
      }
      // A stop between frames still ends on a frame of the final state.
      if (this.frames[this.frames.length - 1]?.t !== this.time) this.emitFrame();
    } finally {
      for (const p of this.players) p.runner.dispose();
    }
    return this.buildResult(endReason);
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  private makeUnit(setup: BattlePlayerSetup, design: BattleUnitDesign, inst: PlacedInstance): SimUnit {
    const s = design.stats;
    const center = this.center;
    return {
      id: inst.instanceId,
      playerId: setup.playerId,
      seat: setup.seat,
      teamId: setup.teamId ?? setup.seat,
      unitId: design.unitId,
      stats: s,
      cost: design.cost,
      type: s.type,
      radius: sizeOf(s), // the size stat (§9 Radii); type default if a snapshot lacks it
      x: inst.x,
      y: inst.y,
      hp: s.maxHealth,
      maxHp: s.maxHealth,
      cooldownRemaining: 0, // every unit can fire on tick 0 (§5 rule 4)
      alive: true,
      disabled: false,
      spawned: false,
      movedSinceFrame: false,
      firedSinceFrame: false,
      // Sprites are drawn facing right: start facing the arena centre, in
      // SCREEN space (iso screenX ∝ x − y, §12; ties by arena x).
      facingLeft: screenX(inst) > screenX(center) || (screenX(inst) === screenX(center) && inst.x > center.x),
      outsideSafeZone: false,
      damageDealt: 0,
      kills: 0,
      valueDestroyed: 0,
      strikes: 0,
      errors: [],
      diedAtTick: null,
    };
  }

  private async spawnAll(): Promise<void> {
    await Promise.all(
      this.players.map(async (p) => {
        for (const u of p.units) {
          let res;
          try {
            res = await p.runner.spawn(u.id, u.unitId);
          } catch (err) {
            res = { ok: false as const, error: { message: err instanceof Error ? err.message : String(err) } };
          }
          if (res.ok) {
            u.spawned = true;
          } else {
            this.recordUnitError(u, 0, res.error.message, res.error.line);
          }
        }
      }),
    );
    // Events are emitted in instanceId order regardless of spawn timing.
    for (const u of this.units) {
      this.recorder.event({ type: 'spawn', instanceId: u.id });
      if (!u.spawned) this.disableUnit(u, 'spawn-failed');
    }
  }

  // -------------------------------------------------------------------------
  // One tick
  // -------------------------------------------------------------------------

  private async step(tick: number): Promise<void> {
    const cfg = this.config;

    // 1) Cooldowns, then views from the start-of-tick state.
    const living = this.living();
    for (const u of living) {
      if (u.cooldownRemaining > 0) u.cooldownRemaining -= 1;
    }
    const others = living.map(toOtherView);
    const safeRadius = safeRadiusAt(tick, cfg);
    // enemies/allies are built once per side and shared by its players, so
    // the sandbox serialises them once per side (§9.2 Performance).
    const sideViews = new Map<number, { enemies: OtherView[]; allies: OtherView[] }>();
    const inputs = this.players.map((p) => this.buildInput(p, tick, living, others, safeRadius, sideViews));

    // 2) All runners in parallel; results applied in seat order below.
    const results = await Promise.all(
      this.players.map((p, i) => {
        const input = inputs[i];
        return input ? safeTick(p.runner, input) : Promise.resolve(undefined);
      }),
    );

    // 3) Apply sandbox results (policy) and validate actions, seat then instanceId order.
    const pending: PendingAction[] = [];
    this.players.forEach((p, i) => {
      const input = inputs[i];
      const res = results[i];
      if (!input || !res) return;
      const raw = this.applyTickResult(p, input, res, tick);
      for (const self of input.selves) {
        if (!raw.has(self.id)) continue;
        const unit = this.byId.get(self.id)!;
        const action = resolveAction(raw.get(self.id), unit, (id) => this.byId.get(id), cfg.sim.rangeTolerance, this.arena);
        if (action.kind !== 'idle') pending.push({ unit, action });
      }
    });

    // 4) Moves (soldiers only; towers were turned into idle in step 3).
    for (const { unit, action } of pending) {
      if (action.kind !== 'move') continue;
      const sx0 = screenX(unit);
      // Sticky until the next frame is recorded (cleared in FrameRecorder.record).
      if (stepToward(unit, action.destination, unit.stats.speed, this.arena)) unit.movedSinceFrame = true;
      const sx1 = screenX(unit);
      if (sx1 < sx0) unit.facingLeft = true;
      else if (sx1 > sx0) unit.facingLeft = false;
    }

    // 5) Separation.
    separate(living, cfg.sim.separationPasses, this.rng, this.arena);

    // 6) Fire attacks. Melee hits are queued and land in step 7 together with
    //    the projectile impacts, so the first hit in seat, then instanceId
    //    order to take a target to ≤ 0 hp gets the kill (§9 Value destroyed).
    const hits: PendingHit[] = [];
    for (const { unit, action } of pending) {
      if (action.kind !== 'attack') continue;
      const target = this.byId.get(action.targetId)!;
      const melee = unit.stats.range <= cfg.sim.meleeMaxRange;
      unit.cooldownRemaining = unit.stats.attackCooldown;
      unit.firedSinceFrame = true;
      if (screenX(target) < screenX(unit)) unit.facingLeft = true;
      else if (screenX(target) > screenX(unit)) unit.facingLeft = false;
      this.recorder.event({ type: 'fire', instanceId: unit.id, targetId: target.id, melee });
      if (melee) {
        hits.push({ attackerId: unit.id, target, damage: unit.stats.damage });
      } else {
        this.projectiles.push({
          id: this.nextProjectileId++,
          x: unit.x,
          y: unit.y,
          ownerId: unit.id,
          targetId: target.id,
          damage: unit.stats.damage,
        });
      }
    }

    // 7) Projectiles move; then every hit of this tick (melee and impacts)
    //    lands in attacker order: seat, then instanceId, then projectile id.
    const moved = moveProjectiles(this.projectiles, (id) => this.byId.get(id), cfg.sim.projectileSpeed);
    this.projectiles = moved.remaining;
    resolveHits([...hits, ...moved.arrived], (h) => {
      const hit = applyHit(this.byId.get(h.attackerId), h.target, h.damage);
      this.recorder.event({ type: 'hit', instanceId: h.attackerId, targetId: h.target.id, damage: hit.dealt });
    });

    // 8) Sudden death (credits nobody: no damage, kills or value).
    applySuddenDeath(living, tick, cfg, this.center);

    // 9) Remove the dead.
    for (const u of living) {
      if (u.hp <= 0) {
        u.alive = false;
        u.hp = 0;
        u.diedAtTick = tick + 1;
        this.recorder.event({ type: 'death', instanceId: u.id });
      }
    }
    // Shots at units that just died vanish.
    this.projectiles = this.projectiles.filter((p) => this.byId.get(p.targetId)?.alive);
    // 10) Elimination is checked by the loop (it also decides the frame).
  }

  /** The TickInput for one player, or undefined if none of its units can act. */
  private buildInput(
    p: PlayerState,
    tick: number,
    living: readonly SimUnit[],
    others: readonly OtherView[],
    safeRadius: number,
    sideViews: Map<number, { enemies: OtherView[]; allies: OtherView[] }>,
  ): TickInput | undefined {
    if (p.disabled || p.runner.disposed) return undefined;
    const selves = living.filter((u) => u.playerId === p.setup.playerId && !u.disabled).map(toSelfView);
    if (selves.length === 0) return undefined;
    const corner = zoneCenterOf(p.setup.zone);
    const { x: cx, y: cy } = this.center;
    const world: WorldView = {
      width: this.arena,
      height: this.arena,
      tick,
      ticksLeft: this.config.timers.battleTicks - tick,
      mapStyle: this.mapStyle,
      myCorner: { x: corner.x, y: corner.y },
      center: { x: cx, y: cy },
      safeZone: { x: cx, y: cy, radius: safeRadius },
    };
    // Same teamId = friend (own units and, in team mode, every teammate's), else enemy.
    const teamId = p.setup.teamId ?? p.setup.seat;
    let views = sideViews.get(teamId);
    if (!views) {
      views = { enemies: others.filter((o) => o.teamId !== teamId), allies: others.filter((o) => o.teamId === teamId) };
      sideViews.set(teamId, views);
    }
    return {
      tick,
      nowMs: (tick * 1000) / this.config.timers.ticksPerSecond,
      selves,
      enemies: views.enemies,
      allies: views.allies,
      world,
    };
  }

  // -------------------------------------------------------------------------
  // Sandbox policy (§8 Deadlines, strikes, disable)
  // -------------------------------------------------------------------------

  /**
   * Record what the runner reported and return the raw actions to validate
   * (instanceId → action). Units with an error or no entry idle.
   */
  private applyTickResult(p: PlayerState, input: TickInput, res: TickResult, tick: number): Map<string, unknown> {
    const limits = this.config.sandbox.battle;
    const actions = new Map<string, unknown>();

    if (res.status === 'crashed') {
      this.incident(p, tick, 'crashed', `The sandbox crashed${res.detail ? `: ${res.detail}` : ''}.`);
      this.disablePlayer(p, 'crashed');
      return actions;
    }

    if (res.status === 'timeout' && res.hostStall) {
      // The sandbox process was frozen (OS / VM scheduler) for most of the
      // tick: the units idle, but it's not the player's code, so no strike and
      // no timeout count (§8).
      this.incident(p, tick, 'timeout', 'The game computer paused for a moment (not your code); all units idled this tick.');
      return actions;
    }

    if (res.status === 'timeout') {
      p.timeouts += 1;
      const culprit = res.culprit !== undefined ? this.byId.get(res.culprit) : undefined;
      if (culprit && culprit.playerId === p.setup.playerId && !culprit.disabled && culprit.alive) {
        // One stall can be the host (GC, scheduler), not the player's code: the
        // first timeout only idles this tick and is reported; a repeat naps.
        // A culprit's own timeouts (forgiven or disabling) don't count toward
        // the player limits, which are for timeouts that CONTINUE after the
        // culprit naps (§8). Otherwise 2 copies of one looping design (A, A,
        // then B) would disable the whole player, healthy units included.
        const timeouts = (p.unitTimeouts.get(culprit.id) ?? 0) + 1;
        p.unitTimeouts.set(culprit.id, timeouts);
        culprit.strikes += 1;
        if (timeouts >= limits.timeoutsToDisable) {
          const again = timeouts > 1 ? ' again' : '';
          this.recordUnitError(
            culprit,
            tick,
            `${culprit.stats.name} took too long${again} (update() over ${limits.hardTimeoutMs} ms, endless loop?) and is taking a nap 💤`,
          );
          this.disableUnit(culprit, 'timeout');
        } else {
          this.recordUnitError(
            culprit,
            tick,
            `${timedOutOnceMessage(culprit.stats.name)}: update() took over ${limits.hardTimeoutMs} ms and was stopped; all units idled this tick.`,
          );
          if (culprit.strikes >= limits.unitStrikeLimit) this.disableUnit(culprit, 'errors');
        }
      } else {
        this.incident(p, tick, 'timeout', `A tick took too long (over ${limits.hardTimeoutMs} ms); all units idled.`);
        p.timeoutsInARow += 1;
        p.playerTimeouts += 1;
        if (p.timeoutsInARow >= limits.timeoutsInARowLimit || p.playerTimeouts >= limits.timeoutsTotalLimit) {
          this.disablePlayer(p, 'player-timeouts');
        }
      }
      return actions;
    }
    p.timeoutsInARow = 0;

    if (res.status === 'bad-output') {
      this.playerStrike(p, tick, 'bad-output', `The sandbox returned unreadable output${res.detail ? ` (${res.detail})` : ''}; all units idled.`);
      return actions;
    }

    // status 'ok'
    if (res.forged > 0) {
      this.playerStrike(p, tick, 'forged', `${res.forged} action(s) for units this player doesn't control were ignored.`);
    }

    const acting = new Set(input.selves.map((s) => s.id));
    const outputs = [...res.outputs].sort((a, b) => compareIds(a.instanceId, b.instanceId));
    for (const out of outputs) {
      // Defensive: the runner already filters, but never trust it with policy.
      if (!acting.has(out.instanceId) || actions.has(out.instanceId)) continue;
      const unit = this.byId.get(out.instanceId)!;
      if (unit.disabled) continue;
      if (isUnitError(out)) {
        unit.strikes += 1;
        this.recordUnitError(unit, tick, out.error.message, out.error.line);
        actions.set(out.instanceId, undefined); // idle
        if (unit.strikes >= limits.unitStrikeLimit) this.disableUnit(unit, 'errors');
      } else {
        actions.set(out.instanceId, out.action);
      }
    }

    if (res.slow) this.slowStrike(p, res, tick, acting);
    return actions;
  }

  private slowStrike(p: PlayerState, res: TickResult, tick: number, acting: ReadonlySet<string>): void {
    const limits = this.config.sandbox.battle;
    p.slowStrikes += 1;
    if (p.slowStrikes < limits.slowStrikeLimit) return;
    const slowest = res.slowestInstanceId !== undefined && acting.has(res.slowestInstanceId)
      ? this.byId.get(res.slowestInstanceId)
      : undefined;
    if (!p.slowUnitDisabled && slowest && !slowest.disabled) {
      // First time: nap the slowest unit and give the player a fresh count.
      this.recordUnitError(slowest, tick, `update() was too slow (over ${limits.softTimeoutMs} ms) too many times.`);
      this.disableUnit(slowest, 'slow');
      p.slowUnitDisabled = true;
      p.slowStrikes = 0;
    } else {
      this.incident(p, tick, 'slow', `Ticks kept taking longer than ${limits.softTimeoutMs} ms.`);
      this.disablePlayer(p, 'player-slow');
    }
  }

  private playerStrike(p: PlayerState, tick: number, kind: PlayerIncident['kind'], message: string): void {
    p.playerStrikes += 1;
    this.incident(p, tick, kind, message);
    if (p.playerStrikes >= this.config.sandbox.battle.unitStrikeLimit) this.disablePlayer(p, 'player-strikes');
  }

  private incident(p: PlayerState, tick: number, kind: PlayerIncident['kind'], message: string): void {
    if (p.incidents.length < MAX_INCIDENTS_PER_PLAYER) p.incidents.push({ tick, kind, message });
  }

  private recordUnitError(u: SimUnit, tick: number, message: string, line?: number): void {
    if (u.errors.length >= MAX_ERRORS_PER_UNIT) return;
    u.errors.push(line === undefined ? { tick, message } : { tick, message, line });
  }

  private disableUnit(u: SimUnit, reason: DisableReason): void {
    if (u.disabled) return;
    u.disabled = true;
    u.disabledReason = reason;
    if (u.alive) this.recorder.event({ type: 'disable', instanceId: u.id, reason });
  }

  /** All of the player's units stop acting for the rest of the battle. */
  private disablePlayer(p: PlayerState, reason: DisableReason): void {
    if (p.disabled) return;
    p.disabled = true;
    p.disabledReason = reason;
    this.incident(p, this.time, 'disabled', `All units were disabled for this battle (${reason}).`);
    for (const u of p.units) this.disableUnit(u, reason);
    p.runner.dispose();
  }

  // -------------------------------------------------------------------------
  // Bookkeeping
  // -------------------------------------------------------------------------

  private living(): SimUnit[] {
    return this.units.filter((u) => u.alive);
  }

  /**
   * Step 10: mark newly eliminated players. Returns true when ≤ 1 side (a
   * free-for-all player, or a team) has living units.
   */
  private checkElimination(): boolean {
    const sidesWithUnits = new Set<number>();
    for (const p of this.players) {
      const alive = p.units.some((u) => u.alive);
      if (alive) sidesWithUnits.add(p.setup.teamId ?? p.setup.seat);
      else if (p.eliminatedAtTick === null) p.eliminatedAtTick = this.time;
    }
    return sidesWithUnits.size <= 1;
  }

  private emitFrame(): void {
    const frame = this.recorder.record(this.time, this.living(), this.projectiles, safeRadiusAt(this.time, this.config));
    this.logCounters(frame.t);
    this.onFrame?.(frame);
  }

  /** Append the counters that changed since the last frame. */
  private logCounters(t: number): void {
    for (const u of this.units) {
      const log = this.unitCounterLog.get(u.id);
      const last = log?.[log.length - 1] ?? { damageDealt: 0, kills: 0, valueDestroyed: 0, strikes: 0, disabled: false };
      const same =
        last.damageDealt === u.damageDealt &&
        last.kills === u.kills &&
        last.valueDestroyed === u.valueDestroyed &&
        last.strikes === u.strikes &&
        last.disabled === u.disabled;
      if (same) continue;
      const entry = { t, damageDealt: u.damageDealt, kills: u.kills, valueDestroyed: u.valueDestroyed, strikes: u.strikes, disabled: u.disabled };
      if (log) log.push(entry);
      else this.unitCounterLog.set(u.id, [entry]);
    }
    for (const p of this.players) {
      const id = p.setup.playerId;
      const log = this.playerStrikeLog.get(id);
      const last = log?.[log.length - 1];
      if ((last?.strikes ?? 0) === p.playerStrikes) continue;
      const entry = { t, strikes: p.playerStrikes };
      if (log) log.push(entry);
      else this.playerStrikeLog.set(id, [entry]);
    }
  }

  private buildResult(endReason: BattleEndReason): BattleResult {
    const players: PlayerOutcome[] = this.players.map((p) => {
      const living = p.units.filter((u) => u.alive);
      const out: PlayerOutcome = {
        playerId: p.setup.playerId,
        seat: p.setup.seat,
        zone: p.setup.zone,
        ...(p.setup.teamId !== undefined ? { teamId: p.setup.teamId } : {}),
        eliminatedAtTick: living.length > 0 ? null : p.eliminatedAtTick ?? this.time,
        livingCost: living.reduce((sum, u) => sum + u.cost, 0),
        livingUnits: living.length,
        playerStrikes: p.playerStrikes,
        timeouts: p.timeouts,
        slowStrikes: p.slowStrikes,
        disabled: p.disabled,
        incidents: p.incidents,
      };
      if (p.disabledReason) out.disabledReason = p.disabledReason;
      return out;
    });
    const units: UnitReport[] = this.units.map((u) => {
      const r: UnitReport = {
        instanceId: u.id,
        playerId: u.playerId,
        unitId: u.unitId,
        unitName: u.stats.name,
        cost: u.cost,
        survived: u.alive,
        hp: u.hp,
        diedAtTick: u.diedAtTick,
        damageDealt: u.damageDealt,
        kills: u.kills,
        valueDestroyed: u.valueDestroyed,
        strikes: u.strikes,
        disabled: u.disabled,
        errors: u.errors,
      };
      if (u.disabledReason) r.disabledReason = u.disabledReason;
      return r;
    });
    const result: BattleResult = { endTick: this.time, endReason, players, units, ranking: [] };
    result.ranking = scoreRanking(rankResult(result, this.kicked), playerMetrics(result), this.config.scoring);
    if (this.teamMode) result.teams = teamRoundRanking(result.ranking);
    return result;
  }
}

/** Run a whole battle. The result also carries the recorded frames. */
export async function runBattle(opts: BattleOptions): Promise<BattleResult & { frames: FrameDTO[] }> {
  const engine = new BattleEngine(opts);
  const result = await engine.run();
  return { ...result, frames: engine.frames };
}

/** Arena side S: the map's, else the players' map zones' (all must agree), else 800. */
function arenaOf(opts: BattleOptions): number {
  const sizes = new Set(opts.players.map((p) => zoneArena(p.zone)));
  if (opts.map) sizes.add(opts.map.width);
  if (sizes.size > 1) throw new Error(`players' zones and the map disagree on the arena size (${[...sizes].join(', ')})`);
  return [...sizes][0] ?? ARENA.width;
}

function zoneArena(zone: ZoneRef): number {
  return typeof zone === 'string' ? ARENA.width : zone.arena;
}

/**
 * Horizontal screen position in the isometric view, up to scale (§12:
 * screenX = (x − y)·k). Sprite facing (FACING_LEFT) is decided on this axis.
 */
function screenX(p: { x: number; y: number }): number {
  return p.x - p.y;
}

/** The last entry with `t` ≤ `tick` in a list sorted by `t`. */
function lastAtOrBefore<T extends { t: number }>(list: readonly T[], tick: number): T | undefined {
  let lo = 0;
  let hi = list.length - 1;
  let found: T | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.t <= tick) {
      found = list[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Reports (§10.3)
// ---------------------------------------------------------------------------

/**
 * Skip (§9): the result as of recorded frame `endTick` (the frame the players were
 * shown): survival and living cost from that frame's living units, counters
 * from `counters`, and only the errors and incidents up to that tick. Ranking
 * is left as is (the caller ranks and scores from the frame).
 */
export function resultAtTick(result: BattleResult, counters: CountersAtTick, aliveAtEnd: ReadonlySet<string>, endTick: number): BattleResult {
  const zero: UnitCounters = { damageDealt: 0, kills: 0, valueDestroyed: 0, strikes: 0, disabled: false };
  const living = new Map<string, { cost: number; count: number }>();
  for (const u of result.units) {
    if (!aliveAtEnd.has(u.instanceId)) continue;
    const l = living.get(u.playerId) ?? { cost: 0, count: 0 };
    l.cost += u.cost;
    l.count += 1;
    living.set(u.playerId, l);
  }
  return {
    ...result,
    endTick,
    players: result.players.map((p) => ({
      ...p,
      livingCost: living.get(p.playerId)?.cost ?? 0,
      livingUnits: living.get(p.playerId)?.count ?? 0,
      playerStrikes: counters.playerStrikes.get(p.playerId) ?? 0,
      incidents: p.incidents.filter((i) => i.tick <= endTick),
    })),
    units: result.units.map((u) => {
      const c = counters.units.get(u.instanceId) ?? zero;
      const r: UnitReport = {
        ...u,
        survived: aliveAtEnd.has(u.instanceId),
        damageDealt: c.damageDealt,
        kills: c.kills,
        valueDestroyed: c.valueDestroyed,
        strikes: c.strikes,
        disabled: c.disabled,
        errors: u.errors.filter((e) => e.tick <= endTick),
      };
      if (!c.disabled) delete r.disabledReason;
      return r;
    }),
  };
}

/**
 * One player's battle report: totals over their units plus every recorded
 * error. Player-level incidents (no single culprit) are listed with an empty
 * unitId/instanceId and unitName "(all units)". The round score comes from
 * `ranking` (default: the result's own); null when the player wasn't ranked.
 */
export function buildBattleReport(
  result: BattleResult,
  playerId: string,
  round: number,
  ranking: readonly RankingEntryDTO[] = result.ranking,
): BattleReportDTO {
  const units = result.units.filter((u) => u.playerId === playerId);
  const player = result.players.find((p) => p.playerId === playerId);
  const errors: BattleReportDTO['errors'] = [];
  for (const u of units) {
    for (const e of u.errors) {
      errors.push({ unitId: u.unitId, instanceId: u.instanceId, unitName: u.unitName, tick: e.tick, message: e.message, ...(e.line !== undefined ? { line: e.line } : {}) });
    }
  }
  for (const inc of player?.incidents ?? []) {
    errors.push({ unitId: '', instanceId: '', unitName: '(all units)', tick: inc.tick, message: inc.message });
  }
  errors.sort((a, b) => a.tick - b.tick || compareIds(a.instanceId, b.instanceId));
  const entry = ranking.find((r) => r.playerId === playerId);
  return {
    round,
    survived: units.filter((u) => u.survived).length,
    damageDealt: Math.round(units.reduce((s, u) => s + u.damageDealt, 0)),
    kills: units.reduce((s, u) => s + u.kills, 0),
    valueDestroyed: units.reduce((s, u) => s + u.valueDestroyed, 0),
    livingValue: units.filter((u) => u.survived).reduce((s, u) => s + u.cost, 0),
    score: entry ? roundScoreOf(entry) : null,
    strikes: units.reduce((s, u) => s + u.strikes, 0) + (player?.playerStrikes ?? 0),
    disabled: units.filter((u) => u.disabled).length,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Views and runner safety
// ---------------------------------------------------------------------------

function toOtherView(u: SimUnit): OtherView {
  return {
    id: u.id,
    ownerId: u.playerId,
    teamId: u.teamId, // free-for-all: the seat; team mode: the team (§5, §9.2)
    type: u.type,
    name: u.stats.name,
    x: u.x,
    y: u.y,
    radius: u.radius,
    hp: u.hp,
    maxHp: u.maxHp,
    range: u.stats.range,
  };
}

function toSelfView(u: SimUnit): SelfView {
  return {
    id: u.id,
    unitId: u.unitId,
    ownerId: u.playerId,
    teamId: u.teamId, // free-for-all: the seat; team mode: the team (§5, §9.2)
    type: u.type,
    name: u.stats.name,
    x: u.x,
    y: u.y,
    radius: u.radius,
    hp: u.hp,
    maxHp: u.maxHp,
    damage: u.stats.damage,
    range: u.stats.range,
    speed: u.stats.speed,
    attackCooldown: u.stats.attackCooldown,
    cooldownRemaining: u.cooldownRemaining,
  };
}

/** tick() must never reject; if a runner breaks that promise, treat it as a crash. */
async function safeTick(runner: PlayerRunner, input: TickInput): Promise<TickResult> {
  try {
    return await runner.tick(input);
  } catch (err) {
    return {
      status: 'crashed',
      outputs: [],
      elapsedMs: 0,
      slow: false,
      forged: 0,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
