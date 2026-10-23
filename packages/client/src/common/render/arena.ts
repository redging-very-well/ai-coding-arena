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
//
// Buildings and minions (M8.5, §12.5): walls are iso blocks (buildings.ts,
// baked per design, seat, crack level and zoom) depth-sorted with everything
// else and kept between the frames that list them (the FrameBuffer carries
// them forward); factories are billboards with a production ring on the
// ground, a door flash, "pop" and "+1" when they make a minion, and a rally
// flag (option `rallyFlags`); minions are adopted from the frames by their id
// (`${factoryId}-mN`) and drawn with the built-in sprite in the factory's
// colour. The reveal drops buildings first (walls slam down), then units.

import {
  ARENA,
  FRAME_FLAGS,
  WALL_HALF,
  zoneRect,
  type BattleRevealDTO,
  type Corner,
  type BodyType,
  type FrameDTO,
  type FrameFactory,
  type MapStyle,
  type MapZoneDTO,
  type Rect,
  type FrameEvent,
  type PlaybackDTO,
  type ReplayDTO,
  type RevealedUnitDTO,
  type SpriteSpec,
  type StatsSnapshot,
  MINION_KIND_NAMES,
  producesOf,
  type MinionKind,
} from '@pixel-clash/shared';
import { WALL_HEIGHT, minionFactoryId, minionLook, productionRing, renderWallBlock, storedBadgeText, wallCrackLevel } from './buildings.js';
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
  /**
   * Factory rally flags (§12.5): every factory's ('all', the projector),
   * only `highlightSeat`'s ('mine', the /play battle view) or none. Default 'all'.
   */
  rallyFlags?: 'all' | 'mine' | 'none';
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
  /** What the body is (M8.5): a design's type, or 'minion' for a factory's minion. Default: stats.type. */
  body?: BodyType;
  /** Minions: the factory that made it. */
  factoryId?: string;
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
  /** Reveal drop-in order (buildings first); -1 = not part of the drop (minions). */
  dropIndex: number;
  /** Last dust puff of a blocked unit (ms). */
  dustAt: number;
}

/** The body kind of an instance (walls, factories and minions draw differently). */
export function bodyOf(info: Pick<ArenaInstance, 'body' | 'stats'>): BodyType {
  return info.body ?? info.stats.type;
}

/** Drop-in order of a reveal (§12.5): walls slam down first, then the other buildings, then soldiers. */
export function dropRank(body: BodyType): number {
  return body === 'wall' ? 0 : body === 'soldier' || body === 'minion' ? 2 : 1;
}

