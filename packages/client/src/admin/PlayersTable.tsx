// Players table (plan §12.3): seat, zone, name, connected, designs, submitted
// this PLAN, selected, ready, strikes. Per player: Kick ("after this battle"
// during BATTLE), Reset PIN, Rotate key, and the rescue paste box with
// Validate (any phase) and Submit on behalf (PLAN only).

import { Fragment } from 'preact';
import { useState } from 'preact/hooks';
import type { AdminOverviewDTO, GameStateDTO, SubmitUnitResponse, ValidationResult } from '@pixel-clash/shared';
import { api } from '../common/api.js';
import { seatStyle } from '../common/seats.js';
import { copyText, cx, formatMoney } from '../common/ui.js';
import { useAdmin } from './context.js';

type OverviewPlayer = AdminOverviewDTO['players'][number];

const ZONE_TEXT: Record<string, string> = { TL: 'top-left', TR: 'top-right', BR: 'bottom-right', BL: 'bottom-left' };

const tick = (v: boolean) => (v ? <span class="yes">✓</span> : <span class="no">·</span>);

export function PlayersTable() {
  const { state, overview } = useAdmin();
  const s = state as GameStateDTO;
  const [open, setOpen] = useState<string | null>(null);
  const rows: OverviewPlayer[] = overview?.players ?? [];

  return (
    <section class="panel players">
      <h2>Players</h2>
      {rows.length === 0 ? (
        <p class="dim">No players yet. Kids join on /play (see /setup for the address and QR).</p>
      ) : (
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Seat</th>
                <th>Zone</th>
                <th>Name</th>
                <th title="Has a /play page open">Online</th>
                <th title="Own designs (templates not counted)">Designs</th>
                <th title="Submitted a unit this PLAN">Submitted</th>
                <th>Selected</th>
                <th>Ready</th>
                <th title="Sandbox strikes in the last battle">Strikes</th>
                <th>Points</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const seat = seatStyle(p.seat);
                const isOpen = open === p.id;
                return (
                  <Fragment key={p.id}>
                    <tr class={cx(!p.active && 'inactive', p.leaving && 'leaving')}>
                      <td>
                        <span class="seat-chip" style={{ background: seat.color }}>
                          {seat.symbol} {p.seat + 1}
                        </span>
                      </td>
                      <td>{p.zone ? ZONE_TEXT[p.zone] : '–'}</td>
                      <td>
                        <b>{p.name}</b>
                        {!p.active && <div class="dim small">joins next round (from round {p.activeFromRound})</div>}
                        {p.leaving && <div class="warn-text small">kicked: leaves after this battle</div>}
                      </td>
                      <td>{p.connected ? <span class="yes">● on</span> : <span class="no">○ off</span>}</td>
                      <td>{p.designs}</td>
                      <td>{tick(p.submitted)}</td>
                      <td>{tick(p.selected)}</td>
                      <td>{tick(p.ready)}</td>
                      <td class={p.strikes > 0 ? 'warn-text' : ''}>{p.strikes}</td>
                      <td>{p.points}</td>
                      <td>
                        <button class={cx('btn small', isOpen && 'on')} onClick={() => setOpen(isOpen ? null : p.id)}>
                          {isOpen ? 'Close' : 'Actions…'}
                        </button>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr class="actions-row">
                        <td colSpan={11}>
                          <PlayerActions player={p} phase={s.phase} onGone={() => setOpen(null)} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PlayerActions({ player, phase, onGone }: { player: OverviewPlayer; phase: GameStateDTO['phase']; onGone: () => void }) {
  const { act, busy } = useAdmin();
  const [pin, setPin] = useState('');
  const [kickConfirm, setKickConfirm] = useState(false);
  const [deleteData, setDeleteData] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const duringBattle = phase === 'BATTLE';

  return (
    <div class="player-actions">
      <div class="action-group">
        <h3>Reset PIN</h3>
        <p class="dim small">Logs the kid out of /play. Their Claude key keeps working.</p>
        <div class="btn-row">
          <input
            class="pin"
            inputMode="numeric"
            maxLength={4}
            placeholder="4 digits"
            value={pin}
            onInput={(e) => setPin(e.currentTarget.value.replace(/\D/g, '').slice(0, 4))}
          />
          <button
            class="btn"
            disabled={busy || pin.length !== 4}
            onClick={async () => {
              if (await act(() => api.admin.resetPin(player.id, pin), `${player.name}'s PIN is now ${pin}`)) setPin('');
            }}
          >
            Set PIN
          </button>
        </div>
      </div>

      <div class="action-group">
        <h3>Kick</h3>
        <p class="dim small">
          {duringBattle
            ? 'During a battle the kick takes effect after this battle (their units keep fighting, no points).'
            : 'Removes the player now and frees the seat.'}
        </p>
        {kickConfirm ? (
          <div class="btn-row">
            <label class="inline">
              <input type="checkbox" checked={deleteData} onChange={(e) => setDeleteData(e.currentTarget.checked)} /> also delete their units
            </label>
            <button
              class="btn danger"
              disabled={busy}
              onClick={async () => {
                const r = await act(
                  () => api.admin.kick(player.id, deleteData),
                  (r) => (r.effective === 'now' ? `${player.name} was removed.` : `${player.name} will be removed after this battle.`),
                );
                if (r?.effective === 'now') onGone();
                setKickConfirm(false);
              }}
            >
              Yes, kick {player.name}
              {duringBattle ? ' (after this battle)' : ''}
            </button>
            <button class="btn" onClick={() => setKickConfirm(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button class="btn warn" disabled={busy || player.leaving} onClick={() => setKickConfirm(true)}>
            {player.leaving ? 'Leaving after this battle' : duringBattle ? 'Kick (after this battle)…' : 'Kick…'}
          </button>
        )}
      </div>

      <div class="action-group">
        <h3>Claude key</h3>
        <p class="dim small">Rotate only if the key leaked: the kid's Claude has to log in again.</p>
        <div class="btn-row">
          <button
            class="btn"
            disabled={busy}
            onClick={async () => {
              const r = await act(() => api.admin.rotateKey(player.id), 'New key issued');
              if (r) setNewKey(r.apiKey);
            }}
          >
            Rotate key
          </button>
          {newKey && (
            <code class="key" onClick={() => void copyText(newKey)} title="Click to copy">
              {newKey}
            </code>
          )}
        </div>
      </div>

      <RescueBox player={player} phase={phase} />
    </div>
  );
}

/** Paste box: validate (any phase) or submit on behalf (PLAN only), result inline. */
function RescueBox({ player, phase }: { player: OverviewPlayer; phase: GameStateDTO['phase'] }) {
  const { act, busy } = useAdmin();
  const [source, setSource] = useState('');
  const [unitId, setUnitId] = useState('');
  const [result, setResult] = useState<{ kind: 'validate' | 'submit'; r: ValidationResult | SubmitUnitResponse } | null>(null);
  const own = player.units.filter((u) => !u.isTemplate);
  const canSubmit = phase === 'PLAN';

  const run = async (dryRun: boolean) => {
    const r = await act(() => api.admin.playerUnit(player.id, source, { ...(unitId ? { unitId } : {}), dryRun }));
    if (r) setResult({ kind: dryRun ? 'validate' : 'submit', r });
  };

  return (
    <div class="action-group rescue">
      <h3>Rescue: paste a unit</h3>
      <div class="btn-row">
        <label class="inline">
          Revise
          <select value={unitId} onChange={(e) => setUnitId(e.currentTarget.value)}>
            <option value="">(new unit)</option>
            {own.map((u) => (
              <option key={u.unitId} value={u.unitId}>
                {u.name} v{u.version}
              </option>
            ))}
          </select>
        </label>
        {unitId && (
          <button
            class="btn small"
            onClick={() => {
              const u = own.find((x) => x.unitId === unitId);
              if (u) setSource(u.source);
            }}
          >
            Load its source
          </button>
        )}
      </div>
      <textarea
        class="code"
        rows={10}
        spellcheck={false}
        placeholder="Paste the unit's JavaScript here (class … { constructor() {…} update(me, world) {…} })"
        value={source}
        onInput={(e) => setSource(e.currentTarget.value)}
      />
      <div class="btn-row">
        <button class="btn" disabled={busy || !source.trim()} onClick={() => run(true)}>
          Validate
        </button>
        <button
          class="btn primary"
          disabled={busy || !source.trim() || !canSubmit}
          title={canSubmit ? '' : 'Submitting is only possible in PLAN (validate works any time)'}
          onClick={() => run(false)}
        >
          Submit on behalf of {player.name}
        </button>
        {!canSubmit && <span class="dim small">Submit opens in PLAN.</span>}
      </div>
      {result && <ResultView kind={result.kind} r={result.r} />}
    </div>
  );
}

function ResultView({ kind, r }: { kind: 'validate' | 'submit'; r: ValidationResult | SubmitUnitResponse }) {
  if (r.ok) {
    const stored = 'unitId' in r && kind === 'submit' ? ` Stored as ${r.unitId} v${r.version}.` : '';
    return (
      <div class="result ok">
        <b>✓ {kind === 'submit' ? 'Submitted' : 'Valid'}:</b> {r.unit.stats.name} ({r.unit.stats.type}), cost {formatMoney(r.unit.cost)}.{stored}
        {r.warnings.length > 0 && (
          <ul>
            {r.warnings.map((w, i) => (
              <li key={i} class="warn-text">
                {w.code}: {w.message}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  return (
    <div class="result bad">
      <b>✗ Not valid</b>
      {r.cost !== null ? ` (cost ${formatMoney(r.cost)})` : ''}
      <ul>
        {r.errors.map((e, i) => (
          <li key={i}>
            <b>{e.code}</b>
            {e.line ? ` (line ${e.line})` : ''}: {e.message}
            <div class="dim small">Fix: {e.fix}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}
