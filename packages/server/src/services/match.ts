// The authoritative game state machine (plan §3) with phase timers, the
// phase gates (§10.2) and the facilitator's controls (§10.3 admin).
//
//   LOBBY → PLAN → PLACEMENT → BATTLE → RESULTS → PLAN … → MATCH_RESULTS → LOBBY
//
// PLAN auto-advances when its timer ends, or (timers.autoAdvanceWhenAllReady)
// ~3 s after every active player is Ready; PLACEMENT never auto-starts (the
// timer just runs out and shows "Waiting for host START"). The host can also
// start a short, cancellable countdown to Next/START (the pending advance). BATTLE → RESULTS
// follows the PLAYBACK clock (services/battle.ts releases the result).

import { fail, ok, type PendingAdvanceDTO, type Phase, type Result, type TimerDTO } from '@pixel-clash/shared';

type AdvanceTarget = PendingAdvanceDTO['to'];
import { log } from '../util/log.js';
import type { Game } from './game.js';
import { teamRoundRanking } from '../sim/scoring.js';
import type { RoundResultRecord } from './store.js';

export type GatedOp = 'submit' | 'retire' | 'selection' | 'placement' | 'ready' | 'adminSubmit';

/** §10.2: the phases in which each operation is open (validate is always open). */
export const PHASE_GATES: Record<GatedOp, readonly Phase[]> = {
  submit: ['PLAN'],
  retire: ['PLAN'],
  selection: ['PLAN'],
  placement: ['PLACEMENT'],
  ready: ['PLAN', 'PLACEMENT'],
  adminSubmit: ['PLAN'],
};

const OP_TEXT: Record<GatedOp, string> = {
  submit: 'Submitting units',
  retire: 'Deleting units',
  selection: 'Picking units',
  placement: 'Placing units',
  ready: 'Getting ready',
  adminSubmit: 'Submitting on behalf',
};

const TICK_MS = 250;
const AUTO_ADVANCE_MS = 3000;

export class MatchService {
  private ticker: NodeJS.Timeout | undefined;
  private lastBroadcastSecond: number | null = null;
  /** The countdown to the next step (host or auto), or null. Not persisted. */
  private pending: { to: AdvanceTarget; at: number; by: 'host' | 'auto'; phase: Phase; round: number } | null = null;
  private lastPendingSecond: number | null = null;
  /** The host cancelled the auto countdown; it re-arms once someone un-readies. */
  private autoCancelled = false;

  constructor(private readonly game: Game) {}

  private get m() {
    return this.game.store.match;
  }

  get phase(): Phase {
    return this.m.phase;
  }

  // -------------------------------------------------------------------------
  // Phase gates (§10.2)
  // -------------------------------------------------------------------------

  /** null when `op` is open now, else a PHASE_CLOSED result. */
  gate(op: GatedOp): Result<never> | null {
    const open = PHASE_GATES[op];
    const phase = this.m.phase;
    if (open.includes(phase)) return null;
    const opensIn = open[0]!;
    const details: Record<string, unknown> = { phase, opensIn };
    // Seconds until it opens, when the very next phase is the one that opens.
    const next: Partial<Record<Phase, Phase>> = { PLAN: 'PLACEMENT' };
    const secs = this.timerDTO().secondsLeft;
    if (next[phase] === opensIn && secs !== null) details.secondsLeft = secs;
    const hint =
      op === 'submit'
        ? "Tell the player: we'll send it when the Plan phase starts. Keep the unit validated (validate_unit works any time) and submit it once get_game_state says submissionsOpen is true."
        : `Wait for the ${opensIn} phase.`;
    return fail('PHASE_CLOSED', `${OP_TEXT[op]} is closed right now (phase ${phase}). It opens in the ${opensIn} phase.`, {
      hint,
      details,
    });
  }

  submissionsOpen(): boolean {
    return this.m.phase === 'PLAN';
  }

  // -------------------------------------------------------------------------
  // Timers
  // -------------------------------------------------------------------------

  private startTimer(seconds: number): void {
    this.m.timer = { deadline: Date.now() + seconds * 1000, remainingMs: null, paused: false };
  }

