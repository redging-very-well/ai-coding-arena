// The MATCH_RESULTS awards ceremony on /screen, DOM-free
// so tests can run it: the step timeline (drumroll intro → one step per
// award → podium 3-2-1 → final scoreboard), a pausable clock the facilitator
// can skip ahead (→ / Enter), pause (Space) and replay (R), the keyboard
// mapping (admin session only) and which sound each step starts with.

import type { AwardId, MatchAwardDTO } from '@pixel-clash/shared';
import type { SfxName } from '../common/sfx.js';

export type CeremonyStep =
  | { kind: 'intro'; ms: number }
  | { kind: 'award'; ms: number; award: MatchAwardDTO; index: number; count: number }
  | { kind: 'podium'; ms: number }
  /** The last step stays up (ms = Infinity). */
  | { kind: 'board'; ms: number };

/** Step lengths (ms): ~90-120 s for the full 15 awards; quicker with reduced motion. */
export const CEREMONY_MS = {
  intro: 5000,
  award: 5600,
  podium: 9000,
  reduced: { intro: 3000, award: 3800, podium: 6000 },
} as const;

/** The steps for these awards. Without awards it goes straight to the podium. */
export function ceremonySteps(awards: readonly MatchAwardDTO[] | undefined, opts: { reducedMotion?: boolean } = {}): CeremonyStep[] {
  const t = opts.reducedMotion ? CEREMONY_MS.reduced : CEREMONY_MS;
  const list = awards ?? [];
  const steps: CeremonyStep[] = [];
  if (list.length > 0) {
    steps.push({ kind: 'intro', ms: t.intro });
    list.forEach((award, index) => steps.push({ kind: 'award', ms: t.award, award, index, count: list.length }));
  }
  steps.push({ kind: 'podium', ms: t.podium });
  steps.push({ kind: 'board', ms: Number.POSITIVE_INFINITY });
  return steps;
}

/** Total length of the timed part (everything before the final board). */
export function ceremonyLength(steps: readonly CeremonyStep[]): number {
  return steps.reduce((s, x) => s + (Number.isFinite(x.ms) ? x.ms : 0), 0);
}

export interface CeremonyPosition {
  index: number;
  step: CeremonyStep;
  /** ms into the current step. */
  elapsed: number;
  paused: boolean;
}

/**
 * The ceremony's clock: elapsed time since the start, minus paused time,
 * with skips. All methods take `now` (ms), so tests drive it by hand.
 */
export class CeremonyClock {
  private startAt: number;
  private pausedAt: number | null = null;

  constructor(
    private steps: readonly CeremonyStep[],
    now: number,
  ) {
    this.startAt = now;
  }

  /** Swap the steps (new awards arrived) keeping the clock. */
  setSteps(steps: readonly CeremonyStep[]): void {
    this.steps = steps;
  }

  get paused(): boolean {
    return this.pausedAt !== null;
  }

  private elapsed(now: number): number {
    return (this.pausedAt ?? now) - this.startAt;
  }

  /** Where the ceremony is at `now`. */
  at(now: number): CeremonyPosition {
    let t = Math.max(0, this.elapsed(now));
    for (let i = 0; i < this.steps.length; i++) {
      const step = this.steps[i]!;
      if (t < step.ms || i === this.steps.length - 1) return { index: i, step, elapsed: t, paused: this.paused };
      t -= step.ms;
    }
    // No steps at all (never happens: there is always a board).
    return { index: 0, step: { kind: 'board', ms: Number.POSITIVE_INFINITY }, elapsed: 0, paused: this.paused };
  }

  /** Start time (ms into the ceremony) of step `index`. */
  private startOf(index: number): number {
    let t = 0;
    for (let i = 0; i < index && i < this.steps.length; i++) t += this.steps[i]!.ms;
    return t;
  }

  /** → / Enter: jump to the start of the next step (stays paused when paused). */
  next(now: number): void {
    const { index } = this.at(now);
    if (index >= this.steps.length - 1) return;
    const target = this.startOf(index + 1);
    this.startAt = (this.pausedAt ?? now) - target;
  }

  /** Space: pause or resume. */
  togglePause(now: number): void {
    if (this.pausedAt === null) this.pausedAt = now;
    else {
      this.startAt += now - this.pausedAt;
      this.pausedAt = null;
    }
  }

  /** R: from the top (and running). */
  replay(now: number): void {
    this.startAt = now;
    this.pausedAt = null;
  }
}

export type CeremonyAction = 'next' | 'pause' | 'replay';

/** Facilitator keys (an /admin session in this browser only): → / Enter next, Space pause, R replay. */
export function ceremonyKey(key: string, isAdmin: boolean): CeremonyAction | null {
  if (!isAdmin) return null;
  if (key === 'ArrowRight' || key === 'Enter') return 'next';
  if (key === ' ' || key === 'Spacebar') return 'pause';
  if (key === 'r' || key === 'R') return 'replay';
  return null;
}

/** The short on-screen hint for the facilitator. */
export const CEREMONY_HINT = '→ / Enter next · Space pause · R replay';

/**
 * The sounds a step starts with: the drumroll (snare roll crescendo and a
 * cymbal) for the intro, a fanfare sting per award, the victory tune for the
 * podium; nothing for the final board.
 */
export function stepSounds(step: CeremonyStep): SfxName[] {
  switch (step.kind) {
    case 'intro':
      return ['drumroll'];
    case 'award':
      // The Champion gets the bigger sting.
      return [step.award.id === 'champion' ? 'fanfare' : 'sting'];
    case 'podium':
      return ['fanfare'];
    case 'board':
      return [];
  }
}

/**
 * Sounds to play when the shown step changed from `prev` to `cur` (step
 * indices; null = nothing shown yet). Only entering a new step plays (a pause
 * or a re-render doesn't); a replay re-enters the intro and plays again.
 */
export function ceremonyCues(prev: number | null, cur: number, steps: readonly CeremonyStep[]): SfxName[] {
  if (prev === cur) return [];
  const step = steps[cur];
  return step ? stepSounds(step) : [];
}

// ---------------------------------------------------------------------------
// The final board: every player's award icons
// ---------------------------------------------------------------------------

export interface PlayerAwardIcon {
  id: AwardId;
  emoji: string;
  title: string;
  text: string;
}

/** playerId → the awards they won (ceremony order). */
export function awardsByPlayer(awards: readonly MatchAwardDTO[] | undefined): Map<string, PlayerAwardIcon[]> {
  const out = new Map<string, PlayerAwardIcon[]>();
  for (const a of awards ?? []) {
    for (const w of a.winners) {
      const list = out.get(w.playerId) ?? [];
      list.push({ id: a.id, emoji: a.emoji, title: a.title, text: a.text });
      out.set(w.playerId, list);
    }
  }
  return out;
}

/** Podium blocks rise 3rd, then 2nd, then 1st: the delay (ms) of a place's block. */
export function podiumRiseMs(place: number, reducedMotion = false): number {
  if (reducedMotion) return 0;
  return place === 3 ? 300 : place === 2 ? 1500 : 2900;
}
