// /play's embedded Claude terminal (plan §11.2 c-d), DOM-free logic: seat
// numbers and stripping a stale ?seat=N, the split / tabs breakpoint and
// the divider, the first tab, the Claude pane states incl. "open in another
// tab", the Game-tab badge reducer and the PLACEMENT nudge.

import { describe, expect, it } from 'vitest';
import type { TerminalDTO, UnitCardDTO } from '@pixel-clash/shared';
import {
  CLAIM_GRACE_MS,
  NO_BADGES,
  PANE_MIN_PX,
  SPLIT_DEFAULT,
  badgeReducer,
  claudeNeedsLook,
  claudeView,
  clampSplit,
  hasBadges,
  initialDisplaced,
  initialTab,
  layoutFor,
  newPaneId,
  nextDisplaced,
  nudgeAllowed,
  parseSeat,
  parseSplit,
  reloadOnRecovery,
  rosterChanges,
  seatTakenText,
  splitKey,
  stripSeatQuery,
  terminalPath,
  terminalTabName,
  unitsBadgeText,
  viewHasFrame,
  viewOffersTab,
  type GameBadges,
} from '../packages/client/src/play/claudePane.js';

const term = (patch: Partial<TerminalDTO> = {}): TerminalDTO => ({ seat: 3, status: 'up', boxReady: true, live: null, ...patch });

describe('seat numbers and stale ?seat=N links (§11.2 c)', () => {
  it('ignores ?seat=N from old printed seat cards: stripped from the URL, no seat taken from it', () => {
    expect(stripSeatQuery('?seat=4')).toBe('');
    expect(stripSeatQuery('?x=1&seat=8&y=2')).toBe('?x=1&y=2');
    expect(stripSeatQuery('?seat=9&a=b')).toBe('?a=b');
    expect(stripSeatQuery('?seat=')).toBe('');
    expect(stripSeatQuery('?a=b')).toBeNull();
    expect(stripSeatQuery('')).toBeNull();
  });
  it('parses seat numbers 1-8 only', () => {
    expect(parseSeat('1')).toBe(1);
    expect(parseSeat(8)).toBe(8);
    expect(parseSeat('2.5')).toBeNull();
    expect(parseSeat(null)).toBeNull();
    expect(parseSeat('-1')).toBeNull();
  });
  it("explains a taken seat in player words", () => {
    expect(seatTakenText(3, 'Sam')).toBe("AI seat 3 is Sam's. Pick another seat, or ask a grown-up.");
    expect(seatTakenText(3, null)).toContain('AI seat 3 is taken');
  });
});

describe('layout (§11.2 d)', () => {
  it('splits at 1500×760 and up, tabs on 1366×768 and smaller', () => {
    expect(layoutFor(1920, 1080)).toBe('split');
    expect(layoutFor(1500, 760)).toBe('split');
    expect(layoutFor(1499, 900)).toBe('tabs');
    expect(layoutFor(1600, 759)).toBe('tabs');
    expect(layoutFor(1366, 768)).toBe('tabs');
    expect(layoutFor(1280, 800)).toBe('tabs');
    expect(layoutFor(390, 844)).toBe('tabs');
  });
  it('keeps both sides at least 560 px', () => {
    expect(clampSplit(0.5, 1920)).toBe(0.5);
    expect(clampSplit(0.1, 1920)).toBeCloseTo(PANE_MIN_PX / 1920);
    expect(clampSplit(0.95, 1920)).toBeCloseTo(1 - PANE_MIN_PX / 1920);
    expect(clampSplit(Number.NaN, 1920)).toBe(SPLIT_DEFAULT);
    // Too narrow for two 560 px sides: the default.
    expect(clampSplit(0.2, 1000)).toBe(SPLIT_DEFAULT);
  });
  it('reads the stored ratio, falling back to the default', () => {
    expect(parseSplit('0.42')).toBe(0.42);
    expect(parseSplit(null)).toBe(SPLIT_DEFAULT);
    expect(parseSplit('')).toBe(SPLIT_DEFAULT);
    expect(parseSplit('nope')).toBe(SPLIT_DEFAULT);
    expect(parseSplit('1.5')).toBe(SPLIT_DEFAULT);
  });
  it('moves the divider 5% per arrow key, clamped', () => {
    expect(splitKey(0.5, 'ArrowRight', 1920)).toBeCloseTo(0.55);
    expect(splitKey(0.5, 'ArrowLeft', 1920)).toBeCloseTo(0.45);
    expect(splitKey(0.3, 'ArrowLeft', 1920)).toBeCloseTo(PANE_MIN_PX / 1920);
    expect(splitKey(0.5, 'Home', 1920)).toBeCloseTo(PANE_MIN_PX / 1920);
    expect(splitKey(0.5, 'a', 1920)).toBeNull();
  });
  it('starts on Claude in LOBBY/PLAN with a seat, else Game; the last choice wins', () => {
    expect(initialTab(null, true, 'LOBBY')).toBe('claude');
    expect(initialTab(null, true, 'PLAN')).toBe('claude');
    expect(initialTab(null, true, 'PLACEMENT')).toBe('game');
    expect(initialTab(null, true, 'BATTLE')).toBe('game');
    expect(initialTab(null, false, 'PLAN')).toBe('game');
    expect(initialTab('game', true, 'PLAN')).toBe('game');
    expect(initialTab('claude', false, 'BATTLE')).toBe('claude');
    expect(initialTab('weird', true, 'RESULTS')).toBe('game');
  });
});

