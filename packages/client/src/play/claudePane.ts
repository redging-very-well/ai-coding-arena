// Pure logic of the embedded Claude terminal on /play (plan §11.2 c-d),
// DOM-free so tests/claude-pane.test.ts can run it: stripping a stale
// `?seat=N` from old links, the split / tabs layout
// decision and the divider ratio, the first tab, which state the Claude pane
// shows (picker, not ready, the terminal, open in another tab), the Game-tab
// badges and the PLACEMENT nudge.

import {
  CLAUDE_SEATS,
  type ClaudeSeatsDTO,
  type Phase,
  type TerminalDTO,
  type TerminalLiveDTO,
  type UnitCardDTO,
} from '@pixel-clash/shared';

/** localStorage: the laptop's Claude seat from its last assignment (preferred for the next player). */
export const LAPTOP_SEAT_KEY = 'pc.laptopSeat';
/** The seat picker of the earlier /play (direct links); read once as a fallback. */
export const OLD_SEAT_KEY = 'pc-claude-seat';
/** localStorage: the split view's Claude share (0-1). */
export const SPLIT_KEY = 'pc.split';
/** sessionStorage: the last tab the player chose ('claude' | 'game'). */
export const TAB_KEY = 'pc.tab';

// ---------------------------------------------------------------------------
// Seat numbers, join preference
// ---------------------------------------------------------------------------

/** A Claude seat 1-8 from a string or number, else null. */
export function parseSeat(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d{1,2}\s*$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= CLAUDE_SEATS ? n : null;
}

/**
 * Old printed seat cards linked to `/play?seat=N`. Seat cards are gone (seats
 * are auto-assigned on join), so the parameter is ignored: this returns the
 * query string without `seat` ("" or "?…") for history.replaceState, or null
 * when there was no `seat` to strip.
 */
export function stripSeatQuery(search: string): string | null {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  if (!params.has('seat')) return null;
  params.delete('seat');
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}

/** What /play sends on join / login: this laptop's seat as the preference, else any free seat. */
export function joinSeatRequest(laptopSeat: number | null): number | 'auto' {
  return laptopSeat ?? 'auto';
}

/** The picker's list has no free seat (every seat that is on is someone's). */
export function noFreeSeat(seats: ClaudeSeatsDTO | null | undefined): boolean {
  return !!seats && seats.seats.every((s) => s.takenBy !== null && !s.mine);
}

/** The player-facing text when no AI seat could be given. */
export const NO_FREE_SEAT_TEXT = 'Every AI seat is in use right now. Ask a grown-up to free one up.';

/** The player-facing text of a CLAUDE_SEAT_OFF answer. */
export function seatOffText(seat: number): string {
  return `AI seat ${seat} is turned off today. Pick another seat, or ask a grown-up.`;
}

/** The player-facing text of a CLAUDE_SEAT_TAKEN conflict. */
export function seatTakenText(seat: number, takenBy: string | null | undefined): string {
  const who = takenBy ? `${takenBy}'s` : 'taken';
  return `AI seat ${seat} is ${who}. Pick another seat, or ask a grown-up.`;
}

// ---------------------------------------------------------------------------
// Layout: split view or tabs, divider
// ---------------------------------------------------------------------------

export type PlayLayout = 'split' | 'tabs';

/** Split view needs at least this viewport (CSS px); 1366×768 and smaller get tabs. */
export const SPLIT_MIN_WIDTH = 1500;
export const SPLIT_MIN_HEIGHT = 760;
/** Neither side of the split gets narrower than this. */
export const PANE_MIN_PX = 560;
export const SPLIT_DEFAULT = 0.5;
/** Arrow keys on the divider move it by this share. */
export const SPLIT_STEP = 0.05;

export function layoutFor(width: number, height: number): PlayLayout {
  return width >= SPLIT_MIN_WIDTH && height >= SPLIT_MIN_HEIGHT ? 'split' : 'tabs';
}

/** Keep both sides ≥ PANE_MIN_PX of `width`; a bad ratio is the default. */
export function clampSplit(ratio: number, width: number): number {
  const r = Number.isFinite(ratio) ? ratio : SPLIT_DEFAULT;
  if (!(width > 2 * PANE_MIN_PX)) return SPLIT_DEFAULT;
  const lo = PANE_MIN_PX / width;
  return Math.min(1 - lo, Math.max(lo, r));
}

