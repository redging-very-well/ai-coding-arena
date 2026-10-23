// Battle orchestration (plan §9): at START the sim runs AHEAD in the sandbox
// runners and records frames; playback streams those frames over WS at
// 60 ticks/s × speed (1x/2x, pausable). The sim's result is HELD here and
// released (ranking, points, scoreboard, battle:end, reports) only when
// playback reaches the final frame, or at once on Skip, which ranks from the
// recorded frame at the current playback tick (§9 Skip).

import { randomInt } from 'node:crypto';
import {
  isArmoryUnitId,
  legacyCornerOf,
  mapDTO,
  mapFor,
  mapZoneDTO,
  scaleSuddenDeath,
  type BattleEndDTO,
  type BattleReportDTO,
  type BattleRevealDTO,
  type FrameDTO,
  type MapZone,
  type PlaybackDTO,
  type ReplayDTO,
  type RevealedUnitDTO,
  type UnitBattleSummaryDTO,
} from '@pixel-clash/shared';
import { createRunnerFactory } from '../sandbox/index.js';
import type { RunnerFactory, RunnerUnitDesign } from '../sandbox/runner.js';
import {
  BattleEngine,
  buildBattleReport,
  buildInstances,
  createBattleRunners,
  resultAtTick,
  type BattlePlayerSetup,
  type BattleResult,
  type BattleUnitDesign,
} from '../sim/engine.js';
import { frameAt } from '../sim/frames.js';
import { rankAtPlaybackTick, rankResult } from '../sim/ranking.js';
import { playerMetrics, scoreRanking } from '../sim/scoring.js';
import { topUnits } from '../sim/topUnits.js';
import { log } from '../util/log.js';
import { ArmoryService, type BorrowedUse, type FieldedDesign } from './armory.js';
import type { Game } from './game.js';
import type { RoundResultRecord } from './store.js';

/** Playback pump interval (frames are batched per pump). */
const PUMP_MS = 50;

interface SetupPlayer {
  playerId: string;
  seat: number;
  /** This round's zone on the battle's map (§9.2). */
  zone: MapZone;
  /** Team mode: the player's team. */
  teamId?: number;
  units: BattleUnitDesign[];
  runnerUnits: RunnerUnitDesign[];
  revealUnits: RevealedUnitDTO[];
  placements: BattlePlayerSetup['placements'];
  /** Own non-template designs fielded (placed) this battle: they enter the Armory at release (§9.1). */
  fielded: FieldedDesign[];
  /** Borrowed Armory types fielded this battle (💡 Inventor). */
  borrowed: BorrowedUse[];
  /** Borrowed unitId → display name and creator name (reports, §9.1). */
  borrowedNames: Map<string, { displayName: string; creatorName: string }>;
}

interface ActiveBattle {
  round: number;
  seed: number;
  reveal: BattleRevealDTO;
  setup: SetupPlayer[];
  /** Recorded frames (the engine's buffer once it exists). */
  frames: FrameDTO[];
  engine?: BattleEngine;
  /** Resolves when the runners exist and the sim loop started (or failed). */
  started: Promise<void>;
  /** Resolves with the sim result (held until playback ends). */
  run?: Promise<BattleResult | undefined>;
  result?: BattleResult;
  simDone: boolean;
  simDoneAt?: number;
  failed: boolean;
  /** Playback clock in ticks (fractional). */
  playbackTick: number;
  /** Index of the next frame to stream. */
  sendIndex: number;
  speed: 1 | 2;
  paused: boolean;
  /** Wall time before which playback holds (reveal animation). */
  holdUntil: number;
  lastWall: number;
  pump?: NodeJS.Timeout;
  releasing: boolean;
  aborted: boolean;
  /** Last whole playback second a state push went out for. */
  lastSecond: number;
  /** Playback stalls ("thinking…": playback caught up with a sim that isn't done), for diagnostics. */
  stalls: number;
  stalledMs: number;
  stalling: boolean;
  startedAt: number;
}

