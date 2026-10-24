// Friendly error pages of the seat terminal proxy (plan §10.3 table, §11.2 b).
// Shown inside the /play iframe or in a standalone terminal tab when the
// request accepts HTML, else the usual JSON error body. Self-contained (inline
// CSS and script, no game assets), never with WWW-Authenticate, and never with
// anything secret in them.

import type { ServerResponse } from 'node:http';
import type { ApiErrorBody, ErrorCode } from '@pixel-clash/shared';
import { SECURITY_HEADERS } from './upstream.js';

export type ProxyErrorCode = Extract<
  ErrorCode,
  | 'TERMINAL_LOGIN_REQUIRED'
  | 'CLAUDE_SEAT_NOT_YOURS'
  | 'BAD_CLAUDE_SEAT'
  | 'TERMINAL_BAD_ORIGIN'
  | 'CLAUDE_BOX_NOT_SET'
  | 'CLAUDE_BOX_DOWN'
  | 'SEAT_PASSWORD_WRONG'
  | 'TERMINAL_BUSY'
  | 'BAD_REQUEST'
>;

export const PROXY_STATUS: Record<ProxyErrorCode, number> = {
  TERMINAL_LOGIN_REQUIRED: 401,
  CLAUDE_SEAT_NOT_YOURS: 403,
  BAD_CLAUDE_SEAT: 404,
  TERMINAL_BAD_ORIGIN: 403,
  CLAUDE_BOX_NOT_SET: 503,
  CLAUDE_BOX_DOWN: 502,
  SEAT_PASSWORD_WRONG: 502,
  TERMINAL_BUSY: 503,
  BAD_REQUEST: 405,
};

export interface ProxyErrorContext {
  /** The requested Claude seat (when it is a valid one). */
  seat: number | null;
  /** The player's own Claude seat (CLAUDE_SEAT_NOT_YOURS). */
  mySeat?: number | null;
}

interface PageSpec {
  heading: string;
  text: string;
  /** Link: [href, label]. */
  link?: [string, string];
  /** Reload (or check, then reload) after this many ms. */
  retryMs?: number;
  /** Before reloading, wait until `HEAD <this page>` answers 200 (box down). */
  checkFirst?: boolean;
  /** The JSON `message`. */
  message: string;
}

