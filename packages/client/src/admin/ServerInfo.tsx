// Server info (plan §12.3, §11): LAN URLs + QR (pick the preferred interface),
// sandbox mode and the wipe button (type WIPE). The Claude box address and
// the seat password live in the Claude seats panel (ClaudeSeats.tsx).

import { useState } from 'preact/hooks';
import { api } from '../common/api.js';
import { updateSetupSettings } from '../setup/setupApi.js';
import { useAdmin } from './context.js';

export function ServerInfo() {
  const { setup, act, busy, setSetup } = useAdmin();
  const [wipeText, setWipeText] = useState('');

  const saveSettings = async (patch: Parameters<typeof updateSetupSettings>[0], okText: string) => {
    const r = await act(() => updateSetupSettings(patch), okText);
    if (r) setSetup(r);
  };

  return (
    <section class="panel server">
      <h2>Server &amp; setup</h2>
      {!setup ? (
        <p class="dim">Loading…</p>
      ) : (
        <>
          <div class="join-row">
            <div class="qr" dangerouslySetInnerHTML={{ __html: setup.playQrSvg }} />
            <div>
              <div class="label">Players join at</div>
              <div class="big-url">{setup.playUrl}</div>
              <div class="dim small">
                Sandbox: <b class={setup.sandboxMode === 'ivm' ? 'yes' : 'error'}>{setup.sandboxMode === 'ivm' ? 'isolated-vm ✓' : setup.sandboxMode}</b>
              </div>
            </div>
          </div>

          <h3>LAN addresses</h3>
          {setup.lanUrls.length === 0 ? (
            <p class="warn-text">No LAN address found: is this machine on the event Wi-Fi?</p>
          ) : (
            <ul class="lan-list">
              {setup.lanUrls.map((u) => (
                <li key={u}>
                  <label>
                    <input
                      type="radio"
                      name="preferred"
                      checked={setup.settings.preferredUrl === u}
                      disabled={busy}
                      onChange={() => void saveSettings({ preferredUrl: u }, `QR now uses ${u}`)}
                    />{' '}
                    <code>{u}</code>
                  </label>
                </li>
              ))}
              <li>
                <label>
                  <input
                    type="radio"
                    name="preferred"
                    checked={setup.settings.preferredUrl === null}
                    disabled={busy}
                    onChange={() => void saveSettings({ preferredUrl: null }, 'QR uses the address each page was opened with')}
                  />{' '}
                  automatic (the address the page was opened with)
                </label>
              </li>
            </ul>
          )}

          <p class="dim small">
            Seat cards (one per Claude laptop, with its <code>/play?seat=N</code> QR) are on{' '}
            <a class="link" href="/setup" target="_blank" rel="noopener">
              /setup
            </a>
            .
          </p>

          <h3>Wipe all data</h3>
          <p class="dim small">Deletes every player, unit, score and replay. Type WIPE to enable.</p>
          <div class="btn-row">
            <input placeholder="WIPE" value={wipeText} onInput={(e) => setWipeText(e.currentTarget.value)} />
            <button
              class="btn danger"
              disabled={busy || wipeText !== 'WIPE'}
              onClick={async () => {
                if (await act(() => api.admin.wipe(), 'All data wiped')) setWipeText('');
              }}
            >
              Wipe
            </button>
          </div>
        </>
      )}
    </section>
  );
}
