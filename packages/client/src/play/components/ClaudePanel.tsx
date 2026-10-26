// The embedded Claude terminal (plan §11.2 d): the player's Claude seat's ttyd
// through the game server's proxy (/terminal/N/), in an iframe that stays
// mounted across tab switches and breakpoints (not under the "open in another
// tab" overlay, and not before the first `terminal` push says nobody else
// holds the seat: loading it takes the seat over). Join / login assign a seat
// by themselves (§11.2 c), so the picker is the fallback (no seat free, or
// "Change seat"). Pane states: seat picker, not
// ready, the terminal (with a "box down" strip), and "open in another tab"
// with "Use it here instead". "Open in new tab" opens the same terminal as its
// own browser tab.

import { useEffect, useRef, useState } from 'preact/hooks';
import { cx } from '../../common/ui.js';
import {
  NO_FREE_SEAT_TEXT,
  claudeView,
  noFreeSeat,
  terminalPath,
  terminalTabName,
  viewHasFrame,
  viewOffersTab,
  type ClaudeView,
  type PlayLayout,
} from '../claudePane.js';
import { CLAUDE_SEATS, claudeTerminalUrl } from '../logic.js';
import { getStore, useStore } from '../store.js';
import { CopyButton } from './CopyButton.js';

// ---------------------------------------------------------------------------
// Focus (same-origin iframe, so this is allowed)
// ---------------------------------------------------------------------------

/** Focus the terminal: the iframe's window, then xterm's input (it appears once ttyd's page has started). */
export function focusTerminal(frame: HTMLIFrameElement | null, tries = 8): void {
  if (!frame) return;
  try {
    frame.focus();
    frame.contentWindow?.focus();
    const ta = frame.contentDocument?.querySelector<HTMLElement>('.xterm-helper-textarea');
    if (ta) {
      ta.focus();
      return;
    }
  } catch {
    return; // not our origin (should not happen): leave focus alone
  }
  if (tries > 0) setTimeout(() => focusTerminal(frame, tries - 1), 250);
}

/** Nothing else has focus: page load, or the player clicked empty space. */
function focusIsFree(frame: HTMLIFrameElement | null): boolean {
  const a = document.activeElement;
  return !a || a === document.body || a === frame;
}

// ---------------------------------------------------------------------------
// Pane
// ---------------------------------------------------------------------------

export interface ClaudePaneProps {
  /** The pane is on screen (split view, or the Claude tab). */
  visible: boolean;
  layout: PlayLayout;
  /** Bumped when the player opens the Claude tab: focus the terminal. */
  focusSeq: number;
  /** The "Time to place your army → Game" strip was clicked. */
  onShowGame: () => void;
}

export function ClaudePane({ visible, layout, focusSeq, onShowGame }: ClaudePaneProps) {
  const st = useStore();
  const store = getStore();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const view = claudeView(st.terminal, st.displaced, st.lastHolder);
  const seat = st.terminal?.seat ?? null;
  const live = view.kind === 'terminal';

  // The player opened the Claude tab (or clicked the pane header): keys go to the terminal.
  useEffect(() => {
    if (focusSeq > 0 && visible && live) focusTerminal(frameRef.current);
  }, [focusSeq]);

  const focusHere = () => {
    if (live) focusTerminal(frameRef.current);
  };

  return (
    <div class={cx('claude-pane', `claude-${view.kind}`)}>
      <div class="claude-head">
        <button class="claude-title" onClick={focusHere} title={live ? 'Type to your AI helper' : undefined}>
          <span class="pixel">AI helper</span>
          {seat !== null && <span class="dim small">seat {seat}</span>}
        </button>
        {seat !== null && viewOffersTab(view) && (
          <a
            class="btn small open-tab"
            href={terminalPath(seat)}
            target={terminalTabName(seat)}
            title="Opens this same terminal as its own browser tab"
          >
            Open in new tab ↗
          </a>
        )}
        {seat !== null && <ChangeSeat />}
      </div>
      {layout === 'tabs' && st.game?.phase === 'PLACEMENT' && (
        // Not focusable on purpose: game events never take the keyboard away from the terminal.
        <div class="place-strip" onClick={onShowGame}>
          Time to place your army → <b>Game</b>
        </div>
      )}
      {st.seatAsk && <SeatAsk ask={st.seatAsk} />}
      <div class="claude-body">
        {view.kind === 'picker' && <SeatPicker />}
        {view.kind === 'not-ready' && <NotReady seat={seat} />}
        {view.kind === 'terminal' && !st.holderKnown && (
          <div class="claude-msg">
            <p class="dim">Connecting to your AI helper…</p>
          </div>
        )}
        {viewHasFrame(view) && st.holderKnown && seat !== null && (
          <TerminalFrame
            key={`${seat}:${st.frameSeq}`}
            frameRef={frameRef}
            src={terminalPath(seat, store.pane)}
            seat={seat}
            visible={visible}
          />
        )}
        {view.kind === 'terminal' && view.down && <DownStrip seat={view.seat} />}
        {view.kind === 'elsewhere' && <Elsewhere view={view} />}
      </div>
    </div>
  );
}

