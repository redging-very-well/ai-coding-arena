// The unit guide: kept in
// sync with the contract (every UnitType, stat field, action, element,
// support kind, minion kind/order and view field appears), live example
// prices equal computeCost under the current config, a retune changes the
// numbers, the public endpoint, and the client's search/markup helpers.

import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  ELEMENTS,
  GUIDE_SECTION_IDS,
  MINION_KINDS,
  MINION_ORDERS,
  STAT_FIELDS,
  SUPPORT_KINDS,
  UNIT_TYPES,
  computeCost,
  money,
  parseConfig,
  pricingOf,
  type GameConfig,
  type GuideBlockDTO,
  type GuideDTO,
  type GuideSectionDTO,
} from '@pixel-clash/shared';
import { buildGuide } from '../packages/server/src/services/guide.js';
import type { RunningServer } from '../packages/server/src/server.js';
import { guideUrl, highlightParts, parseInline, plainText, searchGuide, visibleRows } from '../packages/client/src/guide/logic.js';
import { Client, FAST_CONFIG, adminClient, bootServer, removeDir, tempDataDir } from './helpers/server.js';

const T = 60_000;

/** The verbatim contract block of packages/shared/src/contract.ts. */
const contract = (() => {
  const src = readFileSync(new URL('../packages/shared/src/contract.ts', import.meta.url), 'utf8');
  return src.slice(src.indexOf('// --- BEGIN CONTRACT'), src.indexOf('// --- END CONTRACT ---'));
})();

