// Walls and factories in the API (M8.5, plan §5.2, §10.5): the 4 + 4 type
// limits, the per-group copy caps, W_TRAPPED, NO_FIGHTERS in PLAN and
// PLACEMENT, auto-place around a walls-only layout, the selection fallback
// that adds a fighter, and privacy (no building data before START; the
// reveal carries the minion only after START).

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { BattleRevealDTO, GameStateDTO, PlacementResponse } from '@pixel-clash/shared';
import type { RunningServer } from '../packages/server/src/server.js';
import { Client, WsRecorder, adminClient, bootServer, namedUnit, newPlayer, removeDir, sleep, tempDataDir } from './helpers/server.js';

const T = 60_000;

let srv: RunningServer | undefined;
let dir: string | undefined;

afterEach(async () => {
  await srv?.close();
  if (dir) removeDir(dir);
  srv = undefined;
  dir = undefined;
});

async function boot(opts: Parameters<typeof bootServer>[0] = {}) {
  dir = tempDataDir();
  srv = await bootServer({ dataDir: dir, ...opts });
  return srv;
}

const kit = (file: string) => readFileSync(new URL(`../packages/starter-kit/units/${file}`, import.meta.url), 'utf8');
const renamed = (file: string, from: string, to: string) => kit(file).replace(`this.name = '${from}'`, `this.name = '${to}'`);
const state = async (c: Client) => (await c.get<GameStateDTO>('/state')).body;
const pick = (c: Client, ids: string[]) => c.put('/round/selection', { unitIds: ids });
const ready = (c: Client, r: boolean) => c.post('/round/ready', { ready: r });
const place = (c: Client, placements: Array<{ unitId: string; col: number; row: number }>) => c.put('/round/placement', { placements });
const cells = (unitId: string, list: Array<[number, number]>) => list.map(([col, row]) => ({ unitId, col, row }));

async function submit(c: Client, source: string): Promise<string> {
  const r = await c.post('/units', { source });
  if (r.status !== 200) throw new Error(`submit: ${r.status} ${r.text}`);
  return r.body.unitId as string;
}

describe('selection: up to 4 unit types AND 4 building types (§5.2)', () => {
  it('accepts 4 + 4 and rejects a 5th of either group with details.group', async () => {
    const s = await boot();
    const a = await newPlayer(s.url, 'Ann');
    await newPlayer(s.url, 'Ben');
    const admin = await adminClient(s.url);
    await admin.post('/admin/match', { rounds: 1 });
    const soldiers = ['basic-soldier'];
    for (const n of ['Tank One', 'Tank Two', 'Tank Three', 'Tank Four']) soldiers.push(await submit(a.client, namedUnit(n)));
    const buildings = ['basic-tower', 'basic-wall', 'basic-factory'];
    buildings.push(await submit(a.client, renamed('basic_wall.js', 'Basic Wall', 'Moat Wall')));
    buildings.push(await submit(a.client, renamed('basic_tower.js', 'Basic Tower', 'Spire')));

    const ok = await pick(a.client, [...soldiers.slice(0, 4), ...buildings.slice(0, 4)]);
    expect(ok.body.error).toBeUndefined();
    expect(ok.body.selection).toHaveLength(8);

    const units = await pick(a.client, [...soldiers, 'basic-wall']);
    expect(units.status).toBe(400);
    expect(units.body.error).toMatchObject({ code: 'TOO_MANY_TYPES', details: { group: 'units', max: 4, count: 5 } });

    const builds = await pick(a.client, ['basic-soldier', ...buildings]);
    expect(builds.body.error).toMatchObject({ code: 'TOO_MANY_TYPES', details: { group: 'buildings', max: 4, count: 5 } });

    // Unit cards carry the group so the page can show two pick limits.
    const roster = (await a.client.get('/units')).body as Array<{ unitId: string; group: string }>;
    expect(roster.find((u) => u.unitId === 'moat-wall')?.group).toBe('building');
    expect(roster.find((u) => u.unitId === 'tank-one')?.group).toBe('unit');
  }, T);
});

