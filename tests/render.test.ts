// Client renderer logic that runs without a DOM: the 2:1
// isometric projection and fit, depth sort, floor tile generation, edge props,
// sprite baking (scale, outline, mirror, flash, fallbacks), the animation
// state machine and frame interpolation.

import { describe, expect, it } from 'vitest';
import {
  ARENA,
  CELL_SIZE,
  FRAME_FLAGS,
  checkSprite,
  fallbackSprite,
  type FrameDTO,
  type SpriteSpec,
} from '@pixel-clash/shared';
import {
  FLOOR_CLIFF_PX,
  FLOOR_K,
  PROP_SPRITES,
  billboardWidth,
  depthSort,
  edgeProps,
  fitIso,
  floorColorAt,
  isoEllipse,
  isoProject,
  isoUnproject,
  renderFloor,
  snapZoom,
  toScreen,
  toWorld,
} from '../packages/client/src/common/render/iso.js';
import { alphaAt, getPixel, opaqueCount } from '../packages/client/src/common/render/pixels.js';
import {
  ANIM_FRAME_MS,
  ATTACK_MS,
  DEATH_FADE_MS,
  HIT_MS,
  SpriteCache,
  UnitAnimator,
  bakeFrame,
  bakeSprite,
  chooseBakeScale,
  outlineWidthFor,
  rasterizeFrame,
  resolveSprite,
  stateFrames,
} from '../packages/client/src/common/render/sprites.js';
import { FrameBuffer, LIVE_DELAY_TICKS, PlaybackClock } from '../packages/client/src/common/render/playback.js';
import { SEATS, hexToRgb, seatOfInstance, seatStyle } from '../packages/client/src/common/seats.js';

const close = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps);

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

describe('iso projection', () => {
  it('maps the arena corners to a 2:1 diamond', () => {
    const k = 1;
    expect(isoProject(0, 0, k)).toEqual({ sx: 0, sy: 0 });
    expect(isoProject(800, 0, k)).toEqual({ sx: 800, sy: 400 });
    expect(isoProject(0, 800, k)).toEqual({ sx: -800, sy: 400 });
    expect(isoProject(800, 800, k)).toEqual({ sx: 0, sy: 800 });
    // Width is twice the height.
    expect(isoProject(800, 0, k).sx - isoProject(0, 800, k).sx).toBe(2 * isoProject(800, 800, k).sy);
  });

  it('scales linearly with k and inverts exactly', () => {
    for (const [x, y, k] of [
      [123.4, 567.8, 0.7],
      [0, 800, 2],
      [-40, 900, 1.3],
      [400, 400, 0.25],
    ] as const) {
      const p = isoProject(x, y, k);
      close(p.sx, (x - y) * k);
      close(p.sy, ((x + y) * k) / 2);
      const back = isoUnproject(p.sx, p.sy, k);
      close(back.x, x, 1e-9);
      close(back.y, y, 1e-9);
    }
  });

  it('fits the diamond inside the canvas with headroom, centred', () => {
    for (const [w, h] of [
      [1920, 1080],
      [800, 600],
      [390, 844],
    ] as const) {
      const v = fitIso(w, h, { margin: 10, pad: 40, top: 60 });
      const left = toScreen(v, 0, ARENA.height);
      const right = toScreen(v, ARENA.width, 0);
      const top = toScreen(v, 0, 0);
      const bottom = toScreen(v, ARENA.width, ARENA.height);
      expect(left.sx).toBeGreaterThanOrEqual(10 - 1e-6);
      expect(right.sx).toBeLessThanOrEqual(w - 10 + 1e-6);
      expect(top.sy).toBeGreaterThanOrEqual(10 + 60 * v.k - 1e-6); // room for tall sprites at the back
      expect(bottom.sy).toBeLessThanOrEqual(h - 10 + 1e-6);
      close(left.sx + right.sx, w, 1e-6); // horizontally centred
      close(v.zoom, v.k * Math.SQRT2);
      // Round trip through canvas coordinates.
      const mid = toWorld(v, toScreen(v, 321, 654).sx, toScreen(v, 321, 654).sy);
      close(mid.x, 321, 1e-6);
      close(mid.y, 654, 1e-6);
    }
    // 1080p is height-bound: the diamond is wider than tall but fills the height.
    const v = fitIso(1920, 1080);
    expect(v.k).toBeGreaterThan(0.9);
  });

  it('pixel snap rounds the floor scale to whole (or half) steps', () => {
    expect(snapZoom(FLOOR_K * 2.7)).toBeCloseTo(FLOOR_K * 2);
    expect(snapZoom(FLOOR_K * 1.7)).toBeCloseTo(FLOOR_K * 1.5);
    const v = fitIso(1920, 1080, { pixelSnap: true });
    const s = v.k / FLOOR_K;
    expect(Math.abs(s * 2 - Math.round(s * 2))).toBeLessThan(1e-9);
  });

  it('projects ground circles to 2:1 ellipses that match the billboard width', () => {
    const k = 0.8;
    const { rx, ry } = isoEllipse(10, k);
    close(rx, 10 * k * Math.SQRT2);
    close(ry, rx / 2);
    // Every point of the circle lands on the ellipse.
    for (let a = 0; a < Math.PI * 2; a += 0.3) {
      const p = isoProject(400 + 10 * Math.cos(a), 400 + 10 * Math.sin(a), k);
      const c = isoProject(400, 400, k);
      close(((p.sx - c.sx) / rx) ** 2 + ((p.sy - c.sy) / ry) ** 2, 1, 1e-9);
    }
    // Sprite width = 2·size·zoom = the ring's width.
    const v = fitIso(1000, 700);
    close(billboardWidth(15, v), 2 * isoEllipse(15, v.k).rx);
  });
});

