// The isometric battle renderer (plan §12): floor, tinted zones, edge props,
// safe-zone ellipse, ground rings, depth-sorted sprite billboards, HP bars,
// projectile arcs with trails and the napping bubble. Interpolates between
// buffered frames at display rate (60 fps). With `fx` on (the projector) it
// adds muzzle flashes, hit sparks, damage numbers, death pops, screen shake on
// big hits and an idle bob (fx.ts; pooled, reduced with prefers-reduced-motion).
//
// Used by /screen (live + replay), the /play battle mini-view and replays:
//
//   const arena = new ArenaRenderer(canvas, { highlightSeat: mySeat });
//   arena.start();
//   ws.on('battle:reveal', (m) => arena.setReveal(m.data));
//   ws.on('battle:frames', (m) => arena.pushFrames(m.frames, m.playback));
//   // replay:  arena.loadReplay(replay); arena.setPlayback({ speed: 2 });
//   // lobby:   arena.setMap(state.match.map);
//   //          arena.setZones(map.zones.map((z) => ({ rect: z, seat: -1 })));
//
// The arena size S (800 / 1040 / 1200, §9.2) comes from the map (setMap, or
// the reveal's `map`); the view zooms to fit it. Zones are tinted with the
// seat colour (team colour in team mode) and carry the seat-number badge;
// ground rings use the seat colour, or the team colour + pattern in team mode,
// while the sprite outline always keeps the seat colour.
//
// The canvas should be sized by CSS; the renderer follows its box (HiDPI).

import {
  ARENA,
  FRAME_FLAGS,
  zoneRect,
  type BattleRevealDTO,
  type Corner,
  type FrameDTO,
  type MapStyle,
  type MapZoneDTO,
  type Rect,
  type FrameEvent,
  type PlaybackDTO,
  type ReplayDTO,
  type RevealedUnitDTO,
  type SpriteSpec,
  type StatsSnapshot,
} from '@pixel-clash/shared';
import { fitCanvasToBox, pixelContext, pixelsToCanvas, type Bitmap } from './canvas.js';
import { FxLayer, bobOffset, isBigHit } from './fx.js';
import {
  FLOOR_K,
  PROP_SPRITES,
  billboardWidth,
  depthCompare,
  edgeProps,
  fitIso,
  isoEllipse,
  renderFloor,
  toScreen,
  type EdgeProp,
  type FitOptions,
  type IsoView,
  type ScreenPoint,
} from './iso.js';
import { FrameBuffer, LIVE_SNAP_TICKS, PlaybackClock, type FrameSample, type SampledUnit } from './playback.js';
import { SpriteCache, UnitAnimator, chooseBakeScale, resolveSprite, type BakedSprite } from './sprites.js';
import { patternDash, rgba, seatStyle, teamLook } from '../seats.js';

/** A zone base to tint: a corner of the 800 arena, or a zone rectangle of the current map. */
export interface ArenaZone {
  corner?: Corner;
  rect?: Rect;
  /** Owner seat (-1 = neutral: no owner shown, e.g. before START). */
  seat: number;
  /** Team mode: tint with the team colour (the badge keeps the seat number). */
  teamId?: number | null;
}

/** The arena geometry the renderer draws: side S, style (cosmetic tiles) and every zone of the map. */
export interface ArenaMap {
  style: MapStyle | null;
  width: number;
  zones: readonly MapZoneDTO[];
}

/** The rectangle of an ArenaZone. */
export function arenaZoneRect(z: ArenaZone): Rect {
  if (z.rect) return { x: z.rect.x, y: z.rect.y, width: z.rect.width, height: z.rect.height };
  return zoneRect(z.corner ?? 'TL');
}

/** Tint colour of a zone: the team colour in team mode, else the seat colour (grey when neutral). */
export function zoneTint(z: Pick<ArenaZone, 'seat' | 'teamId'>): string {
  return teamLook(z.teamId)?.color ?? seatStyle(z.seat).color;
}

export interface ArenaOptions {
  /** Seat whose units get a highlighted ring and marker (own units on /play). */
  highlightSeat?: number | null;
  /** Canvas background; null leaves it transparent. Default '#0D0F1A'. */
  background?: string | null;
  /** Fit options (margins, headroom, pixel snapping). */
  fit?: FitOptions;
  /** Draw HP bars (default true). */
  hpBars?: boolean;
  /** Animate units dropping into their zones on reveal (default true). */
  dropIn?: boolean;
  /** Seat-number badges on owned zone tints and HP bars (default true). */
  badges?: boolean;
  /** Called for each battle event as playback passes it (fx, sound, toasts). */
  onEvent?: (event: FrameEvent, arena: ArenaRenderer) => void;
  /**
   * Projector effects (default false): muzzle flashes, hit sparks, floating
   * damage numbers, death pops, screen shake on big hits, idle bob.
   */
  fx?: boolean;
  /** prefers-reduced-motion: no shake or bob, fewer particles (default false). */
  reducedMotion?: boolean;
  /** Extra drawing after the units (fx layer: damage numbers, particles…). */
  overlay?: (ctx: CanvasRenderingContext2D, view: IsoView, arena: ArenaRenderer, now: number) => void;
}

