// /play page state: one GameSocket, the latest game state, the
// player's private data, rules, and the battle feed. The arena renderer for
// the battle view lives here too (it must see the reveal and every frame even
// before the battle panel mounts). Components subscribe with `useStore`.
// Sounds are muted by default here; the header has the unmute button.
// The embedded Claude terminal: the player's Claude seat and its live
// holder (`terminal` push), the seat picker, this laptop's remembered seat, the
// "open in another tab" state and the Game-tab badges.

import { useEffect, useState } from 'preact/hooks';
import {
  DEFAULT_CONFIG,
  FRAME_FLAGS,
  type BattleEndDTO,
  type BattleRevealDTO,
  type ClaudeSeatAssignDTO,
  type ClaudeSeatsDTO,
  type FrameDTO,
  type GameStateDTO,
  type LoginResponse,
  type MeResponse,
  type PlayerDTO,
  type PrivateStateDTO,
  type RulesDTO,
  type SetupInfoDTO,
  type StatBounds,
  type TerminalDTO,
  type TerminalLiveDTO,
} from '@pixel-clash/shared';
import { ApiError, api, request } from '../common/api.js';
import { SoundEngine } from '../common/audio.js';
import { ArenaRenderer } from '../common/render/arena.js';
import { minionFactoryId } from '../common/render/buildings.js';
import { DEFAULT_PLAY_CAPS, capsFromRules, capsWithLiveCopyCaps, type PlayCaps } from './logic.js';
import { MUTE_KEY_PLAY, countdownCue, revealCue } from '../common/sfx.js';
import { GameSocket, type WsStatus } from '../common/ws.js';
import { REVEAL_STEPS, REVEAL_STEP_MS } from '../screen/model.js';
import {
  CLAIM_GRACE_MS,
  LAPTOP_SEAT_KEY,
  NO_BADGES,
  OLD_SEAT_KEY,
  badgeReducer,
  initialDisplaced,
  joinSeatRequest,
  newPaneId,
  nextDisplaced,
  parseSeat,
  reloadOnRecovery,
  rosterChanges,
  seatOffText,
  seatTakenText,
  stripSeatQuery,
  type BadgeEvent,
  type GameBadges,
} from './claudePane.js';

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // not remembered on this laptop, that's fine
  }
}

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
  /** Walls are listed after the fighters (M8.5). */
  wall?: boolean;
}

/** What the code editor has open. */
export type EditorTarget =
  | { mode: 'edit'; unitId: string; name: string }
  /** A copy of a starter template: saving makes a new design. */
  | { mode: 'copy'; templateId: string; templateName: string };

