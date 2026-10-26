// Persistence: data/state.json (players, PIN hashes, keys, match
// state; debounced writes, atomic rename), data/units/<player>/<unit>@v<n>.js
// (+ the compiled CJS next to it), data/armory/<armoryId>.v<n>.compiled.cjs (Open
// Armory entries' frozen code) and data/replays/round-N.json.
//
// The in-memory model lives here too. Services mutate it and call
// `store.save()`; the write is debounced and atomic (tmp file + rename).
// Template designs are NOT persisted: they are re-created for every player at
// boot from packages/starter-kit (services/units.ts).

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentCredentialKind,
  BadgeId,
  BattleReportDTO,
  BattleEndDTO,
  CostBreakdown,
  DeepPartial,
  MatchAwardDTO,
  GameConfig,
  MapStyle,
  MapZone,
  MinionOrder,
  Phase,
  PlacementDTO,
  ReplayDTO,
  SetupSettingsDTO,
  SpriteSpec,
  StatsSnapshot,
  TeamDTO,
  TeamMode,
  UnitBattleSummaryDTO,
  UnitStatus,
  ValidationError,
  ValidationWarning,
} from '@pixel-clash/shared';
import { ECONOMY_VERSION, cornerZone, isMapStyle, isTeamMode, migrateEconomyPatch, type Corner } from '@pixel-clash/shared';
import { log } from '../util/log.js';

/**
 * The scale of units submitted now: 1 = the $1,000 game, 2 = the ×5 $5,000
 * game (M8.8), 3 = the $10,000 redesign (HP ×1.6, damage ×0.8). Stored units
 * are never deleted automatically: older ones stay and are priced and checked
 * under the current rules like any unit (the facilitator wipes data by hand).
 */
export const SCALE_VERSION = 3;
import type { MatchStats } from './awards.js';

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export interface PlayerRecord {
  id: string;
  name: string;
  /** Lowercased name, for case-insensitive uniqueness. */
  nameKey: string;
  /** `scrypt$<salt hex>$<hash hex>` */
  pinHash: string;
  apiKey: string;
  /** Seat 0-7 (colour, seat badge, instance-id prefix). -1 once kicked. */
  seat: number;
  /** Join order (zones are assigned in join order). */
  joinSeq: number;
  /** First round this player takes part in (joined mid-round → next round). */
  activeFromRound: number;
  kicked: boolean;
  createdAt: number;
  /**
   * Claude seat 1-8 (the laptop's terminal container), unique across
   * players; null/absent = none. Independent of the game `seat`.
   */
  claudeSeat?: number | null;
}

export interface UnitVersionRecord {
  version: number;
  status: UnitStatus;
  /** Why the version is invalid (re-price / bounds change). */
  error?: ValidationError;
  source: string;
  compiledJs: string;
  stats: StatsSnapshot;
  sprite: SpriteSpec | null;
  cost: number;
  breakdown: CostBreakdown;
  warnings: ValidationWarning[];
  /** M8.6 factories: the squad orders its update() gave in the dry run, for the card. */
  orders?: MinionOrder[];
  /** M8.8 heal support: whether update() healed in the dry run, for the card. */
  healUsed?: boolean;
  /** The economy scale it was submitted for (SCALE_VERSION; absent = 1, the $1,000 game). Kept as-is on boot (never auto-deleted). */
  scaleVersion?: number;
  sha256: string;
  createdAt: number;
}

export interface DesignRecord {
  unitId: string;
  ownerId: string;
  isTemplate: boolean;
  retired: boolean;
  spriteHidden: boolean;
  createdAt: number;
  updatedAt: number;
  /** Oldest first. */
  versions: UnitVersionRecord[];
}

/** A design locked into this round's selection (latest valid version at lock time). */
export interface LockedUnit {
  unitId: string;
  version: number;
}

export interface PlayerRoundState {
  /** PLAN: chosen unitIds. From PLACEMENT: the locked selection's unitIds. */
  selection: string[];
  /** The locked designs for this round (set when PLAN ends). */
  locked: LockedUnit[] | null;
  /** The selection locked in the previous round (carry-over rule). */
  prevSelection: string[] | null;
  placements: PlacementDTO[];
  /** The placement used in the previous battle ("Copy last layout", auto-place). */
  lastLayout: PlacementDTO[] | null;
  ready: boolean;
  /** Submitted a unit during the current PLAN (status icon). */
  submittedThisPlan: boolean;
}

