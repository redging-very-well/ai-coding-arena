// /play Past battles and the top damage units (plan §12.1), DOM-free parts:
// which rounds are listed, the picked round, a past round's ranking rows,
// and the top-unit texts with the player's own highlight.

import { describe, expect, it } from 'vitest';
import type { RankingEntryDTO, TopUnitDTO } from '@pixel-clash/shared';
import { myTopUnit, projectorTopCards, topRankLabel, topUnitBy, topUnitLine, topUnitLook } from '../packages/client/src/common/topUnits.js';
import { pastRankRows, pickRound, releasedRounds } from '../packages/client/src/play/logic.js';

const top = (o: Partial<TopUnitDTO>): TopUnitDTO => ({
  rank: 1,
  unitId: 'ninja',
  displayName: 'Ninja',
  playerId: 'a',
  playerName: 'Sam',
  seat: 0,
  damage: 312,
  kills: 2,
  valueDestroyed: 300,
  copies: 3,
  sprite: null,
  spriteHidden: false,
  ...o,
});

describe('past battles round picker', () => {
  it('lists only released rounds of this match (never a battle still playing)', () => {
    expect(releasedRounds(null)).toEqual([]);
    expect(releasedRounds({ phase: 'LOBBY', round: 0 })).toEqual([]);
    expect(releasedRounds({ phase: 'PLAN', round: 1 })).toEqual([]);
    expect(releasedRounds({ phase: 'PLAN', round: 3 })).toEqual([1, 2]);
    expect(releasedRounds({ phase: 'BATTLE', round: 2 })).toEqual([1]);
    expect(releasedRounds({ phase: 'RESULTS', round: 2 })).toEqual([1, 2]);
    expect(releasedRounds({ phase: 'MATCH_RESULTS', round: 3 })).toEqual([1, 2, 3]);
  });

  it('keeps the picked round while listed, else shows the latest', () => {
    expect(pickRound([], 1)).toBeNull();
    expect(pickRound([1, 2], null)).toBe(2);
    expect(pickRound([1, 2], 1)).toBe(1);
    expect(pickRound([1, 2], 5)).toBe(2);
  });

  it('builds a past ranking with names, the breakdown and my row', () => {
    const ranking = [
      { playerId: 'b', place: 2, pointsGained: 1, placePoints: 0, damageBonus: 1, valueBonus: 0, damage: 40.4, badges: [] },
      { playerId: 'a', place: 1, pointsGained: 3, placePoints: 1, damageBonus: 1, valueBonus: 1, damage: 99.6, badges: ['lastStanding'] },
    ] as unknown as RankingEntryDTO[];
    const rows = pastRankRows({ ranking, scoreboard: [{ playerId: 'a', name: 'Ann', seat: 0 }] }, [{ id: 'b', name: 'Ben', seat: 1 }], 'b');
    expect(rows.map((r) => [r.place, r.name, r.placePoints, r.damageBonus, r.valueBonus, r.pointsGained, r.damage, r.me])).toEqual([
      [1, 'Ann', 1, 1, 1, 3, 100, false],
      [2, 'Ben', 0, 1, 0, 1, 40, true],
    ]);
    expect(rows[0]!.badges).toEqual(['lastStanding']);
  });
});

describe('top damage texts', () => {
  it('words a unit and who fielded it', () => {
    expect(topUnitLine(top({}))).toBe('312 damage · 2 KOs');
    expect(topUnitLine(top({ kills: 1 }))).toBe('312 damage · 1 KO');
    expect(topUnitLine(top({ kills: 0 }), 100)).toBe('100 damage');
    expect(topUnitBy(top({}))).toBe('by Sam');
    expect(topUnitBy(top({ left: true }))).toBe('by Sam (left the game)');
    expect(topRankLabel(1)).toBe('🥇');
    expect(topRankLabel(4)).toBe('#4');
    expect(topUnitLook(top({})).stats.type).toBe('soldier'); // fallback look without stats
  });

  it('cheers the player’s own unit', () => {
    const list = [top({}), top({ rank: 2, playerId: 'b', playerName: 'Ben', displayName: 'Ogre (Ninja Sam)', unitId: 'armory:1' })];
    expect(myTopUnit(list, 'a')?.text).toBe('Your Ninja hit hardest! 💥');
    expect(myTopUnit(list, 'b')?.text).toBe('Your Ogre (Ninja Sam) made the top damage list (🥈)! 💥');
    expect(myTopUnit(list, 'c')).toBeNull();
    expect(myTopUnit(undefined, 'a')).toBeNull();
  });
});

describe('projector top damage cards', () => {
  it('shows at most 4 cards and counts the rest', () => {
    expect(projectorTopCards([1, 2, 3])).toEqual({ cards: [1, 2, 3], more: 0 });
    expect(projectorTopCards([1, 2, 3, 4, 5, 6, 7, 8])).toEqual({ cards: [1, 2, 3, 4], more: 4 });
  });
});
