// M8.8 client logic without a DOM (elements spec §9, plan §12): status flags,
// tints and the frozen animation tempo; the pooled effect layer (arcs, splash
// rings, beams, pop text) and its caps; the first-battle legend; the status
// icons and aura rings on a fake canvas; the reveal's combat looks; the
// /play cards (element, splash and support chips, the new price rows and
// notes, report lines); money formatting at the $5,000 scale.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CONFIG,
  FRAME_FLAGS,
  computeCost,
  pricingOf,
  type BattleReportDTO,
  type BattleRevealDTO,
  type CostStats,
  type SpriteSpec,
  type StatsSnapshot,
} from '@pixel-clash/shared';
import { ArenaRenderer, combatLook, revealLegendKeys } from '../packages/client/src/common/render/arena.js';
import {
  ARC_MS,
  BOLT_STEPS,
  EffectLayer,
  FROZEN_TEMPO,
  LEGEND_MS,
  LegendTracker,
  MAX_ARCS,
  MAX_BEAMS,
  MAX_POPS,
  MAX_RINGS,
  POP_MS,
  SPLASH_FADE_MS,
  SPLASH_MS,
  animTempo,
  arcAlpha,
  boltPath,
  burnFlickerOn,
  damageColor,
  drawAuraRing,
  drawStatusIcons,
  ELEMENT_COLOR,
  popPose,
  splashRingPose,
  statusIconCount,
  statusOf,
  tintOf,
  tintOutline,
  tintSpec,
  type EffectCanvas,
} from '../packages/client/src/common/render/effects.js';
import { FxLayer, MAX_STATUS_PARTICLES } from '../packages/client/src/common/render/fx.js';
import { ANIM_FRAME_MS, UnitAnimator } from '../packages/client/src/common/render/sprites.js';
import { topUnitLine } from '../packages/client/src/common/topUnits.js';
import { costPanel, savedToast, toDiagnostics } from '../packages/client/src/play/editor/logic.js';
import { breakdownNotes, breakdownRows, budgetText, combatChips, effectReportLines, isSupportOnly, statBars } from '../packages/client/src/play/logic.js';

const pricing = pricingOf(DEFAULT_CONFIG);
const price = (s: CostStats) => computeCost(s, DEFAULT_CONFIG.cost, pricing);

const SOLDIER: CostStats = { type: 'soldier', maxHealth: 600, damage: 50, range: 40, speed: 1.5, attackCooldown: 60, size: 10 };
const SUPPORT_BODY: CostStats = { type: 'soldier', maxHealth: 500, damage: 0, range: 20, speed: 1.5, attackCooldown: 60, size: 10 };

const snap = (extra: Partial<StatsSnapshot> = {}): StatsSnapshot => ({
  name: 'U',
  type: 'soldier',
  maxHealth: 600,
  damage: 50,
  range: 40,
  speed: 1.5,
  attackCooldown: 60,
  color: '#3399FF',
  size: 10,
  shape: 'circle',
  ...extra,
});

/** A canvas that records the calls the effects make. */
function fakeCanvas(): EffectCanvas & { calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  const count = (name: string) => () => {
    calls[name] = (calls[name] ?? 0) + 1;
  };
  return {
    calls,
    globalAlpha: 1,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    beginPath: count('beginPath'),
    moveTo: count('moveTo'),
    lineTo: count('lineTo'),
    closePath: count('closePath'),
    ellipse: count('ellipse'),
    stroke: count('stroke'),
    fill: count('fill'),
    fillRect: count('fillRect'),
    fillText: count('fillText'),
    strokeText: count('strokeText'),
    setLineDash: count('setLineDash'),
  };
}

