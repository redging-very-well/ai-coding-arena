// Always-visible header (plan §12.1): name + seat colour and number badge,
// team chip (team mode), phase banner with countdown, round, map, points, and
// the sound toggle (muted by default) and the connection dot.

import { mapName, teamOfPlayer } from '../../common/maps.js';
import { seatStyle } from '../../common/seats.js';
import { cx, formatClock, PHASE_TEXT, ticksToSeconds } from '../../common/ui.js';
import { getStore, useStore } from '../store.js';
import { TeamChip } from './TeamPanel.js';

export function Header() {
  const st = useStore();
  const sound = getStore().sound;
  const g = st.game;
  const p = st.player;
  const seat = seatStyle(p?.seat);
  const points = g?.scoreboard.find((s) => s.playerId === p?.id)?.points ?? 0;
  const secs = g?.phase === 'BATTLE' && g.battle ? ticksToSeconds(g.battle.totalTicks - g.battle.tick) : (g?.timer.secondsLeft ?? null);
  const urgent = secs !== null && secs <= 10 && (g?.phase === 'BATTLE' || g?.phase === 'PLAN' || g?.phase === 'PLACEMENT');
  const text = g ? PHASE_TEXT[g.phase] : null;
  const showRound = g && g.phase !== 'LOBBY';
  const team = st.priv?.team ?? null;
  const pubTeam = teamOfPlayer(g?.match?.teams, p?.id);
  const teamId = team?.teamId ?? st.priv?.teamId ?? pubTeam?.teamId;
  const teamName = team?.name ?? pubTeam?.name;
  const map = g?.match?.map;

  return (
    <header class={cx('top', p && `seat-${p.seat}`, g && `phase-${g.phase.toLowerCase()}`)}>
      <div class="who">
        {p ? (
          <>
            <span class="seat-badge" style={{ background: seat.color, color: seat.ink }} title={`Seat ${seat.symbol} (${seat.name})`}>
              {seat.symbol}
            </span>
            <span class="who-name">{p.name}</span>
            {teamId !== undefined && <TeamChip teamId={teamId} name={teamName} />}
            {st.priv?.benched && <span class="dim small">next match</span>}
          </>
        ) : (
          <span class="pixel small">PIXEL CLASH</span>
        )}
      </div>
      <div class="phase">
        {/* Re-keyed on a phase change while the game shows, so the banner flashes once (§11.2 d). */}
        <div key={st.phaseFlash} class={cx('phase-title pixel', st.phaseFlash > 0 && 'flash')}>
          {text?.title ?? '…'}
        </div>
        <div class="phase-hint">
          {showRound && (
            <span class="round">
              Round {g.round} of {g.rounds}
              {' · '}
            </span>
          )}
          {text?.hint}
          {map && g?.phase !== 'LOBBY' && <span class="map-chip">{' · '}🗺️ {mapName(map)}</span>}
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
      <div class="hdr-end">
        <button
          class={cx('sound-btn', sound.muted && 'off')}
          onClick={() => sound.toggleMuted()}
          aria-pressed={!sound.muted}
          title={sound.muted ? 'Sounds are off. Click to turn them on' : 'Sounds are on. Click to mute'}
        >
          {sound.muted ? '🔇' : '🔊'}
        </button>
        <span class={cx('conn', st.socket)} title={st.socket === 'open' ? 'Connected' : 'Reconnecting…'} />
      </div>
    </header>
  );
}