describe('depth sort', () => {
  it('draws back (small x + y) first, deterministic on ties', () => {
    const items = [
      { x: 500, y: 500, key: 'c' },
      { x: 100, y: 100, key: 'a' },
      { x: 300, y: 200, key: 'b2' },
      { x: 200, y: 300, key: 'b1' },
      { x: 300, y: 200, key: 'b0' },
    ];
    expect(depthSort(items).map((i) => i.key)).toEqual(['a', 'b1', 'b0', 'b2', 'c']);
    // Input untouched.
    expect(items[0]!.key).toBe('c');
  });

  it('a unit lower on screen is drawn later', () => {
    const k = 1;
    const units = Array.from({ length: 30 }, (_, i) => ({ x: (i * 137) % 800, y: (i * 251) % 800, key: String(i) }));
    const sorted = depthSort(units);
    for (let i = 1; i < sorted.length; i++) {
      expect(isoProject(sorted[i]!.x, sorted[i]!.y, k).sy).toBeGreaterThanOrEqual(isoProject(sorted[i - 1]!.x, sorted[i - 1]!.y, k).sy);
    }
  });
});

// ---------------------------------------------------------------------------
// Floor, zones, props
// ---------------------------------------------------------------------------

describe('floor tiles', () => {
  const floor = renderFloor({ zones: [{ corner: 'TL', color: SEATS[0]!.color }, { corner: 'BR', color: SEATS[2]!.color }] });

  it('is a diamond of 32×16 px tiles (one per 40 px cell) with a cliff under the front edges', () => {
    expect(floor.k).toBe(FLOOR_K);
    expect(CELL_SIZE * FLOOR_K * 2).toBe(32); // tile width in floor px
    expect(floor.image.width).toBe((ARENA.width + ARENA.height) * FLOOR_K);
    expect(floor.image.height).toBe(((ARENA.width + ARENA.height) * FLOOR_K) / 2 + FLOOR_CLIFF_PX);
    const at = (x: number, y: number) => {
      const p = isoProject(x, y, floor.k);
      return alphaAt(floor.image, Math.floor(floor.originX + p.sx), Math.floor(floor.originY + p.sy));
    };
    expect(at(400, 400)).toBe(255);
    expect(at(10, 790)).toBe(255);
    // Outside the diamond at the back is transparent; the front has the cliff.
    expect(alphaAt(floor.image, 2, 2)).toBe(0);
    const bottom = isoProject(800, 800, floor.k);
    expect(alphaAt(floor.image, Math.floor(floor.originX + bottom.sx), Math.floor(bottom.sy + 3))).toBeGreaterThan(0);
    expect(alphaAt(floor.image, Math.floor(floor.originX + bottom.sx), Math.floor(bottom.sy + FLOOR_CLIFF_PX + 1))).toBe(0);
  });

  it('tints the corner zones in their seat colour and leaves other corners plain', () => {
    const blue = hexToRgb(SEATS[0]!.color);
    const dist = (c: number[], t: number[]) => Math.hypot(c[0]! - t[0]!, c[1]! - t[1]!, c[2]! - t[2]!);
    const zones = [{ corner: 'TL' as const, color: SEATS[0]!.color }];
    const inZone = floorColorAt(120, 120, zones);
    const plain = floorColorAt(680, 120, zones);
    expect(dist(inZone, blue)).toBeLessThan(dist(plain, blue));
    // Deterministic for a seed.
    expect(floorColorAt(333, 222, zones, 5)).toEqual(floorColorAt(333, 222, zones, 5));
  });
});