export type { PlayCaps };

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
  /** My factories' minions alive now (M8.5). */
  myMinions: number;
  toasts: Toast[];
  /** Own Claude seat, its status and live holder (WS `terminal`); null until known. */
  terminal: TerminalDTO | null;
  /** The seat picker's list (GET /claude-seats), loaded while the picker shows. */
  claudeSeats: ClaudeSeatsDTO | null;
  /** The terminal is open in another tab (or the admin's): the pane shows "Use it here instead". */
  displaced: boolean;
  /** Who took the terminal last (for the overlay text after that tab closed). */
  lastHolder: TerminalLiveDTO['by'] | null;
  /** A `terminal` push said who holds the seat (until then the iframe isn't loaded: it would take the seat over). */
  holderKnown: boolean;
  /** Bumped by "Use it here instead": remounts the iframe, which takes the seat back. */
  frameSeq: number;
  /** Last seat-picker problem ("Claude seat 3 is Sam's…"). */
  seatError: string | null;
  /** The laptop's Claude seat from its last assignment (localStorage): the join preference and the picker's offer. */
  laptopSeat: number | null;
  /** AI session host address (public /setup), for the grown-ups' direct link. */
  boxHost: string | null;
  /** Game-tab badges while Claude shows. */
  badges: GameBadges;
  /** Bumped on phase changes while the split view shows the game (flash the banner once). */
  phaseFlash: number;
  /** The code editor's unit (it replaces the game view in the Game pane), or null. */
  editor: EditorTarget | null;
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
    caps: DEFAULT_PLAY_CAPS,
    bounds: DEFAULT_CONFIG.stats.bounds,
    socket: 'connecting',
    reveal: null,
    battleEnd: null,
    myBattle: [],
    myMinions: 0,
    toasts: [],
    terminal: null,
    claudeSeats: null,
    displaced: false,
    lastHolder: null,
    holderKnown: false,
    frameSeq: 0,
    seatError: null,
    laptopSeat: null,
    boxHost: null,
    badges: NO_BADGES,
    phaseFlash: 0,
    editor: null,
  };
  /** This page's terminal iframe id (`?pane=`): tells our own terminal from another tab's. */
  readonly pane = newPaneId();
  /** Until then another live holder is ignored (our iframe is still connecting). */
  private claimingUntil = 0;
  private claimTimer: ReturnType<typeof setTimeout> | null = null;
  /** The game side is visible (split view, or the Game tab). */
  private gameShowing = true;
  /** Last keystroke in the terminal (ms epoch), to hold back the PLACEMENT nudge. */
  lastTypedAt = 0;
  private seatsLoading = false;
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
    this.arena = new ArenaRenderer(this.arenaCanvas, { fit: { margin: 4, pad: 24 }, rallyFlags: 'mine' });
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

  /** Open the code editor on a unit (the editor itself asks before throwing changes away). */
  openEditor(target: EditorTarget): void {
    this.set({ editor: target });
  }

  closeEditor(): void {
    if (this.state.editor) this.set({ editor: null });
  }

  dismiss(id: number): void {
    if (!this.state.toasts.some((t) => t.id === id)) return;
    this.set({ toasts: this.state.toasts.filter((t) => t.id !== id) });
  }

  // -------------------------------------------------------------------------
  // Boot / auth
  // -------------------------------------------------------------------------

  async boot(): Promise<void> {
    this.readLaptopSeat();
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
        caps: capsFromRules(caps, rules.budget, this.state.caps, rules.copyRamp),
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

  // -------------------------------------------------------------------------
  // Claude seat
  // -------------------------------------------------------------------------

  /**
   * This laptop's remembered seat (from its last assignment). A stale
   * `?seat=N` from an old printed seat card is ignored and taken out of the
   * URL, so those links work like a plain /play link.
   */
  private readLaptopSeat(): void {
    const laptop = parseSeat(readLocal(LAPTOP_SEAT_KEY)) ?? parseSeat(readLocal(OLD_SEAT_KEY));
    try {
      const rest = stripSeatQuery(location.search);
      if (rest !== null) history.replaceState(history.state, '', `${location.pathname}${rest}${location.hash}`);
    } catch {
      // no location/history (tests): nothing to strip
    }
    this.set({ laptopSeat: laptop });
  }

  /** What join / login send as `claudeSeat`: this laptop's seat (preferred), else 'auto'. */
  joinSeatRequest(): number | 'auto' {
    return joinSeatRequest(this.state.laptopSeat);
  }

  /** After an auto-assigning join: this laptop remembers the seat it was given (the next player's preference). */
  private rememberAssignedSeat(assigned?: ClaudeSeatAssignDTO): void {
    if (assigned?.seat == null || assigned.seat === this.state.laptopSeat) return;
    writeLocal(LAPTOP_SEAT_KEY, String(assigned.seat));
    this.set({ laptopSeat: assigned.seat });
  }

  /** PUT /me/claude-seat. Resolves true when the seat is now the player's. */
  async claimSeat(seat: number | null): Promise<boolean> {
    try {
      const r = await api.setClaudeSeat(seat);
      if (r.claudeSeat !== null) writeLocal(LAPTOP_SEAT_KEY, String(r.claudeSeat));
      const t = this.state.terminal;
      const boxReady = t?.boxReady ?? this.state.claudeSeats?.boxReady ?? true;
      this.set({
        seatError: null,
        laptopSeat: r.claudeSeat ?? this.state.laptopSeat,
        // Show the seat at once; the `terminal` push that follows has the details.
        // A seat just claimed has no other holder of ours: its iframe may load right away.
        ...(t?.seat === r.claudeSeat ? {} : { terminal: { seat: r.claudeSeat, status: 'unknown' as const, boxReady, live: null }, holderKnown: true }),
      });
      void this.loadClaudeSeats();
      return r.claudeSeat === seat;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CLAUDE_SEAT_TAKEN') {
        const d = err.details as { seat?: number; takenBy?: string } | undefined;
        this.set({ seatError: seatTakenText(d?.seat ?? seat ?? 0, d?.takenBy) });
        void this.loadClaudeSeats();
      } else if (err instanceof ApiError && err.code === 'CLAUDE_SEAT_OFF') {
        this.set({ seatError: seatOffText(seat ?? 0) });
        void this.loadClaudeSeats();
      } else if (err instanceof ApiError) {
        this.set({ seatError: err.playerMessage });
      }
      return false;
    }
  }

  /** The seat picker's list (refetched on every `terminal` push while there is no seat). */
  async loadClaudeSeats(): Promise<void> {
    if (this.seatsLoading || this.state.auth !== 'in') return;
    this.seatsLoading = true;
    try {
      const seats = await api.claudeSeats();
      this.set({ claudeSeats: seats });
    } catch {
      // the next push retries
    } finally {
      this.seatsLoading = false;
    }
  }

  /** The AI session host address for the grown-ups' direct link (public /setup; it holds no secret). */
  async loadBoxHost(): Promise<void> {
    try {
      const i = await request<SetupInfoDTO>('GET', '/setup');
      this.set({ boxHost: i.settings?.aiSessionHost ?? null });
    } catch {
      // the link just isn't shown
    }
  }

  private onTerminal(t: TerminalDTO): void {
    const prev = this.state.terminal;
    let displaced = this.state.displaced;
    if (!this.state.holderKnown) {
      // Page load or login: the seat may be live in a standalone tab. Leave it
      // there ("Use it here instead"); our iframe loads only when it isn't.
      displaced = initialDisplaced(t, this.pane);
      this.claimingUntil = Date.now() + CLAIM_GRACE_MS;
    } else {
      if (!prev || prev.seat !== t.seat || !t.boxReady) {
        // A new seat (or no terminal at all): a fresh iframe, nothing displaced.
        displaced = false;
        this.claimingUntil = Date.now() + CLAIM_GRACE_MS;
      }
      displaced = nextDisplaced(displaced, t.live, this.pane, this.claimingUntil, Date.now());
    }
    const lastHolder = t.live && t.live.pane !== this.pane ? t.live.by : this.state.lastHolder;
    if (reloadOnRecovery(prev, t, displaced)) {
      // The AI session host is back: a fresh iframe connects again (ttyd's own page gave up).
      this.claimingUntil = Date.now() + CLAIM_GRACE_MS;
      this.set({ terminal: t, displaced, lastHolder, holderKnown: true, frameSeq: this.state.frameSeq + 1 });
    } else this.set({ terminal: t, displaced, lastHolder, holderKnown: true });
    if (t.seat === null) void this.loadClaudeSeats();
    else if (this.state.claudeSeats) this.set({ claudeSeats: null });
    // Someone else holds it while ours is still connecting: look again once the grace ends.
    if (!displaced && t.live && t.live.pane !== this.pane) this.recheckAfterGrace();
  }

  private recheckAfterGrace(): void {
    if (this.claimTimer) clearTimeout(this.claimTimer);
    const wait = Math.max(0, this.claimingUntil - Date.now()) + 50;
    this.claimTimer = setTimeout(() => {
      this.claimTimer = null;
      const t = this.state.terminal;
      if (t) this.set({ displaced: nextDisplaced(this.state.displaced, t.live, this.pane, this.claimingUntil, Date.now()) });
    }, wait);
  }

  /** The pane mounted (or remounted) its iframe: it is connecting now. */
  frameMounted(): void {
    this.claimingUntil = Date.now() + CLAIM_GRACE_MS;
  }

  /** "Use it here instead": reload the iframe, which takes the seat back from the other tab. */
  useHere(): void {
    this.claimingUntil = Date.now() + CLAIM_GRACE_MS;
    this.set({ displaced: false, frameSeq: this.state.frameSeq + 1 });
  }

  /** The layout tells the store whether the game side is visible (badges collect only while it isn't). */
  setGameShowing(showing: boolean): void {
    this.gameShowing = showing;
    if (showing) this.badge({ type: 'seen' });
  }

  private badge(ev: BadgeEvent): void {
    const next = badgeReducer(this.state.badges, ev, this.gameShowing);
    if (next !== this.state.badges) this.set({ badges: next });
  }

  /** After create/login: remember who we are and reconnect the socket with the new cookie. */
  onLoggedIn(me: MeResponse, assigned?: ClaudeSeatAssignDTO): void {
    this.set({ auth: 'in', me, player: me.player, seatError: null });
    // Until the socket's `terminal` push: start loading the terminal right away (no picker flash).
    if (!this.state.terminal && me.claudeSeat != null) {
      this.set({ terminal: { seat: me.claudeSeat, status: 'unknown', boxReady: true, live: null } });
    }
    this.rememberAssignedSeat(assigned);
    this.arena.setOptions({ highlightSeat: me.player.seat });
    // Reconnect first: the new socket carries the session cookie and says
    // hello as 'player' once open (a hello on the old socket would be refused).
    this.socket.reconnect();
    this.socket.setRole('player');
  }

  /** After join / login; `res` carries the auto-assigned AI seat. */
  async afterJoin(res?: LoginResponse): Promise<void> {
    const me = await api.me();
    this.onLoggedIn(me, res?.claudeSeat);
    void this.refreshState();
  }

  async logout(): Promise<void> {
    try {
      await api.logout();
    } catch {
      // the session may already be gone
    }
    this.set({ auth: 'out', me: null, player: null, priv: null, ...LOGGED_OUT });
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
        this.set({ auth: 'out', me: null, player: null, priv: null, ...LOGGED_OUT });
      }
    });
    s.on('state', (m) => {
      const prev = this.state.game;
      this.set({ game: m.state });
      // The host can change the caps (and the rest of the rules) in /admin at any
      // time: take the live copy caps from every state, and fetch /rules again
      // when they moved or the phase changed, so the page never enforces stale limits.
      const live = capsWithLiveCopyCaps(this.state.caps, m.state.me?.copyCaps);
      if (live.changed) this.set({ caps: live.caps });
      if (live.changed || (prev && prev.phase !== m.state.phase)) void this.loadRules();
      if (prev && prev.phase !== m.state.phase) {
        this.onPhaseChange(prev.phase, m.state.phase);
        this.badge({ type: 'phase', phase: m.state.phase });
        if (this.gameShowing) this.set({ phaseFlash: this.state.phaseFlash + 1 });
      }
      this.countdownSound(m.state);
    });
    s.on('private', (m) => {
      if (m.data.player.seat !== this.state.player?.seat) this.arena.setOptions({ highlightSeat: m.data.player.seat });
      const prevRoster = this.state.priv?.roster;
      this.set({ priv: m.data, player: m.data.player });
      this.badge({ type: 'units', ...rosterChanges(prevRoster, m.data.roster) });
    });
    s.on('toast', (m) => {
      // Before login the server tells us the 'player' hello had no session; that's expected.
      if (this.state.auth !== 'in' && m.level !== 'info') return;
      this.toast(m.message, m.level);
    });
    s.on('kicked', () => this.set({ auth: 'kicked', ...LOGGED_OUT }));
    s.on('terminal', (m) => {
      if (this.state.auth === 'in') this.onTerminal(m.data);
    });
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
    if (kept.length === 0 && to === 'PLAN') this.toast('Plan time! Ask your AI helper for new units.', 'good');
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
      if (this.state.myBattle.length) this.set({ myBattle: [], myMinions: 0 });
      return;
    }
    const designs = new Map(mine.units.map((u) => [u.unitId, u]));
    // The buffer's newest frame: walls (listed only when they change) are carried in it.
    const buf = this.arena.buffer;
    const newest = buf.length > 0 ? buf.all[buf.length - 1]! : this.lastFrame;
    const frameUnits = new Map((newest?.units ?? []).map((u) => [u[0], u]));
    const myFactories = new Set(mine.instances.filter((i) => designs.get(i.unitId)?.stats.type === 'factory').map((i) => i.instanceId));
    let minions = 0;
    for (const id of frameUnits.keys()) {
      const f = minionFactoryId(id);
      if (f && myFactories.has(f)) minions++;
    }
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
        wall: d?.stats.type === 'wall',
      };
    });
    list.sort((a, b) => Number(!!a.wall) - Number(!!b.wall));
    this.set({ myBattle: list, myMinions: minions });
  }
}

/** Claude-pane state that belongs to a login (cleared on logout, kick, lost session). */
const LOGGED_OUT: Partial<PlayState> = {
  terminal: null,
  claudeSeats: null,
  displaced: false,
  lastHolder: null,
  holderKnown: false,
  seatError: null,
  badges: NO_BADGES,
  editor: null,
};

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
