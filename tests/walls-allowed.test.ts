// "Walls allowed" (plan §9.1b) against a booted server with the real
// validator and sandboxes: on by default (state files unchanged), a LOBBY
// draft setting picked up by Start match and then locked; with walls off a
// carried-over selection loses its walls (toast), picking, placing and
// borrowing a wall get WALLS_OFF, the lock drops a wall that slipped in,
// auto-place leaves walls out, the battle has no walls, and /state, /rules,
// get_rules, get_game_state, validate_unit, the guide and the MCP
// instructions say so. Plus the /play roster logic.

import { readFileSync } from 'node:fs';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GameStateDTO, MatchSetupDTO } from '@pixel-clash/shared';
import { isWallOff, toggleGroupedSelection, WALLS_OFF_NOTE } from '../packages/client/src/play/logic.js';
import type { RunningServer } from '../packages/server/src/server.js';
import type { ArmoryEntryRecord } from '../packages/server/src/services/store.js';
import { Client, adminClient, bootServer, namedUnit, newPlayer, removeDir, tempDataDir, waitForState } from './helpers/server.js';

const T = 60_000;
const CONFIG = { timers: { battleTicks: 600 }, suddenDeath: { startTick: 400, endTick: 600 } };

const WALL_SOURCE = readFileSync(new URL('../packages/starter-kit/units/basic_wall.js', import.meta.url), 'utf8').replace(
  "this.name = 'Basic Wall'",
  "this.name = 'Stone Wall'",
);

