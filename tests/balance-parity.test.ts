// Runner parity for the balance tooling. The balance round robins play the archetype brains on the
// LEAN runner (helpers/balance.ts BrainRunner: plain functions in this
// process, no isolate, no IPC), about 10× faster than the real sandbox. That
// is only sound if the lean runner gives exactly the battles the real sandbox
// would: here the same brains (helpers/brains.ts, transpiled like a player's
// unit by helpers/brainUnits.ts) run on isolated-vm (the server default, one
// child process per player) and on node:vm ('inproc-unsafe'), and every frame
// must hash the same, with the same result, as on the lean runner.
//
// The sample covers every brain: chase and hold soldiers, towers, medics and
// auras, focus fire (soldiers, hold soldiers and towers), backline divers (dive, flank and the factories'
// dive raid), every factory order (rally, guard, guardTank, swarm, breach, defend, hold), walls, elements
// and splash, on both duel maps and both seeds.
// Runs in the balance pass (vitest.config.ts BALANCE_FILES), on its own.

import { describe, expect, it } from 'vitest';
import type { MapStyle } from '@pixel-clash/shared';
import { BALANCE_CONFIG, archetypeByKey, balanceBattle, type BalanceBattle, type BalanceRunnerKind } from './helpers/balance.js';

const SAMPLE: Array<[string, string, MapStyle, number, [number, number], number]> = [
  ['bricks', 'tanks', 'corners', 4, [0, 1], 11],
  ['swarm', 'fortress', 'ring', 8, [0, 1], 4242],
  ['shatter', 'healerball', 'corners', 4, [0, 2], 11],
  ['archers', 'medictent', 'ring', 8, [2, 0], 4242],
  ['frostnest', 'storm', 'ring', 8, [0, 1], 11],
  ['elemfactories', 'runners', 'corners', 4, [1, 0], 4242],
  ['brutes', 'homeguard', 'ring', 8, [0, 2], 11],
  ['buffedrush', 'bigFriends', 'corners', 4, [0, 1], 4242],
  ['dormant', 'templates', 'ring', 8, [1, 0], 11],
  ['blizzard', 'mortars', 'corners', 4, [2, 0], 4242],
  // Focus fire: chase-focus soldiers vs medics; hold-focus soldiers with focus fire towers.
  ['hugetanks', 'healerball', 'corners', 4, [0, 1], 11],
  ['overload', 'snipers', 'ring', 8, [0, 2], 4242],
  // Backline divers: flankers past the front to glass snipers, divers to the medics, runner factories swarming the frost archers.
  ['assassins', 'exploit', 'corners', 4, [0, 1], 11],
  ['cavalry', 'healerball', 'ring', 8, [0, 2], 4242],
  ['raiders', 'shatter', 'corners', 4, [1, 0], 11],
];

/** Everything a balance run reads from a battle, minus the wall-clock time. */
function fingerprint(b: BalanceBattle) {
  return {
    frameHash: b.frameHash,
    places: b.places,
    endTick: b.result.endTick,
    ranking: b.result.ranking,
    units: b.result.units,
    lost: b.lost,
    standing: b.standing,
    effects: b.effects,
    heals: b.heals.length,
    firstContactTick: b.firstContactTick,
    suddenDeathBy: b.suddenDeathBy,
  };
}

const play = (kind: BalanceRunnerKind, [a, b, style, players, zones, seed]: (typeof SAMPLE)[number]) =>
  balanceBattle(style, players, [{ archetype: archetypeByKey(a), zone: zones[0] }, { archetype: archetypeByKey(b), zone: zones[1] }], seed, BALANCE_CONFIG, true, kind);

describe('the lean balance runner plays exactly like the real sandbox (parity)', () => {
  it.each(SAMPLE.map((s) => [`${s[0]} vs ${s[1]} (${s[2]} ${s[4].join(',')}, seed ${s[5]})`, s] as const))(
    '%s: identical frames and result on lean, node:vm and isolated-vm',
    async (_label, s) => {
      const lean = await play('lean', s);
      expect(lean.result.endTick).toBeGreaterThan(0);
      const want = fingerprint(lean);
      expect(fingerprint(await play('vm', s))).toEqual(want);
      expect(fingerprint(await play('ivm', s))).toEqual(want);
    },
    60_000,
  );
});
