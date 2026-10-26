// /play root: join screen, or the header plus the Claude terminal and the
// game: a split view with a draggable divider on wide
// screens, two in-page tabs ("Claude" / "Game") on 1366×768 and smaller. Both
// panes stay mounted in the same place in the tree, so switching tabs or
// crossing the breakpoint never reloads the terminal (no Claude restart).

import type { Phase } from '@pixel-clash/shared';
import { useEffect, useRef, useState } from 'preact/hooks';
import { cx } from '../../common/ui.js';
import {
  PHASE_BADGE_TEXT,
  SPLIT_DEFAULT,
  SPLIT_KEY,
  TAB_KEY,
  claudeNeedsLook,
  claudeView,
  clampSplit,
  initialTab,
  layoutFor,
  nudgeAllowed,
  parseSplit,
  splitKey,
  unitsBadgeText,
  type PlayLayout,
  type PlayTab,
} from '../claudePane.js';
import { getStore, useStore } from '../store.js';
import { Battle } from './Battle.js';
import { ClaudePane } from './ClaudePanel.js';
import { EditorHost } from './EditorHost.js';
import { GuideOverlay, setGuideOpen } from './GuideOverlay.js';
import { Header } from './Header.js';
import { Join } from './Join.js';
import { PastBattles, PastBattlesButton } from './PastBattles.js';
import { Placement } from './Placement.js';
import { PlanReady } from './PlanReady.js';
import { Results } from './Results.js';
import { Roster } from './Roster.js';
import { TeamPanel } from './TeamPanel.js';

function Toasts() {
  const st = useStore();
  const store = getStore();
  return (
    <div class="toasts" aria-live="polite">
      {st.toasts.map((t) => (
        <button key={t.id} class={cx('toast', t.level)} onClick={() => store.dismiss(t.id)}>
          {t.message}
        </button>
      ))}
    </div>
  );
}

function Lobby() {
  const st = useStore();
  const others = st.game?.players.filter((p) => p.id !== st.player?.id) ?? [];
  return (
    <section class="panel lobby">
      <h2>You're in!</h2>
      <p>
        When everyone has joined, the host starts the game. First, say hi to your AI helper in your terminal: tell it your player name and PIN.
      </p>
      {others.length > 0 && <p class="dim">Also here: {others.map((p) => p.name).join(', ')}</p>}
    </section>
  );
}

/** Team mode, joined after Start match: sits out until the next match. */
function Benched() {
  const st = useStore();
  if (!st.priv?.benched) return null;
  return (
    <section class="panel benched">
      <h2>Teams are set for this match</h2>
      <p>You'll play in the next match! You can still ask your AI helper to build units now, so you're ready.</p>
    </section>
  );
}

function Main({ phase }: { phase: Phase }) {
  switch (phase) {
    case 'LOBBY':
      return (
        <>
          <Lobby />
          <Roster phase={phase} />
        </>
      );
    case 'PLAN':
      return (
        <>
          <Benched />
          <PlanReady />
          <TeamPanel phase={phase} />
          <Roster phase={phase} />
        </>
      );
    case 'PLACEMENT':
      return (
        <>
          <Placement />
          <TeamPanel phase={phase} />
        </>
      );
    case 'BATTLE':
      return <Battle />;
    case 'RESULTS':
    case 'MATCH_RESULTS':
      return (
        <>
          <Results />
          <Roster phase={phase} />
        </>
      );
  }
}

export function App() {
  const st = useStore();

  if (st.auth === 'unknown') {
    return <main class="join"><p class="pixel">Loading…</p></main>;
  }
  if (st.auth === 'kicked') {
    return (
      <main class="join">
        <div class="panel">
          <h2>You left the game</h2>
          <p>A grown-up took you out of this game. If that seems wrong, ask them for help.</p>
          <button class="btn" onClick={() => location.reload()}>
            Back to the start
          </button>
        </div>
      </main>
    );
  }
  if (st.auth === 'out') {
    return (
      <>
        <Join />
        <Toasts />
      </>
    );
  }
  return <PlayShell />;
}