export interface TimerState {
  /** Epoch ms when the phase timer ends (running). */
  deadline: number | null;
  /** Remaining ms while paused. */
  remainingMs: number | null;
  paused: boolean;
  /** PLACEMENT: the timer ran out; waiting for the host's START (no auto-start). */
  expired?: boolean;
}

export interface RoundResultRecord {
  round: number;
  end: BattleEndDTO;
  reports: Record<string, BattleReportDTO>;
  /** playerId → unitId → summary. */
  unitSummaries: Record<string, Record<string, UnitBattleSummaryDTO>>;
}

/**
 * An Open Armory entry: an immutable copy of a design version that
 * fought, borrowable by everyone but its creator. `compiledJs` lives in
 * data/armory (never in state.json); the source is never copied.
 */
export interface ArmoryEntryRecord {
  armoryId: string;
  sourceUnitId: string;
  version: number;
  creatorId: string;
  creatorName: string;
  /** The raw unit name (`stats.name`). */
  name: string;
  stats: StatsSnapshot;
  sprite: SpriteSpec | null;
  spriteHidden: boolean;
  compiledJs: string;
  /** Re-priced under the current config. */
  cost: number;
  breakdown: CostBreakdown;
  roundAdded: number;
  status: UnitStatus;
  error?: ValidationError;
  /** M8.8: the copied version's scaleVersion (absent = the $1,000 game). */
  scaleVersion?: number;
}

export interface ArmoryState {
  /** Set by Start match; locked for the whole match. */
  enabled: boolean;
  entries: ArmoryEntryRecord[];
  /**
   * Creators removed by "Kick + delete data" during PLACEMENT: their entries
   * stay until the next PLAN so borrowers' locked armies don't change mid-round.
   */
  pendingRemovals?: string[];
}

export interface MatchState {
  phase: Phase;
  /** 0 in LOBBY. */
  round: number;
  rounds: number;
  timer: TimerState;
  /** Total round points this match. */
  points: Record<string, number>;
  /** Total effective damage this match (the standings tie-break). */
  damage: Record<string, number>;
  /** Badges won this match: playerId → badge → count. */
  badges: Record<string, Partial<Record<BadgeId, number>>>;
  /**
   * Match setup. In LOBBY it is the host's draft (`PUT
   * /admin/match/setup`); from Start match on it is the match's own.
   * `mapStyle` null = the default for the player count. `revealNames` =
   * "Show enemy names to units"; absent = off. `wallsAllowed` =
   * "Walls allowed"; absent = on.
   */
  setup: MatchSetupState;
  /**
   * Team mode: the teams, members in join order. LOBBY: the draft
   * (auto-balanced, swaps kept until the roster or mode changes). From Start
   * match to New match: fixed; a kicked member keeps their slot (a hole, so the
   * team keeps its block shape). null = free-for-all.
   */
  teams: TeamDTO[] | null;
  /**
   * The map of the current round: resolved at every PLACEMENT in
   * free-for-all, fixed at Start match in team mode. null before the first.
   */
  map: { style: MapStyle; players: number } | null;
  /** This round's zones on `map` (assigned at the start of PLACEMENT; owner and teammates only until START). */
  zones: Record<string, MapZone>;
  perPlayer: Record<string, PlayerRoundState>;
  /** Released battle results of this match. */
  results: RoundResultRecord[];
  /** Players kicked during BATTLE: removed when the battle ends. */
  pendingKicks: string[];
  /** The subset of pendingKicks that also deletes the player's data ("kick + delete"). */
  pendingDeletes?: string[];
  /** Open Armory. */
  armory: ArmoryState;
  /** Per-match stats for the match awards, accumulated at every released round. */
  stats: MatchStats;
  /** The match awards, computed when the match reaches MATCH_RESULTS; null before. */
  awards: MatchAwardDTO[] | null;
}

