// REST / WebSocket / MCP data-transfer types (plan §10).
//
// Everything that reaches a client is built per recipient by
// packages/server/src/services/visibility.ts (§3 privacy). Optional fields are
// OMITTED, never filled with another player's data, before the reveal.
//
// ===========================================================================
// Quick reference for client builders
// ===========================================================================
//
// Auth
//   * Web pages: POST /api/players or /api/login sets the httpOnly cookie
//     `pc_session`; POST /api/admin/login sets `pc_admin`. Use
//     `credentials: 'same-origin'` (the default for same-origin fetch).
//   * Claude / curl: `Authorization: Bearer pc_…` (the player's apiKey).
//
// REST (JSON, prefix /api). Errors: HTTP 4xx/5xx with ApiErrorBody; a failed
// unit validation is HTTP 422 with the §7 ValidationFailure body.
//   GET    /health                    -> HealthDTO
//   POST   /players      {name,pin}   -> LoginResponse (+ cookie)   NAME_TAKEN GAME_FULL BAD_PIN_FORMAT BAD_NAME_FORMAT
//   POST   /login        {name,pin}   -> LoginResponse (+ cookie)   BAD_LOGIN RATE_LIMITED
//   POST   /logout                    -> {ok:true}
//   GET    /me                        -> MeResponse
//   GET    /rules                     -> RulesDTO
//   GET    /contract                  -> ContractDTO
//   GET    /join                      -> JoinInfoDTO (join URL + QR SVG for /screen)
//   GET    /state                     -> GameStateDTO (`me` only with a player session/key)
//   POST   /units/validate {source,unitId?,baseVersion?} -> ValidationResult (dry run; 422 on failure)
//   POST   /units          {source,unitId?,baseVersion?} -> SubmitUnitResponse (PLAN only)
//                                        baseVersion: the version the edit started from; if the unit's
//                                        latest version differs -> 409 UNIT_CHANGED {details.version}
//   GET    /units                     -> UnitCardDTO[]
//   GET    /units/:id                 -> UnitSourceDTO
//   DELETE /units/:id                 -> {ok:true}  (PLAN only; templates refused)
//   PUT    /round/selection {unitIds} -> {selection: string[]}            (PLAN only; own unitIds and
//                                        `armory:<armoryId>` ids when Open Armory is on, ≤ 3 in total)
//   PUT    /round/placement {placements} -> PlacementResponse            (PLACEMENT only)
//   POST   /round/ready {ready}       -> {ready: boolean}                 (PLAN and PLACEMENT; separate per phase,
//                                        reset on phase change; PLAN needs a selection: NOTHING_SELECTED)
//   GET    /battles/:round/report     -> BattleReportDTO  (own units; after playback ends)
//   GET    /battles/:round/replay     -> ReplayDTO        (after playback ends)
//   GET    /kit.zip                   -> personal kit zip (player)
//   GET    /setup/kit.zip             -> generic kit zip (no auth)
//   GET    /setup                     -> SetupInfoDTO (no auth: LAN/play URL + QR, seat cards; never the seat password)
//   GET    /claude-seats              -> ClaudeSeatsDTO (player; the Claude seat picker, §11.2)
//   PUT    /me/claude-seat {seat: 1-8 | null} -> {claudeSeat} (player, any phase, 1/s;
//                                        BAD_CLAUDE_SEAT, CLAUDE_SEAT_TAKEN 409 with details {seat, takenBy})
// Admin (cookie pc_admin):
//   POST /admin/login {password}      -> {ok:true}
//   POST /admin/logout                -> {ok:true}
//   GET  /admin/session               -> {admin: boolean}
//   POST /admin/match {rounds?, armory?, mapStyle?, teamMode?} -> GameStateDTO (LOBBY -> PLAN, needs 2-8 players;
//                                        armory = Open Armory, §9.1; mapStyle null = default for the player count,
//                                        omitted = the draft's; teamMode omitted = the draft's ('ffa' by default), §9.2;
//                                        BAD_MAP_STYLE / BAD_TEAM_MODE with details {players, valid})
//   GET  /admin/match/setup           -> MatchSetupDTO (the LOBBY draft, or the running match's setup)
//   PUT  /admin/match/setup {mapStyle?, teamMode?} -> MatchSetupDTO (LOBBY only; re-balances the draft teams)
//   POST /admin/teams/swap {playerA, playerB} -> {teams: TeamDTO[]} (LOBBY, team-mode draft only; SAME_TEAM, NO_TEAMS)
//   POST /admin/match/new             -> GameStateDTO (MATCH_RESULTS -> LOBBY)
//   POST /admin/phase/next            -> GameStateDTO
//   POST /admin/phase/skip            -> GameStateDTO
//   POST /admin/timer {setSeconds?,addSeconds?,paused?} -> TimerDTO
//   POST /admin/start {force?}        -> GameStateDTO (PLACEMENT -> BATTLE)
//   POST /admin/phase/advance {delaySec?} -> GameStateDTO (countdown, default 3 s, then Next from PLAN /
//                                        START without force from PLACEMENT; PLACEMENT needs everyone Ready)
//   POST /admin/phase/advance/cancel  -> GameStateDTO (cancels a host or auto countdown)
//   POST /admin/battle {paused?,speed?} -> PlaybackDTO
//   POST /admin/players/:id/kick {deleteData?} -> {ok:true, effective:'now'|'after-battle'}
//   POST /admin/players/:id/pin {pin} -> {ok:true}
//   POST /admin/players/:id/rotate-key -> {apiKey}
//   POST /admin/players/:id/units {source,unitId?,baseVersion?,dryRun?} -> ValidationResult / SubmitUnitResponse
//   POST /admin/units/:playerId/:unitId/sprite {hidden} -> {ok:true}
//   GET  /admin/config                -> AdminConfigResponse
//   PUT  /admin/config  DeepPartial<GameConfig> -> AdminConfigResponse
//   DELETE /admin/config/economy-reset -> AdminConfigResponse (M8.8: dismiss the economy-reset banner)
//   GET  /admin/overview              -> AdminOverviewDTO
//   POST /admin/wipe {confirm:'WIPE'} -> {ok:true}
//   PUT  /admin/setup {claudeBoxHost?, preferredUrl?, seatSecret?} (null/"" clears) -> SetupInfoDTO & {seatSecretSet}
//                                        (BAD_SEAT_SECRET: 12-64 of A-Z a-z 0-9 . _ ~ -)
//   GET  /admin/claude-seats[?details=1] -> AdminClaudeSeatsDTO (seatSecret + directUrl only with details=1)
//   PUT  /admin/claude-seats/:seat {playerId | null} -> AdminClaudeSeatsDTO (assign/move/unassign; BAD_CLAUDE_SEAT, NOT_FOUND)
//   POST /admin/claude-seats/check    -> AdminClaudeSeatsDTO (probes every seat now)
//
// Seat terminal proxy (§11.2, same origin, not under /api; cookie auth: the
// player assigned to Claude seat N, or the admin):
//   GET/HEAD /terminal/<N>/…           -> the seat's ttyd (page, assets); friendly HTML error pages
//   GET      /terminal/<N>/token       -> {"token":"pixel-clash"} (answered by the proxy)
//   WS       /terminal/<N>/ws[?pane=id] -> the seat's terminal; one live terminal per seat, newest wins
//   POST /admin/screen ScreenCommandDTO -> {ok:true, screens} (projector remote: replay, 1x/2x, join poster;
//                                        replay only in RESULTS/MATCH_RESULTS; BAD_REQUEST for an unknown action)
//
// WebSocket /ws: send ClientWsMessage `{type:'hello', role}` after open; the
// cookie decides who you are (a 'player' hello without a valid session is
// answered with a toast and treated as 'screen'). The server then pushes
// ServerWsMessage values (see below). Battle frames arrive in batches every
// ~50 ms at playback speed; clients interpolate between frames.
//   * On hello the server replies 'hello' (granted role), then 'state', then
//     'private' (players), and during BATTLE the 'battle:reveal' plus the
//     current frame, so a reloaded page catches up.
//   * At START: 'battle:reveal' at once, then playback holds ~3 s for the
//     "3-2-1 CLASH!" animation before 'battle:frames' start flowing.
//   * 'state' is pushed on every change and at 1 Hz while a timer (or the
//     battle countdown) runs. In RESULTS/MATCH_RESULTS it carries `lastBattle`.
//   * The 'admin' role receives the same 'state' as the projector; the admin
//     page reads details from GET /api/admin/overview (refetch on 'state').
//   * Instance ids are `${seat}-${row}-${col}`; colour by seat (0-7).
//   * Maps and teams (§9.2): `MapDTO` is public (no zone owners before START),
//     `TeamDTO` is public; teammates' live selections/zones/placements travel
//     only in each member's `private.team` block (`TeamPrivateDTO`).
//   * Phase gates (§10.2): submit/retire/selection only in PLAN; placement
//     only in PLACEMENT; ready in PLAN and PLACEMENT; validate always. A closed gate is HTTP 409
//     PHASE_CLOSED with details {phase, opensIn, secondsLeft?}.
// ===========================================================================

