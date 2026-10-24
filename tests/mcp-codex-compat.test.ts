// MCP compatibility with the OpenAI Codex CLI's client (plan §11.3). The
// requests below were recorded from codex-cli 0.162.1 (the version the seat
// image pins) talking to /mcp through a logging proxy (scripts/codex-mcp-check.mjs
// drives the real binary the same way). Raw fetch, so the exact headers and
// bodies Codex sends are what the server sees.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunningServer } from '../packages/server/src/server.js';
import { bootServer, newPlayer, removeDir, tempDataDir } from './helpers/server.js';

const T = 60_000;
const CODEX_VERSION = '0.162.1';

/** What Codex sends on every /mcp POST (plus mcp-protocol-version after initialize). */
const codexHeaders = (extra: Record<string, string> = {}) => ({
  'user-agent': `codex-mcp-client/${CODEX_VERSION}`,
  accept: 'text/event-stream, application/json',
  'content-type': 'application/json',
  ...extra,
});

const turnMeta = (callId: string) => ({
  callId,
  'x-codex-turn-metadata': {
    session_id: '01a16e12-c887-7bd1-a375-9eb8bb1a3962',
    thread_id: '01a16e12-c887-7bd1-a375-9eb8bb1a3962',
    model: 'gpt-5.5',
    turn_id: '01a16e12-c8e4-7ac2-9ed8-6547e757c6ab',
    turn_started_at_unix_ms: 1792848087270,
    thread_source: 'user',
    turn_trigger: 'user',
    sandbox: 'none',
    sandbox_mode: 'danger-full-access',
    auto_review_enabled: false,
    codex_version: CODEX_VERSION,
  },
  threadId: '01a16e12-c887-7bd1-a375-9eb8bb1a3962',
  sessionId: '01a16e12-c887-7bd1-a375-9eb8bb1a3962',
  windowId: '01a16e12-c887-7bd1-a375-9eb8bb1a3962:0',
  itemId: `fc_${callId}`,
  progressToken: 1,
});

interface RpcReply {
  status: number;
  headers: Headers;
  body: any;
}

