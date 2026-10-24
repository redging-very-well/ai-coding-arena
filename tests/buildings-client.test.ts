// M8.5 client logic without a DOM (plan §12.5): walls carried between frames,
// the iso wall block, minions and factory rings, the grouped 4 + 4 roster,
// placement copy caps and W_TRAPPED, building cards and cost breakdowns, the
// editor cost panel, /screen living-value army bars and the admin quick
// settings for walls and factories.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  FRAME_FLAGS,
  computeCost,
  pricingOf,
  type BattleRevealDTO,
  type FrameDTO,
  type FrameUnit,
  type SpriteSpec,
  type StatsSnapshot,
  type UnitType,
} from '@pixel-clash/shared';
import { QUICK_FIELDS, costPreview, getPath } from '../packages/client/src/admin/quickSettings.js';
import { bodyOf, dropRank, showsHpBar } from '../packages/client/src/common/render/arena.js';
import {
  minionFactoryId,
  minionLook,
  onCrack,
  productionRing,
  renderWallBlock,
  wallCrackLevel,
} from '../packages/client/src/common/render/buildings.js';
import { FxLayer } from '../packages/client/src/common/render/fx.js';
import { FrameBuffer } from '../packages/client/src/common/render/playback.js';
import { UnitAnimator } from '../packages/client/src/common/render/sprites.js';
import { SFX, sfxDuration } from '../packages/client/src/common/sfx.js';
import { costPanel } from '../packages/client/src/play/editor/logic.js';
import {
  DEFAULT_PLAY_CAPS,
  breakdownRows,
  capsFromRules,
  copyCounterText,
  copyCounts,
  copyLastLayout,
  factoryLines,
  factoryReportLines,
  groupFullText,
  overCapText,
  onlyWallsPicked,
  pickCounterText,
  pickCounts,
  planReadyView,
  statBars,
  stuckPrompts,
  tapCell,
  toggleGroupedSelection,
  trappedKeys,
  typeLookup,
  type PlacementRules,
} from '../packages/client/src/play/logic.js';
import { WALLS_CAPTION, armyValues, revealHasWalls } from '../packages/client/src/screen/model.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const frame = (t: number, units: FrameUnit[], extra: Partial<FrameDTO> = {}): FrameDTO => ({ t, units, projectiles: [], safeZoneRadius: 570, events: [], ...extra });

function snap(type: UnitType, extra: Partial<StatsSnapshot> = {}): StatsSnapshot {
  const base: StatsSnapshot = { name: type, type, maxHealth: 100, damage: 10, range: 40, speed: 1.5, attackCooldown: 60, color: '#8A8F98', size: 10, shape: 'circle' };
  if (type === 'wall') return { ...base, maxHealth: 3200, damage: 0, range: 0, speed: 0, attackCooldown: 0, size: 20, shape: 'square', ...extra };
  if (type === 'factory') return { ...base, maxHealth: 2400, damage: 0, range: 0, speed: 0, attackCooldown: 0, size: 18, productionInterval: 600, color: '#C0A060', ...extra };
  if (type === 'tower') return { ...base, speed: 0, size: 14, ...extra };
  return { ...base, ...extra };
}

const WALL_SPRITE: SpriteSpec = {
  grid: 8,
  palette: { o: '#3A3D44', l: '#B4BAC4', g: '#8A8F98' },
  frames: { idle: [['oooooooo', 'llllllll', 'gggggggg', 'oooooooo', 'llllllll', 'gggggggg', 'oooooooo', 'llllllll']] },
};

/** Cards as the logic sees them (id, status, type). */
const cards = (list: Array<[string, UnitType, ('valid' | 'invalid')?]>) => list.map(([unitId, type, status]) => ({ unitId, status: status ?? 'valid', stats: { type } }) as const);

// ---------------------------------------------------------------------------
// Frames: walls are listed only when they change (§9.3 Frames)
// ---------------------------------------------------------------------------

