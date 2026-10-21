// /play page state (plan §12.1): one GameSocket, the latest game state, the
// player's private data, rules, and the battle feed. The arena renderer for
// the battle view lives here too (it must see the reveal and every frame even
// before the battle panel mounts). Components subscribe with `useStore`.
// Sounds (§12.4) are muted by default here; the header has the unmute button.

import { useEffect, useState } from 'preact/hooks';
import {
  DEFAULT_CONFIG,
  FRAME_FLAGS,
  type BattleEndDTO,
  type BattleRevealDTO,
  type FrameDTO,
  type GameStateDTO,
  type MeResponse,
  type PlayerDTO,
  type PrivateStateDTO,
  type RulesDTO,
  type StatBounds,
} from '@pixel-clash/shared';
import { ApiError, api } from '../common/api.js';
import { SoundEngine } from '../common/audio.js';
import { ArenaRenderer } from '../common/render/arena.js';
import { MUTE_KEY_PLAY, countdownCue, revealCue } from '../common/sfx.js';
import { GameSocket, type WsStatus } from '../common/ws.js';
import { REVEAL_STEPS, REVEAL_STEP_MS } from '../screen/model.js';

export interface Toast {
  id: number;
  level: 'info' | 'warn' | 'error' | 'good';
  message: string;
  /** performance.now() when shown. */
  at: number;
}

/** One of my fielded copies during BATTLE (for the unit list). */
export interface MyBattleUnit {
  instanceId: string;
  unitId: string;
  name: string;
  maxHp: number;
  hp: number;
  alive: boolean;
  napping: boolean;
}

export interface PlayCaps {
  budget: number;
  maxTypes: number;
  maxCopies: number;
}

export interface PlayState {
  /** null until /api/me answered (or failed). */
  auth: 'unknown' | 'out' | 'in' | 'kicked';
  me: MeResponse | null;
  player: PlayerDTO | null;
  game: GameStateDTO | null;
  priv: PrivateStateDTO | null;
  rules: RulesDTO | null;
  caps: PlayCaps;
  bounds: StatBounds;
  socket: WsStatus;
  reveal: BattleRevealDTO | null;
  battleEnd: BattleEndDTO | null;
  myBattle: MyBattleUnit[];
  toasts: Toast[];
}

type Listener = () => void;

export class PlayStore {
  state: PlayState = {
    auth: 'unknown',
    me: null,
    player: null,
    game: null,
    priv: null,
    rules: null,
    caps: { budget: DEFAULT_CONFIG.caps.budget, maxTypes: DEFAULT_CONFIG.caps.maxTypes, maxCopies: DEFAULT_CONFIG.caps.maxCopies },
    bounds: DEFAULT_CONFIG.stats.bounds,
    socket: 'connecting',
    reveal: null,
    battleEnd: null,
    myBattle: [],
    toasts: [],
  };
  readonly socket: GameSocket;
  /** Arena for the battle mini-view; its canvas is moved into whichever panel shows it. */
  readonly arenaCanvas: HTMLCanvasElement;
  readonly arena: ArenaRenderer;
  /** UI sounds: muted until the player presses the unmute button (remembered on this device). */
  readonly sound = new SoundEngine(MUTE_KEY_PLAY, true);
  private readonly listeners = new Set<Listener>();
  private toastSeq = 0;
  private battleDirty = false;
  private battleTimer: ReturnType<typeof setInterval> | null = null;
  private lastFrame: FrameDTO | null = null;
  private disabled = new Set<string>();
  /** Last countdown reading, for the last-5-seconds beeps. */
  private lastCount: { key: string; secs: number | null } = { key: '', secs: null };

  constructor() {
    this.arenaCanvas = document.createElement('canvas');
    this.arenaCanvas.className = 'arena-canvas';
    this.arena = new ArenaRenderer(this.arenaCanvas, { fit: { margin: 4, pad: 24 } });
    this.socket = new GameSocket('screen');
    this.sound.installUnlock();
    this.sound.subscribe(() => this.set({}));
    this.wire();
  }