describe('status flags, tints and tempo (§9)', () => {
  it('decodes the five M8.8 frame flags', () => {
    const f = FRAME_FLAGS.BURNING | FRAME_FLAGS.SHIELDED | FRAME_FLAGS.MOVING;
    expect(statusOf(f)).toEqual({ burning: true, frozen: false, hasted: false, mighty: false, shielded: true });
    expect(statusIconCount(f)).toBe(2);
    expect(statusIconCount(FRAME_FLAGS.MOVING)).toBe(0);
  });

  it('a frozen body animates at 65%; frozen wins the tint over burning', () => {
    expect(animTempo(0)).toBe(1);
    expect(animTempo(FRAME_FLAGS.FROZEN)).toBeCloseTo(FROZEN_TEMPO);
    expect(animTempo(FRAME_FLAGS.FROZEN | FRAME_FLAGS.HASTED)).toBeGreaterThan(FROZEN_TEMPO);
    expect(tintOf(FRAME_FLAGS.FROZEN | FRAME_FLAGS.BURNING)).toBe('ice');
    expect(tintOf(FRAME_FLAGS.BURNING)).toBe('fire');
    expect(tintOf(FRAME_FLAGS.HASTED)).toBe('none');
    expect(tintOutline('ice', '#123456')).toBe('#E8FBFF');
    expect(tintOutline('none', '#123456')).toBe('#123456');
    // The orange outline flickers, except with reduced motion.
    const states = new Set(Array.from({ length: 12 }, (_, i) => burnFlickerOn(i * 110, 0, false)));
    expect(states).toEqual(new Set([true, false]));
    expect(burnFlickerOn(220, 0, true)).toBe(true);
  });

  it('tints a sprite palette toward cyan (frames untouched)', () => {
    const spec: SpriteSpec = { grid: 8, palette: { a: '#000000', b: '#FF0000' }, frames: { idle: [['ab......']] as unknown as SpriteSpec['frames']['idle'] } };
    const ice = tintSpec(spec, 'ice');
    expect(ice.frames).toBe(spec.frames);
    expect(ice.palette.a).not.toBe('#000000');
    const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(ice.palette.a!.slice(i, i + 2), 16));
    expect(b!).toBeGreaterThan(r!);
    expect(g!).toBeGreaterThan(r!);
    expect(spec.palette.a).toBe('#000000');
  });

  it('the animator runs walk/idle loops on the tempo clock', () => {
    const normal = new UnitAnimator('a');
    const frozen = new UnitAnimator('a');
    normal.update(FRAME_FLAGS.MOVING, 0);
    frozen.setTempo(FROZEN_TEMPO, 0);
    frozen.update(FRAME_FLAGS.MOVING, 0);
    const t = ANIM_FRAME_MS * 10;
    const count = () => 4;
    expect(normal.pose(t, count).frame).toBe(10 % 4);
    expect(frozen.pose(t, count).frame).toBe(Math.floor(10 * FROZEN_TEMPO) % 4);
    // Back to normal speed keeps the clock continuous.
    frozen.setTempo(1, t);
    expect(frozen.animTime(t + 100)).toBeCloseTo(t * FROZEN_TEMPO + 100);
    // Never set: the wall clock.
    expect(new UnitAnimator('b').animTime(1234)).toBe(1234);
  });

  it('damage numbers take the element colour; burn ticks are orange', () => {
    expect(damageColor(undefined, undefined, false)).toBe('#FF8A7A');
    expect(damageColor('hit', 'ice', false)).toBe(ELEMENT_COLOR.ice);
    expect(damageColor('burn', 'normal', false)).toBe(ELEMENT_COLOR.fire);
    expect(damageColor('zap', 'lightning', true)).toBe(ELEMENT_COLOR.lightning);
  });
});

describe('effect timing', () => {
  it('splash rings grow then fade; reduced motion shows them full size', () => {
    expect(splashRingPose(0)!.grow).toBe(0);
    expect(splashRingPose(SPLASH_MS)!.grow).toBeCloseTo(1);
    expect(splashRingPose(SPLASH_MS + SPLASH_FADE_MS - 1)!.alpha).toBeLessThan(0.05);
    expect(splashRingPose(SPLASH_MS + SPLASH_FADE_MS)).toBeNull();
    expect(splashRingPose(0, true)!.grow).toBe(1);
  });

  it('arcs fade out within ARC_MS; pop text bounces unless reduced motion', () => {
    expect(arcAlpha(0)).toBe(1);
    expect(arcAlpha(ARC_MS)).toBe(0);
    expect(popPose(POP_MS * 0.25)!.scale).toBeGreaterThan(1);
    expect(popPose(POP_MS * 0.25, true)!.scale).toBe(1);
    expect(popPose(POP_MS)).toBeNull();
  });

  it('a bolt starts and ends exactly on its points, kinks within the amplitude, and repeats per seed', () => {
    const out = new Float32Array((BOLT_STEPS + 1) * 2);
    const n = boltPath(10, 20, 110, 20, 7, 6, out);
    expect(n).toBe(BOLT_STEPS + 1);
    expect([out[0], out[1]]).toEqual([10, 20]);
    expect([out[n * 2 - 2], out[n * 2 - 1]]).toEqual([110, 20]);
    for (let i = 0; i < n; i++) expect(Math.abs(out[i * 2 + 1]! - 20)).toBeLessThanOrEqual(6.0001);
    const again = new Float32Array(out.length);
    boltPath(10, 20, 110, 20, 7, 6, again);
    expect([...again]).toEqual([...out]);
    boltPath(10, 20, 110, 20, 8, 6, again);
    expect([...again]).not.toEqual([...out]);
  });
});