function TerminalFrame(props: { frameRef: { current: HTMLIFrameElement | null }; src: string; seat: number; visible: boolean }) {
  const store = getStore();
  const visible = useRef(props.visible);
  visible.current = props.visible;
  useEffect(() => store.frameMounted(), [store]);

  const onLoad = () => {
    const f = props.frameRef.current;
    try {
      // Keystrokes in the terminal hold back the PLACEMENT nudge (same origin: we may listen).
      f?.contentDocument?.addEventListener('keydown', () => (store.lastTypedAt = Date.now()), true);
    } catch {
      // the friendly error page or a cross-origin redirect: nothing to listen to
    }
    if (visible.current && focusIsFree(f)) focusTerminal(f);
  };

  return (
    <iframe
      ref={props.frameRef}
      class="claude-frame"
      src={props.src}
      title={`AI helper terminal, seat ${props.seat}`}
      // Copy/paste in xterm. No sandbox: the terminal must be same-origin.
      allow="clipboard-read; clipboard-write"
      onLoad={onLoad}
    />
  );
}

/** "Change seat" with a confirm step (changing restarts Claude on the new laptop's seat). */
function ChangeSeat() {
  const store = getStore();
  const [ask, setAsk] = useState(false);
  if (!ask) {
    return (
      <button class="mini ghost change-seat" onClick={() => setAsk(true)}>
        Change seat
      </button>
    );
  }
  return (
    <span class="change-seat confirm">
      Wrong laptop?{' '}
      <button class="mini" onClick={() => void store.claimSeat(null).then(() => setAsk(false))}>
        Pick again
      </button>{' '}
      <button class="mini ghost" onClick={() => setAsk(false)}>
        Cancel
      </button>
    </span>
  );
}

/** The seat card's seat differs from the player's: ask, never switch silently (§11.2 c). */
function SeatAsk({ ask }: { ask: { seat: number; current: number } }) {
  const store = getStore();
  return (
    <div class="note seat-ask" role="alert">
      <p>
        This laptop is AI seat <b>{ask.seat}</b>, but you're on seat <b>{ask.current}</b>. Switch to seat {ask.seat}?
      </p>
      <div class="btn-row">
        <button class="btn primary" onClick={() => void store.claimSeat(ask.seat)}>
          Switch to seat {ask.seat}
        </button>
        <button class="btn" onClick={() => store.keepSeat()}>
          Keep seat {ask.current}
        </button>
      </div>
    </div>
  );
}

