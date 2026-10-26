// No required settings in sessions/.env (plan §11.1 "Claude box setup",
// §11.2 a): the game server makes up the seat password on its first start
// (persisted, never replaced), /admin gets a ready-to-copy
// `make seats PIXEL_CLASH_URL=… SEAT_SECRET=…` (admin + details only), and
// sessions/set-env.sh writes those values into .env safely.

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AdminClaudeSeatsDTO, SetupInfoDTO } from '@pixel-clash/shared';
import type { RunningServer } from '../packages/server/src/server.js';
import { SEAT_SECRET_RE } from '../packages/server/src/services/claudeSeats.js';
import { generateSeatSecret, seatSetupCommand } from '../packages/server/src/services/setup.js';
import { Client, adminClient, bootServer, removeDir, tempDataDir } from './helpers/server.js';

const T = 60_000;
const ROOT = join(__dirname, '..');
const SCRIPT = join(ROOT, 'sessions', 'set-env.sh');
const EXAMPLE = join(ROOT, 'sessions', '.env.example');

describe('generateSeatSecret / seatSetupCommand', () => {
  it('makes four random words that ttyd accepts', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const s = generateSeatSecret();
      expect(s).toMatch(/^[a-z]+(-[a-z]+){3}$/);
      expect(SEAT_SECRET_RE.test(s)).toBe(true);
      seen.add(s);
    }
    expect(seen.size).toBeGreaterThan(190);
  });

  it('builds the command only from valid values', () => {
    expect(seatSetupCommand('http://192.168.8.10:8080/', 'otter-lamp-quartz-ninety')).toBe(
      'make seats PIXEL_CLASH_URL=http://192.168.8.10:8080 SEAT_SECRET=otter-lamp-quartz-ninety',
    );
    expect(seatSetupCommand('http://192.168.8.10:8080', null)).toBeNull();
    expect(seatSetupCommand('http://192.168.8.10:8080', 'short')).toBeNull();
    expect(seatSetupCommand('http://x/$(id)', 'otter-lamp-quartz-ninety')).toBeNull();
    expect(seatSetupCommand('javascript:alert(1)', 'otter-lamp-quartz-ninety')).toBeNull();
  });
});

describe('the seat password is made up on the first start', () => {
  let srv: RunningServer;
  let dir: string;
  beforeAll(async () => {
    dir = tempDataDir();
    srv = await bootServer({ dataDir: dir });
  }, T);
  afterAll(async () => {
    await srv.close();
    removeDir(dir);
  });

  it('generates and persists one, and never replaces an existing one', async () => {
    const admin = await adminClient(srv.url);
    const plain = (await admin.get<AdminClaudeSeatsDTO>('/admin/claude-seats')).body;
    expect(plain.seatSecretSet).toBe(true);
    expect(plain.seatSecret).toBeUndefined();
    expect(plain.setupCommand).toBeUndefined();
    const first = (await admin.get<AdminClaudeSeatsDTO>('/admin/claude-seats?details=1')).body.seatSecret!;
    expect(SEAT_SECRET_RE.test(first)).toBe(true);
    // Never in the public setup payload.
    expect(JSON.stringify((await new Client(srv.url).get('/setup')).body)).not.toContain(first);

    // A restart keeps it.
    await srv.close();
    srv = await bootServer({ dataDir: dir });
    const again = await adminClient(srv.url);
    expect((await again.get<AdminClaudeSeatsDTO>('/admin/claude-seats?details=1')).body.seatSecret).toBe(first);
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).setup.seatSecret).toBe(first);

    // One the admin set is kept across restarts too.
    expect((await again.put('/admin/setup', { seatSecret: 'my-own-seat-password' })).status).toBe(200);
    await srv.close();
    srv = await bootServer({ dataDir: dir });
    const third = await adminClient(srv.url);
    expect((await third.get<AdminClaudeSeatsDTO>('/admin/claude-seats?details=1')).body.seatSecret).toBe('my-own-seat-password');
  }, T);

  it('shows the Claude box setup command to the admin only, with details', async () => {
    const anon = await new Client(srv.url).get('/admin/claude-seats?details=1');
    expect(anon.status).toBe(403);
    expect(anon.body.error.code).toBe('ADMIN_REQUIRED');
    expect(JSON.stringify(anon.body)).not.toContain('make seats');

    const admin = await adminClient(srv.url);
    const d = (await admin.get<AdminClaudeSeatsDTO>('/admin/claude-seats?details=1')).body;
    const base = (await admin.get<SetupInfoDTO>('/setup')).body.baseUrl;
    expect(d.setupCommand).toBe(`make seats PIXEL_CLASH_URL=${base} SEAT_SECRET=${d.seatSecret}`);

    // The preferred URL wins.
    await admin.put('/admin/setup', { preferredUrl: 'http://10.0.0.9:8080' });
    const p = (await admin.get<AdminClaudeSeatsDTO>('/admin/claude-seats?details=1')).body;
    expect(p.setupCommand).toBe(`make seats PIXEL_CLASH_URL=http://10.0.0.9:8080 SEAT_SECRET=${p.seatSecret}`);

    // No seat password (cleared): no command.
    await admin.put('/admin/setup', { seatSecret: null });
    expect((await admin.get<AdminClaudeSeatsDTO>('/admin/claude-seats?details=1')).body.setupCommand).toBeNull();
  }, T);
});

