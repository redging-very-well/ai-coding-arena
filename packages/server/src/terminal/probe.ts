// Seat probe (plan §11.2 b): `GET /terminal/N/token` on each seat's ttyd with
// the injected auth (spawns no Claude). Every tick (10 s) for seats with an
// assigned player or a live terminal, every 60 s for the rest, and at once on
// setup changes or "Check now" (seats turned off: only then). 200 → up, 401 → wrong-password, anything else
// that answers → up, refused/timeout → down. Only changes are logged and
// pushed. Proxied requests and relays report what they see too (`observe`).

import { request } from 'node:http';
import type { ProbeStatus } from '../services/claudeSeats.js';
import { seatNumbers } from '../services/claudeSeats.js';
import type { Game } from '../services/game.js';
import { log } from '../util/log.js';
import { errorReason, forwardRequestHeaders, type ResolveUpstream, type TerminalTimeouts } from './upstream.js';

export class SeatProbe {
  private readonly status = new Map<number, ProbeStatus>();
  private readonly lastProbe = new Map<number, number>();
  private readonly inFlight = new Map<number, Promise<void>>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly game: Game,
    private readonly resolve: ResolveUpstream,
    private readonly timeouts: TerminalTimeouts,
    /** Seats with a live terminal (probed as "in use"). */
    private readonly isLive: (seat: number) => boolean,
  ) {}

  start(): void {
    this.timer = setInterval(() => this.tick(), this.timeouts.probeTickMs);
    this.timer.unref?.();
    void this.probeAll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  get(seat: number): ProbeStatus {
    return this.status.get(seat) ?? { status: 'unknown', checkedAt: null };
  }

  /** Record a seat's status; logs and pushes only changes. */
  observe(seat: number, status: ProbeStatus['status'], reason?: string): void {
    const prev = this.status.get(seat);
    const next: ProbeStatus = { status, checkedAt: Date.now(), ...(status === 'down' && reason ? { reason } : {}) };
    this.status.set(seat, next);
    if (prev?.status === status && prev.reason === next.reason) return;
    if (status === 'down') log.warn(`[terminal] seat ${seat} down: ${reason ?? 'no answer'}`);
    else if (status === 'wrong-password') log.warn(`[terminal] seat ${seat} wrong password (does the seat password in /admin match SEAT_SECRET?)`);
    else if (prev && prev.status !== 'unknown') log.info(`[terminal] seat ${seat} ${status}`);
    this.game.notifier.terminalsChanged?.();
  }

  /** Probe every seat now (setup change, "Check now"). */
  async probeAll(): Promise<void> {
    await Promise.all(seatNumbers().map((seat) => this.probe(seat)));
  }

  private tick(): void {
    const now = Date.now();
    for (const seat of seatNumbers()) {
      // A seat turned off in /admin (§11.2 c) is only probed by "Check now".
      if (!this.game.claudeSeats.enabled(seat)) continue;
      const inUse = !!this.game.claudeSeats.holder(seat) || this.isLive(seat);
      const every = inUse ? this.timeouts.probeTickMs : this.timeouts.probeIdleMs;
      // A little slack so a seat due "now" isn't pushed to the next tick by timer jitter.
      if (now - (this.lastProbe.get(seat) ?? 0) >= every - 500) void this.probe(seat);
    }
  }

  /** Probe one seat (joins a probe already running for it). */
  probe(seat: number): Promise<void> {
    const running = this.inFlight.get(seat);
    if (running) return running;
    const p = this.run(seat).finally(() => this.inFlight.delete(seat));
    this.inFlight.set(seat, p);
    return p;
  }

  private run(seat: number): Promise<void> {
    const { claudeBoxHost, seatSecret } = this.game.store.setup;
    this.lastProbe.set(seat, Date.now());
    // Not configured: claudeSeats reports no-box / no-password itself.
    if (!claudeBoxHost || !seatSecret) {
      this.status.delete(seat);
      return Promise.resolve();
    }
    const upstream = this.resolve(seat, claudeBoxHost);
    return new Promise<void>((done) => {
      let settled = false;
      const finish = (status: ProbeStatus['status'], reason?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // The setup may have changed while this probe ran: drop a stale answer.
        const now = this.game.store.setup;
        if (now.claudeBoxHost === claudeBoxHost && now.seatSecret === seatSecret) this.observe(seat, status, reason);
        done();
      };
      const req = request({
        host: upstream.host,
        port: upstream.port,
        method: 'GET',
        path: `/terminal/${seat}/token`,
        agent: false,
        headers: forwardRequestHeaders({}, { upstream, secret: seatSecret, clientIp: undefined, originalHost: undefined }),
      });
      const timer = setTimeout(() => {
        finish('down', 'timeout');
        req.destroy();
      }, this.timeouts.probeMs);
      timer.unref?.();
      req.on('response', (res) => {
        res.resume();
        finish(res.statusCode === 401 ? 'wrong-password' : 'up');
      });
      req.on('error', (err) => finish('down', errorReason(err)));
      req.end();
    });
  }
}