describe('Claude pane states (§11.2 d)', () => {
  it('builds the proxy path, with the pane id for the iframe', () => {
    expect(terminalPath(3)).toBe('/terminal/3/');
    expect(terminalPath(3, 'abc123')).toBe('/terminal/3/?pane=abc123');
    expect(terminalTabName(3)).toBe('pc-claude-3');
    const id = newPaneId();
    expect(id).toMatch(/^[a-z0-9]{10}$/);
    expect(newPaneId()).not.toBe(id);
  });
  it('picker, not ready, terminal (with down), elsewhere', () => {
    expect(claudeView(null, false, null)).toEqual({ kind: 'picker' });
    expect(claudeView(term({ seat: null }), false, null)).toEqual({ kind: 'picker' });
    expect(claudeView(term({ boxReady: false }), true, null)).toEqual({ kind: 'not-ready' });
    expect(claudeView(term(), false, null)).toEqual({ kind: 'terminal', seat: 3, down: false });
    expect(claudeView(term({ status: 'down' }), false, null)).toEqual({ kind: 'terminal', seat: 3, down: true });
    expect(claudeView(term({ live: { pane: null, by: 'admin', since: 1 } }), true, null)).toEqual({ kind: 'elsewhere', seat: 3, by: 'admin' });
    // The other tab closed again: still "elsewhere", by whoever had it last.
    expect(claudeView(term(), true, 'admin')).toEqual({ kind: 'elsewhere', seat: 3, by: 'admin' });
    expect(claudeView(term(), true, null)).toEqual({ kind: 'elsewhere', seat: 3, by: 'player' });
  });
  it('unmounts the iframe under the "elsewhere" overlay (an Enter there would take the seat back)', () => {
    expect(viewHasFrame({ kind: 'terminal', seat: 1, down: false })).toBe(true);
    expect(viewHasFrame({ kind: 'elsewhere', seat: 1, by: 'player' })).toBe(false);
    expect(viewHasFrame({ kind: 'picker' })).toBe(false);
    expect(viewHasFrame({ kind: 'not-ready' })).toBe(false);
    // "Open in new tab" stays offered in both terminal states.
    expect(viewOffersTab({ kind: 'terminal', seat: 1, down: false })).toBe(true);
    expect(viewOffersTab({ kind: 'elsewhere', seat: 1, by: 'player' })).toBe(true);
    expect(viewOffersTab({ kind: 'picker' })).toBe(false);
  });
  it('a reload of /play leaves the terminal in its standalone tab (no silent takeover)', () => {
    // The standalone tab has no pane id; the admin's rescue tab neither.
    expect(initialDisplaced(term({ live: { pane: null, by: 'player', since: 1 } }), 'newpane')).toBe(true);
    expect(initialDisplaced(term({ live: { pane: null, by: 'admin', since: 1 } }), 'newpane')).toBe(true);
    // Another /play tab's iframe.
    expect(initialDisplaced(term({ live: { pane: 'oldpane', by: 'player', since: 1 } }), 'newpane')).toBe(true);
    // Nobody (or our own pane) holds it: load the iframe.
    expect(initialDisplaced(term(), 'newpane')).toBe(false);
    expect(initialDisplaced(term({ live: { pane: 'newpane', by: 'player', since: 1 } }), 'newpane')).toBe(false);
    expect(initialDisplaced(term({ seat: null }), 'newpane')).toBe(false);
    expect(claudeView(term({ live: { pane: null, by: 'player', since: 1 } }), true, 'player')).toEqual({ kind: 'elsewhere', seat: 3, by: 'player' });
  });
  it('flags the Claude tab when it needs a look', () => {
    expect(claudeNeedsLook({ kind: 'terminal', seat: 1, down: false })).toBe(false);
    expect(claudeNeedsLook({ kind: 'terminal', seat: 1, down: true })).toBe(true);
    expect(claudeNeedsLook({ kind: 'picker' })).toBe(true);
    expect(claudeNeedsLook({ kind: 'not-ready' })).toBe(true);
    expect(claudeNeedsLook({ kind: 'elsewhere', seat: 1, by: 'player' })).toBe(true);
  });
  it('"open in another tab" turns on after the grace period, sticks, and clears when ours is live', () => {
    const now = 100_000;
    const other = { pane: null, by: 'player' as const, since: now };
    const mine = { pane: 'me', by: 'player' as const, since: now };
    // Still connecting after (re)load: another holder is ignored.
    expect(nextDisplaced(false, other, 'me', now + CLAIM_GRACE_MS, now)).toBe(false);
    expect(nextDisplaced(false, other, 'me', now, now)).toBe(true);
    // Another /play page (another pane id) also counts.
    expect(nextDisplaced(false, { ...other, pane: 'zzz' }, 'me', 0, now)).toBe(true);
    // The other tab closed: stays displaced until "Use it here instead".
    expect(nextDisplaced(true, null, 'me', 0, now)).toBe(true);
    expect(nextDisplaced(false, null, 'me', 0, now)).toBe(false);
    // Our own pane is live again.
    expect(nextDisplaced(true, mine, 'me', 0, now)).toBe(false);
  });

  it('reloads the iframe when the seat comes back up and nobody holds it (ttyd gave up reconnecting)', () => {
    const down = term({ status: 'down' });
    expect(reloadOnRecovery(down, term(), false)).toBe(true);
    // Not on other transitions, a held seat, a displaced pane or a seat change.
    expect(reloadOnRecovery(term(), term(), false)).toBe(false);
    expect(reloadOnRecovery(term({ status: 'unknown' }), term(), false)).toBe(false);
    expect(reloadOnRecovery(down, term({ live: { pane: 'zzz', by: 'player', since: 1 } }), false)).toBe(false);
    expect(reloadOnRecovery(down, term(), true)).toBe(false);
    expect(reloadOnRecovery(down, term({ seat: 4 }), false)).toBe(false);
    expect(reloadOnRecovery(down, term({ boxReady: false }), false)).toBe(false);
    expect(reloadOnRecovery(null, term(), false)).toBe(false);
  });
});

