// Projector view (plan §12.2), laid out on a fixed 1920×1080 stage that is
// scaled to fit the window. The arena canvas is always mounted (the shared
// ArenaRenderer draws into it); panels and overlays change by phase.

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { GameStateDTO, PlayerStatusDTO } from '@pixel-clash/shared';
import { SEATS, seatStyle } from '../common/seats.js';
import { PHASE_TEXT, PLACE_MEDALS, cx, formatClock, formatMoney, ordinal } from '../common/ui.js';
import { Confetti } from './Confetti.js';
import { ScreenController, type ScreenSnapshot } from './controller.js';
import {
  armyValues,
  badgeCounts,
  badgeLabel,
  battleSecondsLeft,
  countUp,
  isUrgent,
  liveSecondsLeft,
  podiumOrder,
  rankRows,
  revealStep,
  standings,
  statusTicks,
  type ArmyValue,
} from './model.js';

const STAGE_W = 1920;
const STAGE_H = 1080;
const SUDDEN_DEATH_BANNER_MS = 3200;

const SCREEN_TITLES: Record<GameStateDTO['phase'], string> = {
  LOBBY: 'Join the game!',
  PLAN: 'Plan time!',
  PLACEMENT: 'Place your army!',
  BATTLE: 'CLASH!',
  RESULTS: 'Results',
  MATCH_RESULTS: 'Game over!',
};

/** Re-render on every controller change. */
function useController(): [ScreenController | null, ScreenSnapshot | null, (c: HTMLCanvasElement | null) => void] {
  const [ctrl, setCtrl] = useState<ScreenController | null>(null);
  const [, force] = useState(0);
  const ref = useRef<ScreenController | null>(null);
  const attach = (canvas: HTMLCanvasElement | null) => {
    if (!canvas || ref.current) return;
    ref.current = new ScreenController(canvas);
    setCtrl(ref.current);
  };
  useEffect(() => {
    if (!ctrl) return;
    const off = ctrl.subscribe(() => force((n) => n + 1));
    return () => {
      off();
    };
  }, [ctrl]);
  useEffect(() => () => ref.current?.destroy(), []);
  return [ctrl, ctrl?.snapshot ?? null, attach];
}

