// Shared types of the headless simulation.
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
//   * Sides: free-for-all every player is a side of their own; in
//     team mode (every setup carries a `teamId`) a side is a team. Allies,
//     friendly fire, elimination, End and ranking work on sides.

import type {
  BodyType,
  DamageSplitDTO,
  Element,
  MinionKind,
  MinionOrder,
  PlacementDTO,
  Point,
  RankingEntryDTO,
  StatsSnapshot,
  TeamRoundRankDTO,
  ZoneRef,
} from '@pixel-clash/shared';
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
  /** Rounded unit cost at lock time. Used for the living-cost ranking. */
  cost: number;
}

export interface BattlePlayerSetup {
  playerId: string;
  /** Seat 0-7: instanceId prefix, and the order results are applied in. */
  seat: number;
  /** This round's zone: a zone of the battle's map, or a Corner of the 800 Corners map. */
  zone: ZoneRef;
  /**
   * Team mode only: the player's team 0..T−1. Give it to every player
   * or to none; without it every player is their own side (teamId = seat).
   */
  teamId?: number;
  /** The player's display name: shown to units only with `BattleOptions.revealNames` (default: the playerId). */
  name?: string;
  /** Team mode: the team's name (e.g. "Team 2"), shown to units only with `revealNames`. */
  teamName?: string;
  /** The designs this player fields (≤ 4 unit + ≤ 4 building types). */
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

/** The stats a body fights with: a design's snapshot, or the built-in minion's. */
export type SimStats = Omit<StatsSnapshot, 'type'> & { readonly type: BodyType };

/** Wall steering memory. */
export interface SlideMemory {
  /** +1 / −1 along `axis`. */
  side: 1 | -1;
  /** The tangent axis the body slides along. */
  axis: 'x' | 'y';
  /** The destination when the memory started. */
  origin: Point;
  /** Ticks in a row without a wall hit. */
  quiet: number;
  /** Already turned back once (dead end). */
  flipped: boolean;
}

/** How the last move went. */
export type PathingMode = 'direct' | 'detour' | 'no-route';

/** A body's current route plan. */
export interface RoutePlan {
  mode: PathingMode;
  /** Where to steer; null = straight at the destination. */
  waypoint: Point | null;
  /** no-route: the node (index, size class) of the wall the body goes to break, else -1. */
  press: number;
  /** Tick of the next scheduled re-plan. */
  nextPlan: number;
}

/** A factory's production state. */
export interface FactoryState {
  productionInterval: number;
  /** Ticks towards the next minion (0..productionInterval). */
  timer: number;
  /** Minions this factory can still make (of the E it paid for). */
  minionsLeft: number;
  /**
   * Minions it can still make before time runs out (`canMakeOf`):
   * ≤ minionsLeft, 0 at the time limit. A factory is a fighter while it is
   * > 0, and its living value counts these, not minionsLeft.
   */
  canMake: number;
  /** Its timer was full but every spawn spot was covered at the last try (cleared by a spawn). */
  noSpot: boolean;
  /** Minions made so far (stored ones included). */
  made: number;
  /** Minions that left the factory so far (the next one is `${id}-m${released + 1}`). */
  released: number;
  /** M8.6: the minion kind it builds. */
  kind: MinionKind;
  /** M8.8: its minions' element (`minionElement`; medics: normal). Absent = normal. */
  element?: Element;
  /** Minions saved up inside before they leave together (1 = each leaves at once). */
  burst: number;
  /** Built minions waiting inside (no bodies; lost with the factory). */
  stored: number;
  /** A `release` was asked for and hasn't happened yet. */
  releaseRequested: boolean;
  /** The squad order and its target (swarm: an enemy, guard: an ally); kept after the factory dies. */
  order: MinionOrder;
  orderTargetId: string | null;
  /** Minions lost inside when the factory died (report). */
  storedLost: number;
  /** Where its `attack` minions go; kept after the factory dies (minions keep the last one). */
  rally: Point;
  /** Returned `hold` this tick. */
  holding: boolean;
  /** Rounded body price: its living value is bodyCost + minionValue × canMake. */
  bodyCost: number;
  minionValue: number;
  /** Spawned a minion since the last recorded frame (the door flash). */
  spawnedSinceFrame: boolean;
  /** Minions it made that died (report). */
  minionsLost: number;
}

/** M8.8 (burn): one burn on a body, per owning player (at most 8 per body). */
export interface BurnRecord {
  /** The player whose fire hits made it. */
  ownerId: string;
  /** That player's seat (pulses of different owners land in seat order). */
  seat: number;
  /** HP the burn will still take (before shields). */
  pool: number;
  pulsesLeft: number;
  /** Tick of the next pulse: 30 ticks apart, counted from the record's first hit. */
  nextPulseTick: number;
  /** The owner's last fire attacker: pulses credit it (its owner and type), even after it died. */
  source: SimUnit;
}

/** M8.8: the strongest aura of each kind on a body this tick, in %, and who gives it. */
export interface AuraState {
  haste: number;
  might: number;
  shield: number;
  hasteSrc: SimUnit | null;
  mightSrc: SimUnit | null;
  shieldSrc: SimUnit | null;
}

/** M8.8: effective damage per kind. */
export type DamageSplit = DamageSplitDTO;

/** One unit on the field (engine-internal, mutable). */
export interface SimUnit {
  id: string;
  playerId: string;
  seat: number;
  /** The side: the team in team mode, else the seat. */
  teamId: number;
  /** The design (a minion: its factory's design). */
  unitId: string;
  stats: SimStats;
  /** Full price: walls and factories their price, minions minionValue (value destroyed). */
  cost: number;
  type: BodyType;
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
  // Report data.
  /** Effective damage dealt: min(hit, target hp before the hit), credited when the hit lands. */
  damageDealt: number;
  /** Most ticks in a row a wall blocked it (report hint). */
  blockedTicksMax?: number;
  /** Hits of this unit that took an enemy from > 0 to ≤ 0 hp. */
  kills: number;
  /** Sum of the full unit costs of those kills. */
  valueDestroyed: number;
  strikes: number;
  errors: UnitErrorRecord[];
  diedAtTick: number | null;
  /** The unit whose hit took it to ≤ 0 hp (undefined: not killed by a hit, e.g. sudden death). Credits the crumbled minions of a factory. */
  killedBy?: SimUnit;
  // M8.5. Optional so plain test fixtures stay valid; the engine always sets them.
  /** The wall that stopped or turned the last move, else null. */
  blockedBy?: string | null;
  /** Ticks in a row a wall has been in the way. */
  blockedTicks?: number;
  /** A wall turned a move since the last recorded frame (frame `blocked` flag). */
  blockedSinceFrame?: boolean;
  slide?: SlideMemory | null;
  /** M8.7: the mode of the last move ('direct' before the first one). */
  pathing?: PathingMode;
  /** M8.7: the current route plan (sim/pathing.ts). */
  route?: RoutePlan | null;
  /** Time (completed ticks) the body appeared: 0, or a minion's spawn. */
  spawnedAtTick?: number;
  /** Factories. */
  factory?: FactoryState;
  /** Minions: the factory that made it (alive or not), its number there and its kind. */
  minion?: { factory: SimUnit; n: number; kind?: MinionKind };
  /**
   * Factories (2026-10-26): the design has player-written
   * minion code. Its state: `off` once it was switched off (too many errors,
   * timeouts or slow ticks; its minions use the built-in logic from then on),
   * and the strike / timeout counts that switch it off. Absent: no minion code.
   */
  minionCode?: { off: boolean; strikes: number; timeouts: number };
  /** Walls: hp as last listed in a frame (walls are only listed when it changed). */
  frameHp?: number;
  // M8.8. Optional so plain test fixtures stay valid; the engine always sets them.
  // `cooldownRemaining` is a float that drops by the tempo (views show Math.ceil).
  /** Ticks until the freeze ends (0 = not frozen). */
  frozen?: number;
  /** Burns on the body, one per owning player, in seat order. */
  burns?: BurnRecord[];
  /** HP it can still be healed in this 60-tick window (5% of max HP; 0 for walls and factories, and from sudden death). */
  healRoom?: number;
  /** The auras on it this tick (computed at the start of the tick). */
  aura?: AuraState;
  /** Report: HP its heals restored, heals spent on cleanses, shatters + overload zaps, aura assist, damage by kind. */
  healing?: number;
  cleanses?: number;
  combos?: number;
  assist?: number;
  damageSplit?: DamageSplit;
  // Redesign (accuracy): px moved in step 4 of the last tick (0 = standing), and the report counters.
  moved?: number;
  /** Ranged shots of this unit that missed a moving target. */
  misses?: number;
  /** Ranged shots at this unit that missed. */
  dodges?: number;
}

/** A homing projectile in flight. */
export interface Projectile {
  id: number;
  x: number;
  y: number;
  ownerId: string; // attacker instanceId
  targetId: string;
  /** Fixed at fire time: the wall multiplier and (M8.8) the attacker's might are baked in. */
  damage: number;
  /** M8.8: the attacker's element and splash radius at fire time (absent = normal / 0). */
  element?: Element;
  splash?: number;
  /** M8.8: the might % baked into `damage`, and the aura that gave it (assist). */
  might?: number;
  mightSrc?: SimUnit | null;
  /** Redesign (accuracy): a missed shot flies to where the target was at fire time and lands there (splash only). */
  miss?: { x: number; y: number };
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** A unit's report counters as of a recorded frame (Skip trims to the shown frame). */
export interface UnitCounters {
  damageDealt: number;
  kills: number;
  valueDestroyed: number;
  strikes: number;
  disabled: boolean;
  /** M8.8: HP healed and combos (Best Medic, Combo Master); absent = 0. */
  healing?: number;
  combos?: number;
  /** M8.8: report-only counters, trimmed by Skip like the rest; absent = 0. */
  cleanses?: number;
  assist?: number;
  damageSplit?: DamageSplit;
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
  zone: ZoneRef;
  /** Team mode only: the player's team (ranking groups by it). */
  teamId?: number;
  /** Time (completed ticks) at which the player's last unit died; null = survived. */
  eliminatedAtTick: number | null;
  /** Living value of the player's units at the end (walls $0, factories body + unbuilt minions). */
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

/** Per-instance report data. */
export interface UnitReport {
  instanceId: string;
  playerId: string;
  /** The design; a minion carries its factory's (so its damage counts for the factory type). */
  unitId: string;
  unitName: string;
  cost: number;
  /** M8.5: the body type (absent = soldier/tower, for older fixtures). */
  type?: BodyType;
  /** Living value at the end (walls 0, factories body + minionValue × left); 0 when dead. */
  livingValue?: number;
  /** Time the body appeared (minions: their spawn). */
  spawnedAtTick?: number;
  /** Minions: the factory's instanceId. */
  factoryId?: string;
  /** Factories: price parts and production counters. */
  factory?: { bodyCost: number; minionValue: number; minionsLeft: number; minionsMade: number; minionsLost: number; canMake?: number; stored?: number; storedLost?: number };
  /** Soldiers and minions: the most ticks in a row a wall blocked it. */
  blockedTicksMax?: number;
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
  /** M8.8: not a fighter even while alive (damage-0 units, medic minions, medic factories). */
  nonFighter?: boolean;
  /** M8.8: a heal-support unit or a medic factory (the "never healed anyone" hint). */
  healer?: boolean;
  /** M8.8: HP its heals restored, cleanses, shatters + overload zaps, aura assist, damage by kind. */
  healing?: number;
  cleanses?: number;
  combos?: number;
  assist?: number;
  damageSplit?: DamageSplit;
  /** Redesign (accuracy): ranged shots that missed, and shots at it that missed. */
  misses?: number;
  dodges?: number;
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
  /** Ranking and round scores at the sim's end, kicked players excluded. */
  ranking: RankingEntryDTO[];
  /** Team mode only: the round's team ranking. */
  teams?: TeamRoundRankDTO[];
}
