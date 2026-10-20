// Persistence (plan §13): data/state.json (players, PIN hashes, keys, match
// state; debounced writes, atomic rename), data/units/<player>/<unit>@v<n>.js
// (+ the compiled CJS next to it), data/armory/<armoryId>.v<n>.compiled.cjs (Open
// Armory entries' frozen code, §9.1) and data/replays/round-N.json.
//
// The in-memory model lives here too. Services mutate it and call
// `store.save()`; the write is debounced and atomic (tmp file + rename).
// Template designs are NOT persisted: they are re-created for every player at
// boot from packages/starter-kit (services/units.ts).

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  BadgeId,
  BattleReportDTO,
  BattleEndDTO,
  CostBreakdown,
  Corner,
  DeepPartial,
  GameConfig,
  Phase,
  PlacementDTO,
  ReplayDTO,
  SetupSettingsDTO,
  SpriteSpec,
  StatsSnapshot,
  UnitBattleSummaryDTO,
  UnitStatus,
  ValidationError,
  ValidationWarning,
} from '@pixel-clash/shared';
import { migrateConfigPatch } from '@pixel-clash/shared';
import { log } from '../util/log.js';

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
  /** Seat 0-3 (colour, instance-id prefix). -1 once kicked. */
  seat: number;
  /** Join order (zones are assigned in join order, §9). */
  joinSeq: number;
  /** First round this player takes part in (joined mid-round → next round). */
  activeFromRound: number;
  kicked: boolean;
  createdAt: number;
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

/** A design locked into this round's selection (§3: latest valid version at lock time). */
export interface LockedUnit {
  unitId: string;
  version: number;
}

export interface PlayerRoundState {
  /** PLAN: chosen unitIds. From PLACEMENT: the locked selection's unitIds. */
  selection: string[];
  /** The locked designs for this round (set when PLAN ends). */
  locked: LockedUnit[] | null;
  /** The selection locked in the previous round (carry-over rule, §3). */
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
 * An Open Armory entry (§9.1): an immutable copy of a design version that
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
  /** Re-priced under the current config (§6). */
  cost: number;
  breakdown: CostBreakdown;
  roundAdded: number;
  status: UnitStatus;
  error?: ValidationError;
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
  /** Total effective damage this match (the standings tie-break, §9). */
  damage: Record<string, number>;
  /** Badges won this match: playerId → badge → count. */
  badges: Record<string, Partial<Record<BadgeId, number>>>;
  /** This round's zones (assigned at the start of PLACEMENT; owner-only until START). */
  zones: Record<string, Corner>;
  perPlayer: Record<string, PlayerRoundState>;
  /** Released battle results of this match. */
  results: RoundResultRecord[];
  /** Players kicked during BATTLE: removed when the battle ends (§4). */
  pendingKicks: string[];
  /** The subset of pendingKicks that also deletes the player's data ("kick + delete"). */
  pendingDeletes?: string[];
  /** Open Armory (§9.1). */
  armory: ArmoryState;
}

/** MatchState as written to state.json (Armory code lives in data/armory). */
export type PersistedMatchState = Omit<MatchState, 'armory'> & {
  armory?: { enabled: boolean; entries: Array<Omit<ArmoryEntryRecord, 'compiledJs'>>; pendingRemovals?: string[] };
};

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
  /** /setup settings (Claude box address, preferred LAN URL). */
  setup?: SetupSettingsDTO;
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
    zones: {},
    perPlayer: {},
    results: [],
    pendingKicks: [],
    armory: { enabled: false, entries: [] },
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
  setup: SetupSettingsDTO = { claudeBoxHost: null, preferredUrl: null };
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
    }
    this.sessions = new Map(Object.entries(data.sessions ?? {}));
    this.adminSessions = new Set(data.adminSessions ?? []);
    this.adminPassword = data.adminPassword;
    this.configPatch = migrateConfigPatch(data.configPatch ?? {});
    if (data.setup) this.setup = { claudeBoxHost: data.setup.claudeBoxHost ?? null, preferredUrl: data.setup.preferredUrl ?? null };
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
      configPatch: this.configPatch,
      setup: this.setup,
    };
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const tmp = `${this.statePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(data));
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