// ---------------------------------------------------------------------------
// Layout: split view / tabs
// ---------------------------------------------------------------------------

function readStorage(store: 'local' | 'session', key: string): string | null {
  try {
    return (store === 'local' ? localStorage : sessionStorage).getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(store: 'local' | 'session', key: string, value: string): void {
  try {
    (store === 'local' ? localStorage : sessionStorage).setItem(key, value);
  } catch {
    // private window: not remembered
  }
}

function useViewport(): { width: number; layout: PlayLayout } {
  const read = () => ({ width: window.innerWidth, layout: layoutFor(window.innerWidth, window.innerHeight) });
  const [vp, setVp] = useState(read);
  useEffect(() => {
    const onResize = () => {
      const next = read();
      setVp((v) => (v.width === next.width && v.layout === next.layout ? v : next));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return vp;
}

/** Re-render every second while `on` (the PLACEMENT nudge waits for a typing pause). */
function useSecondTick(on: boolean): void {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setN((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [on]);
}

function PlayShell() {
  const st = useStore();
  const store = getStore();
  const phase = st.game?.phase ?? 'LOBBY';
  const { width, layout } = useViewport();
  const [tab, setTab] = useState<PlayTab>(() => initialTab(readStorage('session', TAB_KEY), st.me?.claudeSeat != null, st.game?.phase));
  const [focusSeq, setFocusSeq] = useState(0);
  const [split, setSplit] = useState(() => parseSplit(readStorage('local', SPLIT_KEY)));
  const [dragging, setDragging] = useState(false);
  const [pastOpen, setPastOpen] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);

  const isSplit = layout === 'split';
  const claudeShowing = isSplit || tab === 'claude';
  const gameShowing = isSplit || tab === 'game';
  useEffect(() => store.setGameShowing(gameShowing), [store, gameShowing]);

  const view = claudeView(st.terminal, st.displaced, st.lastHolder);
  const ratio = clampSplit(split, width);

  const choose = (t: PlayTab) => {
    setTab(t);
    setGuideOpen(false);
    writeStorage('session', TAB_KEY, t);
    if (t === 'claude') setFocusSeq((n) => n + 1);
  };
  const saveSplit = (r: number) => {
    setSplit(r);
    writeStorage('local', SPLIT_KEY, r.toFixed(3));
  };

  const dragTo = (clientX: number) => {
    const box = shellRef.current?.getBoundingClientRect();
    if (box && box.width > 0) setSplit(clampSplit((clientX - box.left) / box.width, box.width));
  };

  const shellStyle = isSplit ? { gridTemplateColumns: `minmax(0, ${ratio}fr) 12px minmax(0, ${1 - ratio}fr)` } : undefined;

  return (
    <div class={cx('play-app', `layout-${layout}`)}>
      <Header />
      {!isSplit && <PaneTabs tab={tab} onChoose={choose} claudeWarn={claudeNeedsLook(view)} />}
      <div ref={shellRef} key="shell" class={cx('shell', `show-${tab}`, dragging && 'dragging')} style={shellStyle}>
        <section
          id="pane-claude"
          class={cx('pane claude-side', !claudeShowing && 'pane-hidden')}
          role={isSplit ? 'region' : 'tabpanel'}
          aria-label="AI helper"
          inert={!claudeShowing}
        >
          <ClaudePane visible={claudeShowing} layout={layout} focusSeq={focusSeq} onShowGame={() => choose('game')} />
        </section>
        <div
          class="divider"
          role="separator"
          aria-orientation="vertical"
          aria-label="Make the AI helper or the game bigger"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(ratio * 100)}
          tabIndex={isSplit ? 0 : -1}
          hidden={!isSplit}
          onPointerDown={(e) => {
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            setDragging(true);
          }}
          onPointerMove={(e) => {
            if (dragging) dragTo(e.clientX);
          }}
          onPointerUp={(e) => {
            if (!dragging) return;
            setDragging(false);
            e.currentTarget.releasePointerCapture(e.pointerId);
            saveSplit(clampSplit(split, width));
          }}
          onPointerCancel={() => setDragging(false)}
          onDblClick={() => saveSplit(SPLIT_DEFAULT)}
          onKeyDown={(e) => {
            const next = splitKey(ratio, e.key, width);
            if (next === null) return;
            e.preventDefault();
            saveSplit(next);
          }}
        />
        <section
          id="pane-game"
          class={cx('pane game-side', !gameShowing && 'pane-hidden')}
          role={isSplit ? 'region' : 'tabpanel'}
          aria-label="Game"
          inert={!gameShowing}
        >
          <main class={cx('play', `phase-${phase.toLowerCase()}`)}>
            {st.socket !== 'open' && <p class="note offline">Reconnecting to the game…</p>}
            {st.priv && !st.priv.active && !st.priv.benched && phase !== 'LOBBY' && phase !== 'PLACEMENT' && (
              <p class="note">You joined partway through a round. You're in from the next round!</p>
            )}
            {/* The code editor takes the game's place; the game stays mounted underneath. */}
            {st.editor && <EditorHost target={st.editor} />}
            <div class="game-view" hidden={!!st.editor}>
              <PastBattlesButton open={pastOpen} onToggle={() => setPastOpen(!pastOpen)} />
              {pastOpen && <PastBattles onClose={() => setPastOpen(false)} />}
              <Main phase={phase} />
            </div>
          </main>
        </section>
        {/* The unit guide: over the Game column (split) or both panes (tabs); the terminal stays mounted. */}
        <GuideOverlay />
        {/* While dragging, a shield over everything so the iframe doesn't swallow the pointer. */}
        {dragging && <div class="drag-shield" />}
      </div>
      <Toasts />
    </div>
  );
}

/** "Claude" / "Game" tabs (narrow screens) with the Game tab's badges. */
function PaneTabs({ tab, onChoose, claudeWarn }: { tab: PlayTab; onChoose: (t: PlayTab) => void; claudeWarn: boolean }) {
  const st = useStore();
  const store = getStore();
  const b = st.badges;
  const placing = b.phase === 'place' && tab === 'claude';
  useSecondTick(placing);
  const pulse = placing && nudgeAllowed(store.lastTypedAt, Date.now());
  return (
    <nav class="pane-tabs" role="tablist" aria-label="AI helper or game">
      <button
        role="tab"
        id="tab-claude"
        aria-controls="pane-claude"
        aria-selected={tab === 'claude'}
        class={cx('pane-tab', tab === 'claude' && 'on')}
        onClick={() => onChoose('claude')}
      >
        <span>AI helper</span>
        {tab === 'game' && claudeWarn && (
          <span class="tab-badge warn" title="Your AI helper terminal needs a look">
            ⚠
          </span>
        )}
      </button>
      <button
        role="tab"
        id="tab-game"
        aria-controls="pane-game"
        aria-selected={tab === 'game'}
        class={cx('pane-tab', tab === 'game' && 'on')}
        onClick={() => onChoose('game')}
      >
        <span>Game</span>
        {tab === 'claude' && (
          <span class="tab-badges" aria-live="polite">
            {b.units > 0 && (
              <span class="tab-badge units" title={unitsBadgeText(b.units)}>
                {b.units} new
              </span>
            )}
            {b.warn && (
              <span class="tab-badge warn" title="A unit needs fixing">
                ⚠
              </span>
            )}
            {b.phase && <span class={cx('tab-badge phase', `ph-${b.phase}`, pulse && 'pulse')}>{PHASE_BADGE_TEXT[b.phase]}</span>}
          </span>
        )}
      </button>
    </nav>
  );
}
