// Claude seats (plan §11.2 c): which player sits at which Claude laptop (seat
// 1-8 = container seatN on the AI session host, port 778N, proxy path
// /terminal/N/). Independent of the game seat (colour/zone). Unique across
// players, persisted on the player record, freed by kick and wipe, kept across
// logout, PIN reset, New match and restarts.
//
// Join and login from /play auto-assign a seat (`autoAssign`, preference:
// own seat, this laptop's seat, the lowest free one). The admin can turn
// seats off (`setEnabled`): never assigned or pickable; turning off a held
// seat moves its player to the lowest free seat that is on. `seatLogin` hands
// the seat's agent-loop the player's login (§11.2 e), so the AI helper starts
// logged in, and the shared agent login pasted in /admin (§11.2 f:
// `setAgentCredentials`, write-only), so no seat needs its own /login.
//
// The live side (who holds a seat's terminal, the seat probe) belongs to the
// terminal proxy (src/terminal), which attaches itself as `TerminalControl`.
// Without it (service-only tests) statuses are `unknown` and nothing is live.

import {
  type AgentCredentialKind,
  CLAUDE_SEATS,
  type ClaudeSeatAssignDTO,
  fail,
  ok,
  type AdminClaudeSeatDTO,
  type AdminClaudeSeatsDTO,
  type ClaudeSeatStatus,
  type ClaudeSeatsDTO,
  type PlayerClaudeSeatStatus,
  type Result,
  type SeatCredentialDTO,
  type SeatCredentialEnv,
  type SeatLoginDTO,
  type TerminalDTO,
  type TerminalLiveDTO,
} from '@pixel-clash/shared';
import { createHash, timingSafeEqual } from 'node:crypto';
import { RateLimiter } from '../util/ratelimit.js';
import type { Game } from './game.js';
import { AGENT_CREDENTIAL_RE, type PlayerRecord } from './store.js';

/** ttyd host port of Claude seat 1 (seat N → 7780 + N, §11.1). */
export const CLAUDE_SEAT_BASE_PORT = 7780;

/** The seat password (§11.2 a): no spaces or ':' (ttyd's `-c user:pass` can't take them). */
export const SEAT_SECRET_RE = /^[A-Za-z0-9._~-]{12,64}$/;

export type LiveTerminal = TerminalLiveDTO & { playerName?: string };

/** What the probe knows about a seat (the proxy's view of the AI session host). */
export interface ProbeStatus {
  status: 'up' | 'down' | 'wrong-password' | 'unknown';
  reason?: string;
  checkedAt: number | null;
}

/** Implemented by the terminal proxy (src/terminal/proxy.ts). */
export interface TerminalControl {
  live(seat: number): LiveTerminal | null;
  probeStatus(seat: number): ProbeStatus;
  /** Re-check every live terminal's access soon (closes those that lost it). */
  recheck(): void;
  /** Probe every seat now. */
  probeAll(): Promise<void>;
}

/** A Claude seat number 1-8 from JSON or a route param, else null. */
export function parseClaudeSeat(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,2}$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= CLAUDE_SEATS ? n : null;
}

/** Direct ttyd URL of a seat (adults' fallback, needs the seat password). */
export function directSeatUrl(host: string, seat: number): string {
  return `http://${host}:${CLAUDE_SEAT_BASE_PORT + seat}/terminal/${seat}/`;
}

export function seatNumbers(): number[] {
  return Array.from({ length: CLAUDE_SEATS }, (_, i) => i + 1);
}

/**
 * Which player a seat's terminal serves (plan §11.2 e): 32 hex digits, a hash
 * of the seat and the player's id. The proxy appends `?arg=<token>` to the
 * ttyd WebSocket only for the seat's assigned player; ttyd (`-a`) passes it to
 * the seat's agent-loop, which starts a fresh conversation with the first
 * prompt when the token differs from the last one it saw, and trades it for
 * the player's login at POST /api/seat-login. Deterministic, so a reload or
 * the same player coming back resumes their conversation.
 */
export function seatPlayerToken(seat: number, playerId: string): string {
  return createHash('sha256').update(`pixel-clash seat player\n${seat}\n${playerId}`).digest('hex').slice(0, 32);
}

/**
 * The seat auto-assignment rule (§11.2 c), pure: the player's own seat if it
 * is on; else `preferred` (this laptop's seat) if it is on and free; else the
 * lowest free seat that is on; else none.
 */