function SeatPicker() {
  const st = useStore();
  const store = getStore();
  useEffect(() => void store.loadClaudeSeats(), [store]);
  const seats = st.claudeSeats?.seats ?? Array.from({ length: CLAUDE_SEATS }, (_, i) => ({ seat: i + 1, takenBy: null, mine: false, status: 'unknown' as const }));
  const laptop = st.laptopSeat;
  const laptopRow = laptop === null ? undefined : seats.find((s) => s.seat === laptop);
  const offerLaptop = laptopRow && !laptopRow.takenBy;
  const full = noFreeSeat(st.claudeSeats);

  return (
    <div class="seat-pick">
      <h2>Pick an AI seat</h2>
      <p class="dim">Your AI helper terminal then opens right here.</p>
      {full && !st.seatError && (
        <p class="note" role="status">
          {NO_FREE_SEAT_TEXT}
        </p>
      )}
      {offerLaptop && (
        <button class="btn big-link" onClick={() => void store.claimSeat(laptop)}>
          Use AI seat {laptop}
        </button>
      )}
      <div class="seat-picker" role="group" aria-label="AI seat">
        {seats.map((s) => (
          <button
            key={s.seat}
            class={cx('seat-btn', s.seat === laptop && 'chosen', s.takenBy && 'taken')}
            onClick={() => void store.claimSeat(s.seat)}
            title={s.takenBy ? `${s.takenBy} is on AI seat ${s.seat}` : `Use AI seat ${s.seat}`}
          >
            <span>Seat {s.seat}</span>
            <span class="seat-sub">{s.takenBy ?? (s.status === 'down' ? '(off)' : 'free')}</span>
          </button>
        ))}
      </div>
      {st.seatError && (
        <p class="note bad" role="alert">
          {st.seatError}
        </p>
      )}
      {st.claudeSeats && !st.claudeSeats.boxReady && (
        <p class="dim small">Your AI helper isn't ready yet, but you can pick your seat already.</p>
      )}
    </div>
  );
}

function NotReady({ seat }: { seat: number | null }) {
  return (
    <div class="claude-msg">
      <div class="claude-msg-icon" aria-hidden="true">
        🛠️
      </div>
      <h2>Your AI helper isn't ready yet</h2>
      <p>A grown-up is on it! Your terminal opens here by itself once it's ready{seat !== null ? ` (AI seat ${seat})` : ''}.</p>
      <p class="dim small">Meanwhile, have a look at the Game.</p>
    </div>
  );
}

/** The probe says the seat is down: the iframe's own page retries; this tells the player why. */
function DownStrip({ seat }: { seat: number }) {
  const st = useStore();
  const store = getStore();
  useEffect(() => void store.loadBoxHost(), [store]);
  const direct = claudeTerminalUrl(st.boxHost, seat);
  return (
    <div class="term-strip" role="status">
      <span>The AI computer isn't answering. Trying again by itself…</span>
      {direct && <GrownUps url={direct} />}
    </div>
  );
}

/** The adults' fallback: ttyd directly on the Claude box (asks for the seat password). */
function GrownUps({ url }: { url: string }) {
  return (
    <details class="grown-ups">
      <summary>For grown-ups</summary>
      <span class="small">
        Direct link (needs the seat password): <code>{url}</code> <CopyButton text={url} />
      </span>
    </details>
  );
}

function Elsewhere({ view }: { view: Extract<ClaudeView, { kind: 'elsewhere' }> }) {
  const store = getStore();
  const admin = view.by === 'admin';
  return (
    <div class="claude-overlay" role="dialog" aria-modal="false" aria-labelledby="claude-elsewhere">
      <div class="claude-msg">
        <div class="claude-msg-icon" aria-hidden="true">
          {admin ? '🧑‍🏫' : '🗂️'}
        </div>
        <h2 id="claude-elsewhere">{admin ? 'A grown-up is helping on your AI helper terminal' : 'Your AI helper terminal is open in another tab'}</h2>
        <p>
          {admin
            ? 'Wait until they are done, then take it back here.'
            : 'Only one place can have it at a time. Use it there, or bring it back here.'}
        </p>
        <button class="btn primary big" onClick={() => store.useHere()}>
          {admin ? 'Get it back' : 'Use it here instead'}
        </button>
        <p class="dim small">Your AI helper remembers your chat, it just restarts for a moment.</p>
      </div>
    </div>
  );
}
