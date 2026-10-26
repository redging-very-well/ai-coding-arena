// Players discover tactics themselves (plan §17 "No strategy hints"): the text
// players and their AI helper read states facts only, and lists everything a
// unit's update() can read.

import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, SUCCESS_PLAYER_HINT, playerHintFor, WARNING_CODES } from '@pixel-clash/shared';
import { buildGuide } from '../packages/server/src/services/guide.js';
import { buildContract, buildRules } from '../packages/server/src/services/rules.js';
import { MCP_INSTRUCTIONS } from '../packages/server/src/mcp.js';

const kitFile = (rel: string) => readFileSync(new URL(`../packages/starter-kit/${rel}`, import.meta.url), 'utf8');

/** The verbatim contract block of packages/shared/src/contract.ts. */
const contract = (() => {
  const src = readFileSync(new URL('../packages/shared/src/contract.ts', import.meta.url), 'utf8');
  return src.slice(src.indexOf('// --- BEGIN CONTRACT'), src.indexOf('// --- END CONTRACT ---'));
})();

/** The field names of `export interface Name { … }` (nested `{ … }` types skipped). */
function fieldsOf(name: string): string[] {
  const m = new RegExp(`export interface ${name}(?: extends \\w+)? \\{`).exec(contract);
  if (!m) throw new Error(`no interface ${name} in the contract`);
  let depth = 1;
  let end = m.index + m[0].length;
  while (depth > 0) {
    const ch = contract[end++];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
  }
  let body = contract.slice(m.index + m[0].length, end - 1).replace(/\/\/.*$/gm, '').replace(/\/\*\*[\s\S]*?\*\//g, '');
  while (/\{[^{}]*\}/.test(body)) body = body.replace(/\{[^{}]*\}/g, 'X');
  return [...body.matchAll(/(?:^|[;\n{])\s*(\w+)\??\s*:/g)].map((x) => x[1]!);
}

const VIEWS = ['SelfView', 'OtherView', 'StatusView', 'SupportView', 'FactoryView', 'MinionView', 'WorldView'];

/** Advice phrases that used to be in player-facing text. */
const ADVICE =
  /pair a tank|make them count|two medium (units|supports)|usually beat|often beat|how you beat|spread (your units )?out|focus their|hunt their|good army|good combo|best (on|against)|mix your army|mix designs|mixing designs|aggressive (units|army)|turtle|counter or improved|for the job|juicy|all-rounder|kill the medic|strong finish|second unit|another unit|tough unit plus|tank plus|shoot (slow|standing)|easier to hit|smart units/i;

describe('no strategy hints in player-facing text', () => {
  const units = readdirSync(new URL('../packages/starter-kit/units/', import.meta.url)).map((f) => kitFile(`units/${f}`));
  const texts: Array<[string, string]> = [
    ['CLAUDE.md.tmpl', kitFile('CLAUDE.md.tmpl')],
    ['PROMPTS.md', kitFile('PROMPTS.md')],
    ['FIRST_PROMPT.md.tmpl', kitFile('FIRST_PROMPT.md.tmpl')],
    ...units.map((u, i): [string, string] => [`starter unit ${i}`, u]),
    ['unit guide', JSON.stringify(buildGuide(DEFAULT_CONFIG))],
    ['get_unit_contract', JSON.stringify(buildContract(DEFAULT_CONFIG))],
    ['get_rules', JSON.stringify(buildRules(DEFAULT_CONFIG, true))],
    ['MCP instructions', MCP_INSTRUCTIONS],
    ['warning player hints', [...WARNING_CODES.map((c) => playerHintFor(c)), SUCCESS_PLAYER_HINT].join('\n')],
  ];

  for (const [name, text] of texts) {
    it(`${name} gives no tactics`, () => {
      expect(text.match(ADVICE)?.[0] ?? null, name).toBeNull();
    });
  }

  it('the guide has no tips section', () => {
    expect(buildGuide(DEFAULT_CONFIG).sections.map((s) => s.id)).not.toContain('tips');
  });

  it('the contract notes are notes, not tips', () => {
    const notes = buildContract(DEFAULT_CONFIG).notes;
    expect(notes.some((n) => n.startsWith('Tip:'))).toBe(false);
    expect(notes.some((n) => n.startsWith('Note:'))).toBe(true);
  });
});

describe('every runtime attribute is listed for players and their AI helper', () => {
  const claudeMd = kitFile('CLAUDE.md.tmpl');
  const start = claudeMd.indexOf('### What `update()` can see');
  const section = claudeMd.slice(start, claudeMd.indexOf('## 4b.', start));

  it('CLAUDE.md has a "What update() can see" section naming every view field', () => {
    expect(start).toBeGreaterThan(-1);
    for (const view of VIEWS) {
      const fields = fieldsOf(view);
      expect(fields.length, view).toBeGreaterThan(2);
      for (const f of fields) expect(section, `${view}.${f}`).toContain(`\`${f}\``);
    }
  });

  it('the guide view section names every view field', () => {
    const view = JSON.stringify(buildGuide(DEFAULT_CONFIG).sections.find((s) => s.id === 'view'));
    for (const v of VIEWS) for (const f of fieldsOf(v)) expect(view, `${v}.${f}`).toContain(`\`${f}\``);
  });
});
