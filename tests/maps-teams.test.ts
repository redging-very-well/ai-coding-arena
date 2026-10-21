// Maps, 2-8 players and teams through the real server (plan §9.2, §4 seats
// and benching, §10.2 setup/swap gates, §10.3 admin setup, swap and Start
// match, §10.4 get_game_state / get_rules).
//
//   * Seats 0-7 and GAME_FULL at 8; the LOBBY draft with BAD_MAP_STYLE /
//     BAD_TEAM_MODE, snake auto-balance, swaps, re-balance on join; Start
//     match fixes teams and map; late joiners are benched; a kicked member's
//     zone stays empty; team blocks rotate.
//   * Full matches with 8 players: free-for-all on Ring 8, 2 teams of 4 on
//     Lanes 8, 4 teams of 2 on Islands 8 (1200 arena): team ranking, team
//     table, shared place points, Last Standing for the winning team.

import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  mapFor,
  placePointsFor,
  type BattleEndDTO,
  type GameStateDTO,
  type MapStyle,
  type MapZoneDTO,
  type MatchSetupDTO,
  type TeamMode,
} from '@pixel-clash/shared';
import type { RunningServer } from '../packages/server/src/server.js';
import { Client, adminClient, bootServer, namedUnit, newPlayer, removeDir, tempDataDir, waitForState } from './helpers/server.js';

const T = 120_000;
const NAMES = ['Ada', 'Bo', 'Cy', 'Di', 'Ed', 'Flo', 'Gus', 'Hal', 'Ivy'];

type Player = Awaited<ReturnType<typeof newPlayer>>;

async function players(url: string, n: number, from = 0): Promise<Player[]> {
  const out: Player[] = [];
  for (let i = from; i < from + n; i++) out.push(await newPlayer(url, NAMES[i]!));
  return out;
}

const state = async (c: Client) => (await c.get('/state')).body as GameStateDTO;

/** The block (index / block size) a zone index is in. */
const blockOf = (zone: MapZoneDTO, blockSize: number) => Math.floor(zone.index / blockSize);