describe('the pooled effect layer (8-player caps)', () => {
  it('never grows past its caps, reuses its slots and empties itself', () => {
    const fx = new EffectLayer();
    const arcs = fx.arcs.items.slice();
    for (let i = 0; i < 500; i++) {
      fx.arc([i, 0, i + 10, 5, i + 20, 0], i);
      fx.ring(i, i, 30, 15, '#fff', i);
      fx.beam(0, 0, i, i, '#5CF08A', i);
      fx.pop(i, i, 'SHATTER!', '#7FE3FF', i);
    }
    expect(fx.arcs.items).toHaveLength(MAX_ARCS);
    expect(fx.arcs.aliveCount).toBe(MAX_ARCS);
    expect(fx.rings.aliveCount).toBe(MAX_RINGS);
    expect(fx.beams.aliveCount).toBe(MAX_BEAMS);
    expect(fx.pops.aliveCount).toBe(MAX_POPS);
    expect(fx.arcs.items.every((a, i) => a === arcs[i])).toBe(true);
    fx.update(500 + 2000);
    expect(fx.arcs.aliveCount + fx.rings.aliveCount + fx.beams.aliveCount + fx.pops.aliveCount).toBe(0);
  });

  it('an overload arc (two hops) is thick; a one-point arc is ignored', () => {
    const fx = new EffectLayer();
    fx.arc([0, 0, 10, 10], 0);
    fx.arc([0, 0, 10, 10, 20, 0], 0);
    fx.arc([0, 0], 0);
    const live = fx.arcs.items.filter((a) => a.alive);
    expect(live.map((a) => [a.n, a.thick])).toEqual([
      [2, false],
      [3, true],
    ]);
  });

  it('draws arcs, beams, pops and rings on a canvas', () => {
    const fx = new EffectLayer();
    fx.arc([0, 0, 50, 0, 80, 30], 0);
    fx.beam(0, 0, 40, 0, '#5CF08A', 0);
    fx.pop(10, 10, 'OVERLOAD!', '#FFE14A', 0);
    fx.ring(0, 0, 40, 20, '#FF8A2A', 0);
    const ctx = fakeCanvas();
    fx.drawGround(ctx, 100, 1);
    fx.drawOver(ctx, 50, 1);
    expect(ctx.calls.fillText ?? 0).toBe(0);
    // Pop text is its own pass, drawn after the damage numbers so they can't cover it.
    fx.drawPops(ctx, 50, 1);
    expect(ctx.calls.ellipse).toBe(1);
    expect(ctx.calls.fillText).toBe(1);
    // The beam (3 strokes) + the bolt (3 strokes: outline, colour, core) + the ring (2).
    expect(ctx.calls.stroke).toBe(8);
    expect(ctx.globalAlpha).toBe(1);
  });

  it('status particles have their own capped pool; flames stop with reduced motion', () => {
    const fx = new FxLayer();
    for (let i = 0; i < 400; i++) {
      fx.flame(0, 0, 20, 1);
      fx.sparkles(0, 0, 20, 1);
      fx.shards(0, 0, 1);
    }
    expect(fx.status.items).toHaveLength(MAX_STATUS_PARTICLES);
    expect(fx.status.aliveCount).toBe(MAX_STATUS_PARTICLES);
    expect(fx.particles.aliveCount).toBe(0);
    const calm = new FxLayer({ reducedMotion: true });
    calm.flame(0, 0, 20, 1);
    calm.frost(0, 0, 20, 1);
    expect(calm.status.aliveCount).toBe(0);
    for (let t = 16; t <= 1500; t += 16) fx.update(16, t);
    expect(fx.status.aliveCount).toBe(0);
  });
});

