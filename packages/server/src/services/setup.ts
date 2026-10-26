// /setup info (plan §11 "/setup page", §12.3 server info): the join URL + QR,
// the seat cards (`/play?seat=N` + QR for Claude seats 1-8, §11.2), and the
// facilitator's settings: the AI session host address and the shared seat password
// (`seatSecret`, §11.2 a), which never appears in any public payload.

import { randomInt } from 'node:crypto';
import QRCode from 'qrcode';
import { CLAUDE_SEATS, type Result, type SeatCardDTO, type SeatTerminalDTO, type SetupInfoDTO, type SetupSettingsDTO } from '@pixel-clash/shared';
import { log } from '../util/log.js';
import { lanUrls } from '../util/lan.js';
import { PASSWORD_WORDS } from './auth.js';
import { SEAT_SECRET_RE, directSeatUrl, seatNumbers } from './claudeSeats.js';
import type { Game } from './game.js';
import { safeHost } from './kit.js';

/** ttyd host port of seat index 0 (index i → 7781 + i = Claude seat i + 1, §11.1). */
export const SEAT_TERMINAL_BASE_PORT = 7781;
/** AI seats on the AI session host (seat1..seat8). */
export const SEAT_COUNT = CLAUDE_SEATS;

/** Host name or IPv4 (no scheme, port or path). */
const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*$/;
/** `http://host[:port]` (no path). */
const BASE_URL_RE = /^https?:\/\/[A-Za-z0-9.-]{1,253}(?::\d{1,5})?$/;

/** Normalise what the facilitator typed: strips a scheme, a port and a trailing slash. */
export function normalizeClaudeBoxHost(input: string): string | null {
  const s = input
    .trim()
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '');
  return HOST_RE.test(s) ? s.toLowerCase() : null;
}

export function normalizeBaseUrl(input: string): string | null {
  const s = input.trim().replace(/\/+$/, '');
  return BASE_URL_RE.test(s) ? s : null;
}

/** Direct ttyd URL of seat index 0-7 (Claude seat index + 1; ttyd runs with `-b /terminal/N`). */
export function seatTerminalUrl(host: string, seat: number): string {
  return directSeatUrl(host, seat + 1);
}

const qrCache = new Map<string, string>();

/** QR code as a compact SVG document (cached; the inputs are few and stable). */
export async function qrSvg(text: string): Promise<string> {
  const hit = qrCache.get(text);
  if (hit) return hit;
  const svg = await QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
  if (qrCache.size > 64) qrCache.clear();
  qrCache.set(text, svg);
  return svg;
}

/**
 * A new seat password: four random words joined by '-' (400^4 ≈ 2.6e10, ~34
 * bits; the seat-login check is rate-limited). Always matches SEAT_SECRET_RE.
 */
export function generateSeatSecret(): string {
  return Array.from({ length: 4 }, () => PASSWORD_WORDS[randomInt(PASSWORD_WORDS.length)]).join('-');
}

/**
 * The AI session host setup command shown in /admin → AI seats (details only): run
 * in the repo on the AI session host, it writes both values into sessions/.env and
 * starts the seats. Both values are validated (URL shape, secret charset), so
 * the command needs no quoting. Null when either is unusable.
 */
export function seatSetupCommand(baseUrl: string, seatSecret: string | null): string | null {
  const url = normalizeBaseUrl(baseUrl);
  if (!url || !seatSecret || !SEAT_SECRET_RE.test(seatSecret)) return null;
  return `make seats PIXEL_CLASH_URL=${url} SEAT_SECRET=${seatSecret}`;
}

export class SetupService {
  constructor(private readonly game: Game) {}

  /**
   * On start (after the store loaded): if no seat password is stored, make one
   * up and save it with the venue settings, so nobody has to invent one. An
   * existing password is never replaced. The value is not logged.
   */
  ensureSeatSecret(): boolean {
    if (this.game.store.setup.seatSecret) return false;
    this.game.store.setup = { ...this.game.store.setup, seatSecret: generateSeatSecret() };
    this.game.store.save();
    log.info('[setup] made up a seat password for the AI session host (see /admin → AI seats → AI session host setup)');
    return true;
  }

  /** {@link seatSetupCommand} for this server's base URL (preferred URL, else the request's LAN host, else the first LAN address). */
  setupCommand(requestHost: string | undefined): string | null {
    return seatSetupCommand(this.baseUrl(requestHost), this.game.store.setup.seatSecret);
  }

  /** The public settings (never the seat password). */
  get settings(): SetupSettingsDTO {
    const { claudeBoxHost, preferredUrl } = this.game.store.setup;
    return { claudeBoxHost, preferredUrl };
  }

