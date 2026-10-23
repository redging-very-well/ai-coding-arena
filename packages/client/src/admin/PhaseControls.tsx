// Phase controls (plan §12.3): Start match (rounds 1-10, Open Armory, map
// style and team mode with a map preview and team swaps), Next, Skip, START,
// Force start, Pause/Resume (timer and battle), 1x/2x, timer ±1 min / set,
// New match, and the projector remote (join poster, replay at 1x/2x). Buttons
// are enabled by phase; the server enforces the gates.

import { useEffect, useState } from 'preact/hooks';
import { teamModeLabel, type GameStateDTO, type Phase } from '@pixel-clash/shared';
import { advanceControls, countdownText } from '../common/advance.js';
import { api } from '../common/api.js';
import { mapName } from '../common/maps.js';
import { cx, formatClock, ordinal } from '../common/ui.js';
import { useAdmin } from './context.js';
import { MatchSetup } from './MatchSetup.js';

const PHASE_HELP: Record<Phase, string> = {
  LOBBY: 'Players join (up to 8). Pick the map and teams, then start the match when 2-8 players are in.',
  PLAN: 'Players ask Claude for units, pick up to 4 units and 4 buildings and press Ready. Ends when the timer runs out, or press Next (any time: Ready never blocks you).',
  PLACEMENT: 'Players place their armies and press READY. START when everyone is ready, or Force start.',
  BATTLE: 'The battle is playing. Pause, 1x/2x, or Skip to the results.',
  RESULTS: 'Round results. Press Next for the next round (or the final results).',
  MATCH_RESULTS: 'The match is over. New match keeps players and units, resets points.',
};

/** Toast text for a projector command: says so when no /screen page got it. */
const onScreen = (text: string) => (r: { screens: number }) => (r.screens > 0 ? text : 'No /screen page is open right now.');

const SKIP_TEXT: Partial<Record<Phase, string>> = {
  PLAN: 'Skip to placement',
  PLACEMENT: 'Skip (= Force start)',
  BATTLE: 'Skip to results',
  RESULTS: 'Skip (= Next)',
};

