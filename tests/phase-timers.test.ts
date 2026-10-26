// Phase timers running out (plan §3, bug report 2026-10-26: "/screen didn't
// show a START battle button once the timer had run out"). PLAN moves on by
// itself, Ready or not (players without a pick get the auto-pick). PLACEMENT
// stops: empty zones are auto-placed, placement closes, the battle is NOT
// auto-started, and the host's START / countdown works without everyone
// Ready. A paused timer never runs out; adding time reopens placement.
// The clock is driven like the other server tests: POST /admin/timer
// {setSeconds: 0} and the server's 250 ms ticker.

import { afterEach, describe, expect, it } from 'vitest';
import type { GameStateDTO } from '@pixel-clash/shared';
import type { RunningServer } from '../packages/server/src/server.js';
import { Client, adminClient, bootServer, newPlayer, removeDir, sleep, tempDataDir, waitForState } from './helpers/server.js';

const T = 60_000;

let srv: RunningServer | undefined;
let dir: string | undefined;

afterEach(async () => {
  await srv?.close();
  if (dir) removeDir(dir);
  srv = undefined;
  dir = undefined;
});

const state = async (c: Client) => (await c.get<GameStateDTO>('/state')).body;

async function twoPlayersInPlan() {
  dir = tempDataDir();
  srv = await bootServer({ dataDir: dir });
  const a = await newPlayer(srv.url, 'Ann');
  const b = await newPlayer(srv.url, 'Ben');
  const admin = await adminClient(srv.url);
  expect((await admin.post('/admin/match', { rounds: 1 })).body.phase).toBe('PLAN');
  return { a, b, admin };
}

describe('phase timers running out', () => {
  it('PLAN: a paused timer holds; at zero planning stops even though nobody is ready', async () => {
    const { a, b, admin } = await twoPlayersInPlan();
    await a.client.put('/round/selection', { unitIds: ['basic-soldier'] });
    // Ben picks nothing and nobody presses Ready.

    // Paused at 0 s: the host's pause wins, planning goes on.
    await admin.post('/admin/timer', { setSeconds: 0, paused: true });
    await sleep(700);
    expect((await state(admin)).phase).toBe('PLAN');

    await admin.post('/admin/timer', { paused: false });
    const st = await waitForState(admin, (x) => x.phase === 'PLACEMENT', 5000);
    expect(st.allReady).toBe(false);
    expect(st.timer.secondsLeft).toBeGreaterThan(0); // the PLACEMENT timer runs
    expect((await state(a.client)).me!.selection).toEqual(['basic-soldier']);
    // Ben gets the auto-pick.
    expect((await state(b.client)).me!.selection.length).toBeGreaterThan(0);
  }, T);

  it('PLACEMENT: at zero placement stops and START works without Ready, but the battle never starts by itself', async () => {
    const { a, b, admin } = await twoPlayersInPlan();
    await admin.post('/admin/phase/next');
    expect((await state(admin)).phase).toBe('PLACEMENT');
    // Before time is up START still needs everyone Ready.
    expect((await admin.post('/admin/phase/advance', { delaySec: 0 })).body.error.code).toBe('NOT_ALL_READY');

    await admin.post('/admin/timer', { setSeconds: 0 });
    let st = await waitForState(admin, (x) => x.timer.expired === true, 5000);
    expect(st.phase).toBe('PLACEMENT');
    expect(st.allReady).toBe(false);
    // Nobody had placed: both armies were placed for them right away.
    expect((await state(a.client)).me!.placement.length).toBeGreaterThan(0);
    expect((await state(b.client)).me!.placement.length).toBeGreaterThan(0);
    // Placement is closed.
    const closed = await a.client.put('/round/placement', { placements: [] });
    expect(closed.body.error).toMatchObject({ code: 'PHASE_CLOSED', details: { phase: 'PLACEMENT', timeUp: true } });
    // No auto-start: the battle is the host's show moment.
    await sleep(700);
    expect((await state(admin)).phase).toBe('PLACEMENT');

    // Adding time reopens placement and brings the Ready rule back.
    await admin.post('/admin/timer', { addSeconds: 60 });
    st = await state(admin);
    expect(st.timer.expired).toBeUndefined();
    expect((await a.client.put('/round/placement', { placements: [] })).status).toBe(200);
    expect((await admin.post('/admin/phase/advance', { delaySec: 0 })).body.error.code).toBe('NOT_ALL_READY');

    // Time up again: the host's countdown (the /screen START battle ▶) starts the battle, Ready or not.
    await admin.post('/admin/timer', { setSeconds: 0 });
    await waitForState(admin, (x) => x.timer.expired === true, 5000);
    expect((await state(a.client)).me!.placement.length).toBeGreaterThan(0); // Ann's cleared army was re-placed
    const adv = await admin.post('/admin/phase/advance', { delaySec: 1 });
    expect(adv.body.pendingAdvance).toMatchObject({ to: 'BATTLE', by: 'host' });
    await waitForState(admin, (x) => x.phase === 'BATTLE' || x.phase === 'RESULTS', 10_000);
  }, T);

  it('PLACEMENT: after time is up, plain START (Next) works too', async () => {
    const { admin } = await twoPlayersInPlan();
    await admin.post('/admin/phase/next');
    await admin.post('/admin/timer', { setSeconds: 0 });
    await waitForState(admin, (x) => x.timer.expired === true, 5000);
    expect((await admin.post('/admin/start', {})).body.phase).toBe('BATTLE');
  }, T);
});
