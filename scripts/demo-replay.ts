// Generate a canned 4-player battle for the renderer demo page
// (packages/client/src/common/render/__demo). Runs the REAL path: the starter
// templates and some good test fixtures go through the validator (sprites
// included), isolated-vm runners and the BattleEngine, and the result is
// written as a ReplayDTO.
//
//   npx tsx --no-node-snapshot --conditions=source scripts/demo-replay.ts [seed] [--showcase]
//
// --showcase swaps in the units of scripts/demo-showcase (fire / ice / lightning
// shots, splash, haste / might / shield auras, healers) and writes
// replay-showcase.json, for the 3D observer: /observe?demo=showcase.
//
// Then `npm run dev` and open http://localhost:5173/src/common/render/__demo/

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  DEFAULT_CONFIG,
  assignZones,
  emptyBadgeCounts,
  type BattleEndDTO,
  type BattleRevealDTO,
  type PlacementDTO,
  type ReplayDTO,
  type RevealedUnitDTO,
  type StatsSnapshot,
} from '@pixel-clash/shared';
import { validateDetailed } from '../packages/server/src/validator/validate.js';
import { createIvmRunnerFactory } from '../packages/server/src/sandbox/ivmRunner.js';
import { BattleEngine, buildInstances, createBattleRunners, designFor, type BattlePlayerSetup } from '../packages/server/src/sim/engine.js';

const root = new URL('../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
const config = DEFAULT_CONFIG;
const showcase = process.argv.includes('--showcase');
const seed = Number(process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 4242);

interface Design {
  reveal: RevealedUnitDTO;
  compiledJs: string;
  stats: StatsSnapshot;
}

async function design(path: string): Promise<Design> {
  const d = await validateDetailed(read(path), {}, config);
  if (!d.result.ok || !d.compiledJs) throw new Error(`${path} failed validation: ${JSON.stringify(d.result)}`);
  const u = d.result.unit;
  return {
    reveal: { unitId: u.unitId, name: u.stats.name, stats: u.stats, cost: u.cost, sprite: u.sprite ?? null, spriteHidden: false },
    compiledJs: d.compiledJs,
    stats: u.stats,
  };
}

const SOLDIER = 'packages/starter-kit/units/basic_soldier.js';
const TOWER = 'packages/starter-kit/units/basic_tower.js';
const roster: Array<{ playerId: string; name: string; files: string[] }> = [
  { playerId: 'p-ada', name: 'Ada', files: [SOLDIER, TOWER] },
  { playerId: 'p-ben', name: 'Ben', files: ['tests/fixtures/units/good/speedy_scout.js', TOWER] },
  { playerId: 'p-cy', name: 'Cy', files: ['tests/fixtures/units/good/big_tank.js', 'tests/fixtures/units/good/sniper_tower.js'] },
  { playerId: 'p-dee', name: 'Dee', files: ['tests/fixtures/units/good/pixel_bat.js', SOLDIER] },
];

/** Soldiers in the front cells, towers just behind. */
function placements(designs: Design[]): PlacementDTO[] {
  const soldierCells: Array<[number, number]> = [[0, 0], [1, 0], [0, 1], [1, 1]];
  const towerCells: Array<[number, number]> = [[2, 0], [0, 2], [2, 2]];
  const out: PlacementDTO[] = [];
  const soldiers = designs.filter((d) => d.stats.type === 'soldier');
  const towers = designs.filter((d) => d.stats.type === 'tower');
  soldierCells.forEach(([col, row], i) => {
    const d = soldiers[i % Math.max(1, soldiers.length)] ?? towers[0]!;
    out.push({ unitId: d.reveal.unitId, col, row });
  });
  towerCells.forEach(([col, row], i) => {
    const d = towers[i % Math.max(1, towers.length)] ?? soldiers[0]!;
    out.push({ unitId: d.reveal.unitId, col, row });
  });
  return out;
}

const SHOW = 'scripts/demo-showcase/';
const showcaseRoster = [
  { playerId: 'p-ada', name: 'Ada', files: [SHOW + 'fire_soldier.js', SHOW + 'field_medic.js', SHOW + 'lightning_tower.js'] },
  { playerId: 'p-ben', name: 'Ben', files: [SHOW + 'frost_soldier.js', SHOW + 'haste_soldier.js', SHOW + 'frost_tower.js'] },
  { playerId: 'p-cy', name: 'Cy', files: [SHOW + 'might_tank.js', SHOW + 'shield_soldier.js', SHOW + 'fire_tower.js'] },
  { playerId: 'p-dee', name: 'Dee', files: [SHOW + 'storm_soldier.js', SHOW + 'combat_medic.js', SHOW + 'shield_tower.js'] },
];
if (showcase) roster.splice(0, roster.length, ...showcaseRoster);

const zones = assignZones(roster.map((r) => r.playerId), 0);
const players = await Promise.all(
  roster.map(async (r, seat) => {
    const designs = await Promise.all(r.files.map(design));
    return { ...r, seat, zone: zones.get(r.playerId)!, designs, placements: placements(designs) };
  }),
);

const ivm = createIvmRunnerFactory();
const runners = await createBattleRunners(
  ivm,
  players.map((p) => ({
    playerId: p.playerId,
    seat: p.seat,
    units: p.designs.map((d) => ({ unitId: d.reveal.unitId, compiledJs: d.compiledJs, stats: d.stats })),
  })),
  config,
  seed,
);
const setups: BattlePlayerSetup[] = players.map((p) => ({
  playerId: p.playerId,
  seat: p.seat,
  zone: p.zone,
  units: p.designs.map((d) => designFor(d.reveal.unitId, d.stats, config)),
  placements: p.placements,
  runner: runners.get(p.playerId)!,
}));
const engine = new BattleEngine({ players: setups, config, seed });
const result = await engine.run();

const reveal: BattleRevealDTO = {
  round: 1,
  totalTicks: config.timers.battleTicks,
  players: players.map((p) => ({
    playerId: p.playerId,
    name: p.name,
    seat: p.seat,
    zone: p.zone,
    units: p.designs.map((d) => d.reveal),
    instances: buildInstances({ seat: p.seat, zone: p.zone, units: setups[p.seat]!.units, placements: p.placements }),
  })),
};
const end: BattleEndDTO = {
  round: 1,
  endTick: result.endTick,
  reason: result.endReason === 'elimination' ? 'elimination' : 'timeout',
  ranking: result.ranking,
  scoreboard: players.map((p) => {
    const r = result.ranking.find((e) => e.playerId === p.playerId);
    const badges = emptyBadgeCounts();
    for (const b of r?.badges ?? []) badges[b] += 1;
    return { playerId: p.playerId, name: p.name, seat: p.seat, points: r?.pointsGained ?? 0, damage: r?.damage ?? 0, place: r?.place ?? players.length, badges };
  }),
};
const replay: ReplayDTO = { round: 1, reveal, frames: engine.frames, end };

const outDir = new URL('packages/client/src/common/render/__demo/', root);
mkdirSync(outDir, { recursive: true });
const outFile = new URL(showcase ? 'replay-showcase.json' : 'replay.json', outDir);
writeFileSync(outFile, JSON.stringify(replay));
console.log(
  `[demo-replay] ${engine.frames.length} frames, ${result.endTick} ticks (${result.endReason}); ` +
    `ranking ${result.ranking.map((r) => `${r.playerId}#${r.place}`).join(' ')} → ${outFile.pathname}`,
);
process.exit(0);
