// PLAN Ready on the pages (plan §12.1-§12.3), DOM-free parts: the /play
// "I'm ready!" button state and the "press Ready again" note, the /screen
// tiles, banner and all-ready chime decision, and the admin quick toggle.

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type GameStateDTO, type PlayerStatusDTO } from '@pixel-clash/shared';
import { NO_CONTROLS, advanceControls, advanceKey, countdownText } from '../packages/client/src/common/advance.js';
import { QUICK_GROUPS, QUICK_TOGGLES, fieldChanged, setPath, toggleValue } from '../packages/client/src/admin/quickSettings.js';
import { planReadyView, readyWasCleared } from '../packages/client/src/play/logic.js';
import { becameAllReady, newlyDone, readyBanner, statusTicks, tileDone } from '../packages/client/src/screen/model.js';

const player = (o: Partial<PlayerStatusDTO> = {}): PlayerStatusDTO => ({
  id: 'a',
  name: 'Ann',
  seat: 0,
  connected: true,
  submitted: false,
  selected: false,
  ready: false,
  points: 0,
  active: true,
  ...o,
});

describe('/play PLAN Ready button', () => {
  it('is disabled with a hint until something is picked', () => {
    expect(planReadyView(0, false, 3)).toEqual({ enabled: false, label: "I'm ready!", hint: 'Pick up to 3 units first' });
    const one = planReadyView(1, false, 3);
    expect(one.enabled).toBe(true);
    expect(one.hint).toContain('Picked 1 of 3');
  });

  it('can always be switched off, and shows the countdown when placement starts by itself', () => {
    expect(planReadyView(2, true, 3)).toMatchObject({ enabled: true, label: "✓ I'm ready!" });
    // Ready with an emptied selection (server clears it anyway): still un-readyable.
    expect(planReadyView(0, true, 3).enabled).toBe(true);
    expect(planReadyView(2, true, 3, 2).hint).toBe('Placement starts in 2…');
    expect(planReadyView(0, false, 3, 2)).toMatchObject({ enabled: false, hint: 'Placement starts in 2…' });
  });

  it('notes a Ready the server cleared (army changed), not the player’s own toggle or a phase change', () => {
    const on = { phase: 'PLAN', ready: true };
    const off = { phase: 'PLAN', ready: false };
    expect(readyWasCleared(on, off, false)).toBe(true);
    expect(readyWasCleared(on, off, true)).toBe(false);
    expect(readyWasCleared(null, off, false)).toBe(false);
    expect(readyWasCleared(off, off, false)).toBe(false);
    expect(readyWasCleared(on, { phase: 'PLACEMENT', ready: false }, false)).toBe(false);
  });
});

describe('/screen PLAN ready', () => {
  it('shows picked and ready ticks; a tile is done when ready', () => {
    const p = player({ selected: true, ready: true });
    expect(statusTicks(p, 'PLAN').map((t) => [t.label, t.done])).toEqual([
      ['New unit', false],
      ['Army picked', true],
      ['Ready', true],
    ]);
    expect(tileDone(p, 'PLAN')).toBe(true); // a new unit is optional
    expect(tileDone(player({ selected: true }), 'PLAN')).toBe(false);
    expect(tileDone({ ...p, active: false }, 'PLAN')).toBe(false);
    expect(tileDone(player({ ready: true, selected: true }), 'PLACEMENT')).toBe(true);
    expect(tileDone(player(), 'LOBBY')).toBe(true);
  });

  it('decides the everyone-ready banner from the public flags', () => {
    expect(readyBanner({ phase: 'PLAN', allReady: false })).toBeNull();
    expect(readyBanner(null)).toBeNull();
    expect(readyBanner({ phase: 'PLAN', allReady: true })).toEqual({
      title: "Everyone's ready! 🎉",
      sub: 'Waiting for the host to start placement',
    });
    expect(readyBanner({ phase: 'PLAN', allReady: true, pendingAdvance: { to: 'PLACEMENT', by: 'auto', secondsLeft: 3 } })).toEqual({
      title: 'Placement starts in',
      sub: "Everyone's ready! 🎉",
      countdown: 3,
    });
    // A host countdown shows even if someone un-readied meanwhile.
    expect(readyBanner({ phase: 'PLACEMENT', allReady: false, pendingAdvance: { to: 'BATTLE', by: 'host', secondsLeft: 2 } })?.countdown).toBe(2);
    expect(readyBanner({ phase: 'PLACEMENT', allReady: true })).toEqual({ title: "Everyone's placed and ready!", sub: 'START when you like!' });
    expect(readyBanner({ phase: 'BATTLE', allReady: true })).toBeNull();
  });

  it('chimes once when all-ready switches on within a phase', () => {
    expect(becameAllReady({ phase: 'PLAN', allReady: false }, { phase: 'PLAN', allReady: true })).toBe(true);
    expect(becameAllReady({ phase: 'PLAN', allReady: true }, { phase: 'PLAN', allReady: true })).toBe(false);
    expect(becameAllReady(null, { phase: 'PLAN', allReady: true })).toBe(false);
    expect(becameAllReady({ phase: 'PLAN', allReady: true }, { phase: 'PLACEMENT', allReady: true })).toBe(false);
    expect(becameAllReady({ phase: 'PLACEMENT', allReady: false }, { phase: 'PLACEMENT', allReady: true })).toBe(true);
  });

  it('counts PLAN Ready presses for the per-player chime', () => {
    expect(newlyDone([player({ selected: true })], [player({ selected: true, ready: true })], 'PLAN')).toEqual({ ready: 1, ticks: 0 });
  });
});