async function mcpConnect(url: string): Promise<McpClient> {
  const client = new McpClient({ name: 'walls-allowed-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
  return client;
}

async function call(client: McpClient, name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
  return { isError: r.isError === true, s: (r.structuredContent ?? {}) as Record<string, any>, text: JSON.stringify(r) };
}

describe('Walls allowed: the roster logic on /play', () => {
  const wall = { unitId: 'basic-wall', status: 'valid' as const, stats: { type: 'wall' as const } };
  const tower = { unitId: 'basic-tower', status: 'valid' as const, stats: { type: 'tower' as const } };
  const typeOf = (id: string) => (id === 'basic-wall' ? 'wall' : id === 'basic-tower' ? 'tower' : 'soldier') as 'wall' | 'tower' | 'soldier';
  const limits = { unit: 4, building: 4 };

  it('a wall card is off and refused only when walls are off; un-picking still works', () => {
    expect(isWallOff(wall, false)).toBe(true);
    expect(isWallOff(wall, true)).toBe(false);
    expect(isWallOff(tower, false)).toBe(false);
    expect(toggleGroupedSelection([], wall, typeOf, limits, false)).toEqual({ ok: false, reason: 'walls-off' });
    expect(toggleGroupedSelection([], wall, typeOf, limits)).toEqual({ ok: true, selection: ['basic-wall'] });
    expect(toggleGroupedSelection([], tower, typeOf, limits, false)).toEqual({ ok: true, selection: ['basic-tower'] });
    expect(toggleGroupedSelection(['basic-wall'], wall, typeOf, limits, false)).toEqual({ ok: true, selection: [] });
    expect(WALLS_OFF_NOTE).toBe('Walls are off this match');
  });
});

describe('Walls allowed: on by default', () => {
  let srv: RunningServer;
  let dir: string;

  beforeAll(async () => {
    dir = tempDataDir();
    srv = await bootServer({ dataDir: dir, config: CONFIG });
  }, T);

  afterAll(async () => {
    await srv.close();
    removeDir(dir);
  });

  it('the draft, /state, /rules and get_game_state say on; walls are picked and placed as before', async () => {
    const admin = await adminClient(srv.url);
    const sam = await newPlayer(srv.url, 'Ninja Sam');
    await newPlayer(srv.url, 'Bob');
    expect(((await admin.get('/admin/match/setup')).body as MatchSetupDTO).wallsAllowed).toBe(true);
    expect(((await admin.post('/admin/match', { rounds: 1 })).body as GameStateDTO).match?.wallsAllowed).toBe(true);
    // Stored only when off: state files of matches with walls stay the same.
    expect('wallsAllowed' in srv.game.store.match.setup).toBe(false);
    const rules = (await sam.client.get('/rules')).body as { wallsAllowed: { allowed: boolean }; thisMatch: { wallsAllowed: boolean } };
    expect(rules.wallsAllowed.allowed).toBe(true);
    expect(rules.thisMatch.wallsAllowed).toBe(true);
    const mcp = await mcpConnect(srv.url);
    const gs = await call(mcp, 'get_game_state', { apiKey: sam.apiKey });
    expect(gs.s.wallsAllowed).toBe(true);
    expect(gs.text).not.toContain('Walls are switched off');
    await mcp.close();

    expect((await sam.client.put('/round/selection', { unitIds: ['basic-wall', 'basic-soldier'] })).status).toBe(200);
    await admin.post('/admin/phase/next'); // → PLACEMENT
    const placed = await sam.client.put('/round/placement', {
      placements: [
        { unitId: 'basic-wall', col: 0, row: 0 },
        { unitId: 'basic-soldier', col: 3, row: 3 },
      ],
    });
    expect(placed.status).toBe(200);
    expect(placed.body.counts.walls).toBe(1);
  }, T);
});

describe('Walls allowed: off', () => {
  let srv: RunningServer;
  let dir: string;
  let admin: Client;
  let sam: Awaited<ReturnType<typeof newPlayer>>;
  let bob: Awaited<ReturnType<typeof newPlayer>>;
  let mcp: McpClient;
  let toast: ReturnType<typeof vi.spyOn>;
  let ogreId = '';

  const toasts = () => toast.mock.calls.map((c: unknown[]) => ({ target: c[0], text: String(c[2]) }));

  beforeAll(async () => {
    dir = tempDataDir();
    srv = await bootServer({ dataDir: dir, config: CONFIG });
    admin = await adminClient(srv.url);
    sam = await newPlayer(srv.url, 'Ninja Sam');
    bob = await newPlayer(srv.url, 'Bob');
    mcp = await mcpConnect(srv.url);
    toast = vi.spyOn(srv.game.notifier, 'toast');
  }, T);

  afterAll(async () => {
    await mcp?.close();
    await srv.close();
    removeDir(dir);
  });

  it('is a LOBBY draft setting, picked up by Start match and then locked; a carried-over wall is dropped with a toast', async () => {
    expect((await admin.put('/admin/match/setup', { wallsAllowed: 'no' })).body.error.code).toBe('BAD_REQUEST');
    expect((await admin.post('/admin/match', { rounds: 2, wallsAllowed: 0 })).body.error.code).toBe('BAD_REQUEST');
    expect(((await admin.put('/admin/match/setup', { wallsAllowed: false })).body as MatchSetupDTO).wallsAllowed).toBe(false);
    // Other draft changes keep it.
    expect(((await admin.put('/admin/match/setup', { mapStyle: null, revealNames: true })).body as MatchSetupDTO).wallsAllowed).toBe(false);
    expect(srv.game.store.match.setup).toMatchObject({ wallsAllowed: false, revealNames: true });

    // A selection and last layout carried over from an earlier match (with walls).
    const rs = srv.game.round.stateOf(sam.id);
    rs.selection = ['basic-wall', 'basic-soldier'];
    rs.prevSelection = ['basic-wall', 'basic-soldier'];
    rs.lastLayout = [
      { unitId: 'basic-wall', col: 0, row: 0 },
      { unitId: 'basic-soldier', col: 3, row: 3 },
    ];

    const s = (await admin.post('/admin/match', { rounds: 2, armory: true })).body as GameStateDTO;
    expect(s.phase).toBe('PLAN');
    expect(s.match?.wallsAllowed).toBe(false);
    expect(rs.selection).toEqual(['basic-soldier']);
    expect(rs.prevSelection).toEqual(['basic-soldier']);
    expect(rs.lastLayout).toEqual([{ unitId: 'basic-soldier', col: 3, row: 3 }]);
    expect(toasts()).toContainEqual({ target: { playerId: sam.id }, text: expect.stringContaining('Walls are switched off for this match: Basic Wall was taken out') });
    // Locked for the running match.
    expect((await admin.put('/admin/match/setup', { wallsAllowed: true })).body.error.code).toBe('PHASE_CLOSED');
    expect((await admin.post('/admin/match', { rounds: 2, wallsAllowed: true })).body.error.code).toBe('PHASE_CLOSED');
    expect(((await new Client(srv.url).get('/state')).body as GameStateDTO).match?.wallsAllowed).toBe(false);
    expect(((await admin.get('/admin/match/setup')).body as MatchSetupDTO).wallsAllowed).toBe(false);
  }, T);

  it('shows in /rules, get_rules, get_game_state, the guide and the MCP instructions', async () => {
    const rules = (await bob.client.get('/rules')).body as { wallsAllowed: { allowed: boolean; setting: string; text: string }; thisMatch: { wallsAllowed: boolean } };
    expect(rules.wallsAllowed).toMatchObject({ allowed: false, setting: 'Walls switched off' });
    expect(rules.wallsAllowed.text).toContain('Walls are switched off for this match');
    expect(rules.thisMatch.wallsAllowed).toBe(false);
    expect((await call(mcp, 'get_rules')).s.thisMatch.wallsAllowed).toBe(false);
    const gs = await call(mcp, 'get_game_state', { apiKey: bob.apiKey });
    expect(gs.s.wallsAllowed).toBe(false);
    expect(gs.text).toContain('Walls are switched off for this match');
    const guide = JSON.stringify((await new Client(srv.url).get('/guide')).body);
    expect(guide).toContain('thisMatch.wallsAllowed');
    expect(mcp.getInstructions()).toContain('switch walls off for a match');
  }, T);

  it('walls can still be validated and submitted, but not picked (WALLS_OFF)', async () => {
    const v = await call(mcp, 'validate_unit', { source: WALL_SOURCE, apiKey: sam.apiKey });
    expect(v.s.ok).toBe(true);
    expect(v.text).toContain("Walls are switched off for this match, so it can't be picked");
    const sub = await sam.client.post('/units', { source: WALL_SOURCE });
    expect(sub.status).toBe(200);
    const wallId = sub.body.unit.unitId as string;

    for (const ids of [['basic-wall'], [wallId, 'basic-soldier']]) {
      const r = await sam.client.put('/round/selection', { unitIds: ids });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('WALLS_OFF');
      expect(r.body.error.message).toContain('Walls are switched off for this match');
      expect(r.body.error.hint).toContain('Walls are switched off for this match');
    }
    const ogre = await sam.client.post('/units', { source: namedUnit('Ogre') });
    expect(ogre.status).toBe(200);
    ogreId = ogre.body.unit.unitId as string;
    expect((await sam.client.put('/round/selection', { unitIds: [ogreId, 'basic-tower'] })).status).toBe(200);
    // The roster still lists both walls (the page greys them).
    const roster = (await sam.client.get('/units')).body as { units: Array<{ unitId: string }> } | Array<{ unitId: string }>;
    const ids = (Array.isArray(roster) ? roster : roster.units).map((u) => u.unitId);
    expect(ids).toEqual(expect.arrayContaining(['basic-wall', wallId]));
  }, T);

  it('the lock drops a wall that slipped into a selection (toast); placing a wall gets WALLS_OFF; auto-place skips walls; the battle has no walls', async () => {
    // e.g. a picked design revised into a wall: the lock leaves it out.
    srv.game.round.stateOf(sam.id).selection.push('basic-wall');
    toast.mockClear();
    await admin.post('/admin/phase/next'); // → PLACEMENT
    expect(srv.game.round.lockedDesigns(sam.id).map((d) => d.unitId)).toEqual([ogreId, 'basic-tower']);
    expect(toasts()).toContainEqual({ target: { playerId: sam.id }, text: expect.stringContaining('Basic Wall was taken out') });

    const r = await sam.client.put('/round/placement', { placements: [{ unitId: 'basic-wall', col: 0, row: 0 }] });
    expect(r.body.error.code).toBe('WALLS_OFF');
    expect((await sam.client.put('/round/placement', { placements: [{ unitId: ogreId, col: 2, row: 2 }] })).status).toBe(200);

    // Bob places nothing, with a wall in his last layout: auto-place uses his locked units only.
    srv.game.round.stateOf(bob.id).lastLayout = [{ unitId: 'basic-wall', col: 0, row: 0 }];
    expect((await admin.post('/admin/start', { force: true })).body.phase).toBe('BATTLE');
    expect(srv.game.round.stateOf(bob.id).placements.length).toBeGreaterThan(0);
    expect(srv.game.round.stateOf(bob.id).placements.some((p) => p.unitId === 'basic-wall')).toBe(false);
    await waitForState(bob.client, (st) => st.phase === 'RESULTS', 30_000);

    const replay = (await new Client(srv.url).get('/battles/1/replay')).body;
    const units = replay.reveal.players.flatMap((p: { units: Array<{ stats: { type: string } }> }) => p.units);
    expect(units.length).toBeGreaterThan(0);
    expect(units.some((u: { stats: { type: string } }) => u.stats.type === 'wall')).toBe(false);
    expect(JSON.stringify(replay.frames)).not.toMatch(/"type":"wall"/);
  }, T);

  it('a wall in the Armory cannot be borrowed while walls are off', async () => {
    await admin.post('/admin/phase/next'); // → PLAN round 2
    const entry: ArmoryEntryRecord = {
      ...structuredClone(srv.game.armory.entries()[0]!),
      armoryId: 'ar_wall',
      creatorId: sam.id,
      name: 'Stone Wall',
      stats: { ...srv.game.armory.entries()[0]!.stats, type: 'wall', name: 'Stone Wall' },
      status: 'valid',
    };
    srv.game.store.match.armory!.entries.push(entry);
    const r = await bob.client.put('/round/selection', { unitIds: ['armory:ar_wall'] });
    expect(r.body.error.code).toBe('WALLS_OFF');
    expect(r.body.error.message).toContain('Stone Wall (Ninja Sam)');
    // Other entries can still be borrowed.
    const other = srv.game.armory.entries().find((e) => e.creatorId === sam.id && e.stats.type !== 'wall')!;
    expect(other.name).toBe('Ogre');
    expect((await bob.client.put('/round/selection', { unitIds: [`armory:${other.armoryId}`] })).status).toBe(200);
  }, T);
});
