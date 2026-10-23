// /play page logic (plan §12.1) that runs without a DOM: the zone grid in its
// true orientation, placement taps (budget, copies, swap, remove), "Copy last
// layout", selection toggling, stat bars incl. size, cost breakdown rows,
// "Ask Claude" prompts, Claude terminal links and the join form helpers.

import { describe, expect, it } from 'vitest';
import {
  CORNERS,
  DEFAULT_CONFIG,
  cellCenter,
  computeCost,
  zoneRect,
  type BattleReportErrorDTO,
  type PlacementDTO,
  type StatsSnapshot,
  type UnitCardDTO,
} from '@pixel-clash/shared';
import {
  breakdownRows,
  budgetText,
  cellFill,
  claudeBoxHost,
  claudeTerminalUrl,
  copiesOf,
  copyLastLayout,
  errorPrompt,
  groupErrors,
  nameProblem,
  pinKey,
  scoreLines,
  scoreParts,
  spentOf,
  statBars,
  tapCell,
  toggleSelection,
  towardCentre,
  unitPrompts,
  zoneGrid,
  type PlacementRules,
} from '../packages/client/src/play/logic.js';

const soldier: StatsSnapshot = {
  name: 'Basic Soldier',
  type: 'soldier',
  maxHealth: 120,
  damage: 10,
  range: 40,
  speed: 1.5,
  attackCooldown: 60,
  color: '#3366FF',
  size: 10,
  shape: 'circle',
};

function card(unitId: string, cost: number, extra: Partial<UnitCardDTO> = {}): UnitCardDTO {
  const c = computeCost(soldier, DEFAULT_CONFIG.cost);
  return {
    unitId,
    name: unitId,
    version: 1,
    stats: soldier,
    cost,
    breakdown: c.breakdown,
    status: 'valid',
    warnings: [],
    isTemplate: false,
    sprite: null,
    spriteHidden: false,
    selected: false,
    updatedAt: 0,
    ...extra,
  };
}

const rules = (costs: Record<string, number>, budget = 1000, maxCopies = 12): PlacementRules => ({
  costs: new Map(Object.entries(costs)),
  budget,
  maxCopies,
});

describe('zone grid orientation (§9, §12.1)', () => {
  it('lists all 36 cells once, with (0,0) in the corner nearest the centre', () => {
    for (const corner of CORNERS) {
      const g = zoneGrid(corner);
      expect(g).toHaveLength(36);
      expect(new Set(g.map((c) => `${c.col},${c.row}`)).size).toBe(36);
      const origin = g.find((c) => c.col === 0 && c.row === 0)!;
      const dir = towardCentre(corner);
      expect(origin.gx).toBe(dir.dx > 0 ? 5 : 0);
      expect(origin.gy).toBe(dir.dy > 0 ? 5 : 0);
    }
  });

  it('draws each cell where it sits in the top-down arena', () => {
    for (const corner of CORNERS) {
      const r = zoneRect(corner);
      for (const c of zoneGrid(corner)) {
        const p = cellCenter(corner, c.col, c.row);
        expect(p.x).toBe(r.x + c.gx * 40 + 20);
        expect(p.y).toBe(r.y + c.gy * 40 + 20);
      }
    }
  });

  it('scales sprites by size: size 20 fills a cell, size 10 half of it', () => {
    expect(cellFill({ type: 'soldier', size: 20 })).toBe(1);
    expect(cellFill({ type: 'soldier', size: 10 })).toBe(0.5);
    expect(cellFill({ type: 'tower', size: 6 })).toBeCloseTo(0.3);
  });
});

describe('placement taps (§12.1)', () => {
  const r = rules({ a: 300, b: 450 });

  it('places, removes on a second tap and removes with nothing chosen', () => {
    const one = tapCell([], 0, 0, 'a', r);
    expect(one).toEqual({ ok: true, placements: [{ unitId: 'a', col: 0, row: 0 }] });
    const placed = (one as { placements: PlacementDTO[] }).placements;
    expect(tapCell(placed, 0, 0, 'a', r)).toMatchObject({ ok: true, placements: [], removed: true });
    expect(tapCell(placed, 0, 0, null, r)).toMatchObject({ ok: true, placements: [], removed: true });
  });

  it('tapping a placed unit removes it even when a different unit is chosen (§12.1)', () => {
    const res = tapCell([{ unitId: 'a', col: 1, row: 2 }], 1, 2, 'b', r);
    expect(res).toEqual({ ok: true, placements: [], removed: true });
  });

  it('refuses going over budget, with how much is left', () => {
    const p: PlacementDTO[] = [
      { unitId: 'b', col: 0, row: 0 },
      { unitId: 'a', col: 1, row: 0 },
    ];
    const res = tapCell(p, 2, 0, 'a', r);
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ code: 'OVER_BUDGET' });
    expect((res as { message: string }).message).toContain('$250 left');
  });

  it('refuses more than maxCopies, units not in the palette, and an empty palette choice', () => {
    const small = rules({ a: 1 }, 1000, 2);
    const p: PlacementDTO[] = [
      { unitId: 'a', col: 0, row: 0 },
      { unitId: 'a', col: 1, row: 0 },
    ];
    expect(tapCell(p, 2, 0, 'a', small)).toMatchObject({ ok: false, code: 'TOO_MANY_COPIES' });
    expect(tapCell([], 0, 0, 'zzz', small)).toMatchObject({ ok: false, code: 'NOT_SELECTED' });
    expect(tapCell([], 0, 0, null, small)).toMatchObject({ ok: false, code: 'NOT_SELECTED' });
    expect(tapCell([], 6, 0, 'a', small)).toMatchObject({ ok: false, code: 'CELL_OUT_OF_ZONE' });
  });

  it('sums the spend and copies, and words the budget bar', () => {
    const p: PlacementDTO[] = [
      { unitId: 'a', col: 0, row: 0 },
      { unitId: 'a', col: 1, row: 0 },
      { unitId: 'b', col: 2, row: 0 },
    ];
    expect(spentOf(p, r.costs)).toBe(1050);
    expect(copiesOf(p).get('a')).toBe(2);
    expect(budgetText(937, 1000)).toBe('$937 / $1,000 — $63 left');
    expect(budgetText(1050, 1000)).toContain('$50 too much');
  });
});