/** The match setup: the LOBBY draft, fixed from Start match. */
export interface MatchSetupState {
  mapStyle: MapStyle | null;
  teamMode: TeamMode;
  /** "Show enemy names to units"; stored only when on, so older state files stay the same. */
  revealNames?: true;
  /** "Walls allowed" (default on); stored only when off. */
  wallsAllowed?: false;
  /** Budget per player per team: teamId → budget, only the teams that differ from caps.budget; absent = none. */
  teamBudgets?: Record<string, number>;
}

/** MatchState as written to state.json (Armory code lives in data/armory). */
export type PersistedMatchState = Omit<MatchState, 'armory'> & {
  armory?: { enabled: boolean; entries: Array<Omit<ArmoryEntryRecord, 'compiledJs'>>; pendingRemovals?: string[] };
};

/**
 * /setup settings as stored: the public ones plus the shared seat password.
 * `seatSecret` never leaves the server except to an admin with
 * "Show details" on.
 */
export interface SetupRecord extends SetupSettingsDTO {
  seatSecret: string | null;
  /**
   * AI seats the admin turned off, ascending. Venue state like the AI session
   * host address, so it survives a wipe. Empty (the default) = every seat on.
   */
  disabledClaudeSeats: number[];
  /**
   * The shared agent logins pasted in /admin: venue state like the
   * seat password, so they survive a wipe and restarts. Write-only: never in
   * any payload (admins see only the last 4 characters); handed only to the
   * AI session host by POST /api/seat-login.
   */
  agentCredentials: AgentCredentials;
}

export type AgentCredentials = Record<AgentCredentialKind, string | null>;

export const noAgentCredentials = (): AgentCredentials => ({ claudeToken: null, anthropicApiKey: null, openaiApiKey: null });

/**
 * The shape of each shared agent login (sessions/entrypoint.sh
 * checks the same). Claude Code's `claude setup-token` prints sk-ant-oat01-…,
 * an Anthropic API key is sk-ant-api03-…, an OpenAI key sk-… or sk-proj-….
 */
export const AGENT_CREDENTIAL_RE: Readonly<Record<AgentCredentialKind, RegExp>> = {
  claudeToken: /^sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,500}$/,
  anthropicApiKey: /^sk-ant-api\d{2}-[A-Za-z0-9_-]{20,500}$/,
  openaiApiKey: /^(?!sk-ant-)sk-[A-Za-z0-9_-]{20,500}$/,
};

/** Stored agent logins from an (edited) state file: anything of the wrong shape is dropped. */
export function normalizeAgentCredentials(v: unknown): AgentCredentials {
  const out = noAgentCredentials();
  if (!v || typeof v !== 'object') return out;
  for (const kind of Object.keys(out) as AgentCredentialKind[]) {
    const x = (v as Record<string, unknown>)[kind];
    if (typeof x === 'string' && AGENT_CREDENTIAL_RE[kind].test(x)) out[kind] = x;
  }
  return out;
}

export interface PersistedState {
  schema: 1;
  players: PlayerRecord[];
  /** Persisted designs without source/compiledJs (those live in data/units). */
  designs: Array<Omit<DesignRecord, 'versions'> & { versions: Array<Omit<UnitVersionRecord, 'source' | 'compiledJs'>> }>;
  match: PersistedMatchState;
  sessions: Record<string, string>;
  adminSessions: string[];
  adminPassword?: string;
  configPatch: DeepPartial<GameConfig>;
  /** /setup settings (AI session host address, preferred LAN URL, seat password). */
  setup?: Partial<SetupRecord>;
}

export function newMatchState(defaultRounds: number): MatchState {
  return {
    phase: 'LOBBY',
    round: 0,
    rounds: defaultRounds,
    timer: { deadline: null, remainingMs: null, paused: false },
    points: {},
    damage: {},
    badges: {},
    setup: { mapStyle: null, teamMode: 'ffa' },
    teams: null,
    map: null,
    zones: {},
    perPlayer: {},
    results: [],
    pendingKicks: [],
    armory: { enabled: false, entries: [] },
    stats: {},
    awards: null,
  };
}

