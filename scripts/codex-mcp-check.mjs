#!/usr/bin/env node
// Manual check (plan §11.3): drive the REAL Codex CLI against a running game
// server's /mcp, offline and without an OpenAI login.
//
//   node scripts/codex-mcp-check.mjs --server http://127.0.0.1:8080 [--codex codex] [--name Mia --pin 2468]
//
// How: a tiny fake "model" (the OpenAI Responses API, streamed) tells Codex to
// call the pixel-clash tools in order: login → get_game_state → validate_unit →
// get_rules. Codex itself connects to /mcp (through a logging proxy), using a
// temp CODEX_HOME and a temp kit folder whose .codex/config.toml is the kit's
// (MCP by URL, default_tools_approval_mode = "approve"). The check passes when
// every tool call completes with no approval needed. The player is created
// over REST if it doesn't exist yet (the server must be in LOBBY for that).
// Only Node built-ins; nothing touches the repo or ~/.codex.

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const SERVER = (args.server ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const CODEX = args.codex ?? 'codex';
const NAME = args.name ?? 'CodexCheck';
const PIN = args.pin ?? '2468';
const SOURCE = readFileSync(new URL('../packages/starter-kit/units/basic_soldier.js', import.meta.url), 'utf8');

const PLAN = [
  ['login', () => ({ name: NAME, pin: PIN })],
  ['get_game_state', (key) => ({ apiKey: key })],
  ['validate_unit', (key) => ({ source: SOURCE, apiKey: key })],
  ['get_rules', () => ({})],
];

const mcpLog = [];
let apiKey = '';
let turn = 0;
const usage = { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 };

function sse(res, item) {
  const id = `resp_${++turn}`;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of [
    { type: 'response.created', response: { id } },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id, usage } },
  ]) {
    res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  }
  res.end();
}

const fake = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString();
  if (req.url.startsWith('/mcp')) {
    // Logging proxy to the game server's /mcp.
    const headers = { ...req.headers };
    delete headers.host;
    delete headers['content-length'];
    const up = await fetch(SERVER + req.url, { method: req.method, headers, body: req.method === 'POST' ? body : undefined });
    const text = await up.text();
    let rpc = null;
    try {
      rpc = JSON.parse(body);
    } catch {}
    mcpLog.push({ method: req.method, rpc: rpc?.method ?? null, tool: rpc?.params?.name ?? null, status: up.status, protocol: req.headers['mcp-protocol-version'] ?? null });
    const m = /"apiKey":\s*"(pc_[a-z0-9]+)"/.exec(text);
    if (m) apiKey = m[1];
    res.writeHead(up.status, { 'content-type': up.headers.get('content-type') ?? 'application/json' });
    res.end(text);
    return;
  }
  if (req.method !== 'POST' || !req.url.endsWith('/responses')) {
    res.writeHead(404).end('{}');
    return;
  }
  const j = JSON.parse(body);
  const done = (j.input ?? []).filter((i) => i.type === 'function_call_output').length;
  if (done < PLAN.length) {
    const [tool, mk] = PLAN[done];
    const ns = (j.tools ?? []).find((t) => t.type === 'namespace' && (t.tools ?? []).some((x) => x.name === tool));
    const direct = (j.tools ?? []).find((t) => t.name?.endsWith(tool));
    const name = ns ? tool : (direct?.name ?? tool);
    sse(res, { type: 'function_call', id: `fc_${turn}`, call_id: `call_${turn}`, ...(ns ? { namespace: ns.name } : {}), name, arguments: JSON.stringify(mk(apiKey)) });
  } else {
    sse(res, { type: 'message', role: 'assistant', id: `msg_${turn}`, content: [{ type: 'output_text', text: 'CHECK DONE' }] });
  }
});

async function main() {
  const health = await fetch(`${SERVER}/api/health`).then((r) => r.json()).catch((e) => ({ error: String(e) }));
  if (!health.ok) throw new Error(`game server not reachable at ${SERVER}: ${JSON.stringify(health)}`);
  const created = await fetch(`${SERVER}/api/players`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: NAME, pin: PIN }),
  }).then((r) => r.json());
  if (created.error && created.error.code !== 'NAME_TAKEN') console.log(`note: create player: ${created.error.code} (logging in instead)`);

  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const port = fake.address().port;
  const base = mkdtempSync(join(tmpdir(), 'pc-codex-check-'));
  const home = join(base, 'home');
  const kit = join(base, 'kit');
  mkdirSync(join(kit, '.codex'), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, 'config.toml'),
    `model = "mock-model"\nmodel_provider = "mock"\ncheck_for_update_on_startup = false\n\n[model_providers.mock]\nname = "mock"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nenv_key = "PC_MOCK_KEY"\n\n[projects."${kit}"]\ntrust_level = "trusted"\n`,
  );
  // The kit's Codex config, pointed at the logging proxy.
  const kitToml = readFileSync(new URL('../packages/starter-kit/.codex/config.toml.tmpl', import.meta.url), 'utf8').replaceAll('{{HOST}}', `127.0.0.1:${port}`);
  writeFileSync(join(kit, '.codex/config.toml'), kitToml);
  writeFileSync(join(kit, 'AGENTS.md'), '# Pixel Clash check\n');

  const out = await new Promise((resolve, reject) => {
    const child = spawn(CODEX, ['exec', '--skip-git-repo-check', '--sandbox', 'danger-full-access', 'Run the Pixel Clash check.'], {
      cwd: kit,
      env: { ...process.env, CODEX_HOME: home, PC_MOCK_KEY: 'x' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    child.stdout.on('data', (d) => (text += d));
    child.stderr.on('data', (d) => (text += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('error', reject);
    child.on('close', () => {
      clearTimeout(timer);
      resolve(text);
    });
  });
  fake.close();
  rmSync(base, { recursive: true, force: true });

  const version = /OpenAI Codex v([\d.]+)/.exec(out)?.[1] ?? '?';
  const lines = out.split('\n').filter((l) => /^mcp: pixel-clash\//.test(l) || /approval/i.test(l));
  console.log(`codex ${version} against ${SERVER}/mcp`);
  for (const l of lines) console.log(`  ${l}`);
  console.log('  /mcp requests:', mcpLog.map((m) => `${m.rpc ?? m.method}${m.tool ? `(${m.tool})` : ''}=${m.status}`).join(' '));
  const completed = PLAN.map(([tool]) => tool).filter((t) => out.includes(`mcp: pixel-clash/${t} (completed)`));
  const failures = [];
  // validate_unit may be "failed" only as a tool error (e.g. a unit name clash); login and state must complete.
  for (const t of ['login', 'get_game_state', 'get_rules']) if (!completed.includes(t)) failures.push(`${t} did not complete`);
  if (!out.includes('mcp: pixel-clash/validate_unit')) failures.push('validate_unit was not called');
  if (/requires approval/i.test(out)) failures.push('a tool call needed approval');
  if (mcpLog.some((m) => m.status === 401 || m.status === 403)) failures.push('/mcp answered 401/403');
  if (!out.includes('CHECK DONE')) failures.push('Codex did not finish the turn');
  if (failures.length) {
    console.log(`FAIL: ${failures.join('; ')}`);
    console.log(out.slice(-3000));
    process.exit(1);
  }
  console.log('PASS: Codex connected to /mcp by URL and called every tool with no approval prompt.');
}

main().catch((e) => {
  console.error(e);
  fake.close();
  process.exit(1);
});
