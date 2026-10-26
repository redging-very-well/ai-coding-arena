// The RESULTS replay on the projector: load the stored
// frames of the last battle, play them at 1x/2x, pause, restart at the end,
// report progress for the progress bar and seek (scrubbing). DOM-free: the
// arena and the fetch are passed in, so tests drive it with fakes.

import type { ReplayDTO } from '@pixel-clash/shared';

/** What the controller needs from the arena renderer. */
export interface ReplayTarget {
  /** Current playback tick (fractional). */
  readonly tick: number;
  /** The battle's final tick. */
  readonly endTick: number;
  /** The first stored frame's tick. */
  readonly startTick: number;
  loadReplay(replay: ReplayDTO): void;
  setPlayback(p: { speed?: 1 | 2; paused?: boolean }): void;
  seek(tick: number): void;
}

export interface ReplayView {
  round: number;
  speed: 1 | 2;
  paused: boolean;
  loading: boolean;
  /** true while the replay runs (false once it reached the end or for the static final frame). */
  playing: boolean;
}

export interface ReplayDeps {
  target: ReplayTarget;
  fetch: (round: number) => Promise<ReplayDTO>;
  /** The view changed (null: no replay). */
  onChange: (view: ReplayView | null) => void;
  /** The replay data arrived and is on the arena (e.g. to show its reveal). */
  onLoaded?: (replay: ReplayDTO) => void;
  /** Loading failed (not called for a quiet `atEnd` load). */
  onError?: (err: unknown) => void;
}

/** Progress (0..1) of `tick` between `start` and `end`. */
export function replayProgress(tick: number, start: number, end: number): number {
  if (!(end > start)) return 0;
  return Math.max(0, Math.min(1, (tick - start) / (end - start)));
}

/** The tick for a progress-bar fraction (scrubbing). */
export function tickAtFraction(fraction: number, start: number, end: number): number {
  const f = Math.max(0, Math.min(1, fraction));
  return start + f * Math.max(0, end - start);
}

/** Within this many ticks of the end counts as finished. */
const END_EPS = 0.5;

export class ReplayController {
  private _view: ReplayView | null = null;
  /** The chosen speed; kept while no replay is loaded so the next one starts at it. */
  private speed: 1 | 2 = 1;
  /** Bumped by every load and clear, so a slow fetch can't overwrite a newer one. */
  private seq = 0;

  constructor(private readonly deps: ReplayDeps) {}

  get view(): ReplayView | null {
    return this._view;
  }

  private set(view: ReplayView | null): void {
    this._view = view;
    this.deps.onChange(view);
  }

  /**
   * Fetch and show a battle. `atEnd` shows its final frame paused (a reload
   * during RESULTS); otherwise it plays from the start.
   */
  async load(round: number, opts: { atEnd?: boolean; speed?: 1 | 2 } = {}): Promise<void> {
    const speed = opts.speed ?? this.speed;
    this.speed = speed;
    const seq = ++this.seq;
    this.set({ round, speed, paused: false, loading: true, playing: false });
    let replay: ReplayDTO;
    try {
      replay = await this.deps.fetch(round);
    } catch (err) {
      if (seq !== this.seq) return;
      this.set(null);
      if (!opts.atEnd) this.deps.onError?.(err);
      return;
    }
    if (seq !== this.seq) return;
    const t = this.deps.target;
    t.loadReplay(replay);
    t.setPlayback({ speed, paused: false });
    if (opts.atEnd) {
      t.seek(replay.end.endTick);
      t.setPlayback({ paused: true });
    }
    this.deps.onLoaded?.(replay);
    this.set({ round, speed, paused: !!opts.atEnd, loading: false, playing: !opts.atEnd });
  }

  /** Play `round` from the start (the Replay button, R key, admin remote). */
  play(round: number | null | undefined): Promise<void> {
    if (!round) return Promise.resolve();
    return this.load(round, { speed: this.speed });
  }

  setSpeed(speed: 1 | 2): void {
    this.speed = speed;
    this.deps.target.setPlayback({ speed });
    if (this._view) this.set({ ...this._view, speed });
  }

  /** Pause/resume; at the end, resume means start over. */
  togglePause(): void {
    const v = this._view;
    if (!v || v.loading) return;
    const t = this.deps.target;
    if (v.paused && t.tick >= t.endTick - 1) {
      void this.play(v.round);
      return;
    }
    t.setPlayback({ paused: !v.paused });
    this.set({ ...v, paused: !v.paused, playing: v.paused ? true : v.playing });
  }

  /** Jump to a fraction of the battle (progress-bar click). Keeps the paused state. */
  seekFraction(fraction: number): void {
    const v = this._view;
    if (!v || v.loading) return;
    const t = this.deps.target;
    const tick = tickAtFraction(fraction, t.startTick, t.endTick);
    t.seek(tick);
    const atEnd = tick >= t.endTick - END_EPS;
    if (atEnd) {
      t.setPlayback({ paused: true });
      this.set({ ...v, paused: true, playing: false });
    } else if (!v.playing) {
      this.set({ ...v, playing: true });
    }
  }

  progress(): number {
    if (!this._view || this._view.loading) return 0;
    const t = this.deps.target;
    return replayProgress(t.tick, t.startTick, t.endTick);
  }

  /** Mark the replay finished once the clock reaches the end (polled by the view). */
  sync(): void {
    const v = this._view;
    const t = this.deps.target;
    if (v && v.playing && !v.loading && t.tick >= t.endTick - END_EPS) {
      t.setPlayback({ paused: true });
      this.set({ ...v, playing: false, paused: true });
    }
  }

  /**
   * Stop a running (or still loading) replay on its final frame, so the
   * podium can take over when the match ends mid-replay.
   */
  finish(): void {
    const v = this._view;
    if (!v || (!v.playing && !v.loading)) return;
    if (v.loading) {
      this.clear();
      return;
    }
    const t = this.deps.target;
    t.seek(t.endTick);
    t.setPlayback({ paused: true });
    this.set({ ...v, playing: false, paused: true });
  }

  /** Forget the replay (back to live or the lobby). */
  clear(): void {
    this.seq++;
    if (this._view) this.set(null);
  }
}