describe('the first-battle legend', () => {
  it('explains each thing once, keeps lines together for 3 s, and resets per match', () => {
    const l = new LegendTracker();
    expect(l.note('fire', 0)).toBe(true);
    expect(l.note('fire', 10)).toBe(false);
    expect(l.note('ice', 1000)).toBe(true);
    expect(l.lines(1500)).toEqual(['fire', 'ice']);
    expect(l.lines(1000 + LEGEND_MS)).toEqual([]);
    // A later new key starts a fresh box.
    expect(l.note('shatter', 9000)).toBe(true);
    expect(l.lines(9001)).toEqual(['shatter']);
    l.reset();
    expect(l.note('fire', 20000)).toBe(true);
  });

  it('draws the corner box only while lines are due', () => {
    const fx = new EffectLayer();
    const ctx = fakeCanvas();
    fx.drawLegend(ctx, 0, 600, 1);
    expect(ctx.calls.fillText ?? 0).toBe(0);
    fx.legend.note('lightning', 0);
    fx.legend.note('heal', 0);
    fx.drawLegend(ctx, 100, 600, 1);
    expect(ctx.calls.fillText).toBe(2);
  });
});

describe('status icons and aura rings', () => {
  it('stacks the icons above the bar and returns the new top', () => {
    const ctx = fakeCanvas();
    expect(drawStatusIcons(ctx, 0, 100, 50, 1)).toBe(50);
    const top = drawStatusIcons(ctx, FRAME_FLAGS.FROZEN | FRAME_FLAGS.MIGHTY | FRAME_FLAGS.SHIELDED, 100, 50, 1);
    expect(top).toBeLessThan(50);
    // Snowflake (2 strokes) + might arrow (fill) + shield hexagon (stroke).
    expect(ctx.calls.stroke).toBe(3);
    expect(ctx.calls.fill).toBe(1);
  });

  it('an aura ring is a ground ellipse with its kind marks (static with reduced motion)', () => {
    const a = fakeCanvas();
    drawAuraRing(a, 'haste', 0, 0, 60, 30, 1, 0, 0, true);
    expect(a.calls.ellipse).toBe(1);
    expect(a.calls.stroke).toBe(1 + 6);
    const b = fakeCanvas();
    drawAuraRing(b, 'might', 0, 0, 60, 30, 1, 500, 0, false);
    expect(b.calls.fill).toBe(1 + 6);
    expect(b.globalAlpha).toBe(1);
  });
});

describe('reveal combat looks', () => {
  it('reads element, splash and aura (minions: their factory’s minionElement; old units: normal)', () => {
    expect(combatLook(snap({ element: 'fire', splashRadius: 40 }), 'soldier')).toEqual({ element: 'fire', splash: 40, aura: null });
    expect(combatLook(snap({ support: { kind: 'might', power: 30, range: 100 } }), 'soldier').aura).toEqual({ kind: 'might', range: 100 });
    expect(combatLook(snap({ support: { kind: 'heal', power: 60, range: 120 } }), 'soldier').aura).toBeNull();
    expect(combatLook(snap(), 'tower')).toEqual({ element: 'normal', splash: 0, aura: null });
    const fac = snap({ type: 'factory', produces: 'archer', minionElement: 'ice' });
    expect(combatLook(snap(), 'minion', fac).element).toBe('ice');
    expect(combatLook(snap(), 'minion', snap({ type: 'factory', produces: 'medic', minionElement: 'ice' })).element).toBe('normal');
  });

  it('lists the legend lines a battle needs', () => {
    const unit = (stats: StatsSnapshot) => ({ unitId: stats.name, name: stats.name, stats, cost: 1, sprite: null, spriteHidden: false });
    const reveal = {
      round: 1,
      totalTicks: 3600,
      players: [
        {
          playerId: 'p',
          name: 'P',
          seat: 0,
          zone: null,
          units: [
            unit(snap({ name: 'a', element: 'lightning', splashRadius: 30 })),
            unit(snap({ name: 'b', support: { kind: 'shield', power: 20, range: 80 } })),
            unit(snap({ name: 'c', type: 'factory', produces: 'medic' })),
            unit(snap({ name: 'd', type: 'wall', element: 'fire' })),
          ],
          instances: [],
        },
      ],
    } as unknown as BattleRevealDTO;
    expect(revealLegendKeys(reveal).sort()).toEqual(['heal', 'lightning', 'shield', 'splash']);
  });
});

