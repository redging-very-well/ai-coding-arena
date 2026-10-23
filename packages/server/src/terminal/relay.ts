// One live seat terminal (plan §11.2 b "WebSocket relay"): the browser's
// WebSocket and ttyd's, both terminated here and relayed message by message
// (text/binary kept). The browser's first message is ttyd's JSON
// `{AuthToken, columns, rows}`; its AuthToken is replaced with the real one,
// so the seat password never reaches a browser. Backpressure pauses the
// sending side while the other one has more than 1 MB queued.
//
// Closing: browser gone → close upstream (ttyd ends that Claude). Upstream
// gone unexpectedly → close the browser with 1011 so ttyd's page reconnects by
// itself. Proxy-initiated closes (takeover, access revoked) use 1000 with an
// explanatory output line: ttyd's page then waits for Enter instead of
// reconnecting, so two tabs can't steal the seat back and forth.

import type { RawData, WebSocket } from 'ws';
import { log } from '../util/log.js';

/** Pause a side while the other has more than this queued. */
export const MAX_BUFFERED = 1024 * 1024;

/** ttyd server → client command byte for terminal output. */
const TTYD_OUTPUT = 0x30; // '0'

export interface RelayInfo {
  seat: number;
  /** The /play iframe's pane id; null = a standalone tab (or the admin). */
  pane: string | null;
  by: 'player' | 'admin';
  playerId?: string;
  playerName?: string;
  /** Cookies the relay was opened with (access is re-checked against them). */
  sessionToken?: string;
  adminToken?: string;
  clientIp: string;
}

export class Relay {
  readonly since = Date.now();
  /** Answered the last ping. */
  alive = true;
  private authed = false;
  private closing = false;
  private closeReason: string | undefined;
  private finished = false;

  constructor(
    readonly info: RelayInfo,
    readonly browser: WebSocket,
    readonly upstream: WebSocket,
    /** The ttyd `AuthToken` (base64 `player:<secret>`). */
    private readonly authToken: string,
    private readonly onFinish: (relay: Relay, why: string) => void,
  ) {}

  get label(): string {
    const i = this.info;
    const who = i.by === 'admin' ? 'admin' : `player "${i.playerName ?? '?'}"`;
    return `seat ${i.seat} ${who}${i.pane ? ` pane ${i.pane}` : ' (standalone tab)'}`;
  }

  start(): void {
    const { browser, upstream } = this;
    browser.on('message', (data, isBinary) => {
      if (!this.authed) {
        this.authed = true;
        this.sendAuth(data, isBinary);
        return;
      }
      this.forward(upstream, browser, data, isBinary);
    });
    upstream.on('message', (data, isBinary) => this.forward(browser, upstream, data, isBinary));
    browser.on('pong', () => {
      this.alive = true;
    });
    browser.on('close', () => {
      if (upstream.readyState === upstream.OPEN || upstream.readyState === upstream.CONNECTING) upstream.close(1000, 'browser closed');
      this.finish(this.closeReason ?? 'browser closed');
    });
    upstream.on('close', (code) => {
      if (!this.closing && browser.readyState === browser.OPEN) {
        // ttyd's page reconnects on anything but 1000: a restarted seat comes back by itself.
        browser.close(1011, 'claude box closed');
      }
      this.finish(this.closeReason ?? `upstream closed (${code})`);
    });
    browser.on('error', () => undefined);
    upstream.on('error', () => undefined);
  }

  /** The first browser message: ttyd's JSON hello with the real AuthToken swapped in. */
  private sendAuth(data: RawData, isBinary: boolean): void {
    let hello: unknown;
    try {
      hello = JSON.parse(rawToBuffer(data).toString('utf8'));
    } catch {
      hello = null;
    }
    if (!hello || typeof hello !== 'object' || Array.isArray(hello)) {
      log.warn(`[terminal] ${this.label}: first message is not ttyd's hello; closing`);
      this.end(1008, 'bad hello');
      return;
    }
    const text = JSON.stringify({ ...(hello as Record<string, unknown>), AuthToken: this.authToken });
    if (this.upstream.readyState !== this.upstream.OPEN) return;
    this.upstream.send(isBinary ? Buffer.from(text, 'utf8') : text, { binary: isBinary });
  }

  private forward(to: WebSocket, from: WebSocket, data: RawData, isBinary: boolean): void {
    if (to.readyState !== to.OPEN) return;
    to.send(rawToBuffer(data), { binary: isBinary }, () => {
      if (from.isPaused && to.bufferedAmount <= MAX_BUFFERED) from.resume();
    });
    if (to.bufferedAmount > MAX_BUFFERED && !from.isPaused) from.pause();
  }

  /**
   * Proxy-initiated close: show `text` in the terminal (a ttyd output frame),
   * then close the browser with `code` and end the upstream (its Claude).
   */
  end(code: number, reason: string, text?: string): void {
    if (this.closing) return;
    this.closing = true;
    this.closeReason = reason;
    const { browser, upstream } = this;
    if (browser.readyState === browser.OPEN) {
      if (text) browser.send(Buffer.concat([Buffer.from([TTYD_OUTPUT]), Buffer.from(text, 'utf8')]), { binary: true });
      browser.close(code, reason);
    } else browser.terminate();
    if (upstream.readyState === upstream.OPEN || upstream.readyState === upstream.CONNECTING) upstream.close(1000, reason);
    // A browser that never answers the close handshake still goes.
    setTimeout(() => {
      browser.terminate();
      upstream.terminate();
    }, 2000).unref?.();
  }

  /** Server shutdown. */
  terminate(): void {
    this.closing = true;
    this.closeReason ??= 'server stopping';
    this.browser.terminate();
    this.upstream.terminate();
    this.finish(this.closeReason);
  }

  private finish(why: string): void {
    if (this.finished) return;
    this.finished = true;
    this.onFinish(this, why);
  }
}

function rawToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
