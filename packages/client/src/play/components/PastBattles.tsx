// "📜 Past battles" (plan §12.1): in any phase once a battle was released, a
// panel in the Game pane (the Claude terminal stays mounted) with a round
// picker and, for that round: the ranking with the points breakdown and
// badges, the top damage units, the player's own unit report with the
// "Ask Claude" prompts (handy in PLAN for fixing units), and a replay in the
// shared iso renderer (1x/2x, pause, scrub). Data: GET /battles/:round/results
// (public after release), /report (own only) and /replay.

import { useEffect, useState } from 'preact/hooks';
import { BADGES, type BattleEndDTO, type BattleReportDTO, type ReplayDTO } from '@pixel-clash/shared';
import { ApiError, api } from '../../common/api.js';
import { seatStyle } from '../../common/seats.js';
import { PLACE_MEDALS, cx } from '../../common/ui.js';
import { groupErrors, pastRankRows, pickRound, releasedRounds } from '../logic.js';
import { getStore, useStore } from '../store.js';
import { ArenaView } from './Battle.js';
import { CopyButton } from './CopyButton.js';
import { TopUnits } from './TopUnits.js';

/** The "📜 Past battles" button; null until a battle of this match was released. */
export function PastBattlesButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const st = useStore();
  if (releasedRounds(st.game).length === 0) return null;
  return (
    <div class="past-bar">
      <button class={cx('btn small', open && 'on')} aria-expanded={open} onClick={onToggle}>
        📜 Past battles
      </button>
    </div>
  );
}