/** Sim and playback numbers of the running or last battle (GET /admin/metrics, `npm run loadtest`, §14). */
export interface BattleMetrics {
  round: number;
  /** Players and placed units in the battle. */
  players: number;
  units: number;
  simDone: boolean;
  /** Completed sim ticks so far. */
  ticks: number;
  /**
   * Wall ms per sim tick (sandbox calls included). `p99Warm` leaves out the
   * first second (isolate JIT warm-up); `over8` counts ticks above the 8 ms budget.
   */
  tickMs: { p50: number; p99: number; p99Warm: number; max: number; mean: number; over8: number } | null;
  /** Wall time from START until the sim finished (null while running). */
  simWallMs: number | null;
  playback: { tick: number; speed: 1 | 2; paused: boolean; stalls: number; stalledMs: number };
}

/** Ticks left out of `p99Warm` (1 s of battle). */
const WARMUP_TICKS = 60;

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

export class BattleService {
  private active: ActiveBattle | undefined;
  private factory: RunnerFactory | undefined;
  /** The last released battle, for the replay endpoint. */
  private lastReplay: ReplayDTO | undefined;
  /** Metrics of the last battle that ended (kept after release, §14 load test). */
  private lastMetrics: BattleMetrics | undefined;

  constructor(private readonly game: Game) {}

  private runnerFactory(): RunnerFactory {
    if (this.game.options.runnerFactory) return this.game.options.runnerFactory;
    this.factory ??= createRunnerFactory(this.game.config.sandbox.mode, { unsafe: this.game.options.unsafe === true });
    return this.factory;
  }

  get revealed(): boolean {
    return this.active !== undefined && !this.active.aborted;
  }

  /** The reveal of the running battle (public after START). */
  currentReveal(): BattleRevealDTO | undefined {
    return this.active?.reveal;
  }

  /** The latest frame at or before the playback clock (for late joiners). */
  currentFrame(): FrameDTO | undefined {
    const a = this.active;
    if (!a) return undefined;
    return frameAt(a.frames, Math.floor(a.playbackTick));
  }

  /** Sim/playback metrics of the running battle, else of the last one (diagnostics). */
  metrics(): BattleMetrics | undefined {
    const a = this.active;
    return a ? this.metricsOf(a) : this.lastMetrics;
  }

  private metricsOf(a: ActiveBattle): BattleMetrics {
    const ticks = a.engine?.tickMs ?? [];
    const sorted = [...ticks].sort((x, y) => x - y);
    const sum = ticks.reduce((t, x) => t + x, 0);
    return {
      round: a.round,
      players: a.setup.length,
      units: a.setup.reduce((n, s) => n + s.placements.length, 0),
      simDone: a.simDone,
      ticks: ticks.length,
      tickMs: ticks.length
        ? {
            p50: percentile(sorted, 50),
            p99: percentile(sorted, 99),
            p99Warm: percentile([...ticks.slice(WARMUP_TICKS)].sort((x, y) => x - y), 99),
            max: sorted[sorted.length - 1]!,
            mean: sum / ticks.length,
            over8: ticks.filter((x) => x > 8).length,
          }
        : null,
      simWallMs: a.simDoneAt !== undefined ? a.simDoneAt - a.startedAt : null,
      playback: { tick: Math.floor(a.playbackTick), speed: a.speed, paused: a.paused, stalls: a.stalls, stalledMs: Math.round(a.stalledMs) },
    };
  }

  playback(): PlaybackDTO | undefined {
    const a = this.active;
    if (!a) return undefined;
    const last = a.frames[a.frames.length - 1];
    return {
      tick: Math.floor(a.playbackTick),
      speed: a.speed,
      paused: a.paused,
      thinking: !a.simDone && !a.failed && (!last || a.playbackTick >= last.t) && Date.now() >= a.holdUntil,
      totalTicks: this.game.config.timers.battleTicks,
    };
  }

  setPlayback(opts: { paused?: unknown; speed?: unknown }): PlaybackDTO | undefined {
    const a = this.active;
    if (!a) return undefined;
    if (typeof opts.paused === 'boolean') a.paused = opts.paused;
    if (opts.speed === 1 || opts.speed === 2) a.speed = opts.speed;
    this.game.notifier.stateChanged();
    return this.playback();
  }

  // -------------------------------------------------------------------------
  // Start
  // -------------------------------------------------------------------------

