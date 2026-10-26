// The headless battle engine.
//
// The engine owns all game rules. It talks to player code only through the
// PlayerRunner interface (sandbox/runner.ts) and owns the sandbox POLICY:
// strike counting, disabling culprit units / whole players, and the report.
//
// Tick k (0-based):
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
//      instanceId order;
//   8) apply sudden-death damage; 8b) with factory.dieAtSuddenDeath every
//      factory is destroyed on the first sudden-death tick;
//   9) remove the dead (hp ≤ 0); 9a) with factory.minionsDieWithFactory, the
//      living minions of each factory removed in 9 that are within
//      factory.crumbleRadius of it crumble (credited to its killer);
//  10) check elimination.
// After tick k the sim time is k+1; a frame is recorded whenever the time is a
// multiple of `sim.frameEveryTicks`, and always at the end.
//
// The sim "runs ahead": `run()` loops as fast as the runners allow, pushing
// frames to `frames` / `onFrame`. Playback, result release and Skip are the
// battle service's job; `stop()` ends the loop early.
//
// Maps and teams: the arena is S×S (800 / 1040 / 1200, from
// `BattleOptions.map` or the zones), and the sudden-death radii are scaled by
// S/800. Free-for-all every player is their own side (teamId = seat); in team
// mode (every setup has a `teamId`) `allies` are all of the team's units,
// attacking a teammate idles, a team is eliminated with its last unit, the
// battle ends when ≤ 1 side has units, and sides are ranked (team living cost
// on timeout).
//
// Walls, factories and minions (M8.5): walls never run code (no spawn,
// no update) and live in a wall grid; soldiers and minions steer round them
// (step 4, sim/steering.ts) and separation ends with a wall push (step 5);
// minions decide in step 2 from the same snapshot (sim/minion.ts); factories
// accept rally/hold in step 3 and produce after the dead are removed (step
// 9b, sim/factory.ts); elimination (step 10) counts fighters only, and an
// eliminated side's walls and spent factories crumble.
//
// Minion kinds, squad orders and burst (M8.6): factories accept
// `command`/`release` in step 3, swarm/guard orders whose target died fall
// back in step 1, minion hits on walls are multiplied per kind in step 6,
// and step 9b stores minions inside until a burst is complete.
//
// Elements, splash and support (M8.8): step 1 lowers cooldowns (a
// float) and the factory timers by each body's tempo (×0.65 frozen, ×(1 +
// haste%) hasted), resets the heal room every 60 ticks and computes the
// auras; step 3 accepts `heal`; step 4 moves at speed × tempo (the router's
// re-plan and blocked checks use that step, so a frozen unit is never
// "blocked") and then counts the freeze down; step 6 bakes might into each shot and
// queues heals; step 7 lands hits through the element and splash pipeline
// (sim/effects.ts, lightning draws from its own `elementRng`), then 7b applies
// the queued heals and 7c the due burn pulses; step 10 doesn't count
// damage-0 units, medic minions or medic factories as fighters.

import {
  ARENA,
  arenaCenter,
  burstOf,
  cellCenter,
  computeCost,
  elementOf,
  instanceIdFor,
  minionElementOf,
  pricingOf,
  producesOf,
  runsCode,
  productionEndTick,
  scaleSuddenDeath,
  sizeOf,
  splashOf,
  supportOf,
  zoneCenterOf,
  type Action,
  type DamageSplitDTO,
  type FactoryView,
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
  type UnitType,
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
import { BodyIndex, HitPipeline, emptySplit, noAura, statusOf, tempoOf } from './effects.js';
import { alivePerPlayerCap, canMakeOf, spawnSpots, zoneFacingDir } from './factory.js';
import { FrameRecorder, frameAt } from './frames.js';
import { hitDamage, kindConfig, kindOf, minionAction, minionStats, minionValueOf, withinCrumbleRadius } from './minion.js';
import { isFixedBody, separate } from './movement.js';
import { Pathfinder } from './pathing.js';
import { aliveInFrame, canFight, factoryLeftIn, isFighter, killValueOf, livingValueAt, livingValueOf } from './value.js';
import { applyHeals, computeAuras, freshHealRoom, resetHealRoom, type QueuedHeal } from './support.js';
import { WallGrid } from './walls.js';
import { BuildingGrid, isRoutingBuilding } from './buildings.js';
import { deriveSeed, mulberry32, type Rng } from './prng.js';
import { moveProjectiles, resolveHits, type PendingHit } from './projectiles.js';
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
 * Runner limits from config. Delegates to the sandbox's own helper
 * so the two can't drift (it also carries `loadTimeoutMs`, the per-design
 * evaluation budget, which the runner otherwise defaults).
 */
export function runnerLimitsFrom(config: GameConfig): RunnerLimits {
  return runnerLimitsFromConfig(config.sandbox);
}

