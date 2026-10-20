// Regression tests for client review fixes: sprite bake keys follow the
// sprite's content (revisions keep their unitId), the reveal drop-in is gated
// on time and playback position, the WS liveness watchdog, and sprite facing
// in isometric SCREEN space (engine FACING_LEFT).

import { describe, expect, it } from 'vitest';
import { FRAME_FLAGS, parseConfig, type SpriteSpec } from '@pixel-clash/shared';
import { DROP_MS, DROP_STAGGER_MS, dropInActive, fnv1a, revealedSprite } from '../packages/client/src/common/render/arena.js';
import { isStale } from '../packages/client/src/common/ws.js';
import { runBattle } from '../packages/server/src/sim/engine.js';
import { SOLDIER, design, fakePlayers, idleBrain, scripted } from './helpers/fakeRunner.js';

const DOT = (color: string): SpriteSpec => ({
  grid: 8,
  palette: { a: color },
  frames: { idle: [['aaaaaaaa', 'aaaaaaaa', 'aaaaaaaa', 'aaaaaaaa', '........', '........', '........', '........']] },
});

describe('sprite bake key (§5.1, §7)', () => {
  it('changes when a revision redraws the sprite, even with the same unitId, cost and colour', () => {
    const base = { unitId: 'ninja', spriteHidden: false, stats: SOLDIER };
    const v1 = revealedSprite('p1', { ...base, sprite: DOT('#FF0000') });
    const v2 = revealedSprite('p1', { ...base, sprite: DOT('#00FF00') });
    expect(v1.key).not.toBe(v2.key);
    expect(revealedSprite('p1', { ...base, sprite: DOT('#FF0000') }).key).toBe(v1.key);
    // Hidden sprite → fallback, keyed by the fallback's content.
    const hidden = revealedSprite('p1', { ...base, sprite: DOT('#FF0000'), spriteHidden: true });
    expect(hidden.key).not.toBe(v1.key);
    expect(fnv1a('')).toBe('811c9dc5');
  });
});

describe('reveal drop-in (§12.2)', () => {
  const at = { revealAt: 1000, units: 4 };
  it('plays even when the t=0 frame is already buffered', () => {
    expect(dropInActive({ ...at, now: 1100, bufferLength: 1, tick: 0, firstT: 0 })).toBe(true);
    expect(dropInActive({ ...at, now: 1100, bufferLength: 0, tick: 0, firstT: 0 })).toBe(true);
  });
  it('stops after its time window or once playback moves on', () => {
    expect(dropInActive({ ...at, now: 1000 + DROP_MS + 4 * DROP_STAGGER_MS, bufferLength: 1, tick: 0, firstT: 0 })).toBe(false);
    expect(dropInActive({ ...at, now: 1100, bufferLength: 5, tick: 40, firstT: 0 })).toBe(false);
    expect(dropInActive({ ...at, revealAt: Number.NEGATIVE_INFINITY, now: 1100, bufferLength: 1, tick: 0, firstT: 0 })).toBe(false);
  });
});

describe('WS liveness watchdog', () => {
  it('a socket silent for more than 2 ping periods is stale', () => {
    expect(isStale(0, 30_000, 15_000)).toBe(false);
    expect(isStale(0, 30_001, 15_000)).toBe(true);
    expect(isStale(20_000, 40_000, 15_000)).toBe(false);
  });
});

describe('FACING_LEFT in screen space (§5.1, §12)', () => {
  it('a soldier stepping (+1, +3) moves LEFT on screen and faces left', async () => {
    const config = parseConfig({ timers: { battleTicks: 20 }, suddenDeath: { startTick: 100_000, endTick: 100_001 } });
    const downLeft = scripted((self) => ({ action: 'move', destination: { x: self.x + 10, y: self.y + 30 } }));
    const upRight = scripted((self) => ({ action: 'move', destination: { x: self.x + 30, y: self.y - 10 } }));
    const { setups } = fakePlayers([
      { playerId: 'a', seat: 0, zone: 'TL', units: [design('s', SOLDIER)], placements: [{ unitId: 's', col: 0, row: 0 }], brains: { s: downLeft } },
      { playerId: 'b', seat: 1, zone: 'BR', units: [design('s', SOLDIER)], placements: [{ unitId: 's', col: 0, row: 0 }], brains: { s: upRight } },
      { playerId: 'c', seat: 2, zone: 'BL', units: [design('s', SOLDIER)], placements: [{ unitId: 's', col: 0, row: 0 }], brains: { s: idleBrain } },
    ]);
    const result = await runBattle({ players: setups, config, seed: 1 });
    const flags = (t: number, id: string) => result.frames.find((f) => f.t === t)!.units.find((u) => u[0] === id)![4];
    // x grows but x − y shrinks: on screen it walks left.
    expect(flags(10, '0-0-0') & FRAME_FLAGS.FACING_LEFT).toBeTruthy();
    // x grows and y shrinks: walks right on screen.
    expect(flags(10, '1-0-0') & FRAME_FLAGS.FACING_LEFT).toBe(0);
    // BL sits on the left of the screen: it starts facing right (the centre).
    expect(flags(0, '2-0-0') & FRAME_FLAGS.FACING_LEFT).toBe(0);
  });
});
