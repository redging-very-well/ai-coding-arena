// The M8.8 economy migration (plan §6 M8.8 migration, §14 migration.test.ts):
// a $1,000-game config patch loses its scale-sensitive overrides at boot (the
// rest is kept, the dropped keys are logged and kept for the /admin banner);
// stored designs are re-priced: below the new minimum → invalid with the ×5
// fix (and dropped from the selection), legal but old-scale → W_OLD_SCALE;
// new submits carry scaleVersion 2; templates are never flagged.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ECONOMY_V2_DROPPED, migrateConfigPatch, migrateEconomyPatch, parseConfig, safeParseConfig, type UnitCardDTO } from '@pixel-clash/shared';
import { UnitsService } from '../packages/server/src/services/units.js';
import type { RunningServer } from '../packages/server/src/server.js';
import { adminClient, bootServer, Client, newPlayer, removeDir, template, tempDataDir } from './helpers/server.js';

describe('migrateEconomyPatch (config v2)', () => {
  it('drops every scale-sensitive key of a $1,000-game patch and keeps the rest, stamped economyVersion 2', () => {
    const old = {
      cost: { curveK: 2, hp: 0.25, wall: { hp: 0.1 } },
      caps: { budget: 1000, unitCost: 500, maxCopies: 10 },
      stats: { bounds: { maxHealth: { min: 10, max: 500 }, damage: { max: 60 }, range: { max: 280 }, wallHealth: { max: 1500 }, factoryHealth: { min: 100 } } },
      factory: { minions: { grunt: { maxHealth: 40, damage: 5, speed: 1.6 } }, maxAlivePerPlayer: 5 },
      timers: { placementSec: 99 },
      suddenDeath: { startTick: 2400 },
    };
    const { patch, dropped } = migrateEconomyPatch(old);
    expect(patch).toEqual({
      caps: { maxCopies: 10 },
      stats: { bounds: { range: { max: 280 } } },
      factory: { minions: { grunt: { speed: 1.6 } }, maxAlivePerPlayer: 5 },
      timers: { placementSec: 99 },
      suddenDeath: { startTick: 2400 },
      economyVersion: 2,
    });
    expect(dropped.sort()).toEqual(
      [
        'cost.curveK', 'cost.hp', 'cost.wall.hp', 'caps.budget', 'caps.unitCost',
        'stats.bounds.maxHealth.min', 'stats.bounds.maxHealth.max', 'stats.bounds.damage.max', 'stats.bounds.wallHealth.max', 'stats.bounds.factoryHealth.min',
        'factory.minions.grunt.maxHealth', 'factory.minions.grunt.damage',
      ].sort(),
    );
    expect(ECONOMY_V2_DROPPED).toContain('cost');
    // The migrated patch parses onto the ×5 defaults.
    expect(parseConfig(patch)).toMatchObject({ caps: { budget: 5000, maxCopies: 10 }, cost: { curveK: 1 }, factory: { minions: { grunt: { maxHealth: 180, speed: 1.6 } } } });
  });

  it('a v2 patch (or an empty one) is left alone; an old factory.minion becomes the grunt first (M8.6)', () => {
    const v2 = { economyVersion: 2, cost: { base: 55 }, caps: { budget: 6000 } };
    expect(migrateEconomyPatch(v2)).toEqual({ patch: v2, dropped: [] });
    expect(migrateEconomyPatch({})).toEqual({ patch: {}, dropped: [] });
    expect(migrateEconomyPatch({ factory: { minion: { maxHealth: 40, speed: 2 } } })).toEqual({
      patch: { factory: { minions: { grunt: { speed: 2 } } }, economyVersion: 2 },
      dropped: ['factory.minions.grunt.maxHealth'],
    });
    // A plain override (parseConfig) is never migrated: it is already at the new scale.
    expect(parseConfig({ cost: { base: 55 } }).cost.base).toBe(55);
    expect(migrateConfigPatch({ cost: { base: 55 } })).toEqual({ cost: { base: 55 } });
    expect(safeParseConfig({ economyVersion: 1 }).success).toBe(false);
  });
});

describe('W_OLD_SCALE and the ×5 fix (UnitsService.checkVersion)', () => {
  const config = parseConfig({});
  const soldier = (maxHealth: number, damage: number) =>
    ({ name: 'Old', type: 'soldier', maxHealth, damage, range: 40, speed: 1.5, attackCooldown: 60, color: '#123456', size: 10, shape: 'circle' }) as const;

  it('legal and old-scale: a non-fatal W_OLD_SCALE; resubmitted (scaleVersion 2) or a template: nothing', () => {
    const r = UnitsService.checkVersion({ stats: soldier(120, 10) }, config);
    expect(r.error).toBeUndefined();
    expect(r.oldScale).toMatchObject({ code: 'W_OLD_SCALE', message: 'Made for the old game: about 5× weaker and 5× cheaper.' });
    expect(r.oldScale!.fix).toContain('maxHealth 120 → 600, damage 10 → 50');
    expect(UnitsService.checkVersion({ stats: soldier(120, 10), scaleVersion: 2 }, config).oldScale).toBeUndefined();
    expect(UnitsService.checkVersion({ stats: soldier(120, 10) }, config, { template: true }).oldScale).toBeUndefined();
    // Too big to be an old unit (HP > 500 or damage > 60): not flagged.
    expect(UnitsService.checkVersion({ stats: soldier(600, 50) }, config).oldScale).toBeUndefined();
  });

  it('below the new minimum: invalid with the ×5 fix and its price', () => {
    const r = UnitsService.checkVersion({ stats: soldier(30, 5) }, config);
    expect(r.error).toMatchObject({ code: 'STAT_OUT_OF_RANGE', field: 'maxHealth' });
    expect(r.error!.fix).toMatch(/^This unit was built for the \$1,000 game: multiply maxHealth and damage by 5 \(it would then cost \$\d+\)\./);
    const wall = UnitsService.checkVersion({ stats: { name: 'W', type: 'wall', maxHealth: 200, damage: 0, range: 0, speed: 0, attackCooldown: 0, color: '#123456', size: 20, shape: 'square' } }, config);
    expect(wall.error!.fix).toContain('multiply maxHealth and damage by 5');
  });
});

