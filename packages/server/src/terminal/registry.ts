// One live terminal per Claude seat, newest wins (plan §11.2 b). Each ttyd
// connection spawns its own `claude`, so two tabs on one seat would be two
// Claudes fighting over /kit. When a new relay for seat N is established the
// old one gets a takeover line in its terminal and is closed with 1000 (ttyd's
// page then waits for Enter rather than reconnecting).
//
// Flap guard: more than 4 takeovers of one seat in 10 s → new upgrades for
// that seat are refused for 5 s (TERMINAL_BUSY), logged once.
//
// The registry also pings every browser side every 30 s and drops one that
// missed a pong (≤ 60 s). There is no idle timeout: a quiet terminal is normal.

import type { Game } from '../services/game.js';
import type { LiveTerminal } from '../services/claudeSeats.js';
import { log } from '../util/log.js';
import type { Relay } from './relay.js';

export const FLAP_MAX_TAKEOVERS = 4;
export const FLAP_WINDOW_MS = 10_000;
export const FLAP_BLOCK_MS = 5000;

export const TAKEOVER_TEXT =
  '\r\n\r\n  Your AI helper terminal was opened in another tab.\r\n  Press Enter here to use it in this tab instead.\r\n';
export const ADMIN_TAKEOVER_TEXT = '\r\n\r\n  A grown-up opened your terminal to help.\r\n  Press Enter to get it back.\r\n';
/** The admin's rescue tab when the player takes their seat back. */
export const PLAYER_RECLAIM_TEXT = '\r\n\r\n  The player took their AI helper terminal back.\r\n  Press Enter to open it here again (that takes it from them).\r\n';

export class TerminalRegistry {
  private readonly live = new Map<number, Relay>();
  private readonly takeovers = new Map<number, number[]>();
  private readonly blockedUntil = new Map<number, number>();
  private heartbeat: NodeJS.Timeout | undefined;

  constructor(
    private readonly game: Game,
    private readonly pingMs: number,
  ) {}

  start(): void {
    this.heartbeat = setInterval(() => {
      for (const r of this.live.values()) {
        if (!r.alive) {
          log.info(`[terminal] ${r.label}: no pong, dropping`);
          r.browser.terminate();
          continue;
        }
        r.alive = false;
        r.browser.ping();
      }
    }, this.pingMs);
    this.heartbeat.unref?.();
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    for (const r of [...this.live.values()]) r.terminate();
    this.live.clear();
  }

  get(seat: number): Relay | undefined {
    return this.live.get(seat);
  }

  relays(): Relay[] {
    return [...this.live.values()];
  }

  liveOf(seat: number): LiveTerminal | null {
    const r = this.live.get(seat);
    if (!r) return null;
    const out: LiveTerminal = { pane: r.info.pane, by: r.info.by, since: r.since };
    if (r.info.playerName) out.playerName = r.info.playerName;
    return out;
  }

  /** The flap guard is refusing new terminals for this seat. */
  busy(seat: number, now = Date.now()): boolean {
    return (this.blockedUntil.get(seat) ?? 0) > now;
  }

  /** A new relay is established: it becomes the seat's live terminal; the old one is taken over. */
  register(relay: Relay): void {
    const seat = relay.info.seat;
    const old = this.live.get(seat);
    this.live.set(seat, relay);
    log.info(`[terminal] ${relay.label} open from ${relay.info.clientIp}`);
    if (old) {
      log.info(`[terminal] seat ${seat} taken over by ${relay.info.by === 'admin' ? 'admin' : `player "${relay.info.playerName ?? '?'}"`}${relay.info.pane ? ` (pane ${relay.info.pane})` : ' (standalone tab)'}`);
      const text =
        relay.info.by === 'admin' && old.info.by === 'player'
          ? ADMIN_TAKEOVER_TEXT
          : relay.info.by === 'player' && old.info.by === 'admin'
            ? PLAYER_RECLAIM_TEXT
            : TAKEOVER_TEXT;
      old.end(1000, 'taken-over', text);
      this.countTakeover(seat);
    }
    this.game.notifier.terminalsChanged?.();
  }

  /** Called by a relay when both sides are gone. */
  finished(relay: Relay, why: string): void {
    const secs = Math.round((Date.now() - relay.since) / 1000);
    log.info(`[terminal] ${relay.label} closed (${why}) after ${secs} s`);
    if (this.live.get(relay.info.seat) !== relay) return;
    this.live.delete(relay.info.seat);
    this.game.notifier.terminalsChanged?.();
  }

  private countTakeover(seat: number): void {
    const now = Date.now();
    const list = (this.takeovers.get(seat) ?? []).filter((t) => now - t < FLAP_WINDOW_MS);
    list.push(now);
    if (list.length > FLAP_MAX_TAKEOVERS) {
      this.blockedUntil.set(seat, now + FLAP_BLOCK_MS);
      this.takeovers.set(seat, []);
      log.warn(`[terminal] seat ${seat} is flapping between tabs (${list.length} takeovers in ${FLAP_WINDOW_MS / 1000} s); refusing new terminals for ${FLAP_BLOCK_MS / 1000} s`);
      return;
    }
    this.takeovers.set(seat, list);
  }
}
