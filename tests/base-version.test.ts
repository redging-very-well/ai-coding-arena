// Optimistic concurrency for unit revisions: validate and
// submit take an optional `baseVersion` (REST, MCP and admin on-behalf). A
// stale one is 409 UNIT_CHANGED with the current version; without it, submits
// keep working as before (older Claude sessions).

import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunningServer } from '../packages/server/src/server.js';
import { type Client, adminClient, bootServer, namedUnit, newPlayer, removeDir, tempDataDir } from './helpers/server.js';

const T = 60_000;

async function call(client: McpClient, name: string, args: Record<string, unknown>) {
  const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
  return { isError: r.isError === true, s: (r.structuredContent ?? {}) as Record<string, any>, text: (r.content[0] as { text: string }).text };
}

describe('baseVersion / UNIT_CHANGED', () => {
  let srv: RunningServer;
  let dir: string;
  let admin: Client;
  let a: Awaited<ReturnType<typeof newPlayer>>;
  let mcp: McpClient;

  beforeAll(async () => {
    dir = tempDataDir();
    srv = await bootServer({ dataDir: dir });
    a = await newPlayer(srv.url, 'Ada');
    await newPlayer(srv.url, 'Bo');
    admin = await adminClient(srv.url);
    expect((await admin.post('/admin/match', { rounds: 1 })).body.phase).toBe('PLAN');
    expect((await a.client.post('/units', { source: namedUnit('Edit Me') })).body).toMatchObject({ unitId: 'edit-me', version: 1 });
    mcp = new McpClient({ name: 'base-version-test', version: '1.0.0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${srv.url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${a.apiKey}` } } }));
  }, T);

  afterAll(async () => {
    await mcp?.close();
    await srv.close();
    removeDir(dir);
  });

  it('REST: a matching baseVersion validates and submits; a stale one is 409 UNIT_CHANGED', async () => {
    const v = await a.client.post('/units/validate', { source: namedUnit('Edit Me', { damage: 21 }), unitId: 'edit-me', baseVersion: 1 });
    expect(v.status).toBe(200);
    expect(v.body.unit).toMatchObject({ unitId: 'edit-me', version: 2 });
    const s = await a.client.post('/units', { source: namedUnit('Edit Me', { damage: 22 }), unitId: 'edit-me', baseVersion: 1 });
    expect(s.body).toMatchObject({ ok: true, unitId: 'edit-me', version: 2 });

    // The editor still thinks it is on v1.
    const stale = await a.client.post('/units', { source: namedUnit('Edit Me', { damage: 23 }), unitId: 'edit-me', baseVersion: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: 'UNIT_CHANGED', details: { unitId: 'edit-me', baseVersion: 1, version: 2 } });
    expect(stale.body.error.message).toBe('This unit changed since you opened it (now v2). Reload to see the new code.');
    expect(stale.body.error.hint).toContain('get_unit_source');
    const staleV = await a.client.post('/units/validate', { source: namedUnit('Edit Me'), unitId: 'edit-me', baseVersion: 1 });
    expect(staleV.status).toBe(409);
    expect(staleV.body.error.code).toBe('UNIT_CHANGED');
    // Nothing was stored by the refused submit.
    expect((await a.client.get('/units/edit-me')).body.version).toBe(2);
  }, T);

  it('REST: no baseVersion still works; a bad one is BAD_REQUEST', async () => {
    const s = await a.client.post('/units', { source: namedUnit('Edit Me', { damage: 24 }), unitId: 'edit-me' });
    expect(s.body).toMatchObject({ ok: true, version: 3 });
    expect((await a.client.post('/units', { source: namedUnit('Edit Me'), unitId: 'edit-me', baseVersion: 'x' })).body.error.code).toBe('BAD_REQUEST');
    expect((await a.client.post('/units', { source: namedUnit('Edit Me'), unitId: 'edit-me', baseVersion: 0 })).body.error.code).toBe('BAD_REQUEST');
    // baseVersion without unitId makes no sense.
    expect((await a.client.post('/units/validate', { source: namedUnit('Fresh'), baseVersion: 1 })).body.error.code).toBe('BAD_REQUEST');
    // null counts as "not given".
    expect((await a.client.post('/units/validate', { source: namedUnit('Edit Me'), unitId: 'edit-me', baseVersion: null })).status).toBe(200);
  }, T);

  it('MCP: validate_unit and submit_unit take baseVersion', async () => {
    const tools = (await mcp.listTools()).tools;
    for (const name of ['validate_unit', 'submit_unit']) {
      expect(Object.keys(tools.find((t) => t.name === name)!.inputSchema.properties ?? {})).toContain('baseVersion');
    }
    const src = await call(mcp, 'get_unit_source', { unitId: 'edit-me' });
    expect(src.s.version).toBe(3);
    const stale = await call(mcp, 'submit_unit', { source: namedUnit('Edit Me', { damage: 25 }), unitId: 'edit-me', baseVersion: 2 });
    expect(stale.isError).toBe(true);
    expect(stale.s.errors[0]).toMatchObject({ code: 'UNIT_CHANGED', details: { version: 3 } });
    expect(stale.s.playerHint).toContain('new version');
    const staleV = await call(mcp, 'validate_unit', { source: namedUnit('Edit Me'), unitId: 'edit-me', baseVersion: 2 });
    expect(staleV.s.errors[0].code).toBe('UNIT_CHANGED');
    const fresh = await call(mcp, 'submit_unit', { source: namedUnit('Edit Me', { damage: 25 }), unitId: 'edit-me', baseVersion: 3 });
    expect(fresh.isError).toBe(false);
    expect(fresh.s.unit).toMatchObject({ unitId: 'edit-me', version: 4 });
    // Without baseVersion (older Claude sessions): still accepted.
    const plain = await call(mcp, 'submit_unit', { source: namedUnit('Edit Me', { damage: 26 }), unitId: 'edit-me' });
    expect(plain.s.unit.version).toBe(5);
  }, T);

  it('admin on behalf: dry run and submit check baseVersion too', async () => {
    const dry = await admin.post(`/admin/players/${a.id}/units`, { source: namedUnit('Edit Me'), unitId: 'edit-me', baseVersion: 4, dryRun: true });
    expect(dry.status).toBe(409);
    expect(dry.body.error).toMatchObject({ code: 'UNIT_CHANGED', details: { version: 5 } });
    const sub = await admin.post(`/admin/players/${a.id}/units`, { source: namedUnit('Edit Me'), unitId: 'edit-me', baseVersion: 4 });
    expect(sub.body.error.code).toBe('UNIT_CHANGED');
    const ok = await admin.post(`/admin/players/${a.id}/units`, { source: namedUnit('Edit Me', { damage: 27 }), unitId: 'edit-me', baseVersion: 5 });
    expect(ok.body).toMatchObject({ ok: true, version: 6 });
    const plain = await admin.post(`/admin/players/${a.id}/units`, { source: namedUnit('Edit Me', { damage: 28 }), unitId: 'edit-me' });
    expect(plain.body).toMatchObject({ ok: true, version: 7 });
  }, T);
});

describe('Claude is told to fetch the latest code and pass baseVersion', () => {
  it('in CLAUDE.md, the kit fallback and the MCP instructions/tool descriptions', async () => {
    const { readFileSync } = await import('node:fs');
    const md = readFileSync(new URL('../packages/starter-kit/CLAUDE.md.tmpl', import.meta.url), 'utf8');
    const revising = md.slice(md.indexOf('**Revising a unit:**'), md.indexOf('**The two starter units'));
    expect(revising).toContain('ALWAYS');
    expect(revising).toContain('get_unit_source');
    expect(revising).toContain('baseVersion');
    expect(revising).toContain('UNIT_CHANGED');
    expect(md).toContain('/api/units/<UNIT_ID>');
    const kit = readFileSync(new URL('../packages/server/src/services/kit.ts', import.meta.url), 'utf8');
    expect(kit).toMatch(/get_unit_source[\s\S]*baseVersion[\s\S]*UNIT_CHANGED/);
    const { MCP_INSTRUCTIONS } = await import('../packages/server/src/mcp.js');
    expect(MCP_INSTRUCTIONS).toMatch(/ALWAYS call get_unit_source[\s\S]*baseVersion/);
    expect(MCP_INSTRUCTIONS).toContain('UNIT_CHANGED');
  });
});