describe('a picked design revised into the other group (§5.2 type caps)', () => {
  it('Ready is refused with TOO_MANY_TYPES and a toast says why; un-picking fixes it', async () => {
    const s = await boot();
    const a = await newPlayer(s.url, 'Ann');
    await newPlayer(s.url, 'Ben');
    const admin = await adminClient(s.url);
    const ws = await WsRecorder.open(s.url, 'player', a.client.cookieHeader());
    try {
      await admin.post('/admin/match', { rounds: 1 });
      const tee = await submit(a.client, namedUnit('Tee'));
      const ess = await submit(a.client, namedUnit('Ess'));
      // 4 buildings + 3 soldiers; then 'Ess' comes back as a tower: 5 buildings.
      await submit(a.client, renamed('basic_wall.js', 'Basic Wall', 'Moat'));
      expect((await pick(a.client, ['basic-tower', 'basic-wall', 'basic-factory', 'moat', tee, ess])).body.error).toBeUndefined();
      const toast = ws.next((m) => m.type === 'toast' && m.message.includes('5 buildings'));
      expect(await submit(a.client, renamed('basic_tower.js', 'Basic Tower', 'Ess'))).toBe(ess);
      expect(((await toast) as { message: string }).message).toBe('You picked 5 buildings; 4 max. Tap one to un-pick it.');

      const r = await ready(a.client, true);
      expect(r.body.error).toMatchObject({ code: 'TOO_MANY_TYPES', message: 'You picked 5 buildings; 4 max. Tap one to un-pick it.', details: { group: 'buildings', max: 4, count: 5 } });
      // Un-picking is always allowed (even a soldier, while still over the building cap)...
      expect((await pick(a.client, ['basic-tower', 'basic-wall', 'basic-factory', 'moat', ess])).body.error).toBeUndefined();
      expect((await ready(a.client, true)).body.error?.code).toBe('TOO_MANY_TYPES');
      // ...but adding to an over-cap selection is not.
      expect((await pick(a.client, ['basic-tower', 'basic-wall', 'basic-factory', 'moat', ess, tee, 'basic-soldier'])).body.error?.code).toBe('TOO_MANY_TYPES');
      // Un-pick a building: Ready works.
      expect((await pick(a.client, ['basic-tower', 'basic-factory', 'moat', ess])).body.error).toBeUndefined();
      expect((await ready(a.client, true)).body).toEqual({ ready: true });
    } finally {
      ws.close();
    }
  }, T);

  it('left over the cap at PLAN lock: the later pick is left out and the player is told', async () => {
    const s = await boot();
    const a = await newPlayer(s.url, 'Ann');
    const b = await newPlayer(s.url, 'Ben');
    const admin = await adminClient(s.url);
    const ws = await WsRecorder.open(s.url, 'player', a.client.cookieHeader());
    try {
      await admin.post('/admin/match', { rounds: 1 });
      await submit(a.client, renamed('basic_wall.js', 'Basic Wall', 'Moat'));
      const ess = await submit(a.client, namedUnit('Ess'));
      await pick(a.client, ['basic-tower', 'basic-wall', 'basic-factory', 'moat', 'basic-soldier', ess]);
      await submit(a.client, renamed('basic_tower.js', 'Basic Tower', 'Ess'));
      await pick(b.client, ['basic-soldier']);
      const told = ws.next((m) => m.type === 'toast' && m.message.includes("isn't in your army"));
      await admin.post('/admin/phase/next'); // → PLACEMENT (lock)
      expect(((await told) as { message: string }).message).toBe("Ess isn't in your army this round: 4 buildings max.");
      expect(s.game.round.lockedDesigns(a.id).map((d) => d.unitId).sort()).toEqual(['basic-factory', 'basic-soldier', 'basic-tower', 'basic-wall', 'moat']);
    } finally {
      ws.close();
    }
  }, T);
});

