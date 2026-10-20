// Open Armory (plan §9.1, §14 armory.test.ts) against a booted server with the
// real validator and isolated-vm sandboxes:
//   * toggle off → nothing enters; on → only FIELDED types enter, and only
//     when the battle's result is released (not at START, never unfielded
//     designs);
//   * frozen copies (a later submit doesn't change the entry; fielding v2
//     replaces it), creator exclusion, display name "Ogre (Ninja Sam)" in the
//     selection, reveal, results and report, ≤ 3 types including borrowed;
//   * a borrowed unit runs in the BORROWER's sandbox and its damage/points are
//     the borrower's; its code is never shared (get_unit_source → NOT_FOUND);
//   * 💡 Inventor badge, re-price invalidation, Hide sprite propagation,
//     persistence across a restart, kicked creators' entries stay, New match
//     clears.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ArmoryCardDTO, BattleReportDTO, GameStateDTO } from '@pixel-clash/shared';
import { createRunnerFactory } from '../packages/server/src/sandbox/index.js';
import type { RunnerFactory } from '../packages/server/src/sandbox/runner.js';
import type { RunningServer } from '../packages/server/src/server.js';
import { armoryFileName } from '../packages/server/src/services/store.js';
import { Client, adminClient, bootServer, newPlayer, removeDir, tempDataDir, waitForState } from './helpers/server.js';

const T = 60_000;

/** Long enough for the two armies to meet (fast playback keeps it short). */
const CONFIG = { timers: { battleTicks: 900 }, suddenDeath: { startTick: 600, endTick: 900 } };

/** A fast melee soldier that chases the nearest enemy and throws once (tick 10). */
function ogre(opts: { name?: string; damage?: number } = {}): string {
  return `
export default class Unit {
  constructor() {
    this.name = ${JSON.stringify(opts.name ?? 'Ogre')};
    this.type = 'soldier';
    this.maxHealth = 200;
    this.damage = ${opts.damage ?? 25};
    this.range = 30;
    this.speed = 3;
    this.attackCooldown = 60;
    this.size = 12;
    this.color = '#7A5230';
  }

  update(self, enemies, allies, world) {
    const tag = 'OGRE-MARKER';
    if (world.tick === 10) throw new Error('grumpy ' + tag);
    if (enemies.length === 0) return { action: 'idle' };
    let target = enemies[0];
    let best = Infinity;
    for (const e of enemies) {
      const d = Math.hypot(e.x - self.x, e.y - self.y);
      if (d < best) { best = d; target = e; }
    }
    const gap = best - self.radius - target.radius;
    if (gap <= self.range) return { action: 'attack', targetId: target.id };
    return { action: 'move', destination: { x: target.x, y: target.y } };
  }
}
`;
}

