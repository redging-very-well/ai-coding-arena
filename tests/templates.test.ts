import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, checkSprite, checkStats, computeCost } from '@pixel-clash/shared';

// The starter-kit templates are plain ESM with a default-exported class, so
// they can be imported directly here (the real validator runs them in the sandbox).
const load = async (file: string) => {
  const mod = (await import(`../packages/starter-kit/units/${file}`)) as { default: new () => Record<string, unknown> };
  return new mod.default();
};

describe('starter-kit templates (§6 stats)', () => {
  it('basic_soldier: 120/10/40/1.5/60, size 10 → $92', async () => {
    const u = await load('basic_soldier.js');
    const r = checkStats(u, DEFAULT_CONFIG.stats.bounds);
    expect(r.ok).toBe(true);
    expect(u).toMatchObject({ type: 'soldier', maxHealth: 120, damage: 10, range: 40, speed: 1.5, attackCooldown: 60, size: 10 });
    expect(computeCost(u as never, DEFAULT_CONFIG.cost).cost).toBe(92);
  });

  it('basic_tower: 150/15/180/0/45, size 14 → $198', async () => {
    const u = await load('basic_tower.js');
    const r = checkStats(u, DEFAULT_CONFIG.stats.bounds);
    expect(r.ok).toBe(true);
    expect(u).toMatchObject({ type: 'tower', maxHealth: 150, damage: 15, range: 180, speed: 0, attackCooldown: 45, size: 14 });
    expect(computeCost(u as never, DEFAULT_CONFIG.cost).cost).toBe(198);
  });

  it('soldier chases, then attacks in edge-to-edge range; tower attacks nearest in range', async () => {
    const soldier = (await load('basic_soldier.js')) as unknown as { update: (...a: unknown[]) => unknown };
    const tower = (await load('basic_tower.js')) as unknown as { update: (...a: unknown[]) => unknown };
    const world = { width: 800, height: 800, tick: 0, ticksLeft: 5400, myCorner: { x: 120, y: 120 }, center: { x: 400, y: 400 }, safeZone: { x: 400, y: 400, radius: 570 } };
    const self = { id: '0-0-0', x: 100, y: 100, radius: 10, range: 40, cooldownRemaining: 0 };
    const far = { id: '1-0-0', x: 300, y: 100, radius: 14 };
    const near = { id: '1-0-1', x: 160, y: 100, radius: 14 }; // gap 36
    expect(soldier.update(self, [far], [], world)).toEqual({ action: 'move', destination: { x: 300, y: 100 } });
    expect(soldier.update(self, [far, near], [], world)).toEqual({ action: 'attack', targetId: '1-0-1' });
    const tSelf = { ...self, radius: 14, range: 180 };
    expect(tower.update(tSelf, [far, near], [], world)).toEqual({ action: 'attack', targetId: '1-0-1' });
    expect(tower.update(tSelf, [{ ...far, x: 700 }], [], world)).toEqual({ action: 'idle' });
  });
});

describe('starter-kit templates (§5.1 sprites)', () => {
  it.each([
    ['basic_soldier.js', ''],
    ['basic_tower.js', 'y'], // the crystal's glow sparkles float free
  ])('%s has a valid 16x16 sprite: idle 2, walk 2, attack 1, dark outline', async (file, glow) => {
    const u = (await load(file)) as unknown as { sprite: () => unknown };
    const spec = JSON.parse(JSON.stringify(u.sprite()));
    const r = checkSprite(spec);
    if (!r.ok) throw new Error(JSON.stringify(r.errors, null, 2));
    expect(r.sprite.grid).toBe(16);
    expect(r.sprite.frames.idle).toHaveLength(2);
    expect(r.sprite.frames.walk).toHaveLength(2);
    expect(r.sprite.frames.attack).toHaveLength(1);
    expect(JSON.stringify(u.sprite())).toBe(JSON.stringify(spec)); // deterministic
    // Dark outline: every coloured pixel next to a transparent one is the
    // outline colour 'o' (except glow sparkles).
    expect(r.sprite.palette.o).toBe('#1A1428');
    const loose: string[] = [];
    for (const [state, frames] of Object.entries(r.sprite.frames)) {
      frames.forEach((f, fi) => {
        const at = (x: number, y: number) => f[y]?.[x] ?? '';
        for (let y = 0; y < 16; y++) {
          for (let x = 0; x < 16; x++) {
            const c = at(x, y);
            if (c === '.' || c === 'o' || glow.includes(c)) continue;
            if ([at(x + 1, y), at(x - 1, y), at(x, y + 1), at(x, y - 1)].includes('.')) loose.push(`${state}[${fi}] ${y},${x}`);
          }
        }
      });
    }
    expect(loose).toEqual([]);
  });
});
