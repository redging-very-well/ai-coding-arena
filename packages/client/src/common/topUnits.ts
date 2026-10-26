// "Top damage" units of a round, DOM-free:
// the text lines, the player's own highlight and the fallback look. Shared by
// /screen (RESULTS card), /play (RESULTS and Past battles).

import type { StatsSnapshot, TopUnitDTO } from '@pixel-clash/shared';

const PLACE = ['🥇', '🥈', '🥉'];

/** Medal (1-3) or "#4". */
export function topRankLabel(rank: number): string {
  return PLACE[rank - 1] ?? `#${rank}`;
}

/** "312 damage · 2 KOs" (KOs left out when 0). */
export function topUnitLine(t: Pick<TopUnitDTO, 'damage' | 'kills'> & { healing?: number | undefined }, damage = t.damage): string {
  // M8.8: thousands separators (5× bigger numbers) and the HP its heals restored.
  const heal = (t.healing ?? 0) >= 1 ? ` · ${Math.round(t.healing!).toLocaleString('en-US')} healed` : '';
  return `${Math.round(damage).toLocaleString('en-US')} damage${t.kills > 0 ? ` · ${t.kills} KO${t.kills === 1 ? '' : 's'}` : ''}${heal}`;
}

/** "by Sam" (+ "left the game" for a player kicked during the battle). */
export function topUnitBy(t: Pick<TopUnitDTO, 'playerName' | 'left'>): string {
  return `by ${t.playerName}${t.left ? ' (left the game)' : ''}`;
}

/** The player's own best entry and a cheer for it, or null. */
export function myTopUnit(top: readonly TopUnitDTO[] | undefined, playerId: string | undefined): { unit: TopUnitDTO; text: string } | null {
  if (!top || !playerId) return null;
  const mine = top.filter((t) => t.playerId === playerId).sort((a, b) => a.rank - b.rank)[0];
  if (!mine) return null;
  const name = mine.displayName;
  return {
    unit: mine,
    text: mine.rank === 1 ? `Your ${name} hit hardest! 💥` : `Your ${name} made the top damage list (${topRankLabel(mine.rank)})! 💥`,
  };
}

const FALLBACK_STATS: Pick<StatsSnapshot, 'color' | 'type' | 'shape'> = { color: '#9aa3c7', type: 'soldier', shape: 'circle' };

/** What resolveSprite needs for a top unit (stats may be missing on older results). */
export function topUnitLook(t: Pick<TopUnitDTO, 'sprite' | 'spriteHidden' | 'stats'>) {
  return { sprite: t.sprite, spriteHidden: t.spriteHidden, stats: t.stats ?? FALLBACK_STATS };
}

/** Sprite cache key: the same name+player keeps its baked frames. */
export function topUnitKey(t: Pick<TopUnitDTO, 'playerId' | 'unitId' | 'spriteHidden' | 'sprite'>, round: number): string {
  return `top-${round}-${t.playerId}-${t.unitId}/${t.spriteHidden || !t.sprite ? 'fallback' : 'own'}`;
}

/** The projector shows at most `max` cards (big ties: "+N more with the same damage"). */
export function projectorTopCards<T>(top: readonly T[], max = 4): { cards: T[]; more: number } {
  return { cards: top.slice(0, max), more: Math.max(0, top.length - max) };
}
