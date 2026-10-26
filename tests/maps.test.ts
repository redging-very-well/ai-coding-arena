// Map styles for 2-8 players (plan §9.2): every style × player count is
// checked against the §9.2 zone table rules: cell-aligned, inside the arena,
// at least one cell between zones, facing, fair distances, zone-local cells
// with row 0 at the front, rotation (free-for-all and team blocks), and the
// scaled sudden-death circle.

import { describe, expect, it } from 'vitest';
import {
  CELL_SIZE,
  DEFAULT_CONFIG,
  MAP_STYLES,
  MAP_STYLE_INFO,
  allMapLayouts,
  arenaSizeFor,
  assignMapZones,
  assignTeamZones,
  autoBalance,
  cellAt,
  cellCenter,
  cornerZone,
  defaultMapStyle,
  derivedFacing,
  isValidMapStyle,
  mapDTO,
  mapFor,
  nearestCellDistance,
  resolveMapStyle,
  scaleSuddenDeath,
  teamBlock,
  validMapStyles,
  isValidMapSetup,
  teamBlocksEven,
  unevenTeamBlocks,
  validTeamModes,
  zoneAxes,
  zoneCenterOf,
  zoneCentredOnLine,
  type MapLayout,
  type MapZone,
} from '@pixel-clash/shared';

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const label = (m: MapLayout) => `${m.style} ${m.players}p`;
const centreOf = (m: MapLayout) => ({ x: m.width / 2, y: m.height / 2 });
const cells = () => {
  const out: Array<{ col: number; row: number }> = [];
  for (let row = 0; row < 6; row++) for (let col = 0; col < 6; col++) out.push({ col, row });
  return out;
};

describe('styles, player counts and arena size', () => {
  it('arena: 800 for 2-4 players, 1040 for 5-6, 1200 for 7-8 (whole 40 px cells, even count)', () => {
    expect([2, 3, 4, 5, 6, 7, 8].map(arenaSizeFor)).toEqual([800, 800, 800, 1040, 1040, 1200, 1200]);
    for (let p = 2; p <= 8; p++) expect((arenaSizeFor(p) / CELL_SIZE) % 2).toBe(0);
  });

  it('defaults: 2 Duel, 3 Triangle, 4 Corners, 5-8 Ring', () => {
    expect([2, 3, 4, 5, 6, 7, 8].map(defaultMapStyle)).toEqual(['duel', 'triangle', 'corners', 'ring', 'ring', 'ring', 'ring']);
  });

  it('valid styles: Duel 2 · Triangle 3 · Corners 3-4 · Ring 5-8 · Lanes 4/6/8 · Islands 6/8 (default first)', () => {
    expect(validMapStyles(2)).toEqual(['duel']);
    expect(validMapStyles(3)).toEqual(['triangle', 'corners']);
    expect(validMapStyles(4)).toEqual(['corners', 'lanes']);
    expect(validMapStyles(5)).toEqual(['ring']);
    expect(validMapStyles(6)).toEqual(['ring', 'lanes', 'islands']);
    expect(validMapStyles(7)).toEqual(['ring']);
    expect(validMapStyles(8)).toEqual(['ring', 'lanes', 'islands']);
    expect(isValidMapStyle('lanes', 5)).toBe(false);
    expect(() => mapFor('lanes', 5)).toThrow(RangeError);
    expect(() => mapFor('ring', 9)).toThrow(RangeError);
  });

  it('a host override is used when valid, otherwise the default (with a fallback flag)', () => {
    expect(resolveMapStyle('lanes', 8)).toEqual({ style: 'lanes', fellBack: false });
    expect(resolveMapStyle('lanes', 5)).toEqual({ style: 'ring', fellBack: true });
    expect(resolveMapStyle(null, 3)).toEqual({ style: 'triangle', fellBack: false });
    expect(resolveMapStyle(undefined, 2)).toEqual({ style: 'duel', fellBack: false });
  });

  it('1 active player: Duel zone 0 only', () => {
    const m = mapFor('duel', 1);
    expect(m.width).toBe(800);
    expect(m.zones).toHaveLength(1);
    expect(m.zones[0]).toMatchObject({ x: 0, y: 0, facing: 'diag' });
  });

  it('every style lists its own counts, and allMapLayouts covers all 13 pairs', () => {
    expect(allMapLayouts().map(label)).toEqual([
      'duel 2p', 'triangle 3p', 'corners 3p', 'corners 4p', 'ring 5p', 'ring 6p', 'ring 7p', 'ring 8p',
      'lanes 4p', 'lanes 6p', 'lanes 8p', 'islands 6p', 'islands 8p',
    ]);
    for (const s of MAP_STYLES) expect(MAP_STYLE_INFO[s].players.length).toBeGreaterThan(0);
  });
});

