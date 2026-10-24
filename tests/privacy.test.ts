// Privacy (plan §3, §14): assertions on SERIALIZED payloads.
//   * Before START, no REST response or WS message to another player or the
//     projector contains a player's unit names, stats, selection, placement or
//     zone.
//   * After START the reveal carries only the FIELDED types (a submitted but
//     unplaced design never leaks), sprites included only for fielded types.
//   * During BATTLE, no /state, WS or MCP payload carries the ranking, the
//     round's points or a report before playback reaches the final frame.
//   * Open Armory (§9.1, on in this match): no entry exists or is visible
//     before its battle is released; afterwards only FIELDED types appear,
//     never an unfielded design or any source.

import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BattleRevealDTO, GameStateDTO, ServerWsMessage } from '@pixel-clash/shared';
import type { RunningServer } from '../packages/server/src/server.js';
import { Client, WsRecorder, adminClient, bootServer, namedUnit, newPlayer, removeDir, sleep, tempDataDir } from './helpers/server.js';

const T = 60_000;

/** Strings that identify Alice's secret army. */
const SECRET = ['Secret Ninja', 'secret-ninja', 'Hidden Hawk', 'hidden-hawk', 'Storm Shield', 'storm-shield'];

/**
 * M8.8 (§10.6): a lightning splash soldier with a shield aura. Its element,
 * splash and support are part of the design: hidden until START like every stat.
 * (Bob's own templates are 'normal' with no support, so these JSON values are Alice's.)
 */
const STORM_SHIELD = namedUnit('Storm Shield', { damage: 50 })
  .replace('this.maxHealth = 2500;', "this.maxHealth = 600; this.element = 'lightning'; this.splashRadius = 37; this.support = 'shield'; this.supportPower = 33; this.supportRange = 80;");
const M88_SECRET = ['"lightning"', '"shield"', '"splashRadius":37', '"power":33'];

function leaks(payload: string, needles: readonly string[]): string[] {
  return needles.filter((n) => payload.includes(n));
}

/** A state payload without the owner-only `me` block. */
function withoutMe(s: GameStateDTO): Omit<GameStateDTO, 'me'> {
  const { me: _me, ...rest } = s;
  return rest;
}