describe('NO_FIGHTERS (§5.2 Fighters)', () => {
  it('PLAN Ready needs a soldier, tower or factory; walls alone are refused', async () => {
    const s = await boot();
    const a = await newPlayer(s.url, 'Ann');
    await newPlayer(s.url, 'Ben');
    const admin = await adminClient(s.url);
    await admin.post('/admin/match', { rounds: 1 });
    await pick(a.client, ['basic-wall']);
    const r = await ready(a.client, true);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('NO_FIGHTERS');
    expect(r.body.error.message).toContain("Walls can't win on their own");
    await pick(a.client, ['basic-wall', 'basic-factory']);
    expect((await ready(a.client, true)).body).toEqual({ ready: true });
  }, T);

  it('PLACEMENT Ready with only walls placed is refused; Force start adds fighters next to the walls', async () => {
    const s = await boot();
    const a = await newPlayer(s.url, 'Ann');
    const b = await newPlayer(s.url, 'Ben');
    const admin = await adminClient(s.url);
    await admin.post('/admin/match', { rounds: 1 });
    await pick(a.client, ['basic-wall', 'basic-soldier']);
    await pick(b.client, ['basic-soldier']);
    await admin.post('/admin/phase/next'); // → PLACEMENT
    const walls = cells('basic-wall', [[0, 0], [1, 0], [2, 0]]);
    expect((await place(a.client, walls)).status).toBe(200);
    const r = await ready(a.client, true);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('NO_FIGHTERS');

    const start = await admin.post('/admin/start', { force: true });
    expect(start.body.phase).toBe('BATTLE');
    const placed = s.game.round.stateOf(a.id).placements;
    // The walls stay where Ann put them, and soldiers fill free cells.
    for (const w of walls) expect(placed).toContainEqual(w);
    const soldiers = placed.filter((p) => p.unitId === 'basic-soldier');
    expect(soldiers.length).toBeGreaterThan(0);
    for (const p of soldiers) expect(walls.some((w) => w.col === p.col && w.row === p.row)).toBe(false);
    expect(s.game.round.spent(a.id)).toBeLessThanOrEqual(1000);
  }, T);

  it('the selection fallback adds a starter fighter to a walls-only pick', async () => {
    const s = await boot();
    const a = await newPlayer(s.url, 'Ann');
    await newPlayer(s.url, 'Ben');
    const admin = await adminClient(s.url);
    await admin.post('/admin/match', { rounds: 1 });
    await pick(a.client, ['basic-wall']);
    await admin.post('/admin/phase/next'); // → PLACEMENT (selections lock)
    expect((await state(a.client)).me!.selection).toEqual(['basic-wall', 'basic-soldier']);
  }, T);
});

describe('placement: copy caps per group and W_TRAPPED (§5.2 Copies, §9.3)', () => {
  it('≤ 12 fighters, ≤ 2 factories, ≤ 12 walls; counts and W_TRAPPED in the result', async () => {
    const s = await boot();
    const a = await newPlayer(s.url, 'Ann');
    const b = await newPlayer(s.url, 'Ben');
    const admin = await adminClient(s.url);
    await admin.post('/admin/match', { rounds: 1 });
    await pick(a.client, ['basic-soldier', 'basic-wall', 'basic-factory']);
    await pick(b.client, ['basic-soldier']);
    await admin.post('/admin/phase/next'); // → PLACEMENT
    expect((await state(a.client)).me!.copyCaps).toEqual({ fighters: 12, factories: 2, walls: 12 });

    const all: Array<[number, number]> = [];
    for (let row = 0; row < 6; row++) for (let col = 0; col < 6; col++) all.push([col, row]);

    // 13 walls: over the wall cap (checked before the budget).
    const tooManyWalls = await place(a.client, cells('basic-wall', all.slice(0, 13)));
    expect(tooManyWalls.body.error).toMatchObject({ code: 'TOO_MANY_COPIES', details: { group: 'walls', max: 12 } });

    // 13 fighters.
    const tooManyFighters = await place(a.client, cells('basic-soldier', all.slice(0, 13)));
    expect(tooManyFighters.body.error).toMatchObject({ code: 'TOO_MANY_COPIES', details: { group: 'fighters', max: 12 } });

    // A 3rd factory.
    const tooManyFactories = await place(a.client, cells('basic-factory', all.slice(0, 3)));
    expect(tooManyFactories.body.error).toMatchObject({ code: 'TOO_MANY_COPIES', details: { group: 'factories', max: 2 } });

    // 12 walls + 6 soldiers is fine: walls don't use fighter slots.
    const fine = await place(a.client, [...cells('basic-wall', all.slice(0, 12)), ...cells('basic-soldier', all.slice(12, 18))]);
    expect(fine.status).toBe(200);
    const body = fine.body as PlacementResponse;
    expect(body.counts).toEqual({ fighters: 6, factories: 0, walls: 12 });
    expect(body.spent).toBe(12 * 32 + 6 * 92);
    expect(body.warnings).toEqual([]);

    // A soldier boxed in by four walls: placed, with a W_TRAPPED warning.
    const boxed = await place(a.client, [
      ...cells('basic-wall', [[1, 2], [3, 2], [2, 1], [2, 3]]),
      ...cells('basic-soldier', [[2, 2], [5, 5]]),
      ...cells('basic-factory', [[0, 5]]),
    ]);
    expect(boxed.status).toBe(200);
    expect((boxed.body as PlacementResponse).warnings).toEqual([
      { code: 'W_TRAPPED', unitId: 'basic-soldier', col: 2, row: 2, message: 'Your Basic Soldier is walled in! Leave a gap so it can get out.' },
    ]);
    expect((boxed.body as PlacementResponse).counts).toEqual({ fighters: 3, factories: 1, walls: 4 });
    // Placed anyway (a warning, not an error), and Ready works: there are fighters.
    expect((await ready(a.client, true)).body).toEqual({ ready: true });
  }, T);
});