/**
 * Create one fresh runner per player (in parallel). The sandbox PRNG seed is
 * `battleSeed + seat`. A player who fields borrowed Armory units gets a
 * split runner: each borrowed design in a sandbox of its own. If any creation fails, the runners already made
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
      // Walls have no code: they are never loaded into a sandbox.
      const units = p.units.filter((u) => runsCode(u.stats.type));
      // Borrowed Armory units get sandboxes of their own.
      return needsSplit(units) ? createSplitRunner(factory, player, units, limits) : factory.create(player, units, limits);
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
  return { unitId, stats, cost: computeCost(stats, config.cost, pricingOf(config)).cost };
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface BattleOptions {
  players: readonly BattlePlayerSetup[];
  /**
   * The battle's map: arena size and style for `world`. Omitted: the
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
  /**
   * The match setting "Show enemy names to units": every OtherView
   * also carries `ownerName` (and `teamName` in team mode) and `world.players`
   * lists the battle's players. Off/omitted: the views are exactly as before.
   */
  revealNames?: boolean;
  /** Players kicked during this battle; excluded from `result.ranking`. */
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
  /** Timeouts without a culprit that can still be blamed (they count toward the player limits). */
  playerTimeouts: number;
  timeoutsInARow: number;
  /** Hard timeouts blamed on each of this player's instances (via `__current`). */
  unitTimeouts: Map<string, number>;
  /**
   * The unit the last host-stall timeout named, until the next tick result: if
   * it then times out on its own, the stall was its first timeout.
   */
  stallSuspect?: string;
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
  /** Arena side S. */
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
  /** M8.8: the lightning stream, drawn once per lightning main hit (the separation rng is untouched). */
  private readonly elementRng: Rng;
  /** Redesign: drawn once per ranged shot at a moving target (other streams untouched). */
  private readonly accuracyRng: Rng;
  private readonly onFrame: ((frame: FrameDTO) => void) | undefined;
  private readonly kicked: ReadonlySet<string>;
  private readonly yieldEvery: number;
  /** Living walls by arena cell. */
  private readonly walls: WallGrid;
  /** Living towers and factories by arena cell (redesign: solid for routing). */
  private readonly buildings: BuildingGrid;
  /** Routing round walls: flow fields and plans (M8.7). */
  private readonly paths: Pathfinder;
  /** What a factory pays per minion; a minion's value. */
  private readonly minionValue: number;
  /** Alive minions allowed per player. */
  private readonly minionCapPerPlayer: number;
  /** revealNames: playerId → the names its bodies carry; null = off (views unchanged). */
  private readonly ownerNames: ReadonlyMap<string, OwnerNames> | null;
  /** revealNames: `world.players`, built once per battle and shared by every world view. */
  private readonly worldPlayers: NonNullable<WorldView['players']> | undefined;

  /** Per-unit counters at each frame where they changed (for `countersAt`). */
  private readonly unitCounterLog = new Map<string, Array<UnitCounters & { t: number }>>();
  /** Per-player strikes at each frame where they changed. */
  private readonly playerStrikeLog = new Map<string, Array<{ t: number; strikes: number }>>();

  /** Wall time of every completed tick in ms (sandbox calls included): the "sim ms/tick" (diagnostics, load test). */
  readonly tickMs: number[] = [];
  /**
   * Of each tick's `tickMs`, the wall time spent waiting for the players'
   * sandboxes (their update() calls, IPC and the OS scheduling the sandbox
   * processes). `tickMs[i] - tickWaitMs[i]` is the engine's own work.
   */
  readonly tickWaitMs: number[] = [];

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
    this.elementRng = mulberry32(deriveSeed(opts.seed, 0xe1e));
    this.accuracyRng = mulberry32(deriveSeed(opts.seed, 0xacc));
    this.onFrame = opts.onFrame;
    this.kicked = opts.kickedPlayerIds ?? new Set();
    this.yieldEvery = opts.yieldEveryTicks ?? 30;
    this.frames = this.recorder.frames;
    this.walls = new WallGrid(this.arena);
    this.buildings = new BuildingGrid(this.arena);
    this.paths = new Pathfinder(this.walls, this.arena, this.center, {
      buildings: this.buildings,
      replanTicks: this.config.sim.replanTicks,
      slideMemoryTicks: this.config.sim.slideMemoryTicks,
    });
    this.minionValue = minionValueOf(opts.config);
    this.minionCapPerPlayer = alivePerPlayerCap(opts.config.factory, opts.players.length);

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
    if (opts.revealNames === true) {
      const names = new Map<string, OwnerNames>();
      const list: NonNullable<WorldView['players']> = [];
      for (const p of this.players) {
        const s = p.setup;
        const ownerName = s.name ?? s.playerId;
        const teamName = this.teamMode && s.teamName !== undefined ? s.teamName : undefined;
        names.set(s.playerId, teamName !== undefined ? { ownerName, teamName } : { ownerName });
        list.push({ id: s.playerId, name: ownerName, teamId: s.teamId ?? s.seat, ...(teamName !== undefined ? { teamName } : {}) });
      }
      this.ownerNames = names;
      this.worldPlayers = list;
    } else {
      this.ownerNames = null;
      this.worldPlayers = undefined;
    }
    for (const u of this.units) {
      this.byId.set(u.id, u);
      if (u.type === 'wall') this.walls.add(u);
      else if (isRoutingBuilding(u) && this.config.sim.routeRoundBuildings) this.buildings.add(u);
    }
  }

  /** Routing counters: plans made, flow fields built, cache hits (tests). */
  get pathStats(): Readonly<{ plans: number; built: number; hits: number }> {
    return this.paths.stats;
  }

  /** Completed ticks so far (the sim's lead time). */
  get currentTick(): number {
    return this.time;
  }

  /**
   * Every unit's report counters as they were at recorded frame time `t`
   * (Skip ranks and reports from the frame the players were shown).
   */
  countersAt(t: number): CountersAtTick {
    const units = new Map<string, UnitCounters>();
    for (const [id, log] of this.unitCounterLog) {
      const e = lastAtOrBefore(log, t);
      if (e) {
        units.set(id, {
          damageDealt: e.damageDealt,
          kills: e.kills,
          valueDestroyed: e.valueDestroyed,
          strikes: e.strikes,
          disabled: e.disabled,
          ...(e.healing ? { healing: e.healing } : {}),
          ...(e.combos ? { combos: e.combos } : {}),
          ...(e.cleanses ? { cleanses: e.cleanses } : {}),
          ...(e.assist ? { assist: e.assist } : {}),
          ...(e.damageSplit ? { damageSplit: { ...e.damageSplit } } : {}),
        });
      }
    }
    const playerStrikes = new Map<string, number>();
    for (const [id, log] of this.playerStrikeLog) {
      const e = lastAtOrBefore(log, t);
      if (e) playerStrikes.set(id, e.strikes);
    }
    return { units, playerStrikes };
  }

  /**
   * Every player's scoring metrics as of the recorded frame at or before
   * `t`: damage, kills and value destroyed from the logged counters, living
   * army value from that frame's units. Skip scores from this.
   */
  metricsAt(t: number): PlayerMetricsDTO[] {
    const counters = this.countersAt(t);
    const frame = frameAt(this.frames, t) ?? this.frames[0];
    const listed = new Set(frame?.units.map((u) => u[0]) ?? []);
    const left = frame ? factoryLeftIn(frame) : new Map<string, number>();
    return sumMetrics(
      this.players.map((p) => p.setup.playerId),
      this.units.map((u) => {
        const c = counters.units.get(u.id);
        const r = { instanceId: u.id, playerId: u.playerId, cost: u.cost, diedAtTick: u.diedAtTick, type: u.type, spawnedAtTick: u.spawnedAtTick ?? 0, ...(u.factory ? { factory: factoryReport(u) } : {}) };
        const alive = frame ? aliveInFrame(r, frame, listed) : false;
        return {
          playerId: u.playerId,
          cost: alive ? livingValueAt(r, left) : 0,
          alive,
          damageDealt: c?.damageDealt ?? 0,
          kills: c?.kills ?? 0,
          valueDestroyed: c?.valueDestroyed ?? 0,
          healing: c?.healing ?? 0,
          combos: c?.combos ?? 0,
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
      // Checked before the spawn frame, so a side placed without fighters
      // crumbles in frame 0 (its `crumble` event rides with the spawns).
      const endedAtStart = this.checkElimination();
      this.emitFrame();

      if (endedAtStart) {
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
    const u: SimUnit = {
      id: inst.instanceId,
      playerId: setup.playerId,
      seat: setup.seat,
      teamId: setup.teamId ?? setup.seat,
      unitId: design.unitId,
      stats: s,
      cost: design.cost,
      type: s.type,
      radius: sizeOf(s), // the size stat; type default if a snapshot lacks it
      x: inst.x,
      y: inst.y,
      hp: s.maxHealth,
      maxHp: s.maxHealth,
      cooldownRemaining: 0, // every unit can fire on tick 0
      alive: true,
      disabled: false,
      spawned: false,
      movedSinceFrame: false,
      firedSinceFrame: false,
      // Sprites are drawn facing right: start facing the arena centre, in
      // SCREEN space (iso screenX ∝ x − y; ties by arena x).
      facingLeft: screenX(inst) > screenX(center) || (screenX(inst) === screenX(center) && inst.x > center.x),
      outsideSafeZone: false,
      damageDealt: 0,
      kills: 0,
      valueDestroyed: 0,
      strikes: 0,
      errors: [],
      diedAtTick: null,
      blockedBy: null,
      blockedTicks: 0,
      pathing: 'direct',
      route: null,
      blockedTicksMax: 0,
      blockedSinceFrame: false,
      slide: null,
      spawnedAtTick: 0,
      // M8.8: no status yet; the heal room fills on tick 0.
      frozen: 0,
      burns: [],
      healRoom: 0,
      aura: noAura(),
    };
    if (s.type === 'factory') {
      // Priced like the validator does: body + minionValue × E.
      const priced = computeCost(s, this.config.cost, pricingOf(this.config)).breakdown;
      const prod = priced.production;
      const kind = producesOf(s);
      const element = minionElementOf(s);
      u.factory = {
        productionInterval: s.productionInterval ?? this.config.stats.bounds.productionInterval.max,
        timer: 0,
        minionsLeft: prod?.expected ?? 0,
        canMake: prod?.expected ?? 0,
        noSpot: false,
        made: 0,
        released: 0,
        kind,
        element,
        // A burst never exceeds what one factory may have alive.
        burst: Math.min(burstOf(s), this.config.factory.maxAlivePerFactory),
        stored: 0,
        releaseRequested: false,
        order: 'attack',
        orderTargetId: null,
        storedLost: 0,
        rally: { x: center.x, y: center.y },
        holding: false,
        bodyCost: priced.body ?? design.cost,
        minionValue: prod?.minionValue ?? minionValueOf(this.config, kind, element),
        spawnedSinceFrame: false,
        minionsLost: 0,
      };
    }
    return u;
  }

  private async spawnAll(): Promise<void> {
    await Promise.all(
      this.players.map(async (p) => {
        for (const u of p.units) {
          // Walls have no code: nothing to construct.
          if (u.type === 'wall') {
            u.spawned = true;
            continue;
          }
          let res;
          try {
            res = await p.runner.spawn(u.id, u.unitId);
          } catch (err) {
            res = { ok: false as const, error: { message: err instanceof Error ? err.message : String(err) } };
          }
          if (res.ok) {
            u.spawned = true;
            // A factory with updateMinion() decides for its minions.
            if (res.hasMinion && u.type === 'factory') u.minionCode = { off: false, strikes: 0, timeouts: 0 };
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

    // 1) Cooldowns (by the tempo, M8.8), status timers, heal room and auras,
    //    then views from the start-of-tick state.
    const living = this.living();
    for (const u of living) {
      if (u.cooldownRemaining > 0) {
        const cd = u.cooldownRemaining - tempoOf(u, cfg);
        // Float tempos leave crumbs (0.65 × n): snap them so 0 means ready.
        u.cooldownRemaining = cd > 1e-9 ? cd : 0;
      }
      if (u.factory) u.factory.holding = false;
    }
    resetHealRoom(living, tick, cfg);
    computeAuras(living);
    // Factories build in step 9b at the tempo they had now, so a freeze landing
    // in step 7 slows the same ticks for builds as for reloads and moves.
    const factoryTempo = new Map<SimUnit, number>();
    for (const u of living) if (u.factory) factoryTempo.set(u, tempoOf(u, cfg));
    const healsOff = tick >= cfg.suddenDeath.startTick;
    // M8.6: a swarm whose target died becomes attack, a guard whose ally
    // died defend, before anyone decides (dead factories too: their minions
    // keep the last order).
    for (const u of this.units) if (u.factory) this.checkOrder(u);
    const others = living.map((u) => toOtherView(u, tick, cfg, this.ownerNames));
    const safeRadius = safeRadiusAt(tick, cfg);

    // 2) Minions decide from the same snapshot (engine AI, no isolate), then
    //    all runners in parallel; results applied in seat order below. The
    //    built-in action is also each minion's `self.minion.builtIn` for a
    //    factory's updateMinion(), so it is worked out first.
    const minionRaw = new Map<string, unknown>();
    const minionWorld = {
      living,
      safeCenter: this.center,
      safeRadius,
      rangeTolerance: cfg.sim.rangeTolerance,
      lookup: (id: string) => this.byId.get(id),
      healsOff,
    };
    for (const u of living) {
      if (u.type === 'minion') minionRaw.set(u.id, minionAction(u, minionWorld, cfg));
    }
    // enemies/allies are built once per side and shared by its players, so
    // the sandbox serialises them once per side.
    const sideViews = new Map<number, { enemies: OtherView[]; allies: OtherView[] }>();
    const inputs = this.players.map((p) => this.buildInput(p, tick, living, others, safeRadius, sideViews, minionRaw));
    const waitStart = performance.now();
    const results = await Promise.all(
      this.players.map((p, i) => {
        const input = inputs[i];
        return input ? safeTick(p.runner, input) : Promise.resolve(undefined);
      }),
    );
    this.tickWaitMs.push(performance.now() - waitStart);

    // 3) Apply sandbox results (policy) and validate actions, seat then instanceId order.
    const pending: PendingAction[] = [];
    this.players.forEach((p, i) => {
      const input = inputs[i];
      const res = results[i];
      const minionActs = new Map<string, unknown>();
      const raw = input && res ? this.applyTickResult(p, input, res, tick, minionActs) : new Map<string, unknown>();
      // The player's code-run units and its minions, in instanceId order. A
      // minion takes its factory's updateMinion() action when it gave one,
      // else the built-in one.
      const acting: Array<[SimUnit, unknown]> = [];
      for (const u of p.units) {
        if (!u.alive) continue;
        if (u.type === 'minion') acting.push([u, minionActs.has(u.id) ? minionActs.get(u.id) : minionRaw.get(u.id)]);
        else if (raw.has(u.id)) acting.push([u, raw.get(u.id)]);
      }
      for (const [unit, r] of acting) {
        const action = resolveAction(r, unit, (id) => this.byId.get(id), cfg.sim.rangeTolerance, this.arena, { healsOff });
        const f = unit.factory;
        if (action.kind === 'rally') {
          f!.rally = action.destination;
          f!.order = 'attack';
          f!.orderTargetId = null;
        } else if (action.kind === 'command') {
          f!.order = action.order;
          f!.orderTargetId = action.targetId;
          if (action.destination) f!.rally = action.destination;
          this.checkOrder(unit);
        } else if (action.kind === 'release') {
          if (f!.stored > 0) f!.releaseRequested = true;
        } else if (action.kind === 'hold') f!.holding = true;
        else if (action.kind !== 'idle') pending.push({ unit, action });
      }
    });

    // 4) Moves (soldiers and minions; other types were turned into idle in
    //    step 3), routed round walls and sliding along them.
    // Redesign (accuracy): how far each body moves this tick (0 unless it moves below).
    for (const u of living) u.moved = 0;
    for (const { unit, action } of pending) {
      if (action.kind !== 'move') continue;
      const sx0 = screenX(unit);
      const x0 = unit.x;
      const y0 = unit.y;
      // M8.8: the step is speed × tempo; the router's waypoint and blocked checks use it too.
      const res = this.paths.move(unit, action.destination, unit.stats.speed * tempoOf(unit, cfg), tick);
      // Sticky until the next frame is recorded (cleared in FrameRecorder.record).
      if (res.moved) unit.movedSinceFrame = true;
      if (res.blocked) unit.blockedSinceFrame = true;
      unit.moved = Math.hypot(unit.x - x0, unit.y - y0);
      const sx1 = screenX(unit);
      if (sx1 < sx0) unit.facingLeft = true;
      else if (sx1 > sx0) unit.facingLeft = false;
    }
    // M8.8: the freeze counts down once this tick's reloads, views and moves
    // have read it (and before step 7 can refresh it), so one ice hit slows
    // exactly ice.ticks ticks of each, and views show ice.ticks first.
    for (const u of living) if ((u.frozen ?? 0) > 0) u.frozen! -= 1;

    // 5) Separation (circle bodies), each pass ending with the wall push.
    separate(
      living.filter((u) => u.type !== 'wall'),
      cfg.sim.separationPasses,
      this.rng,
      this.arena,
      this.walls,
    );

    // 6) Fire attacks. Melee hits are queued and land in step 7 together with
    //    the projectile impacts, so the first hit in seat, then instanceId
    //    order to take a target to ≤ 0 hp gets the kill.
    const hits: PendingHit[] = [];
    const heals: QueuedHeal[] = [];
    for (const { unit, action } of pending) {
      if (action.kind === 'heal') {
        // M8.8: heals share the attack cooldown and land in step 7b (an instant beam).
        const target = this.byId.get(action.targetId)!;
        unit.cooldownRemaining = unit.stats.attackCooldown;
        unit.firedSinceFrame = true;
        if (screenX(target) < screenX(unit)) unit.facingLeft = true;
        else if (screenX(target) > screenX(unit)) unit.facingLeft = false;
        heals.push({ healer: unit, target, power: action.power });
        continue;
      }
      if (action.kind !== 'attack') continue;
      const target = this.byId.get(action.targetId)!;
      const melee = unit.stats.range <= cfg.sim.meleeMaxRange;
      unit.cooldownRemaining = unit.stats.attackCooldown;
      unit.firedSinceFrame = true;
      if (screenX(target) < screenX(unit)) unit.facingLeft = true;
      else if (screenX(target) > screenX(unit)) unit.facingLeft = false;
      this.recorder.event({ type: 'fire', instanceId: unit.id, targetId: target.id, melee });
      // Brutes hit walls harder (M8.6); everyone else deals plain damage.
      // M8.8: might is taken at fire time and travels with the shot, with the element and splash.
      const might = unit.aura?.might ?? 0;
      const damage = might > 0 ? hitDamage(unit, target, cfg) * (1 + might / 100) : hitDamage(unit, target, cfg);
      const element = elementOf(unit.stats);
      const splash = splashOf(unit.stats);
      const mightSrc = might > 0 ? (unit.aura?.mightSrc ?? null) : null;
      if (melee) {
        hits.push({ attackerId: unit.id, target, damage, element, splash, might, mightSrc });
      } else {
        // Redesign: a shot at a moving body may miss; it then
        // flies to where the body is now and lands there (splash only).
        const chance = missChance(target.moved ?? 0, cfg);
        const miss = chance > 0 && this.accuracyRng() < chance;
        if (miss) {
          unit.misses = (unit.misses ?? 0) + 1;
          target.dodges = (target.dodges ?? 0) + 1;
        }
        this.projectiles.push({
          id: this.nextProjectileId++,
          x: unit.x,
          y: unit.y,
          ownerId: unit.id,
          targetId: target.id,
          damage,
          ...(element !== 'normal' ? { element } : {}),
          ...(splash > 0 ? { splash } : {}),
          ...(might > 0 ? { might, mightSrc } : {}),
          ...(miss ? { miss: { x: target.x, y: target.y } } : {}),
        });
      }
    }

    // 7) Projectiles move (over walls); then every hit of this tick (melee and
    //    impacts) lands in attacker order: seat, then instanceId, then projectile
    //    id, through the element and splash pipeline (M8.8, sim/effects.ts).
    const moved = moveProjectiles(this.projectiles, (id) => this.byId.get(id), cfg.sim.projectileSpeed);
    this.projectiles = moved.remaining;
    const pipeline = new HitPipeline(cfg, tick, this.recorder, this.elementRng, new BodyIndex(living, this.arena));
    resolveHits([...hits, ...moved.arrived], (h) => {
      const p = h.projectile;
      if (p?.miss) {
        pipeline.landMiss({
          attackerId: h.attackerId,
          attacker: this.byId.get(h.attackerId),
          targetId: p.targetId,
          at: p.miss,
          damage: h.damage,
          element: p.element ?? 'normal',
          splash: p.splash ?? 0,
          might: p.might ?? 0,
          mightSrc: p.mightSrc ?? null,
        });
        return;
      }
      pipeline.land({
        attackerId: h.attackerId,
        attacker: this.byId.get(h.attackerId),
        target: h.target,
        damage: h.damage,
        element: p ? (p.element ?? 'normal') : (h.element ?? 'normal'),
        splash: p ? (p.splash ?? 0) : (h.splash ?? 0),
        might: p ? (p.might ?? 0) : (h.might ?? 0),
        mightSrc: p ? (p.mightSrc ?? null) : (h.mightSrc ?? null),
      });
    });
    // 7b) The queued heals (after every hit: dead is dead), then 7c the burn pulses that are due.
    if (heals.length > 0) applyHeals(heals, this.recorder);
    pipeline.burnPulses(living);

    // 8) Sudden death on every body, buildings included (credits nobody).
    applySuddenDeath(living, tick, cfg, this.center);
    // 8b) factory.dieAtSuddenDeath (2026-10-25, on by default): on the first
    // tick of sudden death every factory still standing is destroyed (credits
    // nobody; step 9 removes it and its stored minions are lost as usual).
    if (cfg.factory.dieAtSuddenDeath && tick === cfg.suddenDeath.startTick) {
      for (const u of living) if (u.alive && u.type === 'factory' && u.hp > 0) u.hp = 0;
    }

    // 9) Remove the dead.
    let deadFactories: SimUnit[] | undefined;
    for (const u of living) {
      if (u.hp <= 0) {
        this.kill(u, tick + 1);
        this.recorder.event({ type: 'death', instanceId: u.id });
        if (u.factory) (deadFactories ??= []).push(u);
      }
    }
    // 9a) factory.minionsDieWithFactory (2026-10-25): the living minions of
    // every factory removed above crumble now, factory by factory in instanceId
    // order (they are dead for 9b and step 10).
    if (deadFactories && cfg.factory.minionsDieWithFactory) for (const fac of deadFactories) this.crumbleMinionsOf(fac, living, tick + 1);
    // Shots at units that just died vanish.
    // (A missed shot flies on to the ground it was aimed at.)
    this.projectiles = this.projectiles.filter((p) => p.miss || this.byId.get(p.targetId)?.alive);

    // 9b) Factory production (new minions act from the next tick).
    this.produce(tick + 1, factoryTempo);
    // 10) Elimination is checked by the loop (it also decides the frame).
  }

  /** Mark a body dead at time `t` (kept in the lists for reports). */
  private kill(u: SimUnit, t: number): void {
    u.alive = false;
    u.hp = 0;
    u.diedAtTick = t;
    if (u.type === 'wall') this.walls.remove(u);
    else if (isRoutingBuilding(u)) this.buildings.remove(u);
    const f = u.minion?.factory.factory;
    if (f) f.minionsLost += 1;
    // Minions waiting inside a factory die with it (M8.6).
    const own = u.factory;
    if (own && own.stored > 0) {
      this.recorder.event({ type: 'lost', factoryId: u.id, count: own.stored });
      own.minionsLost += own.stored;
      own.storedLost += own.stored;
      own.stored = 0;
      own.releaseRequested = false;
    }
  }

  /**
   * Minions die with their factory (factory.minionsDieWithFactory): the
   * factory's living minions within factory.crumbleRadius of it crumble at time `t`, in instanceId order, in one
   * `crumble` event carrying the factory's id. The unit whose hit destroyed the
   * factory gets a kill and the minion's value destroyed for each (the same
   * credit as hitting it down); a factory that died to sudden death credits nobody.
   */
  private crumbleMinionsOf(fac: SimUnit, living: readonly SimUnit[], t: number): void {
    let ids: string[] | undefined;
    const killer = fac.killedBy;
    // factory.crumbleRadius (2026-10-25): only minions whose centre is within it of
    // the factory's centre crumble (0 = all of them); the rest keep fighting.
    const radius = this.config.factory.crumbleRadius;
    for (const m of living) {
      if (!m.alive || m.minion?.factory !== fac || !withinCrumbleRadius(m, fac, radius)) continue;
      if (killer) {
        killer.kills += 1;
        killer.valueDestroyed += killValueOf(m);
      }
      m.killedBy = killer;
      this.kill(m, t);
      (ids ??= []).push(m.id);
    }
    if (ids) this.recorder.event({ type: 'crumble', ids: ids.sort(compareIds), factoryId: fac.id });
  }

  /**
   * The order fallbacks: a swarm needs a living enemy target, a guard a
   * living ally (same side); otherwise they become attack / defend.
   */
  private checkOrder(fac: SimUnit): void {
    const f = fac.factory!;
    if (f.order !== 'swarm' && f.order !== 'guard') return;
    const t = f.orderTargetId ? this.byId.get(f.orderTargetId) : undefined;
    const ok = !!t && t.alive && (f.order === 'swarm' ? t.teamId !== fac.teamId : t.teamId === fac.teamId);
    if (ok) return;
    f.order = f.order === 'swarm' ? 'attack' : 'defend';
    f.orderTargetId = null;
  }

  /** Where a factory's minions head: rally point, factory, swarm target or guarded ally. */
  private focusOf(fac: SimUnit): Point {
    const f = fac.factory!;
    if (f.order === 'defend') return { x: fac.x, y: fac.y };
    if (f.order === 'swarm' || f.order === 'guard') {
      const t = f.orderTargetId ? this.byId.get(f.orderTargetId) : undefined;
      if (t && t.alive) return { x: t.x, y: t.y };
    }
    return f.rally;
  }

  /**
   * Step 9b (M8.6 Store and release). `t` = the
   * time the new minions appear at. Caps count alive + stored minions.
   */
  private produce(t: number, tempos: ReadonlyMap<SimUnit, number>): void {
    const fc = this.config.factory;
    let factories: SimUnit[] | undefined;
    for (const u of this.units) if (u.alive && u.factory) (factories ??= []).push(u);
    if (!factories) return;
    // Alive (and stored) minions per factory and per player.
    const perFactory = new Map<string, number>();
    const perPlayer = new Map<string, number>();
    const add = (factoryId: string, playerId: string, n: number) => {
      perFactory.set(factoryId, (perFactory.get(factoryId) ?? 0) + n);
      perPlayer.set(playerId, (perPlayer.get(playerId) ?? 0) + n);
    };
    for (const u of this.units) {
      if (!u.alive) continue;
      if (u.minion) add(u.minion.factory.id, u.playerId, 1);
      if (u.factory && u.factory.stored > 0) add(u.id, u.playerId, u.factory.stored);
    }
    // factory.stopAtSuddenDeath (2026-10-25, off by default): a minion that
    // would appear at or after sudden death is never built, the timers stop and
    // the minions left unbuilt are gone; stored minions still leave. Off: the
    // production window is the battle (the pre-2026-10-25 behaviour, unchanged).
    const end = productionEndTick(this.config);
    const ticksLeft = end - t;
    const stopped = this.config.factory.stopAtSuddenDeath && ticksLeft <= 0;
    const buildings = { list: undefined as SimUnit[] | undefined };
    for (const fac of factories) {
      const f = fac.factory!;
      if (stopped) {
        f.minionsLeft = 0;
        if (f.stored > 0) this.release(fac, f.stored, t, buildings);
        continue;
      }
      // M8.8: the timer gains the tempo (0.65 per tick while frozen), which slows bursts too.
      if (!f.holding) {
        const timer = f.timer + (tempos.get(fac) ?? tempoOf(fac, this.config));
        f.timer = timer > f.productionInterval - 1e-9 ? f.productionInterval : timer;
      }
      const full = (perFactory.get(fac.id) ?? 0) >= fc.maxAlivePerFactory || (perPlayer.get(fac.playerId) ?? 0) >= this.minionCapPerPlayer;
      const wantRelease = f.releaseRequested && f.stored > 0;
      if (f.timer >= f.productionInterval && f.minionsLeft > 0 && !full) {
        if (f.stored + 1 < f.burst && !wantRelease) {
          // Not a full burst yet: it waits inside (no spawn spot needed).
          f.stored += 1;
          f.minionsLeft -= 1;
          f.made += 1;
          f.timer = 0;
          f.noSpot = false;
          add(fac.id, fac.playerId, 1);
          continue;
        }
        // This one completes the burst (burst 1: every minion): all leave together.
        if (this.release(fac, f.stored + 1, t, buildings)) {
          f.minionsLeft -= 1;
          f.made += 1;
          f.timer = 0;
          add(fac.id, fac.playerId, 1);
        }
        continue;
      }
      // The store can't grow (or a release was asked for): send out what is there.
      if (f.stored > 0 && (wantRelease || full || f.minionsLeft <= 0 || canMakeOf(f, ticksLeft) === 0)) {
        this.release(fac, f.stored, t, buildings);
      }
    }
    for (const fac of factories) fac.factory!.canMake = canMakeOf(fac.factory!, ticksLeft);
  }

  /**
   * `count` minions leave `fac` together (the stored ones plus any new one):
   * false (nothing leaves, `noSpot`) when no spawn spot is free.
   */
  private release(fac: SimUnit, count: number, t: number, buildings: { list: SimUnit[] | undefined }): boolean {
    const f = fac.factory!;
    buildings.list ??= this.units.filter((b) => b.alive && (b.type === 'tower' || b.type === 'factory'));
    const zone = this.players.find((p) => p.setup.playerId === fac.playerId)!.setup.zone;
    const size = kindConfig(this.config, f.kind).size;
    const spots = spawnSpots(fac, this.focusOf(fac), zoneFacingDir(zone), this.arena, size, this.walls, buildings.list, count);
    f.noSpot = spots.length === 0;
    if (spots.length === 0) return false;
    // The burst event comes first, so clients can treat its spawns as one release.
    if (count >= 2) this.recorder.event({ type: 'release', factoryId: fac.id, count });
    for (const spot of spots) {
      f.released += 1;
      this.addMinion(fac, f.released, spot, t);
    }
    f.stored = 0;
    f.releaseRequested = false;
    f.spawnedSinceFrame = true;
    return true;
  }

  /** Create a factory's n-th minion at `spot`. */
  private addMinion(fac: SimUnit, n: number, spot: Point, t: number): void {
    const kind = fac.factory?.kind ?? 'grunt';
    const stats = minionStats(this.config, fac.stats.color, kind, fac.factory?.element ?? 'normal');
    const m: SimUnit = {
      id: `${fac.id}-m${n}`,
      playerId: fac.playerId,
      seat: fac.seat,
      teamId: fac.teamId,
      unitId: fac.unitId,
      stats,
      cost: fac.factory?.minionValue ?? this.minionValue,
      type: 'minion',
      radius: stats.size,
      x: spot.x,
      y: spot.y,
      hp: stats.maxHealth,
      maxHp: stats.maxHealth,
      cooldownRemaining: 0,
      alive: true,
      disabled: false,
      spawned: true,
      movedSinceFrame: false,
      firedSinceFrame: false,
      facingLeft: screenX(this.focusOf(fac)) < screenX(spot),
      outsideSafeZone: false,
      damageDealt: 0,
      kills: 0,
      valueDestroyed: 0,
      strikes: 0,
      errors: [],
      diedAtTick: null,
      blockedBy: null,
      blockedTicks: 0,
      blockedTicksMax: 0,
      blockedSinceFrame: false,
      slide: null,
      pathing: 'direct',
      route: null,
      spawnedAtTick: t,
      minion: { factory: fac, n, kind },
      frozen: 0,
      burns: [],
      // A fresh minion starts with a full heal room for its window.
      healRoom: freshHealRoom({ type: 'minion', maxHp: stats.maxHealth }, t, this.config),
      aura: noAura(),
    };
    insertSorted(this.units, m);
    insertSorted(this.players.find((p) => p.setup.playerId === fac.playerId)!.units, m);
    this.byId.set(m.id, m);
    this.recorder.event({ type: 'spawn', instanceId: m.id, factoryId: fac.id, x: round2(spot.x), y: round2(spot.y), kind });
  }

  /** The TickInput for one player, or undefined if none of its units can act. */
  private buildInput(
    p: PlayerState,
    tick: number,
    living: readonly SimUnit[],
    others: readonly OtherView[],
    safeRadius: number,
    sideViews: Map<number, { enemies: OtherView[]; allies: OtherView[] }>,
    minionRaw: ReadonlyMap<string, unknown>,
  ): TickInput | undefined {
    if (p.disabled || p.runner.disposed) return undefined;
    // Only units that run code act through the sandbox: not walls, not minions.
    const cap = this.config.factory.maxAlivePerFactory;
    // Production stops for sudden death (factory.stopAtSuddenDeath): this tick's step 9b builds only if its minion appears before it.
    const producing = !this.config.factory.stopAtSuddenDeath || tick + 1 < productionEndTick(this.config);
    const selves = living
      .filter((u) => u.playerId === p.setup.playerId && !u.disabled && u.type !== 'wall' && u.type !== 'minion')
      .map((u) => toSelfView(u, u.factory ? factoryView(u, living, cap, producing) : null, tick, this.config));
    if (selves.length === 0) return undefined;
    // The minions of the acting factories that run updateMinion().
    let minions: SelfView[] | undefined;
    for (const u of living) {
      const fac = u.minion?.factory;
      if (!fac || fac.playerId !== p.setup.playerId || !fac.alive || fac.disabled || !fac.minionCode || fac.minionCode.off) continue;
      const f = fac.factory!;
      const view = toSelfView(u, null, tick, this.config);
      view.minion = {
        kind: kindOf(u),
        factoryId: fac.id,
        order: f.order,
        orderTargetId: f.orderTargetId,
        rally: { x: f.rally.x, y: f.rally.y },
        builtIn: (minionRaw.get(u.id) as Action | undefined) ?? { action: 'idle' },
      };
      (minions ??= []).push(view);
    }
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
      ...(this.worldPlayers ? { players: this.worldPlayers } : {}),
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
      ...(minions ? { minions } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Sandbox policy (strikes, disable)
  // -------------------------------------------------------------------------

  /**
   * Record what the runner reported and return the raw actions to validate
   * (instanceId → action). Units with an error or no entry idle.
   */
  private applyTickResult(p: PlayerState, input: TickInput, res: TickResult, tick: number, minionActs: Map<string, unknown>): Map<string, unknown> {
    const limits = this.config.sandbox.battle;
    const actions = new Map<string, unknown>();

    if (res.status === 'crashed') {
      this.incident(p, tick, 'crashed', `The sandbox crashed${res.detail ? `: ${res.detail}` : ''}.`);
      this.disablePlayer(p, 'crashed');
      return actions;
    }

    const suspect = p.stallSuspect;
    p.stallSuspect = undefined;
    if (res.status === 'timeout' && res.hostStall) {
      // The sandbox process was frozen (OS / VM scheduler) for most of the
      // tick: the units idle, but it's not the player's code, so no strike and
      // no timeout count. The stall hides whether the unit it named was
      // looping, so remember it: if it times out again on its own next tick,
      // this stall counts as its first timeout.
      const named = res.culprit !== undefined ? this.byId.get(res.culprit) : undefined;
      if (named && named.playerId === p.setup.playerId && !named.disabled && named.alive) p.stallSuspect = named.id;
      this.incident(p, tick, 'timeout', 'The game computer paused for a moment (not your code); all units idled this tick.');
      return actions;
    }

    if (res.status === 'timeout') {
      p.timeouts += 1;
      const culprit = res.culprit !== undefined ? this.byId.get(res.culprit) : undefined;
      const minionFactory = culprit?.minion?.factory;
      if (culprit && minionFactory?.minionCode && !minionFactory.minionCode.off && minionFactory.playerId === p.setup.playerId) {
        // The factory's updateMinion() was running (for this minion).
        // Like a unit's update(): the first timeout only idles this tick (the
        // minions use their built-in logic), a repeat switches the minion
        // code off; the factory itself keeps running. Neither counts toward
        // the player limits.
        const mc = minionFactory.minionCode;
        mc.timeouts += 1 + (culprit.id === suspect ? 1 : 0);
        if (mc.timeouts >= limits.timeoutsToDisable) {
          this.minionCodeOff(
            minionFactory,
            tick,
            `${minionFactory.stats.name}'s updateMinion() took too long again (over ${limits.hardTimeoutMs} ms, endless loop?), so its minions use their built-in logic for the rest of the battle`,
          );
        } else {
          this.recordUnitError(
            minionFactory,
            tick,
            `${minionFactory.stats.name}'s updateMinion() took too long once (for ${culprit.id}): it was stopped and all units idled this tick.`,
          );
        }
        return actions;
      }
      if (culprit && culprit.type !== 'minion' && culprit.playerId === p.setup.playerId && !culprit.disabled && culprit.alive) {
        // One stall can be the host (GC, scheduler), not the player's code: the
        // first timeout only idles this tick and is reported; a repeat naps.
        // A culprit's own timeouts (forgiven or disabling) don't count toward
        // the player limits, which are for timeouts that CONTINUE after the
        // culprit naps. Otherwise 2 copies of one looping design (A, A,
        // then B) would disable the whole player, healthy units included.
        // Timing out right after a host stall that named it: that stall was its
        // first timeout (an endless loop the stall hid), so this one is a repeat.
        const hidden = culprit.id === suspect ? 1 : 0;
        const timeouts = (p.unitTimeouts.get(culprit.id) ?? 0) + 1 + hidden;
        p.unitTimeouts.set(culprit.id, timeouts);
        culprit.strikes += 1 + hidden;
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

    // The factories' updateMinion() actions. Nothing (undefined/null) =
    // the built-in logic. An error: that minion uses the built-in logic this
    // tick, and its factory's minion code gets one strike per tick (at the
    // unit strike limit it is switched off; the factory keeps running).
    if (res.minions && input.minions) {
      const listed = new Set(input.minions.map((m) => m.id));
      const struck = new Set<SimUnit>();
      for (const out of res.minions) {
        const m = listed.has(out.instanceId) ? this.byId.get(out.instanceId) : undefined;
        const fac = m?.minion?.factory;
        if (!m || !fac || fac.id !== out.factoryId || !fac.minionCode || fac.minionCode.off || minionActs.has(m.id)) continue;
        if ('error' in out) {
          if (struck.has(fac)) continue;
          struck.add(fac);
          fac.minionCode.strikes += 1;
          this.recordUnitError(fac, tick, `updateMinion() threw for ${m.id}: ${out.error.message}`, out.error.line);
          if (fac.minionCode.strikes >= limits.unitStrikeLimit) {
            this.minionCodeOff(fac, tick, `${fac.stats.name}'s updateMinion() got confused too many times, so its minions use their built-in logic for the rest of the battle`);
          }
        } else if (out.action !== undefined && out.action !== null) {
          minionActs.set(m.id, out.action);
        }
      }
    }

    if (res.slow) this.slowStrike(p, res, tick, acting);
    return actions;
  }

  /** Switch a factory's updateMinion() off for the rest of the battle (its minions use the built-in logic). */
  private minionCodeOff(fac: SimUnit, tick: number, message: string): void {
    if (!fac.minionCode || fac.minionCode.off) return;
    fac.minionCode.off = true;
    // Once per battle, so always reported (even past the per-unit error cap).
    fac.errors.push({ tick, message });
  }

  private slowStrike(p: PlayerState, res: TickResult, tick: number, acting: ReadonlySet<string>): void {
    const limits = this.config.sandbox.battle;
    p.slowStrikes += 1;
    if (p.slowStrikes < limits.slowStrikeLimit) return;
    const slowest = res.slowestInstanceId !== undefined && acting.has(res.slowestInstanceId)
      ? this.byId.get(res.slowestInstanceId)
      : undefined;
    if (!p.slowUnitDisabled && slowest && !slowest.disabled && res.slowestIsMinionCode && slowest.minionCode && !slowest.minionCode.off) {
      // The slowest code was the factory's updateMinion(): switch that off, not the factory.
      this.minionCodeOff(slowest, tick, `${slowest.stats.name}'s updateMinion() was too slow (over ${limits.softTimeoutMs} ms) too many times, so its minions use their built-in logic for the rest of the battle`);
      p.slowUnitDisabled = true;
      p.slowStrikes = 0;
    } else if (!p.slowUnitDisabled && slowest && !slowest.disabled) {
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
   * Step 10: mark newly eliminated players. A player (and a side) is out when
   * it has no living FIGHTERS (walls and spent factories don't count).
   * An eliminated side's leftover walls and spent factories crumble at once
   * (credited to nobody). Returns true when ≤ 1 side has fighters.
   */
  private checkElimination(): boolean {
    const sidesWithFighters = new Set<number>();
    const sides = new Set<number>();
    for (const p of this.players) {
      const side = p.setup.teamId ?? p.setup.seat;
      sides.add(side);
      if (p.units.some((u) => u.alive && isFighter(u))) sidesWithFighters.add(side);
      else if (p.eliminatedAtTick === null) p.eliminatedAtTick = this.time;
    }
    let crumbled: string[] | undefined;
    for (const p of this.players) {
      if (sidesWithFighters.has(p.setup.teamId ?? p.setup.seat)) continue;
      for (const u of p.units) {
        if (!u.alive) continue;
        this.kill(u, this.time);
        (crumbled ??= []).push(u.id);
      }
    }
    if (crumbled) {
      crumbled.sort(compareIds);
      this.recorder.event({ type: 'crumble', ids: crumbled });
      // (A missed shot flies on to the ground it was aimed at.)
    this.projectiles = this.projectiles.filter((p) => p.miss || this.byId.get(p.targetId)?.alive);
    }
    return sidesWithFighters.size <= 1;
  }

  private emitFrame(): void {
    const frame = this.recorder.record(this.time, this.living(), this.projectiles, safeRadiusAt(this.time, this.config), (u) => this.focusOf(u));
    this.logCounters(frame.t);
    this.onFrame?.(frame);
  }

  /** Append the counters that changed since the last frame. */
  private logCounters(t: number): void {
    for (const u of this.units) {
      const log = this.unitCounterLog.get(u.id);
      const last: UnitCounters = log?.[log.length - 1] ?? { damageDealt: 0, kills: 0, valueDestroyed: 0, strikes: 0, disabled: false };
      const same =
        last.damageDealt === u.damageDealt &&
        last.kills === u.kills &&
        last.valueDestroyed === u.valueDestroyed &&
        last.strikes === u.strikes &&
        last.disabled === u.disabled &&
        (last.healing ?? 0) === (u.healing ?? 0) &&
        (last.combos ?? 0) === (u.combos ?? 0) &&
        (last.cleanses ?? 0) === (u.cleanses ?? 0) &&
        (last.assist ?? 0) === (u.assist ?? 0) &&
        sameSplit(last.damageSplit, u.damageSplit);
      if (same) continue;
      const entry = {
        t,
        damageDealt: u.damageDealt,
        kills: u.kills,
        valueDestroyed: u.valueDestroyed,
        strikes: u.strikes,
        disabled: u.disabled,
        ...(u.healing ? { healing: u.healing } : {}),
        ...(u.combos ? { combos: u.combos } : {}),
        ...(u.cleanses ? { cleanses: u.cleanses } : {}),
        ...(u.assist ? { assist: u.assist } : {}),
        // A copy: the body's split is mutated in place.
        ...(u.damageSplit ? { damageSplit: { ...u.damageSplit } } : {}),
      };
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
      const fighting = living.some((u) => isFighter(u));
      const out: PlayerOutcome = {
        playerId: p.setup.playerId,
        seat: p.setup.seat,
        zone: p.setup.zone,
        ...(p.setup.teamId !== undefined ? { teamId: p.setup.teamId } : {}),
        eliminatedAtTick: fighting ? null : p.eliminatedAtTick ?? this.time,
        livingCost: living.reduce((sum, u) => sum + livingValueOf(u), 0),
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
        type: u.type,
        livingValue: u.alive ? livingValueOf(u) : 0,
        spawnedAtTick: u.spawnedAtTick ?? 0,
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
      if (u.minion) r.factoryId = u.minion.factory.id;
      if (u.factory) r.factory = factoryReport(u);
      if (u.type === 'soldier' || u.type === 'minion') r.blockedTicksMax = u.blockedTicksMax ?? 0;
      // M8.8: pure support is no fighter; healing, cleanses, combos, assist and the damage split.
      if (!canFight(u) && u.type !== 'wall') r.nonFighter = true;
      if (supportOf(u.stats)?.kind === 'heal' || u.factory?.kind === 'medic') r.healer = true;
      if (u.healing) r.healing = u.healing;
      if (u.cleanses) r.cleanses = u.cleanses;
      if (u.combos) r.combos = u.combos;
      if (u.assist) r.assist = u.assist;
      if (u.damageSplit) r.damageSplit = { ...u.damageSplit };
      // Redesign (accuracy): shots that missed and shots it dodged.
      if (u.misses) r.misses = u.misses;
      if (u.dodges) r.dodges = u.dodges;
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
 * Horizontal screen position in the isometric view, up to scale
 * (screenX = (x − y)·k). Sprite facing (FACING_LEFT) is decided on this axis.
 */
function screenX(p: { x: number; y: number }): number {
  return p.x - p.y;
}

/** The last entry with `t` ≤ `tick` in a list sorted by `t`. */
/** True when two damage splits hold the same numbers (absent = all zero). */
function sameSplit(a: DamageSplitDTO | undefined, b: DamageSplitDTO | undefined): boolean {
  const z = { hit: 0, splash: 0, burn: 0, zap: 0, shatter: 0 };
  const x = a ?? z;
  const y = b ?? z;
  return x.hit === y.hit && x.splash === y.splash && x.burn === y.burn && x.zap === y.zap && x.shatter === y.shatter;
}

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
// Reports
// ---------------------------------------------------------------------------

/**
 * Skip: the result as of recorded frame `endTick` (the frame the players were
 * shown): survival and living value from that frame's living bodies, counters
 * from `counters`, and only the errors and incidents up to that tick. Ranking
 * is left as is (the caller ranks and scores from the frame).
 *
 * Pass the frame itself as `shown` (M8.5): walls are listed in a frame only
 * when their hp changed, and factories' living value needs the frame's `fac`.
 * A plain set of the frame's unit ids still works for battles without walls
 * and factories.
 */
export function resultAtTick(
  result: BattleResult,
  counters: CountersAtTick,
  shown: ReadonlySet<string> | Pick<FrameDTO, 't' | 'units' | 'fac'>,
  endTick: number,
): BattleResult {
  const zero: UnitCounters = { damageDealt: 0, kills: 0, valueDestroyed: 0, strikes: 0, disabled: false };
  const frame = isFrame(shown) ? shown : { t: endTick, units: [...shown].map((id): FrameDTO['units'][number] => [id, 0, 0, 0, 0]) };
  const listed = new Set(frame.units.map((u) => u[0]));
  const left = isFrame(shown) ? factoryLeftIn(shown) : new Map(result.units.filter((u) => u.factory).map((u) => [u.instanceId, u.factory!.canMake ?? u.factory!.minionsLeft]));
  const aliveAtEnd = new Set<string>();
  const valueAt = new Map<string, number>();
  const living = new Map<string, { cost: number; count: number }>();
  for (const u of result.units) {
    if (!aliveInFrame(u, frame, listed)) continue;
    aliveAtEnd.add(u.instanceId);
    const value = livingValueAt(u, left);
    valueAt.set(u.instanceId, value);
    const l = living.get(u.playerId) ?? { cost: 0, count: 0 };
    l.cost += value;
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
        livingValue: valueAt.get(u.instanceId) ?? 0,
        damageDealt: c.damageDealt,
        kills: c.kills,
        valueDestroyed: c.valueDestroyed,
        strikes: c.strikes,
        disabled: c.disabled,
        errors: u.errors.filter((e) => e.tick <= endTick),
      };
      if (!c.disabled) delete r.disabledReason;
      // M8.8: healing, combos, cleanses, assist and the damage split as of the shown frame.
      if (c.healing) r.healing = c.healing;
      else delete r.healing;
      if (c.combos) r.combos = c.combos;
      else delete r.combos;
      if (c.cleanses) r.cleanses = c.cleanses;
      else delete r.cleanses;
      if (c.assist) r.assist = c.assist;
      else delete r.assist;
      if (c.damageSplit) r.damageSplit = { ...c.damageSplit };
      else delete r.damageSplit;
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
  // Minions count for damage, KOs and value (credited to the factory type), not as placed units.
  const placed = units.filter((u) => u.type !== 'minion');
  return {
    round,
    survived: placed.filter((u) => u.survived).length,
    damageDealt: Math.round(units.reduce((s, u) => s + u.damageDealt, 0)),
    kills: units.reduce((s, u) => s + u.kills, 0),
    valueDestroyed: units.reduce((s, u) => s + u.valueDestroyed, 0),
    livingValue: units.filter((u) => u.survived).reduce((s, u) => s + (u.livingValue ?? u.cost), 0),
    score: entry ? roundScoreOf(entry) : null,
    strikes: units.reduce((s, u) => s + u.strikes, 0) + (player?.playerStrikes ?? 0),
    disabled: placed.filter((u) => u.disabled).length,
    errors,
    ...reportTypes(units, result.endTick),
  };
}

/** Share of the battle a soldier type may spend blocked by walls before the report hints. */
const STUCK_HINT_SHARE = 0.3;

/**
 * Per fielded type of one player (M8.5): factories with their
 * minions' output, soldiers with their longest wall block, and the
 * "got stuck behind walls" hint.
 */
function reportTypes(units: readonly UnitReport[], endTick: number): Pick<BattleReportDTO, 'types' | 'hints'> {
  const byType = new Map<string, NonNullable<BattleReportDTO['types']>[number]>();
  const healers = new Set<string>();
  for (const u of units) {
    if (u.type === 'minion') continue;
    let t = byType.get(u.unitId);
    if (!t) {
      t = { unitId: u.unitId, name: u.unitName, type: (u.type ?? 'soldier') as UnitType, fielded: 0, survived: 0, damageDealt: 0, kills: 0 };
      byType.set(u.unitId, t);
    }
    t.fielded++;
    if (u.survived) t.survived++;
    t.damageDealt += u.damageDealt;
    t.kills += u.kills;
    if (u.factory) {
      t.minionsMade = (t.minionsMade ?? 0) + u.factory.minionsMade;
      t.minionsLost = (t.minionsLost ?? 0) + u.factory.minionsLost;
      t.minionDamage ??= 0;
      if (u.factory.storedLost) t.storedLost = (t.storedLost ?? 0) + u.factory.storedLost;
    }
    if (u.blockedTicksMax !== undefined && t.type === 'soldier') t.blockedTicksMax = Math.max(t.blockedTicksMax ?? 0, u.blockedTicksMax);
    addSupport(t, u);
    if (u.healer) healers.add(u.unitId);
  }
  for (const u of units) {
    if (u.type !== 'minion') continue;
    const t = byType.get(u.unitId);
    if (!t) continue;
    t.damageDealt += u.damageDealt;
    t.kills += u.kills;
    t.minionDamage = (t.minionDamage ?? 0) + u.damageDealt;
    addSupport(t, u);
  }
  const types = [...byType.values()].map((t) => ({
    ...t,
    damageDealt: Math.round(t.damageDealt),
    ...(t.minionDamage !== undefined ? { minionDamage: Math.round(t.minionDamage) } : {}),
    ...(t.damageSplit ? { damageSplit: roundSplit(t.damageSplit) } : {}),
    ...(t.healing !== undefined ? { healing: Math.round(t.healing) } : {}),
    ...(t.assist !== undefined ? { assist: Math.round(t.assist) } : {}),
  }));
  if (types.length === 0) return {};
  const hints = types
    .filter((t) => t.type === 'soldier' && endTick > 0 && (t.blockedTicksMax ?? 0) > STUCK_HINT_SHARE * endTick)
    .map((t) => `Your ${t.name} got stuck behind walls a lot. In update(), self.blockedBy, self.blockedTicks and self.pathing show when a wall stops it.`)
    .concat(
      types
        .filter((t) => (t.storedLost ?? 0) > 0)
        .map((t) => `Your ${t.name} was destroyed with ${t.storedLost} minion${t.storedLost === 1 ? '' : 's'} inside (stored minions are lost with their factory).`),
    )
    .concat(
      // M8.8: a heal-support type that never healed or cleansed anyone.
      types
        .filter((t) => healers.has(t.unitId) && !(t.healing ?? 0) && !(t.cleanses ?? 0))
        .map((t) => `Your ${t.name} never healed anyone (a heal needs a hurt, burning or frozen ally within its supportRange).`),
    );
  return { types, ...(hints.length > 0 ? { hints } : {}) };
}

/** Add a body's M8.8 report counters (healing, cleanses, assist, damage split) to its type's row. */
function addSupport(t: NonNullable<BattleReportDTO['types']>[number], u: UnitReport): void {
  if (u.healing) t.healing = (t.healing ?? 0) + u.healing;
  if (u.cleanses) t.cleanses = (t.cleanses ?? 0) + u.cleanses;
  if (u.assist) t.assist = (t.assist ?? 0) + u.assist;
  if (u.damageSplit) {
    const s = (t.damageSplit ??= { hit: 0, splash: 0, burn: 0, zap: 0, shatter: 0 });
    for (const k of ['hit', 'splash', 'burn', 'zap', 'shatter'] as const) s[k] += u.damageSplit[k];
  }
}

function roundSplit(s: DamageSplitDTO): DamageSplitDTO {
  return { hit: Math.round(s.hit), splash: Math.round(s.splash), burn: Math.round(s.burn), zap: Math.round(s.zap), shatter: Math.round(s.shatter) };
}

/**
 * Redesign: the chance a ranged shot misses a body that moved
 * `moved` px this tick: missMaxPct% × min(1, moved / speedRef).
 */
export function missChance(moved: number, config: Pick<GameConfig, 'accuracy'>): number {
  const a = config.accuracy;
  if (!(moved > 0) || a.missMaxPct <= 0) return 0;
  return (a.missMaxPct / 100) * Math.min(1, moved / a.speedRef);
}

// ---------------------------------------------------------------------------
// Views and runner safety
// ---------------------------------------------------------------------------

/** The names a player's bodies carry when "Show enemy names to units" is on. */
interface OwnerNames {
  ownerName: string;
  teamName?: string;
}

function toOtherView(u: SimUnit, tick: number, config: GameConfig, names: ReadonlyMap<string, OwnerNames> | null): OtherView {
  // A wall is a circle of radius 20 for range; walls and factories have range 0.
  const view: OtherView = {
    id: u.id,
    ownerId: u.playerId,
    teamId: u.teamId, // free-for-all: the seat; team mode: the team
    type: u.type,
    name: u.stats.name,
    x: u.x,
    y: u.y,
    radius: u.radius,
    hp: u.hp,
    maxHp: u.maxHp,
    range: u.stats.range,
    // M8.8: a minion's element is its factory's minionElement; walls and factories 'normal'.
    element: elementOf(u.stats),
    splashRadius: splashOf(u.stats),
    support: supportOf(u.stats),
    status: statusOf(u, tick, config),
    // Redesign (accuracy): how far it moved last tick.
    moving: (u.moved ?? 0) > 0,
    currentSpeed: Math.round((u.moved ?? 0) * 100) / 100,
  };
  // 2026-10-25: a minion names the factory that made it.
  if (u.minion) view.factoryId = u.minion.factory.id;
  // revealNames: a minion's playerId is its factory's player; a borrowed
  // Armory unit's is the player who fielded it.
  const n = names?.get(u.playerId);
  if (n) {
    view.ownerName = n.ownerName;
    if (n.teamName !== undefined) view.teamName = n.teamName;
  }
  return view;
}

function toSelfView(u: SimUnit, factory: FactoryView | null, tick: number, config: GameConfig): SelfView {
  return {
    id: u.id,
    unitId: u.unitId,
    ownerId: u.playerId,
    teamId: u.teamId, // free-for-all: the seat; team mode: the team
    type: u.type, // a minion only in its factory's updateMinion()
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
    // M8.8: an internal float (tempo); 0 still means "can act this tick".
    cooldownRemaining: Math.max(0, Math.ceil(u.cooldownRemaining - 1e-9)),
    element: elementOf(u.stats),
    splashRadius: splashOf(u.stats),
    support: supportOf(u.stats),
    status: statusOf(u, tick, config),
    blockedBy: u.blockedBy ?? null,
    blockedTicks: u.blockedTicks ?? 0,
    pathing: u.pathing ?? 'direct',
    factory,
  };
}

/** A factory's `self.factory`. */
function factoryView(u: SimUnit, living: readonly SimUnit[], maxAlive: number, producing: boolean): FactoryView {
  const f = u.factory!;
  let alive = 0;
  for (const m of living) if (m.minion?.factory === u) alive++;
  return {
    productionInterval: f.productionInterval,
    nextMinionIn: Math.max(0, Math.ceil(f.productionInterval - f.timer - 1e-9)),
    producing,
    minionsLeft: producing ? f.minionsLeft : 0,
    minionsAlive: alive,
    maxAlive,
    stored: f.stored,
    burst: f.burst,
    produces: f.kind,
    minionElement: f.element ?? 'normal',
    order: f.order,
    orderTargetId: f.orderTargetId,
    rally: { x: f.rally.x, y: f.rally.y },
  };
}

/** A factory's report block. */
function factoryReport(u: SimUnit): NonNullable<UnitReport['factory']> {
  const f = u.factory!;
  return {
    bodyCost: f.bodyCost,
    minionValue: f.minionValue,
    minionsLeft: f.minionsLeft,
    minionsMade: f.made,
    minionsLost: f.minionsLost,
    canMake: f.canMake,
    stored: f.stored,
    storedLost: f.storedLost,
  };
}

function isFrame(v: ReadonlySet<string> | Pick<FrameDTO, 't' | 'units' | 'fac'>): v is Pick<FrameDTO, 't' | 'units' | 'fac'> {
  return !(v instanceof Set);
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** Insert into a list sorted by instanceId. */
function insertSorted(list: SimUnit[], u: SimUnit): void {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compareIds(list[mid]!.id, u.id) < 0) lo = mid + 1;
    else hi = mid;
  }
  list.splice(lo, 0, u);
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
