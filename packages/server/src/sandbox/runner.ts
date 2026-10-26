// The sandbox Runner interface, shared by every sandbox mode:
//   - ivmRunner     (isolated-vm, the default; one isolate per player per battle)
//   - inprocRunner  (node:vm, dev/tests only, refused at startup without --unsafe)
//
// The sim engine (sim/engine.ts) talks ONLY to this interface, so it can be
// tested with a scripted fake runner.
//
// Division of responsibility
// --------------------------
// The RUNNER executes player code and reports FACTS about each tick:
//   * which actions/errors each instance produced,
//   * whether the player's tick timed out (and which instance was running),
//   * whether it was slow (and which instance was slowest),
//   * whether the output was malformed or contained forged entries,
//   * whether the sandbox crashed / ran out of memory (it then disposes itself).
// The runner does NOT validate action semantics (range, cooldown, target
// alive...) and does NOT keep strike counts or decide to disable units.
//
// The SIM (engine + battle service) owns POLICY: strike counting, disabling a
// culprit unit, disabling the whole player after repeated timeouts or slow
// strikes (config.sandbox.battle.*), and writing the battle report. A disabled
// instance is simply left out of `TickInput.selves`, so its update() is never
// called again.
//
// Data crossing the boundary is plain JSON (one copy each way per tick per
// player). Never pass functions, class instances or host references.

import type {
  OtherView,
  SelfView,
  StatsSnapshot,
  WorldView,
} from '@pixel-clash/shared';
import type { SandboxMode } from '@pixel-clash/shared';

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

/** The player a runner is created for (one runner per player per battle). */
export interface RunnerPlayer {
  playerId: string;
  /** Seat 0-7; prefix of every instanceId this player owns (`${seat}-${row}-${col}`). */
  seat: number;
  /**
   * PRNG seed for the in-sandbox `Math.random` replacement:
   * `battleSeed + seat`. Must be an integer.
   */
  seed: number;
}

/** One validated design the player fields this battle (≤ 3 per player). */
export interface RunnerUnitDesign {
  /** Design id. `spawn` refers to designs by this id. */
  unitId: string;
  /**
   * The stored CJS output of the validator's transpile step, i.e.
   * `StoredUnit.compiledJs`. The runner wraps it as
   * `(function(module, exports){ … })` and reads `module.exports.default`,
   * exactly like validation step 4.
   */
  compiledJs: string;
  /**
   * The frozen stats snapshot from validation. Informational for the runner
   * (combat stats are owned by the sim and never read back from the sandbox);
   * useful for error messages and reports.
   */
  stats: StatsSnapshot;
  /**
   * Open Armory: this design is a borrowed frozen copy of another
   * player's unit. `createBattleRunners` runs it in its OWN sandbox (never
   * sharing globals or prototypes with the borrower's code), loaded under the
   * creator's `sourceUnitId`, and its views use the creator's id as its
   * owner, so the frozen code can't tell it was borrowed by its ids.
   */
  borrowed?: { sourceUnitId: string; creatorId: string };
}

/** Limits, taken from `config.sandbox` (memoryLimitMb + battle.*). */
export interface RunnerLimits {
  /** Isolate heap limit in MB (default 32). */
  memoryLimitMb: number;
  /** Hard per-player `__tick` timeout in ms (default 12). */
  hardTimeoutMs: number;
  /** Soft limit in ms; above it `TickResult.slow` is true (default 6). */
  softTimeoutMs: number;
  /**
   * If a tick has not returned after hardTimeoutMs + disposeGraceMs (default
   * 10 ms) of the sandbox's CPU time, the runner disposes the sandbox and
   * reports status 'crashed' (e.g. a microtask loop that the timeout didn't
   * interrupt). A sandbox process that was merely not scheduled is not
   * killed (see IvmSession.withDeadline).
   */
  disposeGraceMs: number;
  /** Timeout for reading `__current` after a hard timeout (default 5 ms). */
  culpritProbeTimeoutMs: number;
  /** Per-call timeout for constructors run by `spawn` (default 50 ms). */
  constructTimeoutMs: number;
  /**
   * Time budget for evaluating one design at create time (optional; default
   * 1000 ms, the same as the validation evaluation budget).
   */
  loadTimeoutMs?: number;
}

/** Build RunnerLimits from the game config (`config.sandbox`). */
export function runnerLimitsFromConfig(sandbox: {
  memoryLimitMb: number;
  validation: { constructTimeoutMs: number; evalBudgetMs: number };
  battle: { hardTimeoutMs: number; softTimeoutMs: number; disposeGraceMs: number; culpritProbeTimeoutMs: number };
}): RunnerLimits {
  return {
    memoryLimitMb: sandbox.memoryLimitMb,
    hardTimeoutMs: sandbox.battle.hardTimeoutMs,
    softTimeoutMs: sandbox.battle.softTimeoutMs,
    disposeGraceMs: sandbox.battle.disposeGraceMs,
    culpritProbeTimeoutMs: sandbox.battle.culpritProbeTimeoutMs,
    constructTimeoutMs: sandbox.validation.constructTimeoutMs,
    loadTimeoutMs: sandbox.validation.evalBudgetMs,
  };
}

