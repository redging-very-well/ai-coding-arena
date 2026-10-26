// The starter kit's files (plan §11, §11.3), rendered the same way
// sessions/entrypoint.sh renders a seat's /kit (tests/kit-agents.test.ts
// compares the two). There is no kit download: players join in their
// browser and their AI helper runs in an AI seat (§11.2).
//
// Files in packages/starter-kit ending in `.tmpl` get their `{{HOST}}`,
// `{{API_KEY}}`, `{{PLAYER_NAME}}` and `{{AGENT_NAME}}` placeholders filled
// and the suffix removed. Missing templates fall back to built-in minimal
// versions.
//
// One kit source, two agents (§11.3): CLAUDE.md.tmpl is the instructions for
// both. The Claude Code kit gets it as CLAUDE.md plus .mcp.json and
// .claude/settings.json; the Codex kit gets the SAME text as AGENTS.md plus
// .codex/config.toml. sessions/entrypoint.sh applies the same rule (kitFileAgent).

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { repoPath } from '../util/paths.js';
import type { PlayerRecord } from './store.js';

export type KitAgent = 'claude' | 'codex';

/** Per agent: the name in the instructions' title and the instructions file. */
export const KIT_AGENTS: Readonly<Record<KitAgent, { name: string; instructions: string }>> = {
  claude: { name: 'Claude', instructions: 'CLAUDE.md' },
  codex: { name: 'Codex', instructions: 'AGENTS.md' },
};

/**
 * Which agent a kit file (name after `.tmpl` is removed) belongs to; null =
 * both. CLAUDE.md is the shared source: the Codex kit renames it to AGENTS.md.
 */
export function kitFileAgent(rel: string): KitAgent | null {
  if (rel === 'CLAUDE.md' || rel === '.mcp.json' || rel.startsWith('.claude/')) return 'claude';
  if (rel.startsWith('.codex/')) return 'codex';
  return null;
}

/**
 * In packages/starter-kit but not a kit file: FIRST_PROMPT.md(.tmpl) is the
 * message a seat's agent starts with when a new player sits down (sent by
 * sessions/entrypoint.sh, plan §11.2 e). /kit doesn't get it.
 */
export const SEAT_ONLY_FILES: ReadonlySet<string> = new Set(['FIRST_PROMPT.md']);

export interface KitOptions {
  /** host[:port] from the request's Host header. */
  host: string;
  /** With a player: their key pre-filled (as a seat has after login). Without: generic. */
  player?: PlayerRecord;
  /** Which coding agent the kit is for (default: Claude Code). */
  agent?: KitAgent;
}

/** Hosts we accept in a kit (no injection into JSON/markdown). */
export function safeHost(host: string | undefined): string {
  return host && /^[A-Za-z0-9.\-:[\]]{1,255}$/.test(host) ? host : 'localhost:8080';
}

function mcpJson(opts: KitOptions): string {
  const server: Record<string, unknown> = { type: 'http', url: `http://${opts.host}/mcp` };
  if (opts.player) server.headers = { Authorization: `Bearer ${opts.player.apiKey}` };
  return `${JSON.stringify({ mcpServers: { 'pixel-clash': server } }, null, 2)}\n`;
}

/**
 * Seat settings: only the MCP tools and the kit's own files are pre-approved.
 * The curl fallback (CLAUDE.md §9) is deliberately not: a Bash prefix rule
 * can't limit curl to this server's API (anything can follow the URL), and
 * a curl prompt in a seat is a useful signal for an adult to come and look.
 */