describe('/play cards and the price breakdown (M8.8)', () => {
  it('shows element, splash and support chips; a factory its minions’ element', () => {
    expect(combatChips(snap())).toEqual([]);
    const chips = combatChips(snap({ element: 'ice', splashRadius: 40, support: { kind: 'heal', power: 60, range: 120 } }));
    expect(chips.map((c) => [c.key, c.label])).toEqual([
      ['element', 'Ice'],
      ['splash', 'Splash 40'],
      ['support', 'Heal 60 · 120 px'],
    ]);
    expect(chips[0]!.title).toMatch(/freezes/);
    expect(combatChips(snap({ support: { kind: 'haste', power: 30, range: 100 } }))[0]!.label).toBe('Haste 30%');
    expect(combatChips(snap({ type: 'factory', produces: 'brute', minionElement: 'fire' })).map((c) => c.label)).toEqual(['Fire minions']);
    expect(combatChips(snap({ type: 'wall', element: 'fire' }))).toEqual([]);
    expect(isSupportOnly(snap({ damage: 0, support: { kind: 'might', power: 30, range: 100 } }))).toBe(true);
    expect(isSupportOnly(snap({ support: { kind: 'might', power: 30, range: 100 } }))).toBe(false);
  });

  it('prices the spec reference units and lists their new rows', () => {
    const fire = price({ ...SOLDIER, element: 'fire' });
    expect(fire.cost).toBe(635);
    const fireRows = breakdownRows(fire.breakdown);
    expect(fireRows.map((r) => r.label)).toContain('🔥 Fire ×');
    expect(fireRows.find((r) => r.label === '🔥 Fire ×')!.value).toBe('×1.2');
    expect(fireRows.at(-1)!.value).toBe('$635');

    const mortar = price({ type: 'tower', maxHealth: 625, damage: 100, range: 140, speed: 0, attackCooldown: 60, size: 14, splashRadius: 40 });
    expect(mortar.cost).toBe(1179);
    expect(breakdownRows(mortar.breakdown).find((r) => r.label === 'Splash ×')!.value).toBe('×1.53');
    expect(breakdownRows(mortar.breakdown).at(-1)!.value).toBe('$1,179');

    const medic = price({ ...SUPPORT_BODY, support: { kind: 'heal', power: 60, range: 120 } });
    expect(medic.cost).toBe(759);
    const medicRows = breakdownRows(medic.breakdown);
    expect(medicRows.findIndex((r) => r.label === '💚 Heal')).toBeLessThan(medicRows.findIndex((r) => r.label === 'Sum'));

    const drummer = price({ ...SUPPORT_BODY, support: { kind: 'might', power: 30, range: 100 } });
    expect(drummer.cost).toBe(603);
    const drumRows = breakdownRows(drummer.breakdown);
    expect(drumRows.findIndex((r) => r.label === '💪 Aura +')).toBe(drumRows.length - 2);
    expect(breakdownNotes(drummer.breakdown)).toContain(drummer.breakdown.aura!.text);
  });

  it('the editor panel lists the multipliers and the curve follows curveK', () => {
    const b = price({ ...SOLDIER, maxHealth: 1750, damage: 265, element: 'fire', splashRadius: 40 }).breakdown;
    const p = costPanel(b, 2500);
    expect(p.extras.map((x) => x.label)).toEqual(['Tough + strong', 'Splash 40', 'Element fire']);
    expect(p.extras[0]!.price).toBe('×1.37');
    expect(p.maxMultiple).toBe(2);
    const healer = costPanel(price({ ...SUPPORT_BODY, support: { kind: 'heal', power: 60, range: 120 } }).breakdown, 2500);
    expect(healer.rows.map((r) => r.label)).toContain('Heal');
    const drummer = costPanel(price({ ...SUPPORT_BODY, support: { kind: 'might', power: 30, range: 100 } }).breakdown, 2500);
    expect(drummer.extras.at(-1)!.price).toMatch(/^\+\$\d+(\.\d+)?$/);
    expect(breakdownNotes(b)[0]).toMatch(/^Power ×1\.37/);
  });

  it('formats money and stats with thousands separators', () => {
    expect(budgetText(4998, 5000)).toBe('$4,998 / $5,000 — $2 left');
    expect(budgetText(5200, 5000)).toBe('$5,200 / $5,000 — $200 too much!');
    expect(savedToast(3, 1198, false, 'Mortar')).toBe('Saved v3 — $1,198');
    expect(statBars(snap({ maxHealth: 2500 }))[0]!.display).toBe('2,500');
    expect(topUnitLine({ damage: 12480, kills: 3, healing: 1500 })).toBe('12,480 damage · 3 KOs · 1,500 healed');
  });

  it('turns the report’s damage split, healing and assist into lines', () => {
    const report = {
      types: [
        { name: 'Fire Soldier', type: 'soldier', damageDealt: 3000, damageSplit: { hit: 2000, splash: 0, burn: 1000, zap: 0, shatter: 0 } },
        { name: 'Basic Soldier', type: 'soldier', damageDealt: 900, damageSplit: { hit: 900, splash: 0, burn: 0, zap: 0, shatter: 0 } },
        { name: 'Field Medic', type: 'soldier', damageDealt: 0, healing: 1240, cleanses: 2 },
        { name: 'War Drummer', type: 'soldier', damageDealt: 0, assist: 1240.4 },
      ],
    } as unknown as BattleReportDTO;
    expect(effectReportLines(report)).toEqual([
      'Fire Soldier: 🔥 1,000 burn (of 3,000 damage)',
      '💚 Field Medic healed 1,240 HP and put out 2 fires or freezes',
      "📯 War Drummer's aura helped with 1,240 damage (extra damage dealt or damage blocked)",
    ]);
    expect(effectReportLines(null)).toEqual([]);
  });
});