/** A clock that re-renders every `ms` (timers, army bars, banners). */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const id = setInterval(() => setNow(performance.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** Scale the 1920×1080 stage to the window. */
function useStageScale(): number {
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const fit = () => setScale(Math.min(window.innerWidth / STAGE_W, window.innerHeight / STAGE_H));
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);
  return scale;
}

export function App() {
  const [ctrl, snap, attach] = useController();
  const now = useNow(100);
  const scale = useStageScale();
  useEffect(() => ctrl?.syncReplay(), [ctrl, now]);

  // Keyboard for the facilitator at the projector: R replay, 1/2 speed, space pause.
  useEffect(() => {
    if (!ctrl) return;
    const onKey = (e: KeyboardEvent) => {
      const phase = ctrl.snapshot.state?.phase;
      if (phase !== 'RESULTS' && phase !== 'MATCH_RESULTS') return;
      if (e.key === 'r' || e.key === 'R') ctrl.playReplay();
      else if (e.key === '1') ctrl.setReplaySpeed(1);
      else if (e.key === '2') ctrl.setReplaySpeed(2);
      else if (e.key === ' ') {
        e.preventDefault();
        ctrl.toggleReplayPause();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ctrl]);

  const state = snap?.state ?? null;
  const phase = state?.phase ?? 'LOBBY';

  return (
    <div class="viewport">
      <div
        class={cx('stage', `phase-${phase.toLowerCase()}`)}
        style={{ transform: `translate(-50%, -50%) scale(${scale})` }}
      >
        <Header snap={snap} ctrl={ctrl} now={now} />
        <main class="body">
          <section class="arena-panel">
            <canvas ref={attach} class="arena pixelated" />
            {snap && ctrl && <ArenaOverlays snap={snap} ctrl={ctrl} now={now} />}
          </section>
          <aside class="side">{snap && ctrl && <Sidebar snap={snap} ctrl={ctrl} now={now} />}</aside>
        </main>
        {snap && phase === 'MATCH_RESULTS' && state && <Podium state={state} />}
        {snap && snap.conn !== 'open' && (
          <div class="conn">{snap.conn === 'connecting' ? 'Connecting…' : 'Reconnecting to the game server…'}</div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header: title, round, big timer
// ---------------------------------------------------------------------------

function Header({ snap, ctrl, now }: { snap: ScreenSnapshot | null; ctrl: ScreenController | null; now: number }) {
  const state = snap?.state;
  const phase = state?.phase ?? 'LOBBY';
  let seconds: number | null = null;
  let label = '';
  if (state && snap) {
    if (phase === 'BATTLE' && ctrl) {
      const total = snap.playback?.totalTicks ?? snap.reveal?.totalTicks ?? 0;
      const started = ctrl.arena.instanceIds.length > 0 && !snap.revealAt;
      seconds = total ? battleSecondsLeft(started ? ctrl.arena.tick : 0, total, snap.ticksPerSecond) : null;
      label = 'Battle';
    } else if (phase !== 'RESULTS' && phase !== 'MATCH_RESULTS') {
      seconds = liveSecondsLeft(state.timer.secondsLeft, snap.stateAt, state.timer.paused, now);
      label = state.timer.paused ? 'Paused' : 'Time left';
    }
  }
  const expired = phase === 'PLACEMENT' && state?.timer.expired;
  return (
    <header class="top">
      <div class="logo pixel">
        PIXEL<span>CLASH</span>
      </div>
      <div class="title">
        <h1 class="pixel">{SCREEN_TITLES[phase]}</h1>
        <p>{expired ? 'Time is up! Waiting for the host to press START…' : PHASE_TEXT[phase].hint}</p>
      </div>
      <div class="clock">
        {state && state.round > 0 && (
          <div class="round pixel">
            Round {state.round} of {state.rounds}
          </div>
        )}
        {state?.armory?.enabled && <div class="armory-on">💡 Open Armory</div>}
        {seconds !== null && (
          <div class={cx('timer pixel', isUrgent(seconds) && 'urgent', state?.timer.paused && phase !== 'BATTLE' && 'paused')}>
            <small>{label}</small>
            {formatClock(seconds)}
          </div>
        )}
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Overlays on the arena
// ---------------------------------------------------------------------------

function ArenaOverlays({ snap, ctrl, now }: { snap: ScreenSnapshot; ctrl: ScreenController; now: number }) {
  const phase = snap.state?.phase;
  const step = snap.revealAt !== null ? revealStep(now - snap.revealAt) : null;
  const sd = snap.suddenDeathAt !== null && now - snap.suddenDeathAt < SUDDEN_DEATH_BANNER_MS;
  const pb = snap.playback;
  const battle = phase === 'BATTLE';
  return (
    <>
      {(phase === 'LOBBY' || phase === 'PLAN' || phase === 'PLACEMENT') && (
        <div class="arena-caption pixel">{phase === 'PLACEMENT' ? 'Armies hidden until START' : 'The arena awaits…'}</div>
      )}
      {step && (
        <div class="reveal" key={step}>
          <span class={cx('pixel', step === 'CLASH!' ? 'clash' : 'count')}>{step}</span>
        </div>
      )}
      {sd && (
        <div class="sudden-death">
          <span class="pixel">SUDDEN DEATH!</span>
          <small>Stay inside the circle!</small>
        </div>
      )}
      {battle && pb && (
        <div class="chips">
          {pb.speed === 2 && <span class="chip pixel speed">2x ⏩</span>}
          {pb.paused && <span class="chip pixel paused">⏸ PAUSED</span>}
          {pb.thinking && !pb.paused && <span class="chip pixel thinking">Thinking…</span>}
          {snap.suddenDeathAt !== null && <span class="chip pixel sd">☠ Sudden death</span>}
        </div>
      )}
      {battle && pb?.paused && <div class="paused-veil pixel">PAUSED</div>}
      {snap.replay && (
        <div class="chips">
          <span class="chip pixel replay">{snap.replay.loading ? 'Loading replay…' : snap.replay.playing ? `▶ Replay ${snap.replay.speed}x` : 'Final moment'}</span>
        </div>
      )}
      {phase === 'RESULTS' && snap.end && !snap.replay?.playing && (
        <div class="end-reason pixel">{endReasonText(snap.end.reason)}</div>
      )}
      <div class="toasts">
        {snap.toasts.map((t) => (
          <div key={t.id} class={cx('toast', `toast-${t.level}`)} style={{ '--seat': seatStyle(t.seat).color }}>
            {t.seat >= 0 && <b class="sym">{seatStyle(t.seat).symbol}</b>}
            {t.text}
          </div>
        ))}
      </div>
    </>
  );
}

function endReasonText(reason: 'elimination' | 'timeout' | 'skipped'): string {
  return reason === 'elimination' ? 'Last army standing!' : reason === 'timeout' ? "Time's up!" : 'Battle skipped';
}

// ---------------------------------------------------------------------------
// Sidebar by phase
// ---------------------------------------------------------------------------

function Sidebar({ snap, ctrl, now }: { snap: ScreenSnapshot; ctrl: ScreenController; now: number }) {
  const state = snap.state;
  if (!state) return <div class="panel muted">Waiting for the game server…</div>;
  switch (state.phase) {
    case 'LOBBY':
    case 'PLAN':
      return (
        <>
          <JoinCard snap={snap} />
          <PlayerTiles state={state} />
        </>
      );
    case 'PLACEMENT':
      return <PlayerTiles state={state} />;
    case 'BATTLE':
      return <ArmyBars snap={snap} ctrl={ctrl} />;
    case 'RESULTS':
      return <Ranking snap={snap} ctrl={ctrl} now={now} />;
    case 'MATCH_RESULTS':
      return <Ranking snap={snap} ctrl={ctrl} now={now} />;
  }
}

function JoinCard({ snap }: { snap: ScreenSnapshot }) {
  const join = snap.join;
  const pretty = join?.joinUrl.replace(/^https?:\/\//, '') ?? '…';
  return (
    <div class="panel join">
      <h2 class="pixel">Join here</h2>
      <div class="join-row">
        {join?.qrSvg ? <div class="qr" dangerouslySetInnerHTML={{ __html: join.qrSvg }} /> : <div class="qr qr-empty" />}
        <div class="join-text">
          <p>Scan the code or type:</p>
          <div class="url pixel">{pretty}</div>
          <p class="muted">Pick a name and a 4-digit PIN.</p>
        </div>
      </div>
    </div>
  );
}

function PlayerTiles({ state }: { state: GameStateDTO }) {
  const players = [...state.players].sort((a, b) => a.seat - b.seat);
  const empty = Math.max(0, SEATS.length - players.length);
  return (
    <div class="panel players">
      <h2 class="pixel">Players {players.length}/{SEATS.length}</h2>
      <div class="tiles">
        {players.map((p) => (
          <PlayerTile key={p.id} p={p} state={state} />
        ))}
        {Array.from({ length: empty }, (_, i) => (
          <div key={`empty-${i}`} class="tile empty">
            <span class="pixel">Free seat</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PlayerTile({ p, state }: { p: PlayerStatusDTO; state: GameStateDTO }) {
  const seat = seatStyle(p.seat);
  const ticks = statusTicks(p, state.phase);
  const allDone = ticks.length > 0 && ticks.every((t) => t.done);
  return (
    <div class={cx('tile', `seat-${p.seat}`, !p.connected && 'offline', allDone && 'done')}>
      <div class="tile-head">
        <span class="sym">{seat.symbol}</span>
        <span class="name">{p.name}</span>
        {state.round > 0 && <span class="pts pixel">{p.points}</span>}
      </div>
      <ul class="ticks">
        {ticks.map((t) => (
          <li key={t.label} class={cx(t.done && 'on')}>
            <span class="box">{t.done ? '✓' : ''}</span>
            {t.label}
          </li>
        ))}
        {!p.connected && <li class="off">offline</li>}
      </ul>
    </div>
  );
}

function ArmyBars({ snap, ctrl }: { snap: ScreenSnapshot; ctrl: ScreenController }) {
  const reveal = snap.reveal;
  const started = ctrl.arena.instanceIds.length > 0;
  let values: ArmyValue[] = [];
  if (reveal && started) {
    const sample = ctrl.arena.buffer.sample(ctrl.arena.tick);
    values = armyValues(reveal, sample ? new Set(sample.units.map((u) => u.id)) : null);
  } else if (reveal) {
    values = armyValues(reveal, null);
  }
  const max = Math.max(1, ...values.map((v) => v.start));
  const sorted = [...values].sort((a, b) => a.seat - b.seat);
  return (
    <div class="panel armies">
      <h2 class="pixel">Army value</h2>
      {!reveal && <p class="muted">Get ready…</p>}
      {sorted.map((v) => {
        const seat = seatStyle(v.seat);
        const out = v.aliveCount === 0 && started;
        return (
          <div key={v.playerId} class={cx('army', out && 'out')} style={{ '--seat': seat.color, '--seat-light': seat.light }}>
            <div class="army-head">
              <span class="sym">{seat.symbol}</span>
              <span class="name">{v.name}</span>
              <span class="val pixel">{out ? 'OUT' : formatMoney(v.living)}</span>
            </div>
            <div class="bar">
              <div class="fill" style={{ width: `${(100 * v.living) / max}%` }} />
              <div class="ghost" style={{ width: `${(100 * v.start) / max}%` }} />
            </div>
            <div class="army-foot">
              {v.aliveCount}/{v.fieldedCount} units standing
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Ranking({ snap, ctrl, now }: { snap: ScreenSnapshot; ctrl: ScreenController; now: number }) {
  const state = snap.state!;
  const rows = rankRows(state.lastBattle ? state : { ...state, lastBattle: snap.end ?? undefined });
  const inventors = (state.lastBattle ?? snap.end)?.inventors ?? [];
  // The count-up starts when the ranking first has rows.
  const shownAt = useRef<number | null>(null);
  if (rows.length > 0 && shownAt.current === null) shownAt.current = now;
  const elapsed = shownAt.current === null ? 0 : now - shownAt.current;
  const r = snap.replay;
  const board = standings(state.scoreboard);
  return (
    <div class="panel ranking">
      <h2 class="pixel">Battle {snap.end?.round ?? state.round} results</h2>
      {rows.length === 0 && <p class="muted">Counting the points…</p>}
      {rows.length > 0 && (
        <table class="score-table">
          <thead>
            <tr>
              <th />
              <th class="left">Player</th>
              <th title="Points for your place">Place</th>
              <th title="Damage bonus: the biggest hitter gets the most">💥</th>
              <th title="Value bonus: for knocking out enemy units">🗡️</th>
              <th>Round</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const seat = seatStyle(row.seat);
              const t0 = 300 + i * 250;
              const gained = countUp(row.pointsGained, elapsed - t0);
              return (
                <tr key={row.playerId} class={cx('rank', `place-${row.place}`)} style={{ '--seat': seat.color, animationDelay: `${i * 120}ms` }}>
                  <td class="medal">{PLACE_MEDALS[row.place - 1] ?? ''}</td>
                  <td class="who">
                    <span class="sym">{seat.symbol}</span>
                    {row.name}
                    <small>
                      {ordinal(row.place)} · {row.livingCost > 0 ? `${formatMoney(row.livingCost)} still standing` : 'knocked out'}
                    </small>
                    {row.badges.length > 0 && (
                      <span class="badges">
                        {row.badges.map((b, j) => (
                          <span key={b} class="badge" style={{ animationDelay: `${1600 + i * 250 + j * 300}ms` }}>
                            {badgeLabel(b, row.inventorUsedBy)}
                          </span>
                        ))}
                      </span>
                    )}
                  </td>
                  <td class="num pixel">+{row.placePoints}</td>
                  <td class="num pixel">
                    +{row.damageBonus}
                    <small>{Math.round(row.damage)} dmg</small>
                  </td>
                  <td class="num pixel">
                    +{row.valueBonus}
                    <small>{formatMoney(row.valueDestroyed)}</small>
                  </td>
                  <td class="num gain pixel">+{gained}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {inventors.length > 0 && (
        <p class="inventors">
          {inventors.map((inv) => (
            <span key={inv.playerId}>
              💡 <strong>{inv.name}</strong> invented {inv.units.join(', ')}: used by {inv.usedBy} player{inv.usedBy === 1 ? '' : 's'}
            </span>
          ))}
        </p>
      )}
      {board.length > 0 && (
        <>
          <h3 class="pixel board-title">Scoreboard</h3>
          <table class="board-table">
            <tbody>
              {board.map((s) => {
                const seat = seatStyle(s.seat);
                return (
                  <tr key={s.playerId} style={{ '--seat': seat.color }}>
                    <td class="pixel">{ordinal(s.place)}</td>
                    <td class="left">
                      <span class="sym">{seat.symbol}</span>
                      {s.name}
                    </td>
                    <td class="pixel">{s.points} pts</td>
                    <td title="Total damage this match (breaks ties)">💥 {Math.round(s.damage ?? 0)}</td>
                    <td class="badge-counts">
                      {badgeCounts(s).map((b) => (
                        <span key={b.id} title={b.title}>
                          {b.emoji}
                          {b.count > 1 ? `×${b.count}` : ''}
                        </span>
                      ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
      {state.phase === 'RESULTS' && (
        <div class="replay-controls">
          <button class="btn pixel" onClick={() => ctrl.playReplay()} disabled={r?.loading}>
            {r?.playing ? '⟲ Restart' : '▶ Replay'}
          </button>
          <button class={cx('btn pixel small', (r?.speed ?? 1) === 1 && 'on')} onClick={() => ctrl.setReplaySpeed(1)}>
            1x
          </button>
          <button class={cx('btn pixel small', r?.speed === 2 && 'on')} onClick={() => ctrl.setReplaySpeed(2)}>
            2x
          </button>
          {r && !r.loading && (
            <button class="btn pixel small" onClick={() => ctrl.toggleReplayPause()}>
              {r.paused ? '▶' : '⏸'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MATCH_RESULTS: podium, confetti, final scoreboard
// ---------------------------------------------------------------------------

function Podium({ state }: { state: GameStateDTO }) {
  const final = standings(state.scoreboard);
  const top = podiumOrder(final.slice(0, 3));
  return (
    <div class="podium-overlay">
      <Confetti />
      <h1 class="pixel champion">{final[0] ? `${final[0].name} wins!` : 'Game over!'}</h1>
      <div class="podium">
        {top.map((s) => {
          const seat = seatStyle(s.seat);
          return (
            <div key={s.playerId} class={cx('step', `step-${s.place}`)} style={{ '--seat': seat.color, '--seat-light': seat.light }}>
              <div class="medal">{PLACE_MEDALS[s.place - 1] ?? ''}</div>
              <div class="who">
                <span class="sym">{seat.symbol}</span> {s.name}
              </div>
              <div class="block pixel">
                <span>{ordinal(s.place)}</span>
                <small>{s.points} pts</small>
                <small class="dmg">💥 {Math.round(s.damage ?? 0)}</small>
              </div>
              <div class="step-badges">
                {badgeCounts(s).map((b) => (
                  <span key={b.id} class="badge" title={b.title}>
                    {b.emoji} ×{b.count}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <table class="final">
        <tbody>
          {final.map((s) => {
            const seat = seatStyle(s.seat);
            return (
              <tr key={s.playerId} style={{ '--seat': seat.color }}>
                <td class="pixel">{ordinal(s.place)}</td>
                <td>
                  <span class="sym">{seat.symbol}</span> {s.name}
                </td>
                <td class="pixel">{s.points} pts</td>
                <td class="dmg">💥 {Math.round(s.damage ?? 0)}</td>
                <td class="badge-counts">
                  {badgeCounts(s).map((b) => (
                    <span key={b.id} title={b.title}>
                      {b.emoji}
                      {b.count > 1 ? `×${b.count}` : ''}
                    </span>
                  ))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p class="thanks pixel">Great battles, everyone!</p>
    </div>
  );
}