describe('Game tab badges (§11.2 d)', () => {
  const hidden = false;
  it('collects units, invalidations and phases while the game is hidden', () => {
    let b: GameBadges = NO_BADGES;
    b = badgeReducer(b, { type: 'units', changed: 1, invalidated: false }, hidden);
    b = badgeReducer(b, { type: 'units', changed: 2, invalidated: false }, hidden);
    expect(b.units).toBe(3);
    b = badgeReducer(b, { type: 'phase', phase: 'PLACEMENT' }, hidden);
    expect(b.phase).toBe('place');
    b = badgeReducer(b, { type: 'phase', phase: 'BATTLE' }, hidden);
    expect(b.phase).toBe('battle');
    b = badgeReducer(b, { type: 'phase', phase: 'MATCH_RESULTS' }, hidden);
    expect(b.phase).toBe('results');
    b = badgeReducer(b, { type: 'units', changed: 0, invalidated: true }, hidden);
    expect(b).toEqual({ units: 3, warn: true, phase: 'results' });
    expect(hasBadges(b)).toBe(true);
    // A new match: no phase badge.
    expect(badgeReducer(b, { type: 'phase', phase: 'LOBBY' }, hidden).phase).toBeNull();
  });
  it('clears when the Game tab opens, and collects nothing while it shows', () => {
    const b: GameBadges = { units: 2, warn: true, phase: 'plan' };
    expect(badgeReducer(b, { type: 'seen' }, hidden)).toEqual(NO_BADGES);
    expect(badgeReducer(NO_BADGES, { type: 'units', changed: 1, invalidated: false }, true)).toBe(NO_BADGES);
    expect(badgeReducer(NO_BADGES, { type: 'phase', phase: 'PLAN' }, true)).toBe(NO_BADGES);
    expect(hasBadges(NO_BADGES)).toBe(false);
  });
  it('returns the same object when nothing changed (no re-render)', () => {
    const b: GameBadges = { units: 0, warn: false, phase: 'plan' };
    expect(badgeReducer(b, { type: 'phase', phase: 'PLAN' }, hidden)).toBe(b);
    expect(badgeReducer(b, { type: 'units', changed: 0, invalidated: false }, hidden)).toBe(b);
    expect(badgeReducer(NO_BADGES, { type: 'seen' }, hidden)).toBe(NO_BADGES);
  });
  it('counts new units and new versions from the private push', () => {
    const u = (unitId: string, version: number, status: UnitCardDTO['status'] = 'valid') => ({ unitId, version, status });
    expect(rosterChanges(null, [u('a', 1)])).toEqual({ changed: 0, invalidated: false });
    expect(rosterChanges([u('a', 1)], [u('a', 1)])).toEqual({ changed: 0, invalidated: false });
    expect(rosterChanges([u('a', 1)], [u('b', 1), u('a', 2)])).toEqual({ changed: 2, invalidated: false });
    expect(rosterChanges([u('a', 1)], [u('a', 1, 'invalid')])).toEqual({ changed: 0, invalidated: true });
    expect(rosterChanges([u('a', 1, 'invalid')], [u('a', 1, 'invalid')])).toEqual({ changed: 0, invalidated: false });
    // A retired unit is not news.
    expect(rosterChanges([u('a', 1), u('b', 1)], [u('a', 1)])).toEqual({ changed: 0, invalidated: false });
    expect(unitsBadgeText(1)).toBe('1 new unit');
    expect(unitsBadgeText(3)).toBe('3 new units');
  });
  it('holds the PLACEMENT nudge back while the player typed in the last 3 s', () => {
    expect(nudgeAllowed(0, 10_000)).toBe(true);
    expect(nudgeAllowed(9_000, 10_000)).toBe(false);
    expect(nudgeAllowed(7_000, 10_000)).toBe(true);
  });
});
