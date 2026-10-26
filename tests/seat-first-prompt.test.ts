// A new player at a seat gets a fresh conversation that starts with
// packages/starter-kit/FIRST_PROMPT.md.tmpl (plan §11.2 e). The game server's
// proxy names the seat's player to ttyd with an opaque token (seat-proxy.test.ts);
// this file runs sessions/entrypoint.sh's agent-loop with bash in a temp dir,
// with fake `claude` and `codex` commands that record their argv, to check the
// fresh-vs-resume decision, that the prompt is one argument, what is cleared
// between players, and that a token never reaches a shell.

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
if [ "$(basename "$0")" = codex ] && [ "\${1:-}" = login ]; then
  mkdir -p "$CODEX_HOME"
  printf '%s\\x1f' "$@" >>"$FAKE_LOGIN_LOG"
  printf '\\x1e' >>"$FAKE_LOGIN_LOG"
  if [ "\${2:-}" = --with-api-key ]; then k="$(cat)"; printf '{"OPENAI_API_KEY":"%s"}' "$k" >"$CODEX_HOME/auth.json"; exit 0; fi
  printf '%s' "\${FAKE_CODEX_STATUS_OUT:-Not logged in}"; exit "\${FAKE_CODEX_STATUS:-1}"
fi
printf '%s\\x1f' "$(basename "$0")" "$@" >>"$FAKE_LOG"
printf '\\x1e' >>"$FAKE_LOG"
[ -n "\${FAKE_ENV_LOG:-}" ] && printf '%s' "\${TTYD_PASS-<unset>}" >"$FAKE_ENV_LOG"
[ -n "\${FAKE_AUTH_LOG:-}" ] && printf '%s|%s|%s' "\${CLAUDE_CODE_OAUTH_TOKEN-<unset>}" "\${ANTHROPIC_API_KEY-<unset>}" "\${OPENAI_API_KEY-<unset>}" >"$FAKE_AUTH_LOG"
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

// A fake curl for the seat login (§11.2 e): records argv and stdin, answers $FAKE_CURL_OUT.
const FAKE_CURL = `#!/usr/bin/env bash
printf '%s\\x1f' "$@" >"$FAKE_CURL_ARGS"
cat >"$FAKE_CURL_STDIN"
printf '%s' "$FAKE_CURL_OUT"
exit "\${FAKE_CURL_STATUS:-0}"
`;
const SECRET = 'otter-lamp-quartz-ninety';

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
      FAKE_LOGIN_LOG: join(dir, 'codex-login.log'),
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
  writeFileSync(join(dir, 'bin', 'curl'), FAKE_CURL);
  chmodSync(join(dir, 'bin', 'curl'), 0o755);
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

describe('the AI helper starts logged in (§11.2 e seat login)', () => {
  const player = () => join(kit, '.pixel-clash/player.json');
  const env = (extra: Record<string, string> = {}) => ({
    TTYD_PASS: SECRET,
    FAKE_CURL_ARGS: join(dir, 'curl-args'),
    FAKE_CURL_STDIN: join(dir, 'curl-stdin'),
    FAKE_ENV_LOG: join(dir, 'agent-env'),
    FAKE_CURL_OUT: '{"name":"Ninja Sam","apiKey":"pc_ABCDEFGH234567"}',
    ...extra,
  });
  const curlArgs = () => (existsSync(join(dir, 'curl-args')) ? readFileSync(join(dir, 'curl-args'), 'utf8').split('\x1f').slice(0, -1) : null);

  it('a new player: trades the token for their login, writes player.json, keeps the password out of argv and the agent', () => {
    login();
    expect(loop([A], env())).toEqual([['claude', PROMPT]]);
    expect(readFileSync(player(), 'utf8')).toBe('{"name":"Ninja Sam","apiKey":"pc_ABCDEFGH234567"}\n');
    expect(statSync(player()).mode & 0o777).toBe(0o600);
    const args = curlArgs()!;
    expect(args.at(-1)).toBe('http://192.168.8.10:8080/api/seat-login');
    expect(args).toContain(`{"seat":3,"token":"${A}","agent":"claude"}`);
    expect(args.join(' ')).not.toContain(SECRET);
    expect(readFileSync(join(dir, 'curl-stdin'), 'utf8')).toBe(`user = "player:${SECRET}"\n`);
    // The agent never sees the seat password.
    expect(readFileSync(join(dir, 'agent-env'), 'utf8')).toBe('<unset>');
  });

  it('the same player again refreshes the login; no token asks only for the shared agent login', () => {
    loop([A], env());
    expect(loop([A], env({ FAKE_CURL_OUT: '{"name":"Ninja Sam","apiKey":"pc_NEWKEY2345678"}' }))).toEqual([['claude', '--continue']]);
    expect(readFileSync(player(), 'utf8')).toContain('pc_NEWKEY2345678');
    rmSync(join(dir, 'curl-args'));
    // Even a player-shaped answer to a token-less ask never writes player.json.
    expect(loop([], env({ FAKE_CURL_OUT: '{"name":"Someone","apiKey":"pc_OTHERKEY234567"}' }))).toEqual([['claude', '--continue']]);
    expect(curlArgs()).toContain('{"seat":3,"agent":"claude"}');
    expect(readFileSync(player(), 'utf8')).toContain('pc_NEWKEY2345678');
  });

  it('a failed or odd answer writes nothing (the agent asks for name and PIN as before)', () => {
    for (const out of ['', '{"error":{"code":"NOT_FOUND"}}', '{"name":"x","apiKey":"$(touch /tmp/pwn)"}', '{"name":"a\\"b","apiKey":"pc_ABCDEFGH234567"}', '{"name":"x","apiKey":"pc_ABCDEFGH234567"}\nmore']) {
      rmSync(join(kit, '.pixel-clash/last-player'), { force: true });
      expect(loop([A], env({ FAKE_CURL_OUT: out })), out).toEqual([['claude', PROMPT]]);
      expect(existsSync(player()), out).toBe(false);
    }
    rmSync(join(kit, '.pixel-clash/last-player'), { force: true });
    expect(loop([A], env({ FAKE_CURL_STATUS: '22' }))).toEqual([['claude', PROMPT]]);
    expect(existsSync(player())).toBe(false);
    // No seat password (old compose file): no call at all.
    rmSync(join(kit, '.pixel-clash/last-player'), { force: true });
    rmSync(join(dir, 'curl-args'), { force: true });
    const { TTYD_PASS: _drop, ...noPass } = env();
    expect(loop([A], noPass)).toEqual([['claude', PROMPT]]);
    expect(curlArgs()).toBeNull();
  });
});

