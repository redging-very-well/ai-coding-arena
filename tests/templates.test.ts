import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, checkSprite, checkStats, computeCost } from '@pixel-clash/shared';

// The starter-kit templates are plain ESM with a default-exported class, so
// they can be imported directly here (the real validator runs them in the sandbox).
const load = async (file: string) => {
  const mod = (await import(`../packages/starter-kit/units/${file}`)) as { default: new () => Record<string, unknown> };
  return new mod.default();
};

describe('starter-kit templates (§6 stats)', () => {
  it('basic_soldier: 1400/56/40/1.5/60, size 10 → $807 (the $10,000 redesign)', async () => {
    const u = await load('basic_soldier.js');
    const r = checkStats(u, DEFAULT_CONFIG.stats.bounds);
    expect(r.ok).toBe(true);
    expect(r.ok && r.warnings).toEqual([]);
    expect(u).toMatchObject({ type: 'soldier', maxHealth: 1400, damage: 56, range: 40, speed: 1.5, attackCooldown: 60, size: 10 });
    expect(computeCost(u as never, DEFAULT_CONFIG.cost).cost).toBe(807);
  });

  it('basic_tower: 1200/72/140/0/45, size 14 → $1,200 (the $10,000 redesign)', async () => {
    const u = await load('basic_tower.js');
    const r = checkStats(u, DEFAULT_CONFIG.stats.bounds);
    expect(r.ok).toBe(true);
    expect(r.ok && r.warnings).toEqual([]);
    expect(u).toMatchObject({ type: 'tower', maxHealth: 1200, damage: 72, range: 140, speed: 0, attackCooldown: 45, size: 14 });
    expect(computeCost(u as never, DEFAULT_CONFIG.cost).cost).toBe(1200);
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
    const tSelf = { ...self, radius: 14, range: 140 };
    expect(tower.update(tSelf, [far, near], [], world)).toEqual({ action: 'attack', targetId: '1-0-1' });
    expect(tower.update(tSelf, [{ ...far, x: 700 }], [], world)).toEqual({ action: 'idle' });
  });

  it('no template assumes the 800 arena: with no enemies the soldier walks to world.center of a 1200 map', async () => {
    const soldier = (await load('basic_soldier.js')) as unknown as { update: (...a: unknown[]) => unknown };
    const world = { width: 1200, height: 1200, tick: 0, ticksLeft: 5400, mapStyle: 'ring', myCorner: { x: 600, y: 120 }, center: { x: 600, y: 600 }, safeZone: { x: 600, y: 600, radius: 855 } };
    const self = { id: '0-0-0', teamId: 0, x: 600, y: 220, radius: 10, range: 40, cooldownRemaining: 0 };
    expect(soldier.update(self, [], [], world)).toEqual({ action: 'move', destination: { x: 600, y: 600 } });
    for (const file of ['basic_soldier.js', 'basic_tower.js']) {
      const src = readFileSync(new URL(`../packages/starter-kit/units/${file}`, import.meta.url), 'utf8');
      const code = src.replace(/\/\/.*$/gm, ''); // comments may mention the sizes
      expect(code).not.toMatch(/\b(800|400)\b/);
    }
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

describe('starter-kit templates (M8.5 walls and factories)', () => {
  const world = { width: 800, height: 800, tick: 0, ticksLeft: 5400, mapStyle: 'corners', myCorner: { x: 120, y: 120 }, center: { x: 400, y: 400 }, safeZone: { x: 400, y: 400, radius: 570 } };
  type Updater = { update: (...a: unknown[]) => unknown };

  it('basic_wall: 3200 HP, no update(), → $149 (the $10,000 redesign)', async () => {
    const u = await load('basic_wall.js');
    const r = checkStats(u, DEFAULT_CONFIG.stats.bounds);
    expect(r.ok && r.warnings).toEqual([]);
    expect(u).toMatchObject({ type: 'wall', maxHealth: 3200 });
    expect('update' in u).toBe(false);
    expect(computeCost(u as never, DEFAULT_CONFIG.cost).cost).toBe(149);
  });

  it('basic_factory: 2400 HP, interval 600 → $2,194 ($247 body + 11 × $177) (the $10,000 redesign)', async () => {
    const u = await load('basic_factory.js');
    const r = checkStats(u, DEFAULT_CONFIG.stats.bounds);
    expect(r.ok && r.warnings).toEqual([]);
    expect(u).toMatchObject({ type: 'factory', maxHealth: 2400, productionInterval: 600 });
    const priced = computeCost(u as never, DEFAULT_CONFIG.cost);
    expect(priced.cost).toBe(2194);
    expect(priced.breakdown.body).toBe(247);
    expect(priced.breakdown.production).toMatchObject({ expected: 11, minionValue: 177 });
  });

  it.each(['basic_wall.js', 'basic_factory.js'])('%s has a valid, deterministic 16x16 sprite', async (file) => {
    const u = (await load(file)) as unknown as { sprite: () => unknown };
    const spec = JSON.parse(JSON.stringify(u.sprite()));
    const r = checkSprite(spec);
    if (!r.ok) throw new Error(JSON.stringify(r.errors, null, 2));
    expect(r.sprite.grid).toBe(16);
    expect(JSON.stringify(u.sprite())).toBe(JSON.stringify(spec));
  });

  it('the factory sprite has 2 idle frames (chimney smoke) and an attack frame with the door lit', async () => {
    const u = (await load('basic_factory.js')) as unknown as { sprite: () => { frames: Record<string, string[][]> } };
    const s = u.sprite();
    expect(s.frames.idle).toHaveLength(2);
    expect(s.frames.attack).toHaveLength(1);
    expect(s.frames.attack![0]!.join('')).not.toContain('dd');
  });

  it('factory rallies at the nearest enemy that is not a wall, else world.center', async () => {
    const f = (await load('basic_factory.js')) as unknown as Updater;
    const self = { id: '0-0-0', x: 100, y: 100, radius: 18, factory: { minionsLeft: 5 } };
    const wall = { id: '1-0-0', type: 'wall', x: 140, y: 100, radius: 20 };
    const soldier = { id: '1-0-1', type: 'soldier', x: 400, y: 300, radius: 10 };
    expect(f.update(self, [wall, soldier], [], world)).toEqual({ action: 'rally', destination: { x: 400, y: 300 } });
    expect(f.update(self, [wall], [], world)).toEqual({ action: 'rally', destination: { x: 400, y: 400 } });
  });

  it('soldier skips walls when picking a target, and smashes an enemy wall after 120 blocked ticks', async () => {
    const soldier = (await load('basic_soldier.js')) as unknown as Updater;
    const self = { id: '0-0-0', x: 100, y: 100, radius: 10, range: 40, cooldownRemaining: 0, blockedBy: null, blockedTicks: 0 };
    const wall = { id: '1-0-0', type: 'wall', x: 140, y: 100, radius: 20 }; // touching: gap 10
    const enemy = { id: '1-0-1', type: 'soldier', x: 300, y: 100, radius: 10 };
    expect(soldier.update(self, [wall, enemy], [], world)).toEqual({ action: 'move', destination: { x: 300, y: 100 } });
    const stuck = { ...self, blockedBy: '1-0-0', blockedTicks: 120 };
    expect(soldier.update(stuck, [wall, enemy], [], world)).toEqual({ action: 'attack', targetId: '1-0-0' });
    expect(soldier.update({ ...stuck, cooldownRemaining: 5 }, [wall, enemy], [], world)).toEqual({ action: 'idle' });
    // Not long enough, or the wall is our own (not in enemies) / already broken: keep going for the enemy.
    expect(soldier.update({ ...stuck, blockedTicks: 119 }, [wall, enemy], [], world)).toEqual({ action: 'move', destination: { x: 300, y: 100 } });
    expect(soldier.update({ ...stuck, blockedBy: '0-0-9' }, [wall, enemy], [], world)).toEqual({ action: 'move', destination: { x: 300, y: 100 } });
    // Only walls left: attack the nearest wall.
    expect(soldier.update(self, [wall], [], world)).toEqual({ action: 'attack', targetId: '1-0-0' });
  });

  it('tower shoots a wall only when nothing else is in range', async () => {
    const tower = (await load('basic_tower.js')) as unknown as Updater;
    const self = { id: '0-0-0', x: 100, y: 100, radius: 14, range: 180, cooldownRemaining: 0 };
    const wall = { id: '1-0-0', type: 'wall', x: 160, y: 100, radius: 20 };
    const minion = { id: '1-0-1-m1', type: 'minion', x: 250, y: 100, radius: 8 };
    expect(tower.update(self, [wall, minion], [], world)).toEqual({ action: 'attack', targetId: '1-0-1-m1' });
    expect(tower.update(self, [wall, { ...minion, x: 700 }], [], world)).toEqual({ action: 'attack', targetId: '1-0-0' });
  });

  it('the factory template does not assume the 800 arena (it rallies at world.center)', () => {
    const src = readFileSync(new URL('../packages/starter-kit/units/basic_factory.js', import.meta.url), 'utf8');
    expect(src.replace(/\/\/.*$/gm, '')).not.toMatch(/\b(800|400)\b/);
    expect(src).toContain('world.center');
  });
});