/** A stored ratio ("0.42") or the default. */
export function parseSplit(raw: string | null | undefined): number {
  const n = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : SPLIT_DEFAULT;
}

/** The divider's ratio after a key press, or null for other keys. */
export function splitKey(ratio: number, key: string, width: number): number | null {
  if (key === 'ArrowLeft' || key === 'ArrowDown') return clampSplit(ratio - SPLIT_STEP, width);
  if (key === 'ArrowRight' || key === 'ArrowUp') return clampSplit(ratio + SPLIT_STEP, width);
  if (key === 'Home') return clampSplit(0, width);
  if (key === 'End') return clampSplit(1, width);
  return null;
}

export type PlayTab = 'claude' | 'game';

/**
 * The first tab: the player's last choice in this browser tab, else Claude
 * when they have a Claude seat and it's LOBBY or PLAN (time to prompt), else Game.
 */
export function initialTab(saved: string | null | undefined, hasSeat: boolean, phase: Phase | undefined): PlayTab {
  if (saved === 'claude' || saved === 'game') return saved;
  return hasSeat && (phase === undefined || phase === 'LOBBY' || phase === 'PLAN') ? 'claude' : 'game';
}

// ---------------------------------------------------------------------------
// Claude pane state
// ---------------------------------------------------------------------------

/** The proxy path of a seat's terminal; with `pane`, the /play iframe's URL. */
export function terminalPath(seat: number, pane?: string): string {
  return `/terminal/${seat}/${pane ? `?pane=${encodeURIComponent(pane)}` : ''}`;
}

/** Window name of the standalone tab: one tab per seat (window.open reuses it). */
export const terminalTabName = (seat: number) => `pc-claude-${seat}`;
export const adminTerminalTabName = (seat: number) => `pc-admin-seat-${seat}`;

/** A random id for this page's iframe (`?pane=`), so /play can tell its own terminal from another tab's. */
export function newPaneId(rand: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < 10; i++) s += 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(rand() * 36)]!;
  return s;
}

/** After (re)loading the iframe, another holder of the seat is ignored for this long (ours is still connecting). */
export const CLAIM_GRACE_MS = 8000;

/** Is the live terminal someone else's (another tab, the admin)? */
export function liveElsewhere(live: TerminalLiveDTO | null | undefined, pane: string): boolean {
  return !!live && live.pane !== pane;
}

/**
 * The sticky "open in another tab" flag. It turns on once another holder has
 * the seat after our grace period, and stays on (also when that tab closes)
 * until the player presses "Use it here instead" (which resets it and starts
 * a new grace period) or our own pane is the live one again.
 */
export function nextDisplaced(prev: boolean, live: TerminalLiveDTO | null | undefined, pane: string, claimingUntil: number, now: number): boolean {
  if (live && live.pane === pane) return false;
  if (liveElsewhere(live, pane) && now >= claimingUntil) return true;
  return prev;
}

export type ClaudeView =
  | { kind: 'picker' }
  | { kind: 'not-ready' }
  | { kind: 'terminal'; seat: number; down: boolean }
  | { kind: 'elsewhere'; seat: number; by: 'player' | 'admin' };

/** What the Claude pane shows (§11.2 d "Claude pane states"). */
export function claudeView(t: TerminalDTO | null, displaced: boolean, lastHolder: TerminalLiveDTO['by'] | null): ClaudeView {
  if (!t || t.seat === null) return { kind: 'picker' };
  if (!t.boxReady) return { kind: 'not-ready' };
  if (displaced) return { kind: 'elsewhere', seat: t.seat, by: t.live?.by ?? lastHolder ?? 'player' };
  return { kind: 'terminal', seat: t.seat, down: t.status === 'down' };
}

/**
 * The seat came back up (down → up) and nobody holds it: reload the iframe.
 * ttyd's page retries a dropped connection only once, right away; while the
 * AI session host is still down that fails and it waits for Enter ("Press ⏎ to
 * Reconnect"), so without this the player would be stuck after an AI session host restart.
 */
export function reloadOnRecovery(prev: TerminalDTO | null, next: TerminalDTO, displaced: boolean): boolean {
  return !!prev && prev.seat !== null && prev.seat === next.seat && next.boxReady && !displaced && prev.status === 'down' && next.status === 'up' && !next.live;
}

/**
 * The first authoritative `terminal` push after a page load or login: is the
 * seat already live in another tab (a standalone "Open in new tab" tab, the
 * admin)? Then /play starts in "open in another tab" and leaves it there
 * until "Use it here instead"; a reload never takes the terminal back silently.
 */
