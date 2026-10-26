// The "everyone's ready → go" step (plan §3 pending advance, §12.2, §12.3),
// DOM-free so tests/plan-ready-client.test.ts can run it. The server runs one
// countdown (`state.pendingAdvance`) that every page shows; only the
// facilitator (an /admin session in this browser) gets the go / cancel
// controls, on /admin and on /screen.

import type { GameStateDTO, PendingAdvanceDTO } from '@pixel-clash/shared';

type StateBits = Pick<GameStateDTO, 'phase' | 'allReady' | 'pendingAdvance'> & Partial<Pick<GameStateDTO, 'round' | 'rounds' | 'timer'>>;

export interface AdvanceControls {
  /**
   * "Start placement ▶" / "START battle ▶" / "Next battle ▶" / "Final
   * standings ▶": starts the 3 s countdown. `space`: Space also triggers it
   * (not in RESULTS, where Space pauses the replay; Enter still works).
   */
  go: { label: string; space: boolean } | null;
  /** A countdown runs and can be cancelled. */
  cancel: boolean;
}

export const NO_CONTROLS: AdvanceControls = { go: null, cancel: false };

/**
 * What the facilitator can do now: go when everyone is ready or the phase
 * timer has run out (PLAN, PLACEMENT; once the PLACEMENT timer is up the
 * server's START needs no Ready) or any time on the results (next battle /
 * final standings), cancel while a countdown runs.
 */
export function advanceControls(state: StateBits | null | undefined, isAdmin: boolean): AdvanceControls {
  if (!state || !isAdmin) return NO_CONTROLS;
  if (state.pendingAdvance) return { go: null, cancel: true };
  if (state.phase === 'RESULTS') {
    const last = state.round !== undefined && state.rounds !== undefined && state.round >= state.rounds;
    return { go: { label: last ? 'Final standings ▶' : 'Next battle ▶', space: false }, cancel: false };
  }
  if (!state.allReady && !timeUp(state)) return NO_CONTROLS;
  if (state.phase === 'PLAN') return { go: { label: 'Start placement ▶', space: true }, cancel: false };
  if (state.phase === 'PLACEMENT') return { go: { label: 'START battle ▶', space: true }, cancel: false };
  return NO_CONTROLS;
}

/**
 * The phase timer ran out (`timer.expired`: PLACEMENT waits for START; PLAN
 * moves on by itself). A paused timer or one the host extended is not up.
 */
export function timeUp(state: Partial<Pick<GameStateDTO, 'timer'>>): boolean {
  return state.timer?.expired === true;
}

/** Keyboard on /screen: Enter (and Space outside RESULTS) = go, Esc = cancel (only when that control shows). */
export function advanceKey(key: string, controls: AdvanceControls): 'go' | 'cancel' | null {
  if (controls.go && (key === 'Enter' || (key === ' ' && controls.go.space))) return 'go';
  if (key === 'Escape' && controls.cancel) return 'cancel';
  return null;
}

const COUNTDOWN_LABEL: Record<PendingAdvanceDTO['to'], string> = {
  PLACEMENT: 'Placement starts',
  BATTLE: 'Battle starts',
  PLAN: 'Next battle',
  MATCH_RESULTS: 'Final standings',
};

/** "Placement starts in 3…" / "Next battle in 2…" (also the /screen banner title, without the number). */
export function countdownTitle(p: Pick<PendingAdvanceDTO, 'to'>): string {
  return `${COUNTDOWN_LABEL[p.to]} in`;
}

export function countdownText(p: PendingAdvanceDTO): string {
  return `${countdownTitle(p)} ${p.secondsLeft}…`;
}