  private clearTimer(): void {
    this.m.timer = { deadline: null, remainingMs: null, paused: false };
  }

  private remainingMs(): number | null {
    const t = this.m.timer;
    if (t.paused) return t.remainingMs;
    if (t.deadline === null) return null;
    return Math.max(0, t.deadline - Date.now());
  }

  timerDTO(): TimerDTO {
    if (this.m.phase === 'BATTLE') {
      const pb = this.game.battle.playback();
      const total = this.game.config.timers.battleTicks;
      const tps = this.game.config.timers.ticksPerSecond;
      const left = pb ? Math.max(0, Math.ceil((total - pb.tick) / tps)) : Math.ceil(total / tps);
      return { secondsLeft: left, paused: pb?.paused ?? false };
    }
    const rem = this.remainingMs();
    const dto: TimerDTO = { secondsLeft: rem === null ? null : Math.ceil(rem / 1000), paused: this.m.timer.paused };
    if (this.m.timer.expired) {
      dto.expired = true;
      dto.secondsLeft = 0;
    }
    return dto;
  }

  /** Admin timer controls: set, add (may be negative) and pause/resume. */
  adjustTimer(body: { setSeconds?: unknown; addSeconds?: unknown; paused?: unknown }): Result<TimerDTO> {
    const phase = this.m.phase;
    if (phase === 'BATTLE') {
      if (typeof body.paused === 'boolean') this.game.battle.setPlayback({ paused: body.paused });
      return ok(this.timerDTO());
    }
    if (phase !== 'PLAN' && phase !== 'PLACEMENT') {
      return fail('BAD_REQUEST', `There is no timer in ${phase}.`);
    }
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    const set = num(body.setSeconds);
    const add = num(body.addSeconds);
    if (body.setSeconds !== undefined && (set === undefined || set < 0)) return fail('BAD_REQUEST', 'setSeconds must be a number >= 0.');
    if (body.addSeconds !== undefined && add === undefined) return fail('BAD_REQUEST', 'addSeconds must be a number.');
    let rem = this.remainingMs() ?? 0;
    if (set !== undefined) rem = set * 1000;
    if (add !== undefined) rem = Math.max(0, rem + add * 1000);
    const paused = typeof body.paused === 'boolean' ? body.paused : this.m.timer.paused;
    if (set !== undefined || add !== undefined || paused !== this.m.timer.paused) {
      this.m.timer = paused
        ? { deadline: null, remainingMs: rem, paused: true }
        : { deadline: Date.now() + rem, remainingMs: null, paused: false };
      if (rem > 0) delete this.m.timer.expired;
    }
    this.syncAutoAdvance();
    this.changed();
    return ok(this.timerDTO());
  }

