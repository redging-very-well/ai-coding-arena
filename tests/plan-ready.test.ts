// PLAN Ready (plan §3, §10.2, §10.3): players say "my army is picked" in PLAN.
// Gates, NOTHING_SELECTED, clearing on a changed army (selection, own submit),
// the reset on every phase change, the public `allReady` flag with benched and
// kicked players, and the optional auto-advance (timers.autoAdvanceWhenAllReady)
// with its cancel. PLAN Next is never gated on Ready.

import { afterEach, describe, expect, it } from 'vitest';
import type { GameStateDTO } from '@pixel-clash/shared';
import type { RunningServer } from '../packages/server/src/server.js';
import { Client, adminClient, bootServer, namedUnit, newPlayer, removeDir, tempDataDir, waitForState } from './helpers/server.js';

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

const state = async (c: Client) => (await c.get<GameStateDTO>('/state')).body;
const ready = (c: Client, r: boolean) => c.post('/round/ready', { ready: r });
const pick = (c: Client, ids: string[]) => c.put('/round/selection', { unitIds: ids });

describe('PLAN Ready', () => {
  it('opens Ready in PLAN, needs a selection, and resets on every phase change', async () => {
    const s = await boot();
    const a = await newPlayer(s.url, 'Ann');
    const b = await newPlayer(s.url, 'Ben');
    const admin = await adminClient(s.url);
    // LOBBY: closed, opens in PLAN.
    expect((await ready(a.client, true)).body.error).toMatchObject({ code: 'PHASE_CLOSED', details: { opensIn: 'PLAN' } });
    await admin.post('/admin/match', { rounds: 2 });

    // Nothing picked yet: a friendly NOTHING_SELECTED (409); un-ready always works.
    const none = await ready(a.client, true);
    expect(none.status).toBe(409);
    expect(none.body.error.code).toBe('NOTHING_SELECTED');
    expect(none.body.error.hint).toContain('Tap up to 3 units');
    expect((await ready(a.client, false)).body).toEqual({ ready: false });

    await pick(a.client, ['basic-soldier']);
    expect((await ready(a.client, true)).body).toEqual({ ready: true });
    let st = await state(b.client);
    expect(st.players.find((p) => p.id === a.id)).toMatchObject({ selected: true, ready: true });
    expect(st.allReady).toBe(false);
    // Privacy unchanged: still no unit data about Ann for Ben.
    expect(JSON.stringify(st)).not.toContain('basic-soldier');
    expect((await state(a.client)).me?.ready).toBe(true);

    await pick(b.client, ['basic-tower']);
    await ready(b.client, true);
    st = await state(admin);
    expect(st.allReady).toBe(true);
    expect(st.pendingAdvance).toBeUndefined(); // the option is off by default

    // PLAN → PLACEMENT: PLAN Ready does not carry over.
    st = (await admin.post('/admin/phase/next')).body;
    expect(st.phase).toBe('PLACEMENT');
    expect(st.allReady).toBe(false);
    expect(st.players.every((p) => !p.ready)).toBe(true);
    expect((await admin.post('/admin/start', {})).body.error.code).toBe('NOT_ALL_READY');
    // PLACEMENT Ready needs no selection check; everyone ready → allReady.
    await ready(a.client, true);
    await ready(b.client, true);
    expect((await state(admin)).allReady).toBe(true);
    await admin.post('/admin/start', {});
    await waitForState(admin, (x) => x.phase === 'RESULTS');
    expect((await state(admin)).allReady).toBe(false);
    expect((await ready(a.client, true)).body.error).toMatchObject({ code: 'PHASE_CLOSED', details: { phase: 'RESULTS', opensIn: 'PLAN' } });
    // Round 2 PLAN: everyone starts un-ready (the carried-over selection stays).
    st = (await admin.post('/admin/phase/next')).body;
    expect(st.phase).toBe('PLAN');
    expect(st.players.every((p) => !p.ready && p.selected)).toBe(true);
  }, T);

  it('clears Ready when the selection changes or the player submits a unit, not for the same pick or others', async () => {
    const s = await boot();
    const a = await newPlayer(s.url, 'Ann');
    const b = await newPlayer(s.url, 'Ben');
    const admin = await adminClient(s.url);
    await admin.post('/admin/match', { rounds: 1 });
    await pick(a.client, ['basic-soldier', 'basic-tower']);
    await ready(a.client, true);

    // The same set (other order) is no change.
    await pick(a.client, ['basic-tower', 'basic-soldier']);
    expect((await state(a.client)).me?.ready).toBe(true);
    // Someone else's submit doesn't touch Ann.
    expect((await b.client.post('/units', { source: namedUnit('Ben Tank') })).body.ok).toBe(true);
    expect((await state(a.client)).me?.ready).toBe(true);

    // A different selection clears it.
    await pick(a.client, ['basic-soldier']);
    expect((await state(a.client)).me?.ready).toBe(false);

    // Her own submit (new or revised unit) clears it.
    await ready(a.client, true);
    expect((await a.client.post('/units', { source: namedUnit('Ann Tank') })).body.ok).toBe(true);
    expect((await state(a.client)).me?.ready).toBe(false);
    // Also when the facilitator submits on her behalf.
    await ready(a.client, true);
    expect((await admin.post(`/admin/players/${a.id}/units`, { source: namedUnit('Ann Tank') })).body.ok).toBe(true);
    expect((await state(b.client)).players.find((p) => p.id === a.id)?.ready).toBe(false);
  }, T);

  it('allReady counts active players only: benched and kicked players do not block it', async () => {
    const s = await boot();
    const ps = [];
    for (const n of ['Ann', 'Ben', 'Cat', 'Dan']) ps.push(await newPlayer(s.url, n));
    const admin = await adminClient(s.url);
    expect((await admin.post('/admin/match', { rounds: 1, teamMode: 'teams2' })).body.phase).toBe('PLAN');
    const late = await newPlayer(s.url, 'Eve'); // benched until the next match
    expect((await state(late.client)).players.find((p) => p.id === late.id)).toMatchObject({ benched: true, active: false });
    expect((await ready(late.client, true)).body.error.code).toBe('PHASE_CLOSED');

    for (const p of ps.slice(0, 3)) {
      await pick(p.client, ['basic-soldier']);
      await ready(p.client, true);
    }
    expect((await state(admin)).allReady).toBe(false);
    // Kicking the one not-ready player makes everyone ready.
    await admin.post(`/admin/players/${ps[3]!.id}/kick`, {});
    expect((await state(admin)).allReady).toBe(true);
    // The host is never blocked: Next works in PLAN whatever Ready says.
    await ready(ps[0]!.client, false);
    expect((await admin.post('/admin/phase/next')).body.phase).toBe('PLACEMENT');
  }, T);

  it('auto-advances to PLACEMENT after the countdown when the option is on, and cancels on un-ready', async () => {
    const s = await boot({ autoAdvanceDelayMs: 600, config: { timers: { autoAdvanceWhenAllReady: true } } });
    const a = await newPlayer(s.url, 'Ann');
    const b = await newPlayer(s.url, 'Ben');
    const admin = await adminClient(s.url);
    await admin.post('/admin/match', { rounds: 1 });
    await pick(a.client, ['basic-soldier']);
    await pick(b.client, ['basic-tower']);
    await ready(a.client, true);
    expect((await state(admin)).pendingAdvance).toBeUndefined();

    // Everyone ready: the countdown runs; an un-ready during it cancels it.
    await ready(b.client, true);
    const st = await state(admin);
    expect(st.allReady).toBe(true);
    expect(st.pendingAdvance).toEqual({ to: 'PLACEMENT', by: 'auto', secondsLeft: 1 });
    await ready(b.client, false);
    expect((await state(admin)).pendingAdvance).toBeUndefined();
    await new Promise((r) => setTimeout(r, 900));
    expect((await state(admin)).phase).toBe('PLAN');

    // A paused PLAN timer holds the countdown too.
    await admin.post('/admin/timer', { paused: true });
    await ready(b.client, true);
    expect((await state(admin)).pendingAdvance).toBeUndefined();
    await admin.post('/admin/timer', { paused: false });
    expect((await state(admin)).pendingAdvance).toEqual({ to: 'PLACEMENT', by: 'auto', secondsLeft: 1 });
    const placed = await waitForState(admin, (x) => x.phase === 'PLACEMENT', 5000);
    expect(placed.pendingAdvance).toBeUndefined();
    expect(placed.players.every((p) => !p.ready)).toBe(true);

    // Never auto-START the battle, even with everyone ready in PLACEMENT.
    await ready(a.client, true);
    await ready(b.client, true);
    await new Promise((r) => setTimeout(r, 900));
    const still = await state(admin);
    expect(still.phase).toBe('PLACEMENT');
    expect(still.allReady).toBe(true);
    expect(still.pendingAdvance).toBeUndefined();
  }, T);

  it('a host Cancel of the auto countdown sticks until someone un-readies', async () => {
    const s = await boot({ autoAdvanceDelayMs: 600, config: { timers: { autoAdvanceWhenAllReady: true } } });
    const a = await newPlayer(s.url, 'Ann');
    const b = await newPlayer(s.url, 'Ben');
    const admin = await adminClient(s.url);
    await admin.post('/admin/match', { rounds: 1 });
    for (const p of [a, b]) {
      await pick(p.client, ['basic-soldier']);
      await ready(p.client, true);
    }
    expect((await state(admin)).pendingAdvance?.by).toBe('auto');
    expect((await admin.post('/admin/phase/advance/cancel')).body.pendingAdvance).toBeUndefined();
    await new Promise((r) => setTimeout(r, 900));
    let st = await state(admin);
    expect(st.phase).toBe('PLAN');
    expect(st.pendingAdvance).toBeUndefined();
    // Un-ready and ready again: the auto countdown re-arms and fires.
    await ready(b.client, false);
    await ready(b.client, true);
    expect((await state(admin)).pendingAdvance?.by).toBe('auto');
    st = await waitForState(admin, (x) => x.phase === 'PLACEMENT', 5000);
    expect(st.pendingAdvance).toBeUndefined();
  }, T);
});

