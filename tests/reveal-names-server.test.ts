// "Show enemy names to units" (plan §9.1a) against a booted server with the
// real validator and isolated-vm sandboxes: the draft toggle and Start match,
// locked once the match runs, shown in /state, /rules, get_rules,
// get_game_state and the guide; the validator's practice worlds carry names;
// in battle the views carry them (a borrowed Armory unit's owner is the
// player who fielded it, and its own sandbox sees the swapped ids).

import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GameStateDTO, MatchSetupDTO } from '@pixel-clash/shared';
import { createRunnerFactory } from '../packages/server/src/sandbox/index.js';
import type { RunnerFactory, TickInput } from '../packages/server/src/sandbox/runner.js';
import type { RunningServer } from '../packages/server/src/server.js';
import { Client, adminClient, bootServer, newPlayer, removeDir, tempDataDir, waitForState } from './helpers/server.js';

const T = 60_000;
const CONFIG = { timers: { battleTicks: 600 }, suddenDeath: { startTick: 400, endTick: 600 } };

/** A soldier that walks to the nearest enemy and hits it. */
function ogre(name = 'Ogre'): string {
  return `
export default class Unit {
  constructor() {
    this.name = ${JSON.stringify(name)};
    this.type = 'soldier';
    this.maxHealth = 1500;
    this.damage = 125;
    this.range = 30;
    this.speed = 3;
    this.attackCooldown = 60;
    this.size = 12;
    this.color = '#7A5230';
  }
  update(self, enemies, allies, world) {
    if (enemies.length === 0) return { action: 'idle' };
    let target = enemies[0];
    let best = Infinity;
    for (const e of enemies) {
      const d = Math.hypot(e.x - self.x, e.y - self.y);
      if (d < best) { best = d; target = e; }
    }
    if (best - self.radius - target.radius <= self.range) return { action: 'attack', targetId: target.id };
    return { action: 'move', destination: { x: target.x, y: target.y } };
  }
}
`;
}

/** Valid when names are hidden; throws (naming what it saw) when they are shown. */
const NAME_PROBE = `
export default class Unit {
  constructor() {
    this.name = 'Probe';
    this.type = 'tower';
    this.maxHealth = 500;
    this.damage = 10;
    this.range = 100;
    this.speed = 0;
    this.attackCooldown = 60;
    this.color = '#336699';
  }
  update(self, enemies, allies, world) {
    if (world.players) {
      const seen = enemies.concat(allies).map((o) => o.ownerName).filter(Boolean);
      throw new Error('NAMES ' + world.players.map((p) => p.name).join('+') + ' / ' + seen.join('+'));
    }
    return { action: 'idle' };
  }
}
`;