describe('shared agent login from /admin (§11.2 f)', () => {
  const TOKEN = 'sk-ant-oat01-' + 'Ab3_-'.repeat(20);
  const AKEY = 'sk-ant-api03-' + 'Zy9-_'.repeat(20);
  const OKEY = 'sk-proj-' + 'Qw7_-'.repeat(10);
  const PLAYER = '"name":"Ninja Sam","apiKey":"pc_ABCDEFGH234567"';
  const cred = (envName: string, value: string) => `"credential":{"env":"${envName}","value":"${value}"}`;
  const auth = () => readFileSync(join(dir, 'agent-auth'), 'utf8').split('|');
  const claudeJson = () => JSON.parse(readFileSync(join(claudeDir, '.claude.json'), 'utf8'));
  const env = (out: string, extra: Record<string, string> = {}) => ({
    TTYD_PASS: SECRET,
    FAKE_CURL_ARGS: join(dir, 'curl-args'),
    FAKE_CURL_STDIN: join(dir, 'curl-stdin'),
    FAKE_AUTH_LOG: join(dir, 'agent-auth'),
    FAKE_CURL_OUT: out,
    ...extra,
  });

  it('a Claude seat: the token reaches only the agent, by env; player.json gets only name + apiKey; onboarding is pre-seeded', () => {
    writeFileSync(join(claudeDir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'x@y' }, projects: { '/other': { a: 1 } } }));
    const r = run(['agent-loop', A], env(`{${PLAYER},${cred('CLAUDE_CODE_OAUTH_TOKEN', TOKEN)}}`));
    expect(r.calls).toEqual([['claude', PROMPT]]);
    expect(auth()).toEqual([TOKEN, '<unset>', '<unset>']);
    expect(readFileSync(join(kit, '.pixel-clash/player.json'), 'utf8')).toBe(`{${PLAYER}}\n`);
    // Never in argv (the agent's or curl's) or the log.
    expect(JSON.stringify(r.calls)).not.toContain(TOKEN);
    expect(readFileSync(join(dir, 'curl-args'), 'utf8')).not.toContain('sk-ant');
    expect(r.stderr).not.toContain(TOKEN.slice(13, 30));
    expect(r.stderr).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    const c = claudeJson();
    expect(c.hasCompletedOnboarding).toBe(true);
    expect(c.theme).toBe('dark');
    expect(c.projects[kit]).toEqual({ hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true });
    expect(c.projects['/other']).toEqual({ a: 1 });
    expect(c.oauthAccount).toEqual({ emailAddress: 'x@y' });
    expect(c.customApiKeyResponses).toBeUndefined();
    expect(statSync(join(claudeDir, '.claude.json')).mode & 0o777).toBe(0o600);
  });

  it('an admin rescue (no token) still gets the shared login; an API key is pre-approved by its last 20 characters', () => {
    loop([A]);
    expect(loop([], env(`{${cred('ANTHROPIC_API_KEY', AKEY)}}`))).toEqual([['claude', '--continue']]);
    expect(auth()).toEqual(['<unset>', AKEY, '<unset>']);
    expect(readFileSync(join(dir, 'curl-args'), 'utf8')).toContain('{"seat":3,"agent":"claude"}');
    expect(existsSync(join(kit, '.pixel-clash/player.json'))).toBe(false);
    expect(claudeJson().customApiKeyResponses).toEqual({ approved: [AKEY.slice(-20)], rejected: [] });
    // Again: not added twice.
    loop([], env(`{${cred('ANTHROPIC_API_KEY', AKEY)}}`));
    expect(claudeJson().customApiKeyResponses.approved).toEqual([AKEY.slice(-20)]);
  });

  it('nothing set, a failed call, or a credential of the wrong kind or shape: the seat\'s own login, nothing exported', () => {
    const bad = [
      `{"credential":null}`,
      `{${cred('OPENAI_API_KEY', OKEY)}}`, // a Codex key on a Claude seat
      `{${cred('PATH', TOKEN)}}`,
      `{${cred('CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-api03-' + 'x'.repeat(30))}}`,
      `{${cred('CLAUDE_CODE_OAUTH_TOKEN', TOKEN)}}\nmore`,
      `{${PLAYER},${cred('CLAUDE_CODE_OAUTH_TOKEN', TOKEN)},"x":1}`,
      `{"credential":{"env":"CLAUDE_CODE_OAUTH_TOKEN","value":"$(touch ${join(dir, 'PWNED')})"}}`,
      `{"credential":{"env":"CLAUDE_CODE_OAUTH_TOKEN","value":"${TOKEN}","x":1}}`,
    ];
    for (const out of bad) {
      expect(loop([], env(out, { CLAUDE_CONTINUE: '0' })), out).toEqual([['claude']]);
      expect(auth(), out).toEqual(['<unset>', '<unset>', '<unset>']);
      expect(existsSync(join(claudeDir, '.claude.json')), out).toBe(false);
    }
    expect(loop([], env('', { FAKE_CURL_STATUS: '22', CLAUDE_CONTINUE: '0' }))).toEqual([['claude']]);
    expect(auth()).toEqual(['<unset>', '<unset>', '<unset>']);
    expect(existsSync(join(dir, 'PWNED'))).toBe(false);
  });

  it('a Codex seat logs in with the shared OpenAI key on stdin, once; the key never reaches codex\'s environment; ChatGPT logins are kept', () => {
    const loginLog = () =>
      existsSync(join(dir, 'codex-login.log'))
        ? readFileSync(join(dir, 'codex-login.log'), 'utf8').split('\x1e').filter(Boolean).map((c) => c.split('\x1f').slice(0, -1))
        : [];
    const codexArgs = ['--sandbox', 'danger-full-access', '--ask-for-approval', 'never'];
    const r = run(['agent-loop', A], env(`{${PLAYER},${cred('OPENAI_API_KEY', OKEY)}}`, { AGENT: 'codex' }));
    expect(r.calls).toEqual([['codex', ...codexArgs, PROMPT]]);
    expect(loginLog()).toEqual([['login', 'status'], ['login', '--with-api-key']]);
    expect(readFileSync(join(codexDir, 'auth.json'), 'utf8')).toBe(`{"OPENAI_API_KEY":"${OKEY}"}`);
    expect(auth()).toEqual(['<unset>', '<unset>', '<unset>']);
    expect(r.stderr).not.toContain(OKEY.slice(8));
    // Already logged in with that key: no login again.
    rmSync(join(dir, 'codex-login.log'));
    loop([A], env(`{${PLAYER},${cred('OPENAI_API_KEY', OKEY)}}`, { AGENT: 'codex' }));
    expect(loginLog()).toEqual([]);
    // A ChatGPT login stays.
    rmSync(join(codexDir, 'auth.json'));
    loop([A], env(`{${PLAYER},${cred('OPENAI_API_KEY', OKEY)}}`, { AGENT: 'codex', FAKE_CODEX_STATUS: '0', FAKE_CODEX_STATUS_OUT: 'Logged in using ChatGPT' }));
    expect(loginLog()).toEqual([['login', 'status']]);
    expect(existsSync(join(codexDir, 'auth.json'))).toBe(false);
    // A Claude token on a Codex seat is ignored.
    rmSync(join(dir, 'codex-login.log'));
    loop([A], env(`{${PLAYER},${cred('CLAUDE_CODE_OAUTH_TOKEN', TOKEN)}}`, { AGENT: 'codex' }));
    expect(loginLog()).toEqual([]);
    expect(auth()).toEqual(['<unset>', '<unset>', '<unset>']);
  });
});
