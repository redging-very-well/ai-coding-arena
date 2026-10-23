// "Top damage" units of a round (plan §9 Results): per fielded unit TYPE per
// player (all copies of that design summed), ranked by effective damage, at
// the released tick (a Skip uses the counters at the shown playback tick, as
// the ranking does). Public once the result is released: fielded types were
// revealed at START already; never source code.

import type { BattleRevealDTO, TopUnitDTO, UnitBattleSummaryDTO } from '@pixel-clash/shared';

export interface TopUnitsInput {
  reveal: Pick<BattleRevealDTO, 'players'>;
  /** playerId → unitId → the round's summary (copies summed). */
  summaries: Record<string, Record<string, UnitBattleSummaryDTO>>;
  /** Players kicked during the battle: still listed (the damage happened), marked `left`. */
  kicked?: ReadonlySet<string>;
  /** How many places to show (config scoring.topUnitsShown); ties share a place and are all shown. */
  shown: number;
}

export function topUnits({ reveal, summaries, kicked, shown }: TopUnitsInput): TopUnitDTO[] {
  const rows: TopUnitDTO[] = [];
  for (const p of reveal.players) {
    for (const [unitId, s] of Object.entries(summaries[p.playerId] ?? {})) {
      const damage = Math.round(s.damageDealt);
      if (damage <= 0) continue;
      const type = p.units.find((u) => u.unitId === unitId);
      const row: TopUnitDTO = {
        rank: 0,
        unitId,
        displayName: type?.name ?? s.name ?? unitId,
        playerId: p.playerId,
        playerName: p.name,
        seat: p.seat,
        damage,
        kills: s.kills,
        valueDestroyed: Math.round(s.valueDestroyed),
        copies: s.fielded,
        sprite: type?.spriteHidden ? null : (type?.sprite ?? null),
        spriteHidden: type?.spriteHidden ?? false,
      };
      if (type) row.stats = type.stats;
      if (p.teamId !== undefined) row.teamId = p.teamId;
      if (type?.borrowedFrom) row.borrowedFrom = type.borrowedFrom.creatorName;
      if (kicked?.has(p.playerId)) row.left = true;
      rows.push(row);
    }
  }
  rows.sort((a, b) => b.damage - a.damage || b.kills - a.kills || a.seat - b.seat || a.displayName.localeCompare(b.displayName));
  // Competition ranking on damage: equal damage shares a place (1, 1, 3).
  rows.forEach((r, i) => (r.rank = i > 0 && rows[i - 1]!.damage === r.damage ? rows[i - 1]!.rank : i + 1));
  return rows.filter((r) => r.rank <= Math.max(1, shown));
}
