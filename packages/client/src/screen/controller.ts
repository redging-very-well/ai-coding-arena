// The projector's data layer (plan §12.2): one GameSocket in the 'screen' role,
// the shared ArenaRenderer, and a tiny observable snapshot the Preact view
// renders from. Owns the battle lifecycle: neutral empty zones before START,
// the "3-2-1 CLASH!" reveal with a delayed drop-in, live frames, the
// sudden-death banner, napping toasts and the RESULTS replay (replay.ts),
// the synthesized sounds (§12.4) and the join poster. The facilitator can
// drive the replay and the poster from /admin ('screen' WS commands).

import {
  CORNERS,
  MAX_PLAYERS,
  type BattleEndDTO,
  type MapDTO,
  type BattleRevealDTO,
  type FrameDTO,
  type FrameEvent,
  type GameStateDTO,
  type JoinInfoDTO,
  type PlaybackDTO,
  type Phase,
  type ScreenCommandDTO,
  type SetupInfoDTO,
} from '@pixel-clash/shared';
import { api, request } from '../common/api.js';
import { SoundEngine, type AudioState } from '../common/audio.js';
import { ArenaRenderer, bodyOf } from '../common/render/arena.js';
import { isBigHit } from '../common/render/fx.js';
import { MUTE_KEY_SCREEN, countdownCue, revealCue, shotPitch } from '../common/sfx.js';
import { GameSocket, type WsStatus } from '../common/ws.js';
import { getSetupInfo } from '../setup/setupApi.js';
import {
  REVEAL_DROP_AT_MS,
  REVEAL_STEPS,
  REVEAL_STEP_MS,
  REVEAL_TOTAL_MS,
  resultsBadgePops,
  battleSecondsLeft,
  liveSecondsLeft,
  newlyDone,
  becameAllReady,
  rankRows,
} from './model.js';
import { ReplayController, type ReplayView } from './replay.js';

export type { ReplayView } from './replay.js';

export interface ScreenToast {
  id: number;
  text: string;
  seat: number;
  level: 'info' | 'warn' | 'error' | 'nap';
  at: number;
}

export interface ScreenSnapshot {
  conn: WsStatus;
  state: GameStateDTO | null;
  /** performance.now() when `state` arrived (local timer interpolation). */
  stateAt: number;
  reveal: BattleRevealDTO | null;
  /** performance.now() of the START reveal (overlay), or null. */
  revealAt: number | null;
  playback: PlaybackDTO | null;
  end: BattleEndDTO | null;
  join: JoinInfoDTO | null;
  toasts: ScreenToast[];
  replay: ReplayView | null;
  suddenDeathTick: number;
  ticksPerSecond: number;
  /** Live seat limit from GET /rules (config.match.maxPlayers); the join card hides at it. */
  maxPlayers: number;
  /** performance.now() when sudden death began on screen (banner), or null. */
  suddenDeathAt: number | null;
  /** The full-screen join poster is up. */
  poster: boolean;
  /** Seat terminal links for the poster (GET /api/setup), once loaded. */
  setup: SetupInfoDTO | null;
  /** Sound: muted flag (remembered) and whether the browser let audio start yet. */
  muted: boolean;
  audio: AudioState;
}

const PRE_BATTLE: readonly Phase[] = ['LOBBY', 'PLAN', 'PLACEMENT'];
const TOAST_MS = 4500;

