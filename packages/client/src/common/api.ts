// Typed REST client for the game server (plan §10.3; contract documented at
// the top of packages/shared/src/protocol.ts). Same-origin fetch with the
// session cookie; every non-2xx response becomes an ApiError.

import type {
  AdminClaudeSeatsDTO,
  AdminConfigResponse,
  AdminOverviewDTO,
  ApiErrorBody,
  BattleEndDTO,
  BattleReportDTO,
  ClaudeSeatsDTO,
  ContractDTO,
  GameConfig,
  GameStateDTO,
  GuideDTO,
  HealthDTO,
  LoginResponse,
  MapStyle,
  MatchSetupDTO,
  MeResponse,
  PlacementDTO,
  PlacementResponse,
  PlaybackDTO,
  ReplayDTO,
  RulesDTO,
  ScreenCommandDTO,
  SubmitUnitResponse,
  TeamDTO,
  TeamMode,
  TimerDTO,
  UnitCardDTO,
  UnitSourceDTO,
  ValidationFailure,
  ValidationResult,
} from '@pixel-clash/shared';

/** How long a RATE_LIMITED error asks the caller to wait (0 for any other error). */
export function retryAfterMs(err: unknown): number {
  if (!(err instanceof ApiError) || err.code !== 'RATE_LIMITED') return 0;
  const ms = err.details?.retryAfterMs;
  return typeof ms === 'number' && Number.isFinite(ms) ? Math.max(0, ms) : 0;
}

/** A failed request. `validation` is set for HTTP 422 unit validation failures (§7). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly hint?: string,
    readonly details?: Record<string, unknown>,
    readonly validation?: ValidationFailure,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** The phase gate is closed (HTTP 409 PHASE_CLOSED). */
  get phaseClosed(): boolean {
    return this.code === 'PHASE_CLOSED';
  }
  /** Not signed in (or the session was kicked/expired). */
  get unauthenticated(): boolean {
    return this.code === 'AUTH_REQUIRED' || this.code === 'KEY_INVALID' || this.code === 'ADMIN_REQUIRED';
  }
  /** Friendly text: the hint when there is one, else the message. */
  get playerMessage(): string {
    return this.hint ?? this.message;
  }
}

/** True for the §7 failure body `{ok:false, errors:[…]}`. */
function isValidationFailure(body: unknown): body is ValidationFailure {
  return typeof body === 'object' && body !== null && (body as { ok?: unknown }).ok === false && Array.isArray((body as { errors?: unknown }).errors);
}

function isErrorBody(body: unknown): body is ApiErrorBody {
  const e = (body as { error?: unknown } | null)?.error;
  return typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'string';
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface RequestOptions {
  signal?: AbortSignal;
  /** Return the §7 ValidationFailure body (HTTP 422) instead of throwing. */
  validationAsResult?: boolean;
}

/** Base path; the client is always served by the game server (or the Vite proxy). */
const BASE = '/api';

/** Low-level JSON request. Throws ApiError on any non-2xx (or a network failure, status 0). */
export async function request<T>(method: HttpMethod, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? null : JSON.stringify(body),
      signal: opts.signal ?? null,
    });
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK', "Can't reach the game server. Check the Wi-Fi and try again.");
  }
  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (res.ok) return data as T;
  if (res.status === 422 && isValidationFailure(data)) {
    if (opts.validationAsResult) return data as T;
    const first = data.errors[0];
    throw new ApiError(422, first?.code ?? 'VALIDATION_FAILED', first?.message ?? 'The unit did not pass the checks.', data.playerHint, undefined, data);
  }
  if (isErrorBody(data)) {
    const e = data.error;
    throw new ApiError(res.status, e.code, e.message, e.hint, e.details);
  }
  throw new ApiError(res.status, `HTTP_${res.status}`, typeof data === 'string' && data ? data : res.statusText || 'Request failed');
}

const enc = encodeURIComponent;

/** {source, unitId?, baseVersion?} for validate/submit (baseVersion only with a unitId). */
function unitBody(source: string, unitId?: string, baseVersion?: number): { source: string; unitId?: string; baseVersion?: number } {
  if (!unitId) return { source };
  return baseVersion === undefined ? { source, unitId } : { source, unitId, baseVersion };
}

