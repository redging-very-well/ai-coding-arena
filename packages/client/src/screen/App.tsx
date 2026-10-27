// Projector view, laid out on a fixed 1920×1080 stage that is
// scaled to fit the window. The arena canvas is always mounted (the shared
// ArenaRenderer draws into it); panels and overlays change by phase.

import { Fragment } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { BADGES, MAX_PLAYERS, awardStatText, teamModeLabel, type AwardWinnerDTO, type BadgeId, type BattleRevealDTO, type GameStateDTO, type PlayerStatusDTO, type TeamDTO, type TeamTableRowDTO } from '@pixel-clash/shared';
import { groupByTeam, mapName } from '../common/maps.js';
import { seatStyle, teamLook } from '../common/seats.js';
import { PHASE_TEXT, PLACE_MEDALS, cx, formatClock, formatMoney, ordinal } from '../common/ui.js';
import { advanceControls, advanceKey, type AdvanceControls } from '../common/advance.js';
import { api } from '../common/api.js';
import { projectorTopCards, topRankLabel, topUnitBy, topUnitKey, topUnitLine, topUnitLook } from '../common/topUnits.js';
import { resolveSprite } from '../common/render/sprites.js';
import { factoryWorth } from '../common/render/buildings.js';
import { SpriteView } from '../play/components/SpriteView.js';
import { Confetti } from './Confetti.js';
import {
  CEREMONY_HINT,
  CeremonyClock,
  awardsByPlayer,
  ceremonyCues,
  ceremonyKey,
  ceremonySteps,
  podiumRiseMs,
  type CeremonyPosition,
  type CeremonyStep,
} from './ceremony.js';
import { ScreenController, prefersReducedMotion, type ScreenSnapshot } from './controller.js';
import {
  WALLS_CAPTION,
  armyValues,
  revealHasWalls,
  badgeCounts,
  badgePopDelayMs,
  countUpStartMs,
  badgeLabel,
  battleSecondsLeft,
  countUp,
  endReasonText,
  isUrgent,
  liveSecondsLeft,
  freeTiles,
  podiumOrder,
  rankRows,
  readyBanner,
  revealStep,
  standings,
  statusTicks,
  teamArmyValues,
  tileDone,
  teamRankRows,
  teamStandings,
  type ArmyValue,
} from './model.js';

const STAGE_W = 1920;
const STAGE_H = 1080;
const SUDDEN_DEATH_BANNER_MS = 3200;
const REDUCED_MOTION = prefersReducedMotion();

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

/**
 * Whether this browser also holds an /admin session (the facilitator's
 * laptop): only then /screen shows the go / cancel buttons. /screen itself
 * has no login. Re-checked when the window gets focus (log in on /admin in
 * another tab, come back).
 */
function useIsAdmin(): boolean {
  const [admin, setAdmin] = useState(false);
  useEffect(() => {
    let alive = true;
    const check = () =>
      void api.admin
        .session()
        .then((r) => alive && setAdmin(r.admin))
        .catch(() => alive && setAdmin(false));
    check();
    window.addEventListener('focus', check);
    return () => {
      alive = false;
      window.removeEventListener('focus', check);
    };
  }, []);
  return admin;
}

/** Go / cancel from /screen: the server runs the countdown (errors show as a toast there). */
function useAdvanceActions(): { go: () => void; cancel: () => void } {
  return {
    go: () => void api.admin.advance(3).catch(() => undefined),
    cancel: () => void api.admin.cancelAdvance().catch(() => undefined),
  };
}