function spec(code: ProxyErrorCode, ctx: ProxyErrorContext): PageSpec {
  const seat = ctx.seat;
  switch (code) {
    case 'TERMINAL_LOGIN_REQUIRED':
      return {
        heading: 'Log in on the game page first',
        text: 'Your AI helper terminal opens once you have joined the game with your name and PIN.',
        link: [seat ? `/play?seat=${seat}` : '/play', 'Go to the game page'],
        message: 'Log in on the game page first.',
      };
    case 'CLAUDE_SEAT_NOT_YOURS':
      return ctx.mySeat
        ? {
            heading: `This is AI seat ${seat}`,
            text: `Yours is seat ${ctx.mySeat}.`,
            link: [`/terminal/${ctx.mySeat}/`, `Open AI seat ${ctx.mySeat}`],
            message: `This is AI seat ${seat}. Yours is seat ${ctx.mySeat}.`,
          }
        : {
            heading: `This is AI seat ${seat}`,
            text: "You haven't picked your AI seat yet. Use the number on your laptop's card.",
            link: [seat ? `/play?seat=${seat}` : '/play', 'Pick your seat on the game page'],
            message: `This is AI seat ${seat}, and you have no AI seat yet. Pick your seat on the game page.`,
          };
    case 'BAD_CLAUDE_SEAT':
      return {
        heading: 'No such AI seat',
        text: 'AI seats are numbered 1 to 8.',
        link: ['/play', 'Go to the game page'],
        message: 'There is no such AI seat. AI seats are 1-8.',
      };
    case 'TERMINAL_BAD_ORIGIN':
      return { heading: 'Not allowed', text: 'This terminal only opens from the game page.', message: 'Cross-site terminal connections are not allowed.' };
    case 'CLAUDE_BOX_NOT_SET':
      return {
        heading: 'Your AI helper is not connected yet',
        text: "The grown-ups haven't connected the AI computer yet. This page tries again by itself.",
        retryMs: 5000,
        message: "The grown-ups haven't connected the AI computer yet.",
      };
    case 'CLAUDE_BOX_DOWN':
      return {
        heading: 'Waking up your AI helper…',
        text: "Your AI computer isn't answering yet. Trying again…",
        retryMs: 5000,
        checkFirst: true,
        message: "Your AI computer isn't answering yet.",
      };
    case 'SEAT_PASSWORD_WRONG':
      return {
        heading: 'Your AI helper needs a grown-up',
        text: "The AI computer needs a grown-up (password check). This page tries again by itself.",
        retryMs: 10_000,
        message: "The AI computer needs a grown-up (password check).",
      };
    case 'TERMINAL_BUSY':
      return {
        heading: 'Open in several tabs',
        text: 'This terminal is open in several tabs. Close the extra ones.',
        retryMs: 10_000,
        message: 'This terminal is open in several tabs. Close the extra ones.',
      };
    case 'BAD_REQUEST':
      return { heading: 'Not allowed', text: 'The terminal only answers GET and HEAD.', message: 'Only GET and HEAD are allowed here.' };
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function errorPageHtml(code: ProxyErrorCode, ctx: ProxyErrorContext): string {
  const s = spec(code, ctx);
  const title = ctx.seat ? `Pixel Clash · AI helper · seat ${ctx.seat}` : 'Pixel Clash · AI helper';
  const script = s.retryMs
    ? `<script>setTimeout(function again(){${
        s.checkFirst
          ? `fetch(location.href,{method:'HEAD',cache:'no-store',credentials:'same-origin'}).then(function(r){if(r.ok)location.reload();else setTimeout(again,${s.retryMs})},function(){setTimeout(again,${s.retryMs})})`
          : 'location.reload()'
      }},${s.retryMs});</script>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
html,body{margin:0;height:100%;background:#12121c;color:#f2f2f7;font:18px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:24px;box-sizing:border-box}
h1{font-size:26px;margin:0 0 12px;color:#ffd166}
p{max-width:34em;margin:0 0 20px}
a{display:inline-block;padding:10px 18px;border-radius:8px;background:#4b8dff;color:#fff;text-decoration:none;font-weight:600}
.dots::after{content:"";animation:d 1.5s steps(4) infinite}
@keyframes d{0%{content:""}25%{content:"."}50%{content:".."}75%{content:"..."}}
@media (prefers-reduced-motion:reduce){.dots::after{animation:none;content:"…"}}
</style></head>
<body><main data-code="${code}"><h1>${esc(s.heading)}</h1><p${s.retryMs ? ' class="dots"' : ''}>${esc(s.text)}</p>${
    s.link ? `<a href="${esc(s.link[0])}" target="_top">${esc(s.link[1])}</a>` : ''
  }</main>${script}</body></html>`;
}

export function errorBody(code: ProxyErrorCode, ctx: ProxyErrorContext): ApiErrorBody {
  const s = spec(code, ctx);
  const body: ApiErrorBody = { error: { code, message: s.message } };
  const details: Record<string, unknown> = {};
  if (ctx.seat) details.seat = ctx.seat;
  if (ctx.mySeat !== undefined) details.mySeat = ctx.mySeat;
  if (s.retryMs) details.retryAfterMs = s.retryMs;
  if (Object.keys(details).length) body.error.details = details;
  return body;
}

/** True when the client would rather have a page than JSON (iframe, tab). */
export function wantsHtml(accept: string | undefined): boolean {
  return !!accept && /text\/html/i.test(accept);
}

/** Answer an HTTP request with the friendly page or the JSON error. */
export function sendProxyError(res: ServerResponse, method: string | undefined, accept: string | undefined, code: ProxyErrorCode, ctx: ProxyErrorContext): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const html = wantsHtml(accept);
  const text = html ? errorPageHtml(code, ctx) : JSON.stringify(errorBody(code, ctx));
  const headers: Record<string, string | number> = {
    ...SECURITY_HEADERS,
    'content-type': html ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  };
  if (code === 'BAD_REQUEST') headers.allow = 'GET, HEAD';
  res.writeHead(PROXY_STATUS[code], headers);
  res.end(method === 'HEAD' ? undefined : text);
}

const REASONS: Record<number, string> = { 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 502: 'Bad Gateway', 503: 'Service Unavailable' };

/** Refuse a WebSocket upgrade with a JSON error (raw socket, before any handshake). */
export function upgradeErrorResponse(code: ProxyErrorCode, ctx: ProxyErrorContext): string {
  const status = PROXY_STATUS[code];
  const text = JSON.stringify(errorBody(code, ctx));
  return (
    `HTTP/1.1 ${status} ${REASONS[status] ?? 'Error'}\r\n` +
    'Connection: close\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\n' +
    `Content-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`
  );
}
