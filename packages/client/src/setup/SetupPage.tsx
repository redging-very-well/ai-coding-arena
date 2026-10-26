// /setup: the big join URL + QR, the LAN addresses and the setup
// checklist. Players join in their browser; there is no kit download.

import { useEffect, useState } from 'preact/hooks';
import type { SetupInfoDTO } from '@pixel-clash/shared';
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
                <button class="btn" onClick={() => void copyText(info.playUrl)}>
                  Copy URL
                </button>
              </div>
            </div>
          </>
        ) : (
          <p class="dim">Loading…</p>
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