describe.each(allMapLayouts().map((m) => [label(m), m] as const))('%s', (_name, m) => {
  const S = m.width;
  const C = centreOf(m);

  it('one 240×240 zone per player, cell-aligned and fully inside the arena', () => {
    expect(m.height).toBe(S);
    expect(S).toBe(arenaSizeFor(m.players));
    expect(m.zones).toHaveLength(m.players);
    m.zones.forEach((z, i) => {
      expect(z.index).toBe(i);
      expect(z).toMatchObject({ width: 240, height: 240, arena: S });
      expect(z.x % CELL_SIZE).toBe(0);
      expect(z.y % CELL_SIZE).toBe(0);
      expect(z.x).toBeGreaterThanOrEqual(0);
      expect(z.y).toBeGreaterThanOrEqual(0);
      expect(z.x + z.width).toBeLessThanOrEqual(S);
      expect(z.y + z.height).toBeLessThanOrEqual(S);
    });
  });

  it('zones never overlap and are at least one cell apart', () => {
    for (const a of m.zones) {
      for (const b of m.zones) {
        if (a === b) continue;
        const apart =
          a.x + a.width + CELL_SIZE <= b.x || b.x + b.width + CELL_SIZE <= a.x || a.y + a.height + CELL_SIZE <= b.y || b.y + b.height + CELL_SIZE <= a.y;
        expect(apart, `zones ${a.index} and ${b.index}`).toBe(true);
      }
    }
  });

  it('facing follows the direction to the centre (Lanes: the rows face each other)', () => {
    for (const z of m.zones) {
      if (m.style === 'lanes') expect(z.facing).toBe(zoneCenterOf(z).y < C.y ? 'S' : 'N');
      else expect(z.facing, `zone ${z.index}`).toBe(derivedFacing(z, S));
    }
  });

  it('cellAt inverts cellCenter, cells stay inside the zone and fill it exactly once', () => {
    for (const z of m.zones) {
      const seen = new Set<string>();
      for (const { col, row } of cells()) {
        const p = cellCenter(z, col, row);
        expect(p.x).toBeGreaterThan(z.x);
        expect(p.x).toBeLessThan(z.x + z.width);
        expect(p.y).toBeGreaterThan(z.y);
        expect(p.y).toBeLessThan(z.y + z.height);
        expect((p.x - CELL_SIZE / 2) % CELL_SIZE).toBe(0);
        expect((p.y - CELL_SIZE / 2) % CELL_SIZE).toBe(0);
        expect(cellAt(z, p.x, p.y)).toEqual({ col, row });
        seen.add(`${p.x},${p.y}`);
      }
      expect(seen.size).toBe(36);
      expect(cellAt(z, z.x - 1, z.y)).toBeNull();
    }
  });

  it('row 0 is the front row; (0,0) is the front cell nearest the centre (centred zones: nearest along the facing)', () => {
    for (const z of m.zones) {
      const a = zoneAxes(z);
      const rowDist = (row: number) => {
        // Distance of a row from the centre along the facing axis.
        const p = cellCenter(z, 0, row);
        if (z.facing === 'diag') return dist(p, C);
        return a.colAxis === 'x' ? Math.abs(p.y - C.y) : Math.abs(p.x - C.x);
      };
      if (z.facing !== 'diag') for (let row = 1; row < 6; row++) expect(rowDist(row)).toBeGreaterThan(rowDist(row - 1));
      const origin = dist(cellCenter(z, 0, 0), C);
      const nearest = Math.min(...cells().map((c) => dist(cellCenter(z, c.col, c.row), C)));
      const zc = zoneCenterOf(z);
      const centred = z.facing !== 'diag' && (a.colAxis === 'x' ? zc.x === C.x : zc.y === C.y);
      if (centred) {
        // Centred on the cross line: col grows towards + (x or y), so (0,0) is a front-row corner.
        const front = cells().filter((c) => c.row === 0).map((c) => dist(cellCenter(z, c.col, c.row), C));
        expect(front.every((d) => d < Math.min(...cells().filter((c) => c.row === 5).map((c) => dist(cellCenter(z, c.col, c.row), C))))).toBe(true);
      } else {
        expect(origin, `zone ${z.index}`).toBeCloseTo(nearest, 6);
      }
    }
  });

  it('mirror-symmetric about x = S/2 (Islands 8: 4-fold rotation; Duel / Corners 3: a diagonal)', () => {
    const key = (x: number, y: number) => `${x},${y}`;
    const set = new Set(m.zones.map((z) => key(z.x, z.y)));
    const has = (x: number, y: number) => set.has(key(x, y));
    if (m.style === 'islands' && m.players === 8) {
      // Rotating by 90° about the centre maps the layout onto itself.
      for (const z of m.zones) expect(has(S - z.y - 240, z.x)).toBe(true);
    } else if (m.style === 'duel') {
      for (const z of m.zones) expect(has(z.y, z.x)).toBe(true); // about the diagonal x = y
    } else if (m.style === 'corners' && m.players === 3) {
      for (const z of m.zones) expect(has(S - 240 - z.y, S - 240 - z.x)).toBe(true); // about the anti-diagonal
    } else {
      for (const z of m.zones) expect(has(S - z.x - 240, z.y), `zone ${z.index}`).toBe(true);
    }
  });
});

