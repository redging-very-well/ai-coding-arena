// MATCH_RESULTS on /play (plan §12.1): the player's own match awards
// highlighted, then every award of the match with its winner(s), the stat and
// the winner's best unit (sprite of a design revealed when it was fielded).

import type { GameStateDTO } from '@pixel-clash/shared';
import { resolveSprite } from '../../common/render/sprites.js';
import { seatStyle } from '../../common/seats.js';
import { topUnitLook } from '../../common/topUnits.js';
import { cx } from '../../common/ui.js';
import { awardWinnersText, myAwardLines } from '../awards.js';
import { SpriteView } from './SpriteView.js';

export function MatchAwards({ game, meId }: { game: GameStateDTO; meId: string | undefined }) {
  const awards = game.matchAwards ?? [];
  if (awards.length === 0) return null;
  const mine = myAwardLines(awards, meId);
  return (
    <div class="match-awards">
      <h3>🏅 Match awards</h3>
      {mine.length > 0 ? (
        <div class="my-badges">
          {mine.map((m, i) => (
            <div key={m.award.id} class="player-badge my-award" style={{ animationDelay: `${300 + i * 300}ms` }}>
              <span class="kb-emoji">{m.award.emoji}</span>
              <strong>{m.text}</strong>
            </div>
          ))}
        </div>
      ) : (
        <p class="dim">No award this time. Every battle counts: great playing!</p>
      )}
      <ul class="award-list">
        {awards.map((a) => {
          const won = a.winners.some((w) => w.playerId === meId);
          const w = a.winners.find((x) => x.playerId === meId) ?? a.winners[0]!;
          const seat = seatStyle(w.seat);
          const u = w.bestUnit;
          return (
            <li key={a.id} class={cx('award-row', won && 'me')} style={{ '--seat': seat.color }}>
              <span class="award-emoji">{a.emoji}</span>
              <span class="award-text">
                <strong>{a.title}</strong>
                <span class="dim small">{a.rule}</span>
              </span>
              <span class="award-who">
                {u && (
                  <SpriteView
                    spec={resolveSprite(topUnitLook(u))}
                    specKey={`award-${w.playerId}-${u.unitId}/${u.spriteHidden || !u.sprite ? 'fallback' : 'own'}`}
                    outline={seat.color}
                    width={32}
                    title={u.name}
                  />
                )}
                <span>{awardWinnersText(a, meId)}</span>
              </span>
              <span class="award-stat">{a.text}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
