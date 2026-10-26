// wait_for_phase ("agents check the phase after making a unit"): the long poll resolves on a phase change, times out at the cap,
// cleans up on abort and per player; validate_unit / submit_unit end with a
// "Game phase:" line; the kit tells the helper to wait by itself.

import { readFileSync } from 'node:fs';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Phase } from '@pixel-clash/shared';
import { Game, type Notifier } from '../packages/server/src/services/game.js';
import {
  MAX_WAITS_PER_PLAYER,
  PhaseWaitService,
  WAIT_FOR_PHASE_MAX_SEC,
  phaseLine,
} from '../packages/server/src/services/phaseWait.js';
import { MCP_INSTRUCTIONS } from '../packages/server/src/mcp.js';
import type { RunningServer } from '../packages/server/src/server.js';
import { adminClient, bootServer, fixture, newPlayer, removeDir, sleep, tempDataDir } from './helpers/server.js';

const T = 60_000;

/** Just what PhaseWaitService reads from the game. */
function fakeGame(phase: Phase = 'LOBBY') {
  const listeners = new Set<() => void>();
  const match = { phase, round: 0, rounds: 3 };
  const game = {
    store: { match },
    match: { timerDTO: () => ({ secondsLeft: null }), submissionsOpen: () => match.phase === 'PLAN' },
    onStateChanged(fn: () => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const set = (p: Phase, round = match.round) => {
    match.phase = p;
    match.round = round;
    for (const fn of [...listeners]) fn();
  };
  return { game: game as unknown as Game, listeners, set, match };
}

describe('PhaseWaitService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves at once when the game is already in the phase', async () => {
    const { game, listeners } = fakeGame('PLAN');
    const out = await new PhaseWaitService(game).wait('p1', 'PLAN', 10_000);
    expect(out.reason).toBe('reached');
    expect(out.state).toMatchObject({ phase: 'PLAN', submissionsOpen: true });
    expect(listeners.size).toBe(0);
  });

  it('resolves as soon as the phase becomes the requested one, and removes its listener', async () => {
    const { game, listeners, set } = fakeGame('LOBBY');
    const svc = new PhaseWaitService(game);
    const pending = svc.wait('p1', 'PLAN', 10_000);
    expect(listeners.size).toBe(1);
    set('LOBBY'); // a state change that is not a phase change keeps waiting
    expect(svc.count('p1')).toBe(1);
    set('PLAN', 1);
    const out = await pending;
    expect(out).toMatchObject({ reason: 'reached', state: { phase: 'PLAN', round: 1, submissionsOpen: true } });
    expect(listeners.size).toBe(0);
    expect(svc.count()).toBe(0);
  });

  it('resolves on any phase change (BATTLE → RESULTS while waiting for PLAN)', async () => {
    const { game, set } = fakeGame('BATTLE');
    const pending = new PhaseWaitService(game).wait('p1', 'PLAN', 10_000);
    set('RESULTS');
    expect(await pending).toMatchObject({ reason: 'changed', state: { phase: 'RESULTS', submissionsOpen: false } });
  });

  it(`times out at the cap (${WAIT_FOR_PHASE_MAX_SEC} s), even when asked for longer`, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { game, listeners } = fakeGame('RESULTS');
    const svc = new PhaseWaitService(game);
    let done: string | null = null;
    void svc.wait('p1', 'PLAN', 10 * 60_000).then((o) => (done = o.reason));
    await vi.advanceTimersByTimeAsync(WAIT_FOR_PHASE_MAX_SEC * 1000 - 10);
    expect(done).toBeNull();
    await vi.advanceTimersByTimeAsync(20);
    expect(done).toBe('timeout');
    expect(listeners.size).toBe(0);
    expect(svc.count()).toBe(0);
  });

  it('cleans up on abort (client disconnect or cancelled call)', async () => {
    const { game, listeners } = fakeGame('LOBBY');
    const svc = new PhaseWaitService(game);
    const ac = new AbortController();
    const pending = svc.wait('p1', 'PLAN', 10_000, ac.signal);
    expect(svc.count('p1')).toBe(1);
    ac.abort();
    expect((await pending).reason).toBe('aborted');
    expect(listeners.size).toBe(0);
    expect(svc.count()).toBe(0);
    // Already aborted: answers at once, registers nothing.
    expect((await svc.wait('p1', 'PLAN', 10_000, ac.signal)).reason).toBe('aborted');
    expect(listeners.size).toBe(0);
  });

  it(`caps open waits per player at ${MAX_WAITS_PER_PLAYER}: a further one ends the oldest`, async () => {
    const { game, listeners, set } = fakeGame('LOBBY');
    const svc = new PhaseWaitService(game);
    const first = svc.wait('p1', 'PLAN', 10_000);
    const rest = Array.from({ length: MAX_WAITS_PER_PLAYER }, () => svc.wait('p1', 'PLAN', 10_000));
    const other = svc.wait('p2', 'PLAN', 10_000);
    expect((await first).reason).toBe('replaced');
    expect(svc.count('p1')).toBe(MAX_WAITS_PER_PLAYER);
    expect(svc.count('p2')).toBe(1);
    expect(listeners.size).toBe(MAX_WAITS_PER_PLAYER + 1);
    set('PLAN', 1);
    for (const r of await Promise.all([...rest, other])) expect(r.reason).toBe('reached');
    expect(listeners.size).toBe(0);
  });
});