describe('fair distances (§9.2)', () => {
  const spread = (m: MapLayout, zones: readonly MapZone[] = m.zones) => {
    const d = zones.map((z) => dist(zoneCenterOf(z), centreOf(m)));
    return { min: Math.min(...d), max: Math.max(...d) };
  };

  it('symmetric styles: every zone centre is the same distance from the arena centre', () => {
    for (const m of [mapFor('duel', 2), mapFor('corners', 3), mapFor('corners', 4), mapFor('lanes', 4)]) {
      const { min, max } = spread(m);
      expect(max - min, label(m)).toBeLessThan(1e-9);
    }
  });

  it('Triangle within 5 %, Ring 5-7 within 20 % (rotation evens the rest out)', () => {
    const { min, max } = spread(mapFor('triangle', 3));
    expect(max / min).toBeLessThan(1.05);
    for (const p of [5, 6, 7]) {
      const r = spread(mapFor('ring', p));
      expect(r.max / r.min, `ring ${p}`).toBeLessThan(1.2);
      expect(r.min).toBeGreaterThanOrEqual(400);
      expect(r.max).toBeLessThanOrEqual(537);
    }
  });

  it('Ring 8 is a 3×3 ring without its middle: two orbits, edges 480 and corners 679', () => {
    const m = mapFor('ring', 8);
    const d = m.zones.map((z) => Math.round(dist(zoneCenterOf(z), centreOf(m))));
    expect(d).toEqual([480, 679, 480, 679, 480, 679, 480, 679]);
    expect(m.zones.filter((z) => z.facing === 'diag').map((z) => z.index)).toEqual([1, 3, 5, 7]);
  });

  it('team blocks are fair: every block has the same distance profile (Ring 6 / Islands 6 2v2v2: evened out by block rotation)', () => {
    for (const [style, players, teams] of [
      ['corners', 4, 2], ['lanes', 4, 2], ['lanes', 6, 2], ['lanes', 8, 2], ['ring', 6, 2], ['ring', 8, 2], ['ring', 8, 4],
      ['islands', 8, 4], ['islands', 8, 2],
    ] as const) {
      const m = mapFor(style, players);
      const profile = (b: number) =>
        teamBlock(m, teams, b)
          .map((z) => Math.round(dist(zoneCenterOf(z), centreOf(m))))
          .sort((x, y) => x - y)
          .join(',');
      const first = profile(0);
      for (let b = 1; b < teams; b++) expect(profile(b), `${style} ${players}p block ${b}`).toBe(first);
    }
  });

  it('nearest enemy cells match the §9.2 table', () => {
    const near = (m: MapLayout) => {
      let best = Infinity;
      for (const a of m.zones) for (const b of m.zones) if (a !== b) best = Math.min(best, nearestCellDistance(a, b));
      return Math.round(best);
    };
    expect(near(mapFor('duel', 2))).toBe(509);
    expect(near(mapFor('triangle', 3))).toBe(243);
    expect(near(mapFor('corners', 3))).toBe(360);
    expect(near(mapFor('corners', 4))).toBe(360);
    expect(near(mapFor('ring', 5))).toBe(215);
    expect(near(mapFor('ring', 6))).toBe(200);
    expect(near(mapFor('ring', 7))).toBe(165);
    expect(near(mapFor('ring', 8))).toBe(280);
    expect(near(mapFor('lanes', 4))).toBe(200);
    expect(near(mapFor('lanes', 8))).toBe(120);
    expect(near(mapFor('islands', 6))).toBe(120);
    // Across the no-man's-land (Lanes): 360 px between the rows.
    const lanes = mapFor('lanes', 6);
    expect(Math.round(nearestCellDistance(lanes.zones[1]!, lanes.zones[4]!))).toBe(360);
    // Between Islands 6 clusters: 204 px.
    const isl = mapFor('islands', 6);
    expect(Math.round(nearestCellDistance(isl.zones[1]!, isl.zones[2]!))).toBe(204);
  });
});