describe('the code editor marks the new stats', () => {
  it('puts a squiggle on supportPower, element and splashRadius issues', () => {
    const src = `export default class U {
  constructor() {
    this.name = 'Patch'; this.type = 'soldier'; this.maxHealth = 500; this.damage = 0;
    this.element = 'lightening';
    this.splashRadius = 120;
    this.support = 'heal';
    this.supportPower = 999;
    this.supportRange = 120;
  }
  update() { return { action: 'idle' }; }
}`;
    const err = (field: string) => ({ code: 'STAT_OUT_OF_RANGE', field, message: `${field} is out of range`, fix: 'Lower it' });
    const result = { ok: false, errors: [err('element'), err('splashRadius'), err('supportPower')], warnings: [] } as unknown as Parameters<typeof toDiagnostics>[0];
    const { diagnostics, banner } = toDiagnostics(result, src);
    expect(banner).toEqual([]);
    expect(diagnostics.map((d) => src.slice(d.from, d.to))).toEqual(["'lightening'", '120', '999']);
  });
});

describe('reduced motion reaches every arena (M8.8 effects on /play)', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** An arena on a do-nothing canvas, with prefers-reduced-motion set to `reduce`. */
  function arenaWith(reduce: boolean, options: ConstructorParameters<typeof ArenaRenderer>[1] = {}): ArenaRenderer {
    vi.stubGlobal('window', { devicePixelRatio: 1 });
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: reduce && q === '(prefers-reduced-motion: reduce)' }));
    const ctx = new Proxy({} as Record<string, unknown>, { get: (t, k) => (k in t ? t[k as string] : () => undefined), set: (t, k, v) => ((t[k as string] = v), true) });
    const canvas = { width: 0, height: 0, getContext: () => ctx, getBoundingClientRect: () => ({ width: 320, height: 240 }) };
    return new ArenaRenderer(canvas as unknown as HTMLCanvasElement, options);
  }

  it('an arena built without reducedMotion (the /play battle, replay and mini-map) follows prefers-reduced-motion', () => {
    // The /play store and the mini-map pass no reducedMotion: the default is the viewer's setting.
    expect(arenaWith(true, { fit: { margin: 4, pad: 24 }, rallyFlags: 'mine' }).effects.reducedMotion).toBe(true);
    expect(arenaWith(false, { fit: { margin: 4, pad: 24 }, rallyFlags: 'mine' }).effects.reducedMotion).toBe(false);
    // An explicit option still wins.
    expect(arenaWith(true, { reducedMotion: false }).effects.reducedMotion).toBe(false);
  });
});