export function PastBattles({ onClose }: { onClose: () => void }) {
  const st = useStore();
  const store = getStore();
  const rounds = releasedRounds(st.game);
  const [picked, setPicked] = useState<number | null>(null);
  const round = pickRound(rounds, picked);
  const [end, setEnd] = useState<BattleEndDTO | null>(null);
  const [report, setReport] = useState<BattleReportDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [replay, setReplay] = useState<ReplayDTO | null>(null);
  const meId = st.player?.id;
  const battleRunning = st.game?.phase === 'BATTLE';

  useEffect(() => {
    if (round === null) return;
    let cancelled = false;
    setEnd(null);
    setReport(null);
    setError(null);
    setReplay(null);
    api.results(round).then(
      (r) => !cancelled && setEnd(r),
      (err) => !cancelled && setError(err instanceof ApiError ? err.playerMessage : "Couldn't load that battle. Try again!"),
    );
    // Own report only; none when the player sat that round out.
    api.report(round).then(
      (r) => !cancelled && setReport(r),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [round, meId]);

  // A battle starting takes the arena back: close the replay.
  useEffect(() => {
    if (battleRunning) setReplay(null);
  }, [battleRunning]);

  if (round === null) return null;
  const rows = end ? pastRankRows(end, st.game?.players ?? [], meId) : [];
  const groups = report ? groupErrors(report.errors) : [];

  const watch = async () => {
    try {
      const r = await api.replay(round);
      store.arena.loadReplay(r);
      store.arena.setPlayback({ speed: 1, paused: false });
      setReplay(r);
    } catch (err) {
      store.toast(err instanceof ApiError ? err.playerMessage : 'No replay for that round.', 'warn');
    }
  };

  return (
    <section class="panel past-battles" aria-label="Past battles">
      <div class="panel-head">
        <h2>📜 Past battles</h2>
        <button class="btn small" onClick={onClose}>
          ✕ Close
        </button>
      </div>
      <div class="round-picker" role="tablist" aria-label="Round">
        {rounds.map((r) => (
          <button key={r} role="tab" aria-selected={r === round} class={cx('tab', r === round && 'on')} onClick={() => setPicked(r)}>
            Round {r}
          </button>
        ))}
      </div>
      {error && <p class="note bad">{error}</p>}
      {!end && !error && <p class="dim">Loading round {round}…</p>}
      {end && (
        <>
          {/* §6: results from before the ×5 economy carry no scaleVersion; 2 = the $5,000 game. */}
          {end.scaleVersion === undefined && (
            <p class="dim small old-game">($1,000 game) This round was played before prices and stats went up 5×, so its numbers are smaller.</p>
          )}
          {end.scaleVersion === 2 && (
            <p class="dim small old-game">($5,000 game) This round was played before the $10,000 economy, with less health and more damage per unit.</p>
          )}
          <table class="past-ranking">
            <thead>
              <tr>
                <th />
                <th class="left">Player</th>
                <th title="Place points">Place</th>
                <th title="Damage bonus">💥</th>
                <th title="Value bonus">🗡️</th>
                <th>Badges</th>
                <th>Round</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const seat = seatStyle(r.seat);
                return (
                  <tr key={r.playerId} class={cx(r.me && 'me')}>
                    <td>{PLACE_MEDALS[r.place - 1] ?? r.place}</td>
                    <td class="left">
                      <span class="seat-num" style={{ '--seat': seat.color }}>
                        {seat.symbol}
                      </span>{' '}
                      {r.me ? `${r.name} (you)` : r.name}
                    </td>
                    <td>+{r.placePoints}</td>
                    <td>+{r.damageBonus}</td>
                    <td>+{r.valueBonus}</td>
                    <td>
                      {r.badges.map((b) => (
                        <span key={b} title={BADGES[b].title}>
                          {BADGES[b].emoji}
                        </span>
                      ))}
                    </td>
                    <td>
                      <strong>+{r.pointsGained}</strong>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <TopUnits top={end.topUnits} round={round} meId={meId} />
        </>
      )}
      {report && (
        <div class="past-report">
          <h3>My army</h3>
          <p>
            {report.survived} unit{report.survived === 1 ? '' : 's'} still standing · {Math.round(report.damageDealt).toLocaleString('en-US')} damage · {report.kills} KO
            {report.kills === 1 ? '' : 's'}
            {report.strikes > 0 ? ` · ⚠️ ${report.strikes} strike${report.strikes === 1 ? '' : 's'}` : ''}
            {report.disabled > 0 ? ` · 💤 ${report.disabled} napped` : ''}
          </p>
          {groups.length > 0 ? (
            <div class="ask-claude">
              <p class="dim small">Copy a message and paste it to your AI helper to fix it:</p>
              <ul>
                {groups.map((g, i) => (
                  <li key={i}>
                    <blockquote>
                      {g.prompt}
                      {g.count > 1 && <span class="dim"> (happened {g.count}×)</span>}
                    </blockquote>
                    <CopyButton text={g.prompt} />
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p class="good-news">✓ No errors in your units that battle.</p>
          )}
        </div>
      )}
      {end && !report && <p class="dim small">You didn't fight in round {round}.</p>}
      <div class="past-replay">
        {!replay ? (
          <button class="btn" disabled={battleRunning} title={battleRunning ? 'After this battle' : ''} onClick={() => void watch()}>
            ▶ Watch replay
          </button>
        ) : (
          <ReplayPlayer replay={replay} onClose={() => setReplay(null)} />
        )}
      </div>
    </section>
  );
}

/** The stored frames in the shared renderer with 1x/2x, pause and a scrub bar. */
function ReplayPlayer({ replay, onClose }: { replay: ReplayDTO; onClose: () => void }) {
  const arena = getStore().arena;
  const [, setN] = useState(0);
  const [speed, setSpeed] = useState<1 | 2>(1);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setN((n) => n + 1), 200);
    return () => clearInterval(t);
  }, []);
  const start = replay.frames[0]?.t ?? 0;
  const endT = replay.end.endTick;
  const tick = arena.tick;
  return (
    <div class="replay-box">
      <ArenaView />
      <div class="replay-controls">
        <button
          class="btn small"
          onClick={() => {
            const p = !paused;
            setPaused(p);
            arena.setPlayback({ paused: p });
          }}
        >
          {paused ? '▶ Play' : '⏸ Pause'}
        </button>
        {([1, 2] as const).map((s) => (
          <button
            key={s}
            class={cx('btn small', speed === s && 'on')}
            onClick={() => {
              setSpeed(s);
              arena.setPlayback({ speed: s });
            }}
          >
            {s}x
          </button>
        ))}
        <input
          type="range"
          min={start}
          max={endT}
          step={1}
          value={Math.min(endT, Math.max(start, tick))}
          aria-label="Replay position"
          onInput={(e) => arena.seek(Number(e.currentTarget.value))}
        />
        <button
          class="btn small"
          onClick={() => {
            arena.seek(start);
            arena.setPlayback({ paused: false });
            setPaused(false);
          }}
        >
          ↺
        </button>
        <button class="btn small" onClick={onClose}>
          Close replay
        </button>
      </div>
    </div>
  );
}