describe('zone-local cells keep the original Corners rule', () => {
  it('a Corner is that zone of the 4-player Corners map, with the same cells', () => {
    expect(cornerZone('TL')).toMatchObject({ x: 0, y: 0, facing: 'diag', arena: 800 });
    expect(cornerZone('BL')).toMatchObject({ x: 0, y: 560 });
    expect(cellCenter(cornerZone('TR'), 5, 0)).toEqual(cellCenter('TR', 5, 0));
    expect(cellCenter('TR', 5, 0)).toEqual({ x: 780, y: 220 });
    const m = mapFor('corners', 4);
    expect(cellCenter(m.zones[2]!, 2, 3)).toEqual({ x: 660, y: 700 });
  });

  it('N/S zones: row along y from the front edge, col away from x = S/2; E/W transposed', () => {
    const tri = mapFor('triangle', 3);
    // Zone 0 (280,0) faces S: row 0 is its bottom row, col grows +x (centred on x = 400).
    expect(cellCenter(tri.zones[0]!, 0, 0)).toEqual({ x: 300, y: 220 });
    expect(cellCenter(tri.zones[0]!, 5, 5)).toEqual({ x: 500, y: 20 });
    // Zone 1 (520,440) faces W: row grows +x from its left edge, col away from y = 400 (+y).
    expect(cellCenter(tri.zones[1]!, 0, 0)).toEqual({ x: 540, y: 460 });
    expect(cellCenter(tri.zones[1]!, 1, 2)).toEqual({ x: 620, y: 500 });
    // Zone 2 (40,440) faces E: row grows −x from its right edge.
    expect(cellCenter(tri.zones[2]!, 0, 0)).toEqual({ x: 260, y: 460 });
    // Lanes bottom row faces N: row grows +y; left of the centre line col grows −x.
    const lanes = mapFor('lanes', 4);
    expect(cellCenter(lanes.zones[3]!, 0, 0)).toEqual({ x: 300, y: 580 });
    expect(cellCenter(lanes.zones[3]!, 0, 5)).toEqual({ x: 300, y: 780 });
  });

  it('a layout keeps its meaning on every map: row 0 is always the front line', () => {
    const layout = [{ col: 0, row: 0 }, { col: 1, row: 0 }, { col: 0, row: 5 }];
    for (const m of allMapLayouts()) {
      for (const z of m.zones) {
        const C = centreOf(m);
        const [front, , back] = layout.map((c) => cellCenter(z, c.col, c.row));
        expect(dist(front!, C), `${label(m)} zone ${z.index}`).toBeLessThan(dist(back!, C));
      }
    }
  });

  it('mapDTO carries no owners and only the public zone fields', () => {
    const dto = mapDTO(mapFor('ring', 5));
    expect(dto).toMatchObject({ style: 'ring', players: 5, width: 1040, height: 1040 });
    expect(Object.keys(dto.zones[0]!).sort()).toEqual(['facing', 'height', 'index', 'width', 'x', 'y']);
  });
});

