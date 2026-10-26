// MCP end to end (plan §14 mcp.e2e.test.ts): the SDK Client +
// StreamableHTTPClientTransport against a booted server.

import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrivateStateDTO } from '@pixel-clash/shared';
import type { RunningServer } from '../packages/server/src/server.js';
import { WsRecorder, adminClient, bootServer, fixture, namedUnit, newPlayer, removeDir, tempDataDir } from './helpers/server.js';

const T = 60_000;

type Structured = Record<string, any>;

async function connect(url: string, headers?: Record<string, string>): Promise<McpClient> {
  const client = new McpClient({ name: 'pixel-clash-e2e', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), headers ? { requestInit: { headers } } : undefined);
  await client.connect(transport);
  return client;
}

async function call(client: McpClient, name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
  return { isError: r.isError === true, s: (r.structuredContent ?? {}) as Structured, text: (r.content[0] as { text: string }).text };
}

describe('MCP (stateless Streamable HTTP)', () => {
  let srv: RunningServer;
  let dir: string;
  let player: Awaited<ReturnType<typeof newPlayer>>;
  let mcp: McpClient;
  let apiKey: string;

  beforeAll(async () => {
    dir = tempDataDir();
    srv = await bootServer({ dataDir: dir });
    player = await newPlayer(srv.url, 'Claudia', '4821');
    await newPlayer(srv.url, 'Other');
    mcp = await connect(srv.url);
  }, T);

  afterAll(async () => {
    await mcp?.close();
    await srv.close();
    removeDir(dir);
  });

  it('lists the tools without any auth', async () => {
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'get_battle_report',
        'get_game_state',
        'get_rules',
        'get_unit_contract',
        'list_my_units',
        'list_armory',
        'get_unit_source',
        'login',
        'submit_unit',
        'validate_unit',
        'wait_for_phase',
      ].sort(),
    );
    for (const t of tools) expect(t.outputSchema).toBeDefined();
    const submit = tools.find((t) => t.name === 'submit_unit')!;
    expect(Object.keys(submit.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(['source', 'unitId', 'apiKey']));
    expect(mcp.getInstructions()).toContain('login');
    // M8.8 (§10.6): one line on elements, splash and support; no new tools.
    expect(mcp.getInstructions()).toContain('element (fire, ice, lightning), splash (splashRadius) and one support (heal, haste, might, shield)');
    expect(mcp.getInstructions()).toContain('at most 12 fighters');
    expect(mcp.getInstructions()).toContain('never volunteer strategy advice');
    const desc = (n: string) => tools.find((t) => t.name === n)!.description!;
    expect(desc('get_rules')).toMatch(/elements .*support/);
    expect(desc('get_unit_contract')).toContain('elements, splash and support');
    expect(desc('get_battle_report')).toMatch(/damage split .*healing/);
  });

  it('get_rules and get_unit_contract work without a key; other tools say AUTH_REQUIRED', async () => {
    const rules = await call(mcp, 'get_rules');
    expect(rules.isError).toBe(false);
    expect(rules.s).toMatchObject({ ok: true, budget: 10000, scoring: { placePoints: [3, 2, 1, 0], damageBonusMax: 2, valueBonusMax: 1 } });
    expect(rules.s.scoring.badges).toHaveLength(7);
    expect(rules.s.armory).toMatchObject({ enabled: false });
    expect(JSON.stringify(rules.s.scoring)).toContain('no overkill');
    const contract = await call(mcp, 'get_unit_contract');
    expect(contract.s.typescript).toContain('interface WorldView');
    expect(contract.s.templates.basic_soldier).toContain('export default class');
    // M8.8 (§10.6): the rules and contract teach elements, splash and support.
    expect(rules.s).toMatchObject({ caps: { unitCost: 3000 }, coefficients: { curveK: 1, powerFactor: 2 } });
    expect(rules.s.copyRamp).toMatchObject({ freeCopies: 3, pctPerCopy: 15 });
    expect(rules.s.elements.lightning).toContain('35%');
    expect(rules.s.support.text).toContain("{ action: 'heal', targetId: ally.id }");
    expect(contract.s.notes.join('\n')).toContain('SHATTER');
    const state = await call(mcp, 'get_game_state');
    expect(state.isError).toBe(true);
    expect(state.s.errors[0]).toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(state.s.errors[0].fix).toContain('login');
  });

  it('a bad Bearer key: tools/list still works (HTTP 200), tools say KEY_INVALID', async () => {
    const raw = await fetch(`${srv.url}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer pc_wrongwrongwrongwrongwron',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(raw.status).toBe(200);
    const bad = await connect(srv.url, { Authorization: 'Bearer pc_wrongwrongwrongwrongwron' });
    expect((await bad.listTools()).tools.length).toBe(11);
    const r = await call(bad, 'list_my_units');
    expect(r.isError).toBe(true);
    expect(r.s.errors[0].code).toBe('KEY_INVALID');
    await bad.close();
  });

  it('login returns an apiKey and the apiKey argument path works', async () => {
    const badLogin = await call(mcp, 'login', { name: 'Claudia', pin: '0000' });
    expect(badLogin.isError).toBe(true);
    expect(badLogin.s.errors[0].code).toBe('BAD_LOGIN');
    const r = await call(mcp, 'login', { name: 'claudia', pin: '4821' });
    expect(r.isError).toBe(false);
    expect(r.s).toMatchObject({ ok: true, player: { name: 'Claudia' } });
    expect(r.text).toContain('.pixel-clash/player.json');
    apiKey = r.s.apiKey;
    expect(apiKey).toBe(player.apiKey);
    const units = await call(mcp, 'list_my_units', { apiKey });
    expect(units.s.units.map((u: { unitId: string }) => u.unitId)).toEqual(['basic-soldier', 'basic-tower', 'basic-wall', 'basic-factory']);
    const st = await call(mcp, 'get_game_state', { apiKey });
    expect(st.s).toMatchObject({ phase: 'LOBBY', submissionsOpen: false, myBudget: 10000 });
  });

  it('validate_unit: bad code gives structured errors with fixes; good code a cost', async () => {
    const bad = await call(mcp, 'validate_unit', { source: fixture('bad/stat_out_of_range.js'), apiKey });
    expect(bad.isError).toBe(true);
    expect(bad.s.ok).toBe(false);
    expect(bad.s.errors[0]).toMatchObject({ code: 'STAT_OUT_OF_RANGE' });
    expect(typeof bad.s.errors[0].fix).toBe('string');
    expect(typeof bad.s.playerHint).toBe('string');
    const syntax = await call(mcp, 'validate_unit', { source: fixture('bad/syntax_error.js'), apiKey });
    expect(syntax.s.errors[0]).toMatchObject({ code: 'SYNTAX_ERROR' });
    expect(syntax.s.errors[0].line).toBeGreaterThan(0);
    const good = await call(mcp, 'validate_unit', { source: fixture('good/sniper_tower.js'), apiKey });
    expect(good.isError).toBe(false);
    expect(good.s).toMatchObject({ ok: true, unit: { cost: 1831 } });
  });

  it('submit_unit in LOBBY → PHASE_CLOSED', async () => {
    const r = await call(mcp, 'submit_unit', { source: fixture('good/sniper_tower.js'), apiKey });
    expect(r.isError).toBe(true);
    expect(r.s.errors[0]).toMatchObject({ code: 'PHASE_CLOSED', details: { phase: 'LOBBY', opensIn: 'PLAN' } });
    expect(r.s.playerHint).toContain('Plan');
  });

  it('in PLAN, submit works and the player\'s open page gets `private` within 1 s', async () => {
    const admin = await adminClient(srv.url);
    expect((await admin.post('/admin/match', { rounds: 2 })).body.phase).toBe('PLAN');
    const ws = await WsRecorder.open(srv.url, 'player', player.client.cookieHeader());
    try {
      let arrivedAt = 0;
      const pushed = ws
        .next((m) => m.type === 'private' && (m.data as PrivateStateDTO).roster.some((u) => u.unitId === 'sniper-tower'), 5000)
        .then((m) => {
          arrivedAt = Date.now();
          return m;
        });
      const r = await call(mcp, 'submit_unit', { source: fixture('good/sniper_tower.js'), apiKey });
      const submittedAt = Date.now();
      expect(r.isError).toBe(false);
      expect(r.s).toMatchObject({ ok: true, unitId: 'sniper-tower', version: 1, unit: { cost: 1831 } });
      const msg = (await pushed) as { data: PrivateStateDTO };
      // Pushed within 1 s of the submit (in practice before the tool result even arrives).
      expect(arrivedAt - submittedAt).toBeLessThan(1000);
      const card = msg.data.roster.find((u) => u.unitId === 'sniper-tower')!;
      expect(card).toMatchObject({ name: 'Sniper Tower', cost: 1831, version: 1, status: 'valid', isTemplate: false });
    } finally {
      ws.close();
    }
    const list = await call(mcp, 'list_my_units', { apiKey });
    expect(list.s.units.map((u: { unitId: string }) => u.unitId)).toContain('sniper-tower');
    const src = await call(mcp, 'get_unit_source', { unitId: 'sniper-tower', apiKey });
    expect(src.s).toMatchObject({ version: 1 });
    expect(src.s.source).toContain('Sniper Tower');
    // A revision with unitId (and a rename) keeps the design.
    const rev = await call(mcp, 'submit_unit', { source: namedUnit('Sniper Tower Mk2'), unitId: 'sniper-tower', apiKey });
    expect(rev.s).toMatchObject({ unitId: 'sniper-tower', version: 2 });
  });

  it('the Bearer header path works', async () => {
    const withKey = await connect(srv.url, { Authorization: `Bearer ${player.apiKey}` });
    const st = await call(withKey, 'get_game_state');
    expect(st.isError).toBe(false);
    expect(st.s).toMatchObject({ phase: 'PLAN', submissionsOpen: true, player: { name: 'Claudia' } });
    await withKey.close();
  });

  it('get_battle_report before any battle → NOT_FOUND', async () => {
    const r = await call(mcp, 'get_battle_report', { apiKey });
    expect(r.isError).toBe(true);
    expect(r.s.errors[0].code).toBe('NOT_FOUND');
  });

  it('keeps working after a server restart (stateless transport)', async () => {
    const port = srv.port;
    await srv.close();
    srv = await bootServer({ dataDir: dir, port });
    const st = await call(mcp, 'get_game_state', { apiKey });
    expect(st.isError).toBe(false);
    expect(st.s).toMatchObject({ phase: 'PLAN', round: 1 });
    const list = await call(mcp, 'list_my_units', { apiKey });
    expect(list.s.units.find((u: { unitId: string }) => u.unitId === 'sniper-tower')).toMatchObject({ version: 2, name: 'Sniper Tower Mk2' });
  }, T);

  it('rejects a foreign Origin; GET /mcp is 405', async () => {
    const res = await fetch(`${srv.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', origin: 'http://evil.example' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(403);
    const local = await fetch(`${srv.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', origin: `http://127.0.0.1:${srv.port}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(local.status).toBe(200);
    expect((await fetch(`${srv.url}/mcp`)).status).toBe(405);
  });
});
