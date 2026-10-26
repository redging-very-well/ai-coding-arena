// Strike and disable policy for ONE player's sandbox in one battle. Pure bookkeeping, no I/O: the sim feeds it
// every TickResult and leaves disabled instances out of the next TickInput.
//
// | Event                                  | Effect                                               |
// |----------------------------------------|------------------------------------------------------|
// | update() throws                        | unit idles, +1 unit strike; at the limit (30) the    |
// |                                        | unit is disabled ("…is taking a nap 💤")              |
// | __tick exceeds the hard timeout        | all units idle; the culprit (__current) gets +1      |
// |                                        | strike ("…took too long once"); its 2nd timeout in   |
// |                                        | the battle disables it (one GC stall is forgiven)    |
// | a host stall (the sandbox process was  | all units idle, no strike, no count; but if the unit |
// | frozen) that names a culprit           | it named times out on its own on the next tick, the  |
// |                                        | stall was its first timeout (an endless loop that    |
// |                                        | met a stall still naps on its next tick)             |
// | timeouts continue (no culprit left to  | 3 in a row or 5 in total disable the whole player    |
// | blame; a culprit's own don't count)    |                                                      |
// | __tick slower than the soft limit      | +1 slow strike; at the limit (30) the slowest unit   |
// |                                        | is disabled; reaching it again disables the player   |
// | out of memory / crash                  | all of the player's units are disabled               |
// | forged / duplicate output, bad output  | recorded as player strikes (reported, no disable)    |

import type { TickResult } from './runner.js';
import { isUnitError } from './runner.js';

export interface StrikeLimits {
  /** Throws before a unit is disabled (default 30). */
  unitStrikeLimit: number;
  /** Hard timeouts blamed on one unit before it is disabled (default 2). */
  timeoutsToDisable: number;
  /** Timeouts in a row that disable the player (default 3). */
  timeoutsInARowLimit: number;
  /** Total timeouts that disable the player (default 5). */
  timeoutsTotalLimit: number;
  /** Slow strikes before the slowest unit, then the player, is disabled (default 30). */
  slowStrikeLimit: number;
}

export type DisableReason = 'errors' | 'timeout' | 'slow' | 'spawn-failed';
export type PlayerDisableReason = 'timeouts' | 'slow' | 'crashed';

/** One entry for the battle report, in the order it happened. */
export type StrikeEvent =
  | { kind: 'unit-error'; tick: number; instanceId: string; message: string; line?: number; strikes: number }
  | { kind: 'unit-disabled'; tick: number; instanceId: string; reason: DisableReason; message: string }
  | { kind: 'timeout'; tick: number; elapsedMs: number; culprit?: string; hostStall?: true }
  | { kind: 'slow'; tick: number; elapsedMs: number; slowestInstanceId?: string; slowStrikes: number }
  | { kind: 'forged'; tick: number; count: number }
  | { kind: 'bad-output'; tick: number; detail?: string }
  | { kind: 'player-disabled'; tick: number; reason: PlayerDisableReason; message: string };

/** The friendly message for a unit that hit its strike limit. */
export function napMessage(name: string): string {
  return `${name} got confused too many times and is taking a nap 💤`;
}

/** Report text for a unit's first (forgiven) hard timeout. */
export function timedOutOnceMessage(name: string): string {
  return `${name} took too long once`;
}

export class StrikeTracker {
  private readonly unitStrikes = new Map<string, number>();
  /** Hard timeouts blamed on each instance (via `__current`). */
  private readonly unitTimeouts = new Map<string, number>();
  private readonly disabled = new Set<string>();
  private timeoutsInARow = 0;
  private timeoutsTotal = 0;
  private slowStrikes = 0;
  /** Time (ms) each instance spent in slow ticks; names the slowest unit. */
  private readonly slowMs = new Map<string, number>();
  private slowUnitDisabled = false;
  /**
   * The unit a host-stall timeout named, until the next result: a stall hides
   * whether the unit was looping, so if it then times out on its own, the
   * stall is counted as its first timeout.
   */
  private stallSuspect: string | undefined;
  private _playerDisabled = false;
  /** Every event so far (also returned per tick by `record`). */
  readonly events: StrikeEvent[] = [];
  /** Player-level strikes (forged output, bad output). */
  playerStrikes = 0;

  constructor(
    private readonly limits: StrikeLimits,
    /** Display name for an instance (unit name), used in messages. */
    private readonly nameOf: (instanceId: string) => string = (id) => id,
  ) {}

  get playerDisabled(): boolean {
    return this._playerDisabled;
  }

  isDisabled(instanceId: string): boolean {
    return this._playerDisabled || this.disabled.has(instanceId);
  }

  strikesOf(instanceId: string): number {
    return this.unitStrikes.get(instanceId) ?? 0;
  }

  /** The instances that should act this tick (drops disabled ones). */
  active<T extends { id: string }>(selves: readonly T[]): T[] {
    if (this._playerDisabled) return [];
    return selves.filter((s) => !this.disabled.has(s.id));
  }

  /** Disable one unit from outside (e.g. its spawn failed). */
  disableUnit(tick: number, instanceId: string, reason: DisableReason, message?: string): StrikeEvent[] {
    const out: StrikeEvent[] = [];
    this.disable(out, tick, instanceId, reason, message);
    return this.push(out);
  }

  /** Apply the rules to one tick's result. Returns the new events. */
  record(tick: number, result: TickResult): StrikeEvent[] {
    const out: StrikeEvent[] = [];
    if (this._playerDisabled) return out;
    const suspect = this.stallSuspect;
    this.stallSuspect = undefined;

