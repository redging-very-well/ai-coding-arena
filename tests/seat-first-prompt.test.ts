// A new player at a seat gets a fresh conversation that starts with
// packages/starter-kit/FIRST_PROMPT.md.tmpl (plan §11.2 e). The game server's
// proxy names the seat's player to ttyd with an opaque token (seat-proxy.test.ts);
// this file runs sessions/entrypoint.sh's agent-loop with bash in a temp dir,
// with fake `claude` and `codex` commands that record their argv, to check the
// fresh-vs-resume decision, that the prompt is one argument, what is cleared
// between players, and that a token never reaches a shell.

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { kitFiles } from '../packages/server/src/services/kit.js';

const REPO = new URL('..', import.meta.url).pathname;
const ENTRYPOINT = join(REPO, 'sessions/entrypoint.sh');
const TEMPLATE = readFileSync(join(REPO, 'packages/starter-kit/FIRST_PROMPT.md.tmpl'), 'utf8');
const PROMPT = TEMPLATE.trimEnd();
const A = 'a'.repeat(16) + '0123456789abcdef';
const B = 'b'.repeat(16) + '0123456789abcdef';

// Records argv (fields split by \x1f, calls by \x1e), leaves a conversation
// behind like the real agent, and on call number $FAKE_STOP_AFTER stops the
// entrypoint's endless loop by killing it.
const FAKE = `#!/usr/bin/env bash
printf '%s\\x1f' "$(basename "$0")" "$@" >>"$FAKE_LOG"
printf '\\x1e' >>"$FAKE_LOG"
if [ "$(basename "$0")" = claude ]; then
  d="$CLAUDE_CONFIG_DIR/projects/$(printf '%s' "$PWD" | sed 's/[^A-Za-z0-9]/-/g')"
  mkdir -p "$d" && touch "$d/chat.jsonl"
else
  mkdir -p "$CODEX_HOME/sessions/2026" && touch "$CODEX_HOME/sessions/2026/rollout.jsonl"
fi
n=$(tr -cd '\\036' <"$FAKE_LOG" | wc -c)
[ "$n" -ge "\${FAKE_STOP_AFTER:-1}" ] && kill -TERM "$PPID"
exit 0
`;

let dir: string;
let kit: string;
let claudeDir: string;
let codexDir: string;
let log: string;

function run(args: string[], env: Record<string, string> = {}) {
  writeFileSync(log, '');
  const r = spawnSync('bash', [ENTRYPOINT, ...args], {
    cwd: dir,
    env: {
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      HOME: dir,
      CLAUDE_CONFIG_DIR: claudeDir,
      CODEX_HOME: codexDir,
      PC_KIT_DIR: kit,
      PC_TEMPLATE_DIR: join(REPO, 'packages/starter-kit'),
      PIXEL_CLASH_URL: 'http://192.168.8.10:8080',
      SEAT: '3',
      FAKE_LOG: log,
      ...env,
    },
    encoding: 'utf8',
    timeout: 15_000,
  });
  const calls = readFileSync(log, 'utf8')
    .split('\x1e')
    .filter(Boolean)
    .map((c) => c.split('\x1f').slice(0, -1));
  return { calls, stderr: r.stderr, status: r.status };
}