/** What the renderer knows about one placed copy. */
export interface ArenaInstance {
  instanceId: string;
  unitId: string;
  playerId: string;
  seat: number;
  /** Team mode: the owner's team (ring colour + pattern). */
  teamId?: number | null;
  /** Drawn see-through and without HP (a teammate's placement on the /play mini-map). */
  ghost?: boolean;
  name: string;
  stats: StatsSnapshot;
  spec: SpriteSpec;
  /** Cache key of the spec. */
  specKey: string;
  /** Spawn position (reveal). */
  x0: number;
  y0: number;
}

interface InstanceState {
  info: ArenaInstance;
  anim: UnitAnimator;
  x: number;
  y: number;
  hp: number;
  flags: number;
  /** Present in the current sample. */
  alive: boolean;
  /** Idle-bob phase (ms), so copies don't float in step. */
  bobPhase: number;
}

/** One entry of the per-frame draw list (reused between frames: no allocation). */
interface DrawItem {
  x: number;
  y: number;
  key: string;
  unit: InstanceState | null;
  prop: EdgeProp | null;
  lift: number;
}

/** A per-instance phase in [0, 900) ms from its id. */
function phaseOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h) % 900;
}

interface ProjectileState {
  startX: number;
  startY: number;
  /** Arena distance from start to the target when first seen. */
  dist: number;
  color: string;
  trail: ScreenPoint[];
}

const HP_COLORS = { good: '#4ADE80', mid: '#FACC15', low: '#F87171', back: '#14121F', border: '#05040A' };
export const DROP_MS = 450;
export const DROP_STAGGER_MS = 35;
/** A first frame later than this means we joined mid-battle: no drop-in. */
const DROP_MAX_FIRST_T = 6;
/** Team mode is on for a reveal when it lists teams. */
function teamModeOf(reveal: BattleRevealDTO): boolean {
  return !!reveal.teams && reveal.teams.length > 0;
}

/**
 * The owned zones of a reveal: each player's map zone (or, from an older
 * server, the legacy corner), tinted by team in team mode.
 */
export function revealZones(reveal: BattleRevealDTO): ArenaZone[] {
  const teams = teamModeOf(reveal);
  return reveal.players.flatMap((p): ArenaZone[] => {
    const teamId = teams ? (p.teamId ?? null) : null;
    if (p.mapZone) return [{ rect: p.mapZone, seat: p.seat, teamId }];
    return p.zone ? [{ corner: p.zone, seat: p.seat, teamId }] : [];
  });
}

/** The reveal's map geometry (an older reveal without `map` is the 800 Corners arena). */
export function revealMap(reveal: BattleRevealDTO): ArenaMap | null {
  return reveal.map ? { style: reveal.map.style, width: reveal.map.width, zones: reveal.map.zones } : null;
}

/** Floor bitmaps kept per zone combination. */
const FLOOR_MEMO = 8;

/** 32-bit FNV-1a of a string, as 8 hex digits. */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * The resolved sprite of a revealed design and its bake-cache key. The key
 * hashes the spec's CONTENT: unitId is stable across revisions (§7), so a
 * redrawn sprite must not hit the old bake.
 */
export function revealedSprite(playerId: string, u: Pick<RevealedUnitDTO, 'unitId' | 'sprite' | 'spriteHidden' | 'stats'>): {
  spec: SpriteSpec;
  key: string;
} {
  const spec = resolveSprite(u);
  return { spec, key: `${playerId}/${u.unitId}/${fnv1a(JSON.stringify(spec))}` };
}

/**
 * Whether the reveal drop-in animation is still playing: within its time
 * window after the reveal, and while playback has not moved past the first
 * frame (gated on time and playback position, not on an empty buffer: the
 * t=0 frame arrives right with the reveal).
 */
export function dropInActive(o: { now: number; revealAt: number; units: number; bufferLength: number; tick: number; firstT: number }): boolean {
  if (o.now - o.revealAt >= DROP_MS + o.units * DROP_STAGGER_MS) return false;
  return o.bufferLength === 0 || o.tick <= o.firstT + DROP_MAX_FIRST_T;
}

/** Drop-in progress of the `index`-th unit `elapsedMs` after the reveal: < 0 not yet visible, ≥ 1 landed. */
export function dropProgress(elapsedMs: number, index: number): number {
  return (elapsedMs - index * DROP_STAGGER_MS) / DROP_MS;
}

/** Height (CSS px) above its spot of a dropping unit at progress `t` (ease-in fall from 260 px). */
export function dropLift(t: number): number {
  if (t >= 1) return 0;
  const f = 1 - Math.max(0, t);
  return f * f * 260;
}

export class ArenaRenderer {
  readonly buffer = new FrameBuffer();
  readonly clock = new PlaybackClock();
  private readonly ctx: CanvasRenderingContext2D;
  private readonly sprites = new SpriteCache<Bitmap>(pixelsToCanvas);
  private props: EdgeProp[] = edgeProps();
  private view: IsoView;
  private cssSize = { width: 1, height: 1, dpr: 1 };
  private zones: ArenaZone[] = [];
  private map: ArenaMap | null = null;
  private teamMode = false;
  private floors = new Map<string, { bitmap: Bitmap; originX: number; originY: number }>();
  private instances = new Map<string, InstanceState>();
  private projectiles = new Map<number, ProjectileState>();
  private lastFireByTarget = new Map<string, string>();
  private totalTicks = 0;
  private endT: number | null = null;
  private revealAt = Number.NEGATIVE_INFINITY;
  private lastTick = 0;
  private lastNow = 0;
  private raf = 0;
  private running = false;
  private resizeObserver: ResizeObserver | null = null;
  private sample: FrameSample | null = null;
  /** Projector effects (used when options.fx is on). */
  readonly fx = new FxLayer();
  private readonly drawItems: DrawItem[] = [];
  private readonly seenIds = new Set<string>();
  private readonly liveProjectiles = new Set<number>();
  /** The font last set on the context this frame (setting ctx.font re-parses it: costly ×96 badges). */
  private font = '';

