// Typed REST client for the game server (plan §10.3; contract documented at
// the top of packages/shared/src/protocol.ts). Same-origin fetch with the
// session cookie; every non-2xx response becomes an ApiError.

import type {
  AdminConfigResponse,
  AdminOverviewDTO,
  ApiErrorBody,
  BattleReportDTO,
  ContractDTO,
  GameConfig,
  GameStateDTO,
  HealthDTO,
  LoginResponse,
  MeResponse,
  PlacementDTO,
  PlacementResponse,
  PlaybackDTO,
  ReplayDTO,
  RulesDTO,
  SubmitUnitResponse,
  TimerDTO,
  UnitCardDTO,
  UnitSourceDTO,
  ValidationFailure,
  ValidationResult,
} from '@pixel-clash/shared';

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
  /** Kid-friendly text: the hint when there is one, else the message. */
  get kidMessage(): string {
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
    throw new ApiError(422, first?.code ?? 'VALIDATION_FAILED', first?.message ?? 'The unit did not pass the checks.', data.kidHint, undefined, data);
  }
  if (isErrorBody(data)) {
    const e = data.error;
    throw new ApiError(res.status, e.code, e.message, e.hint, e.details);
  }
  throw new ApiError(res.status, `HTTP_${res.status}`, typeof data === 'string' && data ? data : res.statusText || 'Request failed');
}

const enc = encodeURIComponent;

/** All REST endpoints, typed. */
export const api = {
  // --- public -------------------------------------------------------------
  health: () => request<HealthDTO>('GET', '/health'),
  rules: () => request<RulesDTO>('GET', '/rules'),
  contract: () => request<ContractDTO>('GET', '/contract'),
  state: () => request<GameStateDTO>('GET', '/state'),
  join: (name: string, pin: string) => request<LoginResponse>('POST', '/players', { name, pin }),
  login: (name: string, pin: string) => request<LoginResponse>('POST', '/login', { name, pin }),
  logout: () => request<{ ok: true }>('POST', '/logout'),
  replay: (round: number | 'latest') => request<ReplayDTO>('GET', `/battles/${round}/replay`),
  /** URLs for downloads (use as <a href>, not fetch). */
  setupKitUrl: () => `${BASE}/setup/kit.zip`,
  kitUrl: () => `${BASE}/kit.zip`,

  // --- player -------------------------------------------------------------
  me: () => request<MeResponse>('GET', '/me'),
  /** Dry run; resolves with the §7 result (ok or not) instead of throwing on 422. */
  validateUnit: (source: string, unitId?: string) =>
    request<ValidationResult>('POST', '/units/validate', unitId ? { source, unitId } : { source }, { validationAsResult: true }),
  /** Submit (PLAN only). A failed validation throws ApiError with `validation` set. */
  submitUnit: (source: string, unitId?: string) =>
    request<SubmitUnitResponse>('POST', '/units', unitId ? { source, unitId } : { source }),
  units: () => request<UnitCardDTO[]>('GET', '/units'),
  unit: (unitId: string) => request<UnitSourceDTO>('GET', `/units/${enc(unitId)}`),
  retireUnit: (unitId: string) => request<{ ok: true }>('DELETE', `/units/${enc(unitId)}`),
  setSelection: (unitIds: string[]) => request<{ selection: string[] }>('PUT', '/round/selection', { unitIds }),
  setPlacement: (placements: PlacementDTO[]) => request<PlacementResponse>('PUT', '/round/placement', { placements }),
  setReady: (ready: boolean) => request<{ ready: boolean }>('POST', '/round/ready', { ready }),
  report: (round: number | 'latest') => request<BattleReportDTO>('GET', `/battles/${round}/report`),

  // --- admin --------------------------------------------------------------
  admin: {
    login: (password: string) => request<{ ok: true }>('POST', '/admin/login', { password }),
    logout: () => request<{ ok: true }>('POST', '/admin/logout'),
    session: () => request<{ admin: boolean }>('GET', '/admin/session'),
    startMatch: (rounds?: number, armory?: boolean) =>
      request<GameStateDTO>('POST', '/admin/match', {
        ...(rounds === undefined ? {} : { rounds }),
        ...(armory === undefined ? {} : { armory }),
      }),
    newMatch: () => request<GameStateDTO>('POST', '/admin/match/new'),
    nextPhase: () => request<GameStateDTO>('POST', '/admin/phase/next'),
    skipPhase: () => request<GameStateDTO>('POST', '/admin/phase/skip'),
    timer: (t: { setSeconds?: number; addSeconds?: number; paused?: boolean }) => request<TimerDTO>('POST', '/admin/timer', t),
    start: (force = false) => request<GameStateDTO>('POST', '/admin/start', { force }),
    battle: (b: { paused?: boolean; speed?: 1 | 2 }) => request<PlaybackDTO>('POST', '/admin/battle', b),
    kick: (playerId: string, deleteData = false) =>
      request<{ ok: true; effective: 'now' | 'after-battle' }>('POST', `/admin/players/${enc(playerId)}/kick`, { deleteData }),
    resetPin: (playerId: string, pin: string) => request<{ ok: true }>('POST', `/admin/players/${enc(playerId)}/pin`, { pin }),
    rotateKey: (playerId: string) => request<{ apiKey: string }>('POST', `/admin/players/${enc(playerId)}/rotate-key`),
    /** Validate (dryRun) or submit on behalf of a player; 422 results are returned, not thrown. */
    playerUnit: (playerId: string, source: string, opts: { unitId?: string; dryRun?: boolean } = {}) =>
      request<ValidationResult | SubmitUnitResponse>('POST', `/admin/players/${enc(playerId)}/units`, { source, ...opts }, { validationAsResult: true }),
    hideSprite: (playerId: string, unitId: string, hidden: boolean) =>
      request<{ ok: true }>('POST', `/admin/units/${enc(playerId)}/${enc(unitId)}/sprite`, { hidden }),
    config: () => request<AdminConfigResponse>('GET', '/admin/config'),
    updateConfig: (patch: DeepPartial<GameConfig>) => request<AdminConfigResponse>('PUT', '/admin/config', patch),
    overview: () => request<AdminOverviewDTO>('GET', '/admin/overview'),
    wipe: () => request<{ ok: true }>('POST', '/admin/wipe', { confirm: 'WIPE' }),
  },
} as const;

export type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;
