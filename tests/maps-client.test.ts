// Client logic for 2-8 player maps and teams (plan §9.2, §12) that runs
// without a DOM: the placement grid in its true orientation for every zone of
// every map (arrow to the centre, front row), kid words for zones, the 8 seat
// colours and team looks, fit-to-canvas zoom for the bigger arenas, the
// map-aware floor and props, reveal zones and tints, the admin map preview,
// and the projector's team helpers.

import { describe, expect, it } from 'vitest';
import {
  CORNERS,
  TEAM_STYLES,
  allMapLayouts,
  arenaSizeFor,
  assignMapZones,
  assignTeamZones,
  autoBalance,
  cellCenter,
  mapDTO,
  mapFor,
  mapZoneDTO,
  validMapStyles,
  type BattleRevealDTO,
  type GameStateDTO,
  type MapZone,
} from '@pixel-clash/shared';
import { arenaFor, groupByTeam, mapName, toMapZone, zoneLabel, zoneWords } from '../packages/client/src/common/maps.js';
import { revealMap, revealZones, zoneTint } from '../packages/client/src/common/render/arena.js';
import { FLOOR_CLIFF_PX, FLOOR_K, edgeProps, fitIso, floorColorAt, floorTerrain, renderFloor, toScreen } from '../packages/client/src/common/render/iso.js';
import { NEUTRAL_SEAT, SEATS, deltaE, patternDash, seatStyle, teamLook } from '../packages/client/src/common/seats.js';
import { isFrontCell, towardCentre, zoneGrid } from '../packages/client/src/play/logic.js';
import { mapPreview, roundOneOwners, selectedStyleOption, styleOptions, styleTip, teamModeOptions, unevenNote } from '../packages/client/src/admin/mapPreview.js';
import { freeTiles, teamArmyValues, teamRankRows, teamStandings, type ArmyValue } from '../packages/client/src/screen/model.js';

const zonesOfAllMaps = (): MapZone[] => allMapLayouts().flatMap((l) => l.zones);
const label = (z: MapZone) => `arena ${z.arena} zone ${z.index} (${z.x},${z.y}) ${z.facing}`;

// ---------------------------------------------------------------------------
// Placement grid (§12.1): true orientation, arrow to the centre
// ---------------------------------------------------------------------------

