// Match awards on /play (plan §12.1, §9 Match awards), DOM-free: the
// player's own awards as cheers ("You won 🎯 Sharpshooter — 312 px KO!") and
// the winners line of each award in the full list.

import type { MatchAwardDTO } from '@pixel-clash/shared';

/** One cheer per award this player won (ceremony order); shared awards say "share". */
export function myAwardLines(awards: readonly MatchAwardDTO[] | undefined, meId: string | undefined): Array<{ award: MatchAwardDTO; text: string }> {
  if (!awards || !meId) return [];
  const out: Array<{ award: MatchAwardDTO; text: string }> = [];
  for (const a of awards) {
    const me = a.winners.find((w) => w.playerId === meId);
    if (!me) continue;
    const verb = a.winners.length > 1 ? 'share' : 'won';
    const detail = me.detail && a.id === 'comeback' ? ` (${me.detail})` : '';
    out.push({ award: a, text: `You ${verb} ${a.emoji} ${a.title} — ${a.text}${detail}!` });
  }
  return out;
}

/** "Ava & you" / "you" / "Ava, Ben & Cy": the winners of an award, the player called "you". */
export function awardWinnersText(a: Pick<MatchAwardDTO, 'winners'>, meId: string | undefined): string {
  const names = a.winners.map((w) => (w.playerId === meId ? 'you' : w.name));
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
}
