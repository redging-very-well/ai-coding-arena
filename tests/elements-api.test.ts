// M8.8 over the API (plan §10.6, §14): a real battle with a fire tank, a
// lightning splash soldier and a Field Medic, then the REST report, the
// public result, the replay header and MCP get_battle_report: the damage split
// per type, healing for Best Medic, scaleVersion 3 on everything new, and
// a past result without scaleVersion (the $1,000 game) still served.

import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BattleReportDTO, GameStateDTO, UnitCardDTO } from '@pixel-clash/shared';
import type { RunningServer } from '../packages/server/src/server.js';
import { adminClient, bootServer, fixture, newPlayer, removeDir, tempDataDir, waitForState } from './helpers/server.js';

const T = 90_000;

/** A Big Tank fixture with other stats (constructor lines replaced). */
function unit(name: string, stats: string): string {
  return fixture('good/big_tank.js')
    .replace("this.name = 'Big Tank';", `this.name = ${JSON.stringify(name)};`)
    .replace('this.maxHealth = 2500;\n    this.damage = 100;', stats);
}

// The $10,000 scale: HP ×1.6, damage ×0.8 of the M8.8 units.
const FIRE_TANK = unit('Fire Tank', "this.maxHealth = 2000;\n    this.damage = 80;\n    this.element = 'fire';");
const STORM = unit('Storm Bomber', "this.maxHealth = 1120;\n    this.damage = 48;\n    this.element = 'lightning';\n    this.splashRadius = 30;");

/** The CLAUDE.md §4d Field Medic: cleanse first, heal the most hurt, follow the toughest ally. */
const PATCH = `export default class Patch {
  constructor() {
    this.name = 'Patch'; this.type = 'soldier'; this.maxHealth = 800; this.damage = 0; this.range = 20;
    this.speed = 1.5; this.attackCooldown = 60; this.color = '#33CC66'; this.size = 10;
    this.support = 'heal'; this.supportPower = 96; this.supportRange = 120;
  }
  update(self, enemies, allies, world) {
    const gap = (a, b) => Math.hypot(b.x - a.x, b.y - a.y) - a.radius - b.radius;
    const need = allies.filter(a => a.id !== self.id && a.type !== 'wall' && a.type !== 'factory' && gap(self, a) <= self.support.range
      && (a.status.burning > 0 || a.status.frozen > 0 || (a.hp < a.maxHp && a.status.healRoom > 0)));
    need.sort((a, b) => (b.status.burning + b.status.frozen > 0) - (a.status.burning + a.status.frozen > 0) || a.hp / a.maxHp - b.hp / b.maxHp);
    if (need[0] && self.cooldownRemaining === 0) return { action: 'heal', targetId: need[0].id };
    let tank = null;
    for (const a of allies) {
      if (a.id === self.id || a.type === 'wall' || a.type === 'factory' || a.type === 'tower') continue;
      if (!tank || a.maxHp > tank.maxHp) tank = a;
    }
    if (tank) return gap(self, tank) > 30 ? { action: 'move', destination: { x: tank.x, y: tank.y } } : { action: 'idle' };
    return { action: 'move', destination: world.center };
  }
}
`;

async function call(client: McpClient, name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
  return { isError: r.isError === true, s: (r.structuredContent ?? {}) as Record<string, any>, text: (r.content[0] as { text: string }).text };
}

