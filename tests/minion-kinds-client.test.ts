// M8.6 client logic without a DOM (plan §12.5): minion-kind looks, the
// factory `fac` entry with stored / burst / order, the stored badge, the
// /play factory card (kind chip, burst, orders), breakdown rows per kind,
// the /screen army bars with per-kind minion values and stored minions, the
// release sound and the admin cost preview of each kind's factory.

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, computeCost, pricingOf, type BattleRevealDTO, type FrameFactory, type StatsSnapshot } from '@pixel-clash/shared';
import { costPreview } from '../packages/client/src/admin/quickSettings.js';
import { KIND_ICON, factoryWorth, kindPlural, minionLook, productionRing, storedBadgeText } from '../packages/client/src/common/render/buildings.js';
import { SFX, SFX_MIN_GAP_MS } from '../packages/client/src/common/sfx.js';
import { costPanel } from '../packages/client/src/play/editor/logic.js';
import { breakdownRows, burstText, factoryKindChip, ordersText, typeTitle } from '../packages/client/src/play/logic.js';
import { armyValues } from '../packages/client/src/screen/model.js';

const factory = (extra: Partial<StatsSnapshot> = {}): StatsSnapshot => ({
  name: 'Fac',
  type: 'factory',
  maxHealth: 360,
  damage: 0,
  range: 0,
  speed: 0,
  attackCooldown: 0,
  productionInterval: 600,
  color: '#C0A060',
  size: 18,
  shape: 'square',
  ...extra,
});

describe('factory frames (§9.3 Frames, M8.6)', () => {
  it('decodes stored, burst and order; older entries read as 0 stored, burst 1, attack', () => {
    const now: FrameFactory = ['f', 40, 3, 500, 510, 0, 3, 2, 4, 2];
    expect(productionRing(now)).toMatchObject({ stored: 2, burst: 4, order: 'swarm', rally: { x: 500, y: 510 } });
    expect(productionRing(['f', 40, 3, 500, 510, 0, 3, 0, 1, 3]).order).toBe('guard');
    expect(productionRing(['f', 40, 3, 500, 510, 0, 3, 0, 1, 1]).order).toBe('defend');
    expect(productionRing(['f', 40, 3, 500, 510, 0])).toMatchObject({ stored: 0, burst: 1, order: 'attack' });
    // Worth = canMake + stored (minionsLeft in frames before canMake).
    expect(factoryWorth(now)).toBe(5);
    expect(factoryWorth(['f', 40, 3, 500, 510, 0])).toBe(3);
  });

  it('the stored badge reads "stored/burst", none when empty', () => {
    expect(storedBadgeText(3, 4)).toBe('3/4');
    expect(storedBadgeText(2, 2)).toBe('2/2');
    expect(storedBadgeText(0, 4)).toBeNull();
  });
});

describe('minion kind looks (§5.3)', () => {
  it('each kind has its own tinted sprite and bake key (grunts keep the M8.5 key)', () => {
    const looks = (['grunt', 'archer', 'runner', 'brute'] as const).map((k) => minionLook('#33aa55', k));
    expect(looks.map((l) => l.key)).toEqual(['minion:#33AA55', 'minion-archer:#33AA55', 'minion-runner:#33AA55', 'minion-brute:#33AA55']);
    expect(new Set(looks.map((l) => JSON.stringify(l.spec.frames.idle))).size).toBe(4);
    for (const l of looks) expect(l.spec.palette.b).toBe('#33AA55');
    expect(minionLook('#33AA55').key).toBe('minion:#33AA55');
    expect(KIND_ICON).toEqual({ grunt: '👊', archer: '🎯', runner: '💨', brute: '🔨', medic: '💚' });
    expect(kindPlural('brute')).toBe('Brutes');
  });
});