import type { AwardId, MatchAwardDTO } from './awards.js';
import type { CostBreakdown } from './cost.js';
import type { BodyType, Element, MapStyle, MinionKind, MinionOrder, SpriteSpec, StatsSnapshot, UnitGroup, UnitType } from './contract.js';
import type { ValidationError, ValidationResult, ValidationSuccess, ValidationWarning } from './errors.js';
import type { Corner } from './geometry.js';
import type { Facing } from './maps.js';
import type { TeamMode } from './teams.js';

export const PHASES = ['LOBBY', 'PLAN', 'PLACEMENT', 'BATTLE', 'RESULTS', 'MATCH_RESULTS'] as const;
export type Phase = (typeof PHASES)[number];

export type ViewerRole = 'player' | 'screen' | 'admin';

export const SESSION_COOKIE = 'pc_session';
export const ADMIN_COOKIE = 'pc_admin';

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

export interface PlayerDTO {
  id: string;
  name: string;
  /** Player slot 0-7: fixes colour, seat-number badge (seat + 1) and instance-id prefix. Not a zone. */
  seat: number;
}

/** Public status of a player (visible to everyone, §3 privacy table). */
export interface PlayerStatusDTO extends PlayerDTO {
  connected: boolean;
  /** Submitted at least one unit during the current PLAN. */
  submitted: boolean;
  /** Has a (non-empty) selection for this round. */
  selected: boolean;
  /** Ready toggle: PLAN = army picked and done, PLACEMENT = army placed (reset on every phase change). */
  ready: boolean;
  points: number;
  /** False when the player joined mid-round: "you're in from the next round". */
  active: boolean;
  /** Kicked during BATTLE; removed when the battle ends. */
  leaving?: boolean;
  /** Team mode: the player's team (team membership is public, §3). */
  teamId?: number;
  /** Joined after Start match in team mode: sits out until the next match (§4). */
  benched?: boolean;
}

/** POST /players, POST /login, MCP login. */
export interface LoginResponse {
  player: PlayerDTO;
  apiKey: string;
}