  get seatSecretSet(): boolean {
    return !!this.game.store.setup.seatSecret;
  }

  /** Update settings: `null` or "" clears a field, `undefined` leaves it. */
  update(patch: { claudeBoxHost?: unknown; preferredUrl?: unknown; seatSecret?: unknown }): Result<SetupSettingsDTO> {
    const before = this.game.store.setup;
    const next = { ...before };
    if (patch.claudeBoxHost !== undefined) {
      if (patch.claudeBoxHost === null || patch.claudeBoxHost === '') next.claudeBoxHost = null;
      else {
        const h = typeof patch.claudeBoxHost === 'string' ? normalizeClaudeBoxHost(patch.claudeBoxHost) : null;
        if (!h) {
          return {
            ok: false,
            error: { code: 'BAD_REQUEST', message: 'The AI session host address must be a host name or IP, like 192.168.8.20.' },
          };
        }
        next.claudeBoxHost = h;
      }
    }
    if (patch.preferredUrl !== undefined) {
      if (patch.preferredUrl === null || patch.preferredUrl === '') next.preferredUrl = null;
      else {
        const u = typeof patch.preferredUrl === 'string' ? normalizeBaseUrl(patch.preferredUrl) : null;
        if (!u) return { ok: false, error: { code: 'BAD_REQUEST', message: 'The preferred URL must look like http://192.168.8.10:8080.' } };
        next.preferredUrl = u;
      }
    }
    if (patch.seatSecret !== undefined) {
      if (patch.seatSecret === null || patch.seatSecret === '') next.seatSecret = null;
      else {
        const v = typeof patch.seatSecret === 'string' ? patch.seatSecret.trim() : '';
        if (!SEAT_SECRET_RE.test(v)) {
          return {
            ok: false,
            error: {
              code: 'BAD_SEAT_SECRET',
              message: 'The seat password must be 12-64 letters, digits, ".", "_", "~" or "-" (no spaces or ":").',
              hint: 'Use the same value as SEAT_SECRET in sessions/.env on the AI session host, e.g. otter-lamp-quartz-ninety.',
            },
          };
        }
        next.seatSecret = v;
      }
    }
    this.game.store.setup = next;
    this.game.store.save();
    this.game.notifier.stateChanged();
    if (next.claudeBoxHost !== before.claudeBoxHost || next.seatSecret !== before.seatSecret) {
      // Statuses change at once (no-box / no-password); the probe re-checks every seat.
      this.game.notifier.terminalsChanged?.();
      void this.game.claudeSeats.probeAll();
    }
    return { ok: true, data: this.settings };
  }

  /**
   * Base URL for links/QRs when no preferred URL is set: the request's own Host
   * when the page was opened by a LAN address, else the first LAN address.
   */
  baseUrlFromHost(requestHost: string | undefined, lan = lanUrls(this.game.visibility.port)): string {
    const host = safeHost(requestHost);
    const local = /^(localhost|127\.|\[::1\]|::1)/i.test(host);
    return local && lan[0] ? lan[0] : `http://${host}`;
  }

  /** The base URL the facilitator chose, else {@link baseUrlFromHost}. */
  baseUrl(requestHost: string | undefined): string {
    return this.game.store.setup.preferredUrl ?? this.baseUrlFromHost(requestHost);
  }

  /** Public setup info. `requestHost` (the Host header) is the last-resort base URL. */
  async info(requestHost: string | undefined): Promise<SetupInfoDTO> {
    const port = this.game.visibility.port;
    const lan = lanUrls(port);
    const { claudeBoxHost, preferredUrl } = this.game.store.setup;
    const baseUrl = preferredUrl ?? this.baseUrlFromHost(requestHost, lan);
    const playUrl = `${baseUrl}/play`;
    const seatTerminals: SeatTerminalDTO[] = [];
    if (claudeBoxHost) {
      for (let seat = 0; seat < SEAT_COUNT; seat++) {
        const url = seatTerminalUrl(claudeBoxHost, seat);
        seatTerminals.push({ seat, url, qrSvg: await qrSvg(url) });
      }
    }
    const seatCards: SeatCardDTO[] = [];
    for (const seat of seatNumbers()) {
      const url = `${baseUrl}/play?seat=${seat}`;
      seatCards.push({ seat, playUrl: url, qrSvg: await qrSvg(url) });
    }
    return {
      lanUrls: lan,
      baseUrl,
      playUrl,
      playQrSvg: await qrSvg(playUrl),
      settings: this.settings,
      seatTerminals,
      seatCards,
      sandboxMode: this.game.config.sandbox.mode,
    };
  }
}
