// /setup info (plan §11 "/setup page", §12.3 server info): the join URL + QR,
// and the Claude box seat terminal links (§11.1). The server never talks to
// ttyd; it only builds `http://<claude-box>:778N` links from the address the
// facilitator typed in /admin.

import QRCode from 'qrcode';
import type { Result, SeatTerminalDTO, SetupInfoDTO, SetupSettingsDTO } from '@pixel-clash/shared';
import { lanUrls } from '../util/lan.js';
import type { Game } from './game.js';
import { safeHost } from './kit.js';

/** ttyd host port of seat 0 (seat N → 7781 + N, §11.1). */
export const SEAT_TERMINAL_BASE_PORT = 7781;
export const SEAT_COUNT = 4;

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

export function seatTerminalUrl(host: string, seat: number): string {
  return `http://${host}:${SEAT_TERMINAL_BASE_PORT + seat}`;
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

export class SetupService {
  constructor(private readonly game: Game) {}

  get settings(): SetupSettingsDTO {
    return { ...this.game.store.setup };
  }

  /** Update settings: `null` or "" clears a field, `undefined` leaves it. */
  update(patch: { claudeBoxHost?: unknown; preferredUrl?: unknown }): Result<SetupSettingsDTO> {
    const next = { ...this.game.store.setup };
    if (patch.claudeBoxHost !== undefined) {
      if (patch.claudeBoxHost === null || patch.claudeBoxHost === '') next.claudeBoxHost = null;
      else {
        const h = typeof patch.claudeBoxHost === 'string' ? normalizeClaudeBoxHost(patch.claudeBoxHost) : null;
        if (!h) {
          return {
            ok: false,
            error: { code: 'BAD_REQUEST', message: 'The Claude box address must be a host name or IP, like 192.168.8.20.' },
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
    this.game.store.setup = next;
    this.game.store.save();
    this.game.notifier.stateChanged();
    return { ok: true, data: { ...next } };
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
    return {
      lanUrls: lan,
      baseUrl,
      playUrl,
      playQrSvg: await qrSvg(playUrl),
      settings: this.settings,
      seatTerminals,
      sandboxMode: this.game.config.sandbox.mode,
    };
  }
}