describe('/play factory card (§12.5 M8.6)', () => {
  it('shows the kind chip, the burst and the orders its code gives', () => {
    expect(factoryKindChip(factory({ produces: 'archer' }))).toEqual({ kind: 'archer', icon: '🎯', label: 'Archers' });
    expect(factoryKindChip(factory())).toEqual({ kind: 'grunt', icon: '👊', label: 'Grunts' });
    expect(burstText(factory({ burst: 3 }))).toBe('Burst 3');
    expect(burstText(factory())).toBe('one at a time');
    expect(ordersText(['swarm', 'attack'])).toBe('Orders: swarm, attack');
    expect(ordersText(undefined)).toBe('Orders: attack');
    expect(ordersText([])).toBe('Orders: attack');
    expect(typeTitle(factory({ produces: 'runner' }))).toBe('🏭 factory · 💨 Runners');
    expect(typeTitle({ type: 'wall' })).toBe('🧱 wall');
  });

  it('the price pop-up and the editor panel name the kind', () => {
    const b = computeCost({ ...factory({ produces: 'archer' }) }, DEFAULT_CONFIG.cost, pricingOf(DEFAULT_CONFIG)).breakdown;
    const rows = breakdownRows(b);
    // The Basic Factory's $247 body + 11 archers × $216.
    expect(rows.find((r) => r.label === 'Archers')!.value).toBe('11 × $216');
    expect(rows.at(-1)!.value).toBe('$2,623');
    expect(costPanel(b, 3000).rows.map((r) => r.label)).toEqual(['Base', 'Health', 'Archers']);
  });
});

describe('/screen army bars with minion kinds (§9.3)', () => {
  const reveal: BattleRevealDTO = {
    round: 1,
    totalTicks: 5400,
    minion: { stats: { ...factory(), type: 'minion', name: 'Grunt', maxHealth: 40, size: 8 }, value: 28 },
    minions: {
      archer: { stats: { ...factory(), type: 'minion', name: 'Archer', maxHealth: 24, range: 110, size: 7 }, value: 35 },
    },
    players: [
      {
        playerId: 'a',
        name: 'Ann',
        seat: 0,
        zone: 'TL',
        units: [
          { unitId: 'arch', name: 'Archer Nest', cost: 228, bodyCost: 53, stats: factory({ produces: 'archer', burst: 3 }), sprite: null, spriteHidden: false },
          { unitId: 'gru', name: 'Grunt Works', cost: 193, bodyCost: 53, stats: factory(), sprite: null, spriteHidden: false },
        ],
        instances: [
          { instanceId: '0-0-0', unitId: 'arch', x: 1, y: 1 },
          { instanceId: '0-0-1', unitId: 'gru', x: 1, y: 1 },
        ],
      },
    ],
  };

  it("counts each factory's minions at its kind's value, stored ones included", () => {
    const alive = new Set(['0-0-0', '0-0-1', '0-0-0-m1', '0-0-1-m1']);
    // The archer factory: 2 left to make + 2 stored inside = 4 × $35; the grunt factory 3 × $28.
    const v = armyValues(reveal, alive, { factoryLeft: new Map([['0-0-0', factoryWorth(['0-0-0', 0, 2, 0, 0, 0, 2, 2, 3, 0])], ['0-0-1', 3]]) })[0]!;
    expect(v.living).toBe(53 + 4 * 35 + 35 + (53 + 3 * 28) + 28);
    expect(v.minions).toBe(2);
  });
});

describe('release sound and admin preview (M8.6)', () => {
  it('has a short release whoosh with a min gap', () => {
    expect(SFX.release.length).toBeGreaterThan(0);
    for (const s of SFX.release) expect(s.gain).toBeLessThanOrEqual(0.5);
    expect(SFX_MIN_GAP_MS.release).toBeGreaterThan(0);
  });

  it("previews each kind's factory price from the draft config", () => {
    const by = Object.fromEntries(costPreview(DEFAULT_CONFIG).rows.map((r) => [r.key, r.cost]));
    // The Basic Factory ($247 body, 11 minions) building each kind: grunt $177, archer $216, runner and brute $263.
    expect(by).toMatchObject({ basicFactory: 247 + 11 * 177, archerFactory: 247 + 11 * 216, runnerFactory: 247 + 11 * 263, bruteFactory: 247 + 11 * 263 });
  });
});
