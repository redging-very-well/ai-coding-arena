// WebAudio player for the synthesized effects in sfx.ts: no
// asset files, every sound is oscillators and filtered noise. Browsers only
// let an AudioContext start after a user gesture, so the context is created
// (or resumed) on the first click/tap/key; until then `state` is 'locked' and
// pages show a "click to enable sound" hint. The mute flag is remembered per
// page in localStorage (wrapped in try/catch by sfx.ts).

import { PITCHED, SFX, SfxLimiter, browserStorage, loadMuted, saveMuted, type SfxName } from './sfx.js';

export type AudioState = 'locked' | 'running' | 'unsupported';

export interface PlayOptions {
  /** Pitch in Hz for pitched sounds (shoot); tones scale by pitch / 440. */
  pitch?: number;
  /** Volume multiplier (default 1). */
  gain?: number;
  /** Start this many ms from now (scheduled on the audio clock). */
  delayMs?: number;
  /** Skip the rate limiter (UI sounds the player triggered). */
  force?: boolean;
}

/** At most this many sounds ring at once; more are dropped. */
const MAX_VOICES = 24;
const MASTER_GAIN = 0.6;

type Ctx = AudioContext;

export class SoundEngine {
  private ctx: Ctx | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private voices = 0;
  private readonly limiter = new SfxLimiter();
  private readonly listeners = new Set<() => void>();
  private _muted: boolean;
  private _state: AudioState;

  constructor(private readonly storageKey: string, defaultMuted: boolean) {
    this._muted = loadMuted(browserStorage(), storageKey, defaultMuted);
    this._state = typeof window !== 'undefined' && ('AudioContext' in window || 'webkitAudioContext' in window) ? 'locked' : 'unsupported';
  }

  get muted(): boolean {
    return this._muted;
  }

  get state(): AudioState {
    return this._state;
  }

  /** Whether a sound would be heard now. */
  get audible(): boolean {
    return !this._muted && this._state === 'running';
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  setMuted(muted: boolean): void {
    if (muted === this._muted) return;
    this._muted = muted;
    saveMuted(browserStorage(), this.storageKey, muted);
    if (!muted) this.unlock();
    this.emit();
  }

  toggleMuted(): void {
    this.setMuted(!this._muted);
  }

  /** Create or resume the AudioContext. Must run inside a user gesture handler. */
  unlock(): void {
    if (this._state === 'unsupported') return;
    try {
      if (!this.ctx) {
        const Ctor = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)!;
        this.ctx = new Ctor();
        this.master = this.ctx.createGain();
        this.master.gain.value = MASTER_GAIN;
        this.master.connect(this.ctx.destination);
        this.ctx.onstatechange = () => this.syncState();
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume().then(() => this.syncState(), () => undefined);
      this.syncState();
    } catch {
      this._state = 'unsupported';
      this.emit();
    }
  }

  private syncState(): void {
    const next: AudioState = this.ctx?.state === 'running' ? 'running' : 'locked';
    if (next !== this._state) {
      this._state = next;
      this.emit();
    }
  }

  /**
   * Unlock on a pointer or key press anywhere on the page (the autoplay
   * rule). Stays installed, so a context the browser suspends later (tablet
   * backgrounded, audio device changed) resumes on the next gesture.
   * Returns a cleanup function.
   */
  installUnlock(target: Window = window): () => void {
    const onGesture = () => {
      if (this._state === 'running' || this._state === 'unsupported') return;
      this.unlock();
    };
    const off = () => {
      target.removeEventListener('pointerdown', onGesture, true);
      target.removeEventListener('keydown', onGesture, true);
    };
    target.addEventListener('pointerdown', onGesture, true);
    target.addEventListener('keydown', onGesture, true);
    return off;
  }

  /** Play a sound (dropped when muted, locked, rate limited or too many voices ring). */
  play(name: SfxName, opts: PlayOptions = {}): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || !this.audible) return;
    if (!opts.force && !this.limiter.allow(name, performance.now() + (opts.delayMs ?? 0))) return;
    if (this.voices >= MAX_VOICES) return;
    const t0 = ctx.currentTime + Math.max(0, opts.delayMs ?? 0) / 1000;
    const k = PITCHED.has(name) && opts.pitch ? opts.pitch / 440 : 1;
    const vol = opts.gain ?? 1;
    let end = t0;
    for (const step of SFX[name]) {
      const start = t0 + step.at;
      const stop = start + step.dur;
      end = Math.max(end, stop);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, step.gain * vol), start + Math.min(0.01, step.dur / 4));
      g.gain.exponentialRampToValueAtTime(0.0001, stop);
      g.connect(master);
      let src: AudioScheduledSourceNode;
      if (step.kind === 'tone') {
        const osc = ctx.createOscillator();
        osc.type = step.wave;
        osc.frequency.setValueAtTime(step.from * k, start);
        if (step.to !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(20, step.to * k), stop);
        osc.connect(g);
        src = osc;
      } else {
        const buf = this.noise(ctx);
        const node = ctx.createBufferSource();
        node.buffer = buf;
        const filter = ctx.createBiquadFilter();
        filter.type = step.filter;
        filter.frequency.value = step.freq;
        node.connect(filter);
        filter.connect(g);
        src = node;
      }
      src.start(start);
      src.stop(stop + 0.02);
      src.onended = () => g.disconnect();
    }
    this.voices++;
    setTimeout(() => (this.voices = Math.max(0, this.voices - 1)), (end - ctx.currentTime) * 1000 + 50);
  }

  /** One second of white noise, made once and reused by every noise burst. */
  private noise(ctx: Ctx): AudioBuffer {
    if (!this.noiseBuf) {
      const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;
    }
    return this.noiseBuf;
  }
}