describe('frame buffer carries walls between the frames that list them', () => {
  it('keeps a wall at its last state, picks up hp changes and drops it on death or crumble', () => {
    const buf = new FrameBuffer();
    buf.setSticky([
      ['w1', 100, 100, 400, 0],
      ['w2', 140, 100, 400, 0],
    ]);
    buf.push([
      frame(0, [['s', 10, 10, 50, 0], ['w1', 100, 100, 400, 0], ['w2', 140, 100, 400, 0]]),
      frame(2, [['s', 12, 10, 50, 0]]),
      frame(4, [['s', 14, 10, 50, 0], ['w1', 100, 100, 300, 0]]),
      frame(6, [['s', 16, 10, 50, 0]], { events: [{ type: 'death', instanceId: 'w1' }] }),
      frame(8, [], { events: [{ type: 'crumble', ids: ['w2'] }] }),
    ]);
    const ids = (t: number) => buf.sample(t)!.units.map((u) => u.id).sort();
    expect(ids(2)).toEqual(['s', 'w1', 'w2']);
    expect(buf.sample(2)!.units.find((u) => u.id === 'w1')!.hp).toBe(400);
    // Between t=2 (400) and t=4 (300) the hp is interpolated, after it stays.
    expect(buf.sample(3)!.units.find((u) => u.id === 'w1')!.hp).toBe(350);
    expect(buf.sample(5)!.units.find((u) => u.id === 'w1')!.hp).toBe(300);
    expect(ids(6)).toEqual(['s', 'w2']);
    expect(ids(8)).toEqual([]);
    // The raw input frames are not changed.
    expect(buf.all[1]!.units).toHaveLength(3);
  });

  it('trusts a late joiner\'s catch-up frame: it lists every living wall, so one it leaves out has fallen', () => {
    const buf = new FrameBuffer();
    buf.setSticky([
      ['w1', 100, 100, 400, 0],
      ['w2', 140, 100, 400, 0],
    ]);
    buf.push([frame(600, [['s', 10, 10, 50, 0], ['w1', 100, 100, 250, 0]]), frame(602, [['s', 11, 10, 50, 0]])]);
    expect(buf.sample(601)!.units.map((u) => u.id).sort()).toEqual(['s', 'w1']);
    expect(buf.sample(602)!.units.find((u) => u.id === 'w1')!.hp).toBe(250);
    buf.clear();
    buf.setSticky([['w1', 100, 100, 400, 0]]);
    buf.push([frame(0, [['s', 10, 10, 50, 0]]), frame(2, [['s', 10, 10, 50, 0]])]);
    expect(buf.sample(2)!.units.map((u) => u.id).sort()).toEqual(['s', 'w1']);
    buf.clear();
    buf.push([frame(0, [['s', 10, 10, 50, 0]])]);
    expect(buf.sample(0)!.units.map((u) => u.id)).toEqual(['s']);
  });

  it('a frame replaced or inserted out of order is filled from the frame before it', () => {
    const buf = new FrameBuffer();
    buf.setSticky([['w1', 100, 100, 400, 0]]);
    buf.push([frame(0, [['w1', 100, 100, 400, 0]]), frame(4, [])]);
    buf.push([frame(2, [])]);
    expect(buf.all.map((f) => f.t)).toEqual([0, 2, 4]);
    expect(buf.sample(2)!.units.map((u) => u.id)).toEqual(['w1']);
    buf.push([frame(4, [['w1', 100, 100, 100, 0]])]);
    expect(buf.sample(4)!.units[0]!.hp).toBe(100);
  });

  it('samples the living factories', () => {
    const buf = new FrameBuffer();
    buf.push([frame(0, [['f', 1, 1, 300, 0]], { fac: [['f', 40, 5, 400, 400, 0]] }), frame(2, [])]);
    expect(buf.sample(1)!.fac).toEqual([['f', 40, 5, 400, 400, 0]]);
    expect(buf.sample(2)!.fac).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Iso wall blocks, minions, factory rings
// ---------------------------------------------------------------------------

describe('wall blocks', () => {
  const block = (crack: 0 | 1 | 2, outline: string | null = '#FF0000') =>
    renderWallBlock({ spec: WALL_SPRITE, color: '#8A8F98', outline, k: 1, height: 40, crack, outlineWidth: 2 });

  it('is the 40×40 footprint as a 2:1 diamond lifted by its height, with two visible sides', () => {
    const b = block(0);
    expect(b.image.width).toBe(80 + 2);
    expect(b.image.height).toBe(40 + 40 + 2);
    const px = (x: number, y: number) => Array.from(b.image.data.slice((y * b.image.width + x) * 4, (y * b.image.width + x) * 4 + 4));
    // The top face centre sits `height` above the ground centre and is opaque; the image corners are empty.
    expect(px(Math.floor(b.groundX), Math.floor(b.groundY - 40))[3]).toBe(255);
    expect(px(0, 0)[3]).toBe(0);
    expect(px(b.image.width - 1, b.image.height - 1)[3]).toBe(0);
    // The left side (below the top face, left of centre) is darker than the top; the right side darker still.
    const lum = (p: number[]) => p[0]! + p[1]! + p[2]!;
    const top = px(Math.floor(b.groundX), Math.floor(b.groundY - 40));
    const left = px(Math.floor(b.groundX - 20), Math.floor(b.groundY - 5));
    const right = px(Math.floor(b.groundX + 20), Math.floor(b.groundY - 5));
    expect(left[3]).toBe(255);
    expect(right[3]).toBe(255);
    expect(lum(left)).toBeLessThan(lum(top));
    expect(lum(right)).toBeLessThan(lum(left));
    // The seat outline runs round the top face.
    const reds = (img: typeof b.image) => {
      let n = 0;
      for (let i = 0; i < img.data.length; i += 4) if (img.data[i] === 255 && img.data[i + 1] === 0 && img.data[i + 2] === 0) n++;
      return n;
    };
    expect(reds(b.image)).toBeGreaterThan(50);
    expect(reds(block(0, null).image)).toBe(0);
  });

  it('cracks below 66% and 33% HP', () => {
    expect(wallCrackLevel(400, 400)).toBe(0);
    expect(wallCrackLevel(265, 400)).toBe(1);
    expect(wallCrackLevel(130, 400)).toBe(2);
    expect(onCrack('left', 0.34, 0.12, 0)).toBe(false);
    expect(onCrack('left', 0.34, 0.12, 1)).toBe(true);
    const diff = (a: ArrayLike<number>, b: ArrayLike<number>) => {
      let n = 0;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
      return n;
    };
    const c0 = block(0).image.data;
    const c1 = block(1).image.data;
    const c2 = block(2).image.data;
    expect(diff(c0, c1)).toBeGreaterThan(0);
    expect(diff(c0, c2)).toBeGreaterThan(diff(c0, c1));
  });
});

describe('minions and factories on the arena', () => {
  it('finds a minion’s factory from its id and tints the built-in sprite', () => {
    expect(minionFactoryId('2-0-3-m4')).toBe('2-0-3');
    expect(minionFactoryId('2-0-3')).toBeNull();
    const look = minionLook('#33aa55');
    expect(look.key).toBe('minion:#33AA55');
    expect(look.spec.palette.b).toBe('#33AA55');
    expect(minionLook('nope').spec.palette.b).toBe('#C0A060');
  });

  it('turns a fac entry into a production ring (grey while holding or done)', () => {
    expect(productionRing(['f', 50, 3, 400, 410, 0])).toEqual({ frac: 0.5, idle: false, minionsLeft: 3, holding: false, rally: { x: 400, y: 410 }, stored: 0, burst: 1, order: 'attack' });
    expect(productionRing(['f', 50, 3, 400, 410, 1]).idle).toBe(true);
    expect(productionRing(['f', 100, 0, 400, 410, 0])).toMatchObject({ frac: 1, idle: true });
  });

  it('drops walls first, then buildings, then soldiers; walls and minions show HP only when hurt', () => {
    expect(['soldier', 'factory', 'wall', 'tower'].sort((a, b) => dropRank(a as UnitType) - dropRank(b as UnitType))).toEqual(['wall', 'factory', 'tower', 'soldier']);
    expect(showsHpBar('wall', 400, 400)).toBe(false);
    expect(showsHpBar('wall', 399, 400)).toBe(true);
    expect(showsHpBar('minion', 40, 40)).toBe(false);
    expect(showsHpBar('soldier', 40, 40)).toBe(true);
    expect(bodyOf({ stats: snap('wall') })).toBe('wall');
    expect(bodyOf({ body: 'minion', stats: snap('soldier') })).toBe('minion');
  });

  it('a factory flashes its door on spawn, a blocked unit walks in place, crumble ends a wall', () => {
    const f = new UnitAnimator('0-0-1');
    f.onEvent({ type: 'spawn', instanceId: '0-0-1-m0', factoryId: '0-0-1', x: 1, y: 1 }, 1000);
    expect(f.pose(1100, () => 1).state).toBe('attack');
    const u = new UnitAnimator('0-0-2');
    u.update(FRAME_FLAGS.BLOCKED, 0);
    expect(u.pose(10, () => 2).state).toBe('walk');
    const w = new UnitAnimator('0-0-3');
    w.onEvent({ type: 'crumble', ids: ['0-0-3'] }, 500);
    expect(w.dead).toBe(true);
    expect(w.pose(500 + 2000, () => 1, true).gone).toBe(true);
  });

  it('effects: a coloured "+1" label, a pop puff and a crumble stay within the pools', () => {
    const fx = new FxLayer();
    fx.label(10, 10, '+1', '#FFD447', 0);
    const label = fx.numbers.items.find((d) => d.alive)!;
    expect(label).toMatchObject({ text: '+1', color: '#FFD447' });
    fx.damageNumber(0, 0, 5, false, 0);
    expect(fx.numbers.items.filter((d) => d.alive && d.color === null)).toHaveLength(1);
    fx.puff(0, 0, 1, ['#fff']);
    fx.crumble(0, 0, 40, 1, ['#888']);
    fx.dust(0, 0, 1);
    expect(fx.particles.aliveCount).toBeGreaterThan(20);
  });

  it('has the wall-hit, crumble and spawn sounds (short and quiet)', () => {
    for (const n of ['wallHit', 'crumble', 'spawn'] as const) {
      expect(SFX[n].length).toBeGreaterThan(0);
      expect(sfxDuration(n)).toBeLessThan(0.5);
    }
  });
});

// ---------------------------------------------------------------------------
// /play: roster (4 units + 4 buildings), Ready, placement caps
// ---------------------------------------------------------------------------

describe('grouped roster picks (§5.2: 4 units + 4 buildings)', () => {
  const roster = cards([
    ['s1', 'soldier'],
    ['s2', 'soldier'],
    ['s3', 'soldier'],
    ['s4', 'soldier'],
    ['s5', 'soldier'],
    ['t1', 'tower'],
    ['w1', 'wall'],
    ['w2', 'wall'],
    ['f1', 'factory'],
    ['f2', 'factory', 'invalid'],
  ]);
  const typeOf = typeLookup(roster);
  const byId = new Map(roster.map((c) => [c.unitId, c]));
  const limits = { unit: 4, building: 4 };

  it('counts each group against its own limit', () => {
    let sel: string[] = [];
    for (const id of ['s1', 's2', 's3', 's4', 't1', 'w1', 'w2', 'f1']) {
      const r = toggleGroupedSelection(sel, byId.get(id)!, typeOf, limits);
      expect(r.ok, id).toBe(true);
      if (r.ok) sel = r.selection;
    }
    expect(pickCounts(sel, typeOf)).toEqual({ unit: 4, building: 4 });
    expect(pickCounterText(pickCounts(sel, typeOf), limits)).toBe('Units 4/4 · Buildings 4/4');
    expect(toggleGroupedSelection(sel, byId.get('s5')!, typeOf, limits)).toEqual({ ok: false, reason: 'full', group: 'unit', max: 4 });
    expect(toggleGroupedSelection(['t1', 'w1', 'w2', 'f1'], byId.get('s5')!, typeOf, limits).ok).toBe(true);
    expect(toggleGroupedSelection(['t1', 'w1', 'w2', 'f1'], { unitId: 'x', status: 'valid', stats: { type: 'tower' } }, typeOf, limits)).toMatchObject({ ok: false, group: 'building' });
    expect(toggleGroupedSelection([], byId.get('f2')!, typeOf, limits)).toEqual({ ok: false, reason: 'invalid' });
    expect(toggleGroupedSelection(sel, byId.get('w1')!, typeOf, limits)).toEqual({ ok: true, selection: sel.filter((x) => x !== 'w1') });
    expect(groupFullText('building', 4)).toMatch(/^4 buildings max/);
    // A picked design revised into the other group can leave a group over its cap (Ready waits).
    expect(overCapText({ unit: 1, building: 5 }, limits)).toBe('You picked 5 buildings; 4 max. Tap one to un-pick it.');
    expect(overCapText({ unit: 4, building: 4 }, limits)).toBeNull();
  });

  it('Ready needs a fighter: only walls picked says so (NO_FIGHTERS)', () => {
    expect(onlyWallsPicked(['w1', 'w2'], typeOf)).toBe(true);
    expect(onlyWallsPicked(['w1', 's1'], typeOf)).toBe(false);
    expect(onlyWallsPicked([], typeOf)).toBe(false);
    const v = planReadyView(2, false, 8, undefined, { onlyWalls: true, counter: 'Units 0/4 · Buildings 2/4' });
    expect(v.enabled).toBe(false);
    expect(v.hint).toMatch(/soldier, tower or factory/);
    expect(planReadyView(2, false, 8, undefined, { counter: 'Units 1/4 · Buildings 1/4' }).hint).toBe('Units 1/4 · Buildings 1/4. Happy with your army? Press Ready!');
    // Already ready with only walls (the server allowed it earlier): un-ready still works.
    expect(planReadyView(2, true, 8, undefined, { onlyWalls: true }).enabled).toBe(true);
  });

  it('reads the 4 + 4 caps from /rules (an older server’s maxTypes caps both)', () => {
    expect(DEFAULT_PLAY_CAPS).toMatchObject({ maxUnitTypes: 4, maxBuildingTypes: 4, maxCopies: 12, maxFactoryCopies: 5, maxWallCopies: 16, copyRamp: { freeCopies: 3, pctPerCopy: 15 } });
    expect(capsFromRules({ maxUnitTypes: 3, maxBuildingTypes: 2, maxWallCopies: 6 }, 900, DEFAULT_PLAY_CAPS)).toMatchObject({
      budget: 900,
      maxUnitTypes: 3,
      maxBuildingTypes: 2,
      maxWallCopies: 6,
      maxFactoryCopies: 5,
      copyRamp: { freeCopies: 3, pctPerCopy: 15 },
    });
    // GET /rules carries the copy ramp next to `caps` (with a text the caps don't keep).
    expect(capsFromRules({}, undefined, DEFAULT_PLAY_CAPS, { freeCopies: 2, pctPerCopy: 10 }).copyRamp).toEqual({ freeCopies: 2, pctPerCopy: 10 });
    expect(capsFromRules({ maxTypes: 3 }, undefined, DEFAULT_PLAY_CAPS)).toMatchObject({ maxUnitTypes: 3, maxBuildingTypes: 3 });
  });
});

describe('placement with buildings', () => {
  const palette = cards([
    ['sol', 'soldier'],
    ['wal', 'wall'],
    ['fac', 'factory'],
  ]);
  const rules: PlacementRules = {
    costs: new Map([
      ['sol', 50],
      ['wal', 10],
      ['fac', 100],
    ]),
    budget: 1000,
    maxCopies: 3,
    typeOf: typeLookup(palette),
    maxWallCopies: 2,
    maxFactoryCopies: 1,
  };

  it('caps fighters, factories and walls separately', () => {
    let p = tapCell([], 0, 0, 'wal', rules);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    p = tapCell(p.placements, 1, 0, 'wal', rules);
    if (!p.ok) throw new Error('second wall');
    const third = tapCell(p.placements, 2, 0, 'wal', rules);
    expect(third).toMatchObject({ ok: false, code: 'TOO_MANY_COPIES', message: "That's the most walls you can place (2)." });
    let q = tapCell(p.placements, 0, 1, 'fac', rules);
    if (!q.ok) throw new Error('factory');
    expect(tapCell(q.placements, 1, 1, 'fac', rules)).toMatchObject({ ok: false, message: "That's the most factories you can place (1)." });
    q = tapCell(q.placements, 1, 1, 'sol', rules);
    if (!q.ok) throw new Error('soldier');
    q = tapCell(q.placements, 2, 1, 'sol', rules);
    if (!q.ok) throw new Error('soldier 2');
    // 3 fighters (factory + 2 soldiers) is the cap; walls never counted in it.
    expect(tapCell(q.placements, 3, 1, 'sol', rules)).toMatchObject({ ok: false, message: "That's the most fighters you can place (3): soldiers, towers and factories together." });
    const counts = copyCounts(q.placements, rules.typeOf);
    expect(counts).toEqual({ fighters: 3, factories: 1, walls: 2 });
    expect(copyCounterText(counts, rules, { walls: true, factories: true })).toBe('Fighters 3/3 · Factories 1/1 · Walls 2/2');
    expect(copyCounterText(counts, rules, { walls: false, factories: false })).toBe('Fighters 3/3');
  });

  it('copies the last layout within the group caps', () => {
    const last = [
      { unitId: 'wal', col: 0, row: 0 },
      { unitId: 'wal', col: 1, row: 0 },
      { unitId: 'wal', col: 2, row: 0 },
      { unitId: 'fac', col: 0, row: 1 },
      { unitId: 'fac', col: 1, row: 1 },
    ];
    const r = copyLastLayout(last, rules);
    expect(r.placements).toHaveLength(3);
    expect(r.dropped).toBe(2);
  });

  it('outlines soldiers and factories boxed in by walls (W_TRAPPED), never towers', () => {
    const typeOf = (id: string) => ({ s: 'soldier', w: 'wall', t: 'tower', f: 'factory' })[id] as UnitType | undefined;
    const ring = [
      { unitId: 'w', col: 1, row: 2 },
      { unitId: 'w', col: 3, row: 2 },
      { unitId: 'w', col: 2, row: 1 },
      { unitId: 'w', col: 2, row: 3 },
    ];
    expect([...trappedKeys('TL', [...ring, { unitId: 's', col: 2, row: 2 }], typeOf)]).toEqual(['2,2']);
    expect([...trappedKeys('TL', [...ring, { unitId: 't', col: 2, row: 2 }], typeOf)]).toEqual([]);
    expect([...trappedKeys('TL', [...ring.slice(1), { unitId: 'f', col: 2, row: 2 }], typeOf)]).toEqual([]);
  });
});

describe('building cards and prices', () => {
  const pricing = pricingOf(DEFAULT_CONFIG);

  it('walls show health only; factories health and build speed', () => {
    const wall = statBars(snap('wall'));
    expect(wall.map((b) => b.key)).toEqual(['hp']);
    expect(wall[0]!.frac).toBeCloseTo(3200 / 12000);
    const fac = statBars(snap('factory'));
    expect(fac.map((b) => b.key)).toEqual(['hp', 'rate']);
    expect(fac[1]!.display).toBe('10 s');
    expect(statBars(snap('factory', { productionInterval: 300 }))[1]!.frac).toBe(1);
    expect(factoryLines(snap('factory'), 11)).toEqual(['1 minion every 10 s', 'makes 11 minions']);
    expect(factoryLines(snap('wall'))).toEqual([]);
  });

  it('the price pop-up and the editor panel show the wall and factory formulas', () => {
    const wall = computeCost({ type: 'wall', maxHealth: 3200, damage: 0, range: 0, speed: 0, attackCooldown: 60 }, DEFAULT_CONFIG.cost, pricing);
    expect(breakdownRows(wall.breakdown)).toEqual([
      { label: 'Base', value: '20' },
      { label: 'Health', value: expect.any(String) },
      { label: 'Cost', value: '$149' },
    ]);
    // The Basic Factory: $247 body + 11 grunts × $177 (7200-tick battle, one every 600 ticks).
    const fac = computeCost({ type: 'factory', maxHealth: 2400, damage: 0, range: 0, speed: 0, attackCooldown: 60, productionInterval: 600 }, DEFAULT_CONFIG.cost, pricing);
    const rows = breakdownRows(fac.breakdown);
    // M8.6: the production row names the minion kind (grunts by default).
    expect(rows.map((r) => r.label)).toEqual(['Base', 'Health', 'Body', 'Grunts', 'Cost']);
    expect(rows.find((r) => r.label === 'Grunts')!.value).toBe('11 × $177');
    expect(rows.at(-1)!.value).toBe('$2,194');
    const panel = costPanel(fac.breakdown, 3000);
    expect(panel.rows.map((r) => r.label)).toEqual(['Base', 'Health', 'Grunts']);
    expect(panel.rows[2]!.price).toBe('11 × $177 = $1,947');
    expect(panel.factor).toBeNull();
    expect(panel.cost).toBe(2194);
    const maxed = computeCost({ type: 'wall', maxHealth: 12000, damage: 0, range: 0, speed: 0, attackCooldown: 60 }, DEFAULT_CONFIG.cost, pricing);
    expect(costPanel(maxed.breakdown, 3000).rows[1]!.nearMax).toBe(true);
  });

  it('the report lists each factory’s minions and turns long wall time into an Ask-Claude prompt', () => {
    const report = {
      types: [
        { unitId: 'f', name: 'Basic Factory', type: 'factory' as const, fielded: 1, survived: 1, damageDealt: 90, kills: 1, minionsMade: 5, minionsLost: 2, minionDamage: 90 },
        { unitId: 's', name: 'Ninja', type: 'soldier' as const, fielded: 2, survived: 0, damageDealt: 0, kills: 0, blockedTicksMax: 2000 },
        { unitId: 'r', name: 'Runner', type: 'soldier' as const, fielded: 2, survived: 0, damageDealt: 0, kills: 0, blockedTicksMax: 100 },
      ],
      hints: [],
    };
    expect(factoryReportLines(report)).toEqual(['🏭 Basic Factory made 5 minions (2 lost), 90 minion damage']);
    const prompts = stuckPrompts(report, 5400);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatch(/My Ninja got stuck behind walls/);
    expect(stuckPrompts({ hints: ['tip'] }, 5400)).toEqual(['tip']);
    expect(factoryReportLines(null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// /screen: army bars use the living value (§9.3)
// ---------------------------------------------------------------------------

describe('/screen army bars with buildings', () => {
  const reveal: BattleRevealDTO = {
    round: 1,
    totalTicks: 5400,
    minion: { stats: { ...snap('soldier'), type: 'minion' }, value: 28 },
    players: [
      {
        playerId: 'a',
        name: 'Ann',
        seat: 0,
        zone: 'TL',
        units: [
          { unitId: 'sol', name: 'Sol', cost: 92, stats: snap('soldier'), sprite: null, spriteHidden: false },
          { unitId: 'wal', name: 'Wall', cost: 32, stats: snap('wall'), sprite: null, spriteHidden: false },
          { unitId: 'fac', name: 'Fac', cost: 193, bodyCost: 53, stats: snap('factory'), sprite: null, spriteHidden: false },
        ],
        instances: [
          { instanceId: '0-0-0', unitId: 'sol', x: 1, y: 1 },
          { instanceId: '0-0-1', unitId: 'wal', x: 1, y: 1 },
          { instanceId: '0-0-2', unitId: 'wal', x: 1, y: 1 },
          { instanceId: '0-0-3', unitId: 'fac', x: 1, y: 1 },
        ],
      },
    ],
  };

  it('counts walls $0, factories body + unmade minions, and living minions', () => {
    expect(armyValues(reveal, null)[0]).toMatchObject({ start: 92 + 193, living: 92 + 193, aliveCount: 2, fieldedCount: 2, walls: 2, minions: 0 });
    // Two minions made (3 left of 5), one of them alive; the soldier died.
    const alive = new Set(['0-0-1', '0-0-2', '0-0-3', '0-0-3-m1']);
    const v = armyValues(reveal, alive, { factoryLeft: new Map([['0-0-3', 3]]) })[0]!;
    expect(v).toMatchObject({ living: 193 - 2 * 28 + 28, aliveCount: 1, minions: 1 });
    // Only walls left: nothing counts.
    expect(armyValues(reveal, new Set(['0-0-1']))[0]).toMatchObject({ living: 0, aliveCount: 0, minions: 0 });
  });

  it("uses the server's body price and canMake, not the default factory config", () => {
    // maxMinionsPerFactory = 4 on the server: a Swarm Factory costs 53 + 4 × 28 = $165.
    const swarm = { ...snap('factory'), productionInterval: 600 };
    const r: BattleRevealDTO = {
      ...reveal,
      players: [{ ...reveal.players[0]!, units: [{ unitId: 'fac', name: 'Swarm', cost: 165, bodyCost: 53, stats: swarm, sprite: null, spriteHidden: false }], instances: [{ instanceId: '0-0-3', unitId: 'fac', x: 1, y: 1 }] }],
    };
    expect(armyValues(r, new Set(['0-0-3']), { factoryLeft: new Map([['0-0-3', 4]]) })[0]).toMatchObject({ start: 165, living: 165 });
    // A held factory that can only build 1 more in time; at the time limit just the body.
    expect(armyValues(r, new Set(['0-0-3']), { factoryLeft: new Map([['0-0-3', 1]]) })[0]!.living).toBe(53 + 28);
    expect(armyValues(r, new Set(['0-0-3']), { factoryLeft: new Map([['0-0-3', 0]]) })[0]!.living).toBe(53);
  });

  it('shows the walls caption only for battles with walls', () => {
    expect(revealHasWalls(reveal)).toBe(true);
    expect(revealHasWalls({ ...reveal, players: [{ ...reveal.players[0]!, instances: [reveal.players[0]!.instances[0]!] }] })).toBe(false);
    expect(WALLS_CAPTION).toBe('Walls protect, but only fighters count!');
  });
});

// ---------------------------------------------------------------------------
// /admin quick settings
// ---------------------------------------------------------------------------

describe('admin quick settings for walls and factories', () => {
  it('has the wall, factory and minion numbers and previews the building templates', () => {
    for (const path of [
      'cost.wall.hp',
      'cost.factory.minionDiscount',
      'stats.bounds.wallHealth.max',
      'stats.bounds.productionInterval.min',
      'factory.maxAlivePerFactory',
      'factory.minions.grunt.maxHealth',
      'factory.minions.grunt.damage',
      'factory.minions.archer.speed',
      'factory.minions.brute.wallDamageMultiplier',
    ]) {
      expect(QUICK_FIELDS.some((f) => f.path === path), path).toBe(true);
      expect(typeof getPath(DEFAULT_CONFIG, path), path).toBe('number');
    }
    const p = costPreview(DEFAULT_CONFIG);
    const by = Object.fromEntries(p.rows.map((r) => [r.key, r]));
    // The $10,000 templates (plan §6): Basic Wall 3,200 HP, Basic Factory 2,400 HP every 600 ticks; Swarm Factory every 300.
    expect(by.basicWall).toMatchObject({ cost: 149, overCap: false, outOfBounds: null, template: true });
    expect(by.basicFactory).toMatchObject({ cost: 2194, overCap: false, outOfBounds: null, template: true });
    expect(by.swarmFactory!.cost).toBe(2371);
    // A wall HP bound below the Basic Wall's 3200 makes it out of bounds.
    const draft = { ...DEFAULT_CONFIG, stats: { bounds: { ...DEFAULT_CONFIG.stats.bounds, wallHealth: { min: 400, max: 2400 } } } };
    expect(costPreview(draft).rows.find((r) => r.key === 'basicWall')!.outOfBounds).toMatch(/maxHealth/);
  });
});
