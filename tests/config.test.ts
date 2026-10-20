import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, ConfigSchema, parseConfig, safeParseConfig } from '@pixel-clash/shared';

describe('config', () => {
  it('config/default.json mirrors DEFAULT_CONFIG', () => {
    const json = JSON.parse(readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'));
    expect(json).toEqual(DEFAULT_CONFIG);
  });

  it('defaults satisfy the schema', () => {
    expect(ConfigSchema.parse(DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG);
  });

  it('partial overrides deep-merge over defaults', () => {
    const cfg = parseConfig({ cost: { base: 25 }, caps: { budget: 1200 } });
    expect(cfg.cost.base).toBe(25);
    expect(cfg.cost.hp).toBe(0.25);
    expect(cfg.caps.budget).toBe(1200);
    expect(cfg.caps.unitCost).toBe(500);
  });

  it('rejects invalid values', () => {
    expect(safeParseConfig({ cost: { hp: -1 } }).success).toBe(false);
    expect(safeParseConfig({ stats: { bounds: { damage: { min: 10, max: 5 } } } }).success).toBe(false);
    expect(safeParseConfig({ sandbox: { mode: 'yolo' } }).success).toBe(false);
  });
});

describe('unit contract (§5)', () => {
  it('the verbatim block in shared/contract.ts matches plan §5 exactly', () => {
    const plan = readFileSync(new URL('../plan.md', import.meta.url), 'utf8');
    const contract = readFileSync(new URL('../packages/shared/src/contract.ts', import.meta.url), 'utf8');
    const planBlock = plan.split('// packages/shared/src/contract.ts\n')[1]!.split('\n```')[0]!;
    const codeBlock = contract.split('// --- BEGIN CONTRACT (plan §5, verbatim) ---\n')[1]!.split('// --- END CONTRACT ---')[0]!;
    expect(codeBlock.trimEnd()).toBe(planBlock.trimEnd());
    expect(codeBlock).toContain('size?: number;');
    expect(codeBlock).toContain('sprite?(): SpriteSpec;');
  });
});