describe('elements and support over the API (M8.8)', () => {
  let srv: RunningServer;
  let dir: string;
  beforeAll(async () => {
    dir = tempDataDir();
    // A 30 s battle with heals until 25 s (heals stop at sudden death), played at 20x.
    srv = await bootServer({ dataDir: dir, config: { timers: { battleTicks: 1800 }, suddenDeath: { startTick: 1500, endTick: 1800 } } });
  }, T);
  afterAll(async () => {
    await srv.close();
    removeDir(dir);
  });

  it('reports the damage split, healing and Best Medic; new results carry scaleVersion 3', async () => {
    const admin = await adminClient(srv.url);
    const a = await newPlayer(srv.url, 'Alice');
    const b = await newPlayer(srv.url, 'Bob');
    expect((await admin.post('/admin/match', { rounds: 1 })).body.phase).toBe('PLAN');
    for (const source of [FIRE_TANK, STORM, PATCH]) {
      const r = await a.client.post('/units', { source });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    const cards = (await a.client.get('/units')).body as UnitCardDTO[];
    const card = (id: string) => cards.find((c) => c.unitId === id)!;
    // The plan's Half Tank ($1,386) × fire 1.3; the Field Medic ($892).
    expect(card('fire-tank')).toMatchObject({ cost: 1802, scaleVersion: 3, stats: { element: 'fire', splashRadius: 0, support: null } });
    expect(card('patch')).toMatchObject({ cost: 892, healUsed: true, stats: { damage: 0, support: { kind: 'heal', power: 96, range: 120 } } });
    expect(card('patch').breakdown.heal?.text).toMatch(/^Heal 96 HP up to 120 px away/);
    expect(card('storm-bomber').breakdown.splash?.text).toMatch(/^Splash ×1\.49/);
    // A medic alone is no army (§5.2 Fighters).
    await a.client.put('/round/selection', { unitIds: ['patch'] });
    expect((await a.client.post('/round/ready', { ready: true })).body.error.code).toBe('NO_FIGHTERS');
    await a.client.put('/round/selection', { unitIds: ['fire-tank', 'storm-bomber', 'patch'] });

    expect((await admin.post('/admin/phase/next')).body.phase).toBe('PLACEMENT');
    const placed = await a.client.put('/round/placement', {
      placements: [
        { unitId: 'fire-tank', col: 2, row: 0 },
        { unitId: 'fire-tank', col: 3, row: 0 },
        { unitId: 'storm-bomber', col: 4, row: 0 },
        { unitId: 'patch', col: 2, row: 1 },
      ],
    });
    expect(placed.status, JSON.stringify(placed.body)).toBe(200);
    expect(placed.body.spent).toBe(2 * 1802 + card('storm-bomber').cost + 892);
    expect((await admin.post('/admin/start', { force: true })).body.phase).toBe('BATTLE');
    const s = await waitForState(a.client, (x) => x.phase === 'RESULTS', 30_000);
    expect(s.lastBattle).toMatchObject({ round: 1, scaleVersion: 3 });

    const report = (await a.client.get('/battles/1/report')).body as BattleReportDTO;
    expect(report.scaleVersion).toBe(3);
    const type = (id: string) => report.types!.find((t) => t.unitId === id)!;
    // Every point of damage is in the split (rounded per kind).
    for (const t of report.types!.filter((x) => x.damageDealt > 0)) {
      const split = t.damageSplit!;
      expect(Math.abs(split.hit + split.splash + split.burn + split.zap + split.shatter - t.damageDealt), t.name).toBeLessThanOrEqual(5);
    }
    expect(type('fire-tank').damageSplit!.burn).toBeGreaterThan(0);
    expect(type('storm-bomber').damageSplit!.splash + type('storm-bomber').damageSplit!.zap).toBeGreaterThan(0);
    expect(type('patch')).toMatchObject({ damageDealt: 0 });
    expect(type('patch').healing).toBeGreaterThan(0);
    const alice = s.lastBattle!.ranking.find((r) => r.playerId === a.id)!;
    expect(alice.healing).toBe(type('patch').healing);
    expect(alice.badges).toContain('bestMedic');
    expect(s.lastBattle!.ranking.find((r) => r.playerId === b.id)!.badges).not.toContain('bestMedic');
    // The unit card's last battle shows the healing too.
    const patchCard = ((await a.client.get('/units')).body as UnitCardDTO[]).find((c) => c.unitId === 'patch')!;
    expect(patchCard.lastBattle?.healing).toBe(type('patch').healing);

    // Replay header and public results.
    expect((await a.client.get('/battles/1/replay')).body.scaleVersion).toBe(3);
    expect((await a.client.get('/battles/1/results')).body.scaleVersion).toBe(3);

    // MCP get_battle_report: the same report plus a healing line.
    const mcp = new McpClient({ name: 'pixel-clash-e2e', version: '1.0.0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${srv.url}/mcp`)));
    try {
      const r = await call(mcp, 'get_battle_report', { apiKey: a.apiKey });
      expect(r.isError).toBe(false);
      expect(r.s.scaleVersion).toBe(3);
      expect(r.s.types.find((t: { unitId: string }) => t.unitId === 'patch').healing).toBe(type('patch').healing);
      expect(r.text).toContain(`Healing: Patch healed ${type('patch').healing} HP`);
      expect(r.text).toContain('Best Medic');
    } finally {
      await mcp.close();
    }

    // A result from the $1,000 game (stored before M8.8) has no scaleVersion and is still served.
    const rec = srv.game.store.match.results.find((x) => x.round === 1)!;
    delete rec.end.scaleVersion;
    delete rec.reports[a.id]!.scaleVersion;
    expect((await a.client.get('/battles/1/results')).body).not.toHaveProperty('scaleVersion');
    expect((await a.client.get('/battles/1/report')).body).toMatchObject({ round: 1 });
    expect((await a.client.get('/battles/1/report')).body).not.toHaveProperty('scaleVersion');
    void (s as GameStateDTO);
  }, T);
});