  constructor(
    readonly canvas: HTMLCanvasElement,
    private options: ArenaOptions = {},
  ) {
    this.ctx = pixelContext(canvas);
    this.fx.options = { reducedMotion: !!options.reducedMotion };
    this.view = fitIso(1, 1, this.fitOptions());
    this.resize(true);
  }

  /** Arena side S of the current map. */
  get arenaSize(): number {
    return this.map?.width ?? ARENA.width;
  }

  private fitOptions(): FitOptions {
    return { ...this.options.fit, arena: this.arenaSize };
  }

  // -------------------------------------------------------------------------
  // Inputs
  // -------------------------------------------------------------------------

  setOptions(patch: Partial<ArenaOptions>): void {
    this.options = { ...this.options, ...patch };
    this.fx.options = { reducedMotion: !!this.options.reducedMotion };
    if (patch.fit) this.resize(true);
  }

  /** Tint the zone bases (pre-battle lobby view; also set by reveal). */
  setZones(zones: readonly ArenaZone[]): void {
    this.zones = [...zones];
  }

  /**
   * The map to draw (arena size, cosmetic tiles). null = the 800 arena. A
   * different size re-fits the view (the projector zooms out for bigger maps).
   */
  setMap(map: ArenaMap | null): void {
    const before = this.arenaSize;
    this.map = map ? { style: map.style, width: map.width, zones: [...map.zones] } : null;
    if (this.arenaSize !== before) {
      this.props = edgeProps(1, this.arenaSize);
      this.view = fitIso(this.cssSize.width, this.cssSize.height, this.fitOptions());
    }
  }

  get currentMap(): ArenaMap | null {
    return this.map;
  }

  /** Forget the battle (back to an empty, tinted arena). */
  clearBattle(): void {
    this.buffer.clear();
    this.instances.clear();
    this.projectiles.clear();
    this.lastFireByTarget.clear();
    this.fx.clear();
    this.sample = null;
    this.endT = null;
    this.totalTicks = 0;
    this.clock.seek(0);
    this.lastTick = 0;
  }

  /**
   * START: the fielded units of every player. Resets the battle state.
   * `ghosts`: players whose units are drawn see-through (teammates' live
   * placements on the /play mini-map).
   */
  setReveal(reveal: BattleRevealDTO, opts: { ghosts?: ReadonlySet<string> } = {}): void {
    this.clearBattle();
    this.totalTicks = reveal.totalTicks;
    this.setMap(revealMap(reveal));
    this.teamMode = teamModeOf(reveal);
    this.zones = revealZones(reveal);
    for (const p of reveal.players) {
      const ghost = opts.ghosts?.has(p.playerId) ?? false;
      const designs = new Map(p.units.map((u) => [u.unitId, u]));
      for (const inst of p.instances) {
        const u = designs.get(inst.unitId);
        if (!u) continue;
        const sprite = revealedSprite(p.playerId, u);
        const info: ArenaInstance = {
          instanceId: inst.instanceId,
          unitId: u.unitId,
          playerId: p.playerId,
          seat: p.seat,
          teamId: this.teamMode ? (p.teamId ?? null) : null,
          ghost,
          name: u.name,
          stats: u.stats,
          spec: sprite.spec,
          specKey: sprite.key,
          x0: inst.x,
          y0: inst.y,
        };
        this.instances.set(inst.instanceId, {
          info,
          anim: new UnitAnimator(inst.instanceId),
          x: inst.x,
          y: inst.y,
          hp: u.stats.maxHealth,
          flags: 0,
          alive: true,
          bobPhase: phaseOf(inst.instanceId),
        });
      }
    }
    this.revealAt = performance.now();
    this.clock.mode = 'live';
  }

  /**
   * Do the expensive work for `reveal` ahead of time (during the 3-2-1
   * countdown): its floor bitmap and every fielded design's sprite bake at the
   * current scale, so the drop-in itself doesn't drop frames.
   */
  prewarm(reveal: BattleRevealDTO): void {
    this.floorFor(revealZones(reveal), revealMap(reveal));
    for (const p of reveal.players) {
      const color = seatStyle(p.seat).color;
      for (const u of p.units) {
        const { spec, key } = revealedSprite(p.playerId, u);
        const width = billboardWidth(u.stats.size, this.view);
        this.sprites.get(key, spec, color, chooseBakeScale(spec.grid, width * this.cssSize.dpr));
      }
    }
  }