describe('/admin quick toggle', () => {
  it('has the auto-advance checkbox under Timers, off by default', () => {
    expect(QUICK_TOGGLES.map((t) => t.path)).toEqual(['timers.autoAdvanceWhenAllReady', 'sim.routeRoundBuildings']);
    // The redesign's building-routing toggle sits in its own group and is on by default.
    expect(QUICK_GROUPS.find((g) => g.id === 'sim')?.toggles?.[0]?.path).toBe('sim.routeRoundBuildings');
    expect(toggleValue(DEFAULT_CONFIG, 'sim.routeRoundBuildings')).toBe(true);
    expect(QUICK_GROUPS.find((g) => g.id === 'timers')?.toggles?.[0]?.label).toBe('Start placement automatically when everyone is ready');
    expect(toggleValue(DEFAULT_CONFIG, 'timers.autoAdvanceWhenAllReady')).toBe(false);
    const on = setPath(DEFAULT_CONFIG, 'timers.autoAdvanceWhenAllReady', true);
    expect(toggleValue(on, 'timers.autoAdvanceWhenAllReady')).toBe(true);
    expect(fieldChanged(QUICK_TOGGLES[0]!, DEFAULT_CONFIG, on)).toBe(true);
  });
});

describe('go / cancel controls (/screen with an admin session, /admin)', () => {
  const st = (o: Partial<Pick<GameStateDTO, 'phase' | 'allReady' | 'pendingAdvance' | 'round' | 'rounds'>>) => ({ phase: 'PLAN' as const, allReady: false, ...o });

  it('shows go only to the admin when everyone is ready, cancel while a countdown runs', () => {
    expect(advanceControls(st({ allReady: true }), false)).toEqual(NO_CONTROLS);
    expect(advanceControls(st({ allReady: false }), true)).toEqual(NO_CONTROLS);
    expect(advanceControls(st({ allReady: true }), true)).toEqual({ go: { label: 'Start placement ▶', space: true }, cancel: false });
    expect(advanceControls(st({ phase: 'PLACEMENT', allReady: true }), true).go?.label).toBe('START battle ▶');
    expect(advanceControls(st({ phase: 'BATTLE', allReady: true }), true)).toEqual(NO_CONTROLS);
    const counting = st({ allReady: false, pendingAdvance: { to: 'PLACEMENT', by: 'host', secondsLeft: 3 } });
    expect(advanceControls(counting, true)).toEqual({ go: null, cancel: true });
    expect(advanceControls(counting, false)).toEqual(NO_CONTROLS);
    expect(advanceControls(null, true)).toEqual(NO_CONTROLS);
  });

  it('on RESULTS the admin always gets Next battle (or Final standings after the last round), Enter only', () => {
    expect(advanceControls(st({ phase: 'RESULTS', round: 1, rounds: 3 }), true)).toEqual({ go: { label: 'Next battle ▶', space: false }, cancel: false });
    expect(advanceControls(st({ phase: 'RESULTS', round: 3, rounds: 3 }), true).go?.label).toBe('Final standings ▶');
    expect(advanceControls(st({ phase: 'RESULTS', round: 1, rounds: 3 }), false)).toEqual(NO_CONTROLS);
    const counting = st({ phase: 'RESULTS', round: 1, rounds: 3, pendingAdvance: { to: 'PLAN', by: 'host', secondsLeft: 2 } });
    expect(advanceControls(counting, true)).toEqual({ go: null, cancel: true });
    // Space stays "pause the replay" on the results.
    const next = advanceControls(st({ phase: 'RESULTS', round: 1, rounds: 3 }), true);
    expect(advanceKey(' ', next)).toBeNull();
    expect(advanceKey('Enter', next)).toBe('go');
  });

  it('gives the results banner only to the facilitator, and the countdown to everyone', () => {
    expect(readyBanner({ phase: 'RESULTS', allReady: false })).toBeNull();
    expect(readyBanner({ phase: 'RESULTS', allReady: false }, 'Next battle ▶')?.title).toBe('Round over!');
    const b = readyBanner({ phase: 'RESULTS', allReady: false, pendingAdvance: { to: 'PLAN', by: 'host', secondsLeft: 3 } });
    expect(b).toMatchObject({ title: 'Next battle in', countdown: 3 });
  });

  it('maps Space / Enter to go and Esc to cancel, only when that control shows', () => {
    const go = { go: { label: 'x', space: true }, cancel: false };
    const cancel = { go: null, cancel: true };
    expect(advanceKey(' ', go)).toBe('go');
    expect(advanceKey('Enter', go)).toBe('go');
    expect(advanceKey('Escape', go)).toBeNull();
    expect(advanceKey('Escape', cancel)).toBe('cancel');
    expect(advanceKey(' ', cancel)).toBeNull();
    expect(advanceKey('Enter', NO_CONTROLS)).toBeNull();
    expect(advanceKey('r', go)).toBeNull();
  });

  it('words the countdown', () => {
    expect(countdownText({ to: 'PLACEMENT', by: 'host', secondsLeft: 3 })).toBe('Placement starts in 3…');
    expect(countdownText({ to: 'BATTLE', by: 'host', secondsLeft: 1 })).toBe('Battle starts in 1…');
    expect(countdownText({ to: 'PLAN', by: 'host', secondsLeft: 2 })).toBe('Next battle in 2…');
    expect(countdownText({ to: 'MATCH_RESULTS', by: 'host', secondsLeft: 3 })).toBe('Final standings in 3…');
  });
});