  /** Start the 4 Hz ticker: timer expiry and 1 Hz state pushes. */
  startTicker(): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => this.tick(), TICK_MS);
    this.ticker.unref?.();
  }

  stopTimers(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
  }

  // -------------------------------------------------------------------------
  // Pending advance: a short countdown to the next step (§3, §10.3)
  // -------------------------------------------------------------------------
  //
  //  * by 'host': the facilitator pressed "Start placement ▶" / "START battle ▶"
  //    (/admin or /screen with the admin cookie). It keeps counting when
  //    someone un-readies (the host chose it); at zero it does exactly what
  //    Next (PLAN) or START without force (PLACEMENT) does, so a PLACEMENT one
  //    can still be refused with NOT_ALL_READY (toast to the admin).
  //  * by 'auto': timers.autoAdvanceWhenAllReady, PLAN only. Runs while every
  //    active player is Ready and the PLAN timer isn't paused; cancelled as
  //    soon as that stops being true.
  // Either can be cancelled by the host; any other phase change drops it. A
  // cancelled auto countdown stays off until someone un-readies (or the phase
  // changes), so Cancel isn't undone a tick later. Kept in memory only.

  /** True when the auto countdown should run now. */
  private wantAuto(): boolean {
    return this.m.phase === 'PLAN' && this.game.config.timers.autoAdvanceWhenAllReady && !this.m.timer.paused && this.game.round.everyoneReady();
  }

  /**
   * Bring the pending advance in line with the state: drop it after a phase
   * change, start/cancel the auto one. Returns true when it changed.
   */
  syncAutoAdvance(): boolean {
    const p = this.pending;
    if (p && (p.phase !== this.m.phase || p.round !== this.m.round)) {
      this.pending = null;
      this.autoCancelled = false;
      return true;
    }
    if (!this.game.round.everyoneReady() || this.m.phase !== 'PLAN') this.autoCancelled = false;
    if (p?.by === 'host') return false;
    const want = this.wantAuto() && !this.autoCancelled;
    if (want && !p) {
      this.setPending('PLACEMENT', this.game.options.autoAdvanceDelayMs ?? AUTO_ADVANCE_MS, 'auto');
      log.info(`round ${this.m.round}: everyone is ready, placement starts in a moment`);
      return true;
    }
    if (!want && p) {
      this.pending = null;
      return true;
    }
    return false;
  }

  private setPending(to: AdvanceTarget, delayMs: number, by: 'host' | 'auto'): void {
    this.pending = { to, at: Date.now() + delayMs, by, phase: this.m.phase, round: this.m.round };
    this.lastPendingSecond = null;
  }

  /** The countdown for the state DTO, or null. */
  pendingAdvanceDTO(): PendingAdvanceDTO | null {
    const p = this.pending;
    if (!p || p.phase !== this.m.phase || p.round !== this.m.round) return null;
    return { to: p.to, by: p.by, secondsLeft: Math.max(1, Math.ceil((p.at - Date.now()) / 1000)) };
  }

  /**
   * Admin: start the countdown to the next step (PLAN → PLACEMENT any time,
   * PLACEMENT → BATTLE when everyone is Ready). Replaces an auto countdown.
   */
  startAdvance(delayIn: unknown): Result<true> {
    const delay = delayIn === undefined || delayIn === null ? 3 : delayIn;
    if (typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0 || delay > 10) {
      return fail('BAD_REQUEST', 'delaySec must be a number from 0 to 10.');
    }
    const phase = this.m.phase;
    if (phase !== 'PLAN' && phase !== 'PLACEMENT') {
      return fail('PHASE_CLOSED', 'The countdown works only in PLAN and PLACEMENT.', { details: { phase, opensIn: 'PLAN' } });
    }
    if (phase === 'PLACEMENT' && !this.game.round.allReady()) return this.notAllReady();
    this.setPending(phase === 'PLAN' ? 'PLACEMENT' : 'BATTLE', delay * 1000, 'host');
    log.info(`round ${this.m.round}: host countdown to ${this.pending!.to} (${delay} s)`);
    this.game.notifier.stateChanged();
    return ok(true);
  }

  /** Admin: cancel a running countdown (host or auto). Idempotent. */
  cancelAdvance(): Result<true> {
    if (this.pending) {
      if (this.pending.by === 'auto') this.autoCancelled = true;
      this.pending = null;
      this.game.notifier.toast({ all: true }, 'info', 'Countdown cancelled.');
      this.game.notifier.stateChanged();
    }
    return ok(true);
  }

  /** The pending advance reached zero. */
  private firePending(): void {
    const p = this.pending!;
    this.pending = null;
    this.autoCancelled = false;
    if (p.to === 'PLACEMENT') {
      log.info(`round ${this.m.round}: countdown over (${p.by}), starting placement`);
      this.enterPlacement();
      return;
    }
    const r = this.start(false);
    if (!r.ok) {
      this.game.notifier.toast({ admin: true }, 'warn', `${r.error.message} Use Force start, or start the countdown again.`);
      this.game.notifier.stateChanged();
    }
  }

  private tick(): void {
    const phase = this.m.phase;
    if (phase === 'BATTLE') return; // the battle service pushes its own clock
    if (phase === 'PLAN' || phase === 'PLACEMENT') {
      if (this.syncAutoAdvance()) this.game.notifier.stateChanged();
      if (this.pending) {
        if (Date.now() >= this.pending.at) {
          this.firePending();
          return;
        }
        const sec = this.pendingAdvanceDTO()?.secondsLeft ?? null;
        if (sec !== this.lastPendingSecond) {
          this.lastPendingSecond = sec;
          this.game.notifier.stateChanged();
        }
      }
    }
    const rem = this.remainingMs();
    if (rem === null || this.m.timer.expired) {
      this.lastBroadcastSecond = null;
      return;
    }
    if (rem <= 0 && !this.m.timer.paused) {
      this.onTimerEnd();
      return;
    }
    const sec = Math.ceil(rem / 1000);
    if (sec !== this.lastBroadcastSecond) {
      this.lastBroadcastSecond = sec;
      this.game.notifier.stateChanged();
    }
  }

  private onTimerEnd(): void {
    if (this.m.phase === 'PLAN') {
      log.info(`round ${this.m.round}: PLAN timer ended`);
      this.enterPlacement();
    } else if (this.m.phase === 'PLACEMENT') {
      // No auto-start: wait for the host's START.
      this.m.timer = { deadline: null, remainingMs: null, paused: false, expired: true };
      this.game.notifier.toast({ all: true }, 'info', "Time's up! Waiting for the host to press START.");
      this.changed();
    }
  }

  private changed(): void {
    this.game.store.save();
    this.game.notifier.stateChanged();
  }

  private allPrivateChanged(): void {
    for (const p of this.game.players.list()) this.game.notifier.privateChanged(p.id);
  }

  // -------------------------------------------------------------------------
  // Transitions
  // -------------------------------------------------------------------------

  /**
   * LOBBY → PLAN (needs 2-8 players). `armoryIn` switches Open Armory on for
   * the whole match (§9.1). `mapStyleIn` (undefined = the draft's, null = the
   * default for the player count) and `teamModeIn` (undefined = the draft's)
   * are checked against the players now (§9.2); team mode fixes the teams and
   * the map for the whole match.
   */
  startMatch(roundsIn?: unknown, armoryIn?: unknown, mapStyleIn?: unknown, teamModeIn?: unknown): Result<true> {
    if (this.m.phase !== 'LOBBY') return fail('PHASE_CLOSED', 'A match is already running.', { details: { phase: this.m.phase } });
    const rounds = roundsIn === undefined || roundsIn === null ? this.game.config.timers.defaultRounds : roundsIn;
    if (typeof rounds !== 'number' || !Number.isInteger(rounds) || rounds < 1 || rounds > 10) {
      return fail('BAD_REQUEST', 'rounds must be a whole number from 1 to 10.');
    }
    if (armoryIn !== undefined && armoryIn !== null && typeof armoryIn !== 'boolean') {
      return fail('BAD_REQUEST', 'armory must be true or false.');
    }
    const players = this.game.players.list();
    if (players.length < 2) {
      return fail('NOT_ENOUGH_PLAYERS', 'A match needs at least 2 players.', { details: { players: players.length } });
    }
    const setup = this.game.teams.resolveStart(mapStyleIn, teamModeIn);
    if (!setup.ok) return setup;
    for (const p of players) p.activeFromRound = 1;
    this.game.teams.applyStart(setup.data);
    this.m.rounds = rounds;
    this.m.round = 1;
    this.m.results = [];
    this.m.points = Object.fromEntries(players.map((p) => [p.id, 0]));
    this.m.damage = {};
    this.m.badges = {};
    this.game.armory.reset(armoryIn === true);
    const teamsText = setup.data.teams ? `, ${setup.data.teamMode} on ${setup.data.style}` : `, free-for-all (${setup.data.mapStyle ?? 'default'} map)`;
    log.info(`match started: ${rounds} rounds, ${players.length} players${teamsText}${armoryIn === true ? ', Open Armory on' : ''}`);
    this.enterPlan();
    return ok(true);
  }

  private enterPlan(): void {
    const m = this.m;
    m.phase = 'PLAN';
    m.zones = {};
    // Entries of creators deleted during PLACEMENT go now (§9.1 Lifecycle).
    this.game.armory.applyPendingRemovals();
    for (const p of this.game.players.list()) {
      const rs = this.game.round.stateOf(p.id);
      rs.submittedThisPlan = false;
      rs.ready = false;
      rs.placements = [];
      rs.locked = null;
      m.points[p.id] ??= 0;
    }
    const t = this.game.config.timers;
    this.startTimer(m.round === 1 ? t.planFirstRoundSec : t.planLaterRoundsSec);
    this.game.notifier.toast({ all: true }, 'info', `Round ${m.round}: Plan time! Ask Claude for new units.`);
    this.changed();
    this.allPrivateChanged();
  }

  private enterPlacement(): void {
    const m = this.m;
    this.pending = null;
    this.game.round.lockSelections();
    this.game.round.assignZones();
    m.phase = 'PLACEMENT';
    this.startTimer(this.game.config.timers.placementSec);
    this.game.notifier.toast({ all: true }, 'info', 'Place your army!');
    this.changed();
    this.allPrivateChanged();
  }

  /** PLACEMENT → BATTLE. Without force everyone must be Ready (§10.3). */
  start(force: boolean): Result<true> {
    if (this.m.phase !== 'PLACEMENT') {
      return fail('PHASE_CLOSED', 'START works only in PLACEMENT.', { details: { phase: this.m.phase, opensIn: 'PLACEMENT' } });
    }
    if (!force && !this.game.round.allReady()) return this.notAllReady();
    this.pending = null;
    // A kick since PLACEMENT began changes the zone set (§9 Zones: per active count).
    const activeIds = this.game.players.active().map((p) => p.id);
    const zoned = Object.keys(this.m.zones);
    if (activeIds.length !== zoned.length || activeIds.some((id) => !this.m.zones[id])) this.game.round.assignZones();
    const auto = this.game.round.autoPlaceEmpty();
    for (const name of auto) this.game.notifier.toast({ all: true }, 'info', `${name}'s army was placed for them.`);
    for (const p of this.game.players.active()) {
      const rs = this.game.round.stateOf(p.id);
      if (rs.placements.length > 0) rs.lastLayout = rs.placements.map((x) => ({ ...x }));
    }
    this.m.phase = 'BATTLE';
    this.clearTimer();
    this.changed();
    this.allPrivateChanged();
    this.game.battle.start();
    return ok(true);
  }

  private notAllReady(): Result<never> {
    const notReady = this.game.players
      .active()
      .filter((p) => !this.game.round.stateOf(p.id).ready)
      .map((p) => p.name);
    return fail('NOT_ALL_READY', `Not everyone is ready: ${notReady.join(', ')}.`, {
      hint: 'Wait for everyone, or use Force start.',
      details: { notReady },
    });
  }

  /** The battle service could not start the battle: back to PLACEMENT. */
  battleFailed(message: string): void {
    if (this.m.phase !== 'BATTLE') return;
    this.m.phase = 'PLACEMENT';
    for (const p of this.game.players.active()) this.game.round.stateOf(p.id).ready = false;
    this.m.timer = { deadline: null, remainingMs: null, paused: false, expired: true };
    this.game.notifier.toast({ admin: true }, 'error', `The battle could not run: ${message}`);
    this.changed();
    this.allPrivateChanged();
  }

  /** Called by the battle service when playback reached the end (or Skip). */
  battleReleased(result: RoundResultRecord): void {
    const m = this.m;
    // Round points, match damage (standings tie-break) and badge counts (§9).
    for (const r of result.end.ranking) {
      m.points[r.playerId] = (m.points[r.playerId] ?? 0) + r.pointsGained;
      m.damage[r.playerId] = (m.damage[r.playerId] ?? 0) + r.damage;
      const badges = (m.badges[r.playerId] ??= {});
      for (const b of r.badges) badges[b] = (badges[b] ?? 0) + 1;
    }
    // Players kicked during this battle leave the scoreboard with it (§4).
    const leaving = new Set(m.pendingKicks);
    result.end.scoreboard = this.game.visibility.scoreboard(leaving);
    // Team mode (§9.2): the round's team ranking, then the match team table.
    if (this.game.teams.active) result.end.teams = teamRoundRanking(result.end.ranking);
    m.results.push(result);
    if (this.game.teams.active) result.end.teamTable = this.game.teams.teamTable(leaving) ?? [];
    m.phase = 'RESULTS';
    this.clearTimer();
    this.game.players.applyPendingKicks();
    this.changed();
    this.allPrivateChanged();
  }

  /** Admin Next: advance one in-round step. */
  next(): Result<true> {
    switch (this.m.phase) {
      case 'LOBBY':
        return this.startMatch();
      case 'PLAN':
        this.enterPlacement();
        return ok(true);
      case 'PLACEMENT':
        return this.start(false);
      case 'BATTLE':
        return fail('BAD_REQUEST', 'The battle is running. Use Skip to end it now.');
      case 'RESULTS':
        return this.afterResults();
      case 'MATCH_RESULTS':
        return this.resetToLobby();
    }
  }

  /** Admin Skip: end the current phase now. */
  async skip(): Promise<Result<true>> {
    switch (this.m.phase) {
      case 'LOBBY':
        return fail('BAD_REQUEST', 'Nothing to skip in the lobby. Start the match instead.');
      case 'PLAN':
        this.enterPlacement();
        return ok(true);
      case 'PLACEMENT':
        return this.start(true);
      case 'BATTLE':
        await this.game.battle.skip();
        return ok(true);
      case 'RESULTS':
        return this.afterResults();
      case 'MATCH_RESULTS':
        return this.resetToLobby();
    }
  }

  private afterResults(): Result<true> {
    if (this.m.round < this.m.rounds) {
      this.m.round += 1;
      this.enterPlan();
    } else {
      this.m.phase = 'MATCH_RESULTS';
      this.clearTimer();
      this.game.notifier.toast({ all: true }, 'info', 'Game over! Great battles, everyone!');
      this.changed();
    }
    return ok(true);
  }

  /**
   * Admin "New match" (§10.3): → LOBBY. From MATCH_RESULTS this is the normal
   * step; from any other phase it is the host's (confirmed) escape hatch that
   * throws the running match away. A running battle is aborted first, and
   * kicks queued during it are applied (they would otherwise be lost).
   */
  async newMatch(): Promise<Result<true>> {
    if (this.m.phase === 'BATTLE') await this.game.battle.abort();
    return this.resetToLobby();
  }

  /** → LOBBY: resets round, points, damage, badges and the Armory (§9.1); keeps players and units. */
  private resetToLobby(): Result<true> {
    const m = this.m;
    this.game.players.applyPendingKicks();
    this.pending = null;
    m.phase = 'LOBBY';
    m.round = 0;
    m.results = [];
    m.damage = {};
    m.badges = {};
    m.zones = {};
    m.map = null;
    this.game.armory.reset(false);
    this.clearTimer();
    for (const p of this.game.players.list()) {
      p.activeFromRound = 1;
      m.points[p.id] = 0;
      const rs = this.game.round.stateOf(p.id);
      rs.locked = null;
      rs.placements = [];
      rs.ready = false;
      rs.lastLayout = null;
      rs.prevSelection = null;
      rs.submittedThisPlan = false;
    }
    // Teams are only fixed for a match: back in LOBBY the draft is re-dealt
    // for everyone (benched players included), §9.2.
    m.teams = null;
    this.game.teams.rebalance(true);
    this.changed();
    this.allPrivateChanged();
    return ok(true);
  }

  /** After a restart: a running battle is reset to PLACEMENT (§13). */
  recover(): void {
    if (this.m.phase === 'BATTLE') {
      log.warn(`a battle was running when the server stopped; round ${this.m.round} is back in PLACEMENT`);
      this.m.phase = 'PLACEMENT';
      this.game.players.applyPendingKicks();
      for (const p of this.game.players.active()) this.game.round.stateOf(p.id).ready = false;
      this.m.timer = { deadline: null, remainingMs: null, paused: false, expired: true };
    }
    this.startTicker();
  }
}