  /** Lock the battle in (phase is already BATTLE), reveal, start the sim and playback. */
  start(): void {
    const game = this.game;
    const m = game.store.match;
    const setup: SetupPlayer[] = [];
    for (const p of game.players.active()) {
      const zone = m.zones[p.id];
      if (!zone) continue;
      const rs = game.round.stateOf(p.id);
      const units: BattleUnitDesign[] = [];
      const runnerUnits: RunnerUnitDesign[] = [];
      const revealUnits: RevealedUnitDTO[] = [];
      const fielded: FieldedDesign[] = [];
      const borrowed: BorrowedUse[] = [];
      const borrowedNames = new Map<string, { displayName: string; creatorName: string }>();
      const used = new Set(rs.placements.map((pl) => pl.unitId));
      for (const l of rs.locked ?? []) {
        if (isArmoryUnitId(l.unitId)) {
          // A borrowed Armory unit (§9.1): the frozen copy runs in THIS player's sandbox.
          const e = game.armory.forUnitId(l.unitId);
          if (!e) continue;
          units.push({ unitId: l.unitId, stats: e.stats, cost: e.cost });
          // Its own sandbox, loaded under the creator's ids (§9.1 Source; see sandbox/splitRunner.ts).
          runnerUnits.push({
            unitId: l.unitId,
            compiledJs: e.compiledJs,
            stats: e.stats,
            borrowed: { sourceUnitId: e.sourceUnitId, creatorId: e.creatorId },
          });
          if (!used.has(l.unitId)) continue;
          const displayName = ArmoryService.displayName(e);
          borrowed.push({ borrowerId: p.id, armoryId: e.armoryId, creatorId: e.creatorId });
          borrowedNames.set(l.unitId, { displayName, creatorName: e.creatorName });
          revealUnits.push({
            unitId: l.unitId,
            name: displayName,
            stats: e.stats,
            cost: e.cost,
            ...game.armory.spriteOf(e),
            borrowedFrom: { armoryId: e.armoryId, creatorId: e.creatorId, creatorName: e.creatorName },
          });
          continue;
        }
        const v = game.units.versionOf(p.id, l.unitId, l.version);
        if (!v) continue;
        units.push({ unitId: l.unitId, stats: v.stats, cost: v.cost });
        runnerUnits.push({ unitId: l.unitId, compiledJs: v.compiledJs, stats: v.stats });
        // Only FIELDED types are revealed (§3 privacy).
        if (!used.has(l.unitId)) continue;
        const design = game.store.designsOf(p.id).get(l.unitId);
        const hidden = design?.spriteHidden ?? false;
        if (design && !design.isTemplate) {
          fielded.push({
            playerId: p.id,
            unitId: l.unitId,
            version: v.version,
            stats: v.stats,
            sprite: v.sprite,
            spriteHidden: hidden,
            compiledJs: v.compiledJs,
            cost: v.cost,
            breakdown: v.breakdown,
          });
        }
        revealUnits.push({
          unitId: l.unitId,
          name: v.stats.name,
          stats: v.stats,
          cost: v.cost,
          sprite: hidden ? null : v.sprite,
          spriteHidden: hidden,
        });
      }
      const known = new Set(units.map((u) => u.unitId));
      const placements = rs.placements.filter((pl) => known.has(pl.unitId));
      const teamId = game.teams.active ? game.teams.teamIdOf(p.id) : undefined;
      setup.push({
        playerId: p.id,
        seat: p.seat,
        zone,
        ...(teamId !== undefined ? { teamId } : {}),
        units,
        runnerUnits,
        revealUnits,
        placements,
        fielded,
        borrowed,
        borrowedNames,
      });
    }

    const layout = game.teams.currentLayout();
    const reveal: BattleRevealDTO = {
      round: m.round,
      totalTicks: game.config.timers.battleTicks,
      ...(layout ? { map: mapDTO(layout) } : {}),
      ...(game.teams.active ? { teams: game.teams.publicTeams() } : {}),
      players: setup.map((s) => ({
        playerId: s.playerId,
        name: game.store.players.get(s.playerId)?.name ?? '?',
        seat: s.seat,
        zone: legacyCornerOf(s.zone),
        mapZone: mapZoneDTO(s.zone),
        ...(s.teamId !== undefined ? { teamId: s.teamId } : {}),
        units: s.revealUnits,
        instances: buildInstances({ seat: s.seat, zone: s.zone, units: s.units, placements: s.placements }),
      })),
    };

    const now = Date.now();
    const a: ActiveBattle = {
      round: m.round,
      seed: randomInt(1, 2 ** 31 - 1),
      reveal,
      setup,
      frames: [],
      started: Promise.resolve(),
      simDone: false,
      failed: false,
      playbackTick: 0,
      sendIndex: 0,
      speed: 1,
      paused: false,
      holdUntil: now + (game.options.revealDelayMs ?? 3000),
      lastWall: now,
      releasing: false,
      aborted: false,
      lastSecond: 0,
      stalls: 0,
      stalledMs: 0,
      stalling: false,
      startedAt: now,
    };
    this.active = a;
    game.notifier.battleReveal(reveal);
    game.notifier.stateChanged();

    if (setup.length === 0) {
      // Nobody to fight: straight to an empty result.
      a.simDone = true;
      a.result = { endTick: 0, endReason: 'elimination', players: [], units: [], ranking: [] };
      const radius = scaleSuddenDeath(game.config.suddenDeath, layout?.width ?? 800).startRadius;
      a.frames.push({ t: 0, units: [], projectiles: [], safeZoneRadius: radius, events: [] });
    } else {
      a.started = this.launch(a);
    }
    a.pump = setInterval(() => this.pump(a), PUMP_MS);
    a.pump.unref?.();
  }

