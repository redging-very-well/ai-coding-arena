import { describe, expect, it } from 'vitest';
import {
  CENTER,
  DEFAULT_CONFIG,
  assignZones,
  cellAt,
  cellCenter,
  edgeDistance,
  inRange,
  instanceIdFor,
  safeZoneRadius,
  zoneCenter,
  zoneRect,
  zoneSetFor,
  type Corner,
} from '@pixel-clash/shared';

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

describe('zones', () => {
  it('are 240×240 corners of the 800×800 arena', () => {
    expect(zoneRect('TL')).toEqual({ x: 0, y: 0, width: 240, height: 240 });
    expect(zoneRect('TR')).toEqual({ x: 560, y: 0, width: 240, height: 240 });
    expect(zoneRect('BR')).toEqual({ x: 560, y: 560, width: 240, height: 240 });
    expect(zoneRect('BL')).toEqual({ x: 0, y: 560, width: 240, height: 240 });
    expect(zoneCenter('TL')).toEqual({ x: 120, y: 120 });
    expect(zoneCenter('BR')).toEqual({ x: 680, y: 680 });
  });

  it('zone sets: 2p TL/BR, 3p TL/TR/BR, 4p all', () => {
    expect(zoneSetFor(2)).toEqual(['TL', 'BR']);
    expect(zoneSetFor(3)).toEqual(['TL', 'TR', 'BR']);
    expect([...zoneSetFor(4)].sort()).toEqual(['BL', 'BR', 'TL', 'TR']);
    expect(() => zoneSetFor(5)).toThrow();
  });
});

describe('zone-local cells', () => {
  const corners: Corner[] = ['TL', 'TR', 'BR', 'BL'];

  it('(0,0) is the cell nearest the arena centre in every corner', () => {
    for (const c of corners) {
      const origin = cellCenter(c, 0, 0);
      for (let col = 0; col < 6; col++) {
        for (let row = 0; row < 6; row++) {
          if (col === 0 && row === 0) continue;
          expect(dist(cellCenter(c, col, row), CENTER)).toBeGreaterThan(dist(origin, CENTER));
        }
      }
    }
  });

  it('mirrors per corner', () => {
    expect(cellCenter('TL', 0, 0)).toEqual({ x: 220, y: 220 });
    expect(cellCenter('TL', 5, 5)).toEqual({ x: 20, y: 20 });
    expect(cellCenter('TR', 0, 0)).toEqual({ x: 580, y: 220 });
    expect(cellCenter('TR', 5, 0)).toEqual({ x: 780, y: 220 });
    expect(cellCenter('BR', 0, 0)).toEqual({ x: 580, y: 580 });
    expect(cellCenter('BR', 2, 3)).toEqual({ x: 660, y: 700 });
    expect(cellCenter('BL', 0, 0)).toEqual({ x: 220, y: 580 });
    expect(cellCenter('BL', 1, 5)).toEqual({ x: 180, y: 780 });
  });

  it('cells lie inside their zone and cellAt inverts cellCenter', () => {
    for (const c of corners) {
      const r = zoneRect(c);
      for (let col = 0; col < 6; col++) {
        for (let row = 0; row < 6; row++) {
          const p = cellCenter(c, col, row);
          expect(p.x).toBeGreaterThan(r.x);
          expect(p.x).toBeLessThan(r.x + r.width);
          expect(p.y).toBeGreaterThan(r.y);
          expect(p.y).toBeLessThan(r.y + r.height);
          expect(cellAt(c, p.x, p.y)).toEqual({ col, row });
        }
      }
    }
    expect(cellAt('TL', 400, 400)).toBeNull();
  });

  it('rejects cells outside the 6×6 grid', () => {
    expect(() => cellCenter('TL', 6, 0)).toThrow();
    expect(() => cellCenter('TL', -1, 0)).toThrow();
    expect(() => cellCenter('TL', 0.5, 0)).toThrow();
  });

  it('nearest cells of adjacent zones are 360 px apart (diagonal 509)', () => {
    expect(dist(cellCenter('TL', 0, 0), cellCenter('TR', 0, 0))).toBe(360);
    expect(Math.round(dist(cellCenter('TL', 0, 0), cellCenter('BR', 0, 0)))).toBe(509);
  });

  it('instance ids are seat-row-col', () => {
    expect(instanceIdFor(2, 0, 3)).toBe('2-0-3');
  });
});

describe('per-round zone assignment', () => {
  it('player i gets zoneSet[(i + round) % n]', () => {
    const z = assignZones(['a', 'b', 'c'], 1);
    expect(z.get('a')).toBe('TR');
    expect(z.get('b')).toBe('BR');
    expect(z.get('c')).toBe('TL');
  });

  it('every round assigns distinct zones', () => {
    for (const n of [2, 3, 4]) {
      const ids = ['a', 'b', 'c', 'd'].slice(0, n);
      for (let round = 1; round <= 6; round++) {
        const zones = [...assignZones(ids, round).values()];
        expect(new Set(zones).size).toBe(n);
      }
    }
  });

  it('3 players over 3 rounds: each gets the middle seat (TR) exactly once', () => {
    const ids = ['a', 'b', 'c'];
    const middle = new Map<string, number>();
    for (let round = 1; round <= 3; round++) {
      for (const [id, zone] of assignZones(ids, round)) {
        if (zone === 'TR') middle.set(id, (middle.get(id) ?? 0) + 1);
      }
    }
    expect([...middle.entries()].sort()).toEqual([
      ['a', 1],
      ['b', 1],
      ['c', 1],
    ]);
  });

  it('2 players swap corners every round', () => {
    expect(assignZones(['a', 'b'], 1).get('a')).toBe('BR');
    expect(assignZones(['a', 'b'], 2).get('a')).toBe('TL');
  });
});

describe('ranges and the safe circle', () => {
  it('range is edge to edge', () => {
    const soldier = { x: 0, y: 0, radius: 10, range: 20 };
    const tower = { x: 44, y: 0, radius: 14 };
    expect(edgeDistance(soldier, tower)).toBe(20);
    expect(inRange(soldier, tower)).toBe(true);
    expect(inRange(soldier, { ...tower, x: 44.5 })).toBe(true); // 0.5 tolerance
    expect(inRange(soldier, { ...tower, x: 44.6 })).toBe(false);
  });

  it('safe circle shrinks linearly 570 → 60 from tick 4500 to 7200', () => {
    const sd = DEFAULT_CONFIG.suddenDeath;
    expect(safeZoneRadius(0, sd)).toBe(570);
    expect(safeZoneRadius(4500, sd)).toBe(570);
    expect(safeZoneRadius(5850, sd)).toBe(315);
    expect(safeZoneRadius(7200, sd)).toBe(60);
    expect(safeZoneRadius(8000, sd)).toBe(60);
    // 570 covers the whole arena (corner distance ≈ 565.7).
    expect(Math.hypot(400, 400)).toBeLessThan(570);
  });
});