  /** Live frames from 'battle:frames'. */
  pushFrames(frames: readonly FrameDTO[], playback?: PlaybackDTO): void {
    this.clock.mode = 'live';
    if (playback) {
      this.clock.speed = playback.speed;
      this.clock.paused = playback.paused;
      if (playback.totalTicks) this.totalTicks = playback.totalTicks;
    }
    const wasEmpty = this.buffer.length === 0;
    this.buffer.push(frames);
    if (wasEmpty && this.buffer.length > 0) {
      // Joined mid-battle (reconnect, late join): no drop-in.
      if (this.buffer.firstT > DROP_MAX_FIRST_T) this.revealAt = Number.NEGATIVE_INFINITY;
      // Start near the newest frame, without replaying events.
      this.clock.seek(Math.max(this.buffer.firstT, this.buffer.latestT - 6));
      this.lastTick = this.clock.tick;
      this.resyncDeaths();
    }
    // Keep memory bounded in live mode (≈ 4 s of frames behind the clock).
    this.buffer.trimBefore(this.clock.tick - 240);
  }

  /** The battle is over: playback may run to (and stop at) this tick. */
  setEnd(endTick: number): void {
    this.endT = endTick;
  }

  /** A stored battle; plays from the start in replay mode (paused = false). */
  loadReplay(replay: ReplayDTO): void {
    this.setReveal(replay.reveal);
    this.revealAt = Number.NEGATIVE_INFINITY;
    this.buffer.push(replay.frames);
    this.endT = replay.end.endTick;
    this.clock.mode = 'replay';
    this.clock.paused = false;
    this.clock.seek(this.buffer.firstT);
    this.lastTick = this.clock.tick;
  }

  setPlayback(p: { speed?: 1 | 2; paused?: boolean }): void {
    if (p.speed) this.clock.speed = p.speed;
    if (p.paused !== undefined) this.clock.paused = p.paused;
  }

  /** Replay: jump to a tick (events in between are not replayed). */
  seek(tick: number): void {
    this.clock.seek(Math.min(this.endTick, Math.max(this.buffer.firstT, tick)));
    this.lastTick = this.clock.tick;
    this.projectiles.clear();
    this.fx.clear();
    this.resyncDeaths();
  }

  get tick(): number {
    return this.clock.tick;
  }
  get endTick(): number {
    return this.endT ?? (this.totalTicks || this.buffer.latestT);
  }
  get currentView(): IsoView {
    return this.view;
  }
  get instanceIds(): string[] {
    return [...this.instances.keys()];
  }
  instance(id: string): ArenaInstance | undefined {
    return this.instances.get(id)?.info;
  }

  /** Canvas position (CSS px) of an instance's feet, or null. */
  screenPosOf(instanceId: string): ScreenPoint | null {
    const s = this.instances.get(instanceId);
    return s ? toScreen(this.view, s.x, s.y) : null;
  }