describe('host countdown (POST /admin/phase/advance)', () => {
  it('needs the admin: no cookie or a player cookie is refused', async () => {
    const s = await boot();
    const a = await newPlayer(s.url, 'Ann');
    await newPlayer(s.url, 'Ben');
    const admin = await adminClient(s.url);
    await admin.post('/admin/match', { rounds: 1 });
    expect((await a.client.post('/admin/phase/advance', { delaySec: 1 })).body.error.code).toBe('ADMIN_REQUIRED');
    expect((await new Client(s.url).post('/admin/phase/advance', {})).body.error.code).toBe('ADMIN_REQUIRED');
    expect((await a.client.post('/admin/phase/advance/cancel')).body.error.code).toBe('ADMIN_REQUIRED');
    expect((await admin.post('/admin/phase/advance', { delaySec: 99 })).body.error.code).toBe('BAD_REQUEST');
    expect((await state(admin)).pendingAdvance).toBeUndefined();
  }, T);

  it('counts down, keeps going on an un-ready, fires Next / START, and can be cancelled', async () => {
    const s = await boot();
    const a = await newPlayer(s.url, 'Ann');
    const b = await newPlayer(s.url, 'Ben');
    const admin = await adminClient(s.url);
    expect((await admin.post('/admin/phase/advance', {})).body.error.code).toBe('PHASE_CLOSED'); // LOBBY
    await admin.post('/admin/match', { rounds: 1 });
    for (const p of [a, b]) {
      await pick(p.client, ['basic-soldier']);
      await ready(p.client, true);
    }
    // Cancel works throughout.
    let st = (await admin.post('/admin/phase/advance', { delaySec: 0.6 })).body as GameStateDTO;
    expect(st.pendingAdvance).toEqual({ to: 'PLACEMENT', by: 'host', secondsLeft: 1 });
    expect((await state(a.client)).pendingAdvance?.to).toBe('PLACEMENT'); // every client sees it
    await admin.post('/admin/phase/advance/cancel');
    await new Promise((r) => setTimeout(r, 900));
    expect((await state(admin)).phase).toBe('PLAN');

    // The host chose it: an un-ready doesn't stop it (PLAN Next never needs Ready).
    await admin.post('/admin/phase/advance', { delaySec: 0.5 });
    await ready(a.client, false);
    expect((await state(admin)).pendingAdvance?.by).toBe('host');
    st = await waitForState(admin, (x) => x.phase === 'PLACEMENT', 5000);
    expect(st.pendingAdvance).toBeUndefined();

    // PLACEMENT: needs everyone Ready to start, then START without force at zero.
    expect((await admin.post('/admin/phase/advance', { delaySec: 0.5 })).body.error.code).toBe('NOT_ALL_READY');
    await ready(a.client, true);
    await ready(b.client, true);
    st = (await admin.post('/admin/phase/advance', { delaySec: 0.5 })).body;
    expect(st.pendingAdvance).toEqual({ to: 'BATTLE', by: 'host', secondsLeft: 1 });
    // Someone un-readies: the countdown keeps going but START (without force) refuses at zero.
    await ready(b.client, false);
    await new Promise((r) => setTimeout(r, 1000));
    st = await state(admin);
    expect(st.phase).toBe('PLACEMENT');
    expect(st.pendingAdvance).toBeUndefined();
    await ready(b.client, true);
    await admin.post('/admin/phase/advance', { delaySec: 0.5 });
    await waitForState(admin, (x) => x.phase !== 'PLACEMENT', 5000);
  }, T);

  it('is dropped when the phase changes another way', async () => {
    const s = await boot();
    const a = await newPlayer(s.url, 'Ann');
    await newPlayer(s.url, 'Ben');
    const admin = await adminClient(s.url);
    await admin.post('/admin/match', { rounds: 1 });
    await admin.post('/admin/phase/advance', { delaySec: 1 });
    {
      const st = (await admin.post('/admin/phase/next')).body as GameStateDTO;
      expect(st.phase).toBe('PLACEMENT');
      expect(st.pendingAdvance).toBeUndefined();
    }
    await new Promise((r) => setTimeout(r, 1300));
    expect((await state(a.client)).phase).toBe('PLACEMENT');
  }, T);
});
