// Loading the code editor chunk, DOM-free so tests can run it.
//
// CodeMirror is a separate, content-hashed chunk fetched on the first "Edit
// code". If the game is rebuilt (`npm run build`) while /play stays open, the
// build empties dist/public and the chunk the open page knows about is gone
// (404), so the import fails until the page is reloaded. A failed import is
// retried once, then explained: offline, game updated (Reload), or other.
// Chrome remembers a failed dynamic import of a URL and fails again without
// fetching, so a retry imports the chunk's URL (read from the error) with a
// fresh query string.

export type LoadFailure = 'offline' | 'updated' | 'other';

/** Calls `load(undefined)`, and once more with the first error after `delayMs` if that fails. */
export async function loadWithRetry<T>(load: (previousError: unknown) => Promise<T>, delayMs = 600, wait = defaultWait): Promise<T> {
  try {
    return await load(undefined);
  } catch (err) {
    await wait(delayMs);
    return load(err);
  }
}

/**
 * The URL to import again after a failed dynamic import: the module URL in
 * the error (Chrome: "Failed to fetch dynamically imported module: <url>",
 * Firefox: "error loading dynamically imported module: <url>") with a
 * `retry` query, so the browser fetches it again. Null when the error names
 * no URL (Safari): then the plain import is tried again.
 */
export function retryUrl(err: unknown, attempt: number): string | null {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const url = /\b(https?:\/\/\S+)/.exec(message)?.[1];
  if (!url) return null;
  try {
    const u = new URL(url);
    u.searchParams.set('retry', String(attempt));
    return u.href;
  } catch {
    return null;
  }
}

function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The paths of the module scripts a page's HTML starts (Vite puts one entry script per page). */
export function entryScripts(html: string, base = 'http://x/'): string[] {
  const out: string[] = [];
  for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
    if (!/\btype\s*=\s*["']?module\b/i.test(tag)) continue;
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (src) out.push(pathOf(src, base));
  }
  return out;
}

export function pathOf(src: string, base = 'http://x/'): string {
  try {
    return new URL(src, base).pathname;
  } catch {
    return src;
  }
}

/**
 * Why the editor chunk didn't load. `page` is a fresh fetch of the page's own
 * HTML (null when that fetch itself failed); `loaded` the paths of the module
 * scripts this page was started with.
 */
export function classifyLoadFailure(o: { online: boolean; page: { ok: boolean; html: string } | null; loaded: string[] }): LoadFailure {
  if (!o.online || !o.page) return 'offline';
  if (!o.page.ok) return 'other';
  const fresh = entryScripts(o.page.html);
  if (fresh.length > 0 && fresh.some((p) => !o.loaded.includes(p))) return 'updated';
  return 'other';
}

export const LOAD_FAILURE_TEXT: Record<LoadFailure, string> = {
  offline: "The code editor didn't load: this device can't reach the game server. Check the Wi-Fi, then press Try again.",
  updated: 'The game was updated while this page was open. Press Reload to get the new version (your units are safe on the server).',
  other: "The code editor didn't load. Press Try again, or Reload the page.",
};