describe('placement grid for every map zone (§9.2, §12.1)', () => {
  it('draws each of the 36 cells where it sits in the top-down arena', () => {
    for (const z of zonesOfAllMaps()) {
      const g = zoneGrid(z);
      expect(g, label(z)).toHaveLength(36);
      expect(new Set(g.map((c) => `${c.col},${c.row}`)).size, label(z)).toBe(36);
      for (const c of g) {
        const p = cellCenter(z, c.col, c.row);
        expect(p, label(z)).toEqual({ x: z.x + c.gx * 40 + 20, y: z.y + c.gy * 40 + 20 });
      }
    }
  });

  it('puts row 0 on the front edge, which faces the arrow', () => {
    for (const z of zonesOfAllMaps()) {
      const dir = towardCentre(z);
      const row0 = zoneGrid(z).filter((c) => c.row === 0);
      expect(row0, label(z)).toHaveLength(6);
      if (z.facing === 'S') expect(row0.every((c) => c.gy === 5), label(z)).toBe(true);
      if (z.facing === 'N') expect(row0.every((c) => c.gy === 0), label(z)).toBe(true);
      if (z.facing === 'E') expect(row0.every((c) => c.gx === 5), label(z)).toBe(true);
      if (z.facing === 'W') expect(row0.every((c) => c.gx === 0), label(z)).toBe(true);
      // The arrow leaves through the front edge.
      if (dir.dy !== 0 && z.facing !== 'diag') expect(row0[0]!.gy, label(z)).toBe(dir.dy > 0 ? 5 : 0);
      if (dir.dx !== 0 && z.facing !== 'diag') expect(row0[0]!.gx, label(z)).toBe(dir.dx > 0 ? 5 : 0);
      if (z.facing === 'diag') {
        const origin = zoneGrid(z).find((c) => c.col === 0 && c.row === 0)!;
        expect(origin.gx, label(z)).toBe(dir.dx > 0 ? 5 : 0);
        expect(origin.gy, label(z)).toBe(dir.dy > 0 ? 5 : 0);
      }
    }
  });

  it('points the arrow at the arena centre, straight for N/S/E/W and diagonal for corners', () => {
    for (const z of zonesOfAllMaps()) {
      const dir = towardCentre(z);
      const to = { x: z.arena / 2 - (z.x + 120), y: z.arena / 2 - (z.y + 120) };
      expect(dir.dx * to.x + dir.dy * to.y, label(z)).toBeGreaterThan(0);
      expect(dir.dx !== 0 && dir.dy !== 0, label(z)).toBe(z.facing === 'diag');
      expect(dir.arrow, label(z)).not.toBe('•');
    }
    const lanes = mapFor('lanes', 8).zones;
    expect(lanes.slice(0, 4).every((z) => towardCentre(z).arrow === '↓')).toBe(true);
    expect(lanes.slice(4).every((z) => towardCentre(z).arrow === '↑')).toBe(true);
    // Corners still read as before.
    expect(CORNERS.map((c) => towardCentre(c).arrow)).toEqual(['↘', '↙', '↖', '↗']);
  });

  it('highlights row 0 as the front, plus column 0 for corner zones', () => {
    const ring = mapFor('ring', 5).zones[0]!;
    expect(isFrontCell(ring, 3, 0)).toBe(true);
    expect(isFrontCell(ring, 0, 3)).toBe(false);
    expect(isFrontCell('TL', 0, 3)).toBe(true);
    expect(isFrontCell('TL', 3, 3)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Kid words and DTO helpers
// ---------------------------------------------------------------------------

describe('zone words and DTO helpers', () => {
  it('describes where a zone sits, as the map is drawn top-down', () => {
    const corners = mapFor('corners', 4).zones.map((z) => zoneWords(z, 800));
    expect(corners).toEqual(['top left', 'top right', 'bottom right', 'bottom left']);
    const ring8 = mapFor('ring', 8).zones.map((z) => zoneWords(z, 1200));
    expect(ring8).toEqual(['top', 'top right', 'right', 'bottom right', 'bottom', 'bottom left', 'left', 'top left']);
    expect(zoneLabel(mapFor('ring', 8).zones[2]!, 1200)).toBe('zone 3 (right)');
    expect(mapName(mapFor('lanes', 6))).toBe('Lanes · 6 players');
  });

  it('turns a public zone back into a map zone of the right arena', () => {
    for (const layout of allMapLayouts()) {
      const dto = mapDTO(layout);
      for (const z of dto.zones) {
        const S = arenaFor(z, dto);
        expect(S).toBe(layout.width);
        expect(toMapZone(z, S)).toEqual(layout.zones[z.index]);
      }
    }
    // Without the map, the smallest arena it fits in.
    expect(arenaFor(mapZoneDTO(mapFor('ring', 8).zones[3]!), null)).toBe(1200);
  });

  it('groups players by team in member order, leftovers last', () => {
    const players = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }));
    const teams = autoBalance(['a', 'b', 'c', 'd'], 'teams2')!;
    const g = groupByTeam(players, teams);
    expect(g.map((x) => [x.team?.teamId ?? null, x.players.map((p) => p.id)])).toEqual([
      [0, ['a', 'd']],
      [1, ['b', 'c']],
      [null, ['e']],
    ]);
    expect(groupByTeam(players, null)).toEqual([{ team: null, players }]);
  });
});

// ---------------------------------------------------------------------------
// Colours (§12): 8 seats + badges, 4 team looks
// ---------------------------------------------------------------------------

describe('seat colours and team looks (§12)', () => {
  it('has 8 clearly different seat colours in the plan order, each with a number badge', () => {
    expect(SEATS.map((s) => s.color)).toEqual(['#E69F00', '#56B4E9', '#009E73', '#F0E442', '#4B8DFF', '#D55E00', '#CC79A7', '#EEEEEE']);
    expect(SEATS.map((s) => s.symbol)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    for (const a of SEATS) {
      for (const b of SEATS) if (a.seat < b.seat) expect(deltaE(a.color, b.color), `${a.name}/${b.name}`).toBeGreaterThan(25);
      // Every seat colour stands out from the dark floor and from the neutral grey.
      expect(deltaE(a.color, '#4A4E6A'), a.name).toBeGreaterThan(25);
    }
    expect(seatStyle(-1)).toBe(NEUTRAL_SEAT);
  });

  it('gives each team a different colour AND ring pattern', () => {
    const looks = [0, 1, 2, 3].map((t) => teamLook(t)!);
    expect(new Set(looks.map((l) => l.pattern)).size).toBe(4);
    for (const a of looks) for (const b of looks) if (a.teamId < b.teamId) expect(deltaE(a.color, b.color)).toBeGreaterThan(25);
    expect(teamLook(null)).toBeNull();
    expect(teamLook(4)).toBeNull();
    expect(patternDash('solid', 2)).toEqual([]);
    expect(patternDash('dashed', 2).length).toBe(2);
    expect(patternDash('dotted', 2).length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Renderer: fit, floor, props, reveal zones
// ---------------------------------------------------------------------------

describe('renderer for bigger arenas (§9.2, §12)', () => {
  it('zooms out to fit the 1040 and 1200 arenas on the 1080p projector', () => {
    const fits = [800, 1040, 1200].map((S) => {
      for (const [w, h] of [
        [1920, 1080],
        [1232, 852], // the /screen arena panel
        [390, 300],
      ] as const) {
        const v = fitIso(w, h, { arena: S, margin: 16 });
        const left = toScreen(v, 0, S);
        const right = toScreen(v, S, 0);
        const top = toScreen(v, 0, 0);
        const bottom = toScreen(v, S, S);
        expect(left.sx).toBeGreaterThanOrEqual(16 - 1e-6);
        expect(right.sx).toBeLessThanOrEqual(w - 16 + 1e-6);
        expect(top.sy).toBeGreaterThanOrEqual(16 - 1e-6);
        expect(bottom.sy).toBeLessThanOrEqual(h - 16 + 1e-6);
        expect(left.sx + right.sx).toBeCloseTo(w, 6);
      }
      return fitIso(1920, 1080, { arena: S }).k;
    });
    expect(fits[1]!).toBeLessThan(fits[0]!);
    expect(fits[2]!).toBeLessThan(fits[1]!);
    // The default stays the 800 arena.
    expect(fitIso(1920, 1080).k).toBe(fitIso(1920, 1080, { arena: 800 }).k);
  });

  it('builds a floor bitmap sized for the arena with map zones tinted', () => {
    const layout = mapFor('ring', 8);
    const color = SEATS[4]!.color;
    const floor = renderFloor({ arena: 1200, zones: [{ ...layout.zones[2]!, color }], style: 'ring', mapZones: layout.zones });
    expect(floor.image.width).toBe(2 * 1200 * FLOOR_K);
    expect(floor.image.height).toBe(1200 * FLOOR_K + FLOOR_CLIFF_PX);
    const terrain = floorTerrain(1200, 'ring', layout.zones);
    const z = layout.zones[2]!;
    const inZone = floorColorAt(z.x + 100, z.y + 100, [{ ...z, color }], 1, terrain);
    const plain = floorColorAt(z.x + 100, z.y + 100, [], 1, terrain);
    expect(inZone).not.toEqual(plain);
  });

  it('draws the Lanes no-man’s-land and the Islands cluster pads', () => {
    const lanes = floorTerrain(1200, 'lanes', mapFor('lanes', 8).zones);
    expect(lanes.band).toEqual({ y0: 440, y1: 760 });
    expect(floorTerrain(800, 'lanes', mapFor('lanes', 4).zones).band).toEqual({ y0: 240, y1: 560 });
    const islands = floorTerrain(1200, 'islands', mapFor('islands', 8).zones);
    expect(islands.pads).toHaveLength(4);
    for (const pad of islands.pads) {
      expect(pad.x).toBeGreaterThanOrEqual(0);
      expect(pad.x + pad.width).toBeLessThanOrEqual(1200);
    }
    expect(floorTerrain(800, 'corners', mapFor('corners', 4).zones)).toEqual({ arena: 800, band: null, pads: [] });
    // The band changes the tiles (cosmetic only).
    expect(floorColorAt(600, 600, [], 1, lanes)).not.toEqual(floorColorAt(600, 600, [], 1, floorTerrain(1200)));
  });

  it('keeps the edge props outside every arena size', () => {
    for (const S of [800, 1040, 1200]) {
      const props = edgeProps(1, S);
      expect(props.some((p) => p.x > 900 || p.y > 900)).toBe(S > 800);
      for (const p of props) expect(p.x < 0 || p.y < 0 || p.x > S || p.y > S).toBe(true);
    }
  });

  it('reads zones, team tints and the map from a reveal', () => {
    const layout = mapFor('lanes', 4);
    const teams = autoBalance(['a', 'b', 'c', 'd'], 'teams2')!;
    const reveal: BattleRevealDTO = {
      round: 1,
      totalTicks: 5400,
      map: mapDTO(layout),
      teams,
      players: ['a', 'b', 'c', 'd'].map((id, seat) => ({
        playerId: id,
        name: id,
        seat,
        zone: null,
        mapZone: mapZoneDTO(layout.zones[seat]!),
        teamId: teams.find((t) => t.members.includes(id))!.teamId,
        units: [],
        instances: [],
      })),
    };
    const zones = revealZones(reveal);
    expect(zones.map((z) => z.rect?.x)).toEqual([80, 480, 480, 80]);
    expect(zones.map((z) => zoneTint(z))).toEqual([TEAM_STYLES[0]!.color, TEAM_STYLES[1]!.color, TEAM_STYLES[1]!.color, TEAM_STYLES[0]!.color]);
    expect(revealMap(reveal)).toMatchObject({ style: 'lanes', width: 800 });
    // Free-for-all: the seat colour, and an older reveal's corner.
    const ffa = { ...reveal, teams: null, players: [{ ...reveal.players[0]!, mapZone: undefined, zone: 'TL' as const }] };
    expect(revealZones(ffa)).toEqual([{ corner: 'TL', seat: 0, teamId: null }]);
    expect(zoneTint({ seat: 5, teamId: null })).toBe(SEATS[5]!.color);
    expect(revealMap({ ...reveal, map: undefined })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// /admin map preview (§12.3)
// ---------------------------------------------------------------------------

describe('admin map preview (§12.3)', () => {
  const roster = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `Kid ${i}`, seat: i }));

  it('offers only the styles valid for the count, the auto default first', () => {
    // The default is only offered as "auto" (''), never as a pinned override.
    expect(styleOptions(6).map((o) => o.value)).toEqual(['', ...validMapStyles(6).slice(1)]);
    expect(styleOptions(6).map((o) => o.value)).not.toContain('ring');
    expect(styleOptions(4).map((o) => o.value)).toEqual(['', 'lanes']);
    // Only the styles that suit the team mode (Islands 6 is refused for 2 teams).
    expect(styleOptions(6, 'teams2').map((o) => o.value)).toEqual(['', 'lanes']);
    expect(styleOptions(6)[0]!.label).toBe('Ring (auto for 6 players)');
    expect(styleOptions(1)[0]!.label).toBe('Duel (auto for 2 players)');
    expect(teamModeOptions(8).map((o) => o.label)).toEqual(['Free-for-all', '2 teams (4v4)', '4 teams / teams of 2 (2v2v2v2)']);
    expect(teamModeOptions(5).map((o) => o.value)).toEqual(['ffa']);
  });

  it('shows a draft override equal to the default (or no longer valid) as "auto", not a blank select', () => {
    // Visual QA: PUT /admin/match/setup {mapStyle:'duel'} with 2 players left the Map dropdown blank.
    expect(selectedStyleOption(styleOptions(2), 'duel')).toBe('');
    expect(selectedStyleOption(styleOptions(8), 'ring')).toBe('');
    expect(selectedStyleOption(styleOptions(8), 'lanes')).toBe('lanes');
    expect(selectedStyleOption(styleOptions(5), 'lanes')).toBe(''); // Lanes needs 4, 6 or 8
    expect(selectedStyleOption(styleOptions(4), null)).toBe('');
  });

  it("shows each player's round-1 zone, as the server assigns it", () => {
    const players = roster(5);
    const layout = mapFor('ring', 5);
    const owners = roundOneOwners(layout.zones, players, null);
    const server = assignMapZones(layout, players.map((p) => p.id), 1);
    for (const [id, z] of server) expect(owners.get(z.index)?.id).toBe(id);
    const p = mapPreview(null, players, null);
    expect(p.style).toBe('ring');
    expect(p.width).toBe(arenaSizeFor(5));
    expect(p.zones.every((z) => z.owner && z.color === seatStyle(z.owner.seat).color)).toBe(true);
  });

  it('uses team blocks and team colours in team mode', () => {
    const players = roster(8);
    const teams = autoBalance(players.map((p) => p.id), 'teams2')!;
    const p = mapPreview('lanes', players, teams, 'teams2');
    const server = assignTeamZones(mapFor('lanes', 8), teams, 1);
    for (const z of p.zones) {
      expect(server.get(z.owner!.id)!.index).toBe(z.index);
      expect(z.color).toBe(TEAM_STYLES[z.teamId!]!.color);
    }
    // Whole rows: the top row is one team.
    expect(new Set(p.zones.slice(0, 4).map((z) => z.teamId)).size).toBe(1);
    expect(p.closeNeighbours).toBe(false);
    expect(p.tip).toBeNull();
  });

  it('notes close neighbours, suggests Lanes / Islands, and falls back on an invalid style', () => {
    expect(mapPreview('islands', roster(6), null).closeNeighbours).toBe(true);
    expect(styleTip('ring', 'teams2', 8)).toContain('Lanes');
    expect(styleTip('ring', 'teams4', 8)).toContain('Islands');
    expect(styleTip('ring', 'teams3', 6)).toContain('Islands');
    expect(styleTip('ring', 'ffa', 8)).toBeNull();
    // Lanes isn't valid for 5: the default Ring is drawn.
    expect(mapPreview('lanes', roster(5), null).style).toBe('ring');
    // Fewer than 2 players: the 2-player map, no owners.
    const one = mapPreview(null, roster(1), null);
    expect(one.style).toBe('duel');
    expect(one.zones.every((z) => z.owner === null)).toBe(true);
  });

  it('refuses Islands 6 for 2 teams and warns about uneven team areas unless rounds % T === 0', () => {
    expect(mapPreview('islands', roster(6), null, 'teams2').style).toBe('ring');
    const lanes3 = mapPreview('lanes', roster(6), null, 'teams3');
    expect(lanes3.uneven).toBe(true);
    expect(unevenNote(lanes3, 'teams3', 2)).toContain('Uneven teams');
    expect(unevenNote(lanes3, 'teams3', 3)).toBeNull();
    expect(unevenNote(lanes3, 'teams3', 6)).toBeNull();
    const lanes2 = mapPreview('lanes', roster(8), null, 'teams2');
    expect(lanes2.uneven).toBe(false);
    expect(unevenNote(lanes2, 'teams2', 1)).toBeNull();
    expect(mapPreview('lanes', roster(6), null, 'ffa').uneven).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// /screen team helpers (§12.2)
// ---------------------------------------------------------------------------

describe('projector team helpers (§12.2)', () => {
  it('fills the tile grid with free seats up to 4, then to an even count, at most 8', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map((n) => freeTiles(n))).toEqual([4, 3, 2, 1, 0, 1, 0, 1, 0]);
  });

  it('sums army value per team, split by member', () => {
    const teams = autoBalance(['a', 'b', 'c', 'd'], 'teams2')!;
    const v = (playerId: string, seat: number, teamId: number, living: number): ArmyValue => ({
      playerId,
      name: playerId,
      seat,
      teamId,
      start: 100,
      living,
      aliveCount: living > 0 ? 1 : 0,
      fieldedCount: 1,
    });
    const out = teamArmyValues([v('a', 0, 0, 50), v('b', 1, 1, 100), v('c', 2, 1, 0), v('d', 3, 0, 30)], teams);
    expect(out.map((t) => [t.team.teamId, t.start, t.living, t.members.map((m) => m.playerId)])).toEqual([
      [0, 200, 80, ['a', 'd']],
      [1, 200, 100, ['b', 'c']],
    ]);
    expect(teamArmyValues([], null)).toEqual([]);
  });

  it('joins the round team ranking with the team table and names', () => {
    const teams = autoBalance(['a', 'b', 'c', 'd'], 'teams2')!;
    const state = {
      players: ['a', 'b', 'c', 'd'].map((id, seat) => ({ id, name: id.toUpperCase(), seat })),
      match: { mapStyle: 'corners', teamMode: 'teams2', map: null, teams, teamTable: null },
      lastBattle: {
        round: 1,
        endTick: 100,
        reason: 'elimination',
        ranking: [],
        scoreboard: [],
        teams: [
          { teamId: 1, place: 1, placePoints: 3, livingCost: 500, eliminatedAtTick: null, members: ['b', 'c'] },
          { teamId: 0, place: 2, placePoints: 0, livingCost: 0, eliminatedAtTick: 90, members: ['a', 'd'] },
        ],
        teamTable: [
          { ...teams[1]!, points: 4, placePoints: 3, place: 1 },
          { ...teams[0]!, points: 1.5, placePoints: 0, place: 2 },
        ],
      },
    } as unknown as GameStateDTO;
    const rows = teamRankRows(state);
    expect(rows.map((r) => [r.teamId, r.place, r.placePoints, r.points, r.memberNames])).toEqual([
      [1, 1, 3, 4, ['B', 'C']],
      [0, 2, 0, 1.5, ['A', 'D']],
    ]);
    expect(teamRankRows({ ...state, lastBattle: { ...state.lastBattle!, teams: undefined } })).toEqual([]);
    expect(teamStandings(state.lastBattle!.teamTable).map((t) => t.teamId)).toEqual([1, 0]);
  });
});