    switch (result.status) {
      case 'crashed':
        this.disablePlayer(out, tick, 'crashed', `The sandbox stopped: ${result.detail ?? 'crashed'}. All units are disabled for this battle.`);
        return this.push(out);
      case 'bad-output':
        this.playerStrikes++;
        out.push({ kind: 'bad-output', tick, ...(result.detail ? { detail: result.detail } : {}) });
        this.timeoutsInARow = 0;
        return this.push(out);
      case 'timeout': {
        if (result.hostStall) {
          // The sandbox process was frozen, not the player's code: idle, no blame
          // (but remember who was running, in case it times out again on its own).
          if (result.culprit && !this.disabled.has(result.culprit)) this.stallSuspect = result.culprit;
          out.push({ kind: 'timeout', tick, elapsedMs: result.elapsedMs, hostStall: true });
          return this.push(out);
        }
        out.push({ kind: 'timeout', tick, elapsedMs: result.elapsedMs, ...(result.culprit ? { culprit: result.culprit } : {}) });
        const culprit = result.culprit;
        if (culprit && !this.disabled.has(culprit)) {
          // A single stall can be the host (GC, scheduler), not the player's code:
          // the first one only idles this tick and is reported; a repeat naps.
          // Timing out right after a host stall that named it: that stall was
          // its first timeout (a loop the stall hid), so this one is a repeat.
          const hidden = culprit === suspect ? 1 : 0;
          const timeouts = (this.unitTimeouts.get(culprit) ?? 0) + 1 + hidden;
          this.unitTimeouts.set(culprit, timeouts);
          const strikes = (this.unitStrikes.get(culprit) ?? 0) + 1 + hidden;
          this.unitStrikes.set(culprit, strikes);
          const name = this.nameOf(culprit);
          if (timeouts >= this.limits.timeoutsToDisable) {
            const again = timeouts > 1 ? ' again' : '';
            out.push({ kind: 'unit-error', tick, instanceId: culprit, message: `${name} took too long${again}`, strikes });
            this.disable(out, tick, culprit, 'timeout', `${name} took too long to think (endless loop?) and is taking a nap 💤`);
          } else {
            out.push({ kind: 'unit-error', tick, instanceId: culprit, message: timedOutOnceMessage(name), strikes });
            if (strikes >= this.limits.unitStrikeLimit) this.disable(out, tick, culprit, 'errors');
          }
          // A culprit's own timeouts don't count toward the player limits:
          // those are for timeouts that continue after it naps, so 2
          // copies of one looping design can't disable the whole player.
          return this.push(out);
        }
        this.timeoutsInARow++;
        this.timeoutsTotal++;
        if (this.timeoutsInARow >= this.limits.timeoutsInARowLimit || this.timeoutsTotal >= this.limits.timeoutsTotalLimit) {
          this.disablePlayer(out, tick, 'timeouts', 'Too many timeouts: all units are disabled for this battle.');
        }
        return this.push(out);
      }
      case 'ok':
        break;
    }

    this.timeoutsInARow = 0;
    if (result.forged > 0) {
      this.playerStrikes++;
      out.push({ kind: 'forged', tick, count: result.forged });
    }
    for (const o of result.outputs) {
      if (!isUnitError(o)) continue;
      const strikes = (this.unitStrikes.get(o.instanceId) ?? 0) + 1;
      this.unitStrikes.set(o.instanceId, strikes);
      out.push({
        kind: 'unit-error',
        tick,
        instanceId: o.instanceId,
        message: o.error.message,
        ...(o.error.line !== undefined ? { line: o.error.line } : {}),
        strikes,
      });
      if (strikes >= this.limits.unitStrikeLimit) this.disable(out, tick, o.instanceId, 'errors');
    }
    if (result.slow) {
      this.slowStrikes++;
      for (const o of result.outputs) {
        if (o.ms) this.slowMs.set(o.instanceId, (this.slowMs.get(o.instanceId) ?? 0) + o.ms);
      }
      out.push({
        kind: 'slow',
        tick,
        elapsedMs: result.elapsedMs,
        ...(result.slowestInstanceId ? { slowestInstanceId: result.slowestInstanceId } : {}),
        slowStrikes: this.slowStrikes,
      });
      if (this.slowStrikes >= this.limits.slowStrikeLimit) {
        const slowest = this.slowestCandidate() ?? result.slowestInstanceId;
        if (!this.slowUnitDisabled && slowest && !this.disabled.has(slowest)) {
          this.slowUnitDisabled = true;
          this.slowStrikes = 0;
          this.slowMs.clear();
          this.disable(out, tick, slowest, 'slow', `${this.nameOf(slowest)} thinks too slowly and is taking a nap 💤`);
        } else {
          this.disablePlayer(out, tick, 'slow', 'Units keep thinking too slowly: all units are disabled for this battle.');
        }
      }
    }
    return this.push(out);
  }

  /** The not-yet-disabled instance with the most time spent in slow ticks. */
  private slowestCandidate(): string | undefined {
    let best: string | undefined;
    let bestMs = 0;
    for (const [id, ms] of this.slowMs) {
      if (ms > bestMs && !this.disabled.has(id)) {
        best = id;
        bestMs = ms;
      }
    }
    return best;
  }

  private disable(out: StrikeEvent[], tick: number, instanceId: string, reason: DisableReason, message?: string): void {
    if (this.disabled.has(instanceId)) return;
    this.disabled.add(instanceId);
    out.push({ kind: 'unit-disabled', tick, instanceId, reason, message: message ?? napMessage(this.nameOf(instanceId)) });
  }

  private disablePlayer(out: StrikeEvent[], tick: number, reason: PlayerDisableReason, message: string): void {
    this._playerDisabled = true;
    out.push({ kind: 'player-disabled', tick, reason, message });
  }

  private push(out: StrikeEvent[]): StrikeEvent[] {
    this.events.push(...out);
    return out;
  }
}
