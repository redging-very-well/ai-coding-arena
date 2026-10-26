// /screen RESULTS banner: "No battle this time" only when nothing
// was fought; a battle the host skipped partway shows a normal end (Skip
// ranks from the playback tick).

import { describe, expect, it } from 'vitest';
import type { RankingEntryDTO } from '@pixel-clash/shared';
import { endReasonText } from '../packages/client/src/screen/model.js';

const entry = (o: Partial<RankingEntryDTO>): RankingEntryDTO =>
  ({ playerId: 'a', place: 1, damage: 0, kills: 0, livingCost: 0, eliminatedAtTick: null, pointsGained: 0, badges: [], ...o }) as RankingEntryDTO;

describe('endReasonText', () => {
  it('natural ends keep their text', () => {
    expect(endReasonText({ reason: 'elimination', endTick: 900, ranking: [] })).toBe('Last army standing!');
    expect(endReasonText({ reason: 'timeout', endTick: 5400, ranking: [] })).toBe("Time's up!");
  });

  it('a skip before any fighting is "No battle this time"', () => {
    const ranking = [entry({ playerId: 'a', livingCost: 300 }), entry({ playerId: 'b', livingCost: 200 })];
    expect(endReasonText({ reason: 'skipped', endTick: 0, ranking })).toBe('No battle this time');
    // Armies walked for a bit, but nobody hit anybody.
    expect(endReasonText({ reason: 'skipped', endTick: 240, ranking })).toBe('No battle this time');
  });

  it('a skip after real fighting reads like a normal end', () => {
    const two = [entry({ playerId: 'a', damage: 120, kills: 1, livingCost: 300 }), entry({ playerId: 'b', damage: 40, livingCost: 90 })];
    expect(endReasonText({ reason: 'skipped', endTick: 1800, ranking: two })).toBe('Battle over!');
    const one = [entry({ playerId: 'a', damage: 400, kills: 4, livingCost: 300 }), entry({ playerId: 'b', damage: 40, livingCost: 0, eliminatedAtTick: 1500 })];
    expect(endReasonText({ reason: 'skipped', endTick: 1800, ranking: one })).toBe('Last army standing!');
    // Team mode: two living players on the same team are one army.
    const team = [
      entry({ playerId: 'a', teamId: 1, damage: 10, livingCost: 50 }),
      entry({ playerId: 'b', teamId: 1, livingCost: 70 }),
      entry({ playerId: 'c', teamId: 2, damage: 5 }),
    ];
    expect(endReasonText({ reason: 'skipped', endTick: 600, ranking: team })).toBe('Last army standing!');
  });
});