/** GET /me */
export interface MeResponse {
  player: PlayerDTO;
  apiKey: string;
  seat: number;
  connected: boolean;
  active: boolean;
  /** Team mode: own team. */
  teamId?: number;
  /** Joined after Start match in team mode: sits out until the next match (§4). */
  benched: boolean;
  /** The player's Claude seat 1-8 (the laptop's terminal, §11.2), or null. Not the game seat. */
  claudeSeat: number | null;
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

export type UnitStatus = 'valid' | 'invalid';

export interface UnitCardDTO {
  unitId: string;
  name: string;
  version: number;
  stats: StatsSnapshot;
  /** M8.5: 'unit' (soldiers) or 'building' (towers, walls, factories): the two pick limits (§5.2). */
  group?: UnitGroup;
  /** M8.6 factories: the squad orders its update() gave in the dry run (§7), e.g. ['swarm', 'attack']. */
  orders?: MinionOrder[];
  /** M8.8 heal support: whether update() returned { action: 'heal' } in the dry run (§7). */
  healUsed?: boolean;
  /** M8.8: 2 = made for the ×5 economy; older designs have 1 (or none) and may carry W_OLD_SCALE (§6 M8.8 migration). */
  scaleVersion?: number;
  cost: number;
  breakdown: CostBreakdown;
  status: UnitStatus;
  /** Present when status is 'invalid' (after a re-price or bounds change). */
  error?: ValidationError;
  warnings: ValidationWarning[];
  isTemplate: boolean;
  /** The unit's pixel-art sprite (owner only; null = draw the fallback from color+shape). */
  sprite: SpriteSpec | null;
  /** The facilitator hid this sprite (moderation): draw the fallback instead. */
  spriteHidden: boolean;
  /** In the current selection. */
  selected: boolean;
  /** ms epoch of the latest version. */
  updatedAt: number;
  lastBattle?: UnitBattleSummaryDTO;
}

export interface UnitSourceDTO extends UnitCardDTO {
  source: string;
}

export interface UnitBattleSummaryDTO {
  round: number;
  /**
   * The name the unit fought under ("Ogre (Ninja Sam)" for a borrowed one,
   * §9.1). A later Armory replacement or revision may rename the live card.
   */
  name?: string;
  survived: number;
  fielded: number;
  damageDealt: number;
  kills: number;
  valueDestroyed: number;
  strikes: number;
  disabled: number;
  /** M8.8: HP its copies (and a factory's medic minions) healed. */
  healing?: number;
}

export interface ValidateUnitRequest {
  source: string;
  unitId?: string;
  /** Optimistic concurrency: the version this edit started from (needs unitId). */
  baseVersion?: number;
}
export type ValidateUnitResponse = ValidationResult;
/**
 * POST /units success body (HTTP 200): the §7 success result (with the stored
 * unitId/version in `unit`) plus `unitId`/`version` at the top level.
 * Failures are the §7 ValidationFailure (HTTP 422) or an ApiErrorBody.
 */
export type SubmitUnitResponse = ValidationSuccess & { unitId: string; version: number };

// ---------------------------------------------------------------------------
// Open Armory (§9.1)
// ---------------------------------------------------------------------------

/** Selection ids of borrowed units: `armory:<armoryId>`. */
export const ARMORY_PREFIX = 'armory:';

/** True for an `armory:<armoryId>` selection/placement id. */
export function isArmoryUnitId(unitId: string): boolean {
  return unitId.startsWith(ARMORY_PREFIX);
}

/** "Ogre (Ninja Sam)": how a borrowed unit type is named everywhere (§9.1). */
export function armoryDisplayName(unitName: string, creatorName: string): string {
  return `${unitName} (${creatorName})`;
}

/**
 * A borrowable Armory unit, as a unit card: `unitId` is the selection id
 * (`armory:<armoryId>`) and `name` the display name "Ogre (Ninja Sam)";
 * `stats.name` stays the raw unit name. Never carries source code.
 */
export interface ArmoryCardDTO extends UnitCardDTO {
  armoryId: string;
  /** "<unit name> (<creator name>)" (same as `name`). */
  displayName: string;
  creatorId: string;
  creatorName: string;
  /** The round whose battle added (or last updated) this entry. */
  roundAdded: number;
}

/** The match's Open Armory switch, in every game state (public). */
export interface ArmoryInfoDTO {
  /** Set in "Start match" and locked for the whole match. */
  enabled: boolean;
  /** Number of entries (entries exist only after their battle was released). */
  entries: number;
}

// ---------------------------------------------------------------------------
// Round: selection, placement
// ---------------------------------------------------------------------------

export interface PlacementDTO {
  unitId: string;
  /** Zone-local, 0-5: row 0 = the zone's front row, (0,0) = the front cell nearest the centre (§9.2). */
  col: number;
  row: number;
}

export interface SelectionRequest {
  unitIds: string[];
}
export interface PlacementRequest {
  placements: PlacementDTO[];
}
/** Copy counts / caps per group (M8.5, §5.2 Copies): fighters run code, walls don't. */
export interface CopyCountsDTO {
  /** Soldiers + towers + factories. */
  fighters: number;
  /** Factories (also counted in `fighters`). */
  factories: number;
  walls: number;
}

/** A non-fatal placement warning (M8.5): a soldier or factory boxed in by walls. */
export interface PlacementWarningDTO {
  code: 'W_TRAPPED';
  unitId: string;
  col: number;
  row: number;
  message: string;
}

export interface PlacementResponse {
  placements: PlacementDTO[];
  spent: number;
  remaining: number;
  /** M8.5: copies placed per group. */
  counts?: CopyCountsDTO;
  /** M8.5: W_TRAPPED for every soldier/factory walled in (non-fatal). */
  warnings?: PlacementWarningDTO[];
}

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------

export interface TimerDTO {
  /** Seconds left in the current phase, or null when the phase has no timer. */
  secondsLeft: number | null;
  paused: boolean;
  /** PLACEMENT only: the timer ran out; waiting for the host to press START. */
  expired?: boolean;
}

// ---------------------------------------------------------------------------
// Maps and teams (§9.2)
// ---------------------------------------------------------------------------

/** One zone of a map (public: no owner before START). */
export interface MapZoneDTO {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  facing: Facing;
}

/** A resolved map (shared/maps.ts `mapDTO`). */
export interface MapDTO {
  style: MapStyle;
  players: number;
  width: number;
  height: number;
  zones: MapZoneDTO[];
}

/** Ground-ring pattern of a team, so teams never rely on colour alone. */
export type TeamPattern = 'solid' | 'dashed' | 'double' | 'dotted';

/** A team (public). Fixed from Start match to New match. */
export interface TeamDTO {
  /** 0..T−1 (= `teamId` in the unit views, §5). */
  teamId: number;
  name: string;
  color: string;
  pattern: TeamPattern;
  /** Player ids in join order (the block-rotation slots, §9.2). */
  members: string[];
}

/** One team's result in one battle (shared by every member). */
export interface TeamRoundRankDTO {
  teamId: number;
  /** 1-based; tied teams share the better place. */
  place: number;
  /** round((P − 1) × (T − place) / (T − 1)), given to every member. */
  placePoints: number;
  /** Team living cost: the sum over the ranked members' living units. */
  livingCost: number;
  /** When the team's last (ranked) unit died; null = survived. */
  eliminatedAtTick: number | null;
  /** Ranked members (kicked ones left out). */
  members: string[];
}

/** Team table row (§9.2 Team scoring). */
export interface TeamTableRowDTO {
  teamId: number;
  name: string;
  color: string;
  pattern: TeamPattern;
  members: string[];
  /** Average of the current members' match totals, one decimal. */
  points: number;
  /** Tie-break: the sum of the team's place points over the match (counted once per round). */
  placePoints: number;
  /** 1-based; equal points and place points share a place. */
  place: number;
}

/** Match setup: the LOBBY draft (`PUT /admin/match/setup`) and the started match. */
export interface MatchSetupDTO {
  /** The host's style override, or null for the default by player count. */
  mapStyle: MapStyle | null;
  teamMode: TeamMode;
  map: MapDTO;
  teams: TeamDTO[] | null;
  validStyles: MapStyle[];
  validTeamModes: TeamMode[];
}

/** `/state` `match` block (§10.3). */
export interface MatchInfoDTO {
  mapStyle: MapStyle;
  teamMode: TeamMode;
  /** The current map; no zone owners before START. */
  map: MapDTO | null;
  teams: TeamDTO[] | null;
  teamTable: TeamTableRowDTO[] | null;
}

/** A teammate as seen by the other members (team privacy, §9.2). */
export interface TeamMemberPrivateDTO {
  playerId: string;
  name: string;
  seat: number;
  ready: boolean;
  zone: MapZoneDTO | null;
  /** Selected types as unit cards (never source, versions or unselected designs). */
  selection: UnitCardDTO[];
  placement: PlacementDTO[];
  spent: number;
}

/** The `private.team` block (team mode only). */
export interface TeamPrivateDTO {
  teamId: number;
  name: string;
  color: string;
  members: TeamMemberPrivateDTO[];
}

/** Match standings row (§9 Match standings). */
export interface ScoreboardEntryDTO {
  playerId: string;
  name: string;
  seat: number;
  /** Team mode: the player's team. */
  teamId?: number;
  /** Total round points this match. */
  points: number;
  /** Total effective damage dealt this match (the tie-break). */
  damage: number;
  /** 1-based match place: equal points AND equal damage share a place. */
  place: number;
  /** Badges won this match, by badge (0 when none). */
  badges: Record<BadgeId, number>;
}

/** The visibility-filtered `me` block of GET /state (owner only). */
export interface MyStateDTO {
  playerId: string;
  budget: number;
  /** Credits spent by the current placement. */
  spent: number;
  /** PLAN: the chosen unitIds. From PLACEMENT on: the locked selection (palette). */
  selection: string[];
  placement: PlacementDTO[];
  /** This round's zone on the map (§9.2). Only sent to the owner, from the start of PLACEMENT. */
  myZone: MapZoneDTO | null;
  ready: boolean;
  submissionsOpen: boolean;
  /** False when joined mid-round ("you're in from the next round"). */
  active: boolean;
  /** "Copy last layout" is available (a previous layout exists). */
  hasLastLayout: boolean;
  /** M8.5: the copy caps per group (§5.2 Copies). */
  copyCaps?: CopyCountsDTO;
  /** Team mode: own team. */
  teamId?: number;
  /** Joined after Start match in team mode: sits out until the next match (§4). */
  benched?: boolean;
  /** Team mode: teammates' live selection/zone/placement (§9.2 Team privacy). */
  team?: TeamPrivateDTO | null;
  /** MATCH_RESULTS only: the match awards this player won (details in `GameStateDTO.matchAwards`, §9 Match awards). */
  awards?: AwardId[];
}

/** Playback state of the current battle. */
export interface PlaybackDTO {
  /** Playback clock in sim ticks (60 per second of battle). */
  tick: number;
  speed: 1 | 2;
  paused: boolean;
  /** The sim is behind playback ("thinking…"). */
  thinking: boolean;
  /** Battle length in ticks (config timers.battleTicks). */
  totalTicks: number;
}

/** The countdown to the next step (§3 pending advance). */
export interface PendingAdvanceDTO {
  /** PLAN → PLACEMENT, PLACEMENT → BATTLE, RESULTS → the next round's PLAN or (last round) MATCH_RESULTS. */
  to: 'PLACEMENT' | 'BATTLE' | 'PLAN' | 'MATCH_RESULTS';
  /** 'host' = the facilitator pressed go; 'auto' = everyone Ready with the auto-advance option. */
  by: 'host' | 'auto';
  /** Whole seconds left (≥ 1). */
  secondsLeft: number;
}

export interface GameStateDTO {
  phase: Phase;
  round: number;
  rounds: number;
  timer: TimerDTO;
  players: PlayerStatusDTO[];
  /**
   * Sorted by points (desc), then match damage (desc), then seat. Points are
   * added only when a battle's playback ends.
   */
  scoreboard: ScoreboardEntryDTO[];
  /** Sandbox mode; anything but 'ivm' shows a red banner (§12.3). */
  sandboxMode: 'ivm' | 'process' | 'inproc-unsafe';
  /** BATTLE only: playback clock. */
  battle?: PlaybackDTO;
  /** RESULTS / MATCH_RESULTS: the released ranking of the last battle. */
  lastBattle?: BattleEndDTO;
  /** Open Armory (§9.1): on/off for this match. */
  armory: ArmoryInfoDTO;
  /** Map, teams and team table (§9.2). */
  match?: MatchInfoDTO;
  /**
   * PLAN / PLACEMENT: every active player (≥ 1) is Ready in the current phase
   * (PLAN Ready = army picked, PLACEMENT Ready = army placed). False otherwise.
   */
  allReady: boolean;
  /**
   * A countdown to the next step is running (PLAN → PLACEMENT or PLACEMENT →
   * BATTLE): started by the host (cancellable) or by the auto-advance option
   * (timers.autoAdvanceWhenAllReady). Absent when none runs.
   */
  pendingAdvance?: PendingAdvanceDTO;
  /**
   * MATCH_RESULTS only: the match awards in ceremony order (§9 Match awards),
   * each with its winner(s), stat and best unit (fielded designs only, never
   * source). Absent in every other phase.
   */
  matchAwards?: MatchAwardDTO[];
  /** Owner-only block. */
  me?: MyStateDTO;
}

export interface HealthDTO {
  ok: true;
  version: string;
  phase: Phase;
}

/** GET /join: where players join (projector QR, §12.2). */
export interface JoinInfoDTO {
  /** `http://<lan-ip>:<port>/play` (the request's Host when it is not localhost). */
  joinUrl: string;
  /** Every LAN base URL of the server. */
  lanUrls: string[];
  /** QR code of `joinUrl` as an SVG document (black on white). */
  qrSvg: string;
}

// ---------------------------------------------------------------------------
// Rules / contract
// ---------------------------------------------------------------------------

/** GET /rules, MCP get_rules: the config plus explanations (shape is informative). */
export interface RulesDTO {
  phases: readonly Phase[];
  timers: Record<string, number>;
  budget: number;
  caps: Record<string, number>;
  costFormula: string;
  /** Cost coefficients (§6), incl. the `wall` and `factory` blocks (M8.5). */
  coefficients: Record<string, number | Record<string, number>>;
  bounds: Record<string, unknown>;
  /** §9 Points: place points + damage bonus + value bonus, badges, standings. */
  scoring: {
    /** Free-for-all place points at 4 players (3/2/1/0); the rule is the formula in `placePointsRule`. */
    placePoints: number[];
    /** Damage / value bonus maxima at 4 players; scaled × P/4. */
    damageBonusMax: number;
    valueBonusMax: number;
    [key: string]: unknown;
  };
  arena: Record<string, unknown>;
  suddenDeath: Record<string, unknown>;
  /** Live seat limit (`config.match.maxPlayers`, 2-8); joining beyond it is GAME_FULL. */
  maxPlayers: number;
  [key: string]: unknown;
}

export interface ContractDTO {
  typescript: string;
  templates: { basic_soldier: string; basic_tower: string; basic_wall?: string; basic_factory?: string };
  notes: string[];
}

// ---------------------------------------------------------------------------
// Battle
// ---------------------------------------------------------------------------

/** Frame flags bitmask for `FrameUnit[4]`. */
export const FRAME_FLAGS = {
  ATTACKING: 1,
  MOVING: 2,
  DISABLED: 4,
  OUTSIDE_SAFE_ZONE: 8,
  /**
   * The sprite faces left on SCREEN (mirrored); sprites are drawn facing right
   * (§5.1). Decided in isometric screen space (screenX ∝ x − y, §12), not by
   * the arena x axis.
   */
  FACING_LEFT: 16,
  /** A wall stopped or turned the body's move since the last frame (it is pushing on a wall, §9.3). */
  BLOCKED: 32,
  /** A factory made a minion since the last frame (door flash, §12.5). */
  PRODUCED: 64,
  /** M8.8 (§9.4 Frames): status and auras on the body at the frame. */
  BURNING: 128,
  FROZEN: 256,
  HASTED: 512,
  MIGHTY: 1024,
  SHIELDED: 2048,
} as const;

/** M8.8: what kind of damage a `hit` event is (§9.4 Frames). Absent = 'hit'. */
export type HitKind = 'hit' | 'splash' | 'burn' | 'zap' | 'shatter';

/** [instanceId, x, y, hp, flags] */
export type FrameUnit = [string, number, number, number, number];

export interface FrameProjectile {
  id: number;
  x: number;
  y: number;
  targetId: string;
}

/**
 * A living factory in a frame (§9.3 Frames):
 * [factoryId, progress 0-100, minionsLeft, focusX, focusY, holding 0|1, canMake, stored, burst, order].
 * canMake = the minions it can still make before time runs out (its living
 * value counts these and the stored ones; 0 with nothing stored = no longer a
 * fighter, §9.3). M8.6: stored = minions waiting inside, burst = its burst,
 * order = the index in MINION_ORDERS (0 attack, 1 defend, 2 swarm, 3 guard),
 * and (focusX, focusY) = where its minions head: the rally point (attack), the
 * factory (defend), the target (swarm) or the ally (guard). Entries from 6 on
 * are absent in older frames (read as canMake = minionsLeft, 0 stored, burst 1, attack).
 */
export type FrameFactory = [string, number, number, number, number, 0 | 1, number?, number?, number?, number?];

export type FrameEvent =
  /** A body appears: every placed copy at t = 0, and minions when a factory makes them (`factoryId`, position). */
  | { type: 'spawn'; instanceId: string; factoryId?: string; x?: number; y?: number; kind?: MinionKind }
  /** M8.6: 2+ stored minions left a factory together (the "release!" burst, §5.3). */
  | { type: 'release'; factoryId: string; count: number }
  /** M8.6: a factory died with minions inside; they are lost. */
  | { type: 'lost'; factoryId: string; count: number }
  /** An eliminated side's walls and spent factories vanish, credited to nobody (§9.3). */
  | { type: 'crumble'; ids: string[] }
  | { type: 'fire'; instanceId: string; targetId: string; melee: boolean }
  /** M8.8: `kind` (absent = a plain hit) and the attack's `element` (absent = normal). Burn pulses name the burn's last fire attacker. */
  | { type: 'hit'; instanceId: string; targetId: string; damage: number; kind?: HitKind; element?: Element }
  /** M8.8: a lightning zap from `from` (the struck target) to each body in `to`, in hop order. */
  | { type: 'arc'; from: string; to: string[] }
  /** M8.8: a splash ring round the struck target (its centre, radius and element). */
  | { type: 'splash'; x: number; y: number; r: number; element: Element }
  /** M8.8: a fire hit shattered a frozen body (`amount` = the damage of that hit). */
  | { type: 'shatter'; id: string; amount: number }
  /** M8.8: a heal beam (`amount` = HP actually restored). */
  | { type: 'heal'; from: string; to: string; amount: number }
  /** M8.8: a heal put out the burns and thawed the freeze instead of healing. */
  | { type: 'cleanse'; from: string; to: string }
  | { type: 'death'; instanceId: string }
  | { type: 'disable'; instanceId: string; reason: string };

/** One recorded frame: the state after `t` completed ticks (every 2nd tick). */
export interface FrameDTO {
  t: number;
  /**
   * Living bodies. Walls (M8.5) are listed only in the first frame and when
   * their hp changed since they were last listed: keep the last state of a
   * wall until it is listed again or a death/crumble event removes it.
   */
  units: FrameUnit[];
  /** Living factories (M8.5); absent when there are none. */
  fac?: FrameFactory[];
  projectiles: FrameProjectile[];
  safeZoneRadius: number;
  events: FrameEvent[];
}

/** Stats of an engine-made body (the minion): a snapshot whose type is a BodyType. */
export type StatsSnapshotLike = Omit<StatsSnapshot, 'type'> & { type: BodyType };

/** A fielded design as revealed at START (fielded types only, §3). */
export interface RevealedUnitDTO {
  unitId: string;
  name: string;
  stats: StatsSnapshot;
  cost: number;
  /** null when there is none or it is hidden: draw the fallback (color + shape). */
  sprite: SpriteSpec | null;
  spriteHidden: boolean;
  /**
   * Factories: the body's price under this battle's config (§6). Its living
   * value is bodyCost + minion value × the minions it can still make
   * (`frame.fac` canMake), as the server counts it.
   */
  bodyCost?: number;
  /** A borrowed Armory unit (§9.1): `name` is then "Ogre (Ninja Sam)". */
  borrowedFrom?: { armoryId: string; creatorId: string; creatorName: string };
}

/** Revealed at START: fielded types and placements of every player. */
export interface BattleRevealDTO {
  round: number;
  /** M8.5: the built-in minion (same for everyone; its sprite ships with the client). Present when a factory is fielded. M8.6: the grunt. */
  minion?: { stats: StatsSnapshotLike; value: number };
  /** M8.6: every minion kind a fielded factory builds (stats and value). */
  minions?: Partial<Record<MinionKind, { stats: StatsSnapshotLike; value: number }>>;
  /** Battle length in ticks. */
  totalTicks: number;
  /** The battle's map (§9.2). */
  map?: MapDTO;
  /** Team mode: the teams. */
  teams?: TeamDTO[] | null;
  players: Array<{
    playerId: string;
    name: string;
    seat: number;
    /** Legacy: the corner of the 800 arena when the zone is one (Duel/Corners), else null. Use `mapZone`. */
    zone: Corner | null;
    /** The zone on the battle's map (§9.2). */
    mapZone?: MapZoneDTO;
    teamId?: number;
    units: RevealedUnitDTO[];
    instances: Array<{ instanceId: string; unitId: string; x: number; y: number }>;
  }>;
}

// ---------------------------------------------------------------------------
// Scoring (§9 Points, Damage metric, Value destroyed, Badges)
// ---------------------------------------------------------------------------

export const BADGE_IDS = ['lastStanding', 'biggestHitter', 'giantSlayer', 'ironWall', 'inventor', 'bestMedic', 'comboMaster'] as const;
export type BadgeId = (typeof BADGE_IDS)[number];

/** Badges are titles only: they give no points. */
export const BADGES: Record<BadgeId, { emoji: string; title: string; rule: string }> = {
  lastStanding: { emoji: '🏆', title: 'Last Standing', rule: '1st place' },
  biggestHitter: { emoji: '💥', title: 'Biggest Hitter', rule: 'most damage dealt' },
  giantSlayer: { emoji: '🗡️', title: 'Giant Slayer', rule: 'most enemy value destroyed' },
  ironWall: { emoji: '🛡️', title: 'Iron Wall', rule: 'most army value still standing at the end' },
  inventor: { emoji: '💡', title: 'Inventor', rule: 'Open Armory: another player fielded a unit you invented' },
  bestMedic: { emoji: '💚', title: 'Best Medic', rule: 'most HP healed (medic minions included)' },
  comboMaster: { emoji: '⚡', title: 'Combo Master', rule: 'most shatters and overload zaps' },
};

/** A badge count per badge, all zero. */
export function emptyBadgeCounts(): Record<BadgeId, number> {
  return { lastStanding: 0, biggestHitter: 0, giantSlayer: 0, ironWall: 0, inventor: 0, bestMedic: 0, comboMaster: 0 };
}

/** One player's battle metrics (§9), as of the shown final frame. */
export interface PlayerMetricsDTO {
  playerId: string;
  /** Effective damage dealt to enemy units (no overkill), rounded to a whole number. */
  damage: number;
  /** Full cost of the enemy units this player's hits finished off. */
  valueDestroyed: number;
  kills: number;
  /** Full cost of this player's units still alive at the end. */
  livingValue: number;
  /** M8.8: HP actually restored by this player's healers (medic minions included), whole number. Never damage. */
  healing?: number;
  /** M8.8: shatters + overload zaps (Combo Master). */
  combos?: number;
}

/** One player's round score: `total` = placePoints + damageBonus + valueBonus. */
export interface RoundScoreDTO {
  playerId: string;
  /** Team mode: the player's team. `place` and `placePoints` are then the team's. */
  teamId?: number;
  place: number;
  /** round((P − 1) × (T − place) / (T − 1)); free-for-all = P − place (§9 Points). */
  placePoints: number;
  damage: number;
  /** round-half-up(damageBonusMax × P/4 × damage / top damage); 0 when the top is 0. */
  damageBonus: number;
  valueDestroyed: number;
  /** round-half-up(valueBonusMax × P/4 × valueDestroyed / top value destroyed); 0 when the top is 0. */
  valueBonus: number;
  total: number;
  badges: BadgeId[];
  /** 💡 Inventor (§9.1): how many other players fielded this player's Armory units this battle. */
  inventorUsedBy?: number;
  /** M8.8 (💚 Best Medic, no points): HP this player's healers restored; only when > 0. */
  healing?: number;
  /** M8.8 (⚡ Combo Master, no points): shatters + overload zaps; only when > 0. */
  combos?: number;
}

export interface RankingEntryDTO extends Omit<RoundScoreDTO, 'total'> {
  /** Round points: placePoints + damageBonus + valueBonus. */
  pointsGained: number;
  kills: number;
  /** Full cost of living units at the end (the timeout ranking value; Iron Wall). */
  livingCost: number;
  eliminatedAtTick: number | null;
}

/**
 * A "top damage" unit of a round (§9 Results): one fielded unit type of one
 * player, all its copies summed. Public with the released result (fielded
 * types were revealed at START); never source.
 */
export interface TopUnitDTO {
  /** 1-based; equal damage shares a place. */
  rank: number;
  unitId: string;
  /** The name it fought under ("Ogre (Ninja Sam)" for a borrowed Armory unit). */
  displayName: string;
  /** The player who fielded it. */
  playerId: string;
  playerName: string;
  seat: number;
  teamId?: number;
  /** Effective damage of all copies (whole number). */
  damage: number;
  kills: number;
  valueDestroyed: number;
  /** M8.8: HP its heals restored (whole number; never counts as damage). */
  healing?: number;
  /** Copies fielded. */
  copies: number;
  stats?: StatsSnapshot;
  /** null when there is none or it is hidden (draw the fallback from stats). */
  sprite: SpriteSpec | null;
  spriteHidden: boolean;
  /** Borrowed from the Open Armory: the creator's name (§9.1). */
  borrowedFrom?: string;
  /** The player was kicked during the battle (the damage still counts here). */
  left?: boolean;
}

/** Sent only when playback reaches the final frame (§9 Result release). */
export interface BattleEndDTO {
  round: number;
  /** M8.8: the economy the battle was played in (2 = ×5); absent = the $1,000 game (label "($1,000 game)"). */
  scaleVersion?: number;
  /** Tick of the final (shown) frame. */
  endTick: number;
  reason: 'elimination' | 'timeout' | 'skipped';
  ranking: RankingEntryDTO[];
  scoreboard: ScoreboardEntryDTO[];
  /** Team mode: this round's team ranking and the match team table. */
  teams?: TeamRoundRankDTO[];
  teamTable?: TeamTableRowDTO[];
  /**
   * Open Armory (§9.1): creators whose Armory units other players fielded in
   * this battle (💡 Inventor, no points), with "used by N players".
   */
  inventors?: Array<{ playerId: string; name: string; usedBy: number; units: string[] }>;
  /** The round's top damage units (config scoring.topUnitsShown places, ties included). */
  topUnits?: TopUnitDTO[];
}

export interface BattleReportErrorDTO {
  unitId: string;
  instanceId: string;
  unitName: string;
  tick: number;
  message: string;
  line?: number;
  /** A borrowed Armory unit (§9.1): the creator's name ("borrowed from Ninja Sam"). */
  borrowedFrom?: string;
}

/** One fielded type in the battle report (M8.5, §10.5): own units only. */
export interface BattleReportTypeDTO {
  unitId: string;
  name: string;
  type: UnitType;
  /** Copies placed (minions not counted). */
  fielded: number;
  survived: number;
  /** Effective damage, incl. the factory's minions. */
  damageDealt: number;
  kills: number;
  /** Factories: minions made and lost, and the minions' share of the damage. */
  minionsMade?: number;
  minionsLost?: number;
  minionDamage?: number;
  /** M8.6 factories: minions lost inside when a copy was destroyed (part of minionsLost). */
  storedLost?: number;
  /** Soldiers: the most ticks in a row a wall was in the way of one copy. */
  blockedTicksMax?: number;
  /** M8.8: how the damage was dealt (whole numbers; they add up to damageDealt). */
  damageSplit?: DamageSplitDTO;
  /** M8.8: HP its heals restored, and heals spent putting out burns / thawing (cleanses). */
  healing?: number;
  cleanses?: number;
  /** M8.8 (display only): extra damage from its might auras + damage its shield auras prevented. */
  assist?: number;
}

/** M8.8: a type's damage by kind (§9.4 Scoring and reports). */
export interface DamageSplitDTO {
  hit: number;
  splash: number;
  burn: number;
  zap: number;
  shatter: number;
}

/** Own units only (§10.3). */
export interface BattleReportDTO {
  round: number;
  /** M8.8: as BattleEndDTO.scaleVersion (absent = a report from the $1,000 game). */
  scaleVersion?: number;
  survived: number;
  /** Effective damage (no overkill) summed over own units. */
  damageDealt: number;
  kills: number;
  /** Full cost of the enemy units own units finished off. */
  valueDestroyed: number;
  /** Full cost of own units still alive at the end. */
  livingValue: number;
  /** This round's points and badges; null when not ranked (kicked during the battle). */
  score: RoundScoreDTO | null;
  strikes: number;
  disabled: number;
  errors: BattleReportErrorDTO[];
  /** M8.5: per fielded type (factories with their minions, soldiers' wall time). */
  types?: BattleReportTypeDTO[];
  /** M8.5: short tips for Claude, e.g. a soldier type that spent > 30% of the battle stuck behind walls. */
  hints?: string[];
  /** The round's public top damage units (same as BattleEndDTO.topUnits). */
  topUnits?: TopUnitDTO[];
}

/** GET /battles/:round/replay */
export interface ReplayDTO {
  round: number;
  /** M8.8: the economy the battle was played in (2 = ×5; absent = the $1,000 game). */
  scaleVersion?: number;
  reveal: BattleRevealDTO;
  frames: FrameDTO[];
  end: BattleEndDTO;
}

// ---------------------------------------------------------------------------
// WebSocket messages (§10.3)
// ---------------------------------------------------------------------------

export type ClientWsMessage = { type: 'hello'; role: ViewerRole } | { type: 'ping' };

export interface PrivateStateDTO {
  player: PlayerDTO;
  /** All own designs (templates included), newest first. */
  roster: UnitCardDTO[];
  /** See MyStateDTO.selection. */
  selection: string[];
  placement: PlacementDTO[];
  /** The layout used in the previous battle ("Copy last layout"), or null. */
  lastLayout: PlacementDTO[] | null;
  /** Legacy: the corner of the 800 arena when this round's zone is one (Duel/Corners), else null. Use `mapZone`. */
  zone: Corner | null;
  /** The zone on this round's map (§9.2). */
  mapZone?: MapZoneDTO | null;
  budget: number;
  spent: number;
  ready: boolean;
  active: boolean;
  /** Team mode: own team, benched flag and teammates' live data (§9.2). */
  teamId?: number;
  benched?: boolean;
  team?: TeamPrivateDTO | null;
  /** Open Armory is on for this match (§9.1). */
  armoryEnabled: boolean;
  /** Borrowable Armory units (never your own; empty when Open Armory is off). */
  armory: ArmoryCardDTO[];
}

/**
 * Server → client messages.
 *  - 'hello'         reply to hello: the role actually granted (+ player for 'player').
 *  - 'state'         on every change, plus 1 Hz while a timer runs. Per recipient.
 *  - 'private'       own data (players only): after submit/retire/re-price/selection/placement/phase changes.
 *  - 'battle:reveal' at START, to everyone (and on connect during BATTLE).
 *  - 'battle:frames' batched every ~50 ms at playback speed, to everyone.
 *  - 'battle:end'    only when playback reaches the final frame (or Skip).
 *  - 'toast'         short message for the recipient.
 *  - 'kicked'        this player was removed; the session is gone.
 *  - 'screen'        a facilitator command for the projector (replay, join poster), §12.2.
 *  - 'terminal'      players: own Claude seat, its status and who holds its live terminal (§11.2).
 *                    Sent on hello and whenever any Claude seat changes (refetch /claude-seats for the picker).
 *  - 'terminals'     admins: every Claude seat (no secret, no direct URLs), on hello and on every change.
 */
export type ServerWsMessage =
  | { type: 'hello'; role: ViewerRole; player?: PlayerDTO }
  | { type: 'state'; state: GameStateDTO }
  | { type: 'private'; data: PrivateStateDTO }
  | { type: 'battle:reveal'; data: BattleRevealDTO }
  | { type: 'battle:frames'; frames: FrameDTO[]; playback: PlaybackDTO }
  | { type: 'battle:end'; data: BattleEndDTO }
  | { type: 'toast'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'kicked' }
  | { type: 'pong' }
  | { type: 'screen'; command: ScreenCommandDTO }
  | { type: 'terminal'; data: TerminalDTO }
  | { type: 'terminals'; data: AdminClaudeSeatsDTO };

/**
 * POST /admin/screen → 'screen' WS message (§12.2): the facilitator drives the
 * projector from /admin. Carries no game data.
 *  - replay       play the last battle's replay from the start (RESULTS/MATCH_RESULTS).
 *  - replaySpeed  1x / 2x for the running replay.
 *  - replayPause  pause/resume the replay.
 *  - poster       the full-screen join poster: show, hide, or toggle (`show` left out).
 */
export type ScreenCommandDTO =
  | { action: 'replay'; speed?: 1 | 2 }
  | { action: 'replaySpeed'; speed: 1 | 2 }
  | { action: 'replayPause' }
  | { action: 'poster'; show?: boolean };

/** A validated ScreenCommandDTO from an untrusted body, or null. */
export function parseScreenCommand(raw: unknown): ScreenCommandDTO | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const b = raw as { action?: unknown; speed?: unknown; show?: unknown };
  const speed = b.speed === 1 || b.speed === 2 ? b.speed : undefined;
  switch (b.action) {
    case 'replay':
      if (b.speed !== undefined && speed === undefined) return null;
      return speed ? { action: 'replay', speed } : { action: 'replay' };
    case 'replaySpeed':
      return speed ? { action: 'replaySpeed', speed } : null;
    case 'replayPause':
      return { action: 'replayPause' };
    case 'poster':
      if (b.show !== undefined && typeof b.show !== 'boolean') return null;
      return typeof b.show === 'boolean' ? { action: 'poster', show: b.show } : { action: 'poster' };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export interface AdminPlayerDTO extends PlayerStatusDTO {
  /** Legacy corner of this round's zone (Duel/Corners on the 800 arena), else null. */
  zone: Corner | null;
  /** This round's zone on the map (§9.2), or null. */
  mapZone: MapZoneDTO | null;
  designs: number;
  strikes: number;
  activeFromRound: number;
  /** Claude seat 1-8 (§11.2), or null. */
  claudeSeat: number | null;
}

export interface AdminOverviewDTO {
  state: GameStateDTO;
  players: Array<
    AdminPlayerDTO & {
      apiKey: string;
      selection: string[];
      placement: PlacementDTO[];
      units: UnitSourceDTO[];
    }
  >;
  lanUrls: string[];
  sandboxMode: GameStateDTO['sandboxMode'];
  /** The match setup (§9.2): the LOBBY draft with its map preview and teams, or the running match's. */
  setup: MatchSetupDTO;
  /**
   * Open Armory entries (§9.1) with their REAL sprites, so the facilitator can
   * see and hide them, also for retired or deleted designs. Empty when off.
   */
  armory: AdminArmoryEntryDTO[];
  /** M8.8 (§6 migration): config override paths the v2 migration dropped at boot (the /admin banner); empty when none. */
  economyReset: string[];
}

/** One Open Armory entry in the admin overview (Hide sprite goes to the creator's design id). */
export interface AdminArmoryEntryDTO {
  /** The selection id, `armory:<armoryId>`. */
  unitId: string;
  armoryId: string;
  /** "Ogre (Ninja Sam)". */
  displayName: string;
  creatorId: string;
  creatorName: string;
  sourceUnitId: string;
  version: number;
  stats: StatsSnapshot;
  cost: number;
  status: UnitStatus;
  roundAdded: number;
  /** The real sprite, even when hidden. */
  sprite: SpriteSpec | null;
  /** What everyone else sees: hidden on the entry or on the design. */
  spriteHidden: boolean;
}

/** Facilitator settings for /setup (persisted; survive a wipe). */
export interface SetupSettingsDTO {
  /** Claude box host or IP (no scheme/port); seat N's ttyd is http://<host>:778N (§11.1). */
  claudeBoxHost: string | null;
  /** Preferred base URL (`http://ip:port`) for the join QR when there are several interfaces. */
  preferredUrl: string | null;
}

/**
 * @deprecated Direct ttyd links (adults' fallback, needs the seat password).
 * Superseded by `seatCards` + the /terminal/<N>/ proxy (§11.2).
 */
export interface SeatTerminalDTO {
  /** Index 0-7 (Claude seat `seat + 1`). */
  seat: number;
  /** `http://<claude-box>:778N/terminal/N/` */
  url: string;
  /** QR code of `url` as an SVG document (server-generated). */
  qrSvg: string;
}

/** A printed seat card (§11): the laptop's Claude seat and its /play link. */
export interface SeatCardDTO {
  /** Claude seat 1-8. */
  seat: number;
  /** `${baseUrl}/play?seat=N` */
  playUrl: string;
  /** QR code of `playUrl` as an SVG document. */
  qrSvg: string;
}

/** GET /setup (public): what /setup, /screen and /play need to point people at the right place. */
export interface SetupInfoDTO {
  /** `http://<ip>:<port>` for every LAN IPv4 of the server. */
  lanUrls: string[];
  /** Base URL used for the QR: the preferred URL, else the request's Host (a LAN URL when opened via localhost). */
  baseUrl: string;
  /** `${baseUrl}/play` */
  playUrl: string;
  /** QR code of playUrl as an SVG document. */
  playQrSvg: string;
  settings: SetupSettingsDTO;
  /** @deprecated Empty until the facilitator sets the Claude box address. Use `seatCards`. */
  seatTerminals: SeatTerminalDTO[];
  /** Seat cards for Claude seats 1-8 (`/play?seat=N` + QR). Never contains the seat password. */
  seatCards: SeatCardDTO[];
  sandboxMode: GameStateDTO['sandboxMode'];
}

export interface AdminConfigResponse {
  config: unknown;
  /** "playerId/unitId" of units whose price changed. */
  repriced: string[];
  /** "playerId/unitId" of units that became invalid. */
  invalidated: string[];
  /**
   * M8.8 (§6 migration): the $1,000-game config override paths dropped at
   * boot ("Your economy overrides were for the $1,000 game and were reset.");
   * empty when nothing was dropped. Cleared by DELETE /admin/config/economy-reset or a wipe.
   */
  economyReset: string[];
}

// ---------------------------------------------------------------------------
// REST error body (§10.3)
// ---------------------------------------------------------------------------

export interface ApiErrorBody {
  error: { code: string; message: string; hint?: string; details?: Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Claude seats and the embedded terminal (§11.2)
// ---------------------------------------------------------------------------

/** Claude seats 1-8 (containers seat1..seat8 on the Claude box, ports 7781-7788). */
export const CLAUDE_SEATS = 8;

/**
 * Seat status for adults. `unknown` = not probed yet; `no-box` / `no-password`
 * = the Claude box address / seat password is not set in /admin.
 */
export type ClaudeSeatStatus = 'up' | 'down' | 'wrong-password' | 'no-box' | 'no-password' | 'unknown';

/** What players see: anything that needs a grown-up is just `unknown`. */
export type PlayerClaudeSeatStatus = 'up' | 'down' | 'unknown';

/** Who holds a seat's live terminal. `pane` is the /play iframe's id; null = a standalone tab (or the admin). */
export interface TerminalLiveDTO {
  pane: string | null;
  by: 'player' | 'admin';
  /** ms epoch the terminal was opened. */
  since: number;
}

/** WS 'terminal' (players): the player's own Claude seat. */
export interface TerminalDTO {
  /** Own Claude seat 1-8, or null (show the picker). */
  seat: number | null;
  status: PlayerClaudeSeatStatus;
  /** The Claude box address and the seat password are both set in /admin. */
  boxReady: boolean;
  /** The seat's live terminal, or null. */
  live: TerminalLiveDTO | null;
}

/** GET /claude-seats (players). Names are public already (player tiles). */
export interface ClaudeSeatsDTO {
  mySeat: number | null;
  boxReady: boolean;
  seats: Array<{ seat: number; takenBy: string | null; mine: boolean; status: PlayerClaudeSeatStatus }>;
}

export interface AdminClaudeSeatDTO {
  seat: number;
  playerId: string | null;
  playerName: string | null;
  status: ClaudeSeatStatus;
  /** Short reason for `down` (e.g. "ECONNREFUSED"). Never contains a secret. */
  reason?: string;
  /** ms epoch of the last probe, or null. */
  checkedAt: number | null;
  live: (TerminalLiveDTO & { playerName?: string }) | null;
  /** `http://<box>:778N/terminal/N/` (details=1 only). */
  directUrl?: string;
}

/** GET /admin/claude-seats, and WS 'terminals' (without the details fields). */
export interface AdminClaudeSeatsDTO {
  boxHost: string | null;
  seatSecretSet: boolean;
  /** The shared seat password (`?details=1` only). */
  seatSecret?: string | null;
  seats: AdminClaudeSeatDTO[];
}
