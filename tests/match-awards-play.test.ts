// Match awards on /play (plan §12.1): the player's own awards as cheers and
// the winners line of each award in the full list (DOM-free).

import { describe, expect, it } from 'vitest';
import { AWARDS, type AwardId, type MatchAwardDTO, awardStatText } from '@pixel-clash/shared';
import { awardWinnersText, myAwardLines } from '../packages/client/src/play/awards.js';

function award(id: AwardId, winners: string[], value = 3): MatchAwardDTO {
  const a = AWARDS[id];
  return { id, emoji: a.emoji, title: a.title, rule: a.rule, value, text: awardStatText(id, value), winners: winners.map((w, i) => ({ playerId: w, name: w, seat: i, bestUnit: null })) };
}

describe('/play match awards', () => {
  it('cheers the player\'s own awards ("You won 🎯 Sharpshooter — 312 px KO!"), shared ones too', () => {
    const cb = award('comeback', ['me'], 2);
    cb.winners[0]!.detail = '4th → 2nd';
    const list = [award('sharpshooter', ['me'], 312), award('biggestHitter', ['ava', 'me'], 1200), award('champion', ['ava'], 9), cb];
    expect(myAwardLines(list, 'me').map((l) => l.text)).toEqual([
      'You won 🎯 Sharpshooter — 312 px KO!',
      'You share 💥 Biggest Hitter — 1,200 damage!',
      'You won 📈 Comeback — climbed 2 places (4th → 2nd)!',
    ]);
    expect(myAwardLines(list, 'nobody')).toEqual([]);
    expect(myAwardLines(undefined, 'me')).toEqual([]);
  });

  it('names the winners, the player as "you"', () => {
    expect(awardWinnersText(award('champion', ['ava']), 'me')).toBe('ava');
    expect(awardWinnersText(award('champion', ['ava', 'me']), 'me')).toBe('ava & you');
    expect(awardWinnersText(award('champion', ['ava', 'ben', 'cy']), 'me')).toBe('ava, ben & cy');
  });
});