describe('zone rotation per round', () => {
  it('free-for-all: player i gets zones[(i + round) % P], distinct every round', () => {
    const m = mapFor('ring', 5);
    const ids = ['a', 'b', 'c', 'd', 'e'];
    expect(assignMapZones(m, ids, 1).get('a')!.index).toBe(1);
    expect(assignMapZones(m, ids, 1).get('e')!.index).toBe(0);
    for (let round = 1; round <= 5; round++) expect(new Set([...assignMapZones(m, ids, round).values()].map((z) => z.index)).size).toBe(5);
    expect(() => assignMapZones(m, ids.slice(0, 4), 1)).toThrow(RangeError);
  });

  it('team mode: teams rotate as blocks; members rotate inside the block; teammates are always neighbours', () => {
    const m = mapFor('lanes', 8);
    const teams = autoBalance(['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'], 'teams2')!;
    expect(teams.map((t) => t.members)).toEqual([
      ['p0', 'p3', 'p4', 'p7'],
      ['p1', 'p2', 'p5', 'p6'],
    ]);
    for (let round = 0; round < 4; round++) {
      const z = assignTeamZones(m, teams, round);
      // Team t takes block (t + r) % 2: the top row (0-3) or the bottom row (4-7).
      const block0 = (round % 2) * 4;
      expect(teams[0]!.members.map((id) => z.get(id)!.index).sort()).toEqual([block0, block0 + 1, block0 + 2, block0 + 3]);
      // Member m takes block zone (m + r) % 4.
      expect(z.get('p0')!.index).toBe(block0 + (round % 4));
      expect(z.get('p3')!.index).toBe(block0 + ((1 + round) % 4));
    }
    // Over T rounds each team plays from every block.
    const blocks = [0, 1].map((r) => Math.floor(assignTeamZones(m, teams, r).get('p0')!.index / 4));
    expect(new Set(blocks).size).toBe(2);
  });

  it('team mode: a kicked member keeps their slot and their zone stays empty', () => {
    const m = mapFor('corners', 4);
    const teams = autoBalance(['a', 'b', 'c', 'd'], 'teams2')!; // A B B A
    expect(teams.map((t) => t.members)).toEqual([['a', 'd'], ['b', 'c']]);
    const full = assignTeamZones(m, teams, 0);
    const short = assignTeamZones(m, teams, 0, new Set(['d']));
    expect(short.has('d')).toBe(false);
    expect(short.get('a')).toBe(full.get('a'));
    expect(short.get('b')).toBe(full.get('b'));
    // Corners 2v2 = {TL, TR} vs {BR, BL}.
    expect(['a', 'd'].map((id) => full.get(id)!.index).sort()).toEqual([0, 1]);
    expect(['b', 'c'].map((id) => full.get(id)!.index).sort()).toEqual([2, 3]);
    expect(() => assignTeamZones(m, [{ members: ['a', 'b', 'c'] }, { members: ['d', 'e'] }], 0)).toThrow(RangeError);
    expect(() => assignTeamZones(m, [{ members: ['a', 'b', 'c', 'd'] }, { members: [] }], 0)).toThrow(RangeError);
  });

  it('over T rounds every team plays from every block, for every valid style × team mode', () => {
    for (const m of allMapLayouts()) {
      for (const T of [2, 3, 4]) {
        const n = m.players / T;
        if (!Number.isInteger(n) || n < 2) continue;
        const ids = Array.from({ length: m.players }, (_, i) => `p${i}`);
        const teams = autoBalance(ids, `teams${T}` as 'teams2')!;
        teams.forEach((t) => {
          const blocks = new Set(Array.from({ length: T }, (_, r) => Math.floor(assignTeamZones(m, teams, r).get(t.members[0]!)!.index / n)));
          expect(blocks.size, `${label(m)} ${T} teams`).toBe(T);
        });
      }
    }
  });

  it('unequal teams: contiguous blocks sized to each team, no overlap, rotating; Lanes/Islands fall back', () => {
    for (const [style, P, sizes] of [
      ['ring', 5, [3, 2]],
      ['ring', 6, [4, 2]],
      ['ring', 7, [3, 2, 2]],
      ['ring', 8, [5, 3]],
      ['corners', 4, [3, 1]],
      ['triangle', 3, [2, 1]],
    ] as const) {
      const m = mapFor(style, P);
      let k = 0;
      const teams = sizes.map((n) => ({ members: Array.from({ length: n }, () => `p${k++}`) }));
      for (let round = 0; round < 4; round++) {
        const z = assignTeamZones(m, teams, round);
        expect(new Set([...z.values()].map((x) => x.index)).size).toBe(P);
        for (const t of teams) {
          const idx = t.members.map((id) => z.get(id)!.index).sort((a, b) => a - b);
          // Contiguous on the cyclic zone list (index order).
          const gaps = idx.map((v, i) => (idx[(i + 1) % idx.length]! - v + P) % P).filter((g) => g !== 1);
          expect(gaps.length, `${style}${P} ${sizes} r${round}`).toBeLessThanOrEqual(1);
          for (const id of t.members) {
            const zz = z.get(id)!;
            expect(zz.x >= 0 && zz.y >= 0 && zz.x + zz.width <= m.width && zz.y + zz.height <= m.height).toBe(true);
          }
        }
      }
    }
    // Lanes and Islands need equal teams.
    expect(isValidMapSetup('lanes', 'teams2', 6, [4, 2])).toBe(false);
    expect(isValidMapSetup('lanes', 'teams2', 6, [3, 3])).toBe(true);
    expect(isValidMapSetup('islands', 'teams4', 8, [3, 2, 2, 1])).toBe(false);
    expect(isValidMapSetup('lanes', 'teams3', 4)).toBe(false); // 2v1v1
    expect(resolveMapStyle('lanes', 6, 'teams2', [4, 2])).toEqual({ style: 'ring', fellBack: true });
    // Equal teams behave exactly as before: team t takes block (t + r) % T.
    const lanes = mapFor('lanes', 8);
    const even = autoBalance(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], 'teams2')!;
    for (let r = 0; r < 3; r++) expect(Math.floor(assignTeamZones(lanes, even, r).get('a')!.index / 4)).toBe(r % 2);
  });

  it('Islands teams of 2: one cluster per team', () => {
    const m = mapFor('islands', 8);
    const teams = autoBalance(['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'], 'teams4')!;
    const z = assignTeamZones(m, teams, 1);
    for (const t of teams) {
      const [a, b] = t.members.map((id) => z.get(id)!);
      expect(Math.floor(a!.index / 2)).toBe(Math.floor(b!.index / 2));
      expect(Math.round(nearestCellDistance(a!, b!))).toBe(120);
    }
  });
});