/**
 * Creates a sandbox for one player and evaluates all of their designs in it.
 * Rejects (throws) only for infrastructure failures; a design that fails to
 * evaluate is reported in `PlayerRunner.loadErrors` and its spawns fail.
 */
export interface RunnerFactory {
  readonly mode: SandboxMode;
  create(player: RunnerPlayer, units: readonly RunnerUnitDesign[], limits: RunnerLimits): Promise<PlayerRunner>;
}

// ---------------------------------------------------------------------------
// Per-tick input
// ---------------------------------------------------------------------------

/**
 * Everything one player's sandbox needs for one tick. Built by the sim from
 * the start-of-tick state (after cooldowns were decremented).
 *
 * Per-instance views: for each `self` in `selves` the harness calls
 *     unit.update(self, enemies, allies, world)
 * where
 *   - `self`    is that instance's SelfView,
 *   - `enemies` is a fresh copy of `enemies` (all living enemy units),
 *   - `allies`  is a fresh copy of `allies` WITHOUT the unit itself
 *               (filtered by `id !== self.id`),
 *   - `world`   is a fresh copy of `world`.
 * "Fresh" means every update() call gets its own deep copies, so one unit
 * mutating its inputs can never affect another unit.
 * The shared lists are sent once per tick instead of once per instance to
 * keep the JSON payload small (up to 12 own units × 36 others).
 */
export interface TickInput {
  /** Sim tick number, 0-based. */
  tick: number;
  /**
   * Sim time in ms (tick * 1000 / 60). Inside the sandbox `Date.now()` returns
   * this value, so player code is deterministic.
   */
  nowMs: number;
  /**
   * The living, NOT disabled instances of this player that should act this
   * tick, sorted by instanceId. Only these get update() called. Instances not
   * listed (dead, disabled, never spawned) are skipped.
   */
  selves: SelfView[];
  /** All living enemy units (any owner other than this player), sorted by id. */
  enemies: OtherView[];
  /**
   * All living units of this player as OtherView (including disabled ones,
   * which still stand on the field), sorted by id. The harness removes
   * `self` from it per call.
   */
  allies: OtherView[];
  /** The world view; `myCorner` is this player's zone centre this round. */
  world: WorldView;
  /**
   * updateMinion(): the views of the living minions whose factory is in
   * `selves` and has an updateMinion() method (SpawnResult.hasMinion), sorted
   * by instanceId. Each carries `minion` (MinionView, with its factoryId). The
   * harness runs the factory's updateMinion() once for each, in the same call
   * as the factory's update(). Absent or empty: no minion code runs.
   */
  minions?: SelfView[];
}

// ---------------------------------------------------------------------------
// Per-tick output
// ---------------------------------------------------------------------------

/**
 * The action an instance returned (ideally an `Action` from the contract). The value is passed through as parsed
 * from the sandbox's JSON output and is NOT validated beyond being JSON:
 * it may be `undefined` (returned nothing), a well-formed `Action`, or any
 * malformed value. The sim's action validator (sim/actions.ts) turns
 * anything that isn't a legal Action into idle.
 *
 * (A returned Promise or other non-JSON value arrives as `{}` or undefined
 * after JSON serialization; the harness may also replace it with
 * `{action:'idle'}`. Either way the sim idles it.)
 */
export type RawAction = unknown;

/** An instance's update() returned normally. */
export interface UnitActionOutput {
  instanceId: string;
  action: RawAction;
  /** Wall time spent in this instance's update(), in ms (harness-measured). */
  ms?: number;
}

/**
 * An instance's update() threw. The unit idles this tick and the sim adds
 * one strike to it.
 */
export interface UnitErrorOutput {
  instanceId: string;
  error: {
    /** The thrown value's message (String(value) for non-Errors), truncated to ~300 chars. */
    message: string;
    /** 1-based line in the player's ORIGINAL source when it can be mapped, else in compiled JS. */
    line?: number;
  };
  ms?: number;
}

export type UnitOutput = (UnitActionOutput | UnitErrorOutput) & {
  /** Factories with updateMinion() only: the time its updateMinion() calls took this tick, in ms (harness-measured). */
  mms?: number;
};

/**
 * What a factory's updateMinion() returned for one of its minions
 * (`factoryId`). An action of undefined (returned nothing, null, or a
 * Promise) means "use the built-in minion logic"; an error is reported on
 * the factory and the minion also uses the built-in logic this tick.
 */
export type MinionOutput =
  | { instanceId: string; factoryId: string; action: RawAction }
  | { instanceId: string; factoryId: string; error: { message: string; line?: number } };

export function isUnitError(o: UnitOutput): o is UnitErrorOutput {
  return 'error' in o;
}

