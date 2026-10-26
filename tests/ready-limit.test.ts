// Ready can't be spammed: one change per READY_MIN_GAP_MS and at
// most READY_MAX_PER_WINDOW changes per READY_WINDOW_MS per player. Pressing
// the same state again never counts. The client keeps the button disabled for
// the gap and for any retryAfterMs it is told.

import { afterEach, describe, expect, it } from 'vitest';
import { READY_MIN_GAP_MS } from '@pixel-clash/shared';
import type { RunningServer } from '../packages/server/src/server.js';
import { ApiError, retryAfterMs } from '../packages/client/src/common/api.js';
import { adminClient, bootServer, newPlayer, removeDir, tempDataDir } from './helpers/server.js';

let srv: RunningServer | undefined;
let dir: string | undefined;
afterEach(async () => {
  await srv?.close();
  if (dir) removeDir(dir);
  srv = undefined;
  dir = undefined;
});

const ready = (c: { post: (p: string, b: unknown) => Promise<{ status: number; body: any }> }, r: boolean) => c.post('/round/ready', { ready: r });

describe('Ready spam limit', () => {
  it('allows one change per gap and per-window max; same-state presses are free; players are independent', async () => {
    dir = tempDataDir();
    srv = await bootServer({ dataDir: dir, readyLimit: { minGapMs: 400, maxPerWindow: 3, windowMs: 5000 } });
    const a = await newPlayer(srv.url, 'Ann');
    const b = await newPlayer(srv.url, 'Ben');
    const admin = await adminClient(srv.url);
    await admin.post('/admin/match', { rounds: 1 });
    for (const p of [a, b]) await p.client.put('/round/selection', { unitIds: ['basic-soldier'] });

    expect((await ready(a.client, true)).body.ready).toBe(true);
    // Same state again: allowed, not counted.
    expect((await ready(a.client, true)).body.ready).toBe(true);
    // A real change inside the gap: refused with a wait.
    const spam = await ready(a.client, false);
    expect(spam.status).toBe(429);
    expect(spam.body.error.code).toBe('RATE_LIMITED');
    expect(spam.body.error.details.retryAfterMs).toBeGreaterThan(0);
    expect(spam.body.error.details.retryAfterMs).toBeLessThanOrEqual(400);
    // Another player isn't affected.
    expect((await ready(b.client, true)).body.ready).toBe(true);

    await new Promise((r) => setTimeout(r, 450));
    expect((await ready(a.client, false)).body.ready).toBe(false); // change 2
    await new Promise((r) => setTimeout(r, 450));
    expect((await ready(a.client, true)).body.ready).toBe(true); // change 3
    await new Promise((r) => setTimeout(r, 450));
    // Gap passed, but the window allows only 3 changes.
    const windowed = await ready(a.client, false);
    expect(windowed.body.error.code).toBe('RATE_LIMITED');
    expect(windowed.body.error.details.retryAfterMs).toBeGreaterThan(400);
  }, 30_000);

  it('the default limit is on and uses the shared gap', async () => {
    dir = tempDataDir();
    srv = await bootServer({ dataDir: dir, readyLimit: undefined });
    const a = await newPlayer(srv.url, 'Ann');
    await newPlayer(srv.url, 'Ben');
    const admin = await adminClient(srv.url);
    await admin.post('/admin/match', { rounds: 1 });
    await a.client.put('/round/selection', { unitIds: ['basic-soldier'] });
    expect((await ready(a.client, true)).body.ready).toBe(true);
    const spam = await ready(a.client, false);
    expect(spam.body.error.code).toBe('RATE_LIMITED');
    expect(spam.body.error.details.retryAfterMs).toBeLessThanOrEqual(READY_MIN_GAP_MS);
  }, 30_000);

  it('the client reads retryAfterMs only from RATE_LIMITED errors', () => {
    expect(retryAfterMs(new ApiError(429, 'RATE_LIMITED', 'x', undefined, { retryAfterMs: 1234 }))).toBe(1234);
    expect(retryAfterMs(new ApiError(409, 'PHASE_CLOSED', 'x', undefined, { retryAfterMs: 1234 }))).toBe(0);
    expect(retryAfterMs(new Error('boom'))).toBe(0);
  });
});