describe('sessions/set-env.sh', () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'pc-set-env-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const run = (file: string, names: string[], env: Record<string, string>) =>
    spawnSync('sh', [SCRIPT, file, ...names], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env }, encoding: 'utf8' });
  const lines = (file: string) => readFileSync(file, 'utf8').split('\n');

  it('creates .env from .env.example, sets both values, keeps every other line, 0600', () => {
    const d = tmp();
    copyFileSync(EXAMPLE, join(d, '.env.example'));
    const r = run(join(d, '.env'), ['PIXEL_CLASH_URL', 'SEAT_SECRET'], {
      PIXEL_CLASH_URL: 'http://192.168.1.50:8080/',
      SEAT_SECRET: 'otter-lamp-quartz-ninety',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Created');
    expect(r.stdout + r.stderr).not.toContain('otter-lamp-quartz-ninety'); // the secret is never printed
    const out = lines(join(d, '.env'));
    const ex = lines(EXAMPLE);
    expect(out.length).toBe(ex.length);
    expect(out.filter((l) => l.startsWith('PIXEL_CLASH_URL='))).toEqual(['PIXEL_CLASH_URL=http://192.168.1.50:8080']);
    expect(out.filter((l) => l.startsWith('SEAT_SECRET='))).toEqual(['SEAT_SECRET=otter-lamp-quartz-ninety']);
    // Everything else is byte-identical.
    ex.forEach((l, i) => {
      if (!/^(PIXEL_CLASH_URL|SEAT_SECRET)=/.test(l)) expect(out[i]).toBe(l);
    });
    expect(statSync(join(d, '.env')).mode & 0o777).toBe(0o600);
    expect(readdirSync(d).sort()).toEqual(['.env', '.env.example']); // no temp file left
  });

  it('updates an existing .env in place, appends a missing line, keeps the rest', () => {
    const d = tmp();
    const f = join(d, '.env');
    writeFileSync(f, '# mine\nAGENT=codex\nSEAT_SECRET=old-old-old-old\nCUSTOM=a=b=c\n', { mode: 0o644 });
    const r = run(f, ['SEAT_SECRET', 'PIXEL_CLASH_URL'], { SEAT_SECRET: 'New.Secret_~-12345', PIXEL_CLASH_URL: 'https://game-server.local' });
    expect(r.status).toBe(0);
    expect(readFileSync(f, 'utf8')).toBe('# mine\nAGENT=codex\nSEAT_SECRET=New.Secret_~-12345\nCUSTOM=a=b=c\nPIXEL_CLASH_URL=https://game-server.local\n');
    expect(statSync(f).mode & 0o777).toBe(0o600);
    // Only the named values change.
    expect(run(f, ['PIXEL_CLASH_URL'], { PIXEL_CLASH_URL: 'http://10.0.0.2:9000', SEAT_SECRET: 'ignored-ignored-ignored' }).status).toBe(0);
    expect(readFileSync(f, 'utf8')).toContain('SEAT_SECRET=New.Secret_~-12345\n');
    expect(readFileSync(f, 'utf8')).toContain('PIXEL_CLASH_URL=http://10.0.0.2:9000\n');
  });

  it('sets AGENT to claude or codex (the /admin wizard adds it), refuses anything else', () => {
    const d = tmp();
    const f = join(d, '.env');
    writeFileSync(f, 'AGENT=claude\nSEAT_AGENT_7=codex\n', { mode: 0o600 });
    expect(run(f, ['AGENT'], { AGENT: 'codex' }).status).toBe(0);
    expect(readFileSync(f, 'utf8')).toBe('AGENT=codex\nSEAT_AGENT_7=codex\n');
    for (const bad of ['Codex', 'gpt', '', 'codex\nEVIL=1']) {
      const r = run(f, ['AGENT'], { AGENT: bad });
      expect(r.status, JSON.stringify(bad)).not.toBe(0);
      expect(r.stderr).toContain('AGENT');
    }
    expect(readFileSync(f, 'utf8')).toBe('AGENT=codex\nSEAT_AGENT_7=codex\n');
  });

  it('refuses bad values and unknown names without writing anything (no shell injection)', () => {
    const d = tmp();
    const f = join(d, '.env');
    const before = 'PIXEL_CLASH_URL=http://1.2.3.4:8080\nSEAT_SECRET=otter-lamp-quartz-ninety\n';
    writeFileSync(f, before, { mode: 0o600 });
    const pwn = join(d, 'pwned');
    const bad: Array<[string, string]> = [
      ['SEAT_SECRET', 'short'],
      ['SEAT_SECRET', 'has spaces in it ok'],
      ['SEAT_SECRET', 'a:b-c-d-e-f-g-h'],
      ['SEAT_SECRET', `x$(touch ${pwn})xxxxxxxx`],
      ['SEAT_SECRET', `otter-lamp-quartz-ninety\nEVIL=1`],
      ['SEAT_SECRET', 'x'.repeat(65)],
      ['PIXEL_CLASH_URL', 'localhost:8080'],
      ['PIXEL_CLASH_URL', 'http://1.2.3.4:8080/play'],
      ['PIXEL_CLASH_URL', `http://\`touch ${pwn}\``],
      ['PIXEL_CLASH_URL', 'http://1.2.3.4:8080\nSEAT_SECRET=evil-evil-evil-evil'],
      ['PIXEL_CLASH_URL', ''],
    ];
    for (const [name, value] of bad) {
      const r = run(f, [name], { [name]: value });
      expect(r.status, `${name}=${JSON.stringify(value)}`).not.toBe(0);
      expect(r.stderr).toContain(name);
      expect(readFileSync(f, 'utf8')).toBe(before);
    }
    expect(run(f, ['OPENAI_API_KEY'], { OPENAI_API_KEY: 'sk-x' }).status).not.toBe(0);
    expect(run(f, [], {}).status).not.toBe(0);
    expect(existsSync(pwn)).toBe(false);
    expect(readdirSync(d).sort()).toEqual(['.env']);
  });

  it('is plain POSIX sh (no bashisms, no sed -i)', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src.startsWith('#!/bin/sh')).toBe(true);
    const code = src.replace(/^\s*#.*$/gm, '');
    expect(code).not.toMatch(/sed -i|\[\[|\$\{[A-Za-z_]+\/\//);
    expect(() => execFileSync('sh', ['-n', SCRIPT])).not.toThrow();
  });
});