describe('Game.onStateChanged', () => {
  it('runs after every notifier.stateChanged(), the other notifier members are untouched', () => {
    const dir = tempDataDir();
    try {
      const game = new Game({ dataDir: dir });
      const calls: string[] = [];
      const off = game.onStateChanged(() => calls.push('listener'));
      game.notifier.stateChanged(); // the built-in no-op notifier is hooked too
      const fake = {
        stateChanged: () => calls.push('notifier'),
        privateChanged() {},
        toast() {},
        battleReveal() {},
        battleFrames() {},
        battleEnd() {},
        playerRevoked() {},
        isConnected: (id: string) => id === 'p1',
      } satisfies Notifier;
      game.setNotifier(fake);
      game.notifier.stateChanged();
      expect(calls).toEqual(['listener', 'notifier', 'listener']);
      expect(game.notifier.isConnected('p1')).toBe(true);
      expect(game.notifier.clientCount).toBeUndefined();
      off();
      game.notifier.stateChanged();
      expect(calls).toEqual(['listener', 'notifier', 'listener', 'notifier']);
    } finally {
      removeDir(dir);
    }
  });
});

describe('phaseLine (validate_unit / submit_unit results)', () => {
  it('says the phase, time left and whether submissions are open', () => {
    expect(phaseLine({ phase: 'PLAN', round: 2, rounds: 3, secondsLeft: 360, submissionsOpen: true })).toBe(
      'Game phase: PLAN (round 2 of 3), about 6 min left, submissions open.',
    );
    expect(phaseLine({ phase: 'PLAN', round: 1, rounds: 3, secondsLeft: 40, submissionsOpen: true })).toBe('Game phase: PLAN (round 1 of 3), 40 s left, submissions open.');
    expect(phaseLine({ phase: 'LOBBY', round: 0, rounds: 3, secondsLeft: null, submissionsOpen: false })).toBe(
      'Game phase: LOBBY, submissions closed. Submissions open in the next Plan phase; call wait_for_phase to be told.',
    );
  });
});