const loop = (token: string[] = [], env: Record<string, string> = {}) => run(['agent-loop', ...token], env).calls;
const lastPlayer = () => (existsSync(join(kit, '.pixel-clash/last-player')) ? readFileSync(join(kit, '.pixel-clash/last-player'), 'utf8') : null);
const login = () => writeFileSync(join(kit, '.pixel-clash/player.json'), '{"name":"Old","apiKey":"pc_old"}\n');
const projectDir = () => join(claudeDir, 'projects', kit.replace(/[^A-Za-z0-9]/g, '-'));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pc-seat-'));
  kit = join(dir, 'kit');
  claudeDir = join(dir, 'claude');
  codexDir = join(dir, 'codex');
  log = join(dir, 'calls.log');
  mkdirSync(join(dir, 'bin'));
  for (const name of ['claude', 'codex']) {
    writeFileSync(join(dir, 'bin', name), FAKE);
    chmodSync(join(dir, 'bin', name), 0o755);
  }
  mkdirSync(join(kit, '.pixel-clash'), { recursive: true });
  mkdirSync(claudeDir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('first prompt for a new player (§11.2 e)', () => {
  it('the prompt is facts and tool calls, and is not a kit file', () => {
    expect(PROMPT).toMatch(/^A new player has just sat down/);
    for (const tool of ['get_rules', 'get_unit_contract', 'get_game_state', 'login']) expect(PROMPT).toContain(tool);
    expect(PROMPT).toContain('.pixel-clash/player.json');
    expect(PROMPT).not.toMatch(/\{\{[A-Z_]+\}\}/);
    const printed = spawnSync('bash', [ENTRYPOINT, 'first-prompt'], { env: { PATH: process.env.PATH, PC_TEMPLATE_DIR: join(REPO, 'packages/starter-kit') }, encoding: 'utf8' });
    expect(printed.stdout.trimEnd()).toBe(PROMPT);
    // ttyd passes the proxy's ?arg= token to agent-loop only with -a.
    expect(readFileSync(ENTRYPOINT, 'utf8')).toMatch(/exec ttyd -W -O -a -p 7781 [^\n]*\n(?:[^\n]*\\\n)*\s*\/usr\/local\/bin\/pixel-clash-seat agent-loop\n/);
    for (const agent of ['claude', 'codex'] as const) {
      expect(kitFiles({ host: 'h:1', agent }).some((f) => f.name.startsWith('FIRST_PROMPT'))).toBe(false);
    }
  });

  it('a new player: previous login and chats cleared, fresh claude with the prompt as one argument; restarts resume', () => {
    login();
    mkdirSync(projectDir(), { recursive: true });
    writeFileSync(join(projectDir(), 'old.jsonl'), 'old chat');
    writeFileSync(join(claudeDir, 'history.jsonl'), '{"display":"my PIN is 4321"}');
    mkdirSync(join(codexDir, 'sessions'), { recursive: true });
    writeFileSync(join(codexDir, 'history.jsonl'), 'pin');
    writeFileSync(join(codexDir, 'auth.json'), '{}');
    writeFileSync(join(claudeDir, '.credentials.json'), '{}');

    const calls = loop([A], { FAKE_STOP_AFTER: '2' });
    expect(calls).toEqual([['claude', PROMPT], ['claude', '--continue']]);
    expect(existsSync(join(kit, '.pixel-clash/player.json'))).toBe(false);
    expect(existsSync(join(projectDir(), 'old.jsonl'))).toBe(false);
    expect(existsSync(join(claudeDir, 'history.jsonl'))).toBe(false);
    expect(existsSync(join(codexDir, 'sessions'))).toBe(false);
    expect(existsSync(join(codexDir, 'history.jsonl'))).toBe(false);
    // Logins stay.
    expect(existsSync(join(claudeDir, '.credentials.json'))).toBe(true);
    expect(existsSync(join(codexDir, 'auth.json'))).toBe(true);
    expect(lastPlayer()).toBe(`${A}\n`);
  });

  it('a reload or the same player resumes; an admin rescue (no token) never prompts', () => {
    loop([A]);
    login();
    expect(loop([A])).toEqual([['claude', '--continue']]);
    expect(loop([])).toEqual([['claude', '--continue']]);
    expect(existsSync(join(kit, '.pixel-clash/player.json'))).toBe(true);
    expect(lastPlayer()).toBe(`${A}\n`);
    // Then a different player sits down.
    expect(loop([B])).toEqual([['claude', PROMPT]]);
    expect(existsSync(join(kit, '.pixel-clash/player.json'))).toBe(false);
    expect(lastPlayer()).toBe(`${B}\n`);
  });

  it('the same player with no conversation yet gets the prompt; no token and no conversation starts plain', () => {
    loop([A]);
    rmSync(projectDir(), { recursive: true });
    login();
    expect(loop([A])).toEqual([['claude', PROMPT]]);
    expect(existsSync(join(kit, '.pixel-clash/player.json'))).toBe(true); // same player: kept
    rmSync(projectDir(), { recursive: true });
    expect(loop([])).toEqual([['claude']]);
    expect(loop([], { CLAUDE_CONTINUE: '0' })).toEqual([['claude']]);
  });

  it('`new-player` makes the next open a new player, even the same one', () => {
    loop([A]);
    const r = run(['new-player']);
    expect(r.status).toBe(0);
    expect(lastPlayer()).toBeNull();
    expect(loop([A])).toEqual([['claude', PROMPT]]);
  });

  it('a token is only ever compared: anything but 32 hex digits is ignored and never runs', () => {
    loop([A]);
    const pwned = join(dir, 'PWNED');
    const bad = [`$(touch ${pwned})`, `\`touch ${pwned}\``, `${A}; touch ${pwned}`, `${A}\ntouch ${pwned}`, A.toUpperCase(), A.slice(1), `${A}0`, '../../etc/passwd', `-${A.slice(1)}`, ''];
    for (const token of bad) {
      expect(loop([token]), JSON.stringify(token)).toEqual([['claude', '--continue']]);
      expect(lastPlayer()).toBe(`${A}\n`);
    }
    // Two ?arg= values: not a token either.
    expect(loop([B, B])).toEqual([['claude', '--continue']]);
    expect(existsSync(pwned)).toBe(false);
    expect(lastPlayer()).toBe(`${A}\n`);
  });

  it('keeps the seat flags in front of the prompt (claude permission mode, codex sandbox)', () => {
    expect(loop([A], { CLAUDE_PERMISSION_MODE: 'acceptEdits' })).toEqual([['claude', '--permission-mode', 'acceptEdits', PROMPT]]);
    const codexArgs = ['--sandbox', 'danger-full-access', '--ask-for-approval', 'never'];
    expect(loop([B], { AGENT: 'codex', FAKE_STOP_AFTER: '2' })).toEqual([
      ['codex', ...codexArgs, PROMPT],
      ['codex', 'resume', '--last', ...codexArgs],
    ]);
    expect(loop([B], { AGENT: 'codex' })).toEqual([['codex', 'resume', '--last', ...codexArgs]]);
    expect(loop([], { AGENT: 'codex' })).toEqual([['codex', 'resume', '--last', ...codexArgs]]);
    expect(loop([A], { AGENT: 'codex' })).toEqual([['codex', ...codexArgs, PROMPT]]);
  });
});
