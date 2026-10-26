// The shared agent login (plan §11.2 f): the facilitator pastes one Claude Code
// token (`claude setup-token`), optionally an Anthropic API key, and an OpenAI
// key for Codex seats into /admin → AI seats. Write-only: the browser only ever
// gets "…last 4" back; the value reaches nothing but POST /api/seat-login
// (the AI session host, Basic auth with the seat password), and survives restarts
// and wipes like the seat password. The entrypoint side is in
// seat-first-prompt.test.ts.

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AdminClaudeSeatsDTO, LoginResponse } from '@pixel-clash/shared';
import { credentialForAgent, seatPlayerToken } from '../packages/server/src/services/claudeSeats.js';
import { normalizeAgentCredentials } from '../packages/server/src/services/store.js';
import type { RunningServer } from '../packages/server/src/server.js';
import { Client, WsRecorder, adminClient, bootServer, removeDir, sleep, tempDataDir } from './helpers/server.js';

const T = 60_000;
const SECRET = 'otter-lamp-quartz-ninety';
const TOKEN = 'sk-ant-oat01-' + 'Ab3_-'.repeat(20) + 'TK9q';
const AKEY = 'sk-ant-api03-' + 'Zy9-_'.repeat(20) + 'AK7w';
const OKEY = 'sk-proj-' + 'Qw7_-'.repeat(10) + 'OK5e';
/** Fragments that must never show up anywhere but the seat login (the last 4 characters are allowed). */
const FRAGMENTS = [TOKEN.slice(0, -4), AKEY.slice(0, -4), OKEY.slice(0, -4), 'Ab3_-Ab3_', 'Zy9-_Zy9-_', 'Qw7_-Qw7_-'];
const basic = (secret: string) => `Basic ${Buffer.from(`player:${secret}`).toString('base64')}`;

function expectNoSecret(text: string, where: string) {
  for (const f of FRAGMENTS) expect(text.includes(f), `${where} leaks ${f.slice(0, 16)}…`).toBe(false);
}

describe('credential rules (pure)', () => {
  it('Claude seats prefer the token, Codex seats get the OpenAI key; junk in the state file is dropped', () => {
    const all = { claudeToken: TOKEN, anthropicApiKey: AKEY, openaiApiKey: OKEY };
    expect(credentialForAgent(all, 'claude')).toEqual({ env: 'CLAUDE_CODE_OAUTH_TOKEN', value: TOKEN });
    expect(credentialForAgent({ ...all, claudeToken: null }, 'claude')).toEqual({ env: 'ANTHROPIC_API_KEY', value: AKEY });
    expect(credentialForAgent(all, 'codex')).toEqual({ env: 'OPENAI_API_KEY', value: OKEY });
    expect(credentialForAgent({ claudeToken: null, anthropicApiKey: null, openaiApiKey: OKEY }, 'claude')).toBeNull();
    expect(credentialForAgent({ ...all, openaiApiKey: null }, 'codex')).toBeNull();
    expect(normalizeAgentCredentials({ claudeToken: TOKEN, anthropicApiKey: 'nope', openaiApiKey: 'sk-ant-api03-' + 'x'.repeat(30) })).toEqual({
      claudeToken: TOKEN,
      anthropicApiKey: null,
      openaiApiKey: null,
    });
    expect(normalizeAgentCredentials(undefined)).toEqual({ claudeToken: null, anthropicApiKey: null, openaiApiKey: null });
  });
});