export function initialDisplaced(t: TerminalDTO, pane: string): boolean {
  return t.seat !== null && liveElsewhere(t.live, pane);
}

/**
 * The iframe is mounted only while the terminal shows, and only once the
 * holder is known (the first `terminal` push): under the "elsewhere" overlay
 * ttyd's page would wait at "Press ⏎ to Reconnect", and one Enter there would
 * quietly take the seat back from the other tab.
 */
export function viewHasFrame(v: ClaudeView): boolean {
  return v.kind === 'terminal';
}

/** "Open in new tab" shows with the terminal and in the "open in another tab" state. */
export function viewOffersTab(v: ClaudeView): boolean {
  return v.kind === 'terminal' || v.kind === 'elsewhere';
}

/** ⚠ on the Claude tab while the Game tab shows: no seat, not ready, down or open elsewhere. */
export function claudeNeedsLook(v: ClaudeView): boolean {
  return v.kind !== 'terminal' || v.down;
}

// ---------------------------------------------------------------------------
// Game tab badges
// ---------------------------------------------------------------------------

export type PhaseBadge = 'plan' | 'place' | 'battle' | 'results';

export const PHASE_BADGE_TEXT: Readonly<Record<PhaseBadge, string>> = {
  plan: 'Plan!',
  place: 'Place!',
  battle: 'Battle!',
  results: 'Results',
};

export interface GameBadges {
  /** New or updated units since the Game tab was last open. */
  units: number;
  /** A unit was invalidated (re-price / bounds change). */
  warn: boolean;
  phase: PhaseBadge | null;
}

export const NO_BADGES: GameBadges = { units: 0, warn: false, phase: null };

export type BadgeEvent =
  | { type: 'units'; changed: number; invalidated: boolean }
  | { type: 'phase'; phase: Phase }
  /** The Game tab was opened (or the split view shows it). */
  | { type: 'seen' };

export function phaseBadge(phase: Phase): PhaseBadge | null {
  switch (phase) {
    case 'PLAN':
      return 'plan';
    case 'PLACEMENT':
      return 'place';
    case 'BATTLE':
      return 'battle';
    case 'RESULTS':
    case 'MATCH_RESULTS':
      return 'results';
    default:
      return null;
  }
}

/** Badges collect only while the game is hidden; showing it clears them. */
export function badgeReducer(s: GameBadges, ev: BadgeEvent, gameShowing: boolean): GameBadges {
  if (ev.type === 'seen' || gameShowing) return hasBadges(s) ? NO_BADGES : s;
  if (ev.type === 'units') {
    if (!ev.changed && !ev.invalidated) return s;
    return { ...s, units: s.units + ev.changed, warn: s.warn || ev.invalidated };
  }
  const phase = phaseBadge(ev.phase);
  // A new match (back to LOBBY) leaves nothing to look at.
  return phase === s.phase ? s : { ...s, phase };
}

/** True when the badge row has anything to show. */
export function hasBadges(b: GameBadges): boolean {
  return b.units > 0 || b.warn || b.phase !== null;
}

type RosterUnit = Pick<UnitCardDTO, 'unitId' | 'version' | 'status'>;

/**
 * Units Claude sent since the last `private` push: new unit ids and new
 * versions, plus whether any unit turned invalid. The first push (prev null)
 * counts nothing.
 */
export function rosterChanges(prev: readonly RosterUnit[] | null | undefined, next: readonly RosterUnit[]): { changed: number; invalidated: boolean } {
  if (!prev) return { changed: 0, invalidated: false };
  const old = new Map(prev.map((u) => [u.unitId, u]));
  let changed = 0;
  let invalidated = false;
  for (const u of next) {
    const o = old.get(u.unitId);
    if (!o || u.version > o.version) changed++;
    if (u.status === 'invalid' && (!o || o.status !== 'invalid')) invalidated = true;
  }
  return { changed, invalidated };
}

/** "1 new unit" / "3 new units" */
export function unitsBadgeText(n: number): string {
  return `${n} new unit${n === 1 ? '' : 's'}`;
}

/** The PLACEMENT nudge holds back while the player typed in the terminal in the last 3 s. */
export const TYPING_HOLD_MS = 3000;

export function nudgeAllowed(lastTypedAt: number, now: number): boolean {
  return now - lastTypedAt >= TYPING_HOLD_MS;
}