/** HP bars of walls and minions show only while damaged (§12.5); everything else always. */
export function showsHpBar(body: BodyType, hp: number, maxHp: number): boolean {
  if (body === 'wall' || body === 'minion') return hp < maxHp - 1e-6;
  return true;
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

type MinionBodyStats = Omit<StatsSnapshot, 'type' | 'name' | 'color' | 'shape'>;

/**
 * The minion kinds' stats when a reveal doesn't carry them (§5.2, §5.3
 * defaults; kept here so the screen bundle needs no config schema).
 */
const MINION_FALLBACK: Readonly<Record<MinionKind, MinionBodyStats>> = {
  grunt: { maxHealth: 40, damage: 5, range: 20, speed: 1.5, attackCooldown: 60, size: 8 },
  archer: { maxHealth: 24, damage: 5, range: 110, speed: 1.2, attackCooldown: 60, size: 7 },
  runner: { maxHealth: 28, damage: 4, range: 20, speed: 2.6, attackCooldown: 60, size: 6 },
  brute: { maxHealth: 100, damage: 8, range: 20, speed: 0.9, attackCooldown: 60, size: 11 },
};

function bodyStats(m: MinionBodyStats): MinionBodyStats {
  return { maxHealth: m.maxHealth, damage: m.damage, range: m.range, speed: m.speed, attackCooldown: m.attackCooldown, size: m.size };
}

/** Wall block bakes kept (per design × seat × crack level × zoom). */
const WALL_BAKES = 96;

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
  /** Living factories of the current sample (M8.5). */
  private readonly factories = new Map<string, FrameFactory>();
  /** The reveal's minion kinds (stats; drawn with their factory's colour). M8.6: one per kind fielded. */
  private readonly minionStats = new Map<MinionKind, MinionBodyStats>();
  /** Factories whose stored minions left together at this `now` (M8.6): their spawns skip the "+1". */
  private readonly releasedAt = new Map<string, number>();
  private readonly wallBakes = new Map<string, { bitmap: Bitmap; groundX: number; groundY: number; scale: number }>();
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
    this.factories.clear();
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
    this.minionStats.clear();
    this.releasedAt.clear();
    if (reveal.minion?.stats) this.minionStats.set('grunt', bodyStats(reveal.minion.stats));
    for (const [kind, m] of Object.entries(reveal.minions ?? {}) as Array<[MinionKind, { stats: MinionBodyStats } | undefined]>) {
      if (m?.stats) this.minionStats.set(kind, bodyStats(m.stats));
    }
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
          body: u.stats.type,
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
          dropIndex: 0,
          dustAt: 0,
        });
      }
    }
    // Buildings drop first (walls slam down), then the soldiers (§12.5); reveal order within each.
    const order = [...this.instances.values()].sort((a, b) => dropRank(bodyOf(a.info)) - dropRank(bodyOf(b.info)));
    order.forEach((st, i) => (st.dropIndex = i));
    // Walls are listed only when they change: the buffer carries them between frames.
    this.buffer.setSticky(
      [...this.instances.values()].filter((st) => bodyOf(st.info) === 'wall').map((st) => [st.info.instanceId, st.x, st.y, st.hp, 0] as [string, number, number, number, number]),
    );
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
      const outline = teamLook(teamModeOf(reveal) ? p.teamId : null)?.color ?? color;
      for (const u of p.units) {
        const { spec, key } = revealedSprite(p.playerId, u);
        if (u.stats.type === 'wall') {
          this.wallBake(key, spec, u.stats.color, outline, 0);
          continue;
        }
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
    this.factories.clear();
    for (const f of this.sample.fac) this.factories.set(f[0], f);
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
      // Pushing on a wall: a tiny dust puff now and then (§12.5).
      if (this.options.fx && (u.flags & FRAME_FLAGS.BLOCKED) !== 0 && now - s.dustAt > 280 && !s.info.ghost) {
        s.dustAt = now;
        const p = toScreen(this.view, s.x, s.y);
        this.fx.dust(p.sx, p.sy, this.view.zoom);
      }
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
    const ids =
      event.type === 'hit'
        ? [event.targetId, event.instanceId]
        : event.type === 'crumble'
          ? event.ids
          : event.type === 'release' || event.type === 'lost'
            ? [event.factoryId]
            : [event.instanceId];
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
      if (bodyOf(t.info) === 'wall') {
        this.crumbleFx(t);
        return;
      }
      const p = toScreen(view, t.x, t.y);
      const h = billboardWidth(t.info.stats.size, view);
      this.fx.deathPop(p.sx, p.sy - h * 0.4, t.info.stats.size, view.zoom, [seatStyle(t.info.seat).color, t.info.stats.color, '#FFFFFF']);
    } else if (ev.type === 'crumble') {
      for (const id of ev.ids) {
        const t = this.instances.get(id);
        if (!t || t.info.ghost) continue;
        if (bodyOf(t.info) === 'wall') this.crumbleFx(t);
        else {
          const p = toScreen(view, t.x, t.y);
          this.fx.crumble(p.sx, p.sy, billboardWidth(t.info.stats.size, view), view.zoom, [t.info.stats.color, '#6B6B6B']);
        }
      }
    } else if (ev.type === 'spawn' && ev.factoryId) {
      // A factory made a minion: a "pop" where it appears and a rising "+1" over the factory
      // (not for the minions of a burst: the "release!" label already says it, M8.6).
      const f = this.instances.get(ev.factoryId);
      if (!f || f.info.ghost) return;
      const seat = seatStyle(f.info.seat);
      const at = ev.x !== undefined && ev.y !== undefined ? toScreen(view, ev.x, ev.y) : toScreen(view, f.x, f.y);
      this.fx.puff(at.sx, at.sy - 4 * view.zoom, view.zoom, ['#FFFFFF', f.info.stats.color, seat.color]);
      if (this.releasedAt.get(ev.factoryId) === now) return;
      const fp = toScreen(view, f.x, f.y);
      this.fx.label(fp.sx, fp.sy - billboardWidth(f.info.stats.size, view) * 1.05, '+1', seat.light, now);
    } else if (ev.type === 'release') {
      // M8.6 (§12.5): 2+ stored minions burst out: a flash, a ring of puffs and "release!".
      const f = this.instances.get(ev.factoryId);
      if (!f || f.info.ghost) return;
      this.releasedAt.set(ev.factoryId, now);
      const seat = seatStyle(f.info.seat);
      const fp = toScreen(view, f.x, f.y);
      const h = billboardWidth(f.info.stats.size, view);
      this.fx.muzzle(fp.sx, fp.sy - h * 0.5, Math.max(6, h * 0.6), '#FFFFFF', now);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        this.fx.puff(fp.sx + Math.cos(a) * h * 0.7, fp.sy + Math.sin(a) * h * 0.35, view.zoom, ['#FFFFFF', f.info.stats.color, seat.color]);
      }
      this.fx.label(fp.sx, fp.sy - h * 1.1, `release! ×${ev.count}`, seat.light, now);
    } else if (ev.type === 'lost') {
      // M8.6: a factory died with minions inside; they are gone.
      const f = this.instances.get(ev.factoryId);
      if (!f || f.info.ghost) return;
      const fp = toScreen(view, f.x, f.y);
      this.fx.label(fp.sx, fp.sy - billboardWidth(f.info.stats.size, view) * 1.1, `\u2212${ev.count}`, '#9AA0AA', now);
    }
  }

  /** Falling stone chunks and a dust cloud over a wall's block. */
  private crumbleFx(t: InstanceState): void {
    const { view } = this;
    const p = toScreen(view, t.x, t.y);
    const width = 2 * WALL_HALF * view.zoom;
    this.fx.crumble(p.sx, p.sy - WALL_HEIGHT * view.zoom * 0.5, width, view.zoom, [t.info.stats.color, '#5A5E66', '#2E3038']);
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

  /**
   * A body in the frames that the reveal didn't list: a factory's minion
   * (id `${factoryId}-mN`, M8.5), or (should not happen) an unknown unit,
   * drawn as a fallback.
   */
  private adoptUnknown(u: SampledUnit): InstanceState {
    const factoryId = minionFactoryId(u.id);
    const factory = factoryId ? this.instances.get(factoryId) : undefined;
    if (factory && factoryId) return this.adoptMinion(u, factory, factoryId);
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
      dropIndex: -1,
      dustAt: 0,
    };
    this.instances.set(u.id, st);
    return st;
  }

  /** A minion: the built-in sprite tinted with its factory's colour, owned like the factory (§12.5). */
  private adoptMinion(u: SampledUnit, factory: InstanceState, factoryId: string): InstanceState {
    const f = factory.info;
    const kind = producesOf(f.stats);
    const m = this.minionStats.get(kind) ?? MINION_FALLBACK[kind];
    const look = minionLook(f.stats.color, kind);
    const stats: StatsSnapshot = {
      name: MINION_KIND_NAMES[kind],
      type: 'soldier',
      maxHealth: m.maxHealth,
      damage: m.damage,
      range: m.range,
      speed: m.speed,
      attackCooldown: m.attackCooldown,
      color: f.stats.color,
      size: m.size,
      shape: 'circle',
    };
    const st: InstanceState = {
      info: {
        instanceId: u.id,
        unitId: f.unitId,
        playerId: f.playerId,
        seat: f.seat,
        teamId: f.teamId ?? null,
        ghost: f.ghost ?? false,
        body: 'minion',
        factoryId,
        name: `${f.name} ${MINION_KIND_NAMES[kind].toLowerCase()}`,
        stats,
        spec: look.spec,
        specKey: look.key,
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
      dropIndex: -1,
      dustAt: 0,
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
    this.drawRallies();
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
      const body = bodyOf(s.info);
      if (body === 'wall') continue; // the block covers its cell
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
      if (body === 'factory') this.drawProductionRing(s, p, rx, ry);
      ctx.globalAlpha = 1;
    }
  }

  /** A factory's production ring (§12.5): an arc filling with the next minion's progress, grey while holding or done. */
  private drawProductionRing(s: InstanceState, p: ScreenPoint, rx: number, ry: number): void {
    const f = this.factories.get(s.info.instanceId);
    if (!f) return;
    const ring = productionRing(f);
    const { ctx, view } = this;
    const lw = Math.max(2, view.zoom * 2.2);
    const grow = lw * 1.6;
    ctx.beginPath();
    ctx.ellipse(p.sx, p.sy, rx + grow, ry + grow / 2, 0, 0, Math.PI * 2);
    ctx.lineWidth = lw;
    ctx.strokeStyle = 'rgba(5, 4, 10, 0.55)';
    ctx.stroke();
    if (ring.frac <= 0) return;
    const start = -Math.PI / 2;
    ctx.beginPath();
    ctx.ellipse(p.sx, p.sy, rx + grow, ry + grow / 2, 0, start, start + ring.frac * Math.PI * 2);
    ctx.strokeStyle = ring.idle ? '#8A8F98' : seatStyle(s.info.seat).light;
    ctx.stroke();
  }

  /** Rally flags (§12.5): a small seat-coloured flag at each factory's rally point, with a faint dotted line to it. */
  private drawRallies(): void {
    const mode = this.options.rallyFlags ?? 'all';
    if (mode === 'none' || this.factories.size === 0) return;
    const { ctx, view } = this;
    const mine = this.options.highlightSeat;
    for (const f of this.factories.values()) {
      const s = this.instances.get(f[0]);
      if (!s || !s.alive || s.info.ghost) continue;
      if (mode === 'mine' && (mine === null || mine === undefined || s.info.seat !== mine)) continue;
      const ring = productionRing(f);
      const seat = seatStyle(s.info.seat);
      const color = teamLook(s.info.teamId)?.color ?? seat.color;
      const a = toScreen(view, s.x, s.y);
      const b = toScreen(view, ring.rally.x, ring.rally.y);
      // M8.6 (§12.5): the marker shows the order. defend: a shield over the factory, no line.
      if (ring.order === 'defend') {
        this.drawShield(a.sx, a.sy - billboardWidth(s.info.stats.size, view) * 1.25, color, false);
        continue;
      }
      ctx.globalAlpha = 0.45;
      ctx.beginPath();
      ctx.moveTo(a.sx, a.sy);
      ctx.lineTo(b.sx, b.sy);
      ctx.lineWidth = Math.max(1, view.zoom);
      ctx.setLineDash([Math.max(2, 3 * view.zoom), Math.max(3, 4 * view.zoom)]);
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      if (ring.order === 'swarm') {
        this.drawReticle(b.sx, b.sy - Math.max(6, 8 * view.zoom), color);
        continue;
      }
      if (ring.order === 'guard') {
        this.drawShield(b.sx, b.sy - Math.max(14, 22 * view.zoom), color, true);
        continue;
      }
      // The flag: a pole and a pennant.
      const pole = Math.max(10, 14 * view.zoom);
      const w = Math.max(1, Math.round(view.zoom));
      ctx.fillStyle = '#05040A';
      ctx.fillRect(Math.round(b.sx - w), Math.round(b.sy - pole), w * 2, Math.round(pole));
      ctx.beginPath();
      ctx.moveTo(b.sx + w, b.sy - pole);
      ctx.lineTo(b.sx + w + pole * 0.6, b.sy - pole * 0.78);
      ctx.lineTo(b.sx + w, b.sy - pole * 0.55);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = '#05040A';
      ctx.lineWidth = Math.max(1, view.zoom * 0.6);
      ctx.stroke();
    }
  }

  /** A small shield marker (defend: plain; guard: with a heart). */
  private drawShield(x: number, y: number, color: string, heart: boolean): void {
    const { ctx, view } = this;
    const w = Math.max(7, 6 * view.zoom);
    ctx.beginPath();
    ctx.moveTo(x - w, y - w);
    ctx.lineTo(x + w, y - w);
    ctx.lineTo(x + w, y);
    ctx.quadraticCurveTo(x + w, y + w * 0.9, x, y + w * 1.4);
    ctx.quadraticCurveTo(x - w, y + w * 0.9, x - w, y);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = Math.max(1, view.zoom * 0.7);
    ctx.strokeStyle = '#05040A';
    ctx.stroke();
    if (heart) {
      const h = w * 0.45;
      ctx.beginPath();
      ctx.moveTo(x, y + h * 0.9);
      ctx.bezierCurveTo(x - h * 1.6, y - h * 0.2, x - h * 0.6, y - h * 1.4, x, y - h * 0.4);
      ctx.bezierCurveTo(x + h * 0.6, y - h * 1.4, x + h * 1.6, y - h * 0.2, x, y + h * 0.9);
      ctx.fillStyle = '#FFFFFF';
      ctx.fill();
    }
  }

  /** A target reticle (swarm): a ring with four ticks on the target. */
  private drawReticle(x: number, y: number, color: string): void {
    const { ctx, view } = this;
    const r = Math.max(6, 7 * view.zoom);
    const lw = Math.max(1.5, view.zoom * 1.2);
    for (const [stroke, width] of [['#05040A', lw + 2], [color, lw]] as const) {
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * 0.7, 0, 0, Math.PI * 2);
      ctx.moveTo(x - r * 1.5, y);
      ctx.lineTo(x - r * 0.5, y);
      ctx.moveTo(x + r * 0.5, y);
      ctx.lineTo(x + r * 1.5, y);
      ctx.moveTo(x, y - r * 1.2);
      ctx.lineTo(x, y - r * 0.35);
      ctx.moveTo(x, y + r * 0.35);
      ctx.lineTo(x, y + r * 1.2);
      ctx.lineWidth = width;
      ctx.strokeStyle = stroke;
      ctx.stroke();
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
    for (const s of this.instances.values()) {
      let lift = 0;
      if (drop && s.dropIndex >= 0) {
        const t = dropProgress(now - this.revealAt, s.dropIndex);
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

  /** The baked block of a wall design (seat outline, crack level) at the current zoom. */
  private wallBake(specKey: string, spec: SpriteSpec, color: string, outline: string | null, crack: 0 | 1 | 2) {
    const dpr = this.cssSize.dpr;
    const kb = Math.max(0.05, this.view.k * dpr);
    const id = `${specKey}|${outline ?? '-'}|${crack}|${kb.toFixed(3)}`;
    let hit = this.wallBakes.get(id);
    if (hit) {
      this.wallBakes.delete(id);
    } else {
      const img = renderWallBlock({ spec, color, outline, k: kb, height: WALL_HEIGHT * this.view.zoom * dpr, crack, outlineWidth: Math.max(1, Math.round(1.6 * dpr * Math.min(1.5, this.view.zoom))) });
      hit = { bitmap: pixelsToCanvas(img.image), groundX: img.groundX, groundY: img.groundY, scale: dpr };
    }
    this.wallBakes.set(id, hit);
    while (this.wallBakes.size > WALL_BAKES) this.wallBakes.delete(this.wallBakes.keys().next().value!);
    return hit;
  }

  /** A wall: its iso block, fading on death/crumble, with an HP bar only while damaged (§12.5). */
  private drawWall(s: InstanceState, lift: number, now: number): void {
    const { ctx, view } = this;
    const pose = s.anim.pose(now, () => 1, true);
    if (pose.gone) return;
    const team = teamLook(s.info.teamId);
    const outline = team?.color ?? seatStyle(s.info.seat).color;
    const bake = this.wallBake(s.info.specKey, s.info.spec, s.info.stats.color, outline, wallCrackLevel(s.hp, s.info.stats.maxHealth));
    const feet = toScreen(view, s.x, s.y);
    const k = 1 / bake.scale;
    ctx.globalAlpha = (s.info.ghost ? 0.5 : 1) * pose.alpha;
    ctx.drawImage(
      bake.bitmap,
      Math.round(feet.sx - bake.groundX * k),
      Math.round(feet.sy - bake.groundY * k - lift),
      Math.round(bake.bitmap.width * k),
      Math.round(bake.bitmap.height * k),
    );
    ctx.globalAlpha = 1;
    if (!s.alive || lift > 0 || s.info.ghost || this.options.hpBars === false) return;
    if (!showsHpBar('wall', s.hp, s.info.stats.maxHealth)) return;
    const top = feet.sy - WALL_HEIGHT * view.zoom - WALL_HALF * view.k;
    this.drawHpBar(s, feet.sx, top - Math.max(4, 3 * view.zoom), 2 * WALL_HALF * view.zoom * 0.8);
  }

  /** An HP bar centred on `cx` with its bottom at `y`; returns the y above it. */
  private drawHpBar(s: InstanceState, cx: number, y: number, width: number): number {
    const { ctx, view } = this;
    const frac = Math.max(0, Math.min(1, s.hp / s.info.stats.maxHealth));
    const bw = Math.max(14, Math.round(width * 0.9));
    const bh = Math.max(3, Math.round(2.2 * view.zoom));
    const bx = Math.round(cx - bw / 2);
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
    return by - 2;
  }

  private drawUnit(s: InstanceState, lift: number, now: number): void {
    const body = bodyOf(s.info);
    if (body === 'wall') {
      this.drawWall(s, lift, now);
      return;
    }
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

    // HP bar (minions: only while damaged).
    let y = top - Math.max(4, 3 * view.zoom);
    if (this.options.hpBars !== false && showsHpBar(body, s.hp, s.info.stats.maxHealth)) y = this.drawHpBar(s, feet.sx, y, width);
    // Own-unit marker: a small seat-coloured arrow (not over every minion).
    if (body !== 'minion' && this.options.highlightSeat !== undefined && this.options.highlightSeat !== null && s.info.seat === this.options.highlightSeat) {
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
    if (body === 'factory') this.drawStoredBadge(s, feet.sx + width * 0.5, top + width * 0.15);
  }

  /** M8.6 (§12.5): a round seat-coloured badge with "stored/burst" over a factory saving up a burst. */
  private drawStoredBadge(s: InstanceState, x: number, y: number): void {
    const f = this.factories.get(s.info.instanceId);
    if (!f) return;
    const ring = productionRing(f);
    const text = storedBadgeText(ring.stored, ring.burst);
    if (!text) return;
    const { ctx, view } = this;
    const st = seatStyle(s.info.seat);
    const r = Math.max(8, 6 * view.zoom);
    ctx.beginPath();
    ctx.ellipse(x, y, r * 1.35, r, 0, 0, Math.PI * 2);
    ctx.fillStyle = st.color;
    ctx.fill();
    ctx.lineWidth = Math.max(1, view.zoom * 0.8);
    ctx.strokeStyle = '#05040A';
    ctx.stroke();
    ctx.fillStyle = st.ink;
    this.setFont(`${Math.max(6, Math.round(r * 0.8))}px "Press Start 2P", ui-monospace, monospace`);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + 0.5, y + 1);
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