export function pickClaudeSeat(opts: {
  current: number | null;
  preferred: number | null;
  /** Is the seat on? */
  enabled: (seat: number) => boolean;
  /** Is the seat held by another player? */
  taken: (seat: number) => boolean;
}): ClaudeSeatAssignDTO {
  const { current, preferred, enabled, taken } = opts;
  if (current !== null && enabled(current)) return { seat: current, how: 'kept' };
  if (preferred !== null && enabled(preferred) && !taken(preferred)) return { seat: preferred, how: 'preferred' };
  for (const seat of seatNumbers()) if (enabled(seat) && !taken(seat)) return { seat, how: 'lowest' };
  return { seat: null, how: 'none' };
}

/** `Authorization: Basic base64(player:<secret>)` carries the seat password? Constant time. */
export function basicAuthMatches(header: unknown, secret: string | null): boolean {
  if (!secret || typeof header !== 'string') return false;
  const m = /^Basic\s+([A-Za-z0-9+/=]{1,400})$/i.exec(header.trim());
  if (!m) return false;
  const got = Buffer.from(Buffer.from(m[1]!, 'base64').toString('utf8'));
  const want = Buffer.from(`player:${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** A seat-login token: exactly 32 lowercase hex digits. */
const SEAT_TOKEN_RE = /^[a-f0-9]{32}$/;

const CREDENTIAL_KINDS: readonly AgentCredentialKind[] = ['claudeToken', 'anthropicApiKey', 'openaiApiKey'];

const CREDENTIAL_TEXT: Readonly<Record<AgentCredentialKind, { name: string; hint: string }>> = {
  claudeToken: {
    name: 'The Claude Code token',
    hint: 'Run `claude setup-token` on any machine logged in to the event account and paste the sk-ant-oat01-… line it prints.',
  },
  anthropicApiKey: {
    name: 'The Anthropic API key',
    hint: 'Paste an sk-ant-api03-… key from console.anthropic.com → API keys.',
  },
  openaiApiKey: {
    name: 'The OpenAI API key',
    hint: 'Paste an sk-… key from platform.openai.com → API keys.',
  },
};

/** "…" + the last 4 characters: all an admin page ever sees of a stored agent login. */
export function credentialHint(v: string | null): string | null {
  return v ? `…${v.slice(-4)}` : null;
}

/**
 * The shared login for a seat's agent (§11.2 f): Claude seats prefer the
 * Claude Code token (the subscription) over an Anthropic API key; Codex seats
 * get the OpenAI key. Null when nothing fitting is set.
 */
export function credentialForAgent(creds: Record<AgentCredentialKind, string | null>, agent: 'claude' | 'codex'): SeatCredentialDTO | null {
  if (agent === 'codex') return creds.openaiApiKey ? { env: 'OPENAI_API_KEY', value: creds.openaiApiKey } : null;
  if (creds.claudeToken) return { env: 'CLAUDE_CODE_OAUTH_TOKEN', value: creds.claudeToken };
  if (creds.anthropicApiKey) return { env: 'ANTHROPIC_API_KEY', value: creds.anthropicApiKey };
  return null;
}

export class ClaudeSeatsService {
  private terminals: TerminalControl | undefined;
  /** Player seat changes: 1 per second (§10.3). */
  private readonly changeLimiter = new RateLimiter(1, 1000);
  /** Failed seat logins per client address: 20 per minute. */
  private readonly seatLoginFails = new RateLimiter(20, 60_000);
  /** Every seat login per client address (one per terminal open; 8 seats share the AI session host's address): 120 per minute. */
  private readonly seatLoginCalls = new RateLimiter(120, 60_000);
  /** Which shared login each seat last fetched (§11.2 f; memory only, for /admin). */
  private readonly sharedLogins = new Map<number, { env: SeatCredentialEnv; at: number }>();

  constructor(private readonly game: Game) {}

  attachTerminals(control: TerminalControl | undefined): void {
    this.terminals = control;
  }

  /** The non-kicked player holding a Claude seat. */
  holder(seat: number): PlayerRecord | undefined {
    for (const p of this.game.store.players.values()) if (!p.kicked && p.claudeSeat === seat) return p;
    return undefined;
  }

  seatOf(p: PlayerRecord | undefined): number | null {
    return p && !p.kicked && typeof p.claudeSeat === 'number' ? p.claudeSeat : null;
  }

  /** Is the seat on (not turned off in /admin)? */
  enabled(seat: number): boolean {
    return !this.game.store.setup.disabledClaudeSeats.includes(seat);
  }

  private offError(seat: number): Result<never> {
    return fail('CLAUDE_SEAT_OFF', `AI seat ${seat} is turned off today.`, {
      hint: 'Pick another seat, or ask a grown-up.',
      details: { seat },
    });
  }

  /** The AI session host address and the seat password are both set. */
  boxReady(): boolean {
    const s = this.game.store.setup;
    return !!s.aiSessionHost && !!s.seatSecret;
  }

  /** Adults' status of a seat. */
  statusOf(seat: number): ClaudeSeatStatus {
    const s = this.game.store.setup;
    if (!s.aiSessionHost) return 'no-box';
    if (!s.seatSecret) return 'no-password';
    return this.terminals?.probeStatus(seat).status ?? 'unknown';
  }

  /** Players only see up / down / unknown (the rest needs a grown-up). */
  playerStatusOf(seat: number): PlayerClaudeSeatStatus {
    const s = this.statusOf(seat);
    return s === 'up' || s === 'down' ? s : 'unknown';
  }

  live(seat: number): LiveTerminal | null {
    return this.terminals?.live(seat) ?? null;
  }

  // -------------------------------------------------------------------------
  // Assignment
  // -------------------------------------------------------------------------

  /** PUT /me/claude-seat: a free seat, the own seat (no-op) or null. */
  claim(player: PlayerRecord, seatIn: unknown): Result<{ claudeSeat: number | null }> {
    const seat = seatIn === null ? null : parseClaudeSeat(seatIn);
    if (seatIn !== null && seat === null) {
      return fail('BAD_CLAUDE_SEAT', `There is no AI seat ${String(seatIn)}. AI seats are 1-${CLAUDE_SEATS}.`, {
        hint: "Use the number on your laptop's seat card.",
      });
    }
    const current = this.seatOf(player);
    if (seat === current) return ok({ claudeSeat: current });
    if (seat !== null && !this.enabled(seat)) return this.offError(seat);
    if (seat !== null) {
      const other = this.holder(seat);
      if (other && other.id !== player.id) {
        return fail('CLAUDE_SEAT_TAKEN', `AI seat ${seat} is ${other.name}'s.`, {
          hint: "Check the number on your laptop's card, or ask a grown-up.",
          details: { seat, takenBy: other.name },
        });
      }
    }
    const wait = this.changeLimiter.hit(player.id);
    if (wait > 0) {
      return fail('RATE_LIMITED', 'Slow down a little, then try again.', { details: { retryAfterMs: wait } });
    }
    player.claudeSeat = seat;
    this.changed();
    return ok({ claudeSeat: seat });
  }

  /**
   * PUT /admin/claude-seats/:seat: assign a seat to a player (moving them off
   * their old seat and unassigning the seat's previous holder), or clear it.
   */
  adminAssign(seatIn: unknown, playerIdIn: unknown): Result<AdminClaudeSeatsDTO> {
    const seat = parseClaudeSeat(seatIn);
    if (seat === null) return fail('BAD_CLAUDE_SEAT', `There is no AI seat ${String(seatIn)}. AI seats are 1-${CLAUDE_SEATS}.`);
    if (playerIdIn !== null && typeof playerIdIn !== 'string') {
      return fail('BAD_REQUEST', 'Send {"playerId": "<id>"} to assign, or {"playerId": null} to unassign.');
    }
    const player = playerIdIn === null ? undefined : this.game.players.get(playerIdIn);
    if (playerIdIn !== null && !player) return fail('NOT_FOUND', 'No such player.');
    if (player && !this.enabled(seat)) return fail('CLAUDE_SEAT_OFF', `AI seat ${seat} is off. Turn it on first.`, { details: { seat } });
    const previous = this.holder(seat);
    let changed = false;
    if (previous && previous.id !== player?.id) {
      previous.claudeSeat = null;
      changed = true;
    }
    // Moving a player frees their old seat (one field per player).
    if (player && player.claudeSeat !== seat) {
      player.claudeSeat = seat;
      changed = true;
    }
    if (changed) this.changed();
    return ok(this.adminDTO(false));
  }

  /**
   * Join / login from /play (§11.2 c): give the player a seat with no clicks,
   * by {@link pickClaudeSeat}. Synchronous, so many players joining at once
   * can't get the same seat. `preferredIn` = this laptop's seat (1-8) or
   * anything else for none. Not rate limited (one call per login).
   */
  autoAssign(player: PlayerRecord, preferredIn: unknown): ClaudeSeatAssignDTO {
    const pick = pickClaudeSeat({
      current: this.seatOf(player),
      preferred: parseClaudeSeat(preferredIn),
      enabled: (s) => this.enabled(s),
      taken: (s) => {
        const h = this.holder(s);
        return !!h && h.id !== player.id;
      },
    });
    if (pick.seat !== this.seatOf(player)) {
      player.claudeSeat = pick.seat;
      this.changed();
    }
    return pick;
  }

  /**
   * PUT /admin/claude-seats/:seat/enabled: turn a seat on or off. Off: its
   * player (if any) loses it and is moved to the lowest free seat that is on
   * (else they see the picker); their old terminal closes. On: nobody moves
   * (players without a seat see it in the picker).
   */
  setEnabled(seatIn: unknown, enabledIn: unknown): Result<AdminClaudeSeatsDTO> {
    const seat = parseClaudeSeat(seatIn);
    if (seat === null) return fail('BAD_CLAUDE_SEAT', `There is no AI seat ${String(seatIn)}. AI seats are 1-${CLAUDE_SEATS}.`);
    if (typeof enabledIn !== 'boolean') return fail('BAD_REQUEST', 'Send {"enabled": true} or {"enabled": false}.');
    if (this.enabled(seat) === enabledIn) return ok(this.adminDTO(false));
    const setup = this.game.store.setup;
    const off = new Set(setup.disabledClaudeSeats);
    if (enabledIn) off.delete(seat);
    else off.add(seat);
    setup.disabledClaudeSeats = [...off].sort((a, b) => a - b);
    const holder = enabledIn ? undefined : this.holder(seat);
    if (holder) {
      holder.claudeSeat = null;
      this.autoAssign(holder, null);
    }
    this.changed();
    return ok(this.adminDTO(false));
  }

  /**
   * POST /api/seat-login (§11.2 e, f): a seat's agent-loop trades its player
   * token for that player's login, so the AI helper starts logged in. Only
   * the AI session host can ask (Basic auth with the seat password, constant
   * time), and only for the seat's current player.
   *
   * With `agent` ('claude' | 'codex', sent by entrypoints that know about
   * shared logins) the answer also carries `credential`, the shared agent
   * login from /admin (or null), and a missing or stale token is not an error:
   * the agent still needs its login on an admin rescue or after a seat change.
   * Without `agent` (an older seat image) the answer is `{name, apiKey}` as before.
   */
  seatLogin(authHeader: unknown, seatIn: unknown, tokenIn: unknown, client = '?', agentIn?: unknown): Result<SeatLoginDTO> {
    const wait = Math.max(this.seatLoginFails.check(client), this.seatLoginCalls.hit(client));
    if (wait > 0) return fail('RATE_LIMITED', 'Too many seat logins. Wait and try again.', { details: { retryAfterMs: wait } });
    const refuse = (r: Result<never>) => {
      this.seatLoginFails.hit(client);
      return r;
    };
    if (!basicAuthMatches(authHeader, this.game.store.setup.seatSecret)) {
      return refuse(fail('BAD_LOGIN', 'Wrong seat password.', { hint: 'Send Basic auth player:<SEAT_SECRET>, the same value as in /admin.' }));
    }
    const seat = parseClaudeSeat(seatIn);
    if (seat === null) return refuse(fail('BAD_CLAUDE_SEAT', `There is no AI seat ${String(seatIn)}. AI seats are 1-${CLAUDE_SEATS}.`));
    const agent = agentIn === 'claude' || agentIn === 'codex' ? agentIn : null;
    if (agentIn !== undefined && agent === null) return refuse(fail('BAD_REQUEST', 'agent must be "claude" or "codex".'));
    const token = typeof tokenIn === 'string' ? tokenIn : '';
    const holder = this.holder(seat);
    const player = holder && SEAT_TOKEN_RE.test(token) && seatPlayerToken(seat, holder.id) === token ? holder : undefined;
    if (agent === null) {
      if (!player) return refuse(fail('NOT_FOUND', "That token isn't this seat's player."));
      return ok({ name: player.name, apiKey: player.apiKey });
    }
    const credential = credentialForAgent(this.game.store.setup.agentCredentials, agent);
    if (credential) this.sharedLogins.set(seat, { env: credential.env, at: Date.now() });
    else this.sharedLogins.delete(seat);
    this.game.notifier.terminalsChanged?.();
    return ok(player ? { name: player.name, apiKey: player.apiKey, credential } : { credential });
  }

  /**
   * PUT /admin/agent-credentials (§11.2 f): set or clear the shared agent
   * logins. `undefined` leaves a field, `null` or "" clears it. Whitespace is
   * removed (a long token often wraps when copied from a terminal). Each seat
   * picks the change up the next time its terminal opens.
   */
  setAgentCredentials(patch: Partial<Record<AgentCredentialKind, unknown>>): Result<AdminClaudeSeatsDTO> {
    const next = { ...this.game.store.setup.agentCredentials };
    for (const kind of CREDENTIAL_KINDS) {
      const v = patch[kind];
      if (v === undefined) continue;
      if (v === null || v === '') {
        next[kind] = null;
        continue;
      }
      const s = typeof v === 'string' ? v.replace(/\s+/g, '') : '';
      if (!AGENT_CREDENTIAL_RE[kind].test(s)) {
        const other = CREDENTIAL_KINDS.find((k) => k !== kind && AGENT_CREDENTIAL_RE[k].test(s));
        const { name, hint } = CREDENTIAL_TEXT[kind];
        return fail('BAD_AGENT_CREDENTIAL', `${name} doesn't look right.`, {
          hint: other ? `That looks like ${CREDENTIAL_TEXT[other].name.replace(/^The /, 'the ')}: paste it in that field instead.` : hint,
          details: { field: kind },
        });
      }
      next[kind] = s;
    }
    this.game.store.setup = { ...this.game.store.setup, agentCredentials: next };
    this.game.store.save();
    this.game.notifier.terminalsChanged?.();
    return ok(this.adminDTO(false));
  }

  /** Kick: the seat is free again (the record keeps nothing). */
  release(player: PlayerRecord): void {
    if (player.claudeSeat == null) return;
    player.claudeSeat = null;
    this.changed();
  }

  /** Assignments changed: persist, push, and close terminals that lost access. */
  changed(): void {
    this.game.store.save();
    this.game.notifier.terminalsChanged?.();
    this.game.notifier.stateChanged();
    this.terminals?.recheck();
  }

  /** Sessions or admin logins changed (logout, PIN reset, kick, wipe). */
  accessChanged(): void {
    this.terminals?.recheck();
  }

  /** Probe every seat now ("Check now", setup changes). */
  async probeAll(): Promise<void> {
    await this.terminals?.probeAll();
  }

  // -------------------------------------------------------------------------
  // DTOs (none of them carries the seat password, except adminDTO(true), or
  // a shared agent login: only seatLogin hands those out)
  // -------------------------------------------------------------------------

  playerDTO(player: PlayerRecord): ClaudeSeatsDTO {
    const mySeat = this.seatOf(player);
    return {
      mySeat,
      boxReady: this.boxReady(),
      seats: seatNumbers()
        .filter((seat) => this.enabled(seat))
        .map((seat) => {
          const h = this.holder(seat);
          return { seat, takenBy: h ? h.name : null, mine: seat === mySeat, status: this.playerStatusOf(seat) };
        }),
    };
  }

  /** WS 'terminal' for one player. */
  terminalDTO(playerId: string): TerminalDTO {
    const seat = this.seatOf(this.game.players.get(playerId));
    const live = seat === null ? null : this.live(seat);
    return {
      seat,
      status: seat === null ? 'unknown' : this.playerStatusOf(seat),
      boxReady: this.boxReady(),
      live: live ? { pane: live.pane, by: live.by, since: live.since } : null,
    };
  }

  adminDTO(details: boolean): AdminClaudeSeatsDTO {
    const { aiSessionHost, seatSecret } = this.game.store.setup;
    const seats = seatNumbers().map((seat): AdminClaudeSeatDTO => {
      const h = this.holder(seat);
      const probe = this.terminals?.probeStatus(seat);
      const status = this.statusOf(seat);
      const row: AdminClaudeSeatDTO = {
        seat,
        enabled: this.enabled(seat),
        playerId: h?.id ?? null,
        playerName: h?.name ?? null,
        status,
        checkedAt: probe?.checkedAt ?? null,
        live: this.live(seat),
        sharedLogin: this.sharedLogins.get(seat) ?? null,
      };
      if (status === 'down' && probe?.reason) row.reason = probe.reason;
      if (details && aiSessionHost) row.directUrl = directSeatUrl(aiSessionHost, seat);
      return row;
    });
    const creds = this.game.store.setup.agentCredentials;
    const agentCredentials = {
      claudeToken: credentialHint(creds.claudeToken),
      anthropicApiKey: credentialHint(creds.anthropicApiKey),
      openaiApiKey: credentialHint(creds.openaiApiKey),
    };
    const out: AdminClaudeSeatsDTO = { boxHost: aiSessionHost, seatSecretSet: !!seatSecret, agentCredentials, seats };
    if (details) out.seatSecret = seatSecret;
    return out;
  }
}
