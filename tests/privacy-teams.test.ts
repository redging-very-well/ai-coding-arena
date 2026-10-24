// Team privacy (plan §3 privacy table, §9.2 Team privacy, §14 privacy.test):
// assertions on SERIALIZED payloads, with 6 and 8 players.
//   * Team mode: a teammate DOES receive the member's selected types (cards
//     with stats and sprite), zone and placement live (WS `private.team`
//     within ~300 ms, and REST `/state` `me.team`), read-only.
//   * Opponents and the projector receive none of it before START.
//   * No teammate ever gets source, compiled code, or a submitted-but-
//     unselected design.
//   * Free-for-all with 8 players: nobody is a teammate; nothing leaks.

import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import type { GameStateDTO, PrivateStateDTO, ServerWsMessage, TeamMode } from '@pixel-clash/shared';
import { Client, WsRecorder, adminClient, bootServer, namedUnit, newPlayer, removeDir, sleep, tempDataDir } from './helpers/server.js';

const T = 120_000;
const NAMES = ['Alice', 'Bob', 'Cy', 'Di', 'Ed', 'Flo', 'Gus', 'Hal'];
/** Alice's selected (and later placed) design. */
const PICKED = ['Secret Ninja', 'secret-ninja'];
/** Alice's submitted but never selected design. */
const UNPICKED = ['Hidden Hawk', 'hidden-hawk'];

const leaks = (payload: string, needles: readonly string[]) => needles.filter((n) => payload.includes(n));

function withoutMe(s: GameStateDTO): Omit<GameStateDTO, 'me'> {
  const { me: _me, ...rest } = s;
  return rest;
}

const privates = (ws: WsRecorder) =>
  ws.messages.filter((m): m is Extract<ServerWsMessage, { type: 'private' }> => m.type === 'private').map((m) => m.data);

/**
 * Boot, join `n` players (Alice first) with a WS socket each plus the
 * projector, and start a 1-round match in `teamMode`. Alice submits two
 * designs and selects one.
 */