  private async launch(a: ActiveBattle): Promise<void> {
    const game = this.game;
    try {
      const runners = await createBattleRunners(
        this.runnerFactory(),
        a.setup.map((s) => ({ playerId: s.playerId, seat: s.seat, units: s.runnerUnits })),
        game.config,
        a.seed,
      );
      if (a.aborted) {
        for (const r of runners.values()) r.dispose();
        return;
      }
      const map = game.store.match.map;
      const engine = new BattleEngine({
        players: a.setup.map((s) => ({
          playerId: s.playerId,
          seat: s.seat,
          zone: s.zone,
          ...(s.teamId !== undefined ? { teamId: s.teamId } : {}),
          units: s.units,
          placements: s.placements,
          runner: runners.get(s.playerId)!,
        })),
        ...(map ? { map: { style: map.style, width: mapFor(map.style, map.players).width } } : {}),
        config: game.config,
        seed: a.seed,
      });
      a.engine = engine;
      a.frames = engine.frames;
      a.run = engine.run().then(
        (result) => {
          a.result = result;
          a.simDone = true;
          a.simDoneAt = Date.now();
          return result;
        },
        (err: unknown) => {
          this.fail(a, err);
          return undefined;
        },
      );
    } catch (err) {
      this.fail(a, err);
    }
  }

