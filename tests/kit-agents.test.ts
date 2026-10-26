// One kit source, two coding agents: the Claude Code kit
// (CLAUDE.md, .mcp.json, .claude/settings.json) and the Codex kit (AGENTS.md,
// .codex/config.toml) are rendered from the same packages/starter-kit files,
// by services/kit.ts (the reference) and sessions/entrypoint.sh (seat containers).

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { kitFileAgent, kitFiles, type KitOptions } from '../packages/server/src/services/kit.js';
import type { PlayerRecord } from '../packages/server/src/services/store.js';

const HOST = '192.168.8.10:8080';
const player = { id: 'p_1', name: 'Mia', apiKey: 'pc_abcdefghijklmnopqrstuvwx' } as unknown as PlayerRecord;
const files = (opts: Omit<KitOptions, 'host'>) => new Map(kitFiles({ host: HOST, ...opts }).map((f) => [f.name, f.content.toString()]));
const contractBlock = () => {
  const src = readFileSync(new URL('../packages/shared/src/contract.ts', import.meta.url), 'utf8');
  const begin = src.indexOf('// --- BEGIN CONTRACT');
  return src.slice(src.indexOf('\n', begin) + 1, src.indexOf('// --- END CONTRACT')).trimEnd();
};

describe('kit agents', () => {
  it('assigns each kit file to an agent', () => {
    expect(kitFileAgent('CLAUDE.md')).toBe('claude');
    expect(kitFileAgent('.claude/settings.json')).toBe('claude');
    expect(kitFileAgent('.mcp.json')).toBe('claude');
    expect(kitFileAgent('.codex/config.toml')).toBe('codex');
    expect(kitFileAgent('PROMPTS.md')).toBeNull();
    expect(kitFileAgent('units/basic_soldier.js')).toBeNull();
  });

  it('the Claude kit is unchanged: CLAUDE.md, .mcp.json, settings; no Codex files', () => {
    const kit = files({});
    expect([...kit.keys()]).toEqual(expect.arrayContaining(['CLAUDE.md', '.mcp.json', '.claude/settings.json', 'PROMPTS.md', 'units/basic_soldier.js']));
    expect([...kit.keys()].some((n) => n === 'AGENTS.md' || n.startsWith('.codex/'))).toBe(false);
    expect(kit.get('CLAUDE.md')!.split('\n')[0]).toBe('# Pixel Clash: instructions for Claude');
  });

  it('the Codex kit: AGENTS.md is CLAUDE.md with only the title changed, and carries the contract', () => {
    const claude = files({}).get('CLAUDE.md')!;
    const kit = files({ agent: 'codex' });
    expect([...kit.keys()]).toEqual(expect.arrayContaining(['AGENTS.md', '.codex/config.toml', 'PROMPTS.md', 'units/basic_factory.js']));
    expect([...kit.keys()].some((n) => n === 'CLAUDE.md' || n === '.mcp.json' || n.startsWith('.claude/'))).toBe(false);
    const agents = kit.get('AGENTS.md')!;
    expect(agents.split('\n')[0]).toBe('# Pixel Clash: instructions for Codex');
    expect(agents.split('\n').slice(1).join('\n')).toBe(claude.split('\n').slice(1).join('\n'));
    expect(agents).toContain('```ts\n' + contractBlock() + '\n```');
    expect(agents).not.toMatch(/\{\{[A-Z_]+\}\}/);
    // Codex reads at most project_doc_max_bytes of AGENTS.md (default 32 KiB).
    const max = Number(/^project_doc_max_bytes = (\d+)$/m.exec(kit.get('.codex/config.toml')!)![1]);
    expect(Buffer.byteLength(agents)).toBeLessThan(max);
  });

  it('.codex/config.toml: the MCP server by URL, tools pre-approved, edits limited to the kit; key header only in the personal kit', () => {
    const generic = files({ agent: 'codex' }).get('.codex/config.toml')!;
    expect(generic).toContain(`[mcp_servers.pixel-clash]\nurl = "http://${HOST}/mcp"\n`);
    expect(generic).toMatch(/^default_tools_approval_mode = "approve"$/m);
    expect(generic).toMatch(/^approval_policy = "on-request"$/m);
    expect(generic).toMatch(/^sandbox_mode = "workspace-write"$/m);
    expect(generic).toMatch(/^network_access = false$/m);
    expect(generic).not.toContain('Authorization');
    expect(generic).not.toContain('danger-full-access');

    const personal = files({ agent: 'codex', player });
    expect(personal.get('.codex/config.toml')).toContain(
      `url = "http://${HOST}/mcp"\nhttp_headers = { Authorization = "Bearer ${player.apiKey}" }\n`,
    );
    expect(JSON.parse(personal.get('.pixel-clash/player.json')!)).toEqual({ name: 'Mia', apiKey: player.apiKey });
    expect(personal.get('AGENTS.md')).toContain('Player: Mia');
  });

  it('sessions/entrypoint.sh renders the same files for each agent', () => {
    const repo = new URL('..', import.meta.url).pathname;
    for (const agent of ['claude', 'codex'] as const) {
      const kitDir = mkdtempSync(join(tmpdir(), 'pc-kit-'));
      try {
        execFileSync('bash', [join(repo, 'sessions/entrypoint.sh'), 'render'], {
          env: { PATH: process.env.PATH, HOME: kitDir, PIXEL_CLASH_URL: `http://${HOST}`, SEAT: '3', AGENT: agent, PC_KIT_DIR: kitDir, PC_TEMPLATE_DIR: join(repo, 'packages/starter-kit') },
          stdio: 'pipe',
        });
        const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [relative(kitDir, join(d, n))]));
        const rendered = walk(kitDir).sort();
        const zip = files({ agent });
        const expected = [...zip.keys()].sort();
        expect(rendered).toEqual(expected);
        for (const name of expected) expect(readFileSync(join(kitDir, name), 'utf8'), name).toBe(zip.get(name));
      } finally {
        rmSync(kitDir, { recursive: true, force: true });
      }
    }
  });
});