describe('Copy last layout', () => {
  it('keeps units still in the palette, in order, within budget and copies', () => {
    const last: PlacementDTO[] = [
      { unitId: 'a', col: 0, row: 0 },
      { unitId: 'gone', col: 1, row: 0 },
      { unitId: 'b', col: 2, row: 0 },
      { unitId: 'b', col: 3, row: 0 },
      { unitId: 'a', col: 0, row: 0 }, // duplicate cell
    ];
    const res = copyLastLayout(last, rules({ a: 300, b: 400 }));
    expect(res.placements).toEqual([
      { unitId: 'a', col: 0, row: 0 },
      { unitId: 'b', col: 2, row: 0 },
    ]);
    expect(res.dropped).toBe(3);
    expect(copyLastLayout(null, rules({ a: 1 }))).toEqual({ placements: [], dropped: 0 });
  });
});

describe('selection toggle (PLAN, max 3)', () => {
  it('adds, removes, refuses a 4th and refuses invalid units', () => {
    expect(toggleSelection([], card('a', 1), 3)).toEqual({ ok: true, selection: ['a'] });
    expect(toggleSelection(['a', 'b'], card('a', 1), 3)).toEqual({ ok: true, selection: ['b'] });
    expect(toggleSelection(['a', 'b', 'c'], card('d', 1), 3)).toEqual({ ok: false, reason: 'full' });
    expect(toggleSelection([], card('x', 1, { status: 'invalid' }), 3)).toEqual({ ok: false, reason: 'invalid' });
    // An invalid unit that is somehow selected can still be dropped.
    expect(toggleSelection(['x'], card('x', 1, { status: 'invalid' }), 3)).toEqual({ ok: true, selection: [] });
  });
});

describe('stat bars and cost breakdown', () => {
  it('shows six bars including size, scaled to the bounds', () => {
    const bars = statBars(soldier);
    expect(bars.map((b) => b.key)).toEqual(['hp', 'damage', 'range', 'speed', 'rate', 'size']);
    const by = Object.fromEntries(bars.map((b) => [b.key, b]));
    expect(by.hp!.frac).toBeCloseTo(120 / 500);
    expect(by.size!.display).toBe('10');
    expect(by.size!.frac).toBeCloseTo(10 / 20);
    expect(by.rate!.display).toBe('1/s');
    expect(statBars({ ...soldier, type: 'tower', speed: 0 })[3]!.display).toBe('tower');
    for (const b of bars) expect(b.frac).toBeGreaterThanOrEqual(0);
  });

  it('lists every term, the sum, the factor and the cost', () => {
    const { breakdown } = computeCost({ ...soldier, attackCooldown: 30 }, DEFAULT_CONFIG.cost);
    const rows = breakdownRows(breakdown);
    expect(rows.map((r) => r.label)).toEqual(['Base', 'Health', 'Damage', 'Range', 'Speed', 'Size', 'Sum', 'Fast-attack ×', 'Cost']);
    expect(rows.find((r) => r.label === 'Sum')!.value).toBe('91.14');
    expect(rows.find((r) => r.label === 'Fast-attack ×')!.value).toBe('×2');
    expect(rows.at(-1)!.value).toBe('$183');
  });
});

