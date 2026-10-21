import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, computeCost, type CostStats } from '@pixel-clash/shared';

// The kid-facing kit templates (plan §11). sessions/entrypoint.sh and (later)
// services/kit.ts fill {{HOST}} and rename *.tmpl.
const kitFile = (rel: string) => readFileSync(new URL(`../packages/starter-kit/${rel}`, import.meta.url), 'utf8');
const fill = (text: string) => text.replaceAll('{{HOST}}', '192.168.8.10:8080');

describe('starter-kit templates (§11)', () => {
  const claudeMd = kitFile('CLAUDE.md.tmpl');

  it('CLAUDE.md carries the §5 contract verbatim from shared/contract.ts', () => {
    const src = readFileSync(new URL('../packages/shared/src/contract.ts', import.meta.url), 'utf8');
    const begin = src.indexOf('// --- BEGIN CONTRACT');
    const end = src.indexOf('// --- END CONTRACT');
    expect(begin).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(begin);
    const block = src.slice(src.indexOf('\n', begin) + 1, end).trimEnd();
    expect(claudeMd).toContain('```ts\n' + block + '\n```');
  });

  it('CLAUDE.md has every §11 section, including 4b sprites', () => {
    for (const heading of [
      '## 1. Who you',
      '## 2. Player',
      '## 3. Workflow',
      '## 4. The unit contract',
      '## 4b. Drawing the unit',
      '## 5. Cost',
      '## 6. Budget',
      '## 7. After a battle',
      '## 8. Don',
      '## 9. Fallback',
    ]) {
      expect(claudeMd).toContain(heading);
    }
    for (const path of ['/api/units/validate', '/api/units ', '/api/login']) {
      expect(claudeMd).toContain(`http://{{HOST}}${path}`);
    }
  });

  it('CLAUDE.md worked cost examples match computeCost', () => {
    const cases: Array<[CostStats, number]> = [
      [{ type: 'soldier', maxHealth: 120, damage: 10, range: 40, speed: 1.5, attackCooldown: 60, size: 10 }, 92],
      [{ type: 'soldier', maxHealth: 500, damage: 20, range: 40, speed: 0.8, attackCooldown: 60, size: 20 }, 462],
      [{ type: 'soldier', maxHealth: 250, damage: 20, range: 40, speed: 0.8, attackCooldown: 60, size: 20 }, 180],
      [{ type: 'tower', maxHealth: 150, damage: 15, range: 180, speed: 0, attackCooldown: 45, size: 14 }, 198],
      [{ type: 'soldier', maxHealth: 60, damage: 6, range: 30, speed: 4, attackCooldown: 20, size: 6 }, 451],
      [{ type: 'soldier', maxHealth: 60, damage: 6, range: 30, speed: 4, attackCooldown: 10, size: 6 }, 902],
    ];
    for (const [stats, cost] of cases) {
      expect(computeCost(stats, DEFAULT_CONFIG.cost).cost).toBe(cost);
      expect(claudeMd).toContain(`$${cost}`);
    }
    const c = DEFAULT_CONFIG.cost;
    expect(claudeMd).toContain(`stat price = normal price × (1 + ${c.curveK} × (stat / max)²)`);
    expect(claudeMd).toContain(`maxHealth × ${c.hp} `);
    expect(claudeMd).toContain(`damage × ${c.damage} `);
    expect(claudeMd).toContain(`range × ${c.range} `);
    expect(claudeMd).toContain(`speed × ${c.speed} `);
    expect(claudeMd).toContain(`(size − 6) × ${c.size} `);
    expect(claudeMd).toContain(`cost = (${c.base} + the five stat prices) × max(1, ${c.referenceCooldown} / attackCooldown)`);
    expect(claudeMd).toContain(`Maxing a stat costs ${1 + c.curveK}×: spread your stats.`);
  });

  it('the CLAUDE.md sprite example has valid 16×16 frames', () => {
    const js = claudeMd.slice(claudeMd.indexOf('const PALETTE'), claudeMd.indexOf('export default class Knight'));
    const palette = Object.fromEntries([...js.matchAll(/^\s+(\w): '(#[0-9A-F]{6})'/gm)].map((m) => [m[1], m[2]]));
    const rows = [...js.matchAll(/'([.a-z]{8,})'/g)].map((m) => m[1] as string);
    expect(Object.keys(palette).length).toBeGreaterThan(0);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).toHaveLength(16);
      for (const ch of row) expect(ch === '.' || ch in palette).toBe(true);
    }
  });

  it('.mcp.json (generic: no headers) and .claude/settings.json are valid JSON', () => {
    const mcp = JSON.parse(fill(kitFile('.mcp.json.tmpl'))) as {
      mcpServers: Record<string, { type: string; url: string; headers?: unknown }>;
    };
    expect(mcp.mcpServers['pixel-clash']).toEqual({ type: 'http', url: 'http://192.168.8.10:8080/mcp' });

    const settings = JSON.parse(fill(kitFile('.claude/settings.json.tmpl'))) as {
      enabledMcpjsonServers: string[];
      permissions: { allow: string[] };
    };
    expect(settings.enabledMcpjsonServers).toEqual(['pixel-clash']);
    expect(settings.permissions.allow).toContain('mcp__pixel-clash');
    // No Bash rules at all: a prefix rule can't confine curl to the game API
    // (anything may follow the URL), so the §9 curl fallback asks an adult (§11).
    expect(settings.permissions.allow.some((r) => r.startsWith('Bash('))).toBe(false);
    const md = fill(claudeMd);
    expect([...md.matchAll(/^curl .*$/gm)].length).toBeGreaterThan(0);
    expect(md).toMatch(/not pre-approved, so each one asks for permission/);
    // §3's "tools only" rule must not forbid the §9 fallback.
    expect(md).toContain('(or the §9 `curl` commands if the tools are missing)');
  });

  it('only known placeholders are used', () => {
    for (const rel of ['CLAUDE.md.tmpl', '.mcp.json.tmpl', '.claude/settings.json.tmpl', 'PROMPTS.md']) {
      const names = [...kitFile(rel).matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]);
      for (const n of names) expect(['HOST', 'PLAYER_NAME', 'API_KEY']).toContain(n);
    }
  });
});
