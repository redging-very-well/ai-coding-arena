// get_rules / get_unit_contract / MCP text and the kit's CLAUDE.md + PROMPTS.md
// for walls and factories (M8.5, plan §10.5, §11; numbers of the $10,000 redesign).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, computeCost, deepMerge, type CostStats } from '@pixel-clash/shared';
import { MCP_INSTRUCTIONS } from '../packages/server/src/mcp.js';
import { buildContract, buildRules, unitTypeRules } from '../packages/server/src/services/rules.js';

const kitFile = (rel: string) => readFileSync(new URL(`../packages/starter-kit/${rel}`, import.meta.url), 'utf8');

describe('get_unit_contract (M8.5)', () => {
  const contract = buildContract(DEFAULT_CONFIG);

  it('serves all four templates', () => {
    expect(Object.keys(contract.templates)).toEqual(['basic_soldier', 'basic_tower', 'basic_wall', 'basic_factory']);
    expect(contract.templates.basic_wall).toContain("this.type = 'wall'");
    expect(contract.templates.basic_factory).toContain("this.type = 'factory'");
    expect(contract.templates.basic_factory).toContain("action: 'rally'");
  });

  it('the contract, engine rules and tips mention all four types, rally/hold and blockedBy', () => {
    const text = [contract.typescript, ...contract.notes].join('\n');
    for (const word of ["'soldier'", "'tower'", "'wall'", "'factory'", "'minion'", 'rally', 'hold', 'blockedBy', 'blockedTicks', 'productionInterval']) {
      expect(text).toContain(word);
    }
    const notes = contract.notes.join('\n');
    expect(notes).toMatch(/Walls block everyone, your own units too: leave a gap/);
    expect(notes).toMatch(/worth \$0 at the end/);
    expect(notes).toMatch(/self\.blockedBy/);
    expect(notes).toMatch(/A factory pays up front for its minions/);
  });
});

describe('get_rules (M8.5)', () => {
  const rules = buildRules(DEFAULT_CONFIG);

  it('has the per-type bounds, the new caps and coefficients', () => {
    const bounds = rules.bounds as { byType: Record<string, Record<string, unknown>> };
    expect(bounds.byType.wall).toEqual({ maxHealth: { min: 400, max: 12000 } });
    expect(bounds.byType.factory).toEqual({ maxHealth: { min: 120, max: 1200 }, productionInterval: { min: 300, max: 1200 } });
    // Towers out-range soldiers.
    expect(bounds.byType.soldier).toMatchObject({ range: { min: 20, max: 160 } });
    expect(bounds.byType.tower).toMatchObject({ range: { min: 20, max: 300 } });
    expect(rules.caps).toMatchObject({ maxUnitTypes: 4, maxBuildingTypes: 4, maxCopies: 12, maxFactoryCopies: 5, maxWallCopies: 16 });
    expect(rules.caps).not.toHaveProperty('maxTypes');
    expect(rules.copyRamp).toMatchObject({ freeCopies: 3, pctPerCopy: 15 });
    expect(rules.coefficients).toMatchObject({ wall: { base: 20, hp: 0.0375 }, factory: { base: 50, hp: 0.5, minionDiscount: 0.5 } });
    expect(rules.costFormula).toMatch(/Walls: cost = /);
    expect(rules.costFormula).toMatch(/Factories: cost = /);
  });

  it('explains the types, minions, fighters and living value with the config numbers', () => {
    const t = rules.unitTypes as ReturnType<typeof unitTypeRules> & {
      types: Record<string, { group: string }>;
      factories: { minionsPerBattle: Record<string, number>; minionCost: number; minionValue: number; minion: { maxHealth: number } };
    };
    expect(Object.keys(t.types)).toEqual(['soldier', 'tower', 'wall', 'factory']);
    expect(Object.values(t.types).map((x) => x.group)).toEqual(['unit', 'building', 'building', 'building']);
    expect(t.factories.minionsPerBattle).toEqual({ 300: 12, 900: 7, 1200: 5 });
    expect(t.factories).toMatchObject({ minionCost: 353, minionValue: 177, minion: { maxHealth: 360 } });
    expect(String(t.fighters)).toContain('NO_FIGHTERS');
    expect(String(t.livingValue)).toContain('walls are worth $0');
    expect(rules.factory).toMatchObject({ maxAlivePerFactory: 4, maxMinionsPerFactory: 12, maxAlivePerPlayer: 12 });
  });

  it('lists the minion kinds with prices, the squad orders and burst (M8.6)', () => {
    const t = unitTypeRules(DEFAULT_CONFIG) as {
      types: { factory: { optional: Record<string, string>; update: string } };
      factories: {
        minionKinds: Record<string, { name: string; minionCost: number; minionValue: number; maxHealth: number; wallDamageMultiplier: number; role: string }>;
        orders: Record<string, string>;
        burst: { min: number; max: number; default: number; text: string };
      };
    };
    expect(Object.keys(t.factories.minionKinds)).toEqual(['grunt', 'archer', 'runner', 'brute', 'medic']);
    expect(t.factories.minionKinds.archer).toMatchObject({ name: 'Archer', minionCost: 432, minionValue: 216, range: 110 });
    expect(t.factories.minionKinds.runner).toMatchObject({ minionCost: 525, minionValue: 263 });
    expect(t.factories.minionKinds.brute).toMatchObject({ minionValue: 263, wallDamageMultiplier: 3 });
    // M8.8: the medic and the per-element prices (medics ignore the element).
    expect(t.factories.minionKinds.medic).toMatchObject({ name: 'Medic', minionCost: 496, minionValue: 248, damage: 0, heal: 60, reach: 60 });
    const byElement = (t.factories.minionKinds.brute as unknown as { byElement: Record<string, { minionValue: number }> }).byElement;
    expect(byElement.fire!.minionValue).toBe(342);
    expect(byElement.ice!.minionValue).toBe(460);
    expect((t.factories.minionKinds.medic as unknown as { byElement: Record<string, { minionValue: number }> }).byElement.ice!.minionValue).toBe(248);
    expect(Object.keys(t.factories.orders)).toEqual(['text', 'attack', 'defend', 'swarm', 'guard']);
    expect(t.factories.burst).toMatchObject({ min: 1, max: 4, default: 1 });
    expect(t.factories.burst.text).toMatch(/LOST if the factory is destroyed/);
    expect(t.types.factory.optional).toHaveProperty('produces');
    expect(t.types.factory.update).toContain("action: 'command'");
    const contract = buildContract(DEFAULT_CONFIG);
    expect(contract.typescript).toContain("export type MinionKind = 'grunt' | 'archer' | 'runner' | 'brute' | 'medic';");
    expect(contract.notes.some((n) => n.includes("order: 'swarm'"))).toBe(true);
  });

  it('follows a config retune (minion price and E per interval)', () => {
    const cfg = deepMerge(DEFAULT_CONFIG, { cost: { factory: { minionDiscount: 1 } }, timers: { battleTicks: 3600 } });
    const t = unitTypeRules(cfg) as { factories: { minionValue: number; minionsPerBattle: Record<string, number> } };
    expect(t.factories.minionValue).toBe(353);
    expect(t.factories.minionsPerBattle[300]).toBe(11);
    expect(t.factories.minionsPerBattle[900]).toBe(3);
  });
});