describe('privacy', () => {
  let srv: RunningServer;
  let dir: string;
  let admin: Client;
  let alice: Awaited<ReturnType<typeof newPlayer>>;
  let bob: Awaited<ReturnType<typeof newPlayer>>;
  let wsBob: WsRecorder;
  let wsScreen: WsRecorder;
  let wsAlice: WsRecorder;

  beforeAll(async () => {
    dir = tempDataDir();
    // Real-time playback (rate 1) and a 20 s battle, so we can look at the
    // battle while the sim's result is held.
    srv = await bootServer({
      dataDir: dir,
      playbackRate: 1,
      config: { timers: { battleTicks: 1200 }, suddenDeath: { startTick: 900, endTick: 1200 } },
    });
    admin = await adminClient(srv.url);
    alice = await newPlayer(srv.url, 'Alice');
    bob = await newPlayer(srv.url, 'Bob');
    wsBob = await WsRecorder.open(srv.url, 'player', bob.client.cookieHeader());
    wsScreen = await WsRecorder.open(srv.url, 'screen');
    wsAlice = await WsRecorder.open(srv.url, 'player', alice.client.cookieHeader());
  }, T);

  afterAll(async () => {
    wsBob?.close();
    wsScreen?.close();
    wsAlice?.close();
    await srv.close();
    removeDir(dir);
  });

  it('nothing about Alice reaches Bob or the projector before START', async () => {
    await admin.post('/admin/match', { rounds: 1, armory: true });
    expect((await alice.client.post('/units', { source: namedUnit('Secret Ninja') })).status).toBe(200);
    expect((await alice.client.post('/units', { source: namedUnit('Hidden Hawk', { damage: 30 }) })).status).toBe(200);
    const storm = await alice.client.post('/units', { source: STORM_SHIELD });
    expect(storm.status, JSON.stringify(storm.body)).toBe(200);
    expect(storm.body.unit.stats).toMatchObject({ element: 'lightning', splashRadius: 37, support: { kind: 'shield', power: 33, range: 80 } });
    await alice.client.put('/round/selection', { unitIds: ['secret-ninja', 'hidden-hawk', 'storm-shield'] });
    await admin.post('/admin/phase/next'); // → PLACEMENT (zones assigned)
    const aliceState = (await alice.client.get('/state')).body as GameStateDTO;
    const aliceZone = aliceState.me!.myZone!;
    expect(aliceZone).toBeTruthy();
    // Alice places only the Secret Ninja (Hidden Hawk stays unfielded).
    await alice.client.put('/round/placement', {
      placements: [
        { unitId: 'secret-ninja', col: 2, row: 3 },
        { unitId: 'storm-shield', col: 3, row: 3 },
      ],
    });
    await alice.client.post('/round/ready', { ready: true });
    await sleep(100);

    // Alice herself got her private data.
    expect(wsAlice.raw.some((t) => t.includes('Secret Ninja'))).toBe(true);

    // REST: Bob's and the anonymous view.
    const bobState = (await bob.client.get('/state')).body as GameStateDTO;
    const anonState = (await new Client(srv.url).get('/state')).body as GameStateDTO;
    for (const s of [bobState, anonState]) {
      const text = JSON.stringify(withoutMe(s));
      expect(leaks(text, SECRET)).toEqual([]);
      expect(leaks(JSON.stringify(s), M88_SECRET)).toEqual([]);
      for (const key of ['"selection"', '"placement"', '"zone"', '"myZone"', '"roster"', '"maxHealth"']) {
        expect(text).not.toContain(key);
      }
    }
    expect(bobState.me?.myZone).not.toBe(aliceZone);
    expect(JSON.stringify(bobState.me)).not.toContain('secret');
    // Bob can't read Alice's units, even by id.
    expect((await bob.client.get('/units/secret-ninja')).status).toBe(404);
    expect(leaks(JSON.stringify((await bob.client.get('/units')).body), SECRET)).toEqual([]);
    expect(leaks(JSON.stringify((await bob.client.get('/units')).body), M88_SECRET)).toEqual([]);
    // The replay endpoint has nothing for the running round.
    expect((await bob.client.get('/battles/1/replay')).status).toBe(404);

    // WS: every message so far to Bob and the projector.
    for (const ws of [wsBob, wsScreen]) {
      expect(leaks(ws.raw.join('\n'), SECRET)).toEqual([]);
      expect(leaks(ws.raw.join('\n'), M88_SECRET)).toEqual([]);
      expect(ws.messages.some((m) => m.type === 'battle:reveal')).toBe(false);
      for (const m of ws.messages) {
        if (m.type === 'private') expect(m.data.player.id).toBe(bob.id);
        if (m.type === 'state') {
          expect(JSON.stringify(withoutMe(m.state))).not.toContain('"myZone"');
          if (m.state.me) expect(m.state.me.playerId).toBe(bob.id);
        }
      }
    }
    // Open Armory: nothing exists yet.
    expect(bobState.armory).toEqual({ enabled: true, entries: 0 });
    expect(srv.game.armory.entries()).toHaveLength(0);
    // Status ticks are public.
    expect(bobState.players.find((p) => p.id === alice.id)).toMatchObject({ submitted: true, selected: true, ready: true });
  }, T);

  it('the reveal at START carries only fielded types (with sprites) and no ranking', async () => {
    const reveal = wsScreen.next((m) => m.type === 'battle:reveal');
    const s = (await admin.post('/admin/start', { force: true })).body as GameStateDTO;
    expect(s.phase).toBe('BATTLE');
    const r = ((await reveal) as { data: BattleRevealDTO }).data;
    const a = r.players.find((p) => p.playerId === alice.id)!;
    expect(a.units.map((u) => u.unitId).sort()).toEqual(['secret-ninja', 'storm-shield']);
    // M8.8: from START the reveal carries the fielded design's element, splash and support.
    expect(a.units.find((u) => u.unitId === 'storm-shield')!.stats).toMatchObject({ element: 'lightning', splashRadius: 37, support: { kind: 'shield', power: 33, range: 80 } });
    const ninja = a.units.find((u) => u.unitId === 'secret-ninja')!;
    expect(ninja).toHaveProperty('sprite');
    expect(ninja).toMatchObject({ spriteHidden: false, stats: { name: 'Secret Ninja' } });
    expect(a.instances).toHaveLength(2);
    // Bob (auto-placed templates) is revealed too.
    expect(r.players.find((p) => p.playerId === bob.id)!.instances.length).toBeGreaterThan(0);
    // The unfielded design never leaks, not even after the reveal.
    for (const ws of [wsBob, wsScreen]) expect(leaks(ws.raw.join('\n'), ['Hidden Hawk', 'hidden-hawk'])).toEqual([]);
  }, T);

  it('during playback, no payload carries the ranking, points or a report', async () => {
    // Let the sim finish far ahead of the (real-time) playback.
    await sleep(1500);
    const holds = (s: GameStateDTO) => {
      expect(s.phase).toBe('BATTLE');
      expect(s.lastBattle).toBeUndefined();
      expect(s.scoreboard.every((e) => e.points === 0 && e.damage === 0)).toBe(true);
      expect(s.scoreboard.every((e) => Object.values(e.badges).every((n) => n === 0))).toBe(true);
      expect(s.battle!.tick).toBeLessThan(1200);
    };
    holds((await bob.client.get('/state')).body as GameStateDTO);
    holds((await new Client(srv.url).get('/state')).body as GameStateDTO);
    const rep = await alice.client.get('/battles/1/report');
    expect(rep.status).toBe(409);
    expect(rep.body.error.code).toBe('PHASE_CLOSED');
    expect((await alice.client.get('/battles/latest/report')).status).toBe(409);
    expect((await bob.client.get('/battles/1/replay')).status).toBe(409);

    // MCP: get_game_state and get_battle_report are held too.
    const mcp = new McpClient({ name: 'privacy-test', version: '1.0.0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${srv.url}/mcp`)));
    const gs = await mcp.callTool({ name: 'get_game_state', arguments: { apiKey: alice.apiKey } });
    const gsText = JSON.stringify(gs);
    expect(gs.structuredContent).toMatchObject({ phase: 'BATTLE' });
    expect(gsText).not.toContain('ranking');
    expect((gs.structuredContent as { scoreboard: Array<{ points: number }> }).scoreboard.every((e) => e.points === 0)).toBe(true);
    // Open Armory: the fielded types are revealed, but no entry exists before the release.
    const armory = await mcp.callTool({ name: 'list_armory', arguments: { apiKey: bob.apiKey } });
    expect(armory.structuredContent).toMatchObject({ enabled: true, entries: [] });
    expect(srv.game.armory.entries()).toHaveLength(0);
    expect(srv.game.visibility.privateState(bob.id)!.armory).toEqual([]);
    const br = await mcp.callTool({ name: 'get_battle_report', arguments: { apiKey: alice.apiKey } });
    expect(br.isError).toBe(true);
    expect(JSON.stringify(br.structuredContent)).toContain('PHASE_CLOSED');
    await mcp.close();

    // WS: frames are flowing, but no battle:end / ranking yet.
    for (const ws of [wsBob, wsScreen, wsAlice]) {
      expect(ws.messages.some((m) => m.type === 'battle:frames')).toBe(true);
      expect(ws.messages.some((m) => m.type === 'battle:end')).toBe(false);
      expect(ws.raw.join('\n')).not.toContain('"ranking"');
      expect(ws.raw.join('\n')).not.toContain('"pointsGained"');
      expect(ws.raw.join('\n')).not.toContain('"damageBonus"');
    }
  }, T);

  it('Skip releases the result to everyone at once', async () => {
    const end = wsBob.next((m) => m.type === 'battle:end');
    const s = (await admin.post('/admin/phase/skip')).body as GameStateDTO;
    expect(s.phase).toBe('RESULTS');
    const msg = (await end) as Extract<ServerWsMessage, { type: 'battle:end' }>;
    expect(msg.data.ranking).toHaveLength(2);
    expect(msg.data.reason).toBe('skipped');
    expect(msg.data.scoreboard.reduce((sum, e) => sum + e.points, 0)).toBeGreaterThan(0);
    for (const r of msg.data.ranking) expect(r.pointsGained).toBe(r.placePoints + r.damageBonus + r.valueBonus);
    const aliceReport = await alice.client.get('/battles/1/report');
    expect(aliceReport.status).toBe(200);
    expect(aliceReport.body.score).toMatchObject({ playerId: alice.id });
    // Bob only ever gets his own report.
    const bobReport = (await bob.client.get('/battles/1/report')).body;
    expect(leaks(JSON.stringify(bobReport), SECRET)).toEqual([]);
    // Open Armory after the release: the fielded Secret Ninja and Storm Shield are borrowable by
    // Bob (named after Alice); the unfielded Hidden Hawk and all code stay private.
    const bobArmory = srv.game.visibility.privateState(bob.id)!.armory;
    expect(bobArmory.map((u) => u.name).sort()).toEqual(['Secret Ninja (Alice)', 'Storm Shield (Alice)']);
    const armoryText = JSON.stringify(bobArmory) + JSON.stringify((await bob.client.get('/state')).body);
    expect(leaks(armoryText, ['Hidden Hawk', 'hidden-hawk'])).toEqual([]);
    expect(armoryText).not.toContain('"source"');
    expect(armoryText).not.toContain('compiledJs');
    for (const ws of [wsBob, wsScreen]) expect(leaks(ws.raw.join('\n'), ['Hidden Hawk', 'hidden-hawk'])).toEqual([]);
  }, T);
});
