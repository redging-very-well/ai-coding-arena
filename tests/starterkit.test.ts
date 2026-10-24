import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, computeCost, type CostStats } from '@pixel-clash/shared';
import { validate } from '../packages/server/src/validator/validate.js';

// The player-facing kit templates (plan §11). sessions/entrypoint.sh and (later)
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
    // The $10,000 redesign (§6 worked examples).
    const soldier: CostStats = { type: 'soldier', maxHealth: 1400, damage: 56, range: 40, speed: 1.5, attackCooldown: 60, size: 10 };
    const body: CostStats = { type: 'soldier', maxHealth: 800, damage: 0, range: 20, speed: 1.5, attackCooldown: 60, size: 10 };
    const cases: Array<[CostStats, number]> = [
      [soldier, 807],
      [{ ...soldier, element: 'fire' }, 1049],
      [{ ...soldier, element: 'ice' }, 1412],
      [{ type: 'soldier', maxHealth: 2000, damage: 80, range: 40, speed: 0.8, attackCooldown: 60, size: 20 }, 1386],
      [{ type: 'soldier', maxHealth: 3600, damage: 80, range: 40, speed: 0.8, attackCooldown: 60, size: 20 }, 2868],
      [{ type: 'tower', maxHealth: 1200, damage: 72, range: 140, speed: 0, attackCooldown: 45, size: 14 }, 1200],
      [{ type: 'soldier', maxHealth: 480, damage: 24, range: 30, speed: 4, attackCooldown: 20, size: 6 }, 2516],
      [{ type: 'soldier', maxHealth: 480, damage: 24, range: 30, speed: 4, attackCooldown: 10, size: 6 }, 5032],
      [{ ...body, support: { kind: 'heal', power: 96, range: 120 } }, 892],
      [{ ...body, support: { kind: 'might', power: 30, range: 100 } }, 869],
      [{ type: 'wall', maxHealth: 3200, damage: 0, range: 0, speed: 0, attackCooldown: 0 }, 149],
      [{ type: 'factory', maxHealth: 2400, damage: 0, range: 0, speed: 0, attackCooldown: 0, productionInterval: 600 }, 2194],
      // §4d examples: the Frost Spire (ice + splash 40 at CD 60) and the fire archer factory.
      [{ type: 'tower', maxHealth: 1200, damage: 72, range: 140, speed: 0, attackCooldown: 60, size: 14, element: 'ice', splashRadius: 40 }, 2520],
      [{ type: 'factory', maxHealth: 2400, damage: 0, range: 0, speed: 0, attackCooldown: 0, productionInterval: 900, produces: 'archer', minionElement: 'fire' }, 2214],
    ];
    for (const [stats, cost] of cases) {
      expect(computeCost(stats, DEFAULT_CONFIG.cost).cost).toBe(cost);
      expect(claudeMd).toContain(`$${cost.toLocaleString('en-US')}`);
    }
    const c = DEFAULT_CONFIG.cost;
    expect(claudeMd).toContain(`stat price = normal price × (1 + ${c.curveK} × (stat / max)²)`);
    expect(claudeMd).toContain(`maxHealth × ${c.hp} `);
    expect(claudeMd).toContain(`damage × ${c.damage} `);
    expect(claudeMd).toContain(`range × ${c.range} `);
    expect(claudeMd).toContain(`speed × ${c.speed} `);
    expect(claudeMd).toContain(`(size − 6) × ${c.size} `);
    expect(claudeMd).toContain(`cost = (${c.base} + the five stat prices + heal) × max(1, ${c.referenceCooldown} / attackCooldown) × power × splash × element + aura`);
    expect(claudeMd).toContain(`power   = 1 + ${c.powerFactor} × (maxHealth / ${DEFAULT_CONFIG.stats.bounds.maxHealth.max}) × (damage / ${DEFAULT_CONFIG.stats.bounds.damage.max})`);
    expect(claudeMd).toContain(`Maxing a stat costs ${1 + c.curveK}×, being tough AND strong costs up to ×${1 + c.powerFactor} more.`);
    // §6 budget and caps, and the §4d teaching points.
    expect(claudeMd).toContain(`**$${DEFAULT_CONFIG.caps.budget.toLocaleString('en-US')} per round**`);
    expect(claudeMd).toContain(`at most **$${DEFAULT_CONFIG.caps.unitCost.toLocaleString('en-US')}** per unit`);
    expect(claudeMd).toContain('## 4d. Elements, splash and support');
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) expect(claudeMd).toMatch(new RegExp(`^${n}\\. \\*\\*`, 'm'));
    expect(claudeMd).toContain("return { action: 'heal', targetId: need[0].id }");
    expect(claudeMd).not.toContain('There is no healing');
    // The redesign's teaching points: 12 fighters and the copy ramp, the synergies, accuracy, factories.
    expect(claudeMd).toContain('12 fighters, make them count');
    expect(claudeMd).toContain(`copy ${DEFAULT_CONFIG.caps.copyRamp.freeCopies + 1} costs +${DEFAULT_CONFIG.caps.copyRamp.pctPerCopy}%`);
    expect(claudeMd).toContain(`**Kindle:** a burning enemy takes +${DEFAULT_CONFIG.elements.kindlePct}%`);
    expect(claudeMd).toContain(`**Brittle:** a frozen enemy takes +${DEFAULT_CONFIG.elements.brittlePct}%`);
    expect(claudeMd).toContain('Fast units dodge arrows.');
    expect(claudeMd).toContain(`up to ${DEFAULT_CONFIG.accuracy.missMaxPct}% at full speed`);
    expect(claudeMd).toContain(`Up to **${DEFAULT_CONFIG.caps.maxFactoryCopies} factories**`);
  });

  it('the §4d Field Medic and Frost Spire examples validate at their stated prices', async () => {
    const blocks = [...claudeMd.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]!);
    const medic = blocks.find((b) => b.startsWith('// Field Medic'))!;
    const spire = blocks.find((b) => b.startsWith('// Frost Spire'))!;
    const unit = (ctor: string, update: string) => `export default class U {\n  constructor() {\n${ctor}\n  }\n${update}\n}\n`;
    const cases: Array<[string, number]> = [
      [
        unit(
          "this.name = 'Patch'; this.type = 'soldier'; this.maxHealth = 800; this.damage = 0; this.range = 20; this.speed = 1.5; this.attackCooldown = 60; this.color = '#33CC66'; this.size = 10; this.support = 'heal'; this.supportPower = 96; this.supportRange = 120;",
          medic.split('\n').slice(1).join('\n'),
        ),
        892,
      ],
      [
        unit(
          "this.name = 'Frost Spire'; this.type = 'tower'; this.maxHealth = 1200; this.damage = 72; this.range = 140; this.speed = 0; this.attackCooldown = 60; this.color = '#66CCFF'; this.size = 14; this.element = 'ice'; this.splashRadius = 40;",
          spire.split('\n').slice(2).join('\n'),
        ),
        2520,
      ],
    ];
    for (const [source, cost] of cases) {
      const r = await validate(source, {}, DEFAULT_CONFIG);
      expect(r.ok, JSON.stringify(r.ok ? r.warnings : r.errors)).toBe(true);
      if (r.ok) {
        expect(r.unit.cost).toBe(cost);
        expect(r.warnings.map((w) => w.code).filter((c) => c !== 'W_NO_SPRITE')).toEqual([]);
      }
    }
  }, 60_000);

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

  it('PROMPTS.md has the M8.8 and redesign prompts and the $10,000 budget', () => {
    const prompts = kitFile('PROMPTS.md');
    expect(prompts).toContain('Make an ice tower called Frost Spire');
    expect(prompts).toContain('Build a medic soldier called Patch');
    expect(prompts).toContain('a mortar tower with splash 40');
    // The requester's own examples (2026-10-23).
    for (const p of ['Make an ice tower that slows everything near my base.', 'Make a medic that heals my tanks.', 'Fire archers from my factory.']) expect(prompts).toContain(p);
    expect(prompts).toContain('**$10,000**');
    expect(prompts).toContain('**$3,000**');
    for (const p of ['Make a fast scout that dodges arrows.', 'Make a fire tower and an ice soldier that work together.', 'Make a factory that floods the map with minions.', 'Make the best army you can for $10,000.']) expect(prompts).toContain(p);
    expect(prompts).not.toContain('can units heal?');
  });

  it('only known placeholders are used', () => {
    for (const rel of ['CLAUDE.md.tmpl', '.mcp.json.tmpl', '.claude/settings.json.tmpl', 'PROMPTS.md']) {
      const names = [...kitFile(rel).matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]);
      for (const n of names) expect(['HOST', 'PLAYER_NAME', 'API_KEY']).toContain(n);
    }
  });
});