async function mcpConnect(url: string): Promise<McpClient> {
  const client = new McpClient({ name: 'reveal-names-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
  return client;
}

async function call(client: McpClient, name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
  return { isError: r.isError === true, s: (r.structuredContent ?? {}) as Record<string, any>, text: JSON.stringify(r) };
}

/** Records the first two tick inputs of every sandbox the battles create (per part for borrowed units). */
function recordingFactory(): { factory: RunnerFactory; runs: Array<{ playerId: string; unitIds: string[]; inputs: TickInput[] }> } {
  const real = createRunnerFactory('ivm');
  const runs: Array<{ playerId: string; unitIds: string[]; inputs: TickInput[] }> = [];
  return {
    runs,
    factory: {
      mode: real.mode,
      async create(player, units, limits) {
        const runner = await real.create(player, units, limits);
        const run = { playerId: player.playerId, unitIds: units.map((u) => u.unitId), inputs: [] as TickInput[] };
        runs.push(run);
        const tick = runner.tick.bind(runner);
        runner.tick = (input: TickInput) => {
          if (run.inputs.length < 2) run.inputs.push(structuredClone(input));
          return tick(input);
        };
        return runner;
      },
    },
  };
}

describe('Show enemy names to units: off by default', () => {
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

  it('the draft, /state, /rules and get_game_state say off, and practice worlds carry no names', async () => {
    const admin = await adminClient(srv.url);
    const sam = await newPlayer(srv.url, 'Ninja Sam');
    await newPlayer(srv.url, 'Bob');
    expect(((await admin.get('/admin/match/setup')).body as MatchSetupDTO).revealNames).toBe(false);
    expect(((await admin.post('/admin/match', { rounds: 1 })).body as GameStateDTO).match?.revealNames).toBe(false);
    expect(((await sam.client.get('/state')).body as GameStateDTO).match?.revealNames).toBe(false);
    const rules = (await sam.client.get('/rules')).body as { revealNames: { enabled: boolean; text: string } };
    expect(rules.revealNames.enabled).toBe(false);
    const mcp = await mcpConnect(srv.url);
    expect((await call(mcp, 'get_game_state', { apiKey: sam.apiKey })).s.revealNames).toBe(false);
    const v = await call(mcp, 'validate_unit', { source: NAME_PROBE, apiKey: sam.apiKey });
    expect(v.s.ok).toBe(true);
    expect(v.text).not.toContain('NAMES');
    await mcp.close();
  }, T);
});

describe('Show enemy names to units: on', () => {
  let srv: RunningServer;
  let dir: string;
  let admin: Client;
  let sam: Awaited<ReturnType<typeof newPlayer>>;
  let bob: Awaited<ReturnType<typeof newPlayer>>;
  let mcp: McpClient;
  let rec: ReturnType<typeof recordingFactory>;

  beforeAll(async () => {
    dir = tempDataDir();
    rec = recordingFactory();
    srv = await bootServer({ dataDir: dir, config: CONFIG, runnerFactory: rec.factory });
    admin = await adminClient(srv.url);
    sam = await newPlayer(srv.url, 'Ninja Sam');
    bob = await newPlayer(srv.url, 'Bob');
    mcp = await mcpConnect(srv.url);
  }, T);

  afterAll(async () => {
    await mcp?.close();
    await srv.close();
    removeDir(dir);
  });

  it('is a LOBBY draft setting, picked up by Start match and then locked', async () => {
    expect((await admin.put('/admin/match/setup', { revealNames: 'yes' })).body.error.code).toBe('BAD_REQUEST');
    expect((await admin.post('/admin/match', { rounds: 2, revealNames: 1 })).body.error.code).toBe('BAD_REQUEST');
    const draft = (await admin.put('/admin/match/setup', { revealNames: true })).body as MatchSetupDTO;
    expect(draft.revealNames).toBe(true);
    // Other draft changes keep it.
    expect(((await admin.put('/admin/match/setup', { mapStyle: null })).body as MatchSetupDTO).revealNames).toBe(true);
    expect(srv.game.store.match.setup).toMatchObject({ revealNames: true });

    const s = (await admin.post('/admin/match', { rounds: 2, armory: true })).body as GameStateDTO;
    expect(s.phase).toBe('PLAN');
    expect(s.match?.revealNames).toBe(true);
    // Locked for the running match.
    expect((await admin.put('/admin/match/setup', { revealNames: false })).body.error.code).toBe('PHASE_CLOSED');
    expect((await admin.post('/admin/match', { rounds: 2, revealNames: false })).body.error.code).toBe('PHASE_CLOSED');
    expect(((await new Client(srv.url).get('/state')).body as GameStateDTO).match?.revealNames).toBe(true);
  }, T);

  it('shows in /rules, get_rules, get_game_state, the guide and the MCP instructions', async () => {
    const rules = (await bob.client.get('/rules')).body as { revealNames: { enabled: boolean; setting: string }; thisMatch: { revealNames: boolean } };
    expect(rules.revealNames).toMatchObject({ enabled: true, setting: 'Show enemy names to units' });
    expect(rules.thisMatch.revealNames).toBe(true);
    expect((await call(mcp, 'get_rules')).s.revealNames.enabled).toBe(true);
    const gs = await call(mcp, 'get_game_state', { apiKey: bob.apiKey });
    expect(gs.s.revealNames).toBe(true);
    expect(gs.text).toContain('Show enemy names to units is ON');
    const guide = JSON.stringify((await new Client(srv.url).get('/guide')).body);
    for (const f of ['ownerName', 'teamName', 'players']) expect(guide).toContain(`\`${f}\``);
    expect(guide).toContain("only when the match setting 'Show enemy names to units' is on");
    expect(mcp.getInstructions()).toContain('Show enemy names to units');
  }, T);

  it("the validator's practice worlds carry the player's name and a practice enemy", async () => {
    const v = await call(mcp, 'validate_unit', { source: NAME_PROBE, apiKey: sam.apiKey });
    expect(v.s.ok).toBe(false);
    expect(v.text).toContain('NAMES Ninja Sam+Practice Enemy');
    expect(v.text).toMatch(/NAMES Ninja Sam\+Practice Enemy \/ (Ninja Sam|Practice Enemy)/);
  }, T);

  it('round 1: views name every body', async () => {
    expect((await sam.client.post('/units', { source: ogre() })).status).toBe(200);
    expect((await sam.client.put('/round/selection', { unitIds: ['ogre'] })).status).toBe(200);
    await admin.post('/admin/phase/next'); // → PLACEMENT
    await sam.client.put('/round/placement', { placements: [{ unitId: 'ogre', col: 0, row: 0 }] });
    rec.runs.length = 0;
    expect((await admin.post('/admin/start', { force: true })).body.phase).toBe('BATTLE');
    await waitForState(bob.client, (st) => st.phase === 'RESULTS', 30_000);

    const bobRun = rec.runs.find((r) => r.playerId === bob.id)!;
    const input = bobRun.inputs[0]!;
    expect(input.enemies.length).toBeGreaterThan(0);
    for (const e of input.enemies) expect([e.ownerId, e.ownerName]).toEqual([sam.id, 'Ninja Sam']);
    for (const a of input.allies) expect([a.ownerId, a.ownerName]).toEqual([bob.id, 'Bob']);
    expect([...input.enemies, ...input.allies].some((o) => 'teamName' in o)).toBe(false);
    expect(new Map(input.world.players!.map((p) => [p.id, p.name]))).toEqual(
      new Map([
        [sam.id, 'Ninja Sam'],
        [bob.id, 'Bob'],
      ]),
    );
  }, T);

  it("round 2: a borrowed Armory unit carries the name of the player who fielded it; its sandbox sees swapped ids", async () => {
    await admin.post('/admin/phase/next'); // → PLAN round 2
    const borrowId = `armory:${srv.game.armory.entries()[0]!.armoryId}`;
    expect((await bob.client.put('/round/selection', { unitIds: [borrowId] })).status).toBe(200);
    expect((await sam.client.put('/round/selection', { unitIds: ['ogre'] })).status).toBe(200);
    await admin.post('/admin/phase/next'); // → PLACEMENT
    expect((await bob.client.put('/round/placement', { placements: [{ unitId: borrowId, col: 0, row: 0 }] })).status).toBe(200);
    await sam.client.put('/round/placement', { placements: [{ unitId: 'ogre', col: 0, row: 0 }] });
    rec.runs.length = 0;
    expect((await admin.post('/admin/start', { force: true })).body.phase).toBe('BATTLE');
    await waitForState(bob.client, (st) => st.phase === 'RESULTS', 30_000);

    // Sam sees Bob's borrowed Ogre as Bob's.
    const samIn = rec.runs.find((r) => r.playerId === sam.id)!.inputs[0]!;
    expect(samIn.enemies.map((e) => [e.name, e.ownerId, e.ownerName])).toEqual([['Ogre', bob.id, 'Bob']]);
    // The borrowed part runs under Sam's ids: ownerId and world.players ids are swapped, names stay.
    const part = rec.runs.find((r) => r.playerId === bob.id)!;
    expect(part.unitIds).toEqual(['ogre']);
    const partIn = part.inputs[0]!;
    expect(partIn.selves.map((s) => s.ownerId)).toEqual([sam.id]);
    expect(partIn.enemies.map((e) => [e.ownerId, e.ownerName])).toEqual([[bob.id, 'Ninja Sam']]);
    expect(new Map(partIn.world.players!.map((p) => [p.id, p.name]))).toEqual(
      new Map([
        [bob.id, 'Ninja Sam'],
        [sam.id, 'Bob'],
      ]),
    );
  }, T);
});