describe('shared agent login API (§11.2 f)', () => {
  let dir: string;
  let srv: RunningServer;
  let admin: Client;
  let sam: { client: Client; id: string; seat: number };

  beforeAll(async () => {
    dir = tempDataDir();
    srv = await bootServer({ dataDir: dir });
    admin = await adminClient(srv.url);
    expect((await admin.put('/admin/setup', { seatSecret: SECRET })).status).toBe(200);
    const c = new Client(srv.url);
    const r = await c.post<LoginResponse>('/players', { name: 'Sam', pin: '1234', claudeSeat: 'auto' });
    expect(r.status, r.text).toBe(200);
    sam = { client: c, id: r.body.player.id, seat: r.body.claudeSeat!.seat! };
  }, T);

  afterAll(async () => {
    await srv.close();
    removeDir(dir);
  });

  const seatLogin = (b: unknown, secret = SECRET) => new Client(srv.url).req('POST', '/api/seat-login', b, { authorization: basic(secret) });

  it('admin only; strict shapes with a helpful hint; whitespace from a wrapped paste is removed', async () => {
    expect((await sam.client.put('/admin/agent-credentials', { claudeToken: TOKEN })).status).toBe(403);
    expect((await new Client(srv.url).put('/admin/agent-credentials', { claudeToken: TOKEN })).status).toBe(403);

    for (const [field, bad] of [
      ['claudeToken', 'hello'],
      ['claudeToken', `${TOKEN};rm -rf /`],
      ['claudeToken', `${TOKEN}"`],
      ['anthropicApiKey', TOKEN],
      ['openaiApiKey', AKEY],
      ['openaiApiKey', 42],
    ] as const) {
      const r = await admin.put('/admin/agent-credentials', { [field]: bad });
      expect(r.status, `${field}=${String(bad)}`).toBe(400);
      expect(r.body.error.code).toBe('BAD_AGENT_CREDENTIAL');
      expect(r.body.error.details).toEqual({ field });
      expectNoSecret(r.text, 'error');
    }
    // A key in the wrong field says where it belongs.
    expect((await admin.put('/admin/agent-credentials', { claudeToken: AKEY })).body.error.hint).toMatch(/Anthropic API key/);
    expect((await admin.put('/admin/agent-credentials', { openaiApiKey: TOKEN })).body.error.hint).toMatch(/Claude Code token/);

    const wrapped = `  ${TOKEN.slice(0, 40)}\n${TOKEN.slice(40)}\n`;
    const r = await admin.put<AdminClaudeSeatsDTO>('/admin/agent-credentials', { claudeToken: wrapped, openaiApiKey: OKEY });
    expect(r.status, r.text).toBe(200);
    expect(r.body.agentCredentials).toEqual({ claudeToken: '…TK9q', anthropicApiKey: null, openaiApiKey: '…OK5e' });
    expectNoSecret(r.text, 'PUT answer');
    // A partial update leaves the other fields alone.
    const r2 = await admin.put<AdminClaudeSeatsDTO>('/admin/agent-credentials', { anthropicApiKey: AKEY });
    expect(r2.body.agentCredentials).toEqual({ claudeToken: '…TK9q', anthropicApiKey: '…AK7w', openaiApiKey: '…OK5e' });
  }, T);

  it('never in any browser payload: admin GET (details too), setup, state, overview, me, WS pushes, kit', async () => {
    const adminWs = await WsRecorder.open(srv.url, 'admin', admin.cookieHeader());
    const playerWs = await WsRecorder.open(srv.url, 'player', sam.client.cookieHeader());
    const screenWs = await WsRecorder.open(srv.url, 'screen');
    // Changes that push state and terminals.
    await admin.put('/admin/agent-credentials', { openaiApiKey: OKEY });
    await admin.put('/admin/setup', { claudeBoxHost: '10.0.0.5' });
    await seatLogin({ seat: sam.seat, agent: 'claude' });
    await sleep(300);

    const texts: Array<[string, string]> = [];
    for (const path of ['/admin/claude-seats', '/admin/claude-seats?details=1', '/admin/overview', '/admin/config', '/admin/metrics', '/admin/match/setup', '/setup', '/state', '/me', '/claude-seats']) {
      texts.push([`admin ${path}`, (await admin.get(path)).text]);
      texts.push([`player ${path}`, (await sam.client.get(path)).text]);
      texts.push([`anon ${path}`, (await new Client(srv.url).get(path)).text]);
    }
    texts.push(['PUT /admin/setup', (await admin.put('/admin/setup', { preferredUrl: null })).text]);
    texts.push(['POST /admin/claude-seats/check', (await admin.post('/admin/claude-seats/check')).text]);
    texts.push(['kit.zip', (await sam.client.get('/kit.zip')).text]);
    texts.push(['setup kit.zip', (await new Client(srv.url).get('/setup/kit.zip?agent=codex')).text]);
    texts.push(['admin WS', adminWs.raw.join('\n')]);
    texts.push(['player WS', playerWs.raw.join('\n')]);
    texts.push(['screen WS', screenWs.raw.join('\n')]);
    for (const [where, text] of texts) expectNoSecret(text, where);
    // The admin's hints are there, though.
    const details = (await admin.get<AdminClaudeSeatsDTO>('/admin/claude-seats?details=1')).body;
    expect(details.agentCredentials.claudeToken).toBe('…TK9q');
    expect(details.seatSecret).toBe(SECRET);
    expect(adminWs.raw.some((t) => t.includes('"agentCredentials"'))).toBe(true);
    adminWs.close();
    playerWs.close();
    screenWs.close();
  }, T);

  it('seat login hands it out: with the player token, without one (admin rescue), and per agent', async () => {
    const token = seatPlayerToken(sam.seat, sam.id);
    const me = (await sam.client.get('/me')).body;
    const withPlayer = await seatLogin({ seat: sam.seat, token, agent: 'claude' });
    expect(withPlayer.status, withPlayer.text).toBe(200);
    // Exact text: the entrypoint matches the key order strictly.
    expect(withPlayer.text).toBe(JSON.stringify({ name: 'Sam', apiKey: me.apiKey, credential: { env: 'CLAUDE_CODE_OAUTH_TOKEN', value: TOKEN } }));

    const rescue = await seatLogin({ seat: sam.seat, agent: 'claude' });
    expect(rescue.text).toBe(JSON.stringify({ credential: { env: 'CLAUDE_CODE_OAUTH_TOKEN', value: TOKEN } }));
    // A stale token (someone else's) is not an error with `agent`: credential only.
    const stale = await seatLogin({ seat: sam.seat, token: seatPlayerToken(sam.seat, 'someone-else'), agent: 'claude' });
    expect(stale.text).toBe(JSON.stringify({ credential: { env: 'CLAUDE_CODE_OAUTH_TOKEN', value: TOKEN } }));
    const codex = await seatLogin({ seat: 8, agent: 'codex' });
    expect(codex.text).toBe(JSON.stringify({ credential: { env: 'OPENAI_API_KEY', value: OKEY } }));
    // An older seat image (no `agent`): exactly as before, no credential.
    expect((await seatLogin({ seat: sam.seat, token })).text).toBe(JSON.stringify({ name: 'Sam', apiKey: me.apiKey }));
    expect((await seatLogin({ seat: sam.seat })).status).toBe(404);

    // Same checks as the player login: the seat password, constant time.
    for (const r of [
      await seatLogin({ seat: sam.seat, agent: 'claude' }, 'wrong-wrong-wrong-wrong'),
      await new Client(srv.url).req('POST', '/api/seat-login', { seat: sam.seat, agent: 'claude' }),
      await sam.client.post('/seat-login', { seat: sam.seat, agent: 'claude' }),
      await admin.post('/seat-login', { seat: sam.seat, agent: 'claude' }),
    ]) {
      expect(r.status).toBe(401);
      expectNoSecret(r.text, 'refused seat login');
    }
    expect((await seatLogin({ seat: 9, agent: 'claude' })).status).toBe(400);
    expect((await seatLogin({ seat: sam.seat, agent: 'bash' })).status).toBe(400);

    // /admin sees which shared login each seat fetched (not the value).
    const rows = (await admin.get<AdminClaudeSeatsDTO>('/admin/claude-seats')).body.seats;
    expect(rows[sam.seat - 1]!.sharedLogin).toMatchObject({ env: 'CLAUDE_CODE_OAUTH_TOKEN' });
    expect(rows[7]!.sharedLogin).toMatchObject({ env: 'OPENAI_API_KEY' });
    expect(rows.filter((r) => r.sharedLogin).length).toBe(2);

    // The token cleared: the API key; both cleared: null (the seat's own login).
    await admin.put('/admin/agent-credentials', { claudeToken: null });
    expect((await seatLogin({ seat: sam.seat, agent: 'claude' })).body.credential).toEqual({ env: 'ANTHROPIC_API_KEY', value: AKEY });
    const cleared = await admin.put<AdminClaudeSeatsDTO>('/admin/agent-credentials', { anthropicApiKey: '' });
    expect(cleared.body.agentCredentials).toEqual({ claudeToken: null, anthropicApiKey: null, openaiApiKey: '…OK5e' });
    expect((await seatLogin({ seat: sam.seat, token, agent: 'claude' })).text).toBe(JSON.stringify({ name: 'Sam', apiKey: me.apiKey, credential: null }));
    expect((await admin.get<AdminClaudeSeatsDTO>('/admin/claude-seats')).body.seats[sam.seat - 1]!.sharedLogin).toBeNull();
  }, T);

  it('kept across a restart and a wipe, like the seat password; state.json is owner-only', async () => {
    await admin.put('/admin/agent-credentials', { claudeToken: TOKEN });
    await srv.close();
    const state = join(dir, 'state.json');
    expect(statSync(state).mode & 0o777).toBe(0o600);
    expect(readFileSync(state, 'utf8')).toContain(TOKEN);
    srv = await bootServer({ dataDir: dir });
    admin = await adminClient(srv.url);
    expect((await admin.get<AdminClaudeSeatsDTO>('/admin/claude-seats')).body.agentCredentials).toEqual({
      claudeToken: '…TK9q',
      anthropicApiKey: null,
      openaiApiKey: '…OK5e',
    });
    expect((await admin.post('/admin/wipe', { confirm: 'WIPE' })).status).toBe(200);
    expect((await admin.get<AdminClaudeSeatsDTO>('/admin/claude-seats')).body.agentCredentials.claudeToken).toBe('…TK9q');
    expect((await seatLogin({ seat: 1, agent: 'claude' })).body.credential).toEqual({ env: 'CLAUDE_CODE_OAUTH_TOKEN', value: TOKEN });
  }, T);
});
