// The projector's data layer (plan §12.2): one GameSocket in the 'screen' role,
// the shared ArenaRenderer, and a tiny observable snapshot the Preact view
// renders from. Owns the battle lifecycle: neutral empty zones before START,
// the "3-2-1 CLASH!" reveal with a delayed drop-in, live frames, the
// sudden-death banner, napping toasts and the RESULTS replay.

import {
  CORNERS,
  type BattleEndDTO,
  type BattleRevealDTO,
  type FrameDTO,
  type GameStateDTO,
  type JoinInfoDTO,
  type PlaybackDTO,
  type Phase,
} from '@pixel-clash/shared';
import { api, request } from '../common/api.js';
import { ArenaRenderer } from '../common/render/arena.js';
import { GameSocket, type WsStatus } from '../common/ws.js';
import { REVEAL_DROP_AT_MS, REVEAL_TOTAL_MS } from './model.js';

export interface ScreenToast {
  id: number;
  text: string;
  seat: number;
  level: 'info' | 'warn' | 'error' | 'nap';
  at: number;
}

export interface ReplayView {
  round: number;
  speed: 1 | 2;
  paused: boolean;
  loading: boolean;
  /** true while the replay runs (false once it reached the end or for the static final frame). */
  playing: boolean;
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
  /** performance.now() when sudden death began on screen (banner), or null. */
  suddenDeathAt: number | null;
}

const PRE_BATTLE: readonly Phase[] = ['LOBBY', 'PLAN', 'PLACEMENT'];
const TOAST_MS = 4500;

export class ScreenController {
  readonly arena: ArenaRenderer;
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
    suddenDeathTick: 3600,
    ticksPerSecond: 60,
    suddenDeathAt: null,
  };
  private readonly listeners = new Set<() => void>();
  private pendingFrames: FrameDTO[] | null = null;
  private dropTimer: ReturnType<typeof setTimeout> | null = null;
  private toastSeq = 0;
  private lastPhase: Phase | null = null;
  private sdWatch: ReturnType<typeof setInterval> | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.arena = new ArenaRenderer(canvas, {
      fit: { margin: 16 },
      onEvent: (ev, arena) => {
        if (ev.type !== 'disable') return;
        const info = arena.instance(ev.instanceId);
        if (!info) return;
        this.toast(`💤 ${info.name} is napping`, 'nap', info.seat);
      },
    });
    this.neutralZones();
    this.arena.start();

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

    void this.loadRules();
    void this.loadJoin();
    this.sdWatch = setInterval(() => this.watchSuddenDeath(), 100);
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
      this.set({
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
    const patch: Partial<ScreenSnapshot> = { state, stateAt: performance.now() };
    if (state.battle) patch.playback = state.battle;
    if (changed && PRE_BATTLE.includes(phase)) {
      // Back to an empty arena: no unit data at all before START (§3).
      this.cancelPendingReveal();
      this.arena.clearBattle();
      this.neutralZones();
      Object.assign(patch, { reveal: null, revealAt: null, end: null, replay: null, playback: null, suddenDeathAt: null });
      if (phase !== 'PLACEMENT') void this.loadJoin();
    }
    if (state.lastBattle && !this.snap.end) patch.end = state.lastBattle;
    this.set(patch);
    // A reload during RESULTS: show the final frame of the last battle.
    if (changed && (phase === 'RESULTS' || phase === 'MATCH_RESULTS') && this.arena.instanceIds.length === 0 && state.lastBattle) {
      void this.loadReplay(state.lastBattle.round, { atEnd: true });
    }
  }

  private onReveal(reveal: BattleRevealDTO): void {
    this.cancelPendingReveal();
    this.set({ reveal, end: null, replay: null, suddenDeathAt: null });
    const midBattle = (this.snap.state?.battle?.tick ?? 0) > 0;
    if (midBattle) {
      this.arena.setReveal(reveal);
      this.set({ revealAt: null });
      return;
    }
    // "3-2-1 CLASH!": units drop in on the last count, frames follow (~3 s).
    this.pendingFrames = [];
    this.set({ revealAt: performance.now() });
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

  private neutralZones(): void {
    // Zone assignment is private until START, so all four bases are neutral.
    this.arena.setZones(CORNERS.map((corner) => ({ corner, seat: -1 })));
  }

  // -------------------------------------------------------------------------
  // Sudden death and toasts
  // -------------------------------------------------------------------------

  private watchSuddenDeath(): void {
    const s = this.snap;
    const live = s.state?.phase === 'BATTLE' && !s.replay;
    if (!live || s.suddenDeathAt !== null || this.arena.instanceIds.length === 0) return;
    if (this.arena.tick >= s.suddenDeathTick) this.set({ suddenDeathAt: performance.now() });
  }

  toast(text: string, level: ScreenToast['level'], seat: number): void {
    const t: ScreenToast = { id: ++this.toastSeq, text, level, seat, at: performance.now() };
    this.set({ toasts: [...this.snap.toasts, t].slice(-5) });
    setTimeout(() => this.set({ toasts: this.snap.toasts.filter((x) => x.id !== t.id) }), TOAST_MS);
  }

  // -------------------------------------------------------------------------
  // Replay (RESULTS / MATCH_RESULTS)
  // -------------------------------------------------------------------------

  async loadReplay(round: number, opts: { atEnd?: boolean; speed?: 1 | 2 } = {}): Promise<void> {
    const speed = opts.speed ?? this.snap.replay?.speed ?? 1;
    this.set({ replay: { round, speed, paused: false, loading: true, playing: false } });
    try {
      const replay = await api.replay(round);
      if (!this.snap.replay || this.snap.replay.round !== round) return;
      this.set({ reveal: replay.reveal });
      this.arena.loadReplay(replay);
      this.arena.setPlayback({ speed });
      if (opts.atEnd) {
        this.arena.seek(replay.end.endTick);
        this.arena.setPlayback({ paused: true });
      }
      this.set({ replay: { round, speed, paused: !!opts.atEnd, loading: false, playing: !opts.atEnd } });
    } catch {
      this.set({ replay: null });
      if (!opts.atEnd) this.toast("Couldn't load the replay.", 'warn', -1);
    }
  }

  /** The Replay button: play the last battle from the start. */
  playReplay(): void {
    const round = this.snap.state?.lastBattle?.round ?? this.snap.end?.round;
    if (round) void this.loadReplay(round, { speed: this.snap.replay?.speed ?? 1 });
  }

  setReplaySpeed(speed: 1 | 2): void {
    this.arena.setPlayback({ speed });
    if (this.snap.replay) this.set({ replay: { ...this.snap.replay, speed } });
  }

  toggleReplayPause(): void {
    const r = this.snap.replay;
    if (!r || r.loading) return;
    if (r.paused && this.arena.tick >= this.arena.endTick - 1) {
      this.playReplay();
      return;
    }
    this.arena.setPlayback({ paused: !r.paused });
    this.set({ replay: { ...r, paused: !r.paused } });
  }

  /** Mark the replay finished once the clock reaches the end (polled by the view). */
  syncReplay(): void {
    const r = this.snap.replay;
    if (r && r.playing && !r.loading && this.arena.tick >= this.arena.endTick - 0.5) {
      this.arena.setPlayback({ paused: true });
      this.set({ replay: { ...r, playing: false, paused: true } });
    }
  }
}