describe('privacy with walls and factories (§3)', () => {
  it('no wall or factory data leaks before START; the reveal carries the minion only from START', async () => {
    const s = await boot({ playbackRate: 1, config: { timers: { battleTicks: 1200 }, suddenDeath: { startTick: 900, endTick: 1200 } } });
    const alice = await newPlayer(s.url, 'Alice');
    const bob = await newPlayer(s.url, 'Bob');
    const admin = await adminClient(s.url);
    const wsBob = await WsRecorder.open(s.url, 'player', bob.client.cookieHeader());
    const wsScreen = await WsRecorder.open(s.url, 'screen');
    try {
      await admin.post('/admin/match', { rounds: 1 });
      const wallId = await submit(alice.client, renamed('basic_wall.js', 'Basic Wall', 'Secret Moat'));
      const facId = await submit(alice.client, renamed('basic_factory.js', 'Basic Factory', 'Hidden Forge'));
      await pick(alice.client, [wallId, facId, 'basic-soldier']);
      await pick(bob.client, ['basic-soldier']);
      await admin.post('/admin/phase/next'); // → PLACEMENT
      await place(alice.client, [...cells(wallId, [[0, 0], [1, 0]]), ...cells(facId, [[2, 3]]), ...cells('basic-soldier', [[3, 3]])]);
      await place(bob.client, cells('basic-soldier', [[0, 0]]));
      await sleep(100);
      const secret = ['Secret Moat', 'secret-moat', 'Hidden Forge', 'hidden-forge', 'productionInterval', '"minion"'];
      const leaks = (text: string) => secret.filter((w) => text.includes(w));
      const bobState = await state(bob.client);
      expect(leaks(JSON.stringify({ ...bobState, me: undefined }))).toEqual([]);
      expect(leaks(JSON.stringify(await state(new Client(s.url))))).toEqual([]);
      // Bob's own roster has the Basic Factory template (with its
      // productionInterval): only Alice's designs must not reach him.
      expect(leaks(wsBob.raw.join('\n')).filter((w) => w !== 'productionInterval')).toEqual([]);
      expect(leaks(wsScreen.raw.join('\n'))).toEqual([]);
      for (const ws of [wsBob, wsScreen]) {
        expect(ws.messages.some((m) => m.type === 'battle:reveal')).toBe(false);
      }

      const reveal = wsScreen.next((m) => m.type === 'battle:reveal');
      expect((await admin.post('/admin/start', { force: true })).body.phase).toBe('BATTLE');
      const r = ((await reveal) as { data: BattleRevealDTO }).data;
      expect(r.minion).toMatchObject({ value: 28, stats: { type: 'minion', maxHealth: 40 } });
      const a = r.players.find((p) => p.playerId === alice.id)!;
      expect(a.units.map((u) => u.stats.type).sort()).toEqual(['factory', 'soldier', 'wall']);
      expect(a.units.find((u) => u.unitId === facId)!.stats.productionInterval).toBe(900);
      // The factory's body price under the live config (the /screen bars count body + minions it can still make).
      expect(a.units.find((u) => u.unitId === facId)!.bodyCost).toBe(53);
      expect(a.units.find((u) => u.unitId === 'basic-soldier')!.bodyCost).toBeUndefined();
    } finally {
      wsBob.close();
      wsScreen.close();
    }
  }, T);
});

