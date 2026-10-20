// Always-visible header (plan §12.1): name + seat colour, phase banner with
// countdown, round, points, and the connection dot.

import { seatStyle } from '../../common/seats.js';
import { cx, formatClock, PHASE_TEXT, ticksToSeconds } from '../../common/ui.js';
import { useStore } from '../store.js';

export function Header() {
  const st = useStore();
  const g = st.game;
  const p = st.player;
  const seat = seatStyle(p?.seat);
  const points = g?.scoreboard.find((s) => s.playerId === p?.id)?.points ?? 0;
  const secs = g?.phase === 'BATTLE' && g.battle ? ticksToSeconds(g.battle.totalTicks - g.battle.tick) : (g?.timer.secondsLeft ?? null);
  const urgent = secs !== null && secs <= 10 && (g?.phase === 'BATTLE' || g?.phase === 'PLAN' || g?.phase === 'PLACEMENT');
  const text = g ? PHASE_TEXT[g.phase] : null;
  const showRound = g && g.phase !== 'LOBBY';

  return (
    <header class={cx('top', p && `seat-${p.seat}`, g && `phase-${g.phase.toLowerCase()}`)}>
      <div class="who">
        {p ? (
          <>
            <span class="seat-badge" style={{ background: seat.color }} title={`${seat.name} team`}>
              {seat.symbol}
            </span>
            <span class="who-name">{p.name}</span>
          </>
        ) : (
          <span class="pixel small">PIXEL CLASH</span>
        )}
      </div>
      <div class="phase">
        <div class="phase-title pixel">{text?.title ?? '…'}</div>
        <div class="phase-hint">
          {showRound && (
            <span class="round">
              Round {g.round} of {g.rounds}
              {' · '}
            </span>
          )}
          {text?.hint}
          {g?.armory?.enabled && (
            <span class="armory-chip" title="Open Armory: units that fought can be borrowed by everyone else in later rounds">
              {' · '}💡 Open Armory
            </span>
          )}
        </div>
      </div>
      <div class="clock-box">
        {secs !== null && (
          <div class={cx('clock pixel', urgent && 'urgent', g?.timer.paused && g.phase !== 'BATTLE' && 'paused')} aria-label="time left">
            {formatClock(secs)}
          </div>
        )}
        {g?.timer.paused && g.phase !== 'BATTLE' && <div class="dim small">paused</div>}
        {g?.phase === 'PLACEMENT' && g.timer.expired && <div class="dim small">waiting for START</div>}
      </div>
      {p && (
        <div class="points" title="Your points">
          <span class="pixel">{points}</span>
          <span class="small dim">pts</span>
        </div>
      )}
      <span class={cx('conn', st.socket)} title={st.socket === 'open' ? 'Connected' : 'Reconnecting…'} />
    </header>
  );
}
