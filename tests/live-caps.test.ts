// Live caps on /play (user report 2026-10-25: "I set Max fighters placed per
// player to 20, but players are saying they can only place 12"): /play read
// GET /rules once when the page opened, so a cap the host changed later in
// /admin never reached open pages, and the page blocked the 13th fighter itself.
// The server pushes the live copy caps in every state (`me.copyCaps`); /play
// now takes them from there and re-reads /rules when they move.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type GameStateDTO } from '@pixel-clash/shared';
import type { RunningServer } from '../packages/server/src/server.js';
import { DEFAULT_PLAY_CAPS, capsWithLiveCopyCaps, copyCapProblem } from '../packages/client/src/play/logic.js';
import { adminClient, bootServer, newPlayer, removeDir, tempDataDir } from './helpers/server.js';

describe('capsWithLiveCopyCaps', () => {
  it('takes the pushed copy caps over the ones read at page load, and says when they moved', () => {
    const same = capsWithLiveCopyCaps(DEFAULT_PLAY_CAPS, {
      fighters: DEFAULT_PLAY_CAPS.maxCopies,
      factories: DEFAULT_PLAY_CAPS.maxFactoryCopies,
      walls: DEFAULT_PLAY_CAPS.maxWallCopies,
    });
    expect(same).toEqual({ caps: DEFAULT_PLAY_CAPS, changed: false });
    const raised = capsWithLiveCopyCaps(DEFAULT_PLAY_CAPS, { fighters: 20, factories: DEFAULT_PLAY_CAPS.maxFactoryCopies, walls: DEFAULT_PLAY_CAPS.maxWallCopies });
    expect(raised.changed).toBe(true);
    expect(raised.caps.maxCopies).toBe(20);
    expect(capsWithLiveCopyCaps(DEFAULT_PLAY_CAPS, undefined)).toEqual({ caps: DEFAULT_PLAY_CAPS, changed: false });
  });

  it('with the live cap of 20, the 13th fighter is no longer blocked on /play', () => {
    const counts = { fighters: 12, factories: 0, walls: 0 };
    expect(copyCapProblem(counts, 'soldier', DEFAULT_PLAY_CAPS)).not.toBeNull(); // the old, stale 12
    const live = capsWithLiveCopyCaps(DEFAULT_PLAY_CAPS, { fighters: 20, factories: DEFAULT_PLAY_CAPS.maxFactoryCopies, walls: DEFAULT_PLAY_CAPS.maxWallCopies }).caps;
    expect(copyCapProblem(counts, 'soldier', live)).toBeNull();
    expect(copyCapProblem({ ...counts, fighters: 20 }, 'soldier', live)).not.toBeNull();
  });
});

describe('the server pushes the live copy caps', () => {
  let srv: RunningServer;
  const dir = tempDataDir();
  beforeAll(async () => {
    srv = await bootServer({ dataDir: dir });
  });
  afterAll(async () => {
    await srv.close();
    removeDir(dir);
  });

  it('after the host raises Max fighters to 20, every player state says 20', async () => {
    const a = await newPlayer(srv.url, 'Ann');
    const admin = await adminClient(srv.url);
    const before = (await a.client.get('/state')).body as GameStateDTO;
    expect(before.me?.copyCaps?.fighters).toBe(DEFAULT_CONFIG.caps.maxCopies);
    expect((await admin.put('/admin/config', { caps: { maxCopies: 20 } })).status).toBe(200);
    const after = (await a.client.get('/state')).body as GameStateDTO;
    expect(after.me?.copyCaps?.fighters).toBe(20);
  }, 60_000);
});
