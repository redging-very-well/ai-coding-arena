// Small UI helpers shared by /play, /screen, /admin and /setup: formatting,
// friendly phase labels, clipboard, debounce. DOM-free except `copyText`
// and `ensureFonts`, which check for the browser at call time.

import type { Phase } from '@pixel-clash/shared';

/** "$1,000" */
export function formatMoney(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/** Seconds → "1:05" (null → "–"). */
export function formatClock(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '–';
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Sim ticks → whole seconds left (60 ticks per second). */
export function ticksToSeconds(ticks: number, ticksPerSecond = 60): number {
  return Math.max(0, Math.ceil(ticks / ticksPerSecond));
}

/** "1st", "2nd", "3rd", "4th" */
export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

export const PLACE_MEDALS = ['🥇', '🥈', '🥉', '🎖️'] as const;

/** Friendly language for each phase: banner title and a one-line hint. */
export const PHASE_TEXT: Readonly<Record<Phase, { title: string; hint: string }>> = {
  LOBBY: { title: 'Get ready!', hint: 'The game starts soon. Say hi to your AI helper!' },
  PLAN: { title: 'Plan time!', hint: 'Ask your AI helper for new units, then pick up to 4 units and 4 buildings.' },
  PLACEMENT: { title: 'Place your army!', hint: 'Tap a unit, then tap a square. Press READY when you\'re done.' },
  BATTLE: { title: 'CLASH!', hint: 'Watch your army fight!' },
  RESULTS: { title: 'Results!', hint: 'How did your army do?' },
  MATCH_RESULTS: { title: 'Game over!', hint: 'Great battles, everyone!' },
};

/** Join class names, skipping falsy ones. */
export function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(' ');
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Trailing-edge debounce with `flush` (send now) and `cancel`. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last: A | null = null;
  const run = () => {
    timer = null;
    if (last) {
      const a = last;
      last = null;
      fn(...a);
    }
  };
  const debounced = (...args: A) => {
    last = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, ms);
  };
  debounced.flush = () => {
    if (timer) clearTimeout(timer);
    run();
  };
  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    last = null;
  };
  return debounced;
}

/** Copy text to the clipboard (a write is allowed from a normal page). Resolves false on failure. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the textarea trick (insecure http on the LAN)
  }
  if (typeof document === 'undefined') return false;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

/** Font stacks (keep in sync with theme.css). */
export const FONT_PIXEL = '"Press Start 2P", ui-monospace, "Courier New", monospace';
export const FONT_BODY = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/** Wait for the bundled pixel font so canvas text uses it (no-op without document.fonts). */
export async function ensureFonts(): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return;
  try {
    await document.fonts.load('16px "Press Start 2P"');
  } catch {
    // the fallback stack is fine
  }
}