describe('MCP instructions (M8.5)', () => {
  it('name the four types in one line', () => {
    expect(MCP_INSTRUCTIONS).toMatch(/soldier, tower, wall, factory/);
  });
});

describe('starter kit text (M8.5, §11)', () => {
  const claudeMd = kitFile('CLAUDE.md.tmpl');

  it('CLAUDE.md has the 4c unit-types section with the wall and factory tips', () => {
    expect(claudeMd).toContain('## 4c. Unit types: soldier, tower, wall, factory');
    for (const tip of [
      'Walls block your own units too: leave a gap',
      '**Walls are worth $0 at the end**',
      "**Enemy walls are in `enemies`** (`enemy.type === 'wall'`)",
      "`type: 'minion'`",
      'Shots fly over walls',
      'Factory minions arrive during the battle',
      '300-599 = 12 minions, 600 = 11, 720 = 9, 900 = 7, 1200 = 5',
      'Up to **5 factories** per army',
    ]) {
      expect(claudeMd).toContain(tip);
    }
    for (const f of ['units/basic_wall.js', 'units/basic_factory.js']) expect(claudeMd).toContain(f);
  });

  it('CLAUDE.md wall and factory cost examples match computeCost', () => {
    const cases: Array<[CostStats, number]> = [
      [{ type: 'wall', maxHealth: 3200, damage: 0, range: 0, speed: 0, attackCooldown: 0 }, 149],
      [{ type: 'wall', maxHealth: 6400, damage: 0, range: 0, speed: 0, attackCooldown: 0 }, 329],
      [{ type: 'wall', maxHealth: 12000, damage: 0, range: 0, speed: 0, attackCooldown: 0 }, 920],
      [{ type: 'factory', maxHealth: 360, damage: 0, range: 0, speed: 0, attackCooldown: 0, productionInterval: 900 }, 1486],
      [{ type: 'factory', maxHealth: 360, damage: 0, range: 0, speed: 0, attackCooldown: 0, productionInterval: 600 }, 2194],
    ];
    for (const [stats, cost] of cases) {
      expect(computeCost(stats, DEFAULT_CONFIG.cost).cost).toBe(cost);
      expect(claudeMd).toContain(`$${cost.toLocaleString('en-US')}`);
    }
    expect(claudeMd).toContain(`wall:    cost = ${DEFAULT_CONFIG.cost.wall.base} + maxHealth × ${DEFAULT_CONFIG.cost.wall.hp} `);
    expect(claudeMd).toContain(`body       = ${DEFAULT_CONFIG.cost.factory.base} + maxHealth × ${DEFAULT_CONFIG.cost.factory.hp} `);
  });

  it('CLAUDE.md budget rules use the 4 + 4 type limits and the per-group copy caps', () => {
    expect(claudeMd).toContain('Up to **4 unit types** (soldiers) **and 4 building types**');
    expect(claudeMd).toContain('At most **12 fighters** placed');
    expect(claudeMd).toContain('at most **5 factories**');
    expect(claudeMd).toContain('at most **16 walls**');
    expect(claudeMd).toContain('copies of the same design beyond the 3rd cost more');
    expect(claudeMd).not.toMatch(/3 unit types|toward the 3 types/);
  });

  it('PROMPTS.md has wall and factory ideas and the new limits', () => {
    const prompts = kitFile('PROMPTS.md');
    expect(prompts).toContain('"Build me a wall to protect my towers."');
    expect(prompts).toContain('"Make a factory that sends minions to the middle."');
    expect(prompts).toContain('**4** kinds of soldiers and **4** kinds of buildings');
  });
});
