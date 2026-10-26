// Start-match setup, as steps 1 and 2 of the Match tab
// (MatchTab.tsx). TeamsStep: team mode (only the valid modes) and the
// auto-balanced team boxes, each with its "Budget per player $" on top (with
// a balance note above $15,000), where dragging a player chip onto another
// team moves them (or the chip's ⋯ menu moves/swaps; any split, every team
// keeps ≥ 1 player; LOBBY only, logic in teamDnd.ts). MapStep: map style
// (only the styles valid for the player count, the default marked "auto"), a
// top-down map preview (every valid style as a thumbnail, the chosen one large
// with zone numbers, each player's round-1 zone, team colours and "close
// neighbours" notes) and an "uneven teams" warning when the team areas differ
// and `rounds` isn't a multiple of the team count. Every change is saved as
// the server's draft (PUT /admin/match/setup), which Start match uses.

import { useRef, useState } from 'preact/hooks';
import { MAP_STYLE_INFO, teamSizesOf, validMapStyles, type MapStyle, type MatchSetupDTO, type TeamDTO, type TeamMode } from '@pixel-clash/shared';
import { api } from '../common/api.js';
import { floorTerrain } from '../common/render/iso.js';
import { seatStyle, teamLook } from '../common/seats.js';
import { cx } from '../common/ui.js';
import { useAdmin } from './context.js';
import { budgetBalanceWarning } from './quickSettings.js';
import { applyMove, canDrop, dropResult, LAST_MEMBER_TEXT, menuChoices, parseChoice, teamIdOf } from './teamDnd.js';
import { mapPreview, previewCount, selectedStyleOption, styleOptions, teamModeOptions, unevenNote, type MapPreview, type PreviewPlayer } from './mapPreview.js';

/** The front edge(s) of a zone as SVG line coordinates (row 0 faces the centre). */
function frontEdges(z: MapPreview['zones'][number], S: number): Array<[number, number, number, number]> {
  const { x, y, width: w, height: h } = z;
  const right: [number, number, number, number] = [x + w, y, x + w, y + h];
  const left: [number, number, number, number] = [x, y, x, y + h];
  const top: [number, number, number, number] = [x, y, x + w, y];
  const bottom: [number, number, number, number] = [x, y + h, x + w, y + h];
  switch (z.facing) {
    case 'S':
      return [bottom];
    case 'N':
      return [top];
    case 'E':
      return [right];
    case 'W':
      return [left];
    case 'diag':
      return [x + w / 2 < S / 2 ? right : left, y + h / 2 < S / 2 ? bottom : top];
  }
}

/** A top-down map drawing. `detail` adds zone numbers and owner names. */
export function MapView({ preview, size, detail }: { preview: MapPreview; size: number; detail?: boolean }) {
  const S = preview.width;
  const terrain = floorTerrain(S, preview.style, preview.zones);
  const unit = S / 800;
  return (
    <svg class="map-view" width={size} height={size} viewBox={`-8 -8 ${S + 16} ${S + 16}`} role="img" aria-label={`${MAP_STYLE_INFO[preview.style].label} map for ${preview.players} players`}>
      <rect x={0} y={0} width={S} height={S} fill="#2a2e45" stroke="#6a6f92" stroke-width={6 * unit} />
      {terrain.band && <rect x={0} y={terrain.band.y0} width={S} height={terrain.band.y1 - terrain.band.y0} fill="#4a4038" />}
      {terrain.pads.map((r, i) => (
        <rect key={i} x={r.x} y={r.y} width={r.width} height={r.height} fill="#33503f" />
      ))}
      <circle cx={S / 2} cy={S / 2} r={70} fill="none" stroke="#6a6f92" stroke-width={3 * unit} stroke-dasharray={`${10 * unit} ${8 * unit}`} />
      {preview.zones.map((z) => (
        <g key={z.index}>
          <rect x={z.x} y={z.y} width={z.width} height={z.height} fill={z.color} fill-opacity={z.owner ? 0.4 : 0.18} stroke={z.color} stroke-width={4 * unit} />
          {frontEdges(z, S).map(([x1, y1, x2, y2], i) => (
            <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#ffd447" stroke-width={10 * unit} />
          ))}
          {detail && (
            <>
              <text x={z.x + z.width / 2} y={z.y + z.height / 2 + (z.owner ? -10 : 20)} text-anchor="middle" font-size={64 * Math.max(1, unit * 0.9)} fill="#f2f3fa" font-family="var(--font-pixel)">
                {z.index + 1}
              </text>
              {z.owner && (
                <text x={z.x + z.width / 2} y={z.y + z.height / 2 + 50} text-anchor="middle" font-size={34 * Math.max(1, unit * 0.9)} fill="#f2f3fa" font-weight={700}>
                  {seatStyle(z.owner.seat).symbol}: {z.owner.name.slice(0, 10)}
                </text>
              )}
            </>
          )}
        </g>
      ))}
    </svg>
  );
}