  // -------------------------------------------------------------------------
  // Subscription
  // -------------------------------------------------------------------------

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  set(patch: Partial<PlayState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  toast(message: string, level: Toast['level'] = 'info', ms = 5000): void {
    const t: Toast = { id: ++this.toastSeq, level, message, at: performance.now() };
    // The same message twice (server toast + a reconnect, double click) shows once; at most 3 at a time.
    const others = this.state.toasts.filter((x) => x.message !== message);
    this.set({ toasts: [...others.slice(-2), t] });
    setTimeout(() => this.dismiss(t.id), ms);
  }

  dismiss(id: number): void {
    if (!this.state.toasts.some((t) => t.id === id)) return;
    this.set({ toasts: this.state.toasts.filter((t) => t.id !== id) });
  }

  // -------------------------------------------------------------------------
  // Boot / auth
  // -------------------------------------------------------------------------

  async boot(): Promise<void> {
    void this.loadRules();
    try {
      const me = await api.me();
      this.onLoggedIn(me);
    } catch (err) {
      if (err instanceof ApiError && err.status === 0) {
        // Server unreachable: try again shortly.
        this.toast(err.playerMessage, 'error');
        setTimeout(() => void this.boot(), 3000);
        return;
      }
      this.set({ auth: 'out' });
    }
    void this.refreshState();
  }

  private async loadRules(): Promise<void> {
    try {
      const rules = await api.rules();
      const caps = rules.caps as Partial<Record<string, number>>;
      const b = rules.bounds as Partial<StatBounds>;
      const bounds: StatBounds = { ...DEFAULT_CONFIG.stats.bounds };
      for (const k of Object.keys(bounds) as Array<keyof StatBounds>) {
        const v = b[k] as { min?: unknown; max?: unknown } | undefined;
        if (v && typeof v.min === 'number' && typeof v.max === 'number') (bounds as Record<string, unknown>)[k] = v;
      }
      this.set({
        rules,
        bounds,
        caps: {
          budget: caps.budget ?? rules.budget ?? this.state.caps.budget,
          maxTypes: caps.maxTypes ?? this.state.caps.maxTypes,
          maxCopies: caps.maxCopies ?? this.state.caps.maxCopies,
        },
      });
    } catch {
      // defaults are fine
    }
  }

  async refreshState(): Promise<void> {
    try {
      this.set({ game: await api.state() });
    } catch {
      // the socket pushes state anyway
    }
  }

  /** After create/login: remember who we are and reconnect the socket with the new cookie. */
  onLoggedIn(me: MeResponse): void {
    this.set({ auth: 'in', me, player: me.player });
    this.arena.setOptions({ highlightSeat: me.player.seat });
    // Reconnect first: the new socket carries the session cookie and says
    // hello as 'player' once open (a hello on the old socket would be refused).
    this.socket.reconnect();
    this.socket.setRole('player');
  }

  async afterJoin(): Promise<void> {
    const me = await api.me();
    this.onLoggedIn(me);
    void this.refreshState();
  }

  async logout(): Promise<void> {
    try {
      await api.logout();
    } catch {
      // the session may already be gone
    }
    this.set({ auth: 'out', me: null, player: null, priv: null });
    this.socket.reconnect();
    this.socket.setRole('screen');
  }

  // -------------------------------------------------------------------------
  // Socket
  // -------------------------------------------------------------------------

  private wire(): void {
    const s = this.socket;
    s.onStatus((st) => {
      this.set({ socket: st });
      if (st === 'kicked') this.set({ auth: 'kicked' });
    });
    s.on('hello', (m) => {
      if (m.role === 'player' && m.player) this.set({ player: m.player });
      else if (this.state.auth === 'in' && m.role !== 'player') {
        // Our session is gone (PIN reset or server wipe): back to the join screen.
        this.set({ auth: 'out', me: null, player: null, priv: null });
      }
    });
    s.on('state', (m) => {
      const prev = this.state.game;
      this.set({ game: m.state });
      if (prev && prev.phase !== m.state.phase) this.onPhaseChange(prev.phase, m.state.phase);
      this.countdownSound(m.state);
    });
    s.on('private', (m) => {
      if (m.data.player.seat !== this.state.player?.seat) this.arena.setOptions({ highlightSeat: m.data.player.seat });
      this.set({ priv: m.data, player: m.data.player });
    });
    s.on('toast', (m) => {
      // Before login the server tells us the 'player' hello had no session; that's expected.
      if (this.state.auth !== 'in' && m.level !== 'info') return;
      this.toast(m.message, m.level);
    });
    s.on('kicked', () => this.set({ auth: 'kicked' }));
    s.on('battle:reveal', (m) => {
      // At START (not a reload mid-battle): "3, 2, 1, CLASH!" beeps with the projector.
      if ((this.state.game?.battle?.tick ?? 0) === 0 && this.state.game?.phase !== 'RESULTS') {
        REVEAL_STEPS.forEach((step, i) => {
          const sfx = revealCue(step);
          if (sfx) this.sound.play(sfx, { delayMs: i * REVEAL_STEP_MS, force: true });
        });
      }
      this.arena.setReveal(m.data);
      this.lastFrame = null;
      this.disabled.clear();
      this.set({ reveal: m.data, battleEnd: null });
      this.rebuildMyBattle();
    });
    s.on('battle:frames', (m) => {
      this.arena.pushFrames(m.frames, m.playback);
      for (const f of m.frames) {
        for (const ev of f.events) if (ev.type === 'disable') this.disabled.add(ev.instanceId);
      }
      const last = m.frames[m.frames.length - 1];
      if (last) this.lastFrame = last;
      this.battleDirty = true;
      this.ensureBattleTimer();
    });
    s.on('battle:end', (m) => {
      this.arena.setEnd(m.data.endTick);
      this.set({ battleEnd: m.data });
      this.rebuildMyBattle();
    });
  }

  private onPhaseChange(from: string, to: string): void {
    // Last phase's toasts are stale now (the server's toast for the new phase arrives just before
    // the state, so keep anything from the last second). PLAN and PLACEMENT are announced by that toast.
    const fresh = performance.now() - 1000;
    const kept = this.state.toasts.filter((t) => t.at >= fresh);
    this.set({ toasts: kept });
    // Missed the server's toast (socket was down when the phase changed): announce it ourselves.
    if (kept.length === 0 && to === 'PLAN') this.toast('Plan time! Ask Claude for new units.', 'good');
    else if (kept.length === 0 && to === 'PLACEMENT') this.toast('Place your army!', 'good');
    if (to === 'BATTLE') this.toast('CLASH!', 'good', 2500);
    // A little jingle when you won the round.
    const meId = this.state.player?.id;
    const mine = this.state.game?.lastBattle?.ranking.find((r) => r.playerId === meId);
    if (to === 'RESULTS' && mine?.place === 1) this.sound.play('victory');
    if (from === 'BATTLE' && this.battleTimer) {
      clearInterval(this.battleTimer);
      this.battleTimer = null;
    }
  }

  /** Beeps in the last 5 seconds of the PLAN/PLACEMENT timer and the battle (state arrives at 1 Hz). */
  private countdownSound(g: GameStateDTO): void {
    let key = '';
    let secs: number | null = null;
    if (g.phase === 'BATTLE' && g.battle) {
      key = `BATTLE:${g.round}`;
      secs = g.battle.paused ? null : (g.battle.totalTicks - g.battle.tick) / 60;
    } else if ((g.phase === 'PLAN' || g.phase === 'PLACEMENT') && !g.timer.paused) {
      key = `${g.phase}:${g.round}`;
      secs = g.timer.secondsLeft;
    }
    const prev = this.lastCount.key === key ? this.lastCount.secs : null;
    this.lastCount = { key, secs };
    const cue = countdownCue(prev, secs);
    if (cue) this.sound.play(cue.sfx, { force: true });
  }

  /** The unit list updates at 4 Hz, not per frame batch. */
  private ensureBattleTimer(): void {
    if (this.battleTimer) return;
    this.battleTimer = setInterval(() => {
      if (!this.battleDirty) return;
      this.battleDirty = false;
      this.rebuildMyBattle();
    }, 250);
  }

  private rebuildMyBattle(): void {
    const reveal = this.state.reveal;
    const meId = this.state.player?.id;
    const mine = reveal?.players.find((p) => p.playerId === meId);
    if (!mine) {
      if (this.state.myBattle.length) this.set({ myBattle: [] });
      return;
    }
    const designs = new Map(mine.units.map((u) => [u.unitId, u]));
    const frameUnits = new Map((this.lastFrame?.units ?? []).map((u) => [u[0], u]));
    const started = this.lastFrame !== null;
    const list: MyBattleUnit[] = mine.instances.map((inst) => {
      const d = designs.get(inst.unitId);
      const maxHp = d?.stats.maxHealth ?? 1;
      const fu = frameUnits.get(inst.instanceId);
      const alive = !started || fu !== undefined;
      return {
        instanceId: inst.instanceId,
        unitId: inst.unitId,
        name: d?.name ?? '?',
        maxHp,
        hp: fu ? Math.max(0, fu[3]) : started ? 0 : maxHp,
        alive,
        napping: alive && (this.disabled.has(inst.instanceId) || (fu !== undefined && (fu[4] & FRAME_FLAGS.DISABLED) !== 0)),
      };
    });
    this.set({ myBattle: list });
  }
}

let store: PlayStore | null = null;

export function getStore(): PlayStore {
  if (!store) store = new PlayStore();
  return store;
}

/** Re-render on every store change; returns the current state. */
export function useStore(): PlayState {
  const s = getStore();
  const [, setTick] = useState(0);
  useEffect(() => s.subscribe(() => setTick((n) => n + 1)), [s]);
  return s.state;
}
