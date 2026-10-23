// Starter kit zips (plan §11). M3 stub: the full CLAUDE.md template arrives
// with M4. The address is ALWAYS built from the download request's Host
// header (the address the laptop actually reached), never a guessed LAN IP.
//
// Files in packages/starter-kit ending in `.tmpl` get their `{{HOST}}`,
// `{{API_KEY}}` and `{{PLAYER_NAME}}` placeholders filled and the suffix
// removed. Missing templates fall back to built-in minimal versions.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Writable } from 'node:stream';
import { ZipArchive } from 'archiver';
import { repoPath } from '../util/paths.js';
import type { PlayerRecord } from './store.js';

export interface KitOptions {
  /** host[:port] from the request's Host header. */
  host: string;
  /** Personal kit: the player (key pre-filled). Generic kit: undefined. */
  player?: PlayerRecord;
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

function fallbackClaudeMd(opts: KitOptions): string {
  const who = opts.player
    ? `You are helping the player **${opts.player.name}**. The MCP server already sends their key.`
    : 'First read `.pixel-clash/player.json`. If it is missing, or a tool says AUTH_REQUIRED or KEY_INVALID, ask the player for their name and 4-digit PIN, call `login`, save `{name, apiKey}` to `.pixel-clash/player.json`, and pass `apiKey` on every pixel-clash tool call.';
  return `# Pixel Clash

A player (aged about 9-13) is playing Pixel Clash. They only talk to you: never ask them to type or edit code.

${who}

Workflow: call \`get_game_state\` → write or edit \`units/<name>.js\` → \`validate_unit\` → fix using each error's \`fix\` → \`submit_unit\` (only when \`submissionsOpen\`) → tell the player the cost and remind them to select and place it on the web page. When changing an existing unit (the player can also edit units on the web page), first call \`get_unit_source\` for its latest \`source\` and \`version\`, change that code, and pass \`unitId\` and \`baseVersion\` (= that version) to \`validate_unit\` and \`submit_unit\`. On \`UNIT_CHANGED\`, fetch the source again and re-apply the change.

Call \`get_unit_contract\` for the full unit contract and \`get_rules\` for the rules.

Fallback without MCP: \`curl -sS -X POST http://${opts.host}/api/units/validate -H "Authorization: Bearer <apiKey>" -H "Content-Type: application/json" --data-binary @body.json\` (and \`/api/units\` to submit), where body.json is \`{"source": "<file text>"}\`.
`;
}

function fill(text: string, opts: KitOptions): string {
  return text
    .replaceAll('{{HOST}}', opts.host)
    .replaceAll('{{API_KEY}}', opts.player?.apiKey ?? '')
    // Same text as the seat entrypoint renders for a generic kit.
    .replaceAll('{{PLAYER_NAME}}', opts.player?.name ?? '(not logged in yet: see below)');
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

/** Stream the kit zip to `out` (an HTTP response). */
export async function writeKitZip(out: Writable, opts: KitOptions): Promise<void> {
  const zip = new ZipArchive({ zlib: { level: 9 } });
  zip.pipe(out);
  const root = repoPath('packages', 'starter-kit');
  const prefix = 'pixel-clash-kit/';
  const written = new Set<string>();
  if (existsSync(root)) {
    for (const file of walk(root)) {
      let rel = relative(root, file).split('\\').join('/');
      let content: string | Buffer = readFileSync(file);
      if (rel.endsWith('.tmpl')) {
        rel = rel.slice(0, -'.tmpl'.length);
        content = fill(content.toString('utf8'), opts);
      }
      // .mcp.json is always generated: only the personal kit has the key header.
      if (rel === '.mcp.json') continue;
      written.add(rel);
      zip.append(content, { name: prefix + rel });
    }
  }
  zip.append(mcpJson(opts), { name: `${prefix}.mcp.json` });
  if (!written.has('.claude/settings.json')) {
    zip.append(settingsJson(opts), { name: `${prefix}.claude/settings.json` });
  }
  if (!written.has('CLAUDE.md')) zip.append(fallbackClaudeMd(opts), { name: `${prefix}CLAUDE.md` });
  if (opts.player) {
    zip.append(`${JSON.stringify({ name: opts.player.name, apiKey: opts.player.apiKey }, null, 2)}\n`, {
      name: `${prefix}.pixel-clash/player.json`,
    });
  }
  await zip.finalize();
}