function settingsJson(opts: KitOptions): string {
  const settings = {
    enableAllProjectMcpServers: true,
    enabledMcpjsonServers: ['pixel-clash'],
    permissions: {
      allow: [
        'mcp__pixel-clash',
        'Read(./units/**)',
        'Edit(./units/**)',
        'Read(./.pixel-clash/**)',
        'Edit(./.pixel-clash/**)',
      ],
    },
  };
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/**
 * The Codex MCP config: the template, plus the key header in a personal kit
 * (Codex sends `http_headers` on every /mcp request).
 */
export function codexConfigToml(template: string | undefined, opts: KitOptions): string {
  const base =
    template ??
    `project_doc_max_bytes = 131072\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"\n\n[mcp_servers.pixel-clash]\nurl = "http://{{HOST}}/mcp"\ndefault_tools_approval_mode = "approve"\ntool_timeout_sec = 120\n`;
  let text = fill(base, opts);
  if (opts.player) {
    const header = `http_headers = { Authorization = "Bearer ${opts.player.apiKey}" }`;
    text = text.replace(/^(url = "http:\/\/[^"\n]*\/mcp"\n)/m, `$1${header}\n`);
    if (!text.includes(header)) throw new Error('kit: .codex/config.toml.tmpl has no pixel-clash url line');
  }
  return text;
}

function fallbackClaudeMd(opts: KitOptions): string {
  const who = opts.player
    ? `You are helping the player **${opts.player.name}**. The MCP server already sends their key.`
    : 'First read `.pixel-clash/player.json`. If it is missing, or a tool says AUTH_REQUIRED or KEY_INVALID, ask the player for their name and 4-digit PIN, call `login`, save `{name, apiKey}` to `.pixel-clash/player.json`, and pass `apiKey` on every pixel-clash tool call.';
  return `# Pixel Clash: instructions for ${KIT_AGENTS[opts.agent ?? 'claude'].name}

A player (aged about 9-13) is playing Pixel Clash. They only talk to you: never ask them to type or edit code.

${who}

Workflow: call \`get_game_state\` → write or edit \`units/<name>.js\` → \`validate_unit\` → fix using each error's \`fix\` → \`submit_unit\` (Plan phase only: on \`PHASE_CLOSED\`, tell the player you'll send it as soon as the Plan phase starts, call \`wait_for_phase\` until \`submissionsOpen\` is true, then submit) → tell the player the cost and remind them to select and place it on the web page. When changing an existing unit (the player can also edit units on the web page), first call \`get_unit_source\` for its latest \`source\` and \`version\`, change that code, and pass \`unitId\` and \`baseVersion\` (= that version) to \`validate_unit\` and \`submit_unit\`. On \`UNIT_CHANGED\`, fetch the source again and re-apply the change.

Four unit types: soldier, tower, wall, factory (walls block everyone and never attack; factories build minions). Call \`get_unit_contract\` for the full unit contract and templates, and \`get_rules\` for the rules.

Fallback without MCP: \`curl -sS -X POST http://${opts.host}/api/units/validate -H "Authorization: Bearer <apiKey>" -H "Content-Type: application/json" --data-binary @body.json\` (and \`/api/units\` to submit), where body.json is \`{"source": "<file text>"}\`.
`;
}

function fill(text: string, opts: KitOptions): string {
  return text
    .replaceAll('{{HOST}}', opts.host)
    .replaceAll('{{API_KEY}}', opts.player?.apiKey ?? '')
    // Same text as the seat entrypoint renders for a generic kit.
    .replaceAll('{{PLAYER_NAME}}', opts.player?.name ?? '(not logged in yet: see below)')
    .replaceAll('{{AGENT_NAME}}', KIT_AGENTS[opts.agent ?? 'claude'].name);
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** The kit's files (path inside the kit → content). */
export function kitFiles(opts: KitOptions): Array<{ name: string; content: string | Buffer }> {
  const agent = opts.agent ?? 'claude';
  const root = repoPath('packages', 'starter-kit');
  const files: Array<{ name: string; content: string | Buffer }> = [];
  const written = new Set<string>();
  let codexTemplate: string | undefined;
  if (existsSync(root)) {
    for (const file of walk(root)) {
      let rel = relative(root, file).split('\\').join('/');
      let content: string | Buffer = readFileSync(file);
      const isTemplate = rel.endsWith('.tmpl');
      if (isTemplate) rel = rel.slice(0, -'.tmpl'.length);
      if (SEAT_ONLY_FILES.has(rel)) continue;
      const owner = kitFileAgent(rel);
      // CLAUDE.md is the instructions for both agents (renamed for Codex).
      if (rel === 'CLAUDE.md') rel = KIT_AGENTS[agent].instructions;
      else if (owner !== null && owner !== agent) continue;
      // Always generated: only the personal kit has the key header.
      if (rel === '.mcp.json') continue;
      if (rel === '.codex/config.toml') {
        codexTemplate = content.toString('utf8');
        continue;
      }
      if (isTemplate) content = fill(content.toString('utf8'), opts);
      written.add(rel);
      files.push({ name: rel, content });
    }
  }
  if (agent === 'claude') {
    files.push({ name: '.mcp.json', content: mcpJson(opts) });
    if (!written.has('.claude/settings.json')) files.push({ name: '.claude/settings.json', content: settingsJson(opts) });
  } else {
    files.push({ name: '.codex/config.toml', content: codexConfigToml(codexTemplate, opts) });
  }
  const instructions = KIT_AGENTS[agent].instructions;
  if (!written.has(instructions)) files.push({ name: instructions, content: fallbackClaudeMd(opts) });
  if (opts.player) {
    files.push({
      name: '.pixel-clash/player.json',
      content: `${JSON.stringify({ name: opts.player.name, apiKey: opts.player.apiKey }, null, 2)}\n`,
    });
  }
  return files;
}