/** The string literals of `export type Name = 'a' | 'b' …;`. */
function literalsOf(typeName: string): string[] {
  const m = new RegExp(`export type ${typeName} = ([^;]+);`).exec(contract);
  if (!m) throw new Error(`no type ${typeName} in the contract`);
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

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

const section = (g: GuideDTO, id: string) => g.sections.find((s) => s.id === id)!;
const tables = (s: GuideSectionDTO) => s.blocks.filter((b): b is Extract<GuideBlockDTO, { kind: 'table' }> => b.kind === 'table');
const tableByCaption = (s: GuideSectionDTO, start: string) => tables(s).find((t) => (t.caption ?? '').startsWith(start))!;
const firstCells = (t: Extract<GuideBlockDTO, { kind: 'table' }>) => t.rows.map((r) => r[0] ?? '');
const allText = (g: GuideDTO) => JSON.stringify(g.sections);

describe('the unit guide follows the contract', () => {
  const g = buildGuide(DEFAULT_CONFIG);
  const text = allText(g);

  it('has every section, in order', () => {
    expect(g.sections.map((s) => s.id)).toEqual([...GUIDE_SECTION_IDS]);
    for (const s of g.sections) expect(s.blocks.length, s.id).toBeGreaterThan(0);
  });

  it('names every UnitType, minion kind, order, element and support kind', () => {
    expect(literalsOf('UnitType')).toEqual([...UNIT_TYPES]);
    for (const t of literalsOf('UnitType')) expect(text).toContain(`\`type: '${t}'\``);
    expect(text).toContain("`type: 'minion'`");
    expect(literalsOf('MinionKind')).toEqual([...MINION_KINDS]);
    expect(firstCells(tableByCaption(section(g, 'factories'), 'Minion kinds'))).toEqual(MINION_KINDS.map((k) => `\`'${k}'\``));
    expect(literalsOf('MinionOrder')).toEqual([...MINION_ORDERS]);
    expect(firstCells(tableByCaption(section(g, 'factories'), 'Squad orders'))).toEqual(MINION_ORDERS.map((o) => `\`'${o}'\``));
    expect(literalsOf('Element')).toEqual([...ELEMENTS]);
    const elements = tables(section(g, 'elements'))[0]!;
    for (const e of ELEMENTS) expect(firstCells(elements).some((c) => c.endsWith(`\`'${e}'\``)), e).toBe(true);
    expect(literalsOf('SupportKind')).toEqual([...SUPPORT_KINDS]);
    const support = tables(section(g, 'support'))[0]!;
    for (const k of SUPPORT_KINDS) expect(firstCells(support).some((c) => c.endsWith(`\`'${k}'\``)), k).toBe(true);
    for (const combo of ['Shatter', 'Overload', 'Splash']) expect(text).toContain(combo);
  });

  it('explains every stat field for the types that use it', () => {
    const fields = fieldsOf('UnitStats');
    expect(new Set(fields)).toEqual(new Set(STAT_FIELDS));
    const stats = section(g, 'stats');
    const seen = new Set(tables(stats).flatMap((t) => firstCells(t)));
    for (const f of fields) expect(seen.has(`\`${f}\``), f).toBe(true);
    // Per type: walls never list damage, factories list productionInterval, soldiers list speed.
    const byType = (t: string) => firstCells(tables(stats).find((x) => (x.caption ?? '').endsWith(t[0]!.toUpperCase() + t.slice(1)))!);
    expect(byType('wall')).not.toContain('`damage`');
    expect(byType('factory')).toContain('`productionInterval`');
    expect(byType('factory')).toContain('`burst`');
    expect(byType('soldier')).toContain('`speed`');
    expect(byType('soldier')).not.toContain('`produces`');
  });

  it('lists every action update() can return', () => {
    const union = contract.slice(contract.indexOf('export type Action ='), contract.indexOf('export interface Unit '));
    const actions = [...new Set([...union.matchAll(/action: '(\w+)'/g)].map((m) => m[1]!))];
    expect(actions.length).toBeGreaterThanOrEqual(8);
    const rows = firstCells(tables(section(g, 'actions'))[0]!);
    expect(rows).toEqual(actions.map((a) => `\`'${a}'\``));
  });

  it('describes every field of every view', () => {
    const view = section(g, 'view');
    const views: Array<[string, string]> = [
      ['SelfView', 'self'],
      ['OtherView', 'each enemy'],
      ['StatusView', 'status'],
      ['SupportView', 'support'],
      ['FactoryView', 'self.factory'],
      ['WorldView', 'world'],
    ];
    for (const [iface, caption] of views) {
      const fields = fieldsOf(iface);
      expect(fields.length, iface).toBeGreaterThan(2);
      expect(firstCells(tableByCaption(view, caption)), iface).toEqual(fields.map((f) => `\`${f}\``));
    }
    for (const word of ['pathing', 'blockedBy', 'healRoom', 'burning', 'frozen', 'haste', 'might', 'shield']) expect(text).toContain(word);
    // The exact contract is in a "For Claude / code" box.
    expect(view.blocks.some((b) => b.kind === 'code' && b.code.includes('export interface SelfView'))).toBe(true);
  });

  it('speaks to players, never "kids"', () => {
    expect(text.toLowerCase()).not.toMatch(/\bkids?\b/);
  });
});

describe('live example prices', () => {
  const check = (config: GameConfig) => {
    const g = buildGuide(config);
    expect(g.examples.length).toBeGreaterThanOrEqual(6);
    const rows = tableByCaption(section(g, 'cost'), 'Live example prices').rows;
    for (const [i, e] of g.examples.entries()) {
      const cost = computeCost(e.stats, config.cost, pricingOf(config)).cost;
      expect(e.cost, e.name).toBe(cost);
      expect(e.overCap, e.name).toBe(cost > config.caps.unitCost);
      expect(rows[i]![3], e.name).toContain(money(cost));
    }
    // Something shows why maxing is pricier: the maxed example is over the cap.
    expect(g.examples.find((e) => e.id === 'maxed')?.overCap).toBe(true);
    return g;
  };

  it('equal computeCost under the default config', () => {
    check(DEFAULT_CONFIG);
  });

  it('equal computeCost under a retuned config (archetypes stay inside the bounds)', () => {
    const tuned = parseConfig({ cost: { base: 80, curveK: 0.5, element: { fire: 1.4 } }, stats: { bounds: { range: { min: 20, max: 200 } } } });
    const g = check(tuned);
    for (const e of g.examples) expect(e.stats.range, e.name).toBeLessThanOrEqual(200);
  });
});

describe('a config retune changes the guide', () => {
  it('changes the stamp, the prices, the bounds and the budget', () => {
    const before = buildGuide(DEFAULT_CONFIG);
    expect(buildGuide(DEFAULT_CONFIG)).toBe(before); // memoized on the config object
    const tuned = parseConfig({ cost: { base: 80 }, caps: { budget: 6000 }, stats: { bounds: { damage: { min: 0, max: 250 } } }, elements: { ice: { slowPct: 50 } } });
    const after = buildGuide(tuned);
    expect(after.stamp).not.toBe(before.stamp);
    expect(after.examples.map((e) => e.cost)).not.toEqual(before.examples.map((e) => e.cost));
    expect(allText(before)).toContain('$10,000');
    expect(allText(after)).toContain('**$6,000**');
    expect(allText(after)).toContain('0-250 (required)');
    expect(allText(before)).toContain('0-240 (required)');
    expect(allText(after)).toContain('50% slower');
  });
});

describe('GET /api/guide', () => {
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

  it('is public, prices the templates live and follows an admin retune', async () => {
    const c = new Client(srv.url);
    const res = await c.get('/guide');
    expect(res.status).toBe(200);
    const g = res.body as GuideDTO;
    const templates = g.examples.filter((e) => e.group === 'template');
    expect(templates.map((t) => t.name)).toEqual(['Basic Soldier', 'Basic Tower', 'Basic Wall', 'Basic Factory']);
    // The same price a player sees on the template card.
    const live = parseConfig(FAST_CONFIG); // the server's config (short battles: cheaper factories)
    for (const t of templates) expect(t.cost, t.name).toBe(computeCost(t.stats, live.cost, pricingOf(live)).cost);
    expect(templates[0]!.cost).toBeGreaterThan(0);

    const admin = await adminClient(srv.url);
    expect((await admin.put('/admin/config', { cost: { base: 0 } })).status).toBe(200);
    const after = (await c.get('/guide')).body as GuideDTO;
    expect(after.stamp).not.toBe(g.stamp);
    expect(after.examples[0]!.cost).toBeLessThan(templates[0]!.cost);
    await admin.put('/admin/config', { cost: { base: 50 } });
  }, T);
});

describe('guide client helpers', () => {
  const g = buildGuide(DEFAULT_CONFIG);

  it('parses `code` and **bold**', () => {
    expect(parseInline('a `b` **c** d')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'code', text: 'b' },
      { kind: 'text', text: ' ' },
      { kind: 'bold', text: 'c' },
      { kind: 'text', text: ' d' },
    ]);
    expect(plainText('`x` and **y**')).toBe('x and y');
    expect(parseInline('a `b')).toEqual([{ kind: 'text', text: 'a `b' }]);
  });

  it('filters sections and highlights matches', () => {
    const none = searchGuide(g, '');
    expect(none.total).toBe(0);
    const splash = searchGuide(g, '  SPLASH ');
    expect(splash.query).toBe('splash');
    expect(splash.hits.elements).toBeGreaterThan(0);
    expect(splash.hits.cost).toBeGreaterThan(0);
    expect(searchGuide(g, 'zzqqxx').total).toBe(0);
    expect(highlightParts('Fire hits Fire', 'fire')).toEqual([
      { text: 'Fire', hit: true },
      { text: ' hits ', hit: false },
      { text: 'Fire', hit: true },
    ]);
  });

  it('shows only matching table rows unless the heading matches', () => {
    const t = tableByCaption(section(g, 'factories'), 'Minion kinds');
    expect(visibleRows(t, 'brute', false).map((r) => r[0])).toEqual(["`'brute'`"]);
    expect(visibleRows(t, 'brute', true)).toHaveLength(t.rows.length);
    expect(visibleRows(t, '', false)).toHaveLength(t.rows.length);
  });

  it('links a section in the standalone page', () => {
    expect(guideUrl('cost')).toBe('/guide#cost');
    expect(guideUrl(null)).toBe('/guide');
  });
});