export function PhaseControls() {
  const { state, act, busy } = useAdmin();
  const s = state as GameStateDTO;
  const [rounds, setRounds] = useState(s.rounds);
  const [armory, setArmory] = useState(false);
  const [setMin, setSetMin] = useState('5');
  const [confirmForce, setConfirmForce] = useState(false);
  const [confirmNew, setConfirmNew] = useState(false);
  useEffect(() => {
    if (s.phase === 'LOBBY') setRounds(s.rounds);
  }, [s.phase, s.rounds]);
  useEffect(() => {
    setConfirmForce(false);
    setConfirmNew(false);
  }, [s.phase]);

  const p = s.phase;
  const hasTimer = p === 'PLAN' || p === 'PLACEMENT';
  const active = s.players.filter((pl) => pl.active);
  const readyCount = active.filter((pl) => pl.ready).length;
  // The server's flag (active players only: benched and joining-next-round don't count).
  const allReady = s.allReady ?? (active.length > 0 && readyCount === active.length);
  const adv = advanceControls(s, true);
  const battle = s.battle;
  const secondsLeft = s.timer.secondsLeft;

  return (
    <section class="panel controls">
      <div class="phase-row">
        <div>
          <div class="phase-name pixel">{p.replace('_', ' ')}</div>
          <div class="dim">
            {p === 'LOBBY' ? `${s.players.length} player(s) joined` : `Round ${s.round} of ${s.rounds}`}
            {p !== 'LOBBY' && s.armory?.enabled && ` · 💡 Open Armory on (${s.armory.entries} units)`}
            {p !== 'LOBBY' && s.match?.map && ` · 🗺️ ${mapName(s.match.map)}`}
            {p !== 'LOBBY' && s.match && s.match.teamMode !== 'ffa' && ` · ${teamModeLabel(s.match.teamMode, s.match.map?.players ?? s.players.length)}`}
          </div>
        </div>
        <div class="clock-box">
          {battle ? (
            <>
              <div class="clock pixel">{formatClock((battle.totalTicks - battle.tick) / 60)}</div>
              <div class="dim">
                battle {battle.paused ? '⏸ paused' : '▶ playing'} · {battle.speed}x{battle.thinking ? ' · thinking…' : ''}
              </div>
            </>
          ) : (
            <>
              <div class="clock pixel">{formatClock(secondsLeft)}</div>
              <div class="dim">
                {secondsLeft === null ? 'no timer' : s.timer.paused ? '⏸ timer paused' : s.timer.expired ? "time's up: waiting for START" : 'timer running'}
              </div>
            </>
          )}
        </div>
      </div>
      <p class="help">{PHASE_HELP[p]}</p>
      {s.pendingAdvance && (
        <div class="countdown-row" role="status">
          <span class="pixel">⏱ {countdownText(s.pendingAdvance)}</span>
          <span class="dim">{s.pendingAdvance.by === 'auto' ? '(everyone is ready: auto-advance is on)' : '(your countdown)'}</span>
          <button class="btn danger" disabled={busy} onClick={() => act(() => api.admin.cancelAdvance())}>
            ✕ Cancel
          </button>
        </div>
      )}
      {p === 'LOBBY' && <MatchSetup rounds={Math.round(rounds)} />}

      <div class="btn-row">
        {p === 'LOBBY' && (
          <>
            <label class="inline">
              Rounds
              <input type="number" min={1} max={10} value={rounds} onInput={(e) => setRounds(Number(e.currentTarget.value))} />
            </label>
            <label class="inline" title="Units that fought become available to every other player in later rounds (locked for the match)">
              <input type="checkbox" checked={armory} onChange={(e) => setArmory(e.currentTarget.checked)} />
              Open Armory
            </label>
            <button
              class="btn primary"
              disabled={busy || s.players.length < 2 || !(rounds >= 1 && rounds <= 10)}
              title={s.players.length < 2 ? 'Needs at least 2 players' : ''}
              onClick={() => act(() => api.admin.startMatch(Math.round(rounds), armory), 'Match started!')}
            >
              Start match
            </button>
          </>
        )}
        {p === 'PLAN' && (
          <button
            class={cx('btn primary', allReady && 'big all-ready')}
            disabled={busy}
            title={allReady ? '' : 'You can start placement any time; players who are not ready keep their current picks'}
            onClick={() => act(() => api.admin.nextPhase())}
          >
            {allReady ? "Everyone's ready: start placement ▶" : `Next ▶ (${readyCount}/${active.length} ready)`}
          </button>
        )}
        {adv.go && (
          <button class="btn" disabled={busy} title="A 3-second countdown on every screen; you can cancel it" onClick={() => act(() => api.admin.advance(3))}>
            ⏱ 3-2-1, {adv.go.label}
          </button>
        )}
        {p === 'RESULTS' && (
          <button class="btn primary" disabled={busy} onClick={() => act(() => api.admin.nextPhase())}>
            Next ▶
          </button>
        )}
        {p === 'PLACEMENT' && (
          <>
            <button
              class={cx('btn primary big', allReady && 'all-ready')}
              disabled={busy || !allReady}
              title={allReady ? '' : 'Not everyone is ready: use Force start'}
              onClick={() => act(() => api.admin.start(false), 'CLASH!')}
            >
              {allReady ? "Everyone's ready: START ▶" : `START (${readyCount}/${active.length} ready)`}
            </button>
            {confirmForce ? (
              <>
                <button class="btn danger" disabled={busy} onClick={() => act(() => api.admin.start(true), 'Force started')}>
                  Yes, force start
                </button>
                <button class="btn" onClick={() => setConfirmForce(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <button class="btn warn" disabled={busy} onClick={() => setConfirmForce(true)}>
                Force start…
              </button>
            )}
          </>
        )}
        {SKIP_TEXT[p] && p !== 'PLACEMENT' && (
          <button class="btn" disabled={busy} onClick={() => act(() => api.admin.skipPhase())}>
            {SKIP_TEXT[p]}
          </button>
        )}
        {p !== 'LOBBY' &&
          (confirmNew ? (
            <>
              <button class="btn danger" disabled={busy} onClick={() => act(() => api.admin.newMatch(), 'Back to the lobby')}>
                Yes, new match
              </button>
              <button class="btn" onClick={() => setConfirmNew(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button
              class={p === 'MATCH_RESULTS' ? 'btn primary' : 'btn subtle'}
              disabled={busy}
              onClick={() => (p === 'MATCH_RESULTS' ? act(() => api.admin.newMatch(), 'Back to the lobby') : setConfirmNew(true))}
            >
              New match{p === 'MATCH_RESULTS' ? '' : '…'}
            </button>
          ))}
      </div>

      {hasTimer && (
        <div class="btn-row">
          <span class="label">Timer</span>
          <button class="btn" disabled={busy} onClick={() => act(() => api.admin.timer({ paused: !s.timer.paused }))}>
            {s.timer.paused ? '▶ Resume' : '⏸ Pause'}
          </button>
          <button class="btn" disabled={busy} onClick={() => act(() => api.admin.timer({ addSeconds: -60 }))}>
            −1 min
          </button>
          <button class="btn" disabled={busy} onClick={() => act(() => api.admin.timer({ addSeconds: 60 }))}>
            +1 min
          </button>
          <label class="inline">
            Set
            <input type="number" min={0} max={120} step={0.5} value={setMin} onInput={(e) => setSetMin(e.currentTarget.value)} />
            min
          </label>
          <button
            class="btn"
            disabled={busy || !(Number(setMin) >= 0)}
            onClick={() => act(() => api.admin.timer({ setSeconds: Math.round(Number(setMin) * 60) }))}
          >
            Set
          </button>
        </div>
      )}

      {p === 'BATTLE' && battle && (
        <div class="btn-row">
          <span class="label">Battle</span>
          <button class="btn" disabled={busy} onClick={() => act(() => api.admin.battle({ paused: !battle.paused }))}>
            {battle.paused ? '▶ Resume' : '⏸ Pause'}
          </button>
          <button class={battle.speed === 1 ? 'btn on' : 'btn'} disabled={busy} onClick={() => act(() => api.admin.battle({ speed: 1 }))}>
            1x
          </button>
          <button class={battle.speed === 2 ? 'btn on' : 'btn'} disabled={busy} onClick={() => act(() => api.admin.battle({ speed: 2 }))}>
            2x
          </button>
        </div>
      )}

      <div class="btn-row">
        <span class="label" title="Remote control for /screen (keys there: P poster, R replay, M mute)">Projector</span>
        <button class="btn" disabled={busy} onClick={() => act(() => api.admin.screen({ action: 'poster', show: true }), onScreen('Join poster on the projector'))}>
          Show join poster
        </button>
        <button class="btn subtle" disabled={busy} onClick={() => act(() => api.admin.screen({ action: 'poster', show: false }))}>
          Hide poster
        </button>
        {s.lastBattle && (p === 'RESULTS' || p === 'MATCH_RESULTS') && (
          <>
            <button class="btn" disabled={busy} onClick={() => act(() => api.admin.screen({ action: 'replay' }), onScreen('Replay on the projector'))}>
              ▶ Replay
            </button>
            <button class="btn" disabled={busy} onClick={() => act(() => api.admin.screen({ action: 'replaySpeed', speed: 1 }))}>
              1x
            </button>
            <button class="btn" disabled={busy} onClick={() => act(() => api.admin.screen({ action: 'replaySpeed', speed: 2 }))}>
              2x
            </button>
            <button class="btn" disabled={busy} onClick={() => act(() => api.admin.screen({ action: 'replayPause' }))} title="Pause or resume the replay">
              Pause
            </button>
          </>
        )}
      </div>

      {s.lastBattle && (p === 'RESULTS' || p === 'MATCH_RESULTS') && (
        <div class="last-battle">
          <span class="label">Round {s.lastBattle.round}</span> ended by {s.lastBattle.reason} at {formatClock(s.lastBattle.endTick / 60)}.
          {/* The ranking's own place, not the list index: tied players and whole teams share a place. */}
          <ul class="ranking-list">
            {s.lastBattle.ranking.map((r) => (
              <li key={r.playerId}>
                {ordinal(r.place)} {s.players.find((pl) => pl.id === r.playerId)?.name ?? r.playerId}: +{r.pointsGained} pts
              </li>
            ))}
          </ul>
        </div>
      )}

      {s.match?.teamTable && s.match.teamTable.length > 0 && p !== 'LOBBY' && (
        <div class="team-table-admin">
          <span class="label">Teams</span>
          {[...s.match.teamTable]
            .sort((a, b) => a.place - b.place)
            .map((t) => (
              <span key={t.teamId} class="team-chip" style={{ '--team': t.color }}>
                {t.place}. {t.name}: {t.points} pts ({t.members.map((id) => s.players.find((pl) => pl.id === id)?.name ?? '?').join(', ')})
              </span>
            ))}
        </div>
      )}

      {s.scoreboard.length > 0 && p !== 'LOBBY' && (
        <div class="scoreboard dim">
          Scores: {s.scoreboard.map((e) => `${e.name} ${e.points}`).join(' · ')}
        </div>
      )}
    </section>
  );
}
