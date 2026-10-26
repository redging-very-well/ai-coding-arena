// Per-team budgets: in team mode the host can give each team its
// own budget per player in the LOBBY match setup (e.g. a 4v2 where the smaller
// team gets $20,000). Checked: validation and the lock at Start match, the
// placement budget per team, /state me.budget, get_game_state, and
// free-for-all unchanged.

import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GameStateDTO, MatchSetupDTO } from '@pixel-clash/shared';
import type { RunningServer } from '../packages/server/src/server.js';
import { adminClient, bootServer, newPlayer, removeDir, tempDataDir } from './helpers/server.js';

const T = 60_000;
const CONFIG = { timers: { battleTicks: 600 }, suddenDeath: { startTick: 400, endTick: 600 } };

/** Fighters on distinct cells: `n` soldiers then `m` towers. */
function army(n: number, m: number) {
  const out: Array<{ unitId: string; col: number; row: number }> = [];
  for (let i = 0; i < n + m; i++) out.push({ unitId: i < n ? 'basic-soldier' : 'basic-tower', col: i % 6, row: Math.floor(i / 6) });
  return out;
}

describe('Per-team budgets', () => {
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

  it('free-for-all: no team budgets, me.budget is the config budget, teamBudgets refused', async () => {
    const admin = await adminClient(srv.url);
    const sam = await newPlayer(srv.url, 'Ninja Sam');
    const setup = (await admin.get('/admin/match/setup')).body as MatchSetupDTO;
    expect(setup).toMatchObject({ teamMode: 'ffa', teamBudgets: null, defaultBudget: 10000 });
    const bad = await admin.put('/admin/match/setup', { teamBudgets: [20000] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('BAD_REQUEST');
    expect(((await sam.client.get('/state')).body as GameStateDTO).me!.budget).toBe(10000);
    await admin.post(`/admin/players/${sam.id}/kick`, {});
  }, T);

  it('4v2: Team 2 gets $20,000; validation, lock, placement, /state and get_game_state', async () => {
    const admin = await adminClient(srv.url);
    const ps = [];
    for (const name of ['A1', 'A2', 'A3', 'B1', 'B2', 'B3']) ps.push(await newPlayer(srv.url, name));
    let setup = (await admin.put('/admin/match/setup', { teamMode: 'teams2' })).body as MatchSetupDTO;
    expect(setup.teamBudgets).toEqual([10000, 10000]);
    await admin.post('/admin/teams/move', { playerId: setup.teams![1]!.members[0], teamId: 0 });

    // Validation: whole numbers 1..10× the default, at most one per team.
    for (const bad of [[0], [1.5], ['20000'], [10000, 100001], [1, 2, 3], 5000]) {
      const r = await admin.put('/admin/match/setup', { teamBudgets: bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(r.body.error.code).toBe('BAD_REQUEST');
    }
    setup = (await admin.put('/admin/match/setup', { teamBudgets: [null, 20000] })).body as MatchSetupDTO;
    expect(setup.teamBudgets).toEqual([10000, 20000]);
    expect(setup.teams!.map((t) => t.members.length)).toEqual([4, 2]);
    // Stored only for the team that differs.
    expect(srv.game.store.match.setup.teamBudgets).toEqual({ '1': 20000 });

    const s = (await admin.post('/admin/match', { rounds: 1 })).body as GameStateDTO;
    expect(s.match?.teamBudgets).toEqual([10000, 20000]);
    const locked = await admin.put('/admin/match/setup', { teamBudgets: [null, 30000] });
    expect(locked.body.error.code).toBe('PHASE_CLOSED');

    const teams = srv.game.store.match.teams!;
    const t1 = ps.find((p) => teams[0]!.members.includes(p.id))!;
    const t2 = ps.find((p) => teams[1]!.members.includes(p.id))!;
    expect(((await t1.client.get('/state')).body as GameStateDTO).me!.budget).toBe(10000);
    expect(((await t2.client.get('/state')).body as GameStateDTO).me!.budget).toBe(20000);

    for (const p of [t1, t2]) expect((await p.client.put('/round/selection', { unitIds: ['basic-soldier', 'basic-tower'] })).status).toBe(200);
    await admin.post('/admin/phase/next'); // → PLACEMENT

    // The biggest army of the two basics that fits $20,000 but not $10,000.
    let placements: ReturnType<typeof army> | null = null;
    let spent = 0;
    for (let n = 1; n <= 12 && !placements; n++) {
      for (let m = 0; n + m <= 12; m++) {
        const r = await t2.client.put('/round/placement', { placements: army(n, m) });
        if (r.status === 200 && r.body.spent > 10000) {
          placements = army(n, m);
          spent = r.body.spent;
          expect(r.body.remaining).toBe(20000 - spent);
          break;
        }
      }
    }
    expect(placements, 'an army between $10,000 and $20,000').not.toBeNull();
    expect(spent).toBeLessThanOrEqual(20000);
    const refused = await t1.client.put('/round/placement', { placements });
    expect(refused.body.error.code).toBe('OVER_BUDGET');
    expect(refused.body.error.details).toMatchObject({ spent, budget: 10000 });

    const mcp = new McpClient({ name: 'team-budgets-test', version: '1.0.0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${srv.url}/mcp`)));
    const gs = (await mcp.callTool({ name: 'get_game_state', arguments: { apiKey: t2.apiKey } })) as CallToolResult;
    expect((gs.structuredContent as { myBudget: number }).myBudget).toBe(20000);
    expect(JSON.stringify(gs)).toContain('Budgets differ by team');
    await mcp.close();
  }, T);
});
