// Unit file layout (kit "File layout" rule): the player reads these files, so
// the constructor comes first and the pixel art last. The starter templates
// (which Claude and Codex copy from) must follow the rule themselves.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const UNITS = join(__dirname, '../packages/starter-kit/units');
const TEMPLATES = readdirSync(UNITS).filter((f) => f.endsWith('.js'));

describe('starter unit file layout', () => {
  it.each(TEMPLATES)('%s: at most a one-line comment, then the class with the constructor first', (file) => {
    const lines = readFileSync(join(UNITS, file), 'utf8').split('\n');
    const classLine = lines.findIndex((l) => l.startsWith('export default class'));
    expect(classLine).toBeGreaterThan(-1);
    // Above the class: only comments and blank lines, and only a short title.
    const above = lines.slice(0, classLine);
    expect(above.every((l) => l.trim() === '' || l.trim().startsWith('//'))).toBe(true);
    expect(above.filter((l) => l.trim().startsWith('//')).length).toBeLessThanOrEqual(2);
    // The first member of the class is the constructor.
    const firstMember = lines.slice(classLine + 1).find((l) => /^ {2}\S/.test(l));
    expect(firstMember?.trim().startsWith('constructor(')).toBe(true);
  });

  it.each(TEMPLATES)('%s: sprite() is the last method, after update()', (file) => {
    const src = readFileSync(join(UNITS, file), 'utf8');
    const sprite = src.indexOf('\n  sprite()');
    expect(sprite).toBeGreaterThan(-1);
    const update = src.indexOf('\n  update(');
    if (update !== -1) expect(update).toBeLessThan(sprite);
    // No other method after sprite().
    const afterSprite = src.slice(sprite + 1);
    expect(afterSprite.split('\n').slice(1).some((l) => /^ {2}[A-Za-z_$][\w$]*\s*\(/.test(l))).toBe(false);
  });

  it('the kit tells the AI helper about the layout', () => {
    const kit = readFileSync(join(__dirname, '../packages/starter-kit/CLAUDE.md.tmpl'), 'utf8');
    expect(kit).toContain('File layout');
    expect(kit).toMatch(/constructor first/);
    expect(kit).toMatch(/inside `sprite\(\)`/);
  });
});