describe('wait_for_phase over MCP', () => {
  let srv: RunningServer;
  let dir: string;
  let mcp: McpClient;
  let apiKey: string;

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await mcp.callTool({ name, arguments: { apiKey, ...args } })) as CallToolResult;
    return { isError: r.isError === true, s: (r.structuredContent ?? {}) as Record<string, any>, text: (r.content[0] as { text: string }).text };
  };

  beforeAll(async () => {
    dir = tempDataDir();
    srv = await bootServer({ dataDir: dir });
    apiKey = (await newPlayer(srv.url, 'Wanda', '4821')).apiKey;
    await newPlayer(srv.url, 'Other');
    mcp = new McpClient({ name: 'wait-test', version: '1.0.0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${srv.url}/mcp`)));
  }, T);

  afterAll(async () => {
    await mcp?.close();
    await srv.close();
    removeDir(dir);
  });

  it('validate_unit and submit_unit end with the phase now; PHASE_CLOSED points to wait_for_phase', async () => {
    const v = await call('validate_unit', { source: fixture('good/sniper_tower.js') });
    expect(v.isError).toBe(false);
    expect(v.text.split('\n')[1]).toBe('Game phase: LOBBY, submissions closed. Submissions open in the next Plan phase; call wait_for_phase to be told.');
    const s = await call('submit_unit', { source: fixture('good/sniper_tower.js') });
    expect(s.isError).toBe(true);
    expect(s.s.errors[0]).toMatchObject({ code: 'PHASE_CLOSED' });
    expect(s.text).toContain('wait_for_phase');
    expect(s.text.split('\n')[1]).toMatch(/^Game phase: LOBBY, submissions closed\./);
  });

  it('a short wait times out with the current phase', async () => {
    const r = await call('wait_for_phase', { maxWaitSec: 1 });
    expect(r.isError).toBe(false);
    expect(r.s).toMatchObject({ ok: true, phase: 'LOBBY', submissionsOpen: false, reached: false, reason: 'timeout', waitedFor: 'PLAN' });
    expect(r.text).toContain('Call wait_for_phase again');
  });

  it('a waiting call returns as soon as the host starts the match (Plan phase)', async () => {
    const waiting = call('wait_for_phase');
    await sleep(100);
    expect(srv.game.phaseWait.count()).toBe(1);
    const admin = await adminClient(srv.url);
    const started = Date.now();
    expect((await admin.post('/admin/match', { rounds: 2 })).body.phase).toBe('PLAN');
    const r = await waiting;
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r.s).toMatchObject({ phase: 'PLAN', round: 1, submissionsOpen: true, reached: true, reason: 'reached' });
    expect(r.text).toMatch(/^Game phase: PLAN, .*submissions open\. Submit the unit now\./);
    expect(srv.game.phaseWait.count()).toBe(0);
    const sub = await call('submit_unit', { source: fixture('good/sniper_tower.js') });
    expect(sub.isError).toBe(false);
    expect(sub.text.split('\n')[1]).toMatch(/^Game phase: PLAN \(round 1 of 2\), .*submissions open\.$/);
  });

  it('a closed HTTP request ends its wait (no listener left behind)', async () => {
    const ac = new AbortController();
    const req = fetch(`${srv.url}/mcp`, {
      method: 'POST',
      signal: ac.signal,
      headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wait_for_phase', arguments: { phase: 'BATTLE', apiKey } } }),
    }).catch(() => null);
    for (let i = 0; i < 50 && srv.game.phaseWait.count() === 0; i++) await sleep(20);
    expect(srv.game.phaseWait.count()).toBe(1);
    ac.abort();
    await req;
    for (let i = 0; i < 50 && srv.game.phaseWait.count() > 0; i++) await sleep(20);
    expect(srv.game.phaseWait.count()).toBe(0);
  });
});

describe('the kit tells the helper to wait by itself', () => {
  const kit = (rel: string) => readFileSync(new URL(`../packages/starter-kit/${rel}`, import.meta.url), 'utf8');

  it('CLAUDE.md: submit after validating, wait_for_phase while closed, no "wait for the player"', () => {
    const md = kit('CLAUDE.md.tmpl');
    expect(md).toContain('never rely on a phase you read earlier');
    expect(md).toContain('"It\'s ready! I\'ll send it as soon as the Plan phase starts."');
    expect(md).toContain('call `wait_for_phase` again');
    expect(md).toContain('press Esc');
    expect(md).not.toMatch(/wait for the player|tell me and I'll send it|you won't be told/i);
    expect(md).not.toMatch(/\bkids?\b/i);
  });

  it('PROMPTS.md and the MCP instructions: no "tell it the Plan phase started"', () => {
    expect(kit('PROMPTS.md')).not.toContain('The Plan phase started!');
    expect(MCP_INSTRUCTIONS).toContain('wait_for_phase');
    expect(MCP_INSTRUCTIONS).toContain("I'll send it as soon as the Plan phase starts");
  });

  it('Codex: the pixel-clash tools are pre-approved and may run longer than one wait', () => {
    const toml = kit('.codex/config.toml.tmpl');
    expect(toml).toContain('default_tools_approval_mode = "approve"');
    const t = Number(/^tool_timeout_sec = (\d+)$/m.exec(toml)![1]);
    expect(t).toBeGreaterThan(WAIT_FOR_PHASE_MAX_SEC);
    // Claude Code: the server-wide rule covers wait_for_phase (and every other pixel-clash tool).
    expect(JSON.parse(kit('.claude/settings.json.tmpl').replaceAll('{{HOST}}', 'h')).permissions.allow).toContain('mcp__pixel-clash');
  });
});