  // -------------------------------------------------------------------------
  // Loop
  // -------------------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.canvas);
    }
    this.lastNow = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      this.render(now);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  /** Re-fit to the canvas's CSS box (called automatically while running). */
  resize(force = false): void {
    const size = fitCanvasToBox(this.canvas, this.ctx, force);
    if (!size) return;
    this.cssSize = size;
    this.view = fitIso(size.width, size.height, this.fitOptions());
  }

  /** Advance the clock to `now` (ms, performance.now()) and draw one frame. */
  render(now: number = performance.now()): void {
    const dt = now - this.lastNow;
    this.lastNow = now;
    // While running, the ResizeObserver handles box changes; a per-frame
    // getBoundingClientRect would force a layout. Only a DPR change is polled.
    if (!this.resizeObserver || this.dprChanged()) this.resize();
    this.step(dt, now);
    this.draw(now);
  }

  private dprChanged(): boolean {
    const dpr = typeof window === 'undefined' ? 1 : Math.min(3, window.devicePixelRatio || 1);
    return dpr !== this.cssSize.dpr;
  }

  // -------------------------------------------------------------------------
  // Simulation of the view
  // -------------------------------------------------------------------------

  private step(dt: number, now: number): void {
    if (this.options.fx) this.fx.update(dt, now);
    if (this.buffer.length === 0) {
      this.sample = null;
      return;
    }
    const end = Math.min(this.endTick || this.buffer.latestT, this.buffer.latestT);
    const prev = this.lastTick;
    const t = this.clock.advance(dt, this.buffer.firstT, end);
    if (t < prev || t - prev > LIVE_SNAP_TICKS) {
      // Backwards, or a big jump (snap after a background tab, seek): don't
      // replay many seconds of events at once (every flash, death and toast).
      this.projectiles.clear();
      this.fx.clear();
      this.resyncDeaths();
    } else if (t > prev) {
      for (const { event } of this.buffer.eventsBetween(prev, t)) this.applyEvent(event, now);
    }
    this.lastTick = t;
    this.sample = this.buffer.sample(t);
    if (!this.sample) return;
    const seen = this.seenIds;
    seen.clear();
    for (const u of this.sample.units) {
      seen.add(u.id);
      const s = this.instances.get(u.id) ?? this.adoptUnknown(u);
      s.x = u.x;
      s.y = u.y;
      s.hp = u.hp;
      s.flags = u.flags;
      s.alive = true;
      s.anim.update(u.flags, now);
    }
    for (const s of this.instances.values()) {
      if (seen.has(s.info.instanceId) || !s.alive) continue;
      s.alive = false;
      if (!s.anim.dead) s.anim.onEvent({ type: 'death', instanceId: s.info.instanceId }, now);
    }
    this.trackProjectiles();
  }

  private applyEvent(event: FrameEvent, now: number): void {
    if (event.type === 'fire' && !event.melee) this.lastFireByTarget.set(event.targetId, event.instanceId);
    const ids = event.type === 'hit' ? [event.targetId, event.instanceId] : [event.instanceId];
    for (const id of ids) this.instances.get(id)?.anim.onEvent(event, now);
    if (this.options.fx) this.eventFx(event, now);
    this.options.onEvent?.(event, this);
  }

  /** Spawn the projector effects for a battle event (positions from the last drawn state). */
  private eventFx(ev: FrameEvent, now: number): void {
    const { view } = this;
    if (ev.type === 'fire') {
      const s = this.instances.get(ev.instanceId);
      if (!s || s.info.ghost) return;
      const p = toScreen(view, s.x, s.y);
      const h = billboardWidth(s.info.stats.size, view);
      const t = this.instances.get(ev.targetId);
      let dx = 0;
      let dy = 0;
      if (t) {
        const tp = toScreen(view, t.x, t.y);
        const d = Math.hypot(tp.sx - p.sx, tp.sy - p.sy) || 1;
        dx = (tp.sx - p.sx) / d;
        dy = (tp.sy - p.sy) / d;
      }
      const r = h * 0.45;
      this.fx.muzzle(p.sx + dx * r, p.sy - h * 0.5 + dy * r * 0.5, Math.max(2, h * 0.12), ev.melee ? '#FFFFFF' : s.info.stats.color, now);
    } else if (ev.type === 'hit') {
      const t = this.instances.get(ev.targetId);
      if (!t || t.info.ghost) return;
      const p = toScreen(view, t.x, t.y);
      const h = billboardWidth(t.info.stats.size, view);
      const max = t.info.stats.maxHealth;
      const big = isBigHit(ev.damage, max);
      this.fx.sparks(p.sx, p.sy - h * 0.5, view.zoom, big ? '#FFD447' : '#FFFFFF');
      this.fx.damageNumber(p.sx, p.sy - h * 0.9, ev.damage, big, now);
      if (big) this.fx.bigHit(ev.damage / max, now);
    } else if (ev.type === 'death') {
      const t = this.instances.get(ev.instanceId);
      if (!t || t.info.ghost) return;
      const p = toScreen(view, t.x, t.y);
      const h = billboardWidth(t.info.stats.size, view);
      this.fx.deathPop(p.sx, p.sy - h * 0.4, t.info.stats.size, view.zoom, [seatStyle(t.info.seat).color, t.info.stats.color, '#FFFFFF']);
    }
  }

  /** After a seek or a mid-battle join: units missing from the frame are long dead. */
  private resyncDeaths(): void {
    const s = this.buffer.sample(this.clock.tick);
    const alive = new Set(s?.units.map((u) => u.id) ?? []);
    for (const st of this.instances.values()) {
      st.anim.reset();
      st.alive = alive.has(st.info.instanceId);
      if (!st.alive) st.anim.onEvent({ type: 'death', instanceId: st.info.instanceId }, Number.NEGATIVE_INFINITY);
    }
  }

  /** A unit in the frames that the reveal didn't mention (should not happen): draw a fallback. */
  private adoptUnknown(u: SampledUnit): InstanceState {
    const seat = Number.parseInt(u.id, 10);
    const stats: StatsSnapshot = {
      name: '?',
      type: 'soldier',
      maxHealth: Math.max(1, u.hp),
      damage: 0,
      range: 0,
      speed: 0,
      attackCooldown: 1,
      color: '#9AA0AA',
      size: 10,
      shape: 'circle',
    };
    const st: InstanceState = {
      info: {
        instanceId: u.id,
        unitId: '?',
        playerId: '?',
        seat: Number.isInteger(seat) ? seat : -1,
        name: '?',
        stats,
        spec: resolveSprite({ sprite: null, stats }),
        specKey: 'unknown',
        x0: u.x,
        y0: u.y,
      },
      anim: new UnitAnimator(u.id),
      x: u.x,
      y: u.y,
      hp: u.hp,
      flags: u.flags,
      alive: true,
      bobPhase: phaseOf(u.id),
    };
    this.instances.set(u.id, st);
    return st;
  }

  private trackProjectiles(): void {
    const live = this.liveProjectiles;
    live.clear();
    for (const p of this.sample?.projectiles ?? []) {
      live.add(p.id);
      if (this.projectiles.has(p.id)) continue;
      const target = this.instances.get(p.targetId);
      const shooterId = this.lastFireByTarget.get(p.targetId);
      const shooter = shooterId ? this.instances.get(shooterId) : undefined;
      const dist = target ? Math.hypot(target.x - p.x, target.y - p.y) : 0;
      this.projectiles.set(p.id, {
        startX: p.x,
        startY: p.y,
        dist: Math.max(1, dist),
        color: shooter?.info.stats.color ?? '#FFFFFF',
        trail: [],
      });
    }
    for (const id of this.projectiles.keys()) if (!live.has(id)) this.projectiles.delete(id);
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  private draw(now: number): void {
    const { ctx, view } = this;
    const { width, height } = this.cssSize;
    ctx.save();
    this.font = '';
    ctx.imageSmoothingEnabled = false;
    if (this.options.background === null) ctx.clearRect(0, 0, width, height);
    else {
      ctx.fillStyle = this.options.background ?? '#0D0F1A';
      ctx.fillRect(0, 0, width, height);
    }
    const shake = this.options.fx ? this.fx.offset(now) : null;
    if (shake && (shake.x !== 0 || shake.y !== 0)) ctx.translate(shake.x, shake.y);
    this.drawFloor();
    if (this.options.badges !== false) this.drawZoneBadges();
    this.drawSafeZone(now);
    this.drawRings(now);
    this.drawBillboards(now);
    this.drawProjectiles();
    if (this.options.fx) {
      this.fx.draw(ctx, now, Math.max(11, Math.round(9 * view.zoom)));
      this.font = '';
    }
    this.options.overlay?.(ctx, view, this, now);
    ctx.restore();
  }

  private setFont(font: string): void {
    if (font === this.font) return;
    this.ctx.font = font;
    this.font = font;
  }

  /** The floor bitmap for a map and zone set (memoised: only a few combinations occur). */
  private floorFor(zones: readonly ArenaZone[], map: ArenaMap | null = this.map): { bitmap: Bitmap; originX: number; originY: number } {
    const S = map?.width ?? ARENA.width;
    const tinted = zones.map((z) => ({ ...arenaZoneRect(z), color: zoneTint(z) }));
    const key = `${S}:${map?.style ?? '-'}|${tinted.map((z) => `${z.x},${z.y}:${z.color}`).join(',')}`;
    let f = this.floors.get(key);
    if (f) {
      this.floors.delete(key);
    } else {
      const bmp = renderFloor({ zones: tinted, arena: S, style: map?.style ?? null, mapZones: map?.zones ?? [] });
      f = { bitmap: pixelsToCanvas(bmp.image), originX: bmp.originX, originY: bmp.originY };
    }
    this.floors.set(key, f);
    while (this.floors.size > FLOOR_MEMO) this.floors.delete(this.floors.keys().next().value!);
    return f;
  }

  private drawFloor(): void {
    const s = this.view.k / FLOOR_K;
    const f = this.floorFor(this.zones);
    this.ctx.drawImage(
      f.bitmap,
      Math.round(this.view.originX - f.originX * s),
      Math.round(this.view.originY - f.originY * s),
      f.bitmap.width * s,
      f.bitmap.height * s,
    );
  }

  /** Seat-number badge at the centre of each owned zone tint. */
  private drawZoneBadges(): void {
    const { view } = this;
    for (const z of this.zones) {
      if (z.seat < 0) continue;
      const r = arenaZoneRect(z);
      const c = toScreen(view, r.x + r.width / 2, r.y + r.height / 2);
      const size = Math.max(18, Math.round(22 * view.zoom));
      this.drawBadge(c.sx - size / 2, c.sy - size / 2, size, z.seat, 0.85);
    }
  }

  /** A square seat-number badge (1-8) with its top-left at (x, y). */
  private drawBadge(x: number, y: number, size: number, seat: number, alpha = 1): void {
    const { ctx } = this;
    const st = seatStyle(seat);
    const bx = Math.round(x);
    const by = Math.round(y);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#05040A';
    ctx.fillRect(bx - 1, by - 1, size + 2, size + 2);
    ctx.fillStyle = st.color;
    ctx.fillRect(bx, by, size, size);
    ctx.fillStyle = st.ink;
    this.setFont(`${Math.max(7, Math.round(size * 0.62))}px "Press Start 2P", ui-monospace, monospace`);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(st.symbol, bx + size / 2 + 0.5, by + size / 2 + 1);
    ctx.globalAlpha = 1;
  }

  private diamondPath(): void {
    const { ctx, view } = this;
    const S = this.arenaSize;
    const a = toScreen(view, 0, 0);
    const b = toScreen(view, S, 0);
    const c = toScreen(view, S, S);
    const d = toScreen(view, 0, S);
    ctx.moveTo(a.sx, a.sy);
    ctx.lineTo(b.sx, b.sy);
    ctx.lineTo(c.sx, c.sy);
    ctx.lineTo(d.sx, d.sy);
    ctx.closePath();
  }

  /** Sudden death: darken outside the safe circle and outline it (an ellipse on the ground). */
  private drawSafeZone(now: number): void {
    const r = this.sample?.safeZoneRadius;
    // The circle covers the whole arena until it shrinks below the half-diagonal.
    const mid = this.arenaSize / 2;
    if (r === undefined || r >= Math.hypot(mid, mid)) return;
    const { ctx, view } = this;
    const c = toScreen(view, mid, mid);
    const { rx, ry } = isoEllipse(r, view.k);
    ctx.save();
    ctx.beginPath();
    this.diamondPath();
    ctx.ellipse(c.sx, c.sy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(220, 38, 38, 0.22)';
    ctx.fill('evenodd');
    const pulse = 0.65 + 0.35 * Math.sin(now / 180);
    ctx.beginPath();
    ctx.ellipse(c.sx, c.sy, rx, ry, 0, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(2, view.k * 3);
    ctx.setLineDash([Math.max(4, view.k * 10), Math.max(3, view.k * 6)]);
    ctx.lineDashOffset = -now / 40;
    ctx.strokeStyle = `rgba(255, 90, 90, ${pulse})`;
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Ground rings: seat colour in free-for-all; in team mode the team colour
   * and pattern (solid, dashed, double, dotted) so teams read without colour.
   */
  private drawRings(now: number): void {
    const { ctx, view } = this;
    for (const s of this.instances.values()) {
      if (!s.alive) continue;
      const seat = seatStyle(s.info.seat);
      const team = teamLook(s.info.teamId);
      const color = team?.color ?? seat.color;
      const p = toScreen(view, s.x, s.y);
      const { rx, ry } = isoEllipse(s.info.stats.size, view.k);
      const mine = this.options.highlightSeat !== undefined && this.options.highlightSeat !== null && s.info.seat === this.options.highlightSeat;
      const danger = (s.flags & FRAME_FLAGS.OUTSIDE_SAFE_ZONE) !== 0 && Math.sin(now / 90) > 0;
      ctx.globalAlpha = s.info.ghost ? 0.5 : 1;
      ctx.beginPath();
      ctx.ellipse(p.sx, p.sy, rx, ry, 0, 0, Math.PI * 2);
      ctx.fillStyle = rgba(color, mine ? 0.35 : 0.22);
      ctx.fill();
      const lw = Math.max(team ? 1.5 : 1, view.zoom * (mine ? 2 : team ? 1.6 : 1.2));
      ctx.lineWidth = lw;
      ctx.strokeStyle = danger ? '#FF5A5A' : mine && !team ? seat.light : color;
      if (team) {
        ctx.setLineDash(patternDash(team.pattern, lw));
        ctx.lineCap = team.pattern === 'dotted' ? 'round' : 'butt';
      }
      ctx.stroke();
      if (team?.pattern === 'double') {
        ctx.beginPath();
        ctx.ellipse(p.sx, p.sy, rx + lw * 1.8, ry + lw * 0.9, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.lineCap = 'butt';
      ctx.globalAlpha = 1;
    }
  }

  private bakedFor(s: InstanceState, width: number): BakedSprite<Bitmap> {
    const scale = chooseBakeScale(s.info.spec.grid, width * this.cssSize.dpr);
    return this.sprites.get(s.info.specKey, s.info.spec, seatStyle(s.info.seat).color, scale);
  }

  /** Reuse (or grow) the draw-list slot `i`. */
  private drawItem(i: number, x: number, y: number, key: string, unit: InstanceState | null, prop: EdgeProp | null, lift: number): void {
    let it = this.drawItems[i];
    if (!it) this.drawItems.push((it = { x, y, key, unit, prop, lift }));
    it.x = x;
    it.y = y;
    it.key = key;
    it.unit = unit;
    it.prop = prop;
    it.lift = lift;
  }

  /** Props and units back to front, with the drop-in offsets (one reused list, no per-frame closures). */
  private drawBillboards(now: number): void {
    let n = 0;
    for (const prop of this.props) this.drawItem(n++, prop.x, prop.y, prop.key, null, prop, 0);
    const drop =
      this.options.dropIn !== false &&
      dropInActive({
        now,
        revealAt: this.revealAt,
        units: this.instances.size,
        bufferLength: this.buffer.length,
        tick: this.clock.tick,
        firstT: this.buffer.firstT,
      });
    let i = 0;
    for (const s of this.instances.values()) {
      let lift = 0;
      if (drop) {
        const t = dropProgress(now - this.revealAt, i);
        i++;
        if (t < 0) continue;
        lift = dropLift(t);
      }
      this.drawItem(n++, s.x, s.y, s.info.instanceId, s, null, lift);
    }
    const items = this.drawItems;
    items.length = n;
    items.sort(depthCompare);
    for (const it of items) {
      if (it.unit) this.drawUnit(it.unit, it.lift, now);
      else if (it.prop) this.drawProp(it.prop, now);
    }
  }

  private drawProp(prop: EdgeProp, now: number): void {
    const width = billboardWidth(prop.size, this.view);
    const spec = PROP_SPRITES[prop.kind];
    const scale = chooseBakeScale(spec.grid, width * this.cssSize.dpr);
    const baked = this.sprites.get(`prop:${prop.kind}`, spec, null, scale);
    const frame = Math.floor((now + prop.x * 7) / 500) % baked.frameCount('idle');
    const p = toScreen(this.view, prop.x, prop.y);
    this.blit(baked.frame('idle', frame, false), baked, p, width, 0, 1);
  }

  /** Draw a baked bitmap with the inner grid `width` wide and its bottom at the feet. */
  private blit(bmp: Bitmap, baked: BakedSprite<Bitmap>, feet: ScreenPoint, width: number, lift: number, alpha: number): number {
    const inner = baked.grid * baked.scale;
    const k = width / inner;
    const size = baked.size * k;
    const { ry } = isoEllipse(width / 2 / this.view.zoom, this.view.k);
    const bottom = feet.sy + ry * 0.35 - lift;
    const top = bottom - (inner + baked.pad) * k;
    const left = feet.sx - size / 2;
    this.ctx.globalAlpha = alpha;
    this.ctx.drawImage(bmp, Math.round(left), Math.round(top), Math.round(size), Math.round(size));
    this.ctx.globalAlpha = 1;
    return top + baked.pad * k;
  }

  private drawUnit(s: InstanceState, lift: number, now: number): void {
    const { ctx, view } = this;
    const width = billboardWidth(s.info.stats.size, view);
    const baked = this.bakedFor(s, width);
    const pose = s.anim.pose(now, baked.frameCount, baked.fadeOnlyDeath);
    if (pose.gone) return;
    const feet = toScreen(view, s.x, s.y);
    const ghost = s.info.ghost ? 0.5 : 1;
    const bob =
      this.options.fx && !this.options.reducedMotion && s.alive && pose.state === 'idle' && !pose.napping ? bobOffset(now, s.bobPhase, width) : 0;
    const top = this.blit(baked.frame(pose.state, pose.frame, pose.mirror), baked, feet, width, lift + bob, ghost * pose.alpha * (pose.napping ? 0.75 : 1));
    if (!s.alive || lift > 0 || s.info.ghost) return;

    // HP bar.
    let y = top - Math.max(4, 3 * view.zoom);
    if (this.options.hpBars !== false) {
      const frac = Math.max(0, Math.min(1, s.hp / s.info.stats.maxHealth));
      const bw = Math.max(14, Math.round(width * 0.9));
      const bh = Math.max(3, Math.round(2.2 * view.zoom));
      const bx = Math.round(feet.sx - bw / 2);
      const by = Math.round(y - bh);
      ctx.fillStyle = HP_COLORS.border;
      ctx.fillRect(bx - 1, by - 1, bw + 2, bh + 2);
      ctx.fillStyle = HP_COLORS.back;
      ctx.fillRect(bx, by, bw, bh);
      ctx.fillStyle = frac > 0.5 ? HP_COLORS.good : frac > 0.25 ? HP_COLORS.mid : HP_COLORS.low;
      ctx.fillRect(bx, by, Math.max(frac > 0 ? 1 : 0, Math.round(bw * frac)), bh);
      // Seat-number badge on the bar's left end (kept readable when zoomed out).
      if (this.options.badges !== false && s.info.seat >= 0) {
        const side = Math.max(10, Math.round(bh * 2.4));
        this.drawBadge(bx - side + 1, by + bh / 2 - side / 2, side, s.info.seat);
      }
      y = by - 2;
    }
    // Own-unit marker: a small seat-coloured arrow.
    if (this.options.highlightSeat !== undefined && this.options.highlightSeat !== null && s.info.seat === this.options.highlightSeat) {
      const a = Math.max(3, 2.5 * view.zoom);
      const bob = Math.sin(now / 200) * a * 0.3;
      ctx.beginPath();
      ctx.moveTo(feet.sx - a, y - a * 1.6 + bob);
      ctx.lineTo(feet.sx + a, y - a * 1.6 + bob);
      ctx.lineTo(feet.sx, y - a * 0.4 + bob);
      ctx.closePath();
      ctx.fillStyle = seatStyle(s.info.seat).light;
      ctx.fill();
      y -= a * 1.8;
    }
    if (pose.napping) this.drawNapBubble(feet.sx + width * 0.35, y, now);
  }

  /** "Zz" speech bubble for a disabled (napping) unit. */
  private drawNapBubble(x: number, y: number, now: number): void {
    const { ctx, view } = this;
    const h = Math.max(12, 7 * view.zoom);
    const w = h * 1.6;
    const bob = Math.sin(now / 300) * h * 0.12;
    const bx = Math.round(x);
    const by = Math.round(y - h + bob);
    ctx.fillStyle = '#F5F3FF';
    ctx.strokeStyle = '#1A1530';
    ctx.lineWidth = Math.max(1, h / 10);
    ctx.beginPath();
    ctx.roundRect(bx, by, w, h, h * 0.3);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(bx + w * 0.2, by + h);
    ctx.lineTo(bx + w * 0.1, by + h * 1.35);
    ctx.lineTo(bx + w * 0.4, by + h);
    ctx.fill();
    ctx.fillStyle = '#4C3FA0';
    this.setFont(`${Math.round(h * 0.55)}px "Press Start 2P", ui-monospace, monospace`);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Zz', bx + w / 2, by + h / 2 + 1);
  }

  private drawProjectiles(): void {
    const { ctx, view } = this;
    const px = Math.max(2, Math.round(1.6 * view.zoom));
    for (const p of this.sample?.projectiles ?? []) {
      const st = this.projectiles.get(p.id);
      if (!st) continue;
      const target = this.instances.get(p.targetId);
      const remaining = target ? Math.hypot(target.x - p.x, target.y - p.y) : 0;
      const prog = Math.max(0, Math.min(1, 1 - remaining / st.dist));
      // Visual height only: a parabola peaking mid-flight, plus chest height.
      const arc = 4 * prog * (1 - prog) * Math.min(36, st.dist * 0.25);
      const chest = 8;
      const g = toScreen(view, p.x, p.y);
      const pos = { sx: g.sx, sy: g.sy - (arc + chest) * view.zoom };
      st.trail.push(pos);
      if (st.trail.length > 6) st.trail.shift();
      // Ground shadow.
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(Math.round(g.sx - px / 2), Math.round(g.sy - px / 4), px, Math.max(1, Math.round(px / 2)));
      // Trail.
      st.trail.forEach((t, i) => {
        const a = (i + 1) / (st.trail.length + 1);
        const sz = Math.max(1, Math.round(px * a));
        ctx.fillStyle = rgba(st.color, a * 0.6);
        ctx.fillRect(Math.round(t.sx - sz / 2), Math.round(t.sy - sz / 2), sz, sz);
      });
      ctx.fillStyle = st.color;
      ctx.fillRect(Math.round(pos.sx - px / 2), Math.round(pos.sy - px / 2), px, px);
      ctx.fillStyle = '#FFFFFF';
      const core = Math.max(1, Math.round(px / 2));
      ctx.fillRect(Math.round(pos.sx - core / 2), Math.round(pos.sy - core / 2), core, core);
    }
  }
}
