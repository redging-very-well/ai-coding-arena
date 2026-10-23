// The round's "top damage" units on /play (plan §12.1): a compact list with
// each unit's sprite, the player who fielded it (seat badge + name) and its
// damage; the player's own unit is highlighted with a cheer.

import type { TopUnitDTO } from '@pixel-clash/shared';
import { resolveSprite } from '../../common/render/sprites.js';
import { seatStyle } from '../../common/seats.js';
import { myTopUnit, topRankLabel, topUnitBy, topUnitKey, topUnitLine, topUnitLook } from '../../common/topUnits.js';
import { cx } from '../../common/ui.js';
import { SpriteView } from './SpriteView.js';
import { TeamChip } from './TeamPanel.js';

export function TopUnits({ top, round, meId }: { top: readonly TopUnitDTO[] | undefined; round: number; meId: string | undefined }) {
  if (!top || top.length === 0) return null;
  const mine = myTopUnit(top, meId);
  return (
    <div class="top-units">
      <h3>💥 Top damage</h3>
      {mine && <p class="good-news">{mine.text}</p>}
      <ol class="top-list">
        {top.map((t) => {
          const seat = seatStyle(t.seat);
          return (
            <li key={`${t.playerId}-${t.unitId}`} class={cx('top-row', t.playerId === meId && 'me')} style={{ '--seat': seat.color }}>
              <span class="top-rank">{topRankLabel(t.rank)}</span>
              <span class="top-sprite">
                <SpriteView spec={resolveSprite(topUnitLook(t))} specKey={topUnitKey(t, round)} outline={seat.color} width={36} />
              </span>
              <span class="top-text">
                <strong>{t.displayName}</strong>
                <span class="top-by">
                  <span class="seat-num" style={{ '--seat': seat.color }}>
                    {seat.symbol}
                  </span>{' '}
                  {t.playerId === meId ? 'by you' : topUnitBy(t)}
                  {t.teamId !== undefined && <TeamChip teamId={t.teamId} />}
                </span>
              </span>
              <span class="top-dmg">{topUnitLine(t)}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