describe('autoPlace with buildings (§9 Auto-place, M8.5)', () => {
  it('never places walls, puts factories last, and fills fighters around a walls-only layout', async () => {
    const { autoPlace } = await import('../packages/server/src/sim/autoPlace.js');
    const caps = { budget: 1000, maxCopies: 12, maxUnitTypes: 4, maxBuildingTypes: 4, maxFactoryCopies: 2, maxWallCopies: 12 };
    const available = [
      { unitId: 'wall', cost: 32, type: 'wall' as const },
      { unitId: 'fac', cost: 193, type: 'factory' as const },
      { unitId: 'sol', cost: 92, type: 'soldier' as const },
    ];
    const fresh = autoPlace({ available, caps });
    expect(fresh.placements.some((p) => p.unitId === 'wall')).toBe(false);
    expect(fresh.placements[0]!.unitId).toBe('sol');
    expect(fresh.spent).toBeLessThanOrEqual(1000);

    const walls = [{ unitId: 'wall', col: 0, row: 0 }, { unitId: 'wall', col: 1, row: 0 }];
    const filled = autoPlace({ available, caps, existing: walls });
    expect(filled.source).toBe('fill');
    expect(filled.placements.slice(0, 2)).toEqual(walls);
    const rest = filled.placements.slice(2);
    expect(rest.length).toBeGreaterThan(0);
    expect(rest.every((p) => p.unitId !== 'wall' && !(p.row === 0 && p.col < 2))).toBe(true);
    expect(filled.spent).toBe(64 + rest.reduce((s, p) => s + (p.unitId === 'sol' ? 92 : 193), 0));
    expect(filled.spent).toBeLessThanOrEqual(1000);

    // No fighter fits next to the walls: they are dropped and the layout starts over.
    const pricey = autoPlace({ available, caps: { ...caps, budget: 100 }, existing: [{ unitId: 'wall', col: 0, row: 0 }] });
    expect(pricey.placements).toEqual([{ unitId: 'sol', col: 0, row: 0 }]);
  });
});

describe('battle report per type (§10.5)', () => {
  it('credits minions to their factory type and hints at soldiers stuck behind walls', async () => {
    const { buildBattleReport } = await import('../packages/server/src/sim/engine.js');
    const base = { playerId: 'p1', cost: 0, hp: 1, diedAtTick: null, kills: 0, valueDestroyed: 0, strikes: 0, disabled: false, errors: [] };
    const result = {
      endTick: 1000,
      endReason: 'timeout' as const,
      players: [],
      ranking: [],
      units: [
        { ...base, instanceId: '0-0-0', unitId: 'ninja', unitName: 'Ninja', type: 'soldier' as const, survived: true, damageDealt: 50, blockedTicksMax: 400 },
        { ...base, instanceId: '0-0-1', unitId: 'ninja', unitName: 'Ninja', type: 'soldier' as const, survived: false, damageDealt: 10, blockedTicksMax: 20 },
        { ...base, instanceId: '0-0-2', unitId: 'forge', unitName: 'Forge', type: 'factory' as const, survived: true, damageDealt: 0, factory: { bodyCost: 53, minionValue: 28, minionsLeft: 2, minionsMade: 3, minionsLost: 1 } },
        { ...base, instanceId: '0-0-2-m1', unitId: 'forge', unitName: 'Minion', type: 'minion' as const, factoryId: '0-0-2', survived: true, damageDealt: 12.4, kills: 1 },
        { ...base, instanceId: '0-0-3', unitId: 'moat', unitName: 'Moat', type: 'wall' as const, survived: true, damageDealt: 0 },
        { ...base, playerId: 'p2', instanceId: '1-0-0', unitId: 'other', unitName: 'Other', type: 'soldier' as const, survived: true, damageDealt: 99 },
      ],
    };
    const r = buildBattleReport(result as never, 'p1', 1);
    expect(r.survived).toBe(3); // minions are not placed units
    expect(r.types).toEqual([
      { unitId: 'ninja', name: 'Ninja', type: 'soldier', fielded: 2, survived: 1, damageDealt: 60, kills: 0, blockedTicksMax: 400 },
      { unitId: 'forge', name: 'Forge', type: 'factory', fielded: 1, survived: 1, damageDealt: 12, kills: 1, minionsMade: 3, minionsLost: 1, minionDamage: 12 },
      { unitId: 'moat', name: 'Moat', type: 'wall', fielded: 1, survived: 1, damageDealt: 0, kills: 0 },
    ]);
    expect(r.hints).toEqual(['Your Ninja got stuck behind walls a lot. Ask Claude to make it break through (attack self.blockedBy) or go round.']);
  });
});