/** prefers-reduced-motion (no shake or bob, fewer particles; CSS handles the rest). */
export function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export class ScreenController {
  readonly arena: ArenaRenderer;
  /** Projector sound: on by default, unlocked by the first click or key. */
  readonly sound = new SoundEngine(MUTE_KEY_SCREEN, false);
  readonly replays: ReplayController;
  private readonly sock: GameSocket;
  private snap: ScreenSnapshot = {
    conn: 'connecting',
    state: null,
    stateAt: 0,
    reveal: null,
    revealAt: null,
    playback: null,
    end: null,
    join: null,
    toasts: [],
    replay: null,
    suddenDeathTick: 3000,
    ticksPerSecond: 60,
    maxPlayers: MAX_PLAYERS,
    suddenDeathAt: null,
    poster: false,
    setup: null,
    muted: false,
    audio: 'locked',
  };
  private readonly listeners = new Set<() => void>();
  private pendingFrames: FrameDTO[] | null = null;
  private dropTimer: ReturnType<typeof setTimeout> | null = null;
  private toastSeq = 0;
  private lastPhase: Phase | null = null;
  /** The map last drawn empty (style, players), to redraw when it changes before START. */
  private neutralKey = '';
  private sdWatch: ReturnType<typeof setInterval> | null = null;
  /** Last countdown reading (phase + seconds), for the last-5-seconds beeps. */
  private lastCount: { key: string; secs: number | null } = { key: '', secs: null };
  private readonly offUnlock: () => void;

  constructor(canvas: HTMLCanvasElement) {
    this.arena = new ArenaRenderer(canvas, {
      fit: { margin: 16 },
      fx: true,
      reducedMotion: prefersReducedMotion(),
      onEvent: (ev, arena) => {
        this.eventSound(ev, arena);
        if (ev.type !== 'disable') return;
        const info = arena.instance(ev.instanceId);
        if (!info) return;
        this.toast(`💤 ${info.name} is taking a nap`, 'nap', info.seat);
      },
    });
    this.neutralZones();
    this.arena.start();

    const arena = this.arena;
    this.replays = new ReplayController({
      target: {
        get tick() {
          return arena.tick;
        },
        get endTick() {
          return arena.endTick;
        },
        get startTick() {
          return arena.buffer.firstT;
        },
        loadReplay: (r) => arena.loadReplay(r),
        setPlayback: (p) => arena.setPlayback(p),
        seek: (t) => arena.seek(t),
      },
      fetch: (round) => api.replay(round),
      onChange: (replay) => this.set({ replay }),
      onLoaded: (replay) => {
        this.watchedSuddenDeath = false;
        this.set({ reveal: replay.reveal, suddenDeathAt: null });
      },
      onError: () => this.toast("Couldn't load the replay.", 'warn', -1),
    });

    this.set({ muted: this.sound.muted, audio: this.sound.state });
    this.sound.subscribe(() => this.set({ muted: this.sound.muted, audio: this.sound.state }));
    this.offUnlock = this.sound.installUnlock();

    this.sock = new GameSocket('screen');
    this.sock.onStatus((conn) => this.set({ conn }));
    this.sock.on('state', (m) => this.onState(m.state));
    this.sock.on('battle:reveal', (m) => this.onReveal(m.data));
    this.sock.on('battle:frames', (m) => this.onFrames(m.frames, m.playback));
    this.sock.on('battle:end', (m) => {
      this.arena.setEnd(m.data.endTick);
      this.set({ end: m.data });
    });
    this.sock.on('toast', (m) => this.toast(m.message, m.level, -1));
    this.sock.on('screen', (m) => this.onCommand(m.command));

    void this.loadRules();
    void this.loadJoin();
    this.sdWatch = setInterval(() => this.watch(), 100);
  }

  // -------------------------------------------------------------------------
  // Store
  // -------------------------------------------------------------------------

  get snapshot(): ScreenSnapshot {
    return this.snap;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<ScreenSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.listeners) fn();
  }

  destroy(): void {
    this.sock.close();
    this.arena.stop();
    this.offUnlock();
    if (this.dropTimer) clearTimeout(this.dropTimer);
    if (this.sdWatch) clearInterval(this.sdWatch);
  }

  // -------------------------------------------------------------------------
  // Server data
  // -------------------------------------------------------------------------

  private async loadRules(): Promise<void> {
    try {
      const rules = await api.rules();
      const sd = rules.suddenDeath as { startTick?: unknown };
      const tps = rules.timers.ticksPerSecond;
      const max = rules.maxPlayers;
      this.set({
        ...(typeof max === 'number' && max >= 1 ? { maxPlayers: Math.min(max, MAX_PLAYERS) } : {}),
        ...(typeof sd.startTick === 'number' ? { suddenDeathTick: sd.startTick } : {}),
        ...(typeof tps === 'number' && tps > 0 ? { ticksPerSecond: tps } : {}),
      });
    } catch {
      // defaults are fine
    }
  }

  async loadJoin(): Promise<void> {
    try {
      this.set({ join: await request<JoinInfoDTO>('GET', '/join') });
    } catch {
      // Older server or offline: show the page's own address (no QR).
      if (!this.snap.join) this.set({ join: { joinUrl: `${location.origin}/play`, lanUrls: [], qrSvg: '' } });
    }
  }

  private onState(state: GameStateDTO): void {
    const phase = state.phase;
    const changed = phase !== this.lastPhase;
    this.lastPhase = phase;
    const prevState = this.snap.state;
    const patch: Partial<ScreenSnapshot> = { state, stateAt: performance.now() };
    if (state.battle) patch.playback = state.battle;
    if (changed && PRE_BATTLE.includes(phase)) {
      // Back to an empty arena: no unit data at all before START (§3).
      this.cancelPendingReveal();
      this.arena.clearBattle();
      this.neutralKey = '';
      this.neutralZones(state.match?.map ?? null);
      this.replays.clear();
      Object.assign(patch, { reveal: null, revealAt: null, end: null, playback: null, suddenDeathAt: null });
      if (phase !== 'PLACEMENT') void this.loadJoin();
      // The host may have changed quick settings (seat limit, sudden death) since.
      void this.loadRules();
    } else if (PRE_BATTLE.includes(phase)) {
      // Someone joined or left: re-read the seat limit in case the host lowered it.
      if (state.players.length !== this.snap.state?.players.length) void this.loadRules();
      // The map grows or changes style as players join or leave (§9.2).
      this.neutralZones(state.match?.map ?? null);
    }
    if (state.lastBattle && !this.snap.end) patch.end = state.lastBattle;
    this.set(patch);
    this.stateSounds(prevState, state, changed);
    // Next to MATCH_RESULTS during a replay: jump to its end so the podium shows at once.
    if (changed && phase === 'MATCH_RESULTS') this.replays.finish();
    // A reload during RESULTS: show the final frame of the last battle.
    if (changed && (phase === 'RESULTS' || phase === 'MATCH_RESULTS') && this.arena.instanceIds.length === 0 && state.lastBattle) {
      void this.replays.load(state.lastBattle.round, { atEnd: true });
    }
  }

  // -------------------------------------------------------------------------
  // Sounds (§12.4)
  // -------------------------------------------------------------------------

  /** Ready chimes, status blips, the results jingle and badge pops. */
  private stateSounds(prev: GameStateDTO | null, state: GameStateDTO, changed: boolean): void {
    if (!prev) return; // first state after (re)connect: nothing "happened"
    if (!changed) {
      const done = newlyDone(prev.players, state.players, state.phase);
      if (becameAllReady(prev, state)) this.sound.play('allReady', { delayMs: done.ready > 0 ? 350 : 0 });
      if (done.ready > 0) this.sound.play('ready');
      else if (done.ticks > 0) this.sound.play('place');
      return;
    }
    if (state.phase === 'MATCH_RESULTS') this.sound.play('victory');
    if (state.phase === 'RESULTS' && state.lastBattle) {
      this.sound.play('victory', { gain: 0.7 });
      const teamMode = (state.lastBattle.teams?.length ?? 0) > 0;
      for (const delayMs of resultsBadgePops(rankRows(state), { teamMode, reducedMotion: prefersReducedMotion() })) {
        this.sound.play('badge', { delayMs });
      }
    }
  }

  /** Battle sounds: shots pitched by unit type and range, hits, big hits, deaths. */
  private eventSound(ev: FrameEvent, arena: ArenaRenderer): void {
    switch (ev.type) {
      case 'fire': {
        const info = arena.instance(ev.instanceId);
        if (ev.melee) this.sound.play('swing');
        else this.sound.play('shoot', { pitch: info ? shotPitch(info.stats) : 440 });
        break;
      }
      case 'hit': {
        // M8.8: burn ticks, splash and zap hits are silent (the zap and the main hit already sound).
        if (ev.kind === 'burn' || ev.kind === 'splash' || ev.kind === 'zap') break;
        const target = arena.instance(ev.targetId);
        if (target && bodyOf(target) === 'wall') this.sound.play('wallHit');
        else this.sound.play(target && isBigHit(ev.damage, target.stats.maxHealth) ? 'bigHit' : 'hit');
        break;
      }
      case 'death': {
        const target = arena.instance(ev.instanceId);
        this.sound.play(target && bodyOf(target) === 'wall' ? 'crumble' : 'death');
        break;
      }
      case 'crumble':
        this.sound.play('crumble');
        break;
      case 'spawn':
        if (ev.factoryId) this.sound.play('spawn');
        break;
      case 'release':
        this.sound.play('release');
        break;
      case 'arc':
        this.sound.play('zap');
        break;
      case 'shatter':
        this.sound.play('shatter');
        break;
      case 'heal':
        this.sound.play('heal');
        break;
      default:
        break;
    }
  }

  /** The countdown beeps: the last 5 seconds of PLAN/PLACEMENT timers and of a live battle. */
  private watchCountdown(): void {
    const s = this.snap;
    const st = s.state;
    let key = '';
    let secs: number | null = null;
    if (st && (st.phase === 'PLAN' || st.phase === 'PLACEMENT')) {
      key = `${st.phase}:${st.round}`;
      secs = liveSecondsLeft(st.timer.secondsLeft, s.stateAt, st.timer.paused, performance.now());
    } else if (st?.phase === 'BATTLE' && !s.replay && this.arena.instanceIds.length > 0 && s.revealAt === null) {
      const total = s.playback?.totalTicks ?? s.reveal?.totalTicks ?? 0;
      key = `BATTLE:${st.round}`;
      secs = total ? battleSecondsLeft(this.arena.tick, total, s.ticksPerSecond) : null;
    }
    const prev = this.lastCount.key === key ? this.lastCount.secs : null;
    this.lastCount = { key, secs };
    const cue = countdownCue(prev, secs);
    if (cue) this.sound.play(cue.sfx, { force: true });
  }

  setMuted(muted: boolean): void {
    this.sound.setMuted(muted);
  }

  toggleMuted(): void {
    this.sound.toggleMuted();
  }

  // -------------------------------------------------------------------------
  // Join poster and the /admin remote
  // -------------------------------------------------------------------------

  /** Show, hide or (no argument) toggle the full-screen join poster. */
  setPoster(show?: boolean): void {
    const next = show ?? !this.snap.poster;
    if (next === this.snap.poster) return;
    this.set({ poster: next });
    if (next) {
      void this.loadJoin();
      void getSetupInfo().then(
        (setup) => this.set({ setup }),
        () => undefined,
      );
    }
  }

  private onCommand(cmd: ScreenCommandDTO): void {
    switch (cmd.action) {
      case 'poster':
        this.setPoster(cmd.show);
        break;
      case 'replay':
        this.setPoster(false);
        if (cmd.speed) this.setReplaySpeed(cmd.speed);
        this.playReplay(cmd.speed);
        break;
      case 'replaySpeed':
        this.setReplaySpeed(cmd.speed);
        break;
      case 'replayPause':
        this.toggleReplayPause();
        break;
    }
  }

  private onReveal(reveal: BattleRevealDTO): void {
    this.cancelPendingReveal();
    this.set({ reveal, end: null, suddenDeathAt: null });
    this.replays.clear();
    this.watchedSuddenDeath = false;
    const midBattle = (this.snap.state?.battle?.tick ?? 0) > 0;
    if (midBattle) {
      this.arena.setReveal(reveal);
      this.set({ revealAt: null });
      return;
    }
    // "3-2-1 CLASH!": units drop in on the last count, frames follow (~3 s).
    this.pendingFrames = [];
    this.set({ revealAt: performance.now() });
    // 3 · 2 · 1 beeps and the CLASH! hit, on the audio clock in step with the overlay.
    REVEAL_STEPS.forEach((step, i) => {
      const sfx = revealCue(step);
      if (sfx) this.sound.play(sfx, { delayMs: i * REVEAL_STEP_MS, force: true });
    });
    // Build the floor and bake the sprites now, not on the drop-in frame.
    this.arena.prewarm(reveal);
    this.dropTimer = setTimeout(() => this.applyReveal(), REVEAL_DROP_AT_MS);
    setTimeout(() => {
      if (this.snap.revealAt !== null && performance.now() - this.snap.revealAt >= REVEAL_TOTAL_MS - 5) this.set({ revealAt: null });
    }, REVEAL_TOTAL_MS);
  }

  private applyReveal(): void {
    this.dropTimer = null;
    const reveal = this.snap.reveal;
    const queued = this.pendingFrames;
    this.pendingFrames = null;
    if (!reveal) return;
    this.arena.setReveal(reveal);
    if (queued?.length) this.arena.pushFrames(queued, this.snap.playback ?? undefined);
  }

  private cancelPendingReveal(): void {
    if (this.dropTimer) clearTimeout(this.dropTimer);
    this.dropTimer = null;
    this.pendingFrames = null;
  }

  private onFrames(frames: FrameDTO[], playback: PlaybackDTO): void {
    this.set({ playback });
    if (this.snap.replay) return; // a replay owns the arena; live frames don't exist outside BATTLE anyway
    if (this.pendingFrames) {
      this.pendingFrames.push(...frames);
      // Frames well into the battle: we joined late, skip the show.
      if (frames.some((f) => f.t > 60)) {
        this.applyRevealNow();
      }
      return;
    }
    this.arena.pushFrames(frames, playback);
  }

  private applyRevealNow(): void {
    if (this.dropTimer) clearTimeout(this.dropTimer);
    this.applyReveal();
    this.set({ revealAt: null });
  }

  /**
   * The current map's empty zone outlines, zoomed to fit (§12.2). Zone
   * assignment is private until START, so every base is neutral. Without a
   * map (an older server) the four corners are shown.
   */
  private neutralZones(map: MapDTO | null = null): void {
    const key = map ? `${map.style}:${map.players}` : '-';
    if (key === this.neutralKey) return;
    this.neutralKey = key;
    this.arena.setMap(map);
    this.arena.setZones(map ? map.zones.map((z) => ({ rect: z, seat: -1 })) : CORNERS.map((corner) => ({ corner, seat: -1 })));
  }

  // -------------------------------------------------------------------------
  // Sudden death and toasts
  // -------------------------------------------------------------------------

  /** Polled every 100 ms: sudden death, countdown beeps, replay end. */
  private watch(): void {
    this.watchSuddenDeath();
    this.watchCountdown();
    this.replays.sync();
  }

  /** Set once per battle (or replay) so a banner that timed out doesn't come back. */
  private watchedSuddenDeath = false;

  private watchSuddenDeath(): void {
    const s = this.snap;
    const live = (s.state?.phase === 'BATTLE' && !s.replay) || !!(s.replay?.playing && !s.replay.paused);
    if (!live || this.watchedSuddenDeath || s.suddenDeathAt !== null || this.arena.instanceIds.length === 0) return;
    if (this.arena.tick >= s.suddenDeathTick && this.arena.tick < this.arena.endTick - 1) {
      this.watchedSuddenDeath = true;
      this.set({ suddenDeathAt: performance.now() });
      this.sound.play('siren', { force: true });
    }
  }

  toast(text: string, level: ScreenToast['level'], seat: number): void {
    const t: ScreenToast = { id: ++this.toastSeq, text, level, seat, at: performance.now() };
    this.set({ toasts: [...this.snap.toasts, t].slice(-5) });
    setTimeout(() => this.set({ toasts: this.snap.toasts.filter((x) => x.id !== t.id) }), TOAST_MS);
  }

  // -------------------------------------------------------------------------
  // Replay (RESULTS / MATCH_RESULTS)
  // -------------------------------------------------------------------------

  /** The Replay button / R key / admin remote: play the last battle from the start. */
  playReplay(speed?: 1 | 2): void {
    const round = this.snap.state?.lastBattle?.round ?? this.snap.end?.round;
    if (speed) this.replays.setSpeed(speed);
    void this.replays.play(round);
  }

  setReplaySpeed(speed: 1 | 2): void {
    this.replays.setSpeed(speed);
  }

  toggleReplayPause(): void {
    this.replays.togglePause();
  }

  /** Progress-bar click: jump to that point of the replay. */
  seekReplay(fraction: number): void {
    this.replays.seekFraction(fraction);
  }

  /** 0..1 through the replay (progress bar). */
  replayProgress(): number {
    return this.replays.progress();
  }

  /** Mark the replay finished once the clock reaches the end (polled by the view). */
  syncReplay(): void {
    this.replays.sync();
  }
}