describe('sudden death scales with the arena', () => {
  it('570 → 60 at 800, 741 → 78 at 1040, 855 → 90 at 1200, and still covers every corner', () => {
    const sd = DEFAULT_CONFIG.suddenDeath;
    expect(scaleSuddenDeath(sd, 800)).toBe(sd);
    expect(scaleSuddenDeath(sd, 1040)).toMatchObject({ startRadius: 741, endRadius: 78, startTick: 4500, endTick: 7200, damagePctPerSecond: 10 });
    expect(scaleSuddenDeath(sd, 1200)).toMatchObject({ startRadius: 855, endRadius: 90 });
    for (const S of [800, 1040, 1200]) expect((S * Math.SQRT2) / 2).toBeLessThan(scaleSuddenDeath(sd, S).startRadius);
  });
});

describe('team blocks are fair, or refused, or flagged uneven (fixes)', () => {
  // Every (style, team mode) the server allows is classified: blocks that are
  // rotations / mirror images of each other, or explicitly uneven (fair only
  // over a multiple of T rounds; the Start-match preview warns). A new layout
  // that lands here unclassified fails this test.
  const UNEVEN = ['ring:6:teams3', 'lanes:6:teams3', 'islands:6:teams3', 'triangle:3:teams3'];

  it('Islands 6 is refused for 2 teams: it would split a cluster between the teams', () => {
    expect(isValidMapSetup('islands', 'teams2', 6)).toBe(false);
    expect(isValidMapSetup('islands', 'teams3', 6)).toBe(true);
    expect(isValidMapSetup('islands', 'ffa', 6)).toBe(true);
    expect(validMapStyles(6, 'teams2')).toEqual(['ring', 'lanes']);
    expect(validMapStyles(6)).toEqual(['ring', 'lanes', 'islands']);
    expect(resolveMapStyle('islands', 6, 'teams2')).toEqual({ style: 'ring', fellBack: true });
    expect(teamBlocksEven(mapFor('islands', 6), 2)).toBe(false);
  });

  it('every allowed setup has equivalent blocks or is listed as uneven', () => {
    const uneven: string[] = [];
    for (const m of allMapLayouts()) {
      for (const mode of validTeamModes(m.players)) {
        if (mode === 'ffa' || !isValidMapSetup(m.style, mode, m.players)) continue;
        if (unevenTeamBlocks(m.style, mode, m.players)) uneven.push(`${m.style}:${m.players}:${mode}`);
      }
    }
    expect(uneven.sort()).toEqual([...UNEVEN].sort());
    // The default 4-player map and the 8-player team maps are even.
    expect(teamBlocksEven(mapFor('corners', 4), 2)).toBe(true);
    expect(teamBlocksEven(mapFor('lanes', 8), 2)).toBe(true);
    expect(teamBlocksEven(mapFor('islands', 8), 4)).toBe(true);
    expect(unevenTeamBlocks('ring', 'ffa', 6)).toBe(false);
  });

  it('zones centred on the centre line are flagged: their col 0 is an edge, cols 2-3 are the middle', () => {
    const centred = allMapLayouts().flatMap((m) => m.zones.filter((z) => zoneCentredOnLine(z)).map((z) => `${m.style}${m.players}/${z.index}`));
    expect(centred).toEqual([
      'triangle3/0', 'ring5/0', 'ring6/0', 'ring6/3', 'ring7/0', 'ring8/0', 'ring8/2', 'ring8/4', 'ring8/6', 'lanes6/1', 'lanes6/4', 'islands6/2', 'islands6/5',
    ]);
    for (const m of allMapLayouts()) {
      for (const z of m.zones) {
        const c = centreOf(m);
        const d = (col: number) => dist(cellCenter(z, col, 0), c);
        if (zoneCentredOnLine(z)) {
          expect(Math.min(d(2), d(3)), `${label(m)} zone ${z.index}`).toBeLessThan(d(0));
        } else {
          // Elsewhere (0,0) is the front cell nearest the centre.
          for (let col = 1; col < 6; col++) expect(d(0), `${label(m)} zone ${z.index}`).toBeLessThanOrEqual(d(col));
        }
      }
    }
  });
});
