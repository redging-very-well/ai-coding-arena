// Shared types of the headless simulation (plan §9).
//
// Conventions used throughout sim/:
//   * Tick k (0-based) is the k-th simulation step. `world.tick` given to units
//     during that step is k.
//   * "Time" t counts COMPLETED ticks: a frame with `t` shows the state after
//     ticks 0..t-1 ran. Frame t=0 is the spawn state. Elimination ticks and the
//     battle's `endTick` use the same time base, so a frame at t can be
//     compared with them directly.
//   * Everything that iterates units does so in instanceId order (plain string
//     comparison), players in seat order. Never in Promise-resolve order.

import type { Corner, PlacementDTO, RankingEntryDTO, StatsSnapshot, UnitType } from '@pixel-clash/shared';
import type { PlayerRunner } from '../sandbox/runner.js';

/** Deterministic string order used for instanceIds and playerIds. */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/** One design a player fields this battle, with its price at lock time. */
export interface BattleUnitDesign {
  unitId: string;
  stats: StatsSnapshot;
  /** Rounded unit cost at lock time (§6). Used for the living-cost ranking. */
  cost: number;
}

export interface BattlePlayerSetup {
  playerId: string;
  /** Seat 0-3: instanceId prefix, and the order results are applied in. */
  seat: number;
  /** This round's zone (§9 Zones). */
  zone: Corner;
  /** The ≤ 3 designs this player fields. */
  units: readonly BattleUnitDesign[];
  /** Zone-local placements (one per cell). Order does not matter. */
  placements: readonly PlacementDTO[];
  /**
   * The player's sandbox for this battle (fresh, nothing spawned yet). The
   * engine spawns every instance and disposes the runner when the battle ends.
   */
  runner: PlayerRunner;
}

// ---------------------------------------------------------------------------
// Live state
// ---------------------------------------------------------------------------

export interface UnitErrorRecord {
  /** Tick (0-based step) the error happened in. */
  tick: number;
  message: string;
  line?: number;
}

/** Why a unit stopped acting. */
export type DisableReason =
  | 'errors' // reached the throw strike limit
  | 'timeout' // culprit of a hard timeout
  | 'slow' // slowest unit after too many slow strikes
  | 'spawn-failed' // constructor failed in the battle sandbox
  | 'player-timeouts' // the player's sandbox kept timing out
  | 'player-strikes' // the player's sandbox kept sending forged/bad output
  | 'player-slow' // slow strikes continued after the slowest unit was disabled
  | 'crashed'; // the player's sandbox crashed or ran out of memory

/** One unit on the field (engine-internal, mutable). */
export interface SimUnit {
  id: string;
  playerId: string;
  seat: number;
  unitId: string;
  stats: StatsSnapshot;
  cost: number;
  type: UnitType;
  radius: number;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  cooldownRemaining: number;
  /** False once removed (step 9). Dead units stay in the list for reports. */
  alive: boolean;
  disabled: boolean;
  disabledReason?: DisableReason;
  /** Spawned successfully in the runner (else it is disabled from the start). */
  spawned: boolean;
  // Frame flags.
  /** Moved in any tick since the last recorded frame. */
  movedSinceFrame: boolean;
  /** Fired in any tick since the last recorded frame. */
  firedSinceFrame: boolean;
  /** Faces left (sprite mirrored): last horizontal move or target direction. */
  facingLeft: boolean;
  outsideSafeZone: boolean;
  // Report data (§9 Damage metric / Value destroyed).
  /** Effective damage dealt: min(hit, target hp before the hit), credited when the hit lands. */
  damageDealt: number;
  /** Hits of this unit that took an enemy from > 0 to ≤ 0 hp. */
  kills: number;
  /** Sum of the full unit costs of those kills. */
  valueDestroyed: number;
  strikes: number;
  errors: UnitErrorRecord[];
  diedAtTick: number | null;
}

/** A homing projectile in flight (§9 Attacks). */
export interface Projectile {
  id: number;
  x: number;
  y: number;
  ownerId: string; // attacker instanceId
  targetId: string;
  damage: number;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** A unit's report counters as of a recorded frame (Skip trims to the shown frame, §9). */
export interface UnitCounters {
  damageDealt: number;
  kills: number;
  valueDestroyed: number;
  strikes: number;
  disabled: boolean;
}

/** Every unit's and player's counters as of one recorded frame. */
export interface CountersAtTick {
  /** instanceId → counters (units with no entry had all-zero counters). */
  units: Map<string, UnitCounters>;
  /** playerId → player-level strikes. */
  playerStrikes: Map<string, number>;
}

/** A player-level sandbox incident (not attributable to one unit). */
export interface PlayerIncident {
  tick: number;
  kind: 'timeout' | 'bad-output' | 'forged' | 'crashed' | 'slow' | 'disabled';
  message: string;
}

export interface PlayerOutcome {
  playerId: string;
  seat: number;
  zone: Corner;
  /** Time (completed ticks) at which the player's last unit died; null = survived. */
  eliminatedAtTick: number | null;
  /** Sum of the full costs of the player's living units at the end. */
  livingCost: number;
  livingUnits: number;
  /** Player-level strikes (forged or malformed sandbox output). */
  playerStrikes: number;
  timeouts: number;
  slowStrikes: number;
  /** True when ALL the player's units were disabled by a player-level rule. */
  disabled: boolean;
  disabledReason?: DisableReason;
  incidents: PlayerIncident[];
}

/** Per-instance report data (§10.3 battle report). */
export interface UnitReport {
  instanceId: string;
  playerId: string;
  unitId: string;
  unitName: string;
  cost: number;
  survived: boolean;
  hp: number;
  diedAtTick: number | null;
  damageDealt: number;
  kills: number;
  valueDestroyed: number;
  strikes: number;
  disabled: boolean;
  disabledReason?: DisableReason;
  errors: UnitErrorRecord[];
}

export type BattleEndReason = 'elimination' | 'timeout' | 'stopped';

export interface BattleResult {
  /** Completed ticks when the sim stopped (= the last frame's `t`). */
  endTick: number;
  endReason: BattleEndReason;
  /** Sorted by seat. */
  players: PlayerOutcome[];
  /** Sorted by instanceId. */
  units: UnitReport[];
  /** Ranking and round scores at the sim's end, kicked players excluded (§9 Ranking, Points). */
  ranking: RankingEntryDTO[];
}
