// The M8.5 buildings worst case (plan §9.3 Performance, §14 test:perf):
// 8 players on Ring 8 (1200 arena), each with 10 soldiers + 2 Swarm Factories
// (12 fighters) + 12 walls in lines with gates, minions at the cap, every
// update() looping over all enemies. The fake-runner version is a fast smoke
// test; tests/buildings-perf.test.ts runs the same shape with real isolates.

import {
  DEFAULT_CONFIG,
  assignMapZones,
  deepMerge,
  mapFor,
  type GameConfig,
  type MapLayout,
  type OtherView,
  type PlacementDTO,
  type ZoneRef,
} from '@pixel-clash/shared';
import { BattleEngine } from '../../packages/server/src/sim/engine.js';
import { design, fakePlayers, scripted, soldierBrain, stats } from './fakeRunner.js';

export const SWARM_FACTORY = stats({ type: 'factory', name: 'Swarm Factory', maxHealth: 1500, productionInterval: 600 });
export const BASIC_WALL = stats({ type: 'wall' });

const at = (col: number, row: number, unitId: string): PlacementDTO => ({ unitId, col, row });

/** 10 soldiers, 2 factories and 12 walls in three wall rows with gates (24 of 36 cells). */
export function worstCasePlacements(ids = { soldier: 's', factory: 'f', wall: 'w' }): PlacementDTO[] {
  const out: PlacementDTO[] = [];
  for (let c = 0; c < 6; c++) out.push(at(c, 0, ids.soldier));
  for (const c of [0, 1, 2, 4, 5]) out.push(at(c, 1, ids.wall)); // gate at col 3
  for (let c = 0; c < 4; c++) out.push(at(c, 2, ids.soldier));
  out.push(at(4, 2, ids.factory), at(5, 2, ids.factory));
  for (const c of [0, 1, 3, 4, 5]) out.push(at(c, 3, ids.wall)); // gate at col 2
  out.push(at(0, 5, ids.wall), at(5, 5, ids.wall));
  return out;
}

/**
 * M8.7 maze (plan §14 test:perf): 10 soldiers, 2 factories and 12 walls
 * forming a U (cols 1 and 4 of rows 0-2 with row 2 between them, a one-cell
 * gap at (3, 2)), an L at (3, 3)/(2, 4)/(3, 4) and two blocks at (5, 2) and
 * (0, 5), so most moves out of and into a zone need a route.
 *
 *   row 0: S W S S W S
 *   row 1: S W . . W S
 *   row 2: . W W . W W
 *   row 3: S S . W . .
 *   row 4: F . W W . F
 *   row 5: W . S . S .
 */
export function mazePlacements(ids = { soldier: 's', factory: 'f', wall: 'w' }): PlacementDTO[] {
  const out: PlacementDTO[] = [];
  for (const [c, r] of [[0, 0], [2, 0], [3, 0], [5, 0], [0, 1], [5, 1], [0, 3], [1, 3], [2, 5], [4, 5]] as const) out.push(at(c, r, ids.soldier));
  out.push(at(0, 4, ids.factory), at(5, 4, ids.factory));
  for (const [c, r] of [[1, 0], [4, 0], [1, 1], [4, 1], [1, 2], [2, 2], [4, 2], [5, 2], [3, 3], [2, 4], [3, 4], [0, 5]] as const) out.push(at(c, r, ids.wall));
  return out;
}

/** Factory brain: rally at the nearest enemy that isn't a wall (loops over all enemies). */
export const swarmFactoryBrain = scripted((self, enemies: OtherView[], _allies, world) => {
  let best = Infinity;
  let spot = world.center;
  for (const e of enemies) {
    if (e.type === 'wall') continue;
    const d = Math.hypot(e.x - self.x, e.y - self.y);
    if (d < best) {
      best = d;
      spot = { x: e.x, y: e.y };
    }
  }
  return { action: 'rally', destination: spot };
});

export interface WorstCaseSpec {
  playerId: string;
  seat: number;
  zone: ZoneRef;
  placements: PlacementDTO[];
}

/** The 8 players' zones and placements on Ring 8 (round 1 zone assignment). */
export function worstCaseSpecs(): { layout: MapLayout; specs: WorstCaseSpec[] } {
  const layout = mapFor('ring', 8);
  const ids = Array.from({ length: 8 }, (_, i) => `p${i}`);
  const zones = assignMapZones(layout, ids, 1);
  return { layout, specs: ids.map((id, seat) => ({ playerId: id, seat, zone: zones.get(id)!, placements: worstCasePlacements() })) };
}

/** Run the worst case with fake runners (in-process brains). */
export async function buildingsWorstCase(opts: { ticks: number; seed: number; config?: GameConfig }) {
  const config = opts.config ?? deepMerge(DEFAULT_CONFIG, { timers: { battleTicks: opts.ticks } });
  const { layout, specs } = worstCaseSpecs();
  const { setups } = fakePlayers(
    specs.map((s) => ({
      ...s,
      units: [design('s', stats({ type: 'soldier' })), design('f', SWARM_FACTORY, undefined, config), design('w', BASIC_WALL)],
      brains: { s: soldierBrain, f: swarmFactoryBrain },
    })),
    opts.seed,
  );
  const engine = new BattleEngine({ players: setups, config, seed: opts.seed, map: { style: layout.style, width: layout.width } });
  const result = await engine.run();
  return { result, frames: engine.frames, tickMs: engine.tickMs };
}
