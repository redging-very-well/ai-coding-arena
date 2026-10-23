// The "everyone's ready → go" step (plan §3 pending advance, §12.2, §12.3),
// DOM-free so tests/plan-ready-client.test.ts can run it. The server runs one
// countdown (`state.pendingAdvance`) that every page shows; only the
// facilitator (an /admin session in this browser) gets the go / cancel
// controls, on /admin and on /screen.

import type { GameStateDTO, PendingAdvanceDTO } from '@pixel-clash/shared';

type StateBits = Pick<GameStateDTO, 'phase' | 'allReady' | 'pendingAdvance'>;

export interface AdvanceControls {
  /** "Start placement ▶" / "START battle ▶": starts the 3 s countdown. */
  go: { label: string } | null;
  /** A countdown runs and can be cancelled. */
  cancel: boolean;
}

export const NO_CONTROLS: AdvanceControls = { go: null, cancel: false };

/** What the facilitator can do now: go when everyone is ready, cancel while a countdown runs. */
export function advanceControls(state: StateBits | null | undefined, isAdmin: boolean): AdvanceControls {
  if (!state || !isAdmin) return NO_CONTROLS;
  if (state.pendingAdvance) return { go: null, cancel: true };
  if (!state.allReady) return NO_CONTROLS;
  if (state.phase === 'PLAN') return { go: { label: 'Start placement ▶' }, cancel: false };
  if (state.phase === 'PLACEMENT') return { go: { label: 'START battle ▶' }, cancel: false };
  return NO_CONTROLS;
}

/** Keyboard on /screen: Space / Enter = go, Esc = cancel (only when that control shows). */
export function advanceKey(key: string, controls: AdvanceControls): 'go' | 'cancel' | null {
  if ((key === ' ' || key === 'Enter') && controls.go) return 'go';
  if (key === 'Escape' && controls.cancel) return 'cancel';
  return null;
}

/** "Placement starts in 3…" / "Battle starts in 2…". */
export function countdownText(p: PendingAdvanceDTO): string {
  return `${p.to === 'PLACEMENT' ? 'Placement' : 'Battle'} starts in ${p.secondsLeft}…`;
}
