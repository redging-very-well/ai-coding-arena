// The composition root of the service layer (plan §10.1). REST (routes/*)
// and MCP (mcp.ts) are thin adapters over these services; ws.ts implements
// the Notifier the services push through.

import {
  parseConfig,
  type BattleEndDTO,
  type BattleRevealDTO,
  type DeepPartial,
  type FrameDTO,
  type GameConfig,
  type PlaybackDTO,
} from '@pixel-clash/shared';
import type { RunnerFactory } from '../sandbox/runner.js';
import type { SessionOpener } from '../sandbox/session.js';
import { ArmoryService } from './armory.js';
import { AuthService } from './auth.js';
import { BattleService } from './battle.js';
import { MatchService } from './match.js';
import { PlayersService } from './players.js';
import { RoundService } from './round.js';
import { SetupService } from './setup.js';
import { Store } from './store.js';
import { TeamsService } from './teams.js';
import { UnitsService } from './units.js';
import { VisibilityService } from './visibility.js';

export type ToastLevel = 'info' | 'warn' | 'error';
/** A toast target: everyone, every admin socket, or one player's sockets. */
export type ToastTarget = { all: true } | { admin: true } | { playerId: string };

/**
 * Push channel from the services to connected clients (implemented by ws.ts).
 * Every payload is built per recipient by the WS layer via VisibilityService.
 */
export interface Notifier {
  /** Something in the public/per-player game state changed. */
  stateChanged(): void;
  /** One player's private data changed (roster, selection, placement, zone). */
  privateChanged(playerId: string): void;
  toast(target: ToastTarget, level: ToastLevel, message: string): void;
  battleReveal(reveal: BattleRevealDTO): void;
  battleFrames(frames: FrameDTO[], playback: PlaybackDTO): void;
  battleEnd(end: BattleEndDTO): void;
  /** The player was kicked: close their sockets. */
  playerRevoked(playerId: string): void;
  /** Number of open player sockets (for the `connected` flag). */
  isConnected(playerId: string): boolean;
  /** Open WebSocket connections of any role (diagnostics, GET /admin/metrics). */
  clientCount?(): number;
}

const NOOP_NOTIFIER: Notifier = {
  stateChanged() {},
  privateChanged() {},
  toast() {},
  battleReveal() {},
  battleFrames() {},
  battleEnd() {},
  playerRevoked() {},
  isConnected: () => false,
};

export interface GameOptions {
  dataDir: string;
  /** Config overrides on top of config/default.json (tests: short timers). */
  config?: DeepPartial<GameConfig>;
  /** Base config (default: DEFAULT_CONFIG merged with config/default.json by the caller). */
  baseConfig?: GameConfig;
  /** Admin password; when unset a 3-word password is generated (and persisted). */
  adminPassword?: string;
  /** Allow sandbox mode 'inproc-unsafe' (the `--unsafe` flag). */
  unsafe?: boolean;
  /** Battle runner factory override (tests). Default: from config.sandbox.mode. */
  runnerFactory?: RunnerFactory;
  /** Validation sandbox override (tests). Default: isolated-vm child process. */
  validationOpener?: SessionOpener;
  /** Playback speed multiplier on top of 1x/2x (tests: fast-forward). Default 1. */
  playbackRate?: number;
  /** Hold playback this long after the reveal ("3-2-1 CLASH!" animation). Default 3000. */
  revealDelayMs?: number;
  /** Debounce for state.json writes. */
  saveDebounceMs?: number;
}

export class Game {
  readonly store: Store;
  readonly auth: AuthService;
  readonly players: PlayersService;
  readonly units: UnitsService;
  readonly armory: ArmoryService;
  readonly round: RoundService;
  readonly teams: TeamsService;
  readonly match: MatchService;
  readonly battle: BattleService;
  readonly visibility: VisibilityService;
  readonly setup: SetupService;
  notifier: Notifier = NOOP_NOTIFIER;
  /** The boot config (config/default.json + options), before the admin patch. */
  readonly bootConfig: GameConfig;
  config: GameConfig;

  constructor(readonly options: GameOptions) {
    this.bootConfig = parseConfig(options.config ?? {}, options.baseConfig);
    this.config = this.bootConfig;
    this.store = new Store(options.dataDir, this.bootConfig.timers.defaultRounds, options.saveDebounceMs);
    this.auth = new AuthService(this);
    this.players = new PlayersService(this);
    this.units = new UnitsService(this);
    this.armory = new ArmoryService(this);
    this.round = new RoundService(this);
    this.teams = new TeamsService(this);
    this.battle = new BattleService(this);
    this.match = new MatchService(this);
    this.visibility = new VisibilityService(this);
    this.setup = new SetupService(this);
  }

  /** Load data/, validate the templates and recover from a restart. */
  async init(): Promise<void> {
    this.store.load();
    const patched = (() => {
      try {
        return parseConfig(this.store.configPatch, this.bootConfig);
      } catch {
        return this.bootConfig;
      }
    })();
    this.config = patched;
    this.auth.init();
    await this.units.init();
    this.match.recover();
    this.store.save();
  }

  setNotifier(n: Notifier): void {
    this.notifier = n;
  }

  /** Stop timers and battle, write state. */
  async shutdown(): Promise<void> {
    this.match.stopTimers();
    await this.battle.abort();
    this.store.flush();
  }
}