export function newRoundState(): PlayerRoundState {
  return {
    selection: [],
    locked: null,
    prevSelection: null,
    placements: [],
    lastLayout: null,
    ready: false,
    submittedThisPlan: false,
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

export class Store {
  players = new Map<string, PlayerRecord>();
  /** playerId → unitId → design (templates included). */
  designs = new Map<string, Map<string, DesignRecord>>();
  match: MatchState;
  /** Web session token → playerId. */
  sessions = new Map<string, string>();
  adminSessions = new Set<string>();
  adminPassword: string | undefined;
  configPatch: DeepPartial<GameConfig> = {};
  /** /setup settings; kept across a wipe (they describe the venue, not the game). */
  setup: SetupRecord = { aiSessionHost: null, preferredUrl: null, seatSecret: null, disabledClaudeSeats: [], agentCredentials: noAgentCredentials() };
  /** Monotonic counter for join order. */
  private joinSeq = 0;

  private saveTimer: NodeJS.Timeout | undefined;
  private dirty = false;

  constructor(
    readonly dataDir: string,
    defaultRounds: number,
    private readonly debounceMs = 200,
  ) {
    this.match = newMatchState(defaultRounds);
  }

  nextJoinSeq(): number {
    return ++this.joinSeq;
  }

  designsOf(playerId: string): Map<string, DesignRecord> {
    let m = this.designs.get(playerId);
    if (!m) {
      m = new Map();
      this.designs.set(playerId, m);
    }
    return m;
  }

  // -------------------------------------------------------------------------
  // Load
  // -------------------------------------------------------------------------

  private get statePath(): string {
    return join(this.dataDir, 'state.json');
  }

  /** Load data/state.json if present. Returns false when starting fresh. */
  load(): boolean {
    if (!existsSync(this.statePath)) return false;
    let data: PersistedState;
    try {
      data = JSON.parse(readFileSync(this.statePath, 'utf8')) as PersistedState;
    } catch (err) {
      log.error('data/state.json is unreadable; starting fresh (the old file is kept as state.json.bad)', err);
      try {
        renameSync(this.statePath, `${this.statePath}.bad`);
      } catch {
        /* ignore */
      }
      return false;
    }
    for (const p of data.players ?? []) {
      this.players.set(p.id, p);
      this.joinSeq = Math.max(this.joinSeq, p.joinSeq);
    }
    for (const d of data.designs ?? []) {
      const versions: UnitVersionRecord[] = [];
      for (const v of d.versions) {
        const files = this.readUnitFiles(d.ownerId, d.unitId, v.version);
        if (!files) {
          log.warn(`missing source for ${d.ownerId}/${d.unitId}@v${v.version}; version dropped`);
          continue;
        }
        versions.push({ ...v, ...files });
      }
      if (versions.length === 0) continue;
      this.designsOf(d.ownerId).set(d.unitId, { ...d, versions });
    }
    if (data.match) {
      const { armory, ...rest } = data.match;
      const entries: ArmoryEntryRecord[] = [];
      for (const e of armory?.entries ?? []) {
        const compiledJs = this.readArmoryFile(e.armoryId, e.version);
        if (compiledJs === null) {
          log.warn(`missing code for armory entry ${e.armoryId}; entry dropped`);
          continue;
        }
        entries.push({ ...e, compiledJs });
      }
      this.match = {
        ...rest,
        armory: {
          enabled: armory?.enabled === true,
          entries,
          ...(armory?.pendingRemovals?.length ? { pendingRemovals: armory.pendingRemovals } : {}),
        },
      };
      // State files from before the damage tie-break and badges.
      this.match.damage ??= {};
      this.match.badges ??= {};
      // State files from before the match awards.
      this.match.stats ??= {};
      this.match.awards ??= null;
      // State files from before maps and teams: zones were Corners of the 800 Corners map.
      const setup = (this.match.setup ?? {}) as Partial<MatchState['setup']>;
      this.match.setup = {
        mapStyle: isMapStyle(setup.mapStyle) ? setup.mapStyle : null,
        teamMode: isTeamMode(setup.teamMode) ? setup.teamMode : 'ffa',
        ...(setup.revealNames === true ? { revealNames: true } : {}),
        ...(setup.wallsAllowed === false ? { wallsAllowed: false } : {}),
        ...(setup.teamBudgets && typeof setup.teamBudgets === 'object' ? { teamBudgets: setup.teamBudgets } : {}),
      };
      this.match.teams ??= null;
      this.match.map ??= null;
      const zones: Record<string, MapZone> = {};
      for (const [id, z] of Object.entries((this.match.zones ?? {}) as Record<string, MapZone | Corner>)) {
        zones[id] = typeof z === 'string' ? cornerZone(z) : z;
      }
      this.match.zones = zones;
      if (Object.keys(zones).length > 0 && !this.match.map) {
        const n = Object.keys(zones).length;
        // Old 1-2 player zones were TL(+BR) = Duel, 3-4 players the Corners map.
        this.match.map = { style: n <= 2 ? 'duel' : 'corners', players: Math.min(n, 4) };
      }
    }
    this.sessions = new Map(Object.entries(data.sessions ?? {}));
    this.adminSessions = new Set(data.adminSessions ?? []);
    this.adminPassword = data.adminPassword;
    // M8.8: a patch from the $1,000 game loses its scale-sensitive keys (a ×5
    // conversion would let an old curveK or cost.hp undo the retune).
    const migrated = migrateEconomyPatch(data.configPatch ?? {});
    this.configPatch = migrated.patch;
    if (migrated.dropped.length > 0) {
      log.warn(`config overrides from an older economy were dropped ($10,000 economy): ${migrated.dropped.join(', ')}`);
      this.dirty = true;
    }
    if (data.setup) {
      this.setup = {
        aiSessionHost: data.setup.aiSessionHost ?? null,
        preferredUrl: data.setup.preferredUrl ?? null,
        seatSecret: typeof data.setup.seatSecret === 'string' ? data.setup.seatSecret : null,
        disabledClaudeSeats: normalizeSeatList(data.setup.disabledClaudeSeats),
        agentCredentials: normalizeAgentCredentials(data.setup.agentCredentials),
      };
    }
    // Claude seats are unique: drop duplicates and junk from an edited file, and seats that are off.
    const claudeSeats = new Set<number>(this.setup.disabledClaudeSeats);
    for (const p of this.players.values()) {
      const s = p.claudeSeat;
      if (p.kicked || typeof s !== 'number' || !Number.isInteger(s) || s < 1 || s > 8 || claudeSeats.has(s)) p.claudeSeat = null;
      else claudeSeats.add(s);
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Save
  // -------------------------------------------------------------------------

  /** Schedule a debounced atomic write of state.json. */
  save(): void {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.flush();
    }, this.debounceMs);
    this.saveTimer.unref?.();
  }

  /** Write state.json now (if anything changed). */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    if (!this.dirty) return;
    this.dirty = false;
    const data: PersistedState = {
      schema: 1,
      players: [...this.players.values()],
      designs: [...this.designs.values()].flatMap((m) =>
        [...m.values()]
          .filter((d) => !d.isTemplate)
          .map((d) => ({ ...d, versions: d.versions.map(({ source: _s, compiledJs: _c, ...rest }) => rest) })),
      ),
      match: {
        ...this.match,
        armory: {
          enabled: this.match.armory.enabled,
          entries: this.match.armory.entries.map(({ compiledJs: _c, ...rest }) => rest),
          ...(this.match.armory.pendingRemovals?.length ? { pendingRemovals: this.match.armory.pendingRemovals } : {}),
        },
      },
      sessions: Object.fromEntries(this.sessions),
      adminSessions: [...this.adminSessions],
      ...(this.adminPassword !== undefined ? { adminPassword: this.adminPassword } : {}),
      // M8.8: every override written from here on is at the ×5 scale.
      configPatch: Object.keys(this.configPatch).length > 0 ? { ...this.configPatch, economyVersion: ECONOMY_VERSION } : this.configPatch,
      setup: this.setup,
    };
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const tmp = `${this.statePath}.${process.pid}.tmp`;
      // Owner-only: it holds the seat password and the shared agent logins.
      writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
      renameSync(tmp, this.statePath);
    } catch (err) {
      this.dirty = true;
      log.error('could not write data/state.json', err);
    }
  }

  // -------------------------------------------------------------------------
  // Unit files and replays
  // -------------------------------------------------------------------------

  private unitBase(playerId: string, unitId: string, version: number): string {
    if (!SAFE_SEGMENT.test(playerId) || !SAFE_SEGMENT.test(unitId)) throw new Error('unsafe path segment');
    return join(this.dataDir, 'units', playerId, `${unitId}@v${version}`);
  }

  /** Write a version's source (and compiled CJS) synchronously, before the state references it. */
  writeUnitFiles(playerId: string, unitId: string, version: number, source: string, compiledJs: string): void {
    const base = this.unitBase(playerId, unitId, version);
    mkdirSync(join(this.dataDir, 'units', playerId), { recursive: true });
    writeFileSync(`${base}.js`, source);
    writeFileSync(`${base}.compiled.cjs`, compiledJs);
  }

  private readUnitFiles(playerId: string, unitId: string, version: number): { source: string; compiledJs: string } | null {
    try {
      const base = this.unitBase(playerId, unitId, version);
      return { source: readFileSync(`${base}.js`, 'utf8'), compiledJs: readFileSync(`${base}.compiled.cjs`, 'utf8') };
    } catch {
      return null;
    }
  }

  deleteUnitFiles(playerId: string): void {
    if (!SAFE_SEGMENT.test(playerId)) return;
    rmSync(join(this.dataDir, 'units', playerId), { recursive: true, force: true });
  }

  /**
   * Write an Armory entry's frozen code (synchronously, before the state
   * references it). The file is named by version, so a replacement never
   * overwrites the code the (debounced) state.json still points at: after a
   * crash, metadata and code always belong to the same version.
   */
  writeArmoryFile(armoryId: string, version: number, compiledJs: string): void {
    if (!SAFE_SEGMENT.test(armoryId) || !Number.isInteger(version)) throw new Error('unsafe path segment');
    mkdirSync(join(this.dataDir, 'armory'), { recursive: true });
    writeFileSync(join(this.dataDir, 'armory', armoryFileName(armoryId, version)), compiledJs);
  }

  private readArmoryFile(armoryId: string, version: number): string | null {
    if (!SAFE_SEGMENT.test(armoryId) || !Number.isInteger(version)) return null;
    for (const name of [armoryFileName(armoryId, version), `${armoryId}.compiled.cjs`]) {
      try {
        return readFileSync(join(this.dataDir, 'armory', name), 'utf8');
      } catch {
        // try the next name (files from before per-version names)
      }
    }
    return null;
  }

  /** Delete every Armory file (New match). */
  deleteArmoryFiles(): void {
    rmSync(join(this.dataDir, 'armory'), { recursive: true, force: true });
  }

  writeReplay(replay: ReplayDTO): void {
    try {
      const dir = join(this.dataDir, 'replays');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `round-${replay.round}.json`);
      writeFileSync(`${file}.tmp`, JSON.stringify(replay));
      renameSync(`${file}.tmp`, file);
    } catch (err) {
      log.error('could not write the replay', err);
    }
  }

  readReplay(round: number): ReplayDTO | null {
    try {
      return JSON.parse(readFileSync(join(this.dataDir, 'replays', `round-${round}.json`), 'utf8')) as ReplayDTO;
    } catch {
      return null;
    }
  }

  /** Delete data/ and reset the in-memory state (admin wipe). Admin sessions survive. */
  wipe(defaultRounds: number): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    rmSync(this.dataDir, { recursive: true, force: true });
    this.players.clear();
    this.designs.clear();
    this.sessions.clear();
    this.match = newMatchState(defaultRounds);
    this.configPatch = {};
    this.joinSeq = 0;
    this.dirty = true;
    this.flush();
  }
}

/** data/armory file name of an entry's frozen code (one file per version). */
export function armoryFileName(armoryId: string, version: number): string {
  return `${armoryId}.v${version}.compiled.cjs`;
}

/** A stored list of AI seat numbers: 1-8, unique, ascending; junk dropped. */
export function normalizeSeatList(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  const seats = new Set<number>();
  for (const n of v) if (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 8) seats.add(n);
  return [...seats].sort((a, b) => a - b);
}