  private fail(a: ActiveBattle, err: unknown): void {
    if (a.aborted) return;
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`battle for round ${a.round} failed`, err);
    a.failed = true;
    this.stopPump(a);
    if (this.active === a) this.active = undefined;
    this.game.match.battleFailed(msg);
  }

  // -------------------------------------------------------------------------
  // Playback
  // -------------------------------------------------------------------------

  private stopPump(a: ActiveBattle): void {
    if (a.pump) clearInterval(a.pump);
    a.pump = undefined;
  }

  private pump(a: ActiveBattle): void {
    if (a !== this.active || a.releasing || a.failed) return;
    const now = Date.now();
    const dt = now - a.lastWall;
    a.lastWall = now;
    const last = a.frames[a.frames.length - 1];
    if (!a.paused && now >= a.holdUntil && last) {
      const tps = this.game.config.timers.ticksPerSecond;
      const rate = this.game.options.playbackRate ?? 1;
      a.playbackTick = Math.min(last.t, a.playbackTick + (dt * tps * a.speed * rate) / 1000);
    }
    // Playback waiting for the sim ("thinking…", §9 Decoupling).
    const stalled = !a.paused && !a.failed && now >= a.holdUntil && !a.simDone && (!last || a.playbackTick >= last.t);
    if (stalled) {
      if (!a.stalling) a.stalls++;
      a.stalledMs += dt;
    }
    a.stalling = stalled;
    this.sendFrames(a, Math.floor(a.playbackTick));
    // 1 Hz state pushes for the battle countdown (secondsLeft).
    const second = Math.floor(a.playbackTick / this.game.config.timers.ticksPerSecond);
    if (second !== a.lastSecond) {
      a.lastSecond = second;
      this.game.notifier.stateChanged();
    }
    if (a.simDone && last && a.playbackTick >= last.t) {
      void this.release(a, 'natural');
    }
  }

  /** Stream every not-yet-sent frame with t ≤ upTo. */
  private sendFrames(a: ActiveBattle, upTo: number): void {
    const batch: FrameDTO[] = [];
    while (a.sendIndex < a.frames.length && a.frames[a.sendIndex]!.t <= upTo) batch.push(a.frames[a.sendIndex++]!);
    const pb = this.playback();
    if (batch.length > 0 && pb) this.game.notifier.battleFrames(batch, pb);
  }

  // -------------------------------------------------------------------------
  // End
  // -------------------------------------------------------------------------

  /** Admin Skip: end at the current playback tick and rank from that frame (§9 Skip). */
  async skip(): Promise<void> {
    const a = this.active;
    if (!a || a.releasing) return;
    await this.release(a, 'skip');
  }

  private async release(a: ActiveBattle, kind: 'natural' | 'skip'): Promise<void> {
    if (a.releasing) return;
    a.releasing = true;
    this.stopPump(a);
    const game = this.game;
    const scoring = game.config.scoring;

    let skipTick: number | undefined;
    if (kind === 'skip') {
      skipTick = Math.floor(a.playbackTick);
      await a.started;
      a.engine?.stop();
      if (a.run) await a.run;
    }
    if (a.aborted || a.failed || this.active !== a) return;
    const result = a.result;
    if (!result) {
      this.fail(a, new Error('the battle ended without a result'));
      return;
    }
    // Read the kicks after the Skip awaits (an admin may kick meanwhile): no
    // await follows, so ranking, scoring and battleReleased's scoreboard all
    // see the same set (§9 Skip / kick).
    const kicked = new Set(game.store.match.pendingKicks);

    let placings;
    let endTick: number;
    let reason: BattleEndDTO['reason'];
    if (kind === 'skip' && a.frames.length > 0) {
      const frame = frameAt(a.frames, skipTick!) ?? a.frames[0]!;
      endTick = frame.t;
      placings = rankAtPlaybackTick(a.frames, endTick, result, kicked);
      reason = 'skipped';
    } else {
      endTick = result.endTick;
      placings = rankResult(result, kicked);
      reason = result.endReason === 'elimination' ? 'elimination' : 'timeout';
    }
    // Show everything up to the final frame before the result.
    this.sendFrames(a, endTick);

    // Skip: rank, score and report from what was shown (the sim may have run
    // far ahead): counters and living units at the playback tick, §9.
    const shown = kind === 'skip' ? frameAt(a.frames, endTick) : undefined;
    const reported =
      shown && a.engine ? resultAtTick(result, a.engine.countersAt(endTick), new Set(shown.units.map((u) => u[0])), endTick) : result;
    // Kicked players are not in `placings`: no points or badges (§9 Skip / kick).
    const ranking = scoreRanking(placings, playerMetrics(reported), scoring);
    // 💡 Inventor (§9.1, no points): creators whose Armory units others fielded.
    const inventors = game.armory.enabled ? game.armory.inventors(a.setup.flatMap((s) => s.borrowed), kicked) : [];
    for (const inv of inventors) {
      const entry = ranking.find((r) => r.playerId === inv.playerId);
      if (entry) {
        entry.badges.push('inventor');
        entry.inventorUsedBy = inv.usedBy;
      } else {
        // Not in this battle (e.g. joined for the next round): the badge still counts.
        const badges = (game.store.match.badges[inv.playerId] ??= {});
        badges.inventor = (badges.inventor ?? 0) + 1;
      }
    }
    const reports: Record<string, BattleReportDTO> = {};
    const unitSummaries: Record<string, Record<string, UnitBattleSummaryDTO>> = {};
    for (const s of a.setup) {
      const report = buildBattleReport(reported, s.playerId, a.round, ranking);
      // Borrowed units are named "Ogre (Ninja Sam)" and marked "borrowed from" (§9.1).
      for (const e of report.errors) {
        const b = s.borrowedNames.get(e.unitId);
        if (!b) continue;
        e.unitName = b.displayName;
        e.borrowedFrom = b.creatorName;
      }
      reports[s.playerId] = report;
      const sums: Record<string, UnitBattleSummaryDTO> = {};
      for (const u of reported.units) {
        if (u.playerId !== s.playerId) continue;
        const sum = (sums[u.unitId] ??= {
          round: a.round,
          name: s.borrowedNames.get(u.unitId)?.displayName ?? s.units.find((d) => d.unitId === u.unitId)?.stats.name ?? u.unitId,
          survived: 0,
          fielded: 0,
          damageDealt: 0,
          kills: 0,
          valueDestroyed: 0,
          strikes: 0,
          disabled: 0,
        });
        sum.fielded++;
        if (u.survived) sum.survived++;
        sum.damageDealt += u.damageDealt;
        sum.kills += u.kills;
        sum.valueDestroyed += u.valueDestroyed;
        sum.strikes += u.strikes;
        if (u.disabled) sum.disabled++;
      }
      unitSummaries[s.playerId] = sums;
    }

    this.lastMetrics = this.metricsOf(a);
    const end: BattleEndDTO = { round: a.round, endTick, reason, ranking, scoreboard: [] };
    if (inventors.length > 0) end.inventors = inventors;
    end.topUnits = topUnits({ reveal: a.reveal, summaries: unitSummaries, kicked, shown: scoring.topUnitsShown });
    const record: RoundResultRecord = { round: a.round, end, reports, unitSummaries };
    this.active = undefined;
    // The fielded types enter the Open Armory now that the result is public (§9.1).
    game.armory.addFielded(a.round, a.setup.flatMap((s) => s.fielded));
    game.match.battleReleased(record); // adds points and fills end.scoreboard
    const replay: ReplayDTO = { round: a.round, reveal: a.reveal, frames: a.frames.filter((f) => f.t <= endTick), end };
    this.lastReplay = replay;
    game.store.writeReplay(replay);
    game.notifier.battleEnd(end);
    log.info(`round ${a.round} battle released (${reason} at tick ${endTick})`);
  }

  /** Stop without releasing (shutdown, new match). */
  async abort(): Promise<void> {
    const a = this.active;
    if (!a) return;
    a.aborted = true;
    this.active = undefined;
    this.stopPump(a);
    a.engine?.stop();
    await a.started.catch(() => undefined);
    a.engine?.stop();
    if (a.run) await a.run.catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // Reports and replays (released battles only)
  // -------------------------------------------------------------------------

  /** A released round of the current match, or undefined. */
  private released(round: number): RoundResultRecord | undefined {
    return this.game.store.match.results.find((r) => r.round === round);
  }

  /** `round` = undefined → latest released. */
  report(playerId: string, round?: number): BattleReportDTO | { stillPlaying: number } | undefined {
    const m = this.game.store.match;
    // While a battle plays back, "latest" means that battle: it isn't ready yet.
    if (m.phase === 'BATTLE' && (round === undefined || round === m.round)) return { stillPlaying: m.round };
    const target = round ?? m.results[m.results.length - 1]?.round;
    if (target === undefined) return undefined;
    const rec = this.released(target);
    const own = rec?.reports[playerId];
    return own ? { ...own, topUnits: rec!.end.topUnits ?? [] } : undefined;
  }

  /** The public result of a released round of the current match (ranking, points, top units). */
  results(round: number): BattleEndDTO | { stillPlaying: number } | undefined {
    const m = this.game.store.match;
    if (m.phase === 'BATTLE' && m.round === round) return { stillPlaying: round };
    return this.released(round)?.end;
  }

  replay(round: number): ReplayDTO | { stillPlaying: number } | undefined {
    const m = this.game.store.match;
    if (m.phase === 'BATTLE' && m.round === round) return { stillPlaying: round };
    // Only rounds released in this match (a new match starts over at round 1:
    // an older data/replays/round-N.json is not this match's).
    if (!this.released(round)) return undefined;
    if (this.lastReplay?.round === round) return this.lastReplay;
    return this.game.store.readReplay(round) ?? undefined;
  }
}