describe('"Ask Claude" prompts (RESULTS)', () => {
  const err = (over: Partial<BattleReportErrorDTO> = {}): BattleReportErrorDTO => ({
    unitId: 'u1',
    instanceId: '0-0-0',
    unitName: 'Zappy',
    tick: 10,
    message: "Cannot read properties of undefined (reading 'x')",
    line: 12,
    ...over,
  });

  it('builds the plan wording, with or without a line', () => {
    expect(errorPrompt(err())).toBe("My unit Zappy had an error at line 12: 'Cannot read properties of undefined (reading 'x')'. Please fix it.");
    expect(errorPrompt(err({ line: undefined }))).toBe(
      "My unit Zappy had an error: 'Cannot read properties of undefined (reading 'x')'. Please fix it.",
    );
  });

  it('groups repeats of the same error', () => {
    const g = groupErrors([err(), err({ instanceId: '0-1-0' }), err({ line: 3 })]);
    expect(g).toHaveLength(2);
    expect(g[0]!.count).toBe(2);
  });

  it('suggests prompts for napping units and units that did no damage', () => {
    const roster = [
      card('nap', 1, { name: 'Sleepy', lastBattle: { round: 2, survived: 0, fielded: 2, damageDealt: 5, kills: 0, valueDestroyed: 0, strikes: 30, disabled: 1 } }),
      card('idle', 1, { name: 'Lazy', lastBattle: { round: 2, survived: 2, fielded: 2, damageDealt: 0, kills: 0, valueDestroyed: 0, strikes: 0, disabled: 0 } }),
      card('old', 1, { name: 'Old', lastBattle: { round: 1, survived: 0, fielded: 1, damageDealt: 0, kills: 0, valueDestroyed: 0, strikes: 0, disabled: 1 } }),
    ];
    const prompts = unitPrompts(roster, 2, null);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('Sleepy');
    expect(prompts[1]).toContain('Lazy');
  });
});

describe('Claude terminal links (§11.1)', () => {
  it('builds http://<box>:768N for seats 1-8 from any address form', () => {
    expect(claudeTerminalUrl('192.168.8.20', 1)).toBe('http://192.168.8.20:7781');
    expect(claudeTerminalUrl('http://claude-box.local:8080/', 4)).toBe('http://claude-box.local:7784');
    expect(claudeTerminalUrl('[fe80::1]:7781', 2)).toBe('http://[fe80::1]:7782');
    expect(claudeTerminalUrl('192.168.8.20', 8)).toBe('http://192.168.8.20:7788');
    expect(claudeTerminalUrl('192.168.8.20', 9)).toBeNull();
    expect(claudeTerminalUrl('192.168.8.20', 0)).toBeNull();
    expect(claudeTerminalUrl('', 1)).toBeNull();
    expect(claudeBoxHost('javascript:alert(1)')).toBeNull();
    expect(claudeBoxHost('bad host!')).toBeNull();
  });
});

describe('join form helpers', () => {
  it('checks names like the server (1-16 letters, digits, space, - and _)', () => {
    expect(nameProblem('Ninja Sam')).toBeNull();
    expect(nameProblem('  ')).not.toBeNull();
    expect(nameProblem('a'.repeat(17))).not.toBeNull();
    expect(nameProblem('bad<name>')).not.toBeNull();
  });

  it('types at most 4 digits and supports backspace', () => {
    let pin = '';
    for (const k of ['1', '2', 'x', '3', '4', '5']) pin = pinKey(pin, k);
    expect(pin).toBe('1234');
    expect(pinKey(pin, 'back')).toBe('123');
    expect(pinKey(pin, 'clear')).toBe('');
  });
});

describe('round score in friendly language (§9, §12.4)', () => {
  it('explains each part of the points', () => {
    const lines = scoreLines({ place: 2, placePoints: 2, damage: 411.6, damageBonus: 2, valueDestroyed: 300, valueBonus: 1 });
    expect(lines.map((l) => l.text)).toEqual([
      'You came 2nd: +2 points!',
      'You dealt 412 damage: +2 points!',
      'You knocked out $300 of enemy units: +1 point!',
    ]);
    expect(lines.reduce((s, l) => s + l.points, 0)).toBe(5);
    const none = scoreLines({ place: 1, placePoints: 3, damage: 40, damageBonus: 0, valueDestroyed: 0, valueBonus: 0 });
    expect(none[0]!.text).toBe('You came 1st: +3 points!');
    expect(none[1]!.text).toBe('You dealt 40 damage: +0 points. Hit harder for a bonus!');
    expect(none[2]!.text).toContain('No knockouts this time');
  });

  it('a result saved before the scoring metrics reads as place points only (no undefined / NaN)', () => {
    const legacy = { place: 1, pointsGained: 3 };
    expect(scoreParts(legacy)).toEqual({
      place: 1, pointsGained: 3, placePoints: 3, damage: 0, damageBonus: 0, valueDestroyed: 0, valueBonus: 0, badges: [],
    });
    const lines = scoreLines(legacy).map((l) => l.text);
    expect(lines).toEqual([
      'You came 1st: +3 points!',
      'No damage this time: +0 points. Next battle!',
      'No knockouts this time: +0 points. Next battle!',
    ]);
    expect(lines.join(' ')).not.toMatch(/undefined|NaN/);
  });
});