async function mcpFor(url: string) {
  const mcp = new McpClient({ name: 'maps-teams-test', version: '1.0.0' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
  return mcp;
}

describe('seats, the LOBBY draft and team setup', () => {
  let srv: RunningServer;
  let dir: string;
  let admin: Client;
  let ps: Player[];

  beforeAll(async () => {
    dir = tempDataDir();
    srv = await bootServer({ dataDir: dir });
    admin = await adminClient(srv.url);
    ps = await players(srv.url, 6);
  }, T);

  afterAll(async () => {
    await srv.close();
    removeDir(dir);
  });

  it('the draft checks styles and team modes against the player count', async () => {
    let setup = (await admin.get('/admin/match/setup')).body as MatchSetupDTO;
    expect(setup).toMatchObject({ mapStyle: null, teamMode: 'ffa', teams: null, validStyles: ['ring', 'lanes', 'islands'] });
    expect(setup.validTeamModes).toEqual(['ffa', 'teams2', 'teams3']);
    expect(setup.map).toMatchObject({ style: 'ring', players: 6, width: 1040, height: 1040 });
    expect(setup.map.zones).toHaveLength(6);

    let r = await admin.put('/admin/match/setup', { teamMode: 'teams4' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatchObject({ code: 'BAD_TEAM_MODE', details: { players: 6, valid: ['ffa', 'teams2', 'teams3'] } });
    r = await admin.put('/admin/match/setup', { mapStyle: 'triangle' });
    expect(r.body.error).toMatchObject({ code: 'BAD_MAP_STYLE', details: { players: 6, valid: ['ring', 'lanes', 'islands'] } });
    expect((await admin.put('/admin/match/setup', { mapStyle: 'volcano' })).body.error.code).toBe('BAD_MAP_STYLE');
    expect((await admin.put('/admin/match/setup', { teamMode: 'teams9' })).body.error.code).toBe('BAD_TEAM_MODE');
    // Players can't touch the setup.
    expect((await ps[0]!.client.put('/admin/match/setup', { teamMode: 'teams2' })).status).toBe(403);

    // 6 players, 3 teams: snake A B C C B A.
    r = await admin.put('/admin/match/setup', { mapStyle: 'islands', teamMode: 'teams3' });
    expect(r.status).toBe(200);
    setup = r.body as MatchSetupDTO;
    expect(setup.map).toMatchObject({ style: 'islands', players: 6 });
    const ids = ps.map((p) => p.id);
    expect(setup.teams!.map((t) => t.members)).toEqual([
      [ids[0], ids[5]],
      [ids[1], ids[4]],
      [ids[2], ids[3]],
    ]);
    expect(setup.teams![0]).toMatchObject({ teamId: 0, name: 'Team 1', color: '#FFC93C', pattern: 'solid' });
    // Team membership is public (§3), also on /state.
    const s = await state(new Client(srv.url));
    expect(s.match).toMatchObject({ mapStyle: 'islands', teamMode: 'teams3', teamTable: null });
    expect(s.match!.teams!.map((t) => t.members.length)).toEqual([2, 2, 2]);
    expect(s.players.find((p) => p.id === ids[5])!.teamId).toBe(0);
  }, T);

  it('swaps work only across teams; a roster change re-balances and drops swaps', async () => {
    const ids = ps.map((p) => p.id);
    let r = await admin.post('/admin/teams/swap', { playerA: ids[0], playerB: ids[5] });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('SAME_TEAM');
    expect((await admin.post('/admin/teams/swap', { playerA: ids[0], playerB: 'p_nobody' })).body.error.code).toBe('NOT_FOUND');
    r = await admin.post('/admin/teams/swap', { playerA: ids[0], playerB: ids[1] });
    expect(r.status).toBe(200);
    expect(r.body.teams[0].members).toEqual([ids[1], ids[5]]);
    expect(r.body.teams[1].members).toEqual([ids[0], ids[4]]);

    // 2 more players join (8: teams3 no longer fits, so the draft resets to
    // free-for-all and the style to auto; then teams2 by snake).
    const late = await players(srv.url, 2, 6);
    ps.push(...late);
    let setup = (await admin.get('/admin/match/setup')).body as MatchSetupDTO;
    expect(setup.teamMode).toBe('ffa');
    expect(setup.mapStyle).toBeNull(); // Islands didn't fit the 7th join
    expect(setup.teams).toBeNull();
    expect(setup.validTeamModes).toEqual(['ffa', 'teams2', 'teams4']);
    expect((await admin.post('/admin/teams/swap', { playerA: ids[0], playerB: ids[1] })).body.error.code).toBe('NO_TEAMS');
    setup = (await admin.put('/admin/match/setup', { mapStyle: 'lanes', teamMode: 'teams2' })).body as MatchSetupDTO;
    const all = ps.map((p) => p.id);
    // 8 players, 2 teams: A B B A A B B A (the earlier swap is gone).
    expect(setup.teams!.map((t) => t.members)).toEqual([
      [all[0], all[3], all[4], all[7]],
      [all[1], all[2], all[5], all[6]],
    ]);
    expect(setup.map).toMatchObject({ style: 'lanes', players: 8, width: 1200 });
  }, T);

  it('seats 0-7; the 9th player gets GAME_FULL', async () => {
    expect(ps.map((p) => p.seat)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    const r = await new Client(srv.url).post('/players', { name: 'Ivy', pin: '1234' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'GAME_FULL', message: 'All 8 seats are taken.' });
  }, T);

  it('Start match validates its own body and then fixes teams and map for the match', async () => {
    let r = await admin.post('/admin/match', { rounds: 2, teamMode: 'teams3' });
    expect(r.body.error).toMatchObject({ code: 'BAD_TEAM_MODE', details: { players: 8 } });
    r = await admin.post('/admin/match', { rounds: 2, mapStyle: 'duel' });
    expect(r.body.error).toMatchObject({ code: 'BAD_MAP_STYLE', details: { players: 8, valid: ['ring', 'lanes', 'islands'] } });
    expect((await state(admin)).phase).toBe('LOBBY');

    // A swap in the draft is used by Start (same mode, same roster).
    const all = ps.map((p) => p.id);
    expect((await admin.post('/admin/teams/swap', { playerA: all[0], playerB: all[1] })).status).toBe(200);
    r = await admin.post('/admin/match', { rounds: 2, armory: false, teamMode: 'teams2' });
    expect(r.status).toBe(200);
    const s = r.body as GameStateDTO;
    expect(s.phase).toBe('PLAN');
    expect(s.match).toMatchObject({ mapStyle: 'lanes', teamMode: 'teams2', map: { style: 'lanes', players: 8, width: 1200 } });
    expect(s.match!.teams!.map((t) => t.members)).toEqual([
      [all[1], all[3], all[4], all[7]],
      [all[0], all[2], all[5], all[6]],
    ]);
    expect(s.match!.teamTable).toHaveLength(2);

    // Teams are fixed now.
    expect((await admin.post('/admin/teams/swap', { playerA: all[0], playerB: all[1] })).body.error.code).toBe('PHASE_CLOSED');
    expect((await admin.put('/admin/match/setup', { teamMode: 'ffa' })).body.error.code).toBe('PHASE_CLOSED');
    const me = (await ps[0]!.client.get('/me')).body;
    expect(me).toMatchObject({ teamId: 1, benched: false, active: true });
  }, T);

  it('a kicked member leaves a hole; a late joiner is benched; team blocks rotate', async () => {
    const kicked = ps[7]!;
    expect((await admin.post(`/admin/players/${kicked.id}/kick`, {})).body.effective).toBe('now');
    const ivy = await newPlayer(srv.url, 'Ivy');
    expect(ivy.seat).toBe(7);
    const me = (await ivy.client.get('/me')).body;
    expect(me).toMatchObject({ benched: true, active: false });
    expect(me.teamId).toBeUndefined();
    let s = await state(ivy.client);
    expect(s.me).toMatchObject({ benched: true, active: false });
    expect(s.players.find((p) => p.id === ivy.id)).toMatchObject({ benched: true, active: false });
    // Teams never re-balance in a match: Team 1 plays short-handed.
    expect(s.match!.teams!.map((t) => t.members.length)).toEqual([3, 4]);

    const blocks = async () => {
      const out = new Map<number, Set<number>>();
      for (const p of ps.slice(0, 7)) {
        const st = await state(p.client);
        expect(st.me!.myZone).toBeTruthy();
        const set = out.get(st.me!.teamId!) ?? new Set();
        set.add(blockOf(st.me!.myZone!, 4));
        out.set(st.me!.teamId!, set);
      }
      return out;
    };
    s = (await admin.post('/admin/phase/next')).body as GameStateDTO;
    expect(s.phase).toBe('PLACEMENT');
    // Round 1: team t takes block (t + 1) % 2; each team sits in ONE block (a row of Lanes).
    let b = await blocks();
    expect([...b.get(0)!]).toEqual([1]);
    expect([...b.get(1)!]).toEqual([0]);
    // 7 zones dealt: the kicked member's zone stays empty, the benched player has none.
    const overview = (await admin.get('/admin/overview')).body;
    const zoned = overview.players.filter((p: { mapZone: unknown }) => p.mapZone !== null);
    expect(zoned).toHaveLength(7);
    expect(overview.setup).toMatchObject({ teamMode: 'teams2', map: { style: 'lanes' } });
    expect((await state(ivy.client)).me!.myZone).toBeNull();

    // Battle, then round 2: the blocks swap.
    await admin.post('/admin/start', { force: true });
    s = await waitForState(admin, (x) => x.phase === 'RESULTS', 60_000);
    const end = s.lastBattle!;
    expect(end.ranking).toHaveLength(7);
    expect(end.teams!.map((t) => t.members.length).sort()).toEqual([3, 4]);
    expect(end.teamTable).toHaveLength(2);
    expect(end.scoreboard.every((e) => e.teamId === 0 || e.teamId === 1 || e.playerId === ivy.id)).toBe(true);
    await admin.post('/admin/phase/next'); // → PLAN round 2
    await admin.post('/admin/phase/next'); // → PLACEMENT
    b = await blocks();
    expect([...b.get(0)!]).toEqual([0]);
    expect([...b.get(1)!]).toEqual([1]);
    expect((await state(ivy.client)).me).toMatchObject({ benched: true, myZone: null });
  }, T);

  it('New match: back to LOBBY, the draft is re-dealt for everyone (the benched player included)', async () => {
    await admin.post('/admin/start', { force: true });
    await waitForState(admin, (x) => x.phase === 'RESULTS', 60_000);
    await admin.post('/admin/phase/next'); // → MATCH_RESULTS
    const s = (await admin.post('/admin/match/new')).body as GameStateDTO;
    expect(s.phase).toBe('LOBBY');
    expect(s.match!.teams!.flatMap((t) => t.members)).toHaveLength(8);
    expect(s.players.every((p) => !p.benched)).toBe(true);
    expect(s.match!.teamTable).toBeNull();
  }, T);
});

/**
 * Play one full round with 8 players in the given setup; returns the released
 * battle end and the state after it.
 */
async function eightPlayerRound(mapStyle: MapStyle | null, teamMode: TeamMode) {
  const dir = tempDataDir();
  const srv = await bootServer({ dataDir: dir });
  try {
    const admin = await adminClient(srv.url);
    const ps = await players(srv.url, 8);
    const start = await admin.post('/admin/match', { rounds: 2, ...(mapStyle ? { mapStyle } : {}), teamMode });
    expect(start.status).toBe(200);
    await admin.post('/admin/phase/next'); // → PLACEMENT
    const zones = new Map<string, MapZoneDTO>();
    for (const p of ps) zones.set(p.id, (await state(p.client)).me!.myZone!);
    // Every zone of the map is dealt exactly once.
    expect(new Set([...zones.values()].map((z) => z.index)).size).toBe(8);
    const placing = await state(admin);
    await admin.post('/admin/start', { force: true });
    const s = await waitForState(admin, (x) => x.phase === 'RESULTS', 60_000);
    // MCP get_game_state for one player.
    const mcp = await mcpFor(srv.url);
    const gs = (await mcp.callTool({ name: 'get_game_state', arguments: { apiKey: ps[0]!.apiKey } })).structuredContent as Record<string, any>;
    const rules = (await mcp.callTool({ name: 'get_rules', arguments: {} })).structuredContent as Record<string, any>;
    await mcp.close();
    // Round 2 placement: zones rotated.
    await admin.post('/admin/phase/next');
    await admin.post('/admin/phase/next');
    const zones2 = new Map<string, MapZoneDTO>();
    for (const p of ps) zones2.set(p.id, (await state(p.client)).me!.myZone!);
    return { ps, end: s.lastBattle as BattleEndDTO, state: s, placing, zones, zones2, gs, rules };
  } finally {
    await srv.close();
    removeDir(dir);
  }
}

describe('8-player matches (1200 arena)', () => {
  it('free-for-all on the default map (Ring 8): 8 sides, place points 7..0, zones rotate', async () => {
    const { end, placing, zones, zones2, gs, rules } = await eightPlayerRound(null, 'ffa');
    expect(placing.match).toMatchObject({ mapStyle: 'ring', teamMode: 'ffa', teams: null, teamTable: null, map: { players: 8, width: 1200 } });
    expect(end.ranking).toHaveLength(8);
    expect(end.teams).toBeUndefined();
    expect(end.teamTable).toBeUndefined();
    for (const r of end.ranking) {
      expect(r.teamId).toBeUndefined();
      expect(r.placePoints).toBe(placePointsFor(r.place, 8, 8));
      expect(r.pointsGained).toBe(r.placePoints + r.damageBonus + r.valueBonus);
      // Bonus maxima × 8/4: damage 0-4, value 0-2.
      expect(r.damageBonus).toBeLessThanOrEqual(4);
      expect(r.valueBonus).toBeLessThanOrEqual(2);
    }
    // FFA rotation: everybody moves one zone on.
    for (const [id, z] of zones) expect(zones2.get(id)!.index).toBe((z.index + 1) % 8);
    // MCP explains the map.
    expect(gs).toMatchObject({ mapStyle: 'ring', arena: { width: 1200, height: 1200 }, teamMode: 'ffa', myTeam: null, teammates: [], teamTable: null });
    expect(gs.players).toHaveLength(8);
    expect(rules.maps.arenaSizes).toMatchObject({ 2: 800, 4: 800, 5: 1040, 6: 1040, 7: 1200, 8: 1200 });
    expect(rules.maps.defaults).toMatchObject({ 2: 'duel', 3: 'triangle', 4: 'corners', 5: 'ring', 8: 'ring' });
    expect(rules.teams.modes.find((m: { mode: string }) => m.mode === 'teams4').validFor).toEqual([{ players: 8, label: '4 teams / teams of 2 (2v2v2v2)' }]);
    expect(rules.thisMatch).toMatchObject({ mapStyle: 'ring', teamMode: 'ffa', arena: { width: 1200 } });
  }, T);

  it('2 teams of 4 on Lanes 8: one row per team, shared team places, a team table', async () => {
    const { ps, end, placing, zones, zones2, gs } = await eightPlayerRound('lanes', 'teams2');
    expect(placing.match).toMatchObject({ mapStyle: 'lanes', teamMode: 'teams2', map: { style: 'lanes', width: 1200 } });
    const teamOf = new Map(placing.match!.teams!.flatMap((t) => t.members.map((m) => [m, t.teamId] as const)));
    // Each team holds one row (block of 4 consecutive zones), and the rows swap in round 2.
    for (const t of [0, 1]) {
      const mine = ps.filter((p) => teamOf.get(p.id) === t);
      expect(new Set(mine.map((p) => blockOf(zones.get(p.id)!, 4))).size).toBe(1);
      expect(blockOf(zones2.get(mine[0]!.id)!, 4)).toBe(1 - blockOf(zones.get(mine[0]!.id)!, 4));
    }
    checkTeamRound(end, teamOf, 2);
    expect(gs.teamMode).toBe('teams2');
    expect(gs.myTeam).toMatchObject({ teamId: teamOf.get(ps[0]!.id), name: expect.stringMatching(/^Team [12]$/) });
    expect(gs.myTeam.members).toHaveLength(4);
    expect(gs.teammates).toHaveLength(3);
    for (const m of gs.teammates) expect(m.selectedTypes.length).toBeGreaterThan(0);
    expect(gs.teamTable).toHaveLength(2);
  }, T);

  it('4 teams of 2 on Islands 8: one cluster per team, team place points 7/5/2/0', async () => {
    const { ps, end, placing, zones } = await eightPlayerRound('islands', 'teams4');
    const layout = mapFor('islands', 8);
    expect(placing.match!.map).toMatchObject({ style: 'islands', width: layout.width });
    const teamOf = new Map(placing.match!.teams!.flatMap((t) => t.members.map((m) => [m, t.teamId] as const)));
    for (const t of [0, 1, 2, 3]) {
      const mine = ps.filter((p) => teamOf.get(p.id) === t);
      expect(mine).toHaveLength(2);
      expect(blockOf(zones.get(mine[0]!.id)!, 2)).toBe(blockOf(zones.get(mine[1]!.id)!, 2));
    }
    checkTeamRound(end, teamOf, 4);
  }, T);
});

/** Team-mode result invariants (§9.2 Team scoring). */
function checkTeamRound(end: BattleEndDTO, teamOf: Map<string, number>, teams: number): void {
  expect(end.ranking).toHaveLength(8);
  expect(end.teams).toHaveLength(teams);
  expect(end.teamTable).toHaveLength(teams);
  for (const t of end.teams!) {
    expect(t.members).toHaveLength(8 / teams);
    expect(t.placePoints).toBe(placePointsFor(t.place, 8, teams));
    for (const id of t.members) {
      const r = end.ranking.find((x) => x.playerId === id)!;
      // Every member gets the team's place and place points; bonuses stay individual.
      expect(r).toMatchObject({ teamId: t.teamId, place: t.place, placePoints: t.placePoints });
      expect(teamOf.get(id)).toBe(t.teamId);
      expect(r.pointsGained).toBe(r.placePoints + r.damageBonus + r.valueBonus);
      // 🏆 Last Standing for every member of a 1st-place team.
      expect(r.badges.includes('lastStanding')).toBe(t.place === 1);
    }
  }
  // Team table: average of member totals (one decimal), best first.
  for (const row of end.teamTable!) {
    const totals = row.members.map((id) => end.scoreboard.find((e) => e.playerId === id)!.points);
    expect(row.points).toBe(Math.round((totals.reduce((a, b) => a + b, 0) / totals.length) * 10) / 10);
  }
  const pts = end.teamTable!.map((r) => r.points);
  expect([...pts].sort((a, b) => b - a)).toEqual(pts);
  for (const e of end.scoreboard) expect(e.teamId).toBe(teamOf.get(e.playerId));
}

describe('Open Armory with teams', () => {
  it('a teammate and an opponent borrow a fielded unit; the team block shows the borrowed card; it fights for the borrower', async () => {
    const dir = tempDataDir();
    const srv = await bootServer({ dataDir: dir });
    try {
      const admin = await adminClient(srv.url);
      const [ada, bo, , di] = await players(srv.url, 4);
      // 4 players, 2 teams: A B B A → Ada + Di vs Bo + Cy, on Corners (2v2 = {TL, TR} vs {BR, BL}).
      const s = (await admin.post('/admin/match', { rounds: 2, armory: true, teamMode: 'teams2' })).body as GameStateDTO;
      expect(s.match).toMatchObject({ mapStyle: 'corners', teamMode: 'teams2', map: { width: 800 } });
      expect(s.match!.teams!.map((t) => t.members)).toEqual([
        [ada!.id, di!.id],
        [bo!.id, s.match!.teams![1]!.members[1]],
      ]);
      expect((await ada!.client.post('/units', { source: namedUnit('Ogre') })).status).toBe(200);
      await ada!.client.put('/round/selection', { unitIds: ['ogre'] });
      await admin.post('/admin/phase/next'); // → PLACEMENT
      expect((await ada!.client.put('/round/placement', { placements: [{ unitId: 'ogre', col: 0, row: 0 }] })).status).toBe(200);
      await admin.post('/admin/start', { force: true });
      await waitForState(admin, (x) => x.phase === 'RESULTS', 60_000);
      await admin.post('/admin/phase/next'); // → PLAN round 2

      const borrowId = srv.game.visibility.privateState(di!.id)!.armory[0]!.unitId;
      expect(borrowId).toMatch(/^armory:/);
      expect((await di!.client.put('/round/selection', { unitIds: [borrowId, 'basic-soldier'] })).status).toBe(200);
      expect((await bo!.client.put('/round/selection', { unitIds: [borrowId] })).status).toBe(200);
      // Ada sees her teammate's borrowed pick as "Ogre (Ada)" (no code), Bo's pick stays hidden from her.
      const team = ((await ada!.client.get('/state')).body as GameStateDTO).me!.team!;
      expect(team.members.find((m) => m.playerId === di!.id)!.selection.map((c) => c.name)).toEqual(['Ogre (Ada)', 'Basic Soldier']);
      expect(team.members.map((m) => m.playerId).sort()).toEqual([ada!.id, di!.id].sort());

      await admin.post('/admin/phase/next'); // → PLACEMENT
      expect((await di!.client.put('/round/placement', { placements: [{ unitId: borrowId, col: 0, row: 0 }] })).status).toBe(200);
      expect((await bo!.client.put('/round/placement', { placements: [{ unitId: borrowId, col: 0, row: 0 }] })).status).toBe(200);
      const reveal = srv.game.battle;
      await admin.post('/admin/start', { force: true });
      const rv = reveal.currentReveal()!;
      expect(rv.players.find((p) => p.playerId === di!.id)!.units.map((u) => u.name)).toContain('Ogre (Ada)');
      expect(rv.players.find((p) => p.playerId === di!.id)!.teamId).toBe(0);
      expect(rv.players.find((p) => p.playerId === bo!.id)!.teamId).toBe(1);
      const end = (await waitForState(admin, (x) => x.phase === 'RESULTS' && x.round === 2, 60_000)).lastBattle!;
      expect(end.ranking.map((r) => r.playerId).sort()).toEqual(s.players.map((p) => p.id).sort());
      expect(end.teams).toHaveLength(2);
      // 💡 Inventor: used by Di (teammate) and Bo (opponent).
      expect(end.inventors).toEqual([expect.objectContaining({ playerId: ada!.id, usedBy: 2 })]);
    } finally {
      await srv.close();
      removeDir(dir);
    }
  }, T);
});

describe('restart', () => {
  it('a team match survives a restart: setup, teams, map and zones are persisted', async () => {
    const dir = tempDataDir();
    let srv = await bootServer({ dataDir: dir });
    const admin = await adminClient(srv.url);
    const ps = await players(srv.url, 4);
    await admin.post('/admin/match', { rounds: 2, mapStyle: 'lanes', teamMode: 'teams2' });
    await admin.post('/admin/phase/next'); // → PLACEMENT
    const before = await state(ps[1]!.client);
    await srv.close();
    srv = await bootServer({ dataDir: dir });
    try {
      // The web session survives too (sessions are persisted).
      const c = new Client(srv.url);
      c.cookies = ps[1]!.client.cookies;
      const after = await state(c);
      expect(after.phase).toBe('PLACEMENT');
      expect(after.match).toEqual(before.match);
      expect(after.me!.myZone).toEqual(before.me!.myZone);
      expect(after.me!.teamId).toBe(before.me!.teamId);
    } finally {
      await srv.close();
      removeDir(dir);
    }
  }, T);
});

describe('the LOBBY draft never gets stuck (fixes)', () => {
  it('a join that makes both draft values invalid resets them with a toast; Start match works', async () => {
    const dir = tempDataDir();
    const srv = await bootServer({ dataDir: dir });
    try {
      const admin = await adminClient(srv.url);
      await players(srv.url, 4);
      expect((await admin.put('/admin/match/setup', { mapStyle: 'lanes', teamMode: 'teams2' })).status).toBe(200);
      const toasts: string[] = [];
      const notifier = srv.game.notifier;
      const orig = notifier.toast.bind(notifier);
      notifier.toast = ((to: unknown, kind: unknown, text: string, ...rest: unknown[]) => {
        toasts.push(text);
        return (orig as (...a: unknown[]) => unknown)(to, kind, text, ...rest);
      }) as typeof notifier.toast;
      await players(srv.url, 1, 4); // a 5th player joins: lanes and teams2 both stop fitting
      const setup = (await admin.get('/admin/match/setup')).body as MatchSetupDTO;
      expect(setup).toMatchObject({ mapStyle: null, teamMode: 'ffa', teams: null, map: { style: 'ring', players: 5 } });
      expect(toasts).toContain('Team mode reset to free-for-all and map reset to auto (Ring) for 5 players');
      expect(toasts).not.toContain('Teams re-balanced');
      // Single-field requests work again.
      expect((await admin.put('/admin/match/setup', { teamMode: 'ffa' })).status).toBe(200);
      expect((await admin.put('/admin/match/setup', { mapStyle: null })).status).toBe(200);
      expect((await admin.post('/admin/match', { rounds: 1 })).status).toBe(200);
    } finally {
      await srv.close();
      removeDir(dir);
    }
  }, T);

  it('a stale stored draft only fails a request for the fields it names', async () => {
    const dir = tempDataDir();
    const srv = await bootServer({ dataDir: dir });
    try {
      const admin = await adminClient(srv.url);
      await players(srv.url, 7);
      // A stored draft that doesn't fit 7 players (e.g. from an older save).
      srv.game.store.match.setup = { mapStyle: 'lanes', teamMode: 'teams2' };
      let r = await admin.put('/admin/match/setup', { teamMode: 'ffa' });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ teamMode: 'ffa', mapStyle: null });
      srv.game.store.match.setup = { mapStyle: 'lanes', teamMode: 'teams2' };
      r = await admin.put('/admin/match/setup', { mapStyle: null });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ teamMode: 'ffa', mapStyle: null });
      // An explicitly named bad value still fails.
      expect((await admin.put('/admin/match/setup', { mapStyle: 'lanes' })).body.error.code).toBe('BAD_MAP_STYLE');
      expect((await admin.put('/admin/match/setup', { teamMode: 'teams2' })).body.error.code).toBe('BAD_TEAM_MODE');
      // Start match (no setup in the body) falls back to free-for-all on the default.
      srv.game.store.match.setup = { mapStyle: 'lanes', teamMode: 'teams2' };
      r = await admin.post('/admin/match', { rounds: 1 });
      expect(r.status).toBe(200);
      expect((r.body as GameStateDTO).match).toMatchObject({ teamMode: 'ffa', mapStyle: 'ring', teams: null });
    } finally {
      await srv.close();
      removeDir(dir);
    }
  }, T);

  it('Islands 6 is refused for 2 teams (3v3); picking 2 teams on an Islands draft resets the map to auto', async () => {
    const dir = tempDataDir();
    const srv = await bootServer({ dataDir: dir });
    try {
      const admin = await adminClient(srv.url);
      await players(srv.url, 6);
      let r = await admin.put('/admin/match/setup', { mapStyle: 'islands', teamMode: 'teams2' });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatchObject({ code: 'BAD_MAP_STYLE', details: { players: 6, teamMode: 'teams2', valid: ['ring', 'lanes'] } });
      expect((await admin.post('/admin/match', { mapStyle: 'islands', teamMode: 'teams2' })).body.error.code).toBe('BAD_MAP_STYLE');
      expect((await admin.put('/admin/match/setup', { mapStyle: 'islands' })).status).toBe(200);
      r = await admin.put('/admin/match/setup', { teamMode: 'teams2' });
      expect(r.status).toBe(200);
      const setup = r.body as MatchSetupDTO;
      expect(setup).toMatchObject({ mapStyle: null, teamMode: 'teams2', map: { style: 'ring' }, validStyles: ['ring', 'lanes'] });
      // Islands still works for 3 teams of 2.
      expect((await admin.put('/admin/match/setup', { mapStyle: 'islands', teamMode: 'teams3' })).status).toBe(200);
    } finally {
      await srv.close();
      removeDir(dir);
    }
  }, T);
});
