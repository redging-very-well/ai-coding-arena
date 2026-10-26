// wait_for_phase (plan §10.4): a long poll for the AI helpers. A call waits
// until the game reaches the requested phase (default PLAN, when submissions
// open) or the phase or round changes, at most WAIT_FOR_PHASE_MAX_SEC. It
// listens to the services' stateChanged() pushes (Game.onStateChanged): no
// polling. A closed HTTP request or a cancelled MCP call aborts its wait and
// removes the listener; each player has at most MAX_WAITS_PER_PLAYER waits
// open (a further one ends the oldest, which answers with the current state).

import type { Phase } from '@pixel-clash/shared';
import type { Game } from './game.js';

/**
 * Server-side cap on one wait. Both clients time a tool call out at 60 s by
 * default (Claude Code: 60 s per request for HTTP MCP servers unless
 * MCP_TOOL_TIMEOUT or a per-server timeout is set; Codex: tool_timeout_sec
 * defaults to 60), so 50 s stays safely under both even without kit config.
 */
export const WAIT_FOR_PHASE_MAX_SEC = 50;
/** Open waits per player (a seat needs one; two covers a retry overlapping a stale call). */
export const MAX_WAITS_PER_PLAYER = 2;

/** Why a wait ended. */
export type WaitReason = 'reached' | 'changed' | 'timeout' | 'aborted' | 'replaced';

export interface PhaseSnapshot {
  phase: Phase;
  round: number;
  rounds: number;
  secondsLeft: number | null;
  submissionsOpen: boolean;
}

export interface WaitOutcome {
  reason: WaitReason;
  state: PhaseSnapshot;
  waitedMs: number;
}

interface Waiter {
  playerId: string;
  finish: (reason: WaitReason) => void;
}

export class PhaseWaitService {
  private readonly waiters = new Set<Waiter>();

  constructor(private readonly game: Game) {}

  snapshot(): PhaseSnapshot {
    const m = this.game.store.match;
    return {
      phase: m.phase,
      round: m.round,
      rounds: m.rounds,
      secondsLeft: this.game.match.timerDTO().secondsLeft,
      submissionsOpen: this.game.match.submissionsOpen(),
    };
  }

  /** Open waits (all players, or one player's). */
  count(playerId?: string): number {
    if (playerId === undefined) return this.waiters.size;
    let n = 0;
    for (const w of this.waiters) if (w.playerId === playerId) n++;
    return n;
  }

  /**
   * Wait until `target` is the phase (resolves at once if it already is), the
   * phase or round changes, `maxMs` passes (capped at WAIT_FOR_PHASE_MAX_SEC)
   * or `signal` aborts.
   */
  wait(playerId: string, target: Phase, maxMs: number, signal?: AbortSignal): Promise<WaitOutcome> {
    const started = Date.now();
    const start = this.snapshot();
    const done = (reason: WaitReason): WaitOutcome => ({ reason, state: this.snapshot(), waitedMs: Date.now() - started });
    if (start.phase === target) return Promise.resolve(done('reached'));
    if (signal?.aborted) return Promise.resolve(done('aborted'));

    // The per-player cap: the oldest open wait of this player ends now.
    const mine = [...this.waiters].filter((w) => w.playerId === playerId);
    for (const w of mine.slice(0, Math.max(0, mine.length - MAX_WAITS_PER_PLAYER + 1))) w.finish('replaced');

    const ms = Math.max(0, Math.min(maxMs, WAIT_FOR_PHASE_MAX_SEC * 1000));
    const waiters = this.waiters;
    return new Promise<WaitOutcome>((resolve) => {
      let finished = false;
      const finish = (reason: WaitReason): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener('abort', onAbort);
        waiters.delete(waiter);
        resolve(done(reason));
      };
      const waiter: Waiter = { playerId, finish };
      const onAbort = (): void => finish('aborted');
      const unsubscribe = this.game.onStateChanged(() => {
        const m = this.game.store.match;
        if (m.phase === target) finish('reached');
        else if (m.phase !== start.phase || m.round !== start.round) finish('changed');
      });
      const timer = setTimeout(() => finish('timeout'), ms);
      timer.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });
      waiters.add(waiter);
    });
  }
}

/** "about 6 min left" / "40 s left" / '' (no timer). */
export function timeLeftText(secondsLeft: number | null): string {
  if (secondsLeft === null) return '';
  if (secondsLeft >= 90) return `about ${Math.round(secondsLeft / 60)} min left`;
  return `${secondsLeft} s left`;
}

/**
 * One line with the game's phase right now, appended to validate_unit and
 * submit_unit results so the helper never acts on a phase it read earlier.
 */
export function phaseLine(s: PhaseSnapshot): string {
  const round = s.round > 0 ? ` (round ${s.round} of ${s.rounds})` : '';
  const left = timeLeftText(s.secondsLeft);
  if (s.submissionsOpen) return `Game phase: ${s.phase}${round}${left ? `, ${left}` : ''}, submissions open.`;
  return `Game phase: ${s.phase}${round}${left ? `, ${left}` : ''}, submissions closed. Submissions open in the next Plan phase; call wait_for_phase to be told.`;
}