/** All REST endpoints, typed. */
export const api = {
  // --- public -------------------------------------------------------------
  health: () => request<HealthDTO>('GET', '/health'),
  rules: () => request<RulesDTO>('GET', '/rules'),
  contract: () => request<ContractDTO>('GET', '/contract'),
  /** The unit guide (§10.3): the rulebook for units from the live config. */
  guide: () => request<GuideDTO>('GET', '/guide'),
  state: () => request<GameStateDTO>('GET', '/state'),
  join: (name: string, pin: string) => request<LoginResponse>('POST', '/players', { name, pin }),
  login: (name: string, pin: string) => request<LoginResponse>('POST', '/login', { name, pin }),
  logout: () => request<{ ok: true }>('POST', '/logout'),
  replay: (round: number | 'latest') => request<ReplayDTO>('GET', `/battles/${round}/replay`),
  /** URLs for downloads (use as <a href>, not fetch). */
  setupKitUrl: () => `${BASE}/setup/kit.zip`,

  // --- player -------------------------------------------------------------
  me: () => request<MeResponse>('GET', '/me'),
  /** Dry run; resolves with the §7 result (ok or not) instead of throwing on 422. */
  validateUnit: (source: string, unitId?: string, baseVersion?: number) =>
    request<ValidationResult>('POST', '/units/validate', unitBody(source, unitId, baseVersion), { validationAsResult: true }),
  /**
   * Submit (PLAN only). A failed validation throws ApiError with `validation` set.
   * With `baseVersion`, a unit changed meanwhile is ApiError UNIT_CHANGED (409, details.version).
   */
  submitUnit: (source: string, unitId?: string, baseVersion?: number) => request<SubmitUnitResponse>('POST', '/units', unitBody(source, unitId, baseVersion)),
  units: () => request<UnitCardDTO[]>('GET', '/units'),
  unit: (unitId: string) => request<UnitSourceDTO>('GET', `/units/${enc(unitId)}`),
  retireUnit: (unitId: string) => request<{ ok: true }>('DELETE', `/units/${enc(unitId)}`),
  setSelection: (unitIds: string[]) => request<{ selection: string[] }>('PUT', '/round/selection', { unitIds }),
  setPlacement: (placements: PlacementDTO[]) => request<PlacementResponse>('PUT', '/round/placement', { placements }),
  setReady: (ready: boolean) => request<{ ready: boolean }>('POST', '/round/ready', { ready }),
  report: (round: number | 'latest') => request<BattleReportDTO>('GET', `/battles/${round}/report`),
  /** A released round's public result (ranking, points, badges, top units). */
  results: (round: number) => request<BattleEndDTO>('GET', `/battles/${round}/results`),
  /** The Claude seat picker (§11.2 c). */
  claudeSeats: () => request<ClaudeSeatsDTO>('GET', '/claude-seats'),
  /** Pick the laptop's Claude seat 1-8 (null = none). CLAUDE_SEAT_TAKEN (409) has details {seat, takenBy}. */
  setClaudeSeat: (seat: number | null) => request<{ claudeSeat: number | null }>('PUT', '/me/claude-seat', { seat }),

  // --- admin --------------------------------------------------------------
  admin: {
    login: (password: string) => request<{ ok: true }>('POST', '/admin/login', { password }),
    logout: () => request<{ ok: true }>('POST', '/admin/logout'),
    session: () => request<{ admin: boolean }>('GET', '/admin/session'),
    /** Start match (§9.2): mapStyle/teamMode left out = the LOBBY draft's; mapStyle null = default for the player count. */
    startMatch: (rounds?: number, armory?: boolean, setup: { mapStyle?: MapStyle | null; teamMode?: TeamMode } = {}) =>
      request<GameStateDTO>('POST', '/admin/match', {
        ...(rounds === undefined ? {} : { rounds }),
        ...(armory === undefined ? {} : { armory }),
        ...setup,
      }),
    matchSetup: () => request<MatchSetupDTO>('GET', '/admin/match/setup'),
    /** LOBBY draft: map style override (null = auto by player count) and team mode; re-balances the teams. */
    setMatchSetup: (setup: { mapStyle?: MapStyle | null; teamMode?: TeamMode }) => request<MatchSetupDTO>('PUT', '/admin/match/setup', setup),
    /** Swap two players on different draft teams (LOBBY only). */
    swapTeams: (playerA: string, playerB: string) => request<{ teams: TeamDTO[] }>('POST', '/admin/teams/swap', { playerA, playerB }),
    newMatch: () => request<GameStateDTO>('POST', '/admin/match/new'),
    nextPhase: () => request<GameStateDTO>('POST', '/admin/phase/next'),
    skipPhase: () => request<GameStateDTO>('POST', '/admin/phase/skip'),
    timer: (t: { setSeconds?: number; addSeconds?: number; paused?: boolean }) => request<TimerDTO>('POST', '/admin/timer', t),
    start: (force = false) => request<GameStateDTO>('POST', '/admin/start', { force }),
    /** Start the cancellable countdown to Next (PLAN) / START (PLACEMENT). */
    advance: (delaySec = 3) => request<GameStateDTO>('POST', '/admin/phase/advance', { delaySec }),
    cancelAdvance: () => request<GameStateDTO>('POST', '/admin/phase/advance/cancel'),
    battle: (b: { paused?: boolean; speed?: 1 | 2 }) => request<PlaybackDTO>('POST', '/admin/battle', b),
    /** Projector remote (§12.2): replay, 1x/2x, pause, join poster. `screens` = projectors reached. */
    screen: (command: ScreenCommandDTO) => request<{ ok: true; screens: number }>('POST', '/admin/screen', command),
    kick: (playerId: string, deleteData = false) =>
      request<{ ok: true; effective: 'now' | 'after-battle' }>('POST', `/admin/players/${enc(playerId)}/kick`, { deleteData }),
    resetPin: (playerId: string, pin: string) => request<{ ok: true }>('POST', `/admin/players/${enc(playerId)}/pin`, { pin }),
    rotateKey: (playerId: string) => request<{ apiKey: string }>('POST', `/admin/players/${enc(playerId)}/rotate-key`),
    /** Validate (dryRun) or submit on behalf of a player; 422 results are returned, not thrown. */
    playerUnit: (playerId: string, source: string, opts: { unitId?: string; baseVersion?: number; dryRun?: boolean } = {}) =>
      request<ValidationResult | SubmitUnitResponse>('POST', `/admin/players/${enc(playerId)}/units`, { source, ...opts }, { validationAsResult: true }),
    hideSprite: (playerId: string, unitId: string, hidden: boolean) =>
      request<{ ok: true }>('POST', `/admin/units/${enc(playerId)}/${enc(unitId)}/sprite`, { hidden }),
    config: () => request<AdminConfigResponse>('GET', '/admin/config'),
    updateConfig: (patch: DeepPartial<GameConfig>) => request<AdminConfigResponse>('PUT', '/admin/config', patch),
    /** M8.8 (§6 migration): dismiss the "economy overrides were reset" banner. */
    dismissEconomyReset: () => request<AdminConfigResponse>('DELETE', '/admin/config/economy-reset'),
    overview: () => request<AdminOverviewDTO>('GET', '/admin/overview'),
    wipe: () => request<{ ok: true }>('POST', '/admin/wipe', { confirm: 'WIPE' }),
    /** Claude seats (§11.2): with `details`, also the seat password and the direct URLs. */
    claudeSeats: (details = false) => request<AdminClaudeSeatsDTO>('GET', `/admin/claude-seats${details ? '?details=1' : ''}`),
    /** Assign a Claude seat to a player (moves them, unassigns the seat's holder); null unassigns. */
    assignClaudeSeat: (seat: number, playerId: string | null) => request<AdminClaudeSeatsDTO>('PUT', `/admin/claude-seats/${seat}`, { playerId }),
    checkClaudeSeats: () => request<AdminClaudeSeatsDTO>('POST', '/admin/claude-seats/check'),
  },
} as const;

export type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;
