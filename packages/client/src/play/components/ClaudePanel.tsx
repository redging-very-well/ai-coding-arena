// "Open my Claude terminal" (seat picker → http://<claude-box>:778N, §11.1)
// and "Get my Claude kit" (API key reveal + personal kit download, §11).

import { useEffect, useState } from 'preact/hooks';
import type { SetupInfoDTO } from '@pixel-clash/shared';
import { api, request } from '../../common/api.js';
import { cx } from '../../common/ui.js';
import { CLAUDE_SEATS, claudeTerminalUrl } from '../logic.js';
import { getStore, useStore } from '../store.js';
import { CopyButton } from './CopyButton.js';

const SEAT_KEY = 'pc-claude-seat';

function loadSeat(): number | null {
  try {
    const n = Number(localStorage.getItem(SEAT_KEY));
    return Number.isInteger(n) && n >= 1 && n <= CLAUDE_SEATS ? n : null;
  } catch {
    return null;
  }
}

/**
 * The Claude box address the facilitator set in /admin (public GET /api/setup).
 * Refetched on every phase change, and every 20 s while it is still unset.
 */
function useClaudeBox(): { host: string | null; urls: Map<number, string> } {
  const phase = useStore().game?.phase;
  const [info, setInfo] = useState<SetupInfoDTO | null>(null);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      try {
        const i = await request<SetupInfoDTO>('GET', '/setup');
        if (cancelled) return;
        setInfo(i);
        if (!i.settings?.claudeBoxHost) timer = setTimeout(() => void load(), 20000);
      } catch {
        if (!cancelled) timer = setTimeout(() => void load(), 20000);
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [phase]);
  // Server seats are 0-7; players see "Seat 1-8".
  const urls = new Map((info?.seatTerminals ?? []).map((t) => [t.seat + 1, t.url]));
  return { host: info?.settings?.claudeBoxHost ?? null, urls };
}

export function ClaudeTerminal() {
  const [seat, setSeat] = useState<number | null>(loadSeat);
  const { host: box, urls } = useClaudeBox();
  const pick = (n: number) => {
    setSeat(n);
    try {
      localStorage.setItem(SEAT_KEY, String(n));
    } catch {
      // not remembered, that's fine
    }
  };
  const url = seat ? (urls.get(seat) ?? claudeTerminalUrl(box, seat)) : null;

  return (
    <section class="panel claude-term">
      <h2>My Claude terminal</h2>
      {!box ? (
        <p class="dim">The grown-ups haven't set up the Claude computer yet. Ask them which terminal is yours!</p>
      ) : (
        <>
          <p>Which Claude seat is yours? (It's on your seat card.)</p>
          <div class="seat-picker" role="radiogroup" aria-label="Claude seat">
            {Array.from({ length: CLAUDE_SEATS }, (_, i) => i + 1).map((n) => (
              <button key={n} role="radio" aria-checked={seat === n} class={cx('seat-btn', seat === n && 'chosen')} onClick={() => pick(n)}>
                Seat {n}
              </button>
            ))}
          </div>
          {url && (
            <a class="btn big-link" href={url} target="_blank" rel="noopener">
              Open my Claude terminal ↗
            </a>
          )}
          <p class="dim small">Tell Claude your player name and PIN the first time, then ask it for units!</p>
        </>
      )}
    </section>
  );
}

export function ClaudeKit() {
  const st = useStore();
  const store = getStore();
  const [open, setOpen] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const key = st.me?.apiKey ?? '';

  return (
    <section class="panel claude-kit">
      <button class="kit-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <h2>Get my Claude kit</h2>
        <span class="dim">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div class="kit-body">
          <p class="dim small">
            Only needed on a laptop with Claude Code installed. On the Claude terminal, just tell Claude your name and PIN.
          </p>
          <a class="btn" href={api.kitUrl()} download="pixel-clash-kit.zip">
            ⬇ Download my Claude kit
          </a>
          <div class="api-key">
            <span>API key:</span>
            <code class={showKey ? '' : 'hidden-key'}>{showKey ? key : '••••••••••••••••'}</code>
            <button class="mini" onClick={() => setShowKey((v) => !v)}>
              {showKey ? 'Hide' : 'Show'}
            </button>
            {showKey && key && <CopyButton text={key} />}
          </div>
          <p class="dim small">Keep your key secret, like a password.</p>
          <button class="mini ghost" onClick={() => void store.logout()}>
            Log out
          </button>
        </div>
      )}
    </section>
  );
}