/** One team's "Budget per player $" field: Enter/blur saves, empty or the default clears it. */
function TeamBudget({ team, budget, defaultBudget, onBudget, busy }: { team: TeamDTO; budget: number; defaultBudget: number; onBudget: (teamId: number, budget: number | null) => void; busy: boolean }) {
  const [typed, setTyped] = useState<number | null>(null);
  const warning = budgetBalanceWarning(typed ?? budget);
  return (
    <>
    <label class="team-budget small">
      <span>Budget per player $</span>
      <input
        type="number"
        min={1}
        max={defaultBudget * 10}
        step={500}
        // Uncontrolled (re-keyed when the saved value changes), so a re-render
        // from a live state update never wipes what the host is typing.
        key={budget}
        defaultValue={String(budget)}
        disabled={busy}
        aria-label={`${team.name} budget per player in dollars`}
        title={`Default $${defaultBudget.toLocaleString('en-US')} (config budget). Locked once the match starts.`}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur(); // blur fires the change (save)
        }}
        onInput={(e) => {
          const raw = e.currentTarget.value.trim();
          setTyped(raw === '' || !Number.isFinite(Number(raw)) ? null : Number(raw));
        }}
        onChange={(e) => {
          setTyped(null);
          const raw = e.currentTarget.value.trim();
          const v = raw === '' ? null : Math.round(Number(raw));
          onBudget(team.teamId, v === null || v === defaultBudget ? null : v);
        }}
      />
      {budget !== defaultBudget && <span class="dim"> (default ${defaultBudget.toLocaleString('en-US')})</span>}
    </label>
    {warning && <span class="qs-balance small">⚠ {warning}</span>}
    </>
  );
}

/** The team under a screen point (touch drags), from the boxes' `data-team-id`. */
function teamAt(x: number, y: number): number | null {
  const el = document.elementFromPoint(x, y)?.closest('[data-team-id]');
  const id = el ? Number(el.getAttribute('data-team-id')) : NaN;
  return Number.isInteger(id) ? id : null;
}

/**
 * Team boxes with a "Budget per player $" field on top of each and draggable
 * player chips: drop a chip on another team to move that player (mouse: HTML5
 * drag and drop; touch/pen: pointer drag). Each chip also has a menu (keyboard
 * and click fallback) to move to a team or swap with a player on another team.
 */
