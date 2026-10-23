// Server info (plan §12.3, §11): LAN URLs + QR (pick the preferred interface),
// sandbox mode, the Claude box address for the seat terminal links (§11.1),
// and the wipe button (type WIPE).

import { useEffect, useState } from 'preact/hooks';
import { api } from '../common/api.js';
import { seatLabel, updateSetupSettings } from '../setup/setupApi.js';
import { useAdmin } from './context.js';

export function ServerInfo() {
  const { setup, act, busy, setSetup } = useAdmin();
  const [boxHost, setBoxHost] = useState('');
  const [wipeText, setWipeText] = useState('');
  const saved = setup?.settings.claudeBoxHost ?? '';
  useEffect(() => setBoxHost(saved), [saved]);

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

          <h3>Claude box (seat terminals)</h3>
          <p class="dim small">The machine running the seat containers (§11.1). Seat N's terminal is http://&lt;address&gt;:778N.</p>
          <form
            class="btn-row"
            onSubmit={(e) => {
              e.preventDefault();
              void saveSettings({ claudeBoxHost: boxHost.trim() || null }, boxHost.trim() ? 'Claude box address saved' : 'Claude box address cleared');
            }}
          >
            <input placeholder="e.g. 192.168.8.20" value={boxHost} onInput={(e) => setBoxHost(e.currentTarget.value)} />
            <button class="btn" disabled={busy || boxHost.trim() === saved}>
              Save
            </button>
          </form>
          {setup.seatTerminals.length > 0 && (
            <ul class="terminals">
              {setup.seatTerminals.map((t) => (
                <li key={t.seat}>
                  {seatLabel(t.seat)} terminal:{' '}
                  <a href={t.url} target="_blank" rel="noopener">
                    {t.url}
                  </a>
                </li>
              ))}
            </ul>
          )}

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