/**
 * Overall status of one player's tick.
 *  - 'ok'         `__tick` returned in time with parseable output.
 *  - 'timeout'    `__tick` exceeded hardTimeoutMs and was terminated. `outputs`
 *                 is EMPTY (all the player's units idle this tick);
 *                 `culprit` names the instance that was running. The sandbox
 *                 is still usable.
 *  - 'bad-output' `__tick` returned non-JSON or a non-array (the harness was
 *                 tampered with). `outputs` is empty: the whole tick idles and
 *                 the sim records a player strike.
 *  - 'crashed'    out of memory, isolate died, the tick overran
 *                 hardTimeoutMs + disposeGraceMs, or the runner was already
 *                 disposed. The runner has disposed itself; every later tick()
 *                 resolves 'crashed' immediately. The sim disables all of the
 *                 player's units for the rest of the battle.
 */
export type TickStatus = 'ok' | 'timeout' | 'bad-output' | 'crashed';

/** The per-tick result envelope for one player. */
export interface TickResult {
  status: TickStatus;
  /**
   * At most one entry per instanceId, only for instances listed in
   * `TickInput.selves`, sorted by instanceId. The runner has already dropped
   * forged entries (unknown ids, enemy ids, ids not acting this tick,
   * duplicates) and counted them in `forged`. An instance in `selves` with no
   * entry simply idles.
   */
  outputs: UnitOutput[];
  /** Wall time of the whole `__tick` call as seen by the host, in ms. */
  elapsedMs: number;
  /**
   * A slow strike for the player: elapsedMs > softTimeoutMs AND the
   * units' own measured time (sum of `ms`, inside the isolate) is too, so a
   * busy host alone never gives strikes.
   */
  slow: boolean;
  /**
   * The instance with the largest per-unit time this tick (harness timing via
   * the real clock, never exposed to player code). Set when `slow` is true and
   * timings are available; the sim uses it to disable the slowest unit first.
   */
  slowestInstanceId?: string;
  /**
   * status 'timeout' only: the instanceId held in the isolate's `__current`
   * when the timeout hit, read with a short separate call. Undefined if it
   * could not be read (e.g. the timeout hit outside any update(), or the
   * probe itself failed): the sim then treats it as a player-level timeout.
   */
  culprit?: string;
  /**
   * status 'timeout' only: the sandbox process was frozen (not scheduled by
   * the OS or the hypervisor) for most of the tick, so the timeout is the
   * host's fault, not the player's code. The tick still idles, but nobody gets a
   * strike and it counts toward no timeout limit (one stall can be the
   * host).
   */
  hostStall?: boolean;
  /**
   * Number of output entries dropped as forged or duplicate. > 0 means the
   * sim records a player strike.
   */
  forged: number;
  /** Diagnostic text for 'bad-output' / 'crashed' (e.g. "Array buffer allocation failed"). */
  detail?: string;
  /**
   * status 'ok' only: what the factories' updateMinion() returned, at
   * most one entry per minion listed in `TickInput.minions`, sorted by
   * instanceId. Absent when no minion code ran.
   */
  minions?: MinionOutput[];
  /**
   * With `slow`: the slowest code this tick was `slowestInstanceId`'s
   * updateMinion() calls, not its update() (the sim then switches off that
   * factory's minion code instead of napping the factory).
   */
  slowestIsMinionCode?: true;
}

// ---------------------------------------------------------------------------
// The runner for one player
// ---------------------------------------------------------------------------

export type SpawnResult =
  /** hasMinion: the copy has an updateMinion() method (absent = none). */
  | { ok: true; hasMinion?: true }
  | {
      ok: false;
      /** Constructor threw / timed out, design failed to load, or unknown unitId. */
      error: { message: string; line?: number };
    };

/**
 * A live sandbox for one player for one battle. Fresh at every START,
 * disposed at battle end (disabled status lasts one battle only).
 *
 * Call order: create → spawn* (all instances, before tick 0) → tick* → dispose.
 * Calls must not overlap: await each tick before the next. tick() never
 * rejects; every failure is reported through TickResult.status.
 */
export interface PlayerRunner {
  readonly player: RunnerPlayer;
  /**
   * Designs that failed to evaluate at create time, by unitId (should be rare:
   * they passed validation, but evaluation is repeated in the new sandbox).
   */
  readonly loadErrors: ReadonlyMap<string, { message: string; line?: number }>;
  /** True once disposed (explicitly or after a crash). */
  readonly disposed: boolean;

  /**
   * Construct one copy of design `unitId` inside the sandbox and register it
   * under `instanceId`. The constructed object's own stats are
   * ignored by combat (the sim uses the snapshot); only its update() and any
   * extra state on `this` matter. A failed spawn means the sim treats that
   * instance as disabled for the battle (it still stands and can be hit).
   */
  spawn(instanceId: string, unitId: string): Promise<SpawnResult>;

  /** Run one tick for this player. Never rejects. */
  tick(input: TickInput): Promise<TickResult>;

  /** Release the sandbox. Idempotent. */
  dispose(): void;
}
