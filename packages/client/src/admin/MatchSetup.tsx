// Start-match setup (plan §12.3, §9.2): map style (only the styles valid for
// the player count, the default marked "auto"), team mode (only the valid
// modes), a top-down map preview (every valid style as a thumbnail, the chosen
// one large with zone numbers, each player's round-1 zone, team colours and
// "close neighbours" notes) and the auto-balanced team lists, where clicking
// two players on different teams swaps them and "Move to Team N" moves the
// picked player (any split, every team keeps ≥ 1 player; LOBBY only), and an "uneven
// teams" warning when the team areas differ and `rounds` isn't a multiple of
// the team count. Every change is
// saved as the server's draft (PUT /admin/match/setup), which Start match uses.

import { useState } from 'preact/hooks';
import { MAP_STYLE_INFO, teamSizesOf, validMapStyles, type MapStyle, type MatchSetupDTO, type TeamDTO, type TeamMode } from '@pixel-clash/shared';
import { api } from '../common/api.js';
import { floorTerrain } from '../common/render/iso.js';
import { seatStyle, teamLook } from '../common/seats.js';
import { cx } from '../common/ui.js';
import { useAdmin } from './context.js';
import { mapPreview, previewCount, selectedStyleOption, styleOptions, teamModeOptions, unevenNote, type MapPreview, type PreviewPlayer } from './mapPreview.js';

/** The front edge(s) of a zone as SVG line coordinates (row 0 faces the centre, §9.2). */
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

/** Team lists: click a player, then a player on another team to swap them, or "Move to Team N". */
function TeamLists({
  teams,
  players,
  onSwap,
  onMove,
  busy,
}: {
  teams: TeamDTO[];
  players: Map<string, PreviewPlayer>;
  onSwap: (a: string, b: string) => void;
  onMove: (id: string, teamId: number) => void;
  busy: boolean;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const teamOf = (id: string) => teams.find((t) => t.members.includes(id))?.teamId;
  const click = (id: string) => {
    if (picked === null) return setPicked(id);
    if (picked === id) return setPicked(null);
    if (teamOf(picked) === teamOf(id)) return setPicked(id);
    onSwap(picked, id);
    setPicked(null);
  };
  return (
    <div class="team-lists">
      {teams.map((t) => {
        const look = teamLook(t.teamId);
        return (
          <div key={t.teamId} class={cx('team-list', look && `pat-${look.pattern}`)} style={{ '--team': t.color }}>
            <div class="team-list-head">
              {t.name} · {t.members.length} player{t.members.length === 1 ? '' : 's'} <span class="dim small">({look?.pattern} ring)</span>
            </div>
            <ul>
              {t.members.map((id) => {
                const p = players.get(id);
                const seat = seatStyle(p?.seat);
                return (
                  <li key={id}>
                    <button class={cx('btn small team-member', picked === id && 'on')} disabled={busy} onClick={() => click(id)}>
                      <span class="seat-chip" style={{ background: seat.color, color: seat.ink }}>
                        {seat.symbol}
                      </span>{' '}
                      {p?.name ?? id}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
      <p class="dim small">
        {picked ? 'Now click a player on another team to swap them, or move them:' : 'Click two players on different teams to swap them, or click one player to move them to another team.'}
      </p>
      {picked && (
        <div class="btn-row">
          {teams
            .filter((t) => t.teamId !== teamOf(picked))
            .map((t) => (
              <button
                key={t.teamId}
                class="btn small"
                disabled={busy || (teams.find((x) => x.teamId === teamOf(picked))?.members.length ?? 0) <= 1}
                title="Every team needs at least 1 player."
                onClick={() => {
                  onMove(picked, t.teamId);
                  setPicked(null);
                }}
              >
                Move {players.get(picked)?.name ?? picked} to {t.name}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

export function MatchSetup({ rounds }: { rounds: number }) {
  const { overview, state, act, busy } = useAdmin();
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

  const options = styleOptions(roster.length, mode, sizes);
  const selected = selectedStyleOption(options, override);
  const save = (patch: { mapStyle?: MapStyle | null; teamMode?: TeamMode }, text?: string) => act(() => api.admin.setMatchSetup(patch), text);

  if (!setup) return <p class="dim">Loading the match setup…</p>;
  return (
    <div class="match-setup">
      <div class="btn-row">
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
      </div>
      <div class="map-previews">
        <div class="map-big">
          <MapView preview={chosen} size={300} detail />
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
                  <MapView preview={p} size={92} />
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
      {teams && teams.length > 0 && (
        <TeamLists
          teams={teams}
          players={byId}
          busy={busy}
          onSwap={(a, b) => void act(() => api.admin.swapTeams(a, b), `Swapped ${byId.get(a)?.name ?? a} and ${byId.get(b)?.name ?? b}`)}
          onMove={(id, teamId) => void act(() => api.admin.moveTeam(id, teamId), `Moved ${byId.get(id)?.name ?? id} to ${teams.find((t) => t.teamId === teamId)?.name ?? `Team ${teamId + 1}`}`)}
        />
      )}
    </div>
  );
}