describe('MCP with a Codex-style client (§11.3)', () => {
  let srv: RunningServer;
  let dir: string;
  let protocol = '';
  let id = 0;

  const post = async (payload: Record<string, unknown>, extra: Record<string, string> = {}): Promise<RpcReply> => {
    const headers = codexHeaders(protocol ? { 'mcp-protocol-version': protocol, ...extra } : extra);
    const res = await fetch(`${srv.url}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', ...payload }) });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  };
  const call = async (name: string, args: Record<string, unknown>, extra: Record<string, string> = {}) => {
    const r = await post({ id: ++id, method: 'tools/call', params: { _meta: turnMeta(`call_${id}`), name, arguments: args } }, extra);
    expect(r.status).toBe(200);
    return r.body.result as { content: Array<{ type: string; text: string }>; structuredContent: any; isError?: boolean };
  };

  beforeAll(async () => {
    dir = tempDataDir();
    srv = await bootServer({ dataDir: dir });
    await newPlayer(srv.url, 'Mia', '2468');
  }, T);
  afterAll(async () => {
    await srv.close();
    removeDir(dir);
  });

  it('initialize: negotiates Codex\'s protocol version, stateless (no session id), with instructions', async () => {
    const r = await post({
      id: id++,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: { elicitation: { form: {}, url: {} } },
        clientInfo: { name: 'codex-mcp-client', title: 'Codex', version: CODEX_VERSION },
      },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('mcp-session-id')).toBeNull();
    expect(r.headers.get('content-type')).toContain('application/json');
    expect(r.body.result.protocolVersion).toBe('2025-06-18');
    expect(r.body.result.capabilities.tools).toBeDefined();
    expect(r.body.result.serverInfo.name).toBe('pixel-clash');
    expect(r.body.result.instructions).toContain('login');
    protocol = r.body.result.protocolVersion;

    const note = await post({ method: 'notifications/initialized' });
    expect(note.status).toBe(202);
  });

  it('a newer or older client protocol version still gets a version the server supports', async () => {
    for (const v of ['2099-01-01', '2025-03-26', '2024-11-05']) {
      const r = await fetch(`${srv.url}/mcp`, {
        method: 'POST',
        headers: codexHeaders(),
        body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'initialize', params: { protocolVersion: v, capabilities: {}, clientInfo: { name: 'codex-mcp-client', version: '9.9.9' } } }),
      });
      const body = (await r.json()) as any;
      expect(r.status).toBe(200);
      expect(typeof body.result.protocolVersion).toBe('string');
      if (v !== '2099-01-01') expect(body.result.protocolVersion).toBe(v);
    }
  });

  it('tools/list: every tool has a plain object input schema Codex can turn into a function', async () => {
    const r = await post({ id: ++id, method: 'tools/list', params: { _meta: { progressToken: 0 } } });
    expect(r.status).toBe(200);
    const tools = r.body.result.tools as Array<{ name: string; description: string; inputSchema: any; outputSchema?: any }>;
    expect(tools).toHaveLength(10);
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z_]+$/);
      expect(t.description.length).toBeGreaterThan(10);
      expect(t.inputSchema.type).toBe('object');
      for (const [key, prop] of Object.entries<any>(t.inputSchema.properties ?? {})) {
        expect(['string', 'integer', 'number'], `${t.name}.${key}`).toContain(prop.type);
      }
      // No combinators or refs Codex would have to flatten.
      expect(JSON.stringify(t.inputSchema)).not.toMatch(/"(anyOf|oneOf|allOf|\$ref)"/);
      expect(t.outputSchema?.type).toBe('object');
    }
  });

  it('tools/call with Codex _meta: text + structuredContent; no key = a tool error, never 401/403', async () => {
    const rules = await call('get_rules', {});
    expect(rules.isError).toBeUndefined();
    expect(rules.content[0]!.type).toBe('text');
    expect(rules.structuredContent.ok).toBe(true);

    const anon = await call('get_game_state', {});
    expect(anon.isError).toBe(true);
    expect(anon.structuredContent.errors[0].code).toBe('AUTH_REQUIRED');
    expect(anon.content[0]!.text).toContain('AUTH_REQUIRED');

    // The generic kit: login, then apiKey as an argument.
    const login = await call('login', { name: 'Mia', pin: '2468' });
    expect(login.isError).toBeUndefined();
    const apiKey = login.structuredContent.apiKey as string;
    expect(apiKey).toMatch(/^pc_/);
    expect(login.content[0]!.text).toContain(apiKey);
    const state = await call('get_game_state', { apiKey });
    expect(state.structuredContent.player.name).toBe('Mia');

    // The personal kit: .codex/config.toml http_headers sends the key as a header.
    const viaHeader = await call('list_my_units', {}, { authorization: `Bearer ${apiKey}` });
    expect(viaHeader.isError).toBeUndefined();
    expect(Array.isArray(viaHeader.structuredContent.units)).toBe(true);

    const bad = await call('list_my_units', {}, { authorization: 'Bearer pc_wrongwrongwrongwrongwrong' });
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent.errors[0].code).toBe('KEY_INVALID');
  });

  it('Codex\'s OAuth discovery and SSE probes get no auth challenge', async () => {
    for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server', '/mcp/.well-known/openid-configuration']) {
      const r = await fetch(`${srv.url}${path}`, { headers: { 'user-agent': `codex-mcp-client/${CODEX_VERSION}`, 'mcp-protocol-version': '2024-11-05' } });
      expect(r.status, path).toBe(404);
      expect(r.headers.get('www-authenticate')).toBeNull();
    }
    const sse = await fetch(`${srv.url}/mcp`, { headers: { accept: 'text/event-stream', 'user-agent': `codex-mcp-client/${CODEX_VERSION}` } });
    expect(sse.status).toBe(405);
    expect(sse.headers.get('www-authenticate')).toBeNull();
  });
});
