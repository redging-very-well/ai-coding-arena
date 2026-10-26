// /setup (plan §11): the big join URL + QR, the generic Claude kit download,
// the seat cards (Claude seats 1-8: `/play?seat=N` + QR, §11.2) and the setup
// checklist.

import { useEffect, useState } from 'preact/hooks';
import type { SetupInfoDTO } from '@pixel-clash/shared';
import { api } from '../common/api.js';
import { copyText } from '../common/ui.js';
import { CHECKLIST } from './checklist.js';
import { getSetupInfo } from './setupApi.js';

const STORAGE_KEY = 'pc-setup-checklist';

function loadTicks(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
}

function saveTicks(t: Record<string, boolean>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(t));
  } catch {
    // private window: ticks just don't persist
  }
}

export function SetupPage() {
  const [info, setInfo] = useState<SetupInfoDTO | null>(null);
  const [error, setError] = useState('');
  const [ticks, setTicks] = useState<Record<string, boolean>>(loadTicks);

  useEffect(() => {
    const load = () =>
      getSetupInfo()
        .then((i) => {
          setInfo(i);
          setError('');
        })
        .catch(() => setError("Can't reach the game server. Is it running?"));
    void load();
    const t = setInterval(load, 10_000);
    window.addEventListener('focus', load);
    return () => {
      clearInterval(t);
      window.removeEventListener('focus', load);
    };
  }, []);

  const toggle = (id: string) => {
    const next = { ...ticks, [id]: !ticks[id] };
    setTicks(next);
    saveTicks(next);
  };

  return (
    <div class="setup">
      <header class="setup-head">
        <h1>Pixel Clash · Setup</h1>
        <a class="link" href="/admin">
          /admin
        </a>
      </header>
      {error && <div class="banner-bad">{error}</div>}
      {info && info.sandboxMode !== 'ivm' && (
        <div class="banner-bad">Sandbox mode is {info.sandboxMode}, not isolated-vm.</div>
      )}

      <section class="panel join">
        {info ? (
          <>
            <div class="qr big" dangerouslySetInnerHTML={{ __html: info.playQrSvg }} />
            <div>
              <div class="label">Players open</div>
              <div class="huge-url">{info.playUrl}</div>
              {info.lanUrls.length > 1 && (
                <p class="dim small">
                  This machine has several addresses: {info.lanUrls.join(', ')}. Pick the one the players' Wi-Fi reaches in /admin.
                </p>
              )}
              {info.lanUrls.length === 0 && <p class="warn-text">No LAN address found: is this machine on the event network?</p>}
              <div class="btn-row">
                <a class="btn primary" href={api.setupKitUrl()} download>
                  Download kit for Claude Code (zip)
                </a>
                <a class="btn" href={api.setupKitUrl('codex')} download>
                  Download kit for Codex (zip)
                </a>
                <button class="btn" onClick={() => void copyText(info.playUrl)}>
                  Copy URL
                </button>
              </div>
              <p class="dim small">
                The kit's MCP address is the one this page was opened with ({location.host}). Open /setup by the LAN address before
                downloading it for another machine.
              </p>
            </div>
          </>
        ) : (
          <p class="dim">Loading…</p>
        )}
      </section>

      <section class="panel">
        <h2>Seat cards (AI seat laptops)</h2>
        <p class="dim small">
          Print one card per laptop and lay it next to it. The QR opens /play with that laptop's AI seat, and the player's AI helper
          terminal then shows inside /play. No terminal address or password goes on a card.
          {info && !info.settings.claudeBoxHost && ' Set the AI session host address and the seat password in /admin (AI seats).'}
        </p>
        {!info ? (
          <p class="dim">Loading…</p>
        ) : (
          <div class="seat-grid">
            {info.seatCards.map((c) => (
              <div class="seat-card" key={c.seat}>
                <div class="pixel seat-card-num">AI seat {c.seat}</div>
                <div class="qr" dangerouslySetInnerHTML={{ __html: c.qrSvg }} />
                <a href={c.playUrl} target="_blank" rel="noopener">
                  {c.playUrl}
                </a>
              </div>
            ))}
          </div>
        )}
      </section>

      <section class="panel">
        <h2>Checklist</h2>
        {CHECKLIST.map((sec) => (
          <div key={sec.title} class="check-section">
            <h3>{sec.title}</h3>
            <ul class="checklist">
              {sec.items.map((it) => (
                <li key={it.id} class={ticks[it.id] ? 'done' : ''}>
                  <label>
                    <input type="checkbox" checked={!!ticks[it.id]} onChange={() => toggle(it.id)} /> {it.title}
                  </label>
                  {it.detail && <div class="dim small">{it.detail}</div>}
                  {it.command && (
                    <code class="cmd" title="Click to copy" onClick={() => void copyText(it.command!)}>
                      {it.command}
                    </code>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
        <button
          class="btn small"
          onClick={() => {
            setTicks({});
            saveTicks({});
          }}
        >
          Clear ticks
        </button>
      </section>
    </div>
  );
}