function TeamBoard({
  teams,
  players,
  onSwap,
  onMove,
  onRefused,
  budgets,
  defaultBudget,
  onBudget,
  busy,
}: {
  teams: TeamDTO[];
  players: Map<string, PreviewPlayer>;
  onSwap: (a: string, b: string) => void;
  /** Resolves true when the server accepted the move. */
  onMove: (id: string, teamId: number) => Promise<boolean>;
  onRefused: (text: string) => void;
  /** Budget per player of each team (index = teamId). */
  budgets: number[];
  defaultBudget: number;
  onBudget: (teamId: number, budget: number | null) => void;
  busy: boolean;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overTeam, setOverTeam] = useState<number | null>(null);
  const [pending, setPending] = useState<{ playerId: string; teamId: number } | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);
  const touch = useRef<{ id: string; pointer: number; x0: number; y0: number; moved: boolean } | null>(null);
  const nameOf = (id: string) => players.get(id)?.name ?? id;
  const shown = pending ? applyMove(teams, pending.playerId, pending.teamId) : teams;
  const locked = busy || pending !== null;

  const endDrag = () => {
    setDragId(null);
    setOverTeam(null);
    setGhost(null);
    touch.current = null;
  };
  const drop = async (playerId: string, teamId: number) => {
    endDrag();
    const r = dropResult(teams, playerId, teamId);
    if (r.kind === 'refused') return onRefused(r.text);
    if (r.kind === 'none') return;
    setPending({ playerId, teamId });
    try {
      await onMove(playerId, teamId); // refused by the server: the chip snaps back
    } finally {
      setPending(null);
    }
  };

  return (
    <div class="team-board">
      <div class="team-lists">
        {shown.map((t) => {
          const look = teamLook(t.teamId);
          const budget = budgets[t.teamId] ?? defaultBudget;
          const target = dragId !== null && teamIdOf(teams, dragId) !== t.teamId;
          return (
            <div
              key={t.teamId}
              data-team-id={t.teamId}
              class={cx('team-list', look && `pat-${look.pattern}`, dragId !== null && target && (canDrop(teams, dragId, t.teamId) ? 'drop-ok' : 'drop-no'), target && overTeam === t.teamId && 'drop-over')}
              style={{ '--team': t.color }}
              onDragOver={(e) => {
                if (dragId === null) return;
                e.preventDefault();
                if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; // a refused drop still lands, to say why
                if (overTeam !== t.teamId) setOverTeam(t.teamId);
              }}
              onDragLeave={(e) => {
                const to = e.relatedTarget as Node | null;
                if (!to || !e.currentTarget.contains(to)) setOverTeam((o) => (o === t.teamId ? null : o));
              }}
              onDrop={(e) => {
                e.preventDefault();
                const id = e.dataTransfer?.getData('text/plain') || dragId;
                if (id) void drop(id, t.teamId);
              }}
            >
              <div class="team-list-top">
                <TeamBudget team={t} budget={budget} defaultBudget={defaultBudget} onBudget={onBudget} busy={busy} />
                <div class="team-list-head">
                  {t.name} · {t.members.length} player{t.members.length === 1 ? '' : 's'} <span class="dim small">({look?.pattern} ring)</span>
                </div>
              </div>
              <ul aria-label={`${t.name} players`}>
                {t.members.map((id) => {
                  const p = players.get(id);
                  const seat = seatStyle(p?.seat);
                  const { moves, swaps } = menuChoices(teams, id, nameOf);
                  return (
                    <li
                      key={id}
                      class={cx('team-chip', dragId === id && 'dragging', pending?.playerId === id && 'pending', locked && 'locked')}
                      draggable={!locked}
                      title={locked ? undefined : 'Drag onto another team to move this player'}
                      onDragStart={(e) => {
                        if (locked) return e.preventDefault();
                        e.dataTransfer?.setData('text/plain', id);
                        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
                        // Re-rendering inside dragstart can cancel the drag in Chromium: do it next tick.
                        setTimeout(() => setDragId(id), 0);
                      }}
                      onDragEnd={endDrag}
                      onPointerDown={(e) => {
                        if (locked || e.pointerType === 'mouse' || (e.target as HTMLElement).closest('select')) return;
                        touch.current = { id, pointer: e.pointerId, x0: e.clientX, y0: e.clientY, moved: false };
                        e.currentTarget.setPointerCapture(e.pointerId);
                      }}
                      onPointerMove={(e) => {
                        const tc = touch.current;
                        if (!tc || tc.pointer !== e.pointerId) return;
                        if (!tc.moved && Math.hypot(e.clientX - tc.x0, e.clientY - tc.y0) < 8) return;
                        tc.moved = true;
                        setDragId(tc.id);
                        setGhost({ x: e.clientX, y: e.clientY });
                        setOverTeam(teamAt(e.clientX, e.clientY));
                      }}
                      onPointerUp={(e) => {
                        const tc = touch.current;
                        if (!tc || tc.pointer !== e.pointerId) return;
                        const over = tc.moved ? teamAt(e.clientX, e.clientY) : null;
                        if (over !== null) void drop(tc.id, over);
                        else endDrag();
                      }}
                      onPointerCancel={endDrag}
                    >
                      <span class="chip-grip" aria-hidden="true">
                        ⠿
                      </span>
                      <span class="seat-chip" style={{ background: seat.color, color: seat.ink }}>
                        {seat.symbol}
                      </span>
                      <span class="chip-name">{p?.name ?? id}</span>
                      <select
                        class="chip-menu"
                        value=""
                        disabled={locked}
                        aria-label={`Move or swap ${p?.name ?? id}`}
                        title="Move or swap"
                        onChange={(e) => {
                          const c = parseChoice(e.currentTarget.value);
                          e.currentTarget.value = '';
                          if (c?.kind === 'move') void drop(id, c.teamId);
                          else if (c?.kind === 'swap') onSwap(id, c.playerId);
                        }}
                      >
                        <option value="">⋯</option>
                        <optgroup label="Move">
                          {moves.map((m) => (
                            <option key={m.value} value={m.value} disabled={m.disabled}>
                              {m.label}
                              {m.disabled ? ' (last player)' : ''}
                            </option>
                          ))}
                        </optgroup>
                        {swaps.length > 0 && (
                          <optgroup label="Swap">
                            {swaps.map((m) => (
                              <option key={m.value} value={m.value}>
                                {m.label}
                              </option>
                            ))}
                          </optgroup>
                        )}
                      </select>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
      <p class="dim small">Drag a player onto another team to move them, or use the ⋯ menu on a player to move or swap. {LAST_MEMBER_TEXT}</p>
      {ghost && dragId && (
        <div class="team-chip drag-ghost" style={{ left: `${ghost.x}px`, top: `${ghost.y}px` }} aria-hidden="true">
          {nameOf(dragId)}
        </div>
      )}
    </div>
  );
}

/** What the setup steps share: the roster, the draft teams and the chosen map. */
function useMatchModel(rounds: number) {
  const { overview, state, act, busy, notify } = useAdmin();
  const setup: MatchSetupDTO | undefined = overview?.setup;
  const roster: PreviewPlayer[] = (overview?.players ?? state?.players ?? []).map((p) => ({ id: p.id, name: p.name, seat: p.seat }));
  const byId = new Map(roster.map((p) => [p.id, p]));
  const n = previewCount(roster.length);
  const mode: TeamMode = setup?.teamMode ?? 'ffa';
  const override = setup?.mapStyle ?? null;
  const teams = mode === 'ffa' ? null : (setup?.teams ?? null);
  const chosen = mapPreview(override, roster, teams, mode);
  const sizes = teams ? teamSizesOf(teams) : undefined;
  const styles = validMapStyles(n, mode, sizes);
  const uneven = unevenNote(chosen, mode, rounds);
  const save = (patch: { mapStyle?: MapStyle | null; teamMode?: TeamMode }, text?: string) => act(() => api.admin.setMatchSetup(patch), text);
  return { setup, roster, byId, mode, override, teams, chosen, sizes, styles, uneven, save, act, busy, notify };
}

/** Step 1 (Players & teams): who joined, free-for-all or teams, and the team boxes with their budgets. */
export function TeamsStep({ rounds }: { rounds: number }) {
  const { setup, roster, byId, mode, teams, sizes, save, act, busy, notify } = useMatchModel(rounds);
  if (!setup) return <p class="dim">Loading the match setup…</p>;
  return (
    <div class="match-setup">
      <label class="inline">
        Teams
        <select
          value={mode}
          disabled={busy}
          onChange={(e) => {
            const teamMode = e.currentTarget.value as TeamMode;
            void save({ teamMode }, teamMode === 'ffa' ? 'Free-for-all' : 'Teams balanced');
          }}
        >
          {teamModeOptions(roster.length, mode, sizes).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      {teams && teams.length > 0 ? (
        <TeamBoard
          teams={teams}
          players={byId}
          busy={busy}
          onRefused={(text) => notify('warn', text)}
          onSwap={(a, b) => void act(() => api.admin.swapTeams(a, b), `Swapped ${byId.get(a)?.name ?? a} and ${byId.get(b)?.name ?? b}`)}
          onMove={async (id, teamId) => (await act(() => api.admin.moveTeam(id, teamId), `Moved ${byId.get(id)?.name ?? id} to ${teams.find((t) => t.teamId === teamId)?.name ?? `Team ${teamId + 1}`}`)) !== undefined}
          budgets={setup.teamBudgets ?? []}
          defaultBudget={setup.defaultBudget}
          onBudget={(teamId, budget) => {
            const next: (number | null)[] = teams.map((t) => {
              const b = setup.teamBudgets?.[t.teamId];
              return b === undefined || b === setup.defaultBudget ? null : b;
            });
            next[teamId] = budget;
            const name = teams.find((t) => t.teamId === teamId)?.name ?? `Team ${teamId + 1}`;
            void act(() => api.admin.setMatchSetup({ teamBudgets: next }), `${name}: $${(budget ?? setup.defaultBudget).toLocaleString('en-US')} per player`);
          }}
        />
      ) : (
        <ul class="roster-chips" aria-label="Players in the lobby">
          {roster.map((p) => {
            const seat = seatStyle(p.seat);
            return (
              <li key={p.id} class="team-chip locked">
                <span class="seat-chip" style={{ background: seat.color, color: seat.ink }}>
                  {seat.symbol}
                </span>
                <span class="chip-name">{p.name}</span>
              </li>
            );
          })}
          {roster.length === 0 && <li class="dim small">Nobody has joined yet: players open /play on their laptops.</li>}
        </ul>
      )}
    </div>
  );
}

/** Step 2 (Map): the map style with a large preview and a thumbnail of every valid style. */
export function MapStep({ rounds }: { rounds: number }) {
  const { setup, roster, mode, override, teams, chosen, sizes, styles, uneven, save, busy } = useMatchModel(rounds);
  if (!setup) return <p class="dim">Loading the match setup…</p>;
  const options = styleOptions(roster.length, mode, sizes);
  const selected = selectedStyleOption(options, override);
  return (
    <div class="match-setup">
      <label class="inline">
        Map
        <select value={selected} disabled={busy} onChange={(e) => void save({ mapStyle: (e.currentTarget.value || null) as MapStyle | null })}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <div class="map-previews">
        <div class="map-big">
          <MapView preview={chosen} size={260} detail />
          <div class="map-notes">
            <b>
              {MAP_STYLE_INFO[chosen.style].label} · {chosen.players} players · {chosen.width}×{chosen.width}
            </b>
            <span class="dim small">{MAP_STYLE_INFO[chosen.style].idea}. Yellow edge = front row.</span>
            {roster.length < 2 && <span class="dim small">Needs at least 2 players.</span>}
            {roster.length >= 2 && chosen.zones.every((z) => !z.owner) && <span class="dim small">Zone owners show once the roster fits the map.</span>}
            {chosen.zones.some((z) => z.owner) && <span class="dim small">Names show each player's zone in round 1 (zones rotate every round).</span>}
            {chosen.closeNeighbours && <span class="warn-text small">Close neighbours: this map is meant for teams.</span>}
            {uneven && <span class="warn-text small">{uneven}</span>}
            {chosen.tip && <span class="small">{chosen.tip}</span>}
          </div>
        </div>
        {styles.length > 1 && (
          <div class="map-thumbs">
            {styles.map((st) => {
              const p = mapPreview(st, roster, teams, mode);
              const on = st === chosen.style;
              return (
                <button key={st} class={cx('map-thumb', on && 'on')} disabled={busy} title={MAP_STYLE_INFO[st].idea} onClick={() => !on && void save({ mapStyle: st === styles[0] ? null : st })}>
                  <MapView preview={p} size={84} />
                  <span>
                    {MAP_STYLE_INFO[st].label}
                    {st === styles[0] ? ' (auto)' : ''}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