export function App() {
  const [ctrl, snap, attach] = useController();
  const isAdmin = useIsAdmin();
  const actions = useAdvanceActions();
  const controls = advanceControls(snap?.state, isAdmin);
  const controlsRef = useRef<AdvanceControls>(controls);
  controlsRef.current = controls;
  const now = useNow(100);
  const scale = useStageScale();
  useEffect(() => ctrl?.syncReplay(), [ctrl, now]);
  const isAdminRef = useRef(isAdmin);
  isAdminRef.current = isAdmin;

  // MATCH_RESULTS: the awards ceremony runs on its own clock from the
  // moment this page sees the phase; the facilitator can skip, pause, replay.
  const ceremony = useRef<CeremonyClock | null>(null);
  const cued = useRef<number | null>(null);
  const awardsList = snap?.state?.phase === 'MATCH_RESULTS' ? snap.state.matchAwards : undefined;
  const steps = useMemo(() => ceremonySteps(awardsList, { reducedMotion: REDUCED_MOTION }), [JSON.stringify(awardsList ?? null)]);
  if (snap?.state?.phase === 'MATCH_RESULTS') {
    if (!ceremony.current) ceremony.current = new CeremonyClock(steps, performance.now());
    else ceremony.current.setSteps(steps);
  } else if (ceremony.current) {
    ceremony.current = null;
    cued.current = null;
  }
  const ceremonyPos = ceremony.current?.at(now) ?? null;
  const ceremonyHidden = !!snap?.replay?.playing;
  // Each step starts with its sound (drumroll, sting, victory tune); the projector mute applies.
  useEffect(() => {
    if (!ctrl || !ceremonyPos || ceremonyHidden) return;
    for (const name of ceremonyCues(cued.current, ceremonyPos.index, steps)) ctrl.sound.play(name);
    cued.current = ceremonyPos.index;
  }, [ctrl, ceremonyPos?.index, ceremonyHidden]);

  // Keyboard for the facilitator at the projector: P join poster, M mute;
  // after a battle R replay, 1/2 speed, space pause.
  useEffect(() => {
    if (!ctrl) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // Facilitator only: Space/Enter starts the countdown, Esc cancels it.
      const adv = advanceKey(e.key, controlsRef.current);
      if (adv) {
        e.preventDefault();
        if (adv === 'go') actions.go();
        else actions.cancel();
        return;
      }
      if (e.key === 'p' || e.key === 'P' || e.key === 'q' || e.key === 'Q') return ctrl.setPoster();
      if (e.key === 'Escape') return ctrl.setPoster(false);
      if (e.key === 'm' || e.key === 'M') return ctrl.toggleMuted();
      const phase = ctrl.snapshot.state?.phase;
      if (phase === 'MATCH_RESULTS') {
        // The ceremony: facilitator only (an /admin session in this browser).
        const act = ceremonyKey(e.key, isAdminRef.current);
        const clock = ceremony.current;
        if (!act || !clock) return;
        e.preventDefault();
        const t = performance.now();
        if (act === 'next') clock.next(t);
        else if (act === 'pause') clock.togglePause(t);
        else {
          clock.replay(t);
          cued.current = null;
        }
        return;
      }
      if (phase !== 'RESULTS') return;
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
  // In play (PLAN, PLACEMENT, BATTLE) the arena takes most of the stage and the
  // side becomes a narrow strip; LOBBY and the results keep the wide side.
  const playLayout = phase === 'PLAN' || phase === 'PLACEMENT' || phase === 'BATTLE';
  // BATTLE: no side column at all. The arena takes the whole stage and the army values become a small overlay on it.
  const battleLayout = phase === 'BATTLE';

  return (
    <div class="viewport">
      <div
        class={cx('stage', `phase-${phase.toLowerCase()}`, playLayout && 'play-layout', battleLayout && 'battle-layout')}
        style={{ transform: `translate(-50%, -50%) scale(${scale})` }}
      >
        <Header snap={snap} ctrl={ctrl} now={now} />
        <main class="body">
          <section class="arena-panel">
            <canvas ref={attach} class="arena pixelated" />
            {snap && ctrl && <ArenaOverlays snap={snap} ctrl={ctrl} now={now} controls={controls} actions={actions} />}
            {battleLayout && snap && ctrl && (
              <div class="score-overlay">
                <ArmyBars snap={snap} ctrl={ctrl} overlay />
              </div>
            )}
          </section>
          {!battleLayout && <aside class="side">{snap && ctrl && <Sidebar snap={snap} ctrl={ctrl} now={now} />}</aside>}
        </main>
        {snap && phase === 'MATCH_RESULTS' && state && ceremonyPos && !ceremonyHidden && (
          <Ceremony state={state} pos={ceremonyPos} steps={steps} isAdmin={isAdmin} />
        )}
        {snap && ctrl && snap.poster && <JoinPoster snap={snap} onClose={() => ctrl.setPoster(false)} />}
        {snap && ctrl && <SoundControl snap={snap} ctrl={ctrl} />}
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
        <p>{expired ? "Time's up! Waiting for the host to press START…" : PHASE_TEXT[phase].hint}</p>
      </div>
      <div class="clock">
        {state && (state.round > 0 || state.armory?.enabled || (state.phase !== 'LOBBY' && state.match?.wallsAllowed === false)) && (
          <div class="clock-meta">
            {state.round > 0 && (
              <span class="round pixel">
                Round {state.round} of {state.rounds}
              </span>
            )}
            {state.armory?.enabled && <span class="armory-on">💡 Open Armory</span>}
            {state.phase !== 'LOBBY' && state.match?.wallsAllowed === false && <span class="armory-on">🧱 No walls</span>}
          </div>
        )}
        {state?.match?.map && (
          <div class="map-name">
            🗺️ {mapName(state.match.map)}
            {state.match.teamMode !== 'ffa' && ` · ${teamModeLabel(state.match.teamMode, state.match.map.players)}`}
          </div>
        )}
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

function ArenaOverlays({
  snap,
  ctrl,
  now,
  controls,
  actions,
}: {
  snap: ScreenSnapshot;
  ctrl: ScreenController;
  now: number;
  controls: AdvanceControls;
  actions: { go: () => void; cancel: () => void };
}) {
  const phase = snap.state?.phase;
  const step = snap.revealAt !== null ? revealStep(now - snap.revealAt) : null;
  const pb = snap.playback;
  const battle = phase === 'BATTLE';
  // Not over the results: a battle that ends right as sudden death starts must not keep the banner up.
  const sd = (battle || !!snap.replay?.playing) && snap.suddenDeathAt !== null && now - snap.suddenDeathAt < SUDDEN_DEATH_BANNER_MS;
  const banner = readyBanner(snap.state, controls.go?.label);
  // On RESULTS the facilitator's banner carries the end text ("Battle over!") instead of stacking two titles.
  const ready = banner && phase === 'RESULTS' && banner.countdown === undefined && snap.end ? { ...banner, title: endReasonText(snap.end) } : banner;
  return (
    <>
      {ready && (
        <div class={cx('ready-banner', ready.countdown !== undefined && 'counting')} role="status">
          {ready.countdown !== undefined ? (
            <>
              <small>{ready.sub}</small>
              <span class="pixel">{ready.title}</span>
              <span class="count pixel" key={ready.countdown}>
                {ready.countdown}
              </span>
            </>
          ) : (
            <>
              <span class="pixel">{ready.title}</span>
              <small>{ready.sub}</small>
            </>
          )}
          {(controls.go || controls.cancel) && (
            <div class="adv-buttons">
              {controls.go && (
                <button class="adv-btn go pixel" onClick={actions.go} title={`${controls.go.space ? 'Space / Enter' : 'Enter'}: start the 3-second countdown`}>
                  {controls.go.label}
                </button>
              )}
              {controls.cancel && (
                <button class="adv-btn cancel pixel" onClick={actions.cancel} title="Esc">
                  ✕ Cancel
                </button>
              )}
              <span class="adv-keys">{controls.go ? (controls.go.space ? 'Space / Enter' : 'Enter') : 'Esc'}</span>
            </div>
          )}
        </div>
      )}
      {(phase === 'LOBBY' || phase === 'PLAN' || phase === 'PLACEMENT') && snap.toasts.length === 0 && (
        <div class="arena-caption pixel">{phase === 'PLACEMENT' ? 'Armies stay secret until START!' : 'The arena awaits…'}</div>
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
          {pb.speed === 2 && <span class="chip pixel speed">2x »</span>}
          {pb.paused && <span class="chip pixel paused">II PAUSED</span>}
          {pb.thinking && !pb.paused && <span class="chip pixel thinking">Thinking…</span>}
          {snap.suddenDeathAt !== null && (
            <span class="chip pixel sd">
              <span class="chip-ico">☠️</span> Sudden death
            </span>
          )}
        </div>
      )}
      {battle && pb?.paused && <div class="paused-veil pixel">PAUSED</div>}
      {snap.replay && (
        <div class="chips">
          <span class="chip pixel replay">
            {snap.replay.loading ? 'Loading replay…' : snap.replay.playing ? `${snap.replay.paused ? 'II' : '▶'} Replay ${snap.replay.speed}x` : 'Final moment'}
          </span>
        </div>
      )}
      {snap.replay && !snap.replay.loading && (snap.replay.playing || phase === 'RESULTS') && <ReplayBar ctrl={ctrl} />}
      {phase === 'RESULTS' && snap.end && !snap.replay?.playing && !ready && (
        <div class="end-reason pixel">{endReasonText(snap.end)}</div>
      )}
      {phase === 'RESULTS' && !snap.replay?.playing && (snap.state?.lastBattle ?? snap.end)?.topUnits?.length ? (
        <TopDamage end={(snap.state?.lastBattle ?? snap.end)!} now={now} />
      ) : null}
      <div class="toasts">
        {snap.toasts.map((t) => (
          <div key={t.id} class={cx('toast', `toast-${t.level}`)} style={{ '--seat': seatStyle(t.seat).color }}>
            {t.seat >= 0 && <b class="sym seat-num">{seatStyle(t.seat).symbol}</b>}
            {t.text}
          </div>
        ))}
      </div>
    </>
  );
}

/**
 * RESULTS: the round's top damage units over the bottom of the arena,
 * each with its sprite, the player who fielded it (seat badge + name, team
 * chip) and a damage count-up; cards pop in one after another.
 */
function TopDamage({ end, now }: { end: NonNullable<GameStateDTO['lastBattle']>; now: number }) {
  const { cards: top, more } = projectorTopCards(end.topUnits ?? []);
  const shownAt = useRef<number | null>(null);
  if (shownAt.current === null) shownAt.current = now;
  const elapsed = REDUCED_MOTION ? Number.POSITIVE_INFINITY : now - shownAt.current;
  return (
    <div class="top-damage">
      <h2 class="pixel">💥 Top damage</h2>
      <div class={cx('top-cards', top.length > 3 && 'many')}>
        {top.map((t, i) => {
          const seat = seatStyle(t.seat);
          return (
            <div
              key={`${t.playerId}-${t.unitId}`}
              class={cx('top-card', t.rank === 1 && 'first', t.left && 'left')}
              style={{ '--seat': seat.color, animationDelay: REDUCED_MOTION ? undefined : `${i * 250}ms` }}
            >
              <span class="top-rank">{topRankLabel(t.rank)}</span>
              <span class="top-sprite">
                <SpriteView spec={resolveSprite(topUnitLook(t))} specKey={topUnitKey(t, end.round)} outline={seat.color} width={56} />
              </span>
              <div class="top-info">
                <div class="top-name">{t.displayName}</div>
                <div class="top-by">
                  <span class="sym seat-num">{seat.symbol}</span>
                  {topUnitBy(t)}
                  {t.teamId !== undefined && <TeamChip teamId={t.teamId} />}
                </div>
                <div class="top-dmg pixel">{topUnitLine(t, countUp(t.damage, elapsed - (300 + i * 250)))}</div>
              </div>
            </div>
          );
        })}
      </div>
      {more > 0 && <p class="top-more">+{more} more with the same damage</p>}
    </div>
  );
}

/** Replay progress bar; click (or drag) to jump. */
function ReplayBar({ ctrl }: { ctrl: ScreenController }) {
  const pct = Math.round(ctrl.replayProgress() * 1000) / 10;
  const seekTo = (e: PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    if (r.width > 0) ctrl.seekReplay((e.clientX - r.left) / r.width);
  };
  return (
    <div
      class="replay-bar"
      role="slider"
      aria-label="Replay position"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      onPointerDown={(e) => {
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        seekTo(e);
      }}
      onPointerMove={(e) => {
        if (e.buttons & 1) seekTo(e);
      }}
    >
      <div class="replay-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Mute toggle and, until the browser allows audio, the "click to enable sound" hint. */
function SoundControl({ snap, ctrl }: { snap: ScreenSnapshot; ctrl: ScreenController }) {
  if (snap.audio === 'unsupported') return null;
  const locked = snap.audio === 'locked' && !snap.muted;
  return (
    <div class="sound-ctl">
      {locked && <span class="sound-hint pixel">🔈 Click anywhere to enable sound</span>}
      <button
        class={cx('btn small sound-btn', snap.muted && 'off')}
        title={snap.muted ? 'Sound off (M)' : 'Sound on (M)'}
        aria-pressed={!snap.muted}
        onClick={() => ctrl.toggleMuted()}
      >
        {snap.muted ? '🔇' : '🔊'}
      </button>
    </div>
  );
}

/** Full-screen join poster (P key or /admin): big QR and the URL. */
function JoinPoster({ snap, onClose }: { snap: ScreenSnapshot; onClose: () => void }) {
  const join = snap.join;
  const pretty = join?.joinUrl.replace(/^https?:\/\//, '') ?? '…';
  return (
    <div class="poster" onClick={onClose}>
      <div class="poster-logo pixel">
        PIXEL<span>CLASH</span>
      </div>
      <h1 class="pixel poster-title">Join the game!</h1>
      <div class="poster-main">
        {join?.qrSvg ? <div class="poster-qr" dangerouslySetInnerHTML={{ __html: join.qrSvg }} /> : <div class="poster-qr qr-empty" />}
        <div class="poster-text">
          <p>Scan the code or open:</p>
          <div class="poster-url pixel">
            {pretty.split(/(?=[:/])/).map((part, i) => (
              <Fragment key={i}>
                {i > 0 && <wbr />}
                {part}
              </Fragment>
            ))}
          </div>
          <p class="muted">
            Pick a name and a <span class="nowrap">4-digit</span> PIN.
          </p>
        </div>
      </div>
      {/* The terminal lives inside /play now: no terminal addresses on the projector. */}
      <div class="poster-seats">
        <h2 class="pixel">Your AI helper terminal is on the game page</h2>
        <p class="muted">Join on an AI seat laptop and you get a free AI seat automatically.</p>
      </div>
      <p class="poster-hint">Press P to close</p>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Sidebar by phase
// ---------------------------------------------------------------------------

function Sidebar({ snap, ctrl, now }: { snap: ScreenSnapshot; ctrl: ScreenController; now: number }) {
  const state = snap.state;
  if (!state) return <div class="panel muted">Connecting to the game…</div>;
  switch (state.phase) {
    case 'LOBBY':
    case 'PLAN': {
      // All seats taken: nobody can join, so the tiles get the whole column.
      // Past 4 players a smaller join card leaves room for 2-4 rows of tiles.
      const n = state.players.length;
      return (
        <>
          {n < snap.maxPlayers && <JoinCard snap={snap} compact={n > 4} />}
          <PlayerTiles state={state} maxPlayers={snap.maxPlayers} />
        </>
      );
    }
    case 'PLACEMENT':
      return <PlayerTiles state={state} maxPlayers={snap.maxPlayers} />;
    case 'BATTLE':
      return <ArmyBars snap={snap} ctrl={ctrl} />;
    case 'RESULTS':
      return <Ranking snap={snap} ctrl={ctrl} now={now} />;
    case 'MATCH_RESULTS':
      return <Ranking snap={snap} ctrl={ctrl} now={now} />;
  }
}

function JoinCard({ snap, compact }: { snap: ScreenSnapshot; compact?: boolean }) {
  const join = snap.join;
  const pretty = join?.joinUrl.replace(/^https?:\/\//, '') ?? '…';
  return (
    <div class={cx('panel join', compact && 'compact')}>
      <h2 class="pixel">Join here</h2>
      <div class="join-row">
        {join?.qrSvg ? <div class="qr" dangerouslySetInnerHTML={{ __html: join.qrSvg }} /> : <div class="qr qr-empty" />}
        <div class="join-text">
          <p>Scan the code or type the address below.</p>
          <p class="muted">
            Pick a name and a <span class="nowrap">4-digit</span> PIN.
          </p>
        </div>
      </div>
      {/* Full panel width so a LAN address fits on one line; it may only wrap at ':' or '/'. */}
      <div class="url pixel">
        {pretty.split(/(?=[:/])/).map((part, i) => (
          <Fragment key={i}>
            {i > 0 && <wbr />}
            {part}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

/** A team chip in team colour + ring pattern (the pattern keeps teams apart without colour). */
function TeamChip({ teamId, name }: { teamId: number; name?: string }) {
  const look = teamLook(teamId);
  if (!look) return null;
  return (
    <span class={cx('team-chip', `pat-${look.pattern}`)} style={{ '--team': look.color }}>
      {name ?? look.name}
    </span>
  );
}

function PlayerTiles({ state, maxPlayers = MAX_PLAYERS }: { state: GameStateDTO; maxPlayers?: number }) {
  const players = [...state.players].sort((a, b) => a.seat - b.seat);
  const teams = state.match?.teams ?? null;
  const table = new Map((state.match?.teamTable ?? []).map((t) => [t.teamId, t]));
  const groups = groupByTeam(players, teams);
  const compact = players.length > 4;
  const empty = teams ? 0 : freeTiles(players.length, maxPlayers);
  return (
    <div class={cx('panel players', compact && 'compact')}>
      <h2 class="pixel">
        Players {players.length}/{maxPlayers}
      </h2>
      {groups.map((g) => (
        <div key={g.team?.teamId ?? 'rest'} class={cx('tile-group', g.team && 'team-group')} style={g.team ? { '--team': g.team.color } : undefined}>
          {teams && (
            <div class="group-head">
              {g.team ? <TeamChip teamId={g.team.teamId} name={g.team.name} /> : <span class="muted">Next match</span>}
              {g.team && state.match?.teamBudgets?.[g.team.teamId] !== undefined && (
                <span class="muted">${state.match.teamBudgets[g.team.teamId]!.toLocaleString('en-US')} each</span>
              )}
              {g.team && state.round > 0 && table.get(g.team.teamId) && <span class="pts pixel">{table.get(g.team.teamId)!.points} pts</span>}
            </div>
          )}
          <div class="tiles">
            {g.players.map((p) => (
              <PlayerTile key={p.id} p={p} state={state} />
            ))}
            {!teams &&
              Array.from({ length: empty }, (_, i) => (
                <div key={`empty-${i}`} class="tile empty">
                  <span class="pixel">Free seat</span>
                </div>
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function PlayerTile({ p, state }: { p: PlayerStatusDTO; state: GameStateDTO }) {
  const seat = seatStyle(p.seat);
  const ticks = statusTicks(p, state.phase);
  const allDone = tileDone(p, state.phase);
  return (
    <div class={cx('tile', `seat-${p.seat}`, !p.connected && 'offline', allDone && 'done')}>
      <div class="tile-head">
        <span class="sym seat-num">{seat.symbol}</span>
        <span class="name">{p.name}</span>
        {/* The narrow play-layout strip shows these as tags in the head row (the list rows are hidden there). */}
        {!p.connected && <span class="off-tag">offline</span>}
        {p.benched && <span class="off-tag">next match</span>}
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
        {p.benched && <li class="off">plays next match</li>}
      </ul>
    </div>
  );
}

function ArmyBars({ snap, ctrl, overlay = false }: { snap: ScreenSnapshot; ctrl: ScreenController; overlay?: boolean }) {
  const reveal = snap.reveal;
  const started = ctrl.arena.instanceIds.length > 0;
  let values: ArmyValue[] = [];
  if (reveal && started) {
    const sample = ctrl.arena.buffer.sample(ctrl.arena.tick);
    values = armyValues(reveal, sample ? new Set(sample.units.map((u) => u.id)) : null, {
      factoryLeft: new Map((sample?.fac ?? []).map((f) => [f[0], factoryWorth(f)])),
    });
  } else if (reveal) {
    values = armyValues(reveal, null);
  }
  const teams = teamArmyValues(values, reveal?.teams);
  if (teams.length > 0) return <TeamArmyBars teams={teams} started={started} />;
  const max = Math.max(1, ...values.map((v) => v.start));
  const sorted = [...values].sort((a, b) => a.seat - b.seat);
  // 7-8 players: the unit count moves into the name row so every bar fits the column.
  const dense = overlay || sorted.length > 6;
  return (
    <div class={cx('panel armies', sorted.length > 4 && 'compact', dense && 'dense')}>
      {!overlay && <h2 class="pixel">Army value</h2>}
      {!reveal && <p class="muted">Get ready…</p>}
      {sorted.map((v) => {
        const seat = seatStyle(v.seat);
        const out = v.aliveCount === 0 && v.minions === 0 && started;
        return (
          <div key={v.playerId} class={cx('army', out && 'out')} style={{ '--seat': seat.color, '--seat-light': seat.light }}>
            <div class="army-head">
              <span class="sym seat-num">{seat.symbol}</span>
              <span class="name">{v.name}</span>
              {dense && (
                <small class="cnt">
                  {v.aliveCount}/{v.fieldedCount} units
                </small>
              )}
              <span class="val pixel">{out ? 'OUT' : formatMoney(v.living)}</span>
            </div>
            <div class="bar">
              <div class="fill" style={{ width: `${(100 * v.living) / max}%` }} />
              <div class="ghost" style={{ width: `${(100 * v.start) / max}%` }} />
            </div>
            {!dense && (
              <div class="army-foot">
                {v.aliveCount}/{v.fieldedCount} units standing
                {v.minions > 0 && ` · ${v.minions} minion${v.minions === 1 ? '' : 's'}`}
              </div>
            )}
          </div>
        );
      })}
      {!overlay && wallsCaption(reveal) && <p class="muted walls-caption">{WALLS_CAPTION}</p>}
    </div>
  );
}

/** The round of the first battle this screen showed with walls in it (the caption shows only then). */
let firstWallsRound: number | null = null;

function wallsCaption(reveal: BattleRevealDTO | null | undefined): boolean {
  if (!reveal || !revealHasWalls(reveal)) return false;
  firstWallsRound ??= reveal.round;
  return reveal.round === firstWallsRound;
}

/** Team mode: one bar per team, split into its members' living value. */
function TeamArmyBars({ teams, started }: { teams: ReturnType<typeof teamArmyValues>; started: boolean }) {
  const max = Math.max(1, ...teams.map((t) => t.start));
  return (
    <div class="panel armies teams">
      <h2 class="pixel">Team army value</h2>
      {teams.map((t) => {
        const out = started && t.members.every((m) => m.aliveCount === 0);
        return (
          <div key={t.team.teamId} class={cx('army', out && 'out')} style={{ '--team': t.team.color }}>
            <div class="army-head">
              <TeamChip teamId={t.team.teamId} name={t.team.name} />
              <span class="name" />
              <span class="val pixel">{out ? 'OUT' : formatMoney(t.living)}</span>
            </div>
            <div class="bar split">
              {t.members.map((m) => {
                const seat = seatStyle(m.seat);
                return (
                  <div
                    key={m.playerId}
                    class="part"
                    title={m.name}
                    style={{ width: `${(100 * m.living) / max}%`, '--seat': seat.color, '--seat-light': seat.light }}
                  >
                    {m.living > 0 && <span class="part-num pixel">{seat.symbol}</span>}
                  </div>
                );
              })}
              <div class="ghost" style={{ width: `${(100 * t.start) / max}%` }} />
            </div>
            <div class="army-foot">
              {t.members.map((m) => `${m.name} ${m.aliveCount}/${m.fieldedCount}`).join(' · ')}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Team mode RESULTS: this round's team places with the team table next to it. */
function TeamResults({ state }: { state: GameStateDTO }) {
  const rows = teamRankRows(state);
  if (rows.length === 0) return null;
  return (
    <table class="score-table team-results">
      <thead>
        <tr>
          <th />
          <th class="left">Team</th>
          <th title="Place points every member got this round">Place</th>
          <th title="Team points: the average of its members' totals">Team pts</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((t, i) => (
          <tr key={t.teamId} class={cx('rank', `place-${t.place}`)} style={{ '--seat': t.color, animationDelay: `${i * 120}ms` }}>
            <td class="medal">{PLACE_MEDALS[t.place - 1] ?? ''}</td>
            <td class="who">
              <TeamChip teamId={t.teamId} name={t.name} />
              <small>
                {t.memberNames.join(', ')} · {t.livingCost > 0 ? `${formatMoney(t.livingCost)} still standing` : 'knocked out'}
              </small>
            </td>
            <td class="num pixel">+{t.placePoints}</td>
            <td class="num gain pixel">
              {t.points}
              <small>{ordinal(t.tablePlace)} overall</small>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Ranking({ snap, ctrl, now }: { snap: ScreenSnapshot; ctrl: ScreenController; now: number }) {
  const state = snap.state!;
  const rows = rankRows(state.lastBattle ? state : { ...state, lastBattle: snap.end ?? undefined });
  const inventors = (state.lastBattle ?? snap.end)?.inventors ?? [];
  // The count-up starts when the ranking first has rows.
  const shownAt = useRef<number | null>(null);
  if (rows.length > 0 && shownAt.current === null) shownAt.current = now;
  // Reduced motion: final numbers at once (the CSS skips the pop-ins too).
  const elapsed = REDUCED_MOTION ? Number.POSITIVE_INFINITY : shownAt.current === null ? 0 : now - shownAt.current;
  const r = snap.replay;
  const board = standings(state.scoreboard);
  const lbState = state.lastBattle ? state : { ...state, lastBattle: snap.end ?? undefined };
  const teamMode = (lbState.lastBattle?.teams?.length ?? 0) > 0;
  const gained = new Map(rows.map((row) => [row.playerId, row]));
  // 7-8 players: one line per player (badges as emoji, no sub-lines) so both tables and Replay fit.
  const dense = Math.max(rows.length, board.length) > 6;
  const badge = (b: BadgeId, usedBy: number | undefined) => (dense ? BADGES[b].emoji : badgeLabel(b, usedBy));
  return (
    <div class={cx('panel ranking', rows.length > 3 && 'compact', dense && 'dense', teamMode && 'team-mode')}>
      <h2 class="pixel">Battle {snap.end?.round ?? state.round} results</h2>
      {rows.length === 0 && <p class="muted">Counting the points…</p>}
      {teamMode && <TeamResults state={lbState} />}
      {teamMode && board.length > 0 && (
        <>
          <h3 class="pixel board-title">Everyone</h3>
          <table class="score-table">
            <thead>
              <tr>
                <th />
                <th class="left">Player</th>
                <th title="The team's place points">Place</th>
                <th title="Damage bonus (your own)">💥</th>
                <th title="Value bonus (your own)">🗡️</th>
                <th>Round</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {board.map((s, i) => {
                const seat = seatStyle(s.seat);
                const row = gained.get(s.playerId);
                return (
                  <tr key={s.playerId} class="rank" style={{ '--seat': seat.color, animationDelay: `${400 + i * 80}ms` }}>
                    <td class="pixel place-num">{ordinal(s.place)}</td>
                    <td class="who">
                      <span class="sym seat-num">{seat.symbol}</span>
                      {s.name}
                      {row && row.badges.length > 0 && (
                        <span class="badges">
                          {row.badges.map((b) => (
                            <span key={b} class="badge" title={BADGES[b].title}>
                              {badge(b, row.inventorUsedBy)}
                            </span>
                          ))}
                        </span>
                      )}
                    </td>
                    <td class="num pixel">{row ? `+${row.placePoints}` : '–'}</td>
                    <td class="num pixel">{row ? `+${row.damageBonus}` : '–'}</td>
                    <td class="num pixel">{row ? `+${row.valueBonus}` : '–'}</td>
                    <td class="num gain pixel">{row ? `+${countUp(row.pointsGained, elapsed - 600 - i * 120)}` : ''}</td>
                    <td class="num pixel">{s.points}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
      {!teamMode && rows.length > 0 && (
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
              const gained = countUp(row.pointsGained, elapsed - countUpStartMs(i));
              return (
                <tr key={row.playerId} class={cx('rank', `place-${row.place}`)} style={{ '--seat': seat.color, animationDelay: `${i * 120}ms` }}>
                  <td class="medal">{PLACE_MEDALS[row.place - 1] ?? ''}</td>
                  <td class="who">
                    <span class="sym seat-num">{seat.symbol}</span>
                    {row.name}
                    <small>
                      {ordinal(row.place)} · {row.livingCost > 0 ? `${formatMoney(row.livingCost)} still standing` : 'knocked out'}
                    </small>
                    {row.badges.length > 0 && (
                      <span class="badges">
                        {row.badges.map((b, j) => (
                          <span key={b} class="badge" title={BADGES[b].title} style={{ animationDelay: `${badgePopDelayMs(i, j)}ms` }}>
                            {badge(b, row.inventorUsedBy)}
                          </span>
                        ))}
                      </span>
                    )}
                  </td>
                  <td class="num pixel">+{row.placePoints}</td>
                  <td class="num pixel">
                    +{row.damageBonus}
                    <small>{Math.round(row.damage).toLocaleString('en-US')} dmg</small>
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
      {!teamMode && board.length > 0 && (
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
                      <span class="sym seat-num">{seat.symbol}</span>
                      {s.name}
                    </td>
                    <td class="pixel">{s.points} pts</td>
                    <td title="Total damage this match (breaks ties)">💥 {Math.round(s.damage ?? 0).toLocaleString('en-US')}</td>
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
            <button class="btn pixel small" title={r.paused ? 'Resume (space)' : 'Pause (space)'} onClick={() => ctrl.toggleReplayPause()}>
              {/* "II", not ⏸: the pixel font has no ⏸ glyph and the fallback is a dot. */}
              {r.paused ? '▶' : 'II'}
            </button>
          )}
          <button class="btn pixel small" title="Join poster (P)" onClick={() => ctrl.setPoster(true)}>
            QR
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MATCH_RESULTS: podium, confetti, final scoreboard
// ---------------------------------------------------------------------------

/** Team mode MATCH_RESULTS: the team podium (members under each team). */
function TeamPodium({ table, teams, state }: { table: TeamTableRowDTO[]; teams: TeamDTO[] | null; state: GameStateDTO }) {
  const names = new Map(state.players.map((p) => [p.id, p.name]));
  const top = podiumOrder(table.slice(0, 3));
  return (
    <div class="podium">
      {top.map((t) => {
        const members = t.members.length ? t.members : (teams?.find((x) => x.teamId === t.teamId)?.members ?? []);
        return (
          <div
            key={t.teamId}
            class={cx('step', `step-${t.place}`)}
            style={{ '--seat': t.color, '--seat-light': t.color, animationDelay: `${podiumRiseMs(Math.min(3, t.place), REDUCED_MOTION)}ms` }}
          >
            <div class="medal">{PLACE_MEDALS[t.place - 1] ?? ''}</div>
            <div class="who">
              <TeamChip teamId={t.teamId} name={t.name} />
            </div>
            <div class={cx('block pixel', `pat-${t.pattern}`)}>
              <span>{ordinal(t.place)}</span>
              <small>{t.points} pts</small>
              <small class="dmg members">{members.map((id) => names.get(id) ?? '?').join(', ')}</small>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The awards ceremony: drumroll intro, each award with its winner(s)
 * and their best unit, the podium 3-2-1 with confetti, then the final board
 * with everyone's award icons. Facilitator keys show as a small hint.
 */
function Ceremony({ state, pos, steps, isAdmin }: { state: GameStateDTO; pos: CeremonyPosition; steps: readonly CeremonyStep[]; isAdmin: boolean }) {
  const step = pos.step;
  const many = state.scoreboard.length > 4;
  return (
    <div class={cx('ceremony', `cer-step-${step.kind}`, many && 'many')}>
      {step.kind === 'intro' && <CeremonyIntro state={state} count={steps.filter((x) => x.kind === 'award').length} />}
      {step.kind === 'award' && <AwardReveal key={step.award.id} step={step} elapsed={pos.elapsed} />}
      {step.kind === 'podium' && <PodiumStep state={state} elapsed={pos.elapsed} />}
      {step.kind === 'board' && <FinalBoard state={state} />}
      <ol class="cer-progress" aria-hidden="true">
        {steps.slice(0, -1).map((x, i) => (
          <li key={i} class={cx(i < pos.index && 'done', i === pos.index && 'now', x.kind !== 'award' && 'big')} />
        ))}
      </ol>
      {isAdmin && (
        <div class="cer-hint">
          {pos.paused && <b class="pixel">II PAUSED</b>}
          <span>{CEREMONY_HINT}</span>
        </div>
      )}
    </div>
  );
}

/** Step 1: the drumroll ("And the awards go to…") over every player's chip. */
function CeremonyIntro({ state, count }: { state: GameStateDTO; count: number }) {
  const players = [...state.scoreboard].sort((a, b) => a.seat - b.seat);
  return (
    <div class="cer-intro">
      <div class="cer-beams" aria-hidden="true" />
      <div class="cer-drum" aria-hidden="true">
        🥁
      </div>
      <h1 class="pixel cer-title">And the awards go to…</h1>
      <p class="cer-sub">
        {count} award{count === 1 ? '' : 's'} for {players.length} players
      </p>
      <div class="cer-players">
        {players.map((p, i) => {
          const seat = seatStyle(p.seat);
          return (
            <span key={p.playerId} class="cer-chip" style={{ '--seat': seat.color, animationDelay: REDUCED_MOTION ? undefined : `${400 + i * 120}ms` }}>
              <span class="sym seat-num">{seat.symbol}</span>
              {p.name}
              {p.teamId !== undefined && <TeamChip teamId={p.teamId} />}
            </span>
          );
        })}
      </div>
    </div>
  );
}

const AWARD_WINNERS_SHOWN = 4;
/** When the winners and the stat appear in an award step (ms). */
const WINNERS_AT_MS = REDUCED_MOTION ? 0 : 900;
const STAT_AT_MS = REDUCED_MOTION ? 0 : 1300;

/** Step 2: one award, its winner(s) with the sprite of their best unit, and the stat counting up. */
function AwardReveal({ step, elapsed }: { step: Extract<CeremonyStep, { kind: 'award' }>; elapsed: number }) {
  const a = step.award;
  const shown = a.winners.slice(0, AWARD_WINNERS_SHOWN);
  const more = a.winners.length - shown.length;
  const width = shown.length === 1 ? 200 : shown.length === 2 ? 160 : 120;
  const value = REDUCED_MOTION ? a.value : countUp(a.value, elapsed - STAT_AT_MS);
  return (
    <div class="cer-award">
      <div class="cer-count pixel">
        Award {step.index + 1} of {step.count}
      </div>
      <div class="cer-icon">{a.emoji}</div>
      <h1 class="pixel cer-name">{a.title}</h1>
      <p class="cer-rule">{a.rule}</p>
      <div class={cx('cer-winners', `n-${shown.length}`)} style={{ visibility: elapsed >= WINNERS_AT_MS ? 'visible' : 'hidden' }}>
        {shown.map((w, i) => (
          <AwardWinner key={w.playerId} w={w} width={width} delayMs={WINNERS_AT_MS + i * 200} elapsed={elapsed} />
        ))}
        {more > 0 && <div class="cer-more pixel">+{more} more</div>}
      </div>
      <div class="cer-stat pixel" style={{ visibility: elapsed >= STAT_AT_MS ? 'visible' : 'hidden' }}>
        {awardStatText(a.id, value)}
      </div>
    </div>
  );
}

function AwardWinner({ w, width, delayMs, elapsed }: { w: AwardWinnerDTO; width: number; delayMs: number; elapsed: number }) {
  const seat = seatStyle(w.seat);
  const u = w.bestUnit;
  // Show off: the unit swings at the crowd now and then.
  const anim = Math.floor(Math.max(0, elapsed - delayMs) / 1400) % 2 === 1 ? 'attack' : 'walk';
  return (
    <div class="cer-winner" style={{ '--seat': seat.color, animationDelay: REDUCED_MOTION ? undefined : `${delayMs}ms` }}>
      <div class="cer-sprite" style={{ width: `${width + 24}px`, height: `${width + 24}px` }}>
        {u && (
          <SpriteView
            spec={resolveSprite(topUnitLook(u))}
            specKey={`award-${w.playerId}-${u.unitId}/${u.spriteHidden || !u.sprite ? 'fallback' : 'own'}`}
            outline={seat.color}
            width={width}
            state={anim}
          />
        )}
      </div>
      <div class="cer-who">
        <span class="sym seat-num">{seat.symbol}</span>
        <span class="cer-who-name">{w.name}</span>
        {w.teamId !== undefined && <TeamChip teamId={w.teamId} />}
      </div>
      {u && (
        <div class="cer-unit">
          {u.name}
          {u.borrowedFrom && !u.name.includes(`(${u.borrowedFrom})`) ? ` (from ${u.borrowedFrom})` : ''}
        </div>
      )}
      {w.detail && <div class="cer-detail">{w.detail}</div>}
    </div>
  );
}

/** Step 3: the podium rises 3rd, 2nd, 1st; confetti and the winner's name with 1st. */
function PodiumStep({ state, elapsed }: { state: GameStateDTO; elapsed: number }) {
  const final = standings(state.scoreboard);
  const table = teamStandings(state.match?.teamTable ?? state.lastBattle?.teamTable);
  const firstUp = elapsed >= podiumRiseMs(1, REDUCED_MOTION) + 400;
  const champion = table.length > 0 ? (table[0] ? `${table[0].name} wins!` : 'Game over!') : final[0] ? `${final.filter((s) => s.place === 1).map((s) => s.name).join(' & ')} win${final.filter((s) => s.place === 1).length > 1 ? '' : 's'}!` : 'Game over!';
  return (
    <div class={cx('podium-overlay cer-podium', table.length > 0 && 'team-mode')}>
      {firstUp && !REDUCED_MOTION && <Confetti />}
      <h1 class="pixel champion" style={{ visibility: firstUp ? 'visible' : 'hidden' }}>
        {champion}
      </h1>
      {table.length > 0 ? (
        <TeamPodium table={table} teams={state.match?.teams ?? null} state={state} />
      ) : (
        <div class="podium">
          {podiumOrder(final.slice(0, 3)).map((s) => {
            const seat = seatStyle(s.seat);
            return (
              <div
                key={s.playerId}
                class={cx('step', `step-${s.place}`)}
                style={{ '--seat': seat.color, '--seat-light': seat.light, animationDelay: `${podiumRiseMs(Math.min(3, s.place), REDUCED_MOTION)}ms` }}
              >
                <div class="medal">{PLACE_MEDALS[s.place - 1] ?? ''}</div>
                <div class="who">
                  <span class="sym seat-num">{seat.symbol}</span> {s.name}
                </div>
                <div class="block pixel">
                  <span>{ordinal(s.place)}</span>
                  <small>{s.points} pts</small>
                  <small class="dmg">💥 {Math.round(s.damage ?? 0).toLocaleString('en-US')}</small>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Step 4: the final standings with every player's award icons (stays up). */
function FinalBoard({ state }: { state: GameStateDTO }) {
  const final = standings(state.scoreboard);
  const table = teamStandings(state.match?.teamTable ?? state.lastBattle?.teamTable);
  const awards = awardsByPlayer(state.matchAwards);
  return (
    <div class={cx('podium-overlay cer-board', final.length > 6 && 'many')}>
      {!REDUCED_MOTION && <Confetti count={60} />}
      <h1 class="pixel champion">Final standings</h1>
      {table.length > 0 && table[0] && (
        <p class="cer-team-win pixel">
          🏆 <TeamChip teamId={table[0].teamId} name={table[0].name} /> wins with {table[0].points} pts
        </p>
      )}
      <FinalTable final={final} awards={awards} compactOver={6} />
      {(state.matchAwards?.length ?? 0) > 0 && (
        <ul class="cer-award-grid">
          {state.matchAwards!.map((a) => (
            <li key={a.id} style={{ '--seat': a.winners.length === 1 ? seatStyle(a.winners[0]!.seat).color : 'var(--accent)' }} title={`${a.title}: ${a.text}`}>
              <span class="ag-emoji">{a.emoji}</span>
              <span class="ag-title">{a.title}</span>
              <span class="ag-who">{a.winners.map((w) => w.name).join(', ')}</span>
            </li>
          ))}
        </ul>
      )}
      <p class="thanks pixel">{table.length > 0 ? 'Great teamwork, everyone!' : 'Great battles, everyone!'}</p>
    </div>
  );
}

/** The final individual standings (MATCH_RESULTS). */
function FinalTable({
  final,
  awards,
  compactOver = 4,
}: {
  final: ReturnType<typeof standings>;
  awards?: ReturnType<typeof awardsByPlayer>;
  /** More players than this: the compact table. */
  compactOver?: number;
}) {
  return (
    <table class={cx('final', final.length > compactOver && 'compact')}>
      <tbody>
        {final.map((s) => {
          const seat = seatStyle(s.seat);
          return (
            <tr key={s.playerId} style={{ '--seat': seat.color }}>
              <td class="pixel">{ordinal(s.place)}</td>
              <td>
                <span class="sym seat-num">{seat.symbol}</span> {s.name}
                {s.teamId !== undefined && <TeamChip teamId={s.teamId} />}
              </td>
              <td class="pixel">{s.points} pts</td>
              <td class="dmg">💥 {Math.round(s.damage ?? 0).toLocaleString('en-US')}</td>
              {awards ? (
                <td class="award-icons">
                  {(awards.get(s.playerId) ?? []).map((a) => (
                    <span key={a.id} title={`${a.title}: ${a.text}`}>
                      {a.emoji}
                    </span>
                  ))}
                </td>
              ) : (
                <td class="badge-counts">
                  {badgeCounts(s).map((b) => (
                    <span key={b.id} title={b.title}>
                      {b.emoji}
                      {b.count > 1 ? `×${b.count}` : ''}
                    </span>
                  ))}
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
