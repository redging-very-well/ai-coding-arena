// The $10,000 redesign migration (plan §6 migration, §14 migration.test.ts):
// a stored config patch from an older economy loses its scale-sensitive
// overrides at boot (the rest is kept; a log line, no banner), and player
// units made for an older economy are WIPED at boot (user decision
// 2026-10-24: "they can be wiped"): designs, armory entries and every
// selection or placement naming them. Players, PINs and templates stay.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, ECONOMY_DROPPED, ECONOMY_VERSION, migrateConfigPatch, migrateEconomyPatch, parseConfig, safeParseConfig, type UnitCardDTO } from '@pixel-clash/shared';
import { SCALE_VERSION } from '../packages/server/src/services/store.js';
import type { RunningServer } from '../packages/server/src/server.js';
import { adminClient, bootServer, Client, newPlayer, removeDir, template, tempDataDir } from './helpers/server.js';

describe('migrateEconomyPatch (config v3)', () => {
  it('drops every scale-sensitive key of an older patch and keeps the rest, stamped with the economy version', () => {
    const old = {
      economyVersion: 2,
      cost: { curveK: 2, hp: 0.25, wall: { hp: 0.1 } },
      caps: { budget: 5000, unitCost: 2500, maxCopies: 10, maxFactoryCopies: 2 },
      stats: { bounds: { maxHealth: { min: 50, max: 2500 }, damage: { max: 300 }, range: { max: 280 }, productionInterval: { min: 600 } } },
      factory: { minions: { grunt: { maxHealth: 180, damage: 25, speed: 1.6 } }, maxAlivePerPlayer: 6, rallyGuardRadius: 210 },
      timers: { placementSec: 99, battleTicks: 5400 },
      suddenDeath: { startTick: 3000, damagePctPerSecond: 6 },
    };
    const { patch, dropped } = migrateEconomyPatch(old);
    expect(patch).toEqual({
      caps: { maxCopies: 10 },
      stats: { bounds: { range: { max: 280 } } },
      factory: { minions: { grunt: { speed: 1.6 } }, rallyGuardRadius: 210 },
      timers: { placementSec: 99 },
      suddenDeath: { damagePctPerSecond: 6 },
      economyVersion: ECONOMY_VERSION,
    });
    expect(dropped.sort()).toEqual(
      [
        'cost.curveK', 'cost.hp', 'cost.wall.hp', 'caps.budget', 'caps.unitCost', 'caps.maxFactoryCopies',
        'stats.bounds.maxHealth.min', 'stats.bounds.maxHealth.max', 'stats.bounds.damage.max', 'stats.bounds.productionInterval.min',
        'factory.minions.grunt.maxHealth', 'factory.minions.grunt.damage', 'factory.maxAlivePerPlayer',
        'timers.battleTicks', 'suddenDeath.startTick',
      ].sort(),
    );
    expect(ECONOMY_DROPPED).toContain('cost');
    // The migrated patch parses onto the $10,000 defaults.
    expect(parseConfig(patch)).toMatchObject({ caps: { budget: DEFAULT_CONFIG.caps.budget, maxCopies: 10 }, timers: { battleTicks: DEFAULT_CONFIG.timers.battleTicks } });
  });

  it('a current patch (or an empty one) is left alone; an old factory.minion becomes the grunt first (M8.6)', () => {
    const v3 = { economyVersion: ECONOMY_VERSION, cost: { base: 55 }, caps: { budget: 9000 } };
    expect(migrateEconomyPatch(v3)).toEqual({ patch: v3, dropped: [] });
    expect(migrateEconomyPatch({})).toEqual({ patch: {}, dropped: [] });
    expect(migrateEconomyPatch({ factory: { minion: { maxHealth: 40, speed: 2 } } })).toEqual({
      patch: { factory: { minions: { grunt: { speed: 2 } } }, economyVersion: ECONOMY_VERSION },
      dropped: ['factory.minions.grunt.maxHealth'],
    });
    // A plain override (parseConfig) is never migrated: it is already at the new scale.
    expect(parseConfig({ cost: { base: 55 } }).cost.base).toBe(55);
    expect(migrateConfigPatch({ cost: { base: 55 } })).toEqual({ cost: { base: 55 } });
    expect(safeParseConfig({ economyVersion: 2 }).success).toBe(false);
  });
});

describe('boot with stored data from an older economy', () => {
  let srv: RunningServer | undefined;
  const dir = tempDataDir();
  afterAll(async () => {
    await srv?.close();
    removeDir(dir);
  });

  it('wipes old player units (and what names them), keeps players and templates, and drops old config overrides', async () => {
    srv = await bootServer({ dataDir: dir });
    const admin = await adminClient(srv.url);
    const ann = await newPlayer(srv.url, 'Ann');
    await newPlayer(srv.url, 'Ben');
    expect((await admin.post('/admin/match', { rounds: 2 })).body.phase).toBe('PLAN');
    const named = (name: string) => template('basic_soldier').replace("this.name = 'Basic Soldier';", `this.name = '${name}';`);
    for (const name of ['Old Guard', 'New Guy']) expect((await ann.client.post('/units', { source: named(name) })).body.ok).toBe(true);
    const tpl = ((await ann.client.get('/units')).body as UnitCardDTO[]).find((u) => u.isTemplate)!.unitId;
    expect((await ann.client.put('/round/selection', { unitIds: ['old-guard', 'new-guy', tpl] })).status).toBe(200);
    expect((await ann.client.get('/units')).body.find((u: UnitCardDTO) => u.unitId === 'new-guy')).toMatchObject({ scaleVersion: SCALE_VERSION });
    await srv.close();
    srv = undefined;

    // Turn one of them into a $5,000-game record, and add an old config patch.
    const file = join(dir, 'state.json');
    const state = JSON.parse(readFileSync(file, 'utf8'));
    for (const d of state.designs) if (d.unitId === 'old-guard') d.versions.at(-1).scaleVersion = 2;
    state.configPatch = { economyVersion: 2, cost: { curveK: 2 }, caps: { budget: 5000 }, timers: { planLaterRoundsSec: 333 } };
    writeFileSync(file, JSON.stringify(state));

    srv = await bootServer({ dataDir: dir, port: 0 });
    const ra = new Client(srv.url);
    ra.cookies = ann.client.cookies; // players and sessions survive
    expect(srv.game.config.cost.curveK).toBe(DEFAULT_CONFIG.cost.curveK);
    expect(srv.game.config.caps.budget).toBe(DEFAULT_CONFIG.caps.budget);
    expect(srv.game.config.timers.planLaterRoundsSec).toBe(333);
    expect(srv.game.store.configPatch).toEqual({ timers: { planLaterRoundsSec: 333 }, economyVersion: ECONOMY_VERSION });

    const cards = (await ra.get('/units')).body as UnitCardDTO[];
    // Every player-made design is gone (not only the old one): the wipe is all or nothing.
    expect(cards.filter((u) => !u.isTemplate)).toEqual([]);
    expect(cards.filter((u) => u.isTemplate).length).toBeGreaterThan(0);
    expect(srv.game.round.stateOf(ann.id).selection).toEqual([tpl]);
    // No banner: nothing about it in the admin config or overview.
    const admin2 = await adminClient(srv.url);
    expect((await admin2.get('/admin/config')).body).not.toHaveProperty('economyReset');
    expect((await admin2.get('/admin/overview')).body).not.toHaveProperty('economyReset');
  }, 60_000);
});