describe('edge props', () => {
  it('sit outside the arena on the back edges only and are deterministic', () => {
    const props = edgeProps(1);
    expect(props.length).toBeGreaterThan(10);
    expect(edgeProps(1)).toEqual(props);
    for (const p of props) {
      const outside = p.x < 0 || p.y < 0 || p.x > ARENA.width || p.y > ARENA.height;
      expect(outside, `${p.key} at ${p.x},${p.y}`).toBe(true);
      // Never in front of the arena's front edges (they would cover units).
      expect(p.x <= ARENA.width + 20 && p.y <= ARENA.height + 20).toBe(true);
    }
    expect(new Set(props.map((p) => p.kind))).toEqual(new Set(['rock', 'bush', 'crystal', 'banner']));
  });

  it('prop sprites are valid SpriteSpecs', () => {
    for (const [kind, spec] of Object.entries(PROP_SPRITES)) {
      const r = checkSprite(spec);
      expect(r.ok, `${kind}: ${JSON.stringify(r)}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Sprite baking
// ---------------------------------------------------------------------------

const DOT: SpriteSpec = {
  grid: 8,
  palette: { r: '#FF0000', g: '#00FF00' },
  frames: {
    idle: [['........', '..rr....', '..rg....', '........', '........', '........', '........', '........']],
    walk: [['rr......', '........', '........', '........', '........', '........', '........', '........']],
  },
};

describe('sprite baking', () => {
  it('rasterizes palette keys and leaves "." transparent', () => {
    const img = rasterizeFrame(DOT, DOT.frames.idle[0]!);
    expect(img.width).toBe(8);
    expect(getPixel(img, 2, 1)).toEqual([255, 0, 0, 255]);
    expect(getPixel(img, 3, 2)).toEqual([0, 255, 0, 255]);
    expect(alphaAt(img, 0, 0)).toBe(0);
    expect(opaqueCount(img)).toBe(4);
  });

  it('upscales with nearest neighbour and adds a seat-coloured outline around opaque pixels', () => {
    const seat = hexToRgb('#56B4E9');
    const img = bakeFrame(DOT, DOT.frames.idle[0]!, { scale: 3, outline: seat, outlineWidth: 1 });
    expect(img.width).toBe(8 * 3 + 2);
    // Sprite pixel (2,1) → baked block [1+6..1+8]×[1+3..1+5], all red.
    for (let y = 4; y < 7; y++) for (let x = 7; x < 10; x++) expect(getPixel(img, x, y)).toEqual([255, 0, 0, 255]);
    // The outline: directly left of the block is seat-coloured, diagonals stay empty (4-neighbour).
    expect(getPixel(img, 6, 4)).toEqual([...seat, 255]);
    expect(getPixel(img, 7, 3)).toEqual([...seat, 255]);
    expect(alphaAt(img, 6, 3)).toBe(0);
    // Opaque = 4 pixels × 9 + a 1 px ring around the 6×6 block (6·4 = 24 edge pixels).
    expect(opaqueCount(img)).toBe(36 + 24);
    // No outline when the colour is null (props).
    expect(opaqueCount(bakeFrame(DOT, DOT.frames.idle[0]!, { scale: 3, outline: null }))).toBe(36);
  });

  it('mirrors horizontally (sprites face right; mirrored = facing left)', () => {
    const a = bakeFrame(DOT, DOT.frames.walk![0]!, { scale: 1, outline: null });
    const m = bakeFrame(DOT, DOT.frames.walk![0]!, { scale: 1, outline: null, mirror: true });
    expect(alphaAt(a, 0, 0)).toBe(255);
    expect(alphaAt(m, 0, 0)).toBe(0);
    expect(alphaAt(m, 7, 0)).toBe(255);
    expect(alphaAt(m, 6, 0)).toBe(255);
  });

  it('applies the contract fallbacks for missing states', () => {
    expect(stateFrames(DOT, 'walk').frames).toBe(DOT.frames.walk);
    expect(stateFrames(DOT, 'attack')).toMatchObject({ frames: DOT.frames.idle, flash: false });
    expect(stateFrames(DOT, 'hit')).toMatchObject({ flash: true, fadeOnly: false });
    expect(stateFrames(DOT, 'death')).toMatchObject({ fadeOnly: true });
    const flash = bakeFrame(DOT, DOT.frames.idle[0]!, { scale: 1, outline: null, flash: true });
    const [r, g, b] = getPixel(flash, 3, 2);
    expect(r).toBeGreaterThan(150);
    expect(g).toBeGreaterThan(200);
    expect(b).toBeGreaterThan(150);
  });

  it('uses the fallback sprite when the sprite is missing or hidden', () => {
    const stats = { color: '#FF8800', type: 'soldier' as const, shape: 'circle' as const };
    expect(resolveSprite({ sprite: DOT, stats })).toBe(DOT);
    expect(resolveSprite({ sprite: DOT, spriteHidden: true, stats })).toEqual(fallbackSprite(stats));
    expect(resolveSprite({ sprite: null, stats })).toEqual(fallbackSprite(stats));
  });

  it('picks an integer bake scale and a thin outline', () => {
    expect(chooseBakeScale(16, 40)).toBe(3);
    expect(chooseBakeScale(32, 20)).toBe(1);
    expect(chooseBakeScale(8, 1000)).toBe(8); // capped
    expect(outlineWidthFor(1)).toBe(1);
    expect(outlineWidthFor(4)).toBe(2);
    expect(outlineWidthFor(8)).toBe(3);
  });

  it('bakes every state (lazily mirrored) and caches per key/outline/scale', () => {
    let bakes = 0;
    const cache = new SpriteCache((img) => {
      bakes++;
      return img;
    });
    const a = cache.get('u1', DOT, '#56B4E9', 2);
    const eager = bakes;
    expect(eager).toBe(5); // idle, walk, attack(→idle), hit(flash), death(→idle)
    expect(cache.get('u1', DOT, '#56B4E9', 2)).toBe(a);
    expect(bakes).toBe(eager);
    a.frame('walk', 0, true);
    expect(bakes).toBe(eager + 1);
    a.frame('walk', 0, true);
    expect(bakes).toBe(eager + 1);
    expect(cache.get('u1', DOT, '#E69F00', 2)).not.toBe(a);
    expect(a.size).toBe(8 * 2 + 2 * a.pad);
    expect(a.frameCount('idle')).toBe(1);
    expect(a.fadeOnlyDeath).toBe(true);
    // Frame indices wrap.
    expect(a.frame('idle', 5, false)).toBe(a.frame('idle', 0, false));
  });

  it('bakes the real fallback sprite with a full outline', () => {
    const spec = fallbackSprite({ color: '#3366FF', type: 'tower', shape: 'square' });
    const baked = bakeSprite(spec, hexToRgb('#E69F00'), 2, (img) => img);
    const img = baked.frame('idle', 0, false);
    // Every opaque pixel touching a transparent pixel (4-neighbour) is outline-coloured.
    const [or, og, ob] = hexToRgb('#E69F00');
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        if (alphaAt(img, x, y) === 0) continue;
        const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => alphaAt(img, x + dx!, y + dy!) === 0);
        if (edge) expect(getPixel(img, x, y)).toEqual([or, og, ob, 255]);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Animation state machine
// ---------------------------------------------------------------------------

describe('unit animator (8 fps)', () => {
  const counts = (s: string) => ({ idle: 2, walk: 4, attack: 2, hit: 1, death: 3 })[s] ?? 1;

  it('walks while MOVING, faces left with FACING_LEFT', () => {
    const a = new UnitAnimator('0-0-0');
    a.update(FRAME_FLAGS.MOVING | FRAME_FLAGS.FACING_LEFT, 1000);
    const p0 = a.pose(1000, counts);
    expect(p0).toMatchObject({ state: 'walk', frame: 0, mirror: true });
    expect(a.pose(1000 + ANIM_FRAME_MS * 1.5, counts).frame).toBe(1);
    expect(a.pose(1000 + ANIM_FRAME_MS * 5, counts).frame).toBe(1); // 5 % 4
    a.update(0, 2000);
    expect(a.pose(2000, counts)).toMatchObject({ state: 'idle', mirror: false });
  });

  it('attack lasts 250 ms after firing, hit 100 ms, hit wins over attack', () => {
    const a = new UnitAnimator('1-0-0');
    a.onEvent({ type: 'fire', instanceId: '1-0-0', targetId: '0-0-0', melee: false }, 0);
    expect(a.pose(10, counts).state).toBe('attack');
    expect(a.pose(ANIM_FRAME_MS + 1, counts)).toMatchObject({ state: 'attack', frame: 1 });
    expect(a.pose(ATTACK_MS + 1, counts).state).toBe('idle');
    // Events about other units are ignored.
    a.onEvent({ type: 'fire', instanceId: '2-0-0', targetId: '1-0-0', melee: true }, 1000);
    expect(a.pose(1001, counts).state).toBe('idle');
    a.onEvent({ type: 'hit', instanceId: '2-0-0', targetId: '1-0-0', damage: 5 }, 1000);
    a.onEvent({ type: 'fire', instanceId: '1-0-0', targetId: '2-0-0', melee: false }, 1000);
    expect(a.pose(1050, counts).state).toBe('hit');
    expect(a.pose(1000 + HIT_MS + 1, counts).state).toBe('attack');
  });

  it('plays death once, then fades out and is gone', () => {
    const a = new UnitAnimator('2-1-1');
    a.update(FRAME_FLAGS.MOVING, 0);
    a.onEvent({ type: 'death', instanceId: '2-1-1' }, 0);
    expect(a.pose(0, counts)).toMatchObject({ state: 'death', frame: 0, alpha: 1 });
    expect(a.pose(ANIM_FRAME_MS * 2.5, counts).frame).toBe(2);
    expect(a.pose(ANIM_FRAME_MS * 10, counts).frame).toBe(2); // holds the last frame
    const fading = a.pose(ANIM_FRAME_MS * 3 + DEATH_FADE_MS / 2, counts);
    expect(fading.alpha).toBeCloseTo(0.5);
    expect(a.pose(ANIM_FRAME_MS * 3 + DEATH_FADE_MS, counts).gone).toBe(true);
    // Without death frames it fades from the start.
    const b = new UnitAnimator('x');
    b.onEvent({ type: 'death', instanceId: 'x' }, 0);
    expect(b.pose(DEATH_FADE_MS / 2, counts, true).alpha).toBeCloseTo(0.5);
    b.reset();
    expect(b.dead).toBe(false);
  });

  it('naps (frozen idle) while DISABLED', () => {
    const a = new UnitAnimator('3-0-0');
    a.update(FRAME_FLAGS.DISABLED | FRAME_FLAGS.MOVING, 0);
    expect(a.pose(500, counts)).toMatchObject({ state: 'idle', frame: 0, napping: true });
  });
});

// ---------------------------------------------------------------------------
// Frame buffer and clock
// ---------------------------------------------------------------------------

const frame = (t: number, units: FrameDTO['units'], extra: Partial<FrameDTO> = {}): FrameDTO => ({
  t,
  units,
  projectiles: [],
  safeZoneRadius: 570,
  events: [],
  ...extra,
});

describe('frame interpolation', () => {
  it('lerps positions/hp between neighbouring frames, using the next frame’s flags', () => {
    const buf = new FrameBuffer();
    buf.push([frame(2, [['0-0-0', 100, 100, 50, 0]]), frame(0, [['0-0-0', 90, 100, 60, 0]])]);
    buf.push([frame(4, [['0-0-0', 110, 120, 40, FRAME_FLAGS.MOVING]], { projectiles: [{ id: 1, x: 0, y: 0, targetId: '0-0-0' }] })]);
    expect(buf.all.map((f) => f.t)).toEqual([0, 2, 4]);
    const s = buf.sample(3)!;
    expect(s.units[0]).toMatchObject({ id: '0-0-0', x: 105, y: 110, hp: 45, flags: FRAME_FLAGS.MOVING });
    // Clamped at the ends.
    expect(buf.sample(99)!.units[0]).toMatchObject({ x: 110, y: 120 });
    expect(buf.sample(-5)!.units[0]).toMatchObject({ x: 90 });
  });

  it('keeps a unit that is missing from the next frame (it died) in place', () => {
    const buf = new FrameBuffer();
    buf.push([frame(0, [['a', 0, 0, 5, 0], ['b', 10, 10, 5, 0]]), frame(2, [['b', 20, 10, 5, 0]], { events: [{ type: 'death', instanceId: 'a' }] })]);
    const s = buf.sample(1)!;
    expect(s.units.find((u) => u.id === 'a')).toMatchObject({ x: 0, y: 0 });
    expect(s.units.find((u) => u.id === 'b')).toMatchObject({ x: 15 });
    expect(buf.eventsBetween(0, 2).map((e) => e.event.type)).toEqual(['death']);
    expect(buf.eventsBetween(2, 4)).toEqual([]);
  });

  it('replaces duplicate frames and trims old ones', () => {
    const buf = new FrameBuffer();
    buf.push([frame(0, []), frame(2, []), frame(4, [])]);
    buf.push([frame(2, [['z', 1, 1, 1, 0]])]);
    expect(buf.length).toBe(3);
    expect(buf.sample(2)!.units).toHaveLength(1);
    buf.trimBefore(3);
    expect(buf.firstT).toBe(2);
  });

  it('live clock trails the newest frame and snaps when far behind; replay runs freely', () => {
    const c = new PlaybackClock();
    c.advance(16, 0, 600);
    expect(c.tick).toBe(600 - LIVE_DELAY_TICKS); // snapped
    for (let i = 0; i < 60; i++) c.advance(16, 0, 600 + i);
    expect(c.tick).toBeLessThanOrEqual(659);
    expect(c.tick).toBeGreaterThan(640);
    c.paused = true;
    const before = c.tick;
    c.advance(100, 0, 700);
    expect(c.tick).toBe(before);

    const r = new PlaybackClock();
    r.mode = 'replay';
    r.speed = 2;
    r.advance(1000 / 6, 0, 5400); // ~166 ms ≈ 20 ticks at 2x
    expect(r.tick).toBeCloseTo(20);
    r.advance(10_000, 0, 5400); // long gaps are capped (background tab)
    expect(r.tick).toBeCloseTo(50);
    r.seek(5399);
    r.advance(200, 0, 5400);
    expect(r.tick).toBe(5400);
  });
});

describe('seat palette', () => {
  it('has 8 distinct seat colours plus a neutral, and reads seats from instance ids', () => {
    expect(new Set(SEATS.map((s) => s.color)).size).toBe(8);
    expect(seatStyle(7).seat).toBe(7);
    expect(seatStyle(8).seat).toBe(-1);
    expect(seatOfInstance('2-3-4')).toBe(2);
    expect(seatOfInstance('7-0-0')).toBe(7);
    expect(seatOfInstance('x')).toBe(-1);
  });
});