async function mcpConnect(url: string): Promise<McpClient> {
  const client = new McpClient({ name: 'armory-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
  return client;
}

async function call(client: McpClient, name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
  return { isError: r.isError === true, s: (r.structuredContent ?? {}) as Record<string, any>, text: JSON.stringify(r) };
}

/** Records which units each player's battle sandbox was created with. */
function recordingFactory(): { factory: RunnerFactory; calls: Array<{ playerId: string; units: Array<{ unitId: string; compiledJs: string }> }> } {
  const real = createRunnerFactory('ivm');
  const calls: Array<{ playerId: string; units: Array<{ unitId: string; compiledJs: string }> }> = [];
  return {
    calls,
    factory: {
      mode: real.mode,
      async create(player, units, limits) {
        calls.push({ playerId: player.playerId, units: units.map((u) => ({ unitId: u.unitId, compiledJs: u.compiledJs })) });
        return real.create(player, units, limits);
      },
    },
  };
}

async function playBattle(admin: Client, watcher: Client): Promise<GameStateDTO> {
  const s = (await admin.post('/admin/start', { force: true })).body as GameStateDTO;
  expect(s.phase).toBe('BATTLE');
  return waitForState(watcher, (st) => st.phase === 'RESULTS', 30_000);
}

describe('Open Armory: off (the default)', () => {
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

  it('nothing enters the Armory and armory ids are refused', async () => {
    const admin = await adminClient(srv.url);
    const sam = await newPlayer(srv.url, 'Ninja Sam');
    const bob = await newPlayer(srv.url, 'Bob');
    expect((await admin.post('/admin/match', { rounds: 2, armory: 'yes' })).status).toBe(400);
    const started = (await admin.post('/admin/match', { rounds: 2 })).body as GameStateDTO;
    expect(started.armory).toEqual({ enabled: false, entries: 0 });
    expect(((await sam.client.get('/rules')).body as { armory: { enabled: boolean } }).armory.enabled).toBe(false);
    expect((await sam.client.post('/units', { source: ogre() })).status).toBe(200);
    await sam.client.put('/round/selection', { unitIds: ['ogre'] });
    await admin.post('/admin/phase/next');
    await sam.client.put('/round/placement', { placements: [{ unitId: 'ogre', col: 0, row: 0 }] });
    await playBattle(admin, bob.client);

    expect(srv.game.armory.entries()).toHaveLength(0);
    expect(srv.game.visibility.privateState(bob.id)!).toMatchObject({ armoryEnabled: false, armory: [] });
    await admin.post('/admin/phase/next'); // → PLAN round 2
    const r = await bob.client.put('/round/selection', { unitIds: ['armory:ar_00000000'] });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('ARMORY_OFF');
    const mcp = await mcpConnect(srv.url);
    const list = await call(mcp, 'list_armory', { apiKey: bob.apiKey });
    expect(list.isError).toBe(false);
    expect(list.s).toMatchObject({ ok: true, enabled: false, entries: [] });
    await mcp.close();
  }, T);
});

describe('Open Armory: on', () => {
  let srv: RunningServer;
  let dir: string;
  let admin: Client;
  let sam: Awaited<ReturnType<typeof newPlayer>>;
  let bob: Awaited<ReturnType<typeof newPlayer>>;
  let mcp: McpClient;
  let rec: ReturnType<typeof recordingFactory>;
  let armoryId = '';
  const borrowId = () => `armory:${armoryId}`;

  const boot = async () => {
    srv = await bootServer({ dataDir: dir, config: CONFIG, runnerFactory: rec.factory });
    admin = await adminClient(srv.url);
    // After a restart the port changes: talk to the new server with the (persisted) API keys.
    for (const p of [sam, bob]) if (p) p.client = Object.assign(new Client(srv.url), { bearer: p.apiKey });
    mcp = await mcpConnect(srv.url);
  };

  beforeAll(async () => {
    dir = tempDataDir();
    rec = recordingFactory();
    await boot();
    sam = await newPlayer(srv.url, 'Ninja Sam');
    bob = await newPlayer(srv.url, 'Bob');
  }, T);

  afterAll(async () => {
    await mcp?.close();
    await srv.close();
    removeDir(dir);
  });

  it('Start match with Open Armory: shown in /state, /rules, get_rules and get_game_state, and locked', async () => {
    const s = (await admin.post('/admin/match', { rounds: 3, armory: true })).body as GameStateDTO;
    expect(s.phase).toBe('PLAN');
    expect(s.armory).toEqual({ enabled: true, entries: 0 });
    expect(((await new Client(srv.url).get('/state')).body as GameStateDTO).armory.enabled).toBe(true);
    expect(((await bob.client.get('/rules')).body as { armory: { enabled: boolean } }).armory.enabled).toBe(true);
    expect((await call(mcp, 'get_rules')).s.armory.enabled).toBe(true);
    expect((await call(mcp, 'get_game_state', { apiKey: bob.apiKey })).s.armory).toEqual({ enabled: true, entries: 0 });
    // Locked: a running match can't be restarted with another setting.
    expect((await admin.post('/admin/match', { rounds: 3, armory: false })).body.error.code).toBe('PHASE_CLOSED');
    expect(srv.game.visibility.privateState(bob.id)!.armoryEnabled).toBe(true);
  }, T);

  it('round 1: only fielded types enter, and only when the result is released', async () => {
    expect((await sam.client.post('/units', { source: ogre() })).status).toBe(200);
    expect((await sam.client.post('/units', { source: ogre({ name: 'Shy Guy' }) })).status).toBe(200);
    expect((await sam.client.put('/round/selection', { unitIds: ['ogre', 'shy-guy'] })).status).toBe(200);
    // Unknown armory ids are refused.
    const unknown = await bob.client.put('/round/selection', { unitIds: ['armory:ar_deadbeef'] });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('NOT_FOUND');
    await admin.post('/admin/phase/next'); // → PLACEMENT
    // Sam fields only the Ogre (Shy Guy stays unfielded).
    await sam.client.put('/round/placement', { placements: [{ unitId: 'ogre', col: 0, row: 0 }] });
    expect((await admin.post('/admin/start', { force: true })).body.phase).toBe('BATTLE');

    // During BATTLE (revealed, result held): no entry exists or is visible.
    expect(srv.game.armory.entries()).toHaveLength(0);
    expect(((await bob.client.get('/state')).body as GameStateDTO).armory.entries).toBe(0);
    expect(srv.game.visibility.privateState(bob.id)!.armory).toEqual([]);
    expect((await call(mcp, 'list_armory', { apiKey: bob.apiKey })).s.entries).toEqual([]);

    await waitForState(bob.client, (st) => st.phase === 'RESULTS', 30_000);
    const entries = srv.game.armory.entries();
    expect(entries.map((e) => e.name)).toEqual(['Ogre']);
    expect(entries[0]).toMatchObject({ creatorId: sam.id, creatorName: 'Ninja Sam', sourceUnitId: 'ogre', version: 1, roundAdded: 1, status: 'valid' });
    armoryId = entries[0]!.armoryId;
    // Templates never enter (Bob was auto-placed with them).
    expect(entries.some((e) => e.creatorId === bob.id)).toBe(false);

    // Bob sees "Ogre (Ninja Sam)"; the raw name stays in stats.
    const bobArmory = srv.game.visibility.privateState(bob.id)!.armory;
    expect(bobArmory).toHaveLength(1);
    expect(bobArmory[0]).toMatchObject({ unitId: borrowId(), name: 'Ogre (Ninja Sam)', displayName: 'Ogre (Ninja Sam)', creatorName: 'Ninja Sam', roundAdded: 1 });
    expect(bobArmory[0]!.stats.name).toBe('Ogre');
    // The creator doesn't see their own entry as borrowable.
    expect(srv.game.visibility.privateState(sam.id)!.armory).toEqual([]);
    expect((await call(mcp, 'list_armory', { apiKey: sam.apiKey })).s.entries).toEqual([]);

    const list = await call(mcp, 'list_armory', { apiKey: bob.apiKey });
    expect(list.s.enabled).toBe(true);
    expect(list.s.entries).toHaveLength(1);
    expect(list.s.entries[0]).toMatchObject({ armoryId, displayName: 'Ogre (Ninja Sam)', creatorName: 'Ninja Sam', roundAdded: 1, status: 'valid' });
    expect(list.s.entries[0].cost).toBeGreaterThan(0);
    expect(list.s.entries[0].breakdown).toBeDefined();
    expect((await bob.client.get('/state')).body.armory.entries).toBe(1);

    // The unfielded design and the source never reach Bob.
    const bobPayloads = [JSON.stringify(srv.game.visibility.privateState(bob.id)), list.text, (await bob.client.get('/state')).text];
    for (const p of bobPayloads) {
      expect(p).not.toContain('Shy Guy');
      expect(p).not.toContain('OGRE-MARKER');
      expect(p).not.toContain('compiledJs');
    }
  }, T);

  it('the code of a borrowed unit is never shared or changeable', async () => {
    const rest = await bob.client.get(`/units/${encodeURIComponent(borrowId())}`);
    expect(rest.status).toBe(404);
    expect(rest.text).not.toContain('OGRE-MARKER');
    const src = await call(mcp, 'get_unit_source', { unitId: borrowId(), apiKey: bob.apiKey });
    expect(src.isError).toBe(true);
    expect(src.s.errors[0].code).toBe('NOT_FOUND');
    expect(src.text).not.toContain('OGRE-MARKER');
    // Even the creator can't fetch source by the armory id.
    expect((await call(mcp, 'get_unit_source', { unitId: borrowId(), apiKey: sam.apiKey })).s.errors[0].code).toBe('NOT_FOUND');
    // A revision aimed at the armory id is refused too.
    const v = await call(mcp, 'validate_unit', { source: ogre(), unitId: borrowId(), apiKey: bob.apiKey });
    expect(v.isError).toBe(true);
    expect(v.s.errors[0].code).toBe('NOT_FOUND');
  }, T);

  it('round 2: frozen copy, ≤ 3 types incl. borrowed, creator excluded, Hide sprite propagates', async () => {
    await admin.post('/admin/phase/next'); // → PLAN round 2
    // Sam's later revision (more damage) doesn't change the entry.
    expect((await sam.client.post('/units', { source: ogre({ damage: 35 }), unitId: 'ogre' })).status).toBe(200);
    expect(srv.game.armory.entry(armoryId)).toMatchObject({ version: 1 });
    expect(srv.game.armory.entry(armoryId)!.stats.damage).toBe(25);
    expect(srv.game.visibility.privateState(bob.id)!.armory[0]!.stats.damage).toBe(25);

    // The creator can't borrow their own entry.
    const own = await sam.client.put('/round/selection', { unitIds: [borrowId()] });
    expect(own.status).toBe(400);
    expect(own.body.error.code).toBe('ARMORY_OWN_UNIT');
    // ≤ 3 types in total, borrowed ones included.
    expect((await bob.client.post('/units', { source: ogre({ name: 'Bob Brute' }) })).status).toBe(200);
    const four = await bob.client.put('/round/selection', { unitIds: [borrowId(), 'bob-brute', 'basic-soldier', 'basic-tower'] });
    expect(four.body.error.code).toBe('TOO_MANY_TYPES');
    expect((await bob.client.put('/round/selection', { unitIds: [borrowId(), 'bob-brute', 'basic-soldier'] })).status).toBe(200);
    // Bob borrows only the Ogre; Sam fields his own (v2): a mirror match.
    const sel = await bob.client.put('/round/selection', { unitIds: [borrowId()] });
    expect(sel.body.selection).toEqual([borrowId()]);
    expect(srv.game.visibility.privateState(bob.id)!.armory[0]!.selected).toBe(true);
    expect((await sam.client.put('/round/selection', { unitIds: ['ogre'] })).status).toBe(200);

    // Hide sprite on the design hides the entry's sprite too.
    await admin.post(`/admin/units/${sam.id}/ogre/sprite`, { hidden: true });
    expect(srv.game.visibility.privateState(bob.id)!.armory[0]).toMatchObject({ spriteHidden: true, sprite: null });
    await admin.post(`/admin/units/${sam.id}/ogre/sprite`, { hidden: false });
    expect(srv.game.visibility.privateState(bob.id)!.armory[0]!.spriteHidden).toBe(false);

    await admin.post('/admin/phase/next'); // → PLACEMENT
    const placed = await bob.client.put('/round/placement', { placements: [{ unitId: borrowId(), col: 0, row: 0 }] });
    expect(placed.status).toBe(200);
    expect(placed.body.spent).toBe(srv.game.armory.entry(armoryId)!.cost);
    await sam.client.put('/round/placement', { placements: [{ unitId: 'ogre', col: 0, row: 0 }] });
  }, T);

  it('a borrowed unit fights in the borrower’s sandbox; damage and points are the borrower’s; 💡 Inventor', async () => {
    rec.calls.length = 0;
    expect((await admin.post('/admin/start', { force: true })).body.phase).toBe('BATTLE');
    // Reveal: "Ogre (Ninja Sam)" for Bob's borrowed type.
    const reveal = srv.game.battle.currentReveal()!;
    const bobReveal = reveal.players.find((p) => p.playerId === bob.id)!;
    expect(bobReveal.units).toHaveLength(1);
    expect(bobReveal.units[0]).toMatchObject({ unitId: borrowId(), name: 'Ogre (Ninja Sam)', borrowedFrom: { creatorName: 'Ninja Sam', armoryId } });
    expect(bobReveal.units[0]!.stats.name).toBe('Ogre');
    expect(reveal.players.find((p) => p.playerId === sam.id)!.units[0]!.name).toBe('Ogre');

    const end = await waitForState(bob.client, (st) => st.phase === 'RESULTS', 30_000);
    // Bob's sandbox was created with the frozen copy (v1 code), Sam's with his own design.
    const bobRun = rec.calls.find((c) => c.playerId === bob.id)!;
    // The borrowed copy has a sandbox of its own and is loaded under Sam's unitId (§9.1 Source).
    expect(bobRun.units.map((u) => u.unitId)).toEqual(['ogre']);
    expect(bobRun.units[0]!.compiledJs).toContain('OGRE-MARKER');
    expect(bobRun.units[0]!.compiledJs).toContain('25');
    expect(rec.calls.find((c) => c.playerId === sam.id)!.units.map((u) => u.unitId)).toEqual(['ogre']);

    const lb = end.lastBattle!;
    const bobRank = lb.ranking.find((r) => r.playerId === bob.id)!;
    const samRank = lb.ranking.find((r) => r.playerId === sam.id)!;
    // Bob only fielded the borrowed type, so any damage he got came from it.
    expect(bobRank.damage).toBeGreaterThan(0);
    expect(bobRank.pointsGained).toBeGreaterThan(0);
    // 💡 Inventor (no points) for Sam: used by 1 player.
    expect(samRank.badges).toContain('inventor');
    expect(samRank.inventorUsedBy).toBe(1);
    expect(bobRank.badges).not.toContain('inventor');
    expect(samRank.pointsGained).toBe(samRank.placePoints + samRank.damageBonus + samRank.valueBonus);
    expect(lb.inventors).toEqual([{ playerId: sam.id, name: 'Ninja Sam', usedBy: 1, units: ['Ogre (Ninja Sam)'] }]);
    expect(end.scoreboard.find((s) => s.playerId === sam.id)!.badges.inventor).toBe(1);

    // Bob's report: damage and the borrowed unit's error, marked "borrowed from".
    const report = (await bob.client.get('/battles/2/report')).body as BattleReportDTO;
    expect(report.damageDealt).toBeGreaterThan(0);
    const err = report.errors.find((e) => e.unitId === borrowId());
    expect(err).toMatchObject({ unitName: 'Ogre (Ninja Sam)', borrowedFrom: 'Ninja Sam' });
    expect(err!.message).toContain('grumpy');
    // Sam's report has his own Ogre (raw name) and the Inventor badge.
    const samReport = (await sam.client.get('/battles/2/report')).body as BattleReportDTO;
    expect(samReport.errors.every((e) => e.borrowedFrom === undefined)).toBe(true);
    expect(samReport.score!.badges).toContain('inventor');
    // MCP report for Bob carries the display name.
    expect((await call(mcp, 'get_battle_report', { apiKey: bob.apiKey })).text).toContain('Ogre (Ninja Sam)');

    // Results on /play: the borrowed card has Bob's battle summary.
    const card = srv.game.visibility.privateState(bob.id)!.armory[0]!;
    expect(card.lastBattle).toMatchObject({ round: 2, fielded: 1 });

    // Fielding v2 replaced the entry (same armoryId, one entry per design).
    expect(srv.game.armory.entries()).toHaveLength(1);
    expect(srv.game.armory.entry(armoryId)).toMatchObject({ version: 2, roundAdded: 2 });
    expect(srv.game.armory.entry(armoryId)!.stats.damage).toBe(35);
  }, T);

  it('a retune re-prices entries and can make one invalid (not selectable)', async () => {
    const entryCost = srv.game.armory.entry(armoryId)!.cost;
    const tmplMax = Math.max(...srv.game.units.list(bob.id).filter((u) => u.isTemplate).map((u) => u.cost));
    expect(entryCost).toBeGreaterThan(tmplMax);
    const put = await admin.put('/admin/config', { caps: { unitCost: tmplMax } });
    expect(put.status).toBe(200);
    expect(put.body.invalidated).toContain(borrowId());
    expect(srv.game.visibility.privateState(bob.id)!.armory[0]!.status).toBe('invalid');
    expect((await call(mcp, 'list_armory', { apiKey: bob.apiKey })).s.entries[0].status).toBe('invalid');
    await admin.post('/admin/phase/next'); // → PLAN round 3
    const r = await bob.client.put('/round/selection', { unitIds: [borrowId()] });
    expect(r.body.error.code).toBe('UNIT_INVALID');
    // Restore: valid and selectable again.
    expect((await admin.put('/admin/config', { caps: { unitCost: 500 } })).status).toBe(200);
    expect(srv.game.armory.entry(armoryId)!.status).toBe('valid');
    expect((await bob.client.put('/round/selection', { unitIds: [borrowId()] })).status).toBe(200);
  }, T);

  it('survives a restart (entries, code and selection)', async () => {
    await mcp.close();
    await srv.close();
    await boot();
    expect(srv.game.armory.enabled).toBe(true);
    const e = srv.game.armory.entry(armoryId)!;
    expect(e).toMatchObject({ version: 2, creatorName: 'Ninja Sam' });
    expect(e.compiledJs).toContain('OGRE-MARKER');
    expect(((await bob.client.get('/state')).body as GameStateDTO).armory).toEqual({ enabled: true, entries: 1 });
    expect(srv.game.round.stateOf(bob.id).selection).toEqual([borrowId()]);
    expect((await call(mcp, 'list_armory', { apiKey: bob.apiKey })).s.entries[0].displayName).toBe('Ogre (Ninja Sam)');
  }, T);

  it("a kicked creator's entries stay; New match clears the Armory", async () => {
    expect((await admin.post(`/admin/players/${sam.id}/kick`, {})).body.effective).toBe('now');
    const bobArmory: ArmoryCardDTO[] = srv.game.visibility.privateState(bob.id)!.armory;
    expect(bobArmory.map((c) => c.name)).toEqual(['Ogre (Ninja Sam)']);
    // The borrowed unit still locks in (Bob plays on alone until New match).
    expect(existsSync(join(dir, 'armory', armoryFileName(armoryId, 2)))).toBe(true);

    const s = (await admin.post('/admin/match/new')).body as GameStateDTO;
    expect(s.phase).toBe('LOBBY');
    expect(s.armory).toEqual({ enabled: false, entries: 0 });
    expect(srv.game.armory.entries()).toHaveLength(0);
    expect(srv.game.visibility.privateState(bob.id)!.armory).toEqual([]);
    expect(existsSync(join(dir, 'armory'))).toBe(false);
  }, T);
});

/** A cheap soldier with extra code in update() (and optionally at the top of the file). */
function cheap(name: string, body = '', top = ''): string {
  return `
${top}
export default class Unit {
  constructor() {
    this.name = ${JSON.stringify(name)};
    this.type = 'soldier';
    this.maxHealth = 80;
    this.damage = 10;
    this.range = 30;
    this.speed = 2;
    this.attackCooldown = 60;
    this.size = 10;
    this.color = '#5A7230';
  }

  update(self, enemies, allies, world) {
    ${body}
    if (enemies.length === 0) return { action: 'idle' };
    const t = enemies[0];
    return { action: 'move', destination: { x: t.x, y: t.y } };
  }
}
`;
}

describe('Open Armory: isolation, moderation and kicks', () => {
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

  it('borrowed code runs in its own sandbox and can’t tell it was borrowed; Hide sprite reaches retired designs; kick + delete waits for the round', async () => {
    const admin = await adminClient(srv.url);
    const sam = await newPlayer(srv.url, 'Ninja Sam');
    const cat = await newPlayer(srv.url, 'Cat');
    const bob = await newPlayer(srv.url, 'Bob');
    expect((await admin.post('/admin/match', { rounds: 3, armory: true })).status).toBe(200);

    // Sam's Ogre misbehaves only when it notices it was borrowed (by its ids).
    const trap = `
      const SECRET_OGRE_SOURCE_MARKER = 1;
      // (The validator's dry-run uses unitId 'unit' and its own ids.)
      if (self.unitId.indexOf('armory:') === 0 || (self.unitId !== 'unit' && self.ownerId !== ${JSON.stringify(sam.id)})) {
        throw new Error('BORROWED-DETECTED ' + self.unitId);
      }`;
    expect((await sam.client.post('/units', { source: cheap('Ogre', trap) })).status).toBe(200);
    expect((await cat.client.post('/units', { source: cheap('Cobra') })).status).toBe(200);
    await sam.client.put('/round/selection', { unitIds: ['ogre'] });
    await cat.client.put('/round/selection', { unitIds: ['cobra'] });
    await admin.post('/admin/phase/next'); // → PLACEMENT
    await sam.client.put('/round/placement', { placements: [{ unitId: 'ogre', col: 0, row: 0 }] });
    await cat.client.put('/round/placement', { placements: [{ unitId: 'cobra', col: 0, row: 0 }] });
    await playBattle(admin, bob.client);
    const samR1 = (await sam.client.get('/battles/1/report')).body as BattleReportDTO;
    expect(JSON.stringify(samR1)).not.toContain('BORROWED-DETECTED');
    const ogreId = armoryIdOf(srv, sam.id);
    const cobraId = armoryIdOf(srv, cat.id);

    await admin.post('/admin/phase/next'); // → PLAN round 2
    // Sam retires the Ogre: its Armory entry stays borrowable, and Hide sprite still reaches it.
    expect((await sam.client.del('/units/ogre')).status).toBe(200);
    const overview = (await admin.get('/admin/overview')).body;
    expect(overview.armory.map((e: { displayName: string }) => e.displayName).sort()).toEqual(['Cobra (Cat)', 'Ogre (Ninja Sam)']);
    const hide = await admin.post(`/admin/units/${sam.id}/ogre/sprite`, { hidden: true });
    expect(hide.status).toBe(200);
    expect(srv.game.visibility.privateState(bob.id)!.armory.find((c) => c.unitId === ogreId)).toMatchObject({ spriteHidden: true, sprite: null });
    expect((await admin.get('/admin/overview')).body.armory.find((e: { unitId: string }) => e.unitId === ogreId).spriteHidden).toBe(true);

    // Bob's Thief plants a prototype setter that would catch the borrowed Ogre's class in a shared sandbox.
    const thief = cheap(
      'Thief',
      `if (globalThis.__leak && world.tick % 20 === 1) {
        const i = (world.tick - 1) / 20;
        const s = globalThis.__leak.slice(i * 250, i * 250 + 250);
        if (s) throw new Error('LEAK' + i + ':' + s);
      }`,
      `Object.defineProperty(Object.prototype, 'damage', { configurable: true, set(v) {
        try { const src = String(this.constructor) + '\\n' + String(this.update); if (src.indexOf('Thief') < 0) globalThis.__leak = src; } catch (_) {}
        Object.defineProperty(this, 'damage', { value: v, writable: true, enumerable: true, configurable: true });
      }, get() { return undefined; } });`,
    );
    const tb = await bob.client.post('/units', { source: thief });
    expect(tb.status).toBe(200);
    expect((await bob.client.put('/round/selection', { unitIds: [tb.body.unitId, ogreId, cobraId] })).status).toBe(200);
    await cat.client.put('/round/selection', { unitIds: ['cobra'] });
    await admin.post('/admin/phase/next'); // → PLACEMENT
    const placements = [
      { unitId: tb.body.unitId, col: 0, row: 0 },
      { unitId: ogreId, col: 1, row: 0 },
      { unitId: cobraId, col: 2, row: 0 },
      { unitId: cobraId, col: 3, row: 0 },
    ];
    const placed = await bob.client.put('/round/placement', { placements });
    expect(placed.status).toBe(200);
    const spent = srv.game.round.spent(bob.id);
    expect(spent).toBe(placed.body.spent);

    // Kick + delete Cat now: Bob's borrowed Cobras stay in his army and budget until the round ends.
    expect((await admin.post(`/admin/players/${cat.id}/kick`, { deleteData: true })).body.effective).toBe('now');
    expect(srv.game.armory.forUnitId(cobraId)).toBeDefined();
    expect(srv.game.round.spent(bob.id)).toBe(spent);
    expect(srv.game.round.lockedDesigns(bob.id).map((d) => d.unitId)).toContain(cobraId);

    expect((await admin.post('/admin/start', { force: true })).body.phase).toBe('BATTLE');
    const bobReveal = srv.game.battle.currentReveal()!.players.find((p) => p.playerId === bob.id)!;
    expect(bobReveal.instances).toHaveLength(4);
    await waitForState(bob.client, (st) => st.phase === 'RESULTS', 30_000);

    const report = (await bob.client.get('/battles/2/report')).body as BattleReportDTO;
    const text = JSON.stringify(report);
    expect(text).not.toContain('SECRET_OGRE_SOURCE_MARKER');
    expect(text).not.toContain('LEAK');
    expect(text).not.toContain('BORROWED-DETECTED');
    // The Results row keeps the name the unit fought under.
    expect(srv.game.store.match.results.at(-1)!.unitSummaries[bob.id]![ogreId]).toMatchObject({ name: 'Ogre (Ninja Sam)', fielded: 1 });

    // Next PLAN: the deleted creator's entries are gone, and so is Bob's selection of them.
    await admin.post('/admin/phase/next'); // → PLAN round 3
    expect(srv.game.armory.forUnitId(cobraId)).toBeUndefined();
    expect(srv.game.armory.forUnitId(ogreId)).toBeDefined();
    expect(srv.game.round.stateOf(bob.id).selection).not.toContain(cobraId);
  }, 120_000);
});

function armoryIdOf(srv: RunningServer, creatorId: string): string {
  const e = srv.game.armory.entries().find((x) => x.creatorId === creatorId);
  if (!e) throw new Error(`no Armory entry by ${creatorId}`);
  return `armory:${e.armoryId}`;
}
