// Claude seats (plan §11.2 c): which player sits at which Claude laptop (seat
// 1-8 = container seatN on the Claude box, port 778N, proxy path
// /terminal/N/). Independent of the game seat (colour/zone). Unique across
// players, persisted on the player record, freed by kick and wipe, kept across
// logout, PIN reset, New match and restarts.
//
// Join and login from /play auto-assign a seat (`autoAssign`, preference:
// own seat, this laptop's seat, the lowest free one). The admin can turn
// seats off (`setEnabled`): never assigned or pickable; turning off a held
// seat moves its player to the lowest free seat that is on. `seatLogin` hands
// the seat's agent-loop the player's login (§11.2 e), so the AI helper starts
// logged in.
//
// The live side (who holds a seat's terminal, the seat probe) belongs to the
// terminal proxy (src/terminal), which attaches itself as `TerminalControl`.
// Without it (service-only tests) statuses are `unknown` and nothing is live.

import {
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
  type SeatLoginDTO,
  type TerminalDTO,
  type TerminalLiveDTO,
} from '@pixel-clash/shared';
import { createHash, timingSafeEqual } from 'node:crypto';
import { RateLimiter } from '../util/ratelimit.js';
import type { Game } from './game.js';
import type { PlayerRecord } from './store.js';

/** ttyd host port of Claude seat 1 (seat N → 7780 + N, §11.1). */
export const CLAUDE_SEAT_BASE_PORT = 7780;

/** The seat password (§11.2 a): no spaces or ':' (ttyd's `-c user:pass` can't take them). */
export const SEAT_SECRET_RE = /^[A-Za-z0-9._~-]{12,64}$/;

export type LiveTerminal = TerminalLiveDTO & { playerName?: string };

/** What the probe knows about a seat (the proxy's view of the Claude box). */
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

export class ClaudeSeatsService {
  private terminals: TerminalControl | undefined;
  /** Player seat changes: 1 per second (§10.3). */
  private readonly changeLimiter = new RateLimiter(1, 1000);
  /** Failed seat logins per client address: 20 per minute. */
  private readonly seatLoginFails = new RateLimiter(20, 60_000);

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

  /** The Claude box address and the seat password are both set. */
  boxReady(): boolean {
    const s = this.game.store.setup;
    return !!s.claudeBoxHost && !!s.seatSecret;
  }

  /** Adults' status of a seat. */
  statusOf(seat: number): ClaudeSeatStatus {
    const s = this.game.store.setup;
    if (!s.claudeBoxHost) return 'no-box';
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
   * POST /api/seat-login (§11.2 e): a seat's agent-loop trades its player
   * token for that player's login, so the AI helper starts logged in. Only
   * the Claude box can ask (Basic auth with the seat password), and only for
   * the seat's current player.
   */
  seatLogin(authHeader: unknown, seatIn: unknown, tokenIn: unknown, client = '?'): Result<SeatLoginDTO> {
    const wait = this.seatLoginFails.check(client);
    if (wait > 0) return fail('RATE_LIMITED', 'Too many failed seat logins. Wait and try again.', { details: { retryAfterMs: wait } });
    const refuse = (r: Result<never>) => {
      this.seatLoginFails.hit(client);
      return r;
    };
    if (!basicAuthMatches(authHeader, this.game.store.setup.seatSecret)) {
      return refuse(fail('BAD_LOGIN', 'Wrong seat password.', { hint: 'Send Basic auth player:<SEAT_SECRET>, the same value as in /admin.' }));
    }
    const seat = parseClaudeSeat(seatIn);
    const token = typeof tokenIn === 'string' ? tokenIn : '';
    const holder = seat === null ? undefined : this.holder(seat);
    if (seat === null || !SEAT_TOKEN_RE.test(token) || !holder || seatPlayerToken(seat, holder.id) !== token) {
      return refuse(fail('NOT_FOUND', "That token isn't this seat's player."));
    }
    return ok({ name: holder.name, apiKey: holder.apiKey });
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
  // DTOs (none of them carries the seat password, except adminDTO(true))
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
    const { claudeBoxHost, seatSecret } = this.game.store.setup;
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
      };
      if (status === 'down' && probe?.reason) row.reason = probe.reason;
      if (details && claudeBoxHost) row.directUrl = directSeatUrl(claudeBoxHost, seat);
      return row;
    });
    const out: AdminClaudeSeatsDTO = { boxHost: claudeBoxHost, seatSecretSet: !!seatSecret, seats };
    if (details) out.seatSecret = seatSecret;
    return out;
  }
}