describe('boot migration with stored data', () => {
  let srv: RunningServer | undefined;
  const dir = tempDataDir();
  afterAll(async () => {
    await srv?.close();
    removeDir(dir);
  });

  it('resets old config overrides, flags old designs and drops invalid ones from the selection', async () => {
    srv = await bootServer({ dataDir: dir });
    const admin = await adminClient(srv.url);
    const ann = await newPlayer(srv.url, 'Ann');
    await newPlayer(srv.url, 'Ben');
    expect((await admin.post('/admin/match', { rounds: 2 })).body.phase).toBe('PLAN');
    const named = (name: string) => template('basic_soldier').replace("this.name = 'Basic Soldier';", `this.name = '${name}';`);
    for (const name of ['Old Guard', 'Tiny Tim', 'New Guy']) expect((await ann.client.post('/units', { source: named(name) })).body.ok).toBe(true);
    expect((await ann.client.put('/round/selection', { unitIds: ['old-guard', 'tiny-tim', 'new-guy'] })).status).toBe(200);
    expect((await ann.client.get('/units')).body.find((u: UnitCardDTO) => u.unitId === 'new-guy')).toMatchObject({ scaleVersion: 2 });
    await srv.close();
    srv = undefined;

    // Turn two of them into $1,000-game records, and add an old config patch.
    const file = join(dir, 'state.json');
    const state = JSON.parse(readFileSync(file, 'utf8'));
    for (const d of state.designs) {
      const v = d.versions.at(-1);
      if (d.unitId === 'old-guard') v.stats = { ...v.stats, maxHealth: 120, damage: 10 };
      if (d.unitId === 'tiny-tim') v.stats = { ...v.stats, maxHealth: 30, damage: 5 };
      if (d.unitId !== 'new-guy') delete v.scaleVersion;
    }
    state.configPatch = { cost: { curveK: 2, hp: 0.25 }, caps: { budget: 1000 }, timers: { planLaterRoundsSec: 333 } };
    writeFileSync(file, JSON.stringify(state));

    srv = await bootServer({ dataDir: dir, port: 0 });
    const ra = new Client(srv.url);
    ra.cookies = ann.client.cookies; // the web session survives
    expect(srv.game.config.cost).toMatchObject({ curveK: 1, hp: 0.3 });
    expect(srv.game.config.caps.budget).toBe(5000);
    expect(srv.game.config.timers.planLaterRoundsSec).toBe(333);
    expect(srv.game.store.economyReset.sort()).toEqual(['caps.budget', 'cost.curveK', 'cost.hp']);
    expect(srv.game.store.configPatch).toEqual({ timers: { planLaterRoundsSec: 333 }, economyVersion: 2 });

    const cards = (await ra.get('/units')).body as UnitCardDTO[];
    const card = (id: string) => cards.find((u) => u.unitId === id)!;
    expect(card('old-guard')).toMatchObject({ status: 'valid', scaleVersion: 1 });
    expect(card('old-guard').warnings.map((w) => w.code)).toContain('W_OLD_SCALE');
    expect(card('tiny-tim')).toMatchObject({ status: 'invalid', error: { code: 'STAT_OUT_OF_RANGE', field: 'maxHealth' } });
    expect(card('tiny-tim').error!.fix).toContain('built for the $1,000 game');
    expect(card('new-guy').warnings.map((w) => w.code)).not.toContain('W_OLD_SCALE');
    expect(cards.filter((u) => u.isTemplate).every((u) => u.status === 'valid' && !u.warnings.some((w) => w.code === 'W_OLD_SCALE'))).toBe(true);
    expect(srv.game.round.stateOf(ann.id).selection).toEqual(['old-guard', 'new-guy']);

    // The /admin banner (§10.6): GET /admin/config and the overview name the dropped keys until dismissed.
    const admin2 = await adminClient(srv.url);
    expect((await admin2.get('/admin/config')).body.economyReset.sort()).toEqual(['caps.budget', 'cost.curveK', 'cost.hp']);
    expect((await admin2.get('/admin/overview')).body.economyReset).toHaveLength(3);
    expect((await admin2.put('/admin/config', { timers: { planLaterRoundsSec: 300 } })).body.economyReset).toHaveLength(3);
    expect((await admin2.del('/admin/config/economy-reset')).body.economyReset).toEqual([]);
    expect((await admin2.get('/admin/config')).body.economyReset).toEqual([]);
    expect(srv.game.store.economyReset).toEqual([]);
    expect((await new Client(srv.url).del('/admin/config/economy-reset')).status).toBe(403);
  }, 60_000);
});
