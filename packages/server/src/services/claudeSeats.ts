// Claude seats (plan §11.2 c): which player sits at which Claude laptop (seat
// 1-8 = container seatN on the Claude box, port 778N, proxy path
// /terminal/N/). Independent of the game seat (colour/zone). Unique across
// players, persisted on the player record, freed by kick and wipe, kept across
// logout, PIN reset, New match and restarts.
//
// The live side (who holds a seat's terminal, the seat probe) belongs to the
// terminal proxy (src/terminal), which attaches itself as `TerminalControl`.
// Without it (service-only tests) statuses are `unknown` and nothing is live.

import {
  CLAUDE_SEATS,
  fail,
  ok,
  type AdminClaudeSeatDTO,
  type AdminClaudeSeatsDTO,
  type ClaudeSeatStatus,
  type ClaudeSeatsDTO,
  type PlayerClaudeSeatStatus,
  type Result,
  type TerminalDTO,
  type TerminalLiveDTO,
} from '@pixel-clash/shared';
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

export class ClaudeSeatsService {
  private terminals: TerminalControl | undefined;
  /** Player seat changes: 1 per second (§10.3). */
  private readonly changeLimiter = new RateLimiter(1, 1000);

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
      return fail('BAD_CLAUDE_SEAT', `There is no Claude seat ${String(seatIn)}. Claude seats are 1-${CLAUDE_SEATS}.`, {
        hint: "Use the number on your laptop's seat card.",
      });
    }
    const current = this.seatOf(player);
    if (seat === current) return ok({ claudeSeat: current });
    if (seat !== null) {
      const other = this.holder(seat);
      if (other && other.id !== player.id) {
        return fail('CLAUDE_SEAT_TAKEN', `Claude seat ${seat} is ${other.name}'s.`, {
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
    if (seat === null) return fail('BAD_CLAUDE_SEAT', `There is no Claude seat ${String(seatIn)}. Claude seats are 1-${CLAUDE_SEATS}.`);
    if (playerIdIn !== null && typeof playerIdIn !== 'string') {
      return fail('BAD_REQUEST', 'Send {"playerId": "<id>"} to assign, or {"playerId": null} to unassign.');
    }
    const player = playerIdIn === null ? undefined : this.game.players.get(playerIdIn);
    if (playerIdIn !== null && !player) return fail('NOT_FOUND', 'No such player.');
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
      seats: seatNumbers().map((seat) => {
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