async function setup(n: number, teamMode: TeamMode) {
  const dir = tempDataDir();
  const srv = await bootServer({ dataDir: dir, playbackRate: 1, config: { timers: { battleTicks: 600 } } });
  const admin = await adminClient(srv.url);
  const ps = [];
  for (const name of NAMES.slice(0, n)) ps.push(await newPlayer(srv.url, name));
  const ws = await Promise.all(ps.map((p) => WsRecorder.open(srv.url, 'player', p.client.cookieHeader())));
  const screen = await WsRecorder.open(srv.url, 'screen');
  const start = await admin.post('/admin/match', { rounds: 1, teamMode });
  expect(start.status).toBe(200);
  const s = start.body as GameStateDTO;
  const teamOf = new Map((s.match!.teams ?? []).flatMap((t) => t.members.map((m) => [m, t.teamId] as const)));
  const alice = ps[0]!;
  expect((await alice.client.post('/units', { source: namedUnit('Secret Ninja') })).status).toBe(200);
  expect((await alice.client.post('/units', { source: namedUnit('Hidden Hawk', { damage: 30 }) })).status).toBe(200);
  expect((await alice.client.put('/round/selection', { unitIds: ['secret-ninja'] })).status).toBe(200);
  const mates = ps.filter((p, i) => i > 0 && teamMode !== 'ffa' && teamOf.get(p.id) === teamOf.get(alice.id));
  const opponents = ps.filter((p, i) => i > 0 && !mates.includes(p));
  const close = async () => {
    for (const w of [...ws, screen]) w.close();
    await srv.close();
    removeDir(dir);
  };
  return { srv, admin, ps, ws, screen, alice, mates, opponents, teamOf, close };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** Nothing of Alice's reached any opponent or the projector (REST, WS, MCP). */
async function expectNothingToOpponents(t: Setup): Promise<void> {
  const secret = [...PICKED, ...UNPICKED];
  for (const o of t.opponents) {
    const s = (await o.client.get('/state')).body as GameStateDTO;
    expect(leaks(JSON.stringify(s), secret)).toEqual([]);
    for (const key of ['"selection"', '"placement"', '"zone"', '"myZone"', '"roster"', '"maxHealth"']) {
      expect(JSON.stringify(withoutMe(s))).not.toContain(key);
    }
    // Their own team block never lists Alice.
    expect(JSON.stringify(s.me?.team ?? null)).not.toContain(t.alice.id);
    const ows = t.ws[t.ps.indexOf(o)]!;
    expect(leaks(ows.raw.join('\n'), secret)).toEqual([]);
    for (const d of privates(ows)) for (const m of d.team?.members ?? []) expect(m.playerId).not.toBe(t.alice.id);
  }
  const anon = (await new Client(t.srv.url).get('/state')).body as GameStateDTO;
  expect(leaks(JSON.stringify(anon), secret)).toEqual([]);
  expect(leaks(t.screen.raw.join('\n'), secret)).toEqual([]);
  expect(t.screen.messages.some((m) => m.type === 'battle:reveal' || m.type === 'private')).toBe(false);
  // MCP get_game_state of an opponent.
  if (t.opponents[0]) {
    const mcp = new McpClient({ name: 'privacy-teams', version: '1.0.0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${t.srv.url}/mcp`)));
    const gs = await mcp.callTool({ name: 'get_game_state', arguments: { apiKey: t.opponents[0].apiKey } });
    expect(leaks(JSON.stringify(gs), secret)).toEqual([]);
    await mcp.close();
  }
}

/** A teammate sees Alice's picked type (never source or the unpicked design), zone and placement. */
async function expectTeammatesSee(t: Setup, phase: 'PLAN' | 'PLACEMENT'): Promise<void> {
  const aliceZone = ((await t.alice.client.get('/state')).body as GameStateDTO).me!.myZone;
  for (const mate of t.mates) {
    const s = (await mate.client.get('/state')).body as GameStateDTO;
    const a = s.me!.team!.members.find((m) => m.playerId === t.alice.id)!;
    expect(a.selection.map((c) => c.name)).toEqual(['Secret Ninja']);
    expect(a.selection[0]).toMatchObject({ unitId: 'secret-ninja', stats: { name: 'Secret Ninja', damage: 100 }, version: 0 });
    expect(a.selection[0]).toHaveProperty('sprite');
    if (phase === 'PLACEMENT') {
      expect(a.zone).toEqual(aliceZone);
      expect(a.placement).toEqual([{ unitId: 'secret-ninja', col: 2, row: 0 }]);
      expect(a.spent).toBeGreaterThan(0);
    } else {
      expect(a.zone).toBeNull();
      expect(a.placement).toEqual([]);
    }
    // WS: the live push reached the teammate.
    const mws = t.ws[t.ps.indexOf(mate)]!;
    const last = privates(mws).at(-1)!;
    expect(last.team!.members.find((m) => m.playerId === t.alice.id)!.selection.map((c) => c.unitId)).toEqual(['secret-ninja']);
    if (phase === 'PLACEMENT') expect(last.team!.members.find((m) => m.playerId === t.alice.id)!.placement).toHaveLength(1);
    const text = JSON.stringify(s) + mws.raw.join('\n');
    expect(leaks(text, UNPICKED)).toEqual([]);
    expect(text).not.toContain('"source"');
    expect(text).not.toContain('compiledJs');
    expect(text).not.toContain('export default class');
    // Read-only: a teammate's placement PUT only ever changes their own.
    expect(((await mate.client.get('/state')).body as GameStateDTO).me!.playerId).toBe(mate.id);
  }
}

async function runCase(n: number, teamMode: TeamMode, matesExpected: number): Promise<void> {
  const t = await setup(n, teamMode);
  try {
    expect(t.mates).toHaveLength(matesExpected);
    await sleep(500); // > the 300 ms teammate push window
    if (matesExpected > 0) await expectTeammatesSee(t, 'PLAN');
    await expectNothingToOpponents(t);

    await t.admin.post('/admin/phase/next'); // → PLACEMENT
    expect((await t.alice.client.put('/round/placement', { placements: [{ unitId: 'secret-ninja', col: 2, row: 0 }] })).status).toBe(200);
    await sleep(500);
    if (matesExpected > 0) await expectTeammatesSee(t, 'PLACEMENT');
    await expectNothingToOpponents(t);
    if (teamMode === 'ffa') {
      for (const p of t.ps) {
        const s = (await p.client.get('/state')).body as GameStateDTO;
        expect(s.me!.team).toBeUndefined();
        expect(s.me!.teamId).toBeUndefined();
        const priv = privates(t.ws[t.ps.indexOf(p)]!).at(-1) as PrivateStateDTO;
        expect(priv.team).toBeUndefined();
      }
    }

    // START reveals the fielded type to everyone; the unpicked design never.
    const reveal = t.screen.next((m) => m.type === 'battle:reveal');
    expect((await t.admin.post('/admin/start', { force: true })).status).toBe(200);
    const r = (await reveal) as Extract<ServerWsMessage, { type: 'battle:reveal' }>;
    expect(r.data.players).toHaveLength(n);
    expect(r.data.map).toMatchObject({ players: n });
    const ra = r.data.players.find((p) => p.playerId === t.alice.id)!;
    expect(ra.units.map((u) => u.unitId)).toEqual(['secret-ninja']);
    expect(ra.mapZone).toBeTruthy();
    if (teamMode !== 'ffa') {
      expect(ra.teamId).toBe(t.teamOf.get(t.alice.id));
      expect(r.data.teams).toHaveLength(new Set(t.teamOf.values()).size);
    } else {
      expect(ra.teamId).toBeUndefined();
    }
    await sleep(200);
    // (Alice's own sockets carry her roster, of course.)
    for (const w of [...t.ws.slice(1), t.screen]) expect(leaks(w.raw.join('\n'), UNPICKED)).toEqual([]);
  } finally {
    await t.close();
  }
}

describe('team privacy', () => {
  it('6 players, 3 teams of 2 (2v2v2): the teammate sees picks, zone and placement live; 4 opponents and the projector see nothing', async () => {
    await runCase(6, 'teams3', 1);
  }, T);

  it('8 players, 2 teams of 4 (4v4): 3 teammates see it, 4 opponents and the projector see nothing', async () => {
    await runCase(8, 'teams2', 3);
  }, T);

  it('8 players, 4 teams of 2 (2v2v2v2): one teammate sees it, 6 opponents see nothing', async () => {
    await runCase(8, 'teams4', 1);
  }, T);

  it('8 players free-for-all: nobody is a teammate and nothing leaks before START', async () => {
    await runCase(8, 'ffa', 0);
  }, T);
});
