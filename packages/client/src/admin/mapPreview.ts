// Start-match map preview (plan §12.3): which styles fit the player count, a
// top-down model of a map with zone numbers, each player's round-1 zone and
// team colours, "close neighbours" notes, the Lanes / Islands tips and the
// "team areas differ" note for maps whose team blocks aren't mirror images.
// DOM-free (tests/maps-client.test.ts); PhaseControls draws it as SVG.

import {
  CLOSE_NEIGHBOUR_STYLES,
  MAP_STYLE_INFO,
  MAX_PLAYERS,
  MIN_PLAYERS,
  TEAM_STYLES,
  assignMapZones,
  assignTeamZones,
  defaultMapStyle,
  isValidMapSetup,
  mapFor,
  teamCountOf,
  teamModeLabel,
  unevenTeamBlocks,
  validMapStyles,
  validTeamModes,
  type Facing,
  type MapStyle,
  type MapZone,
  type TeamDTO,
  type TeamMode,
} from '@pixel-clash/shared';
import { NEUTRAL_SEAT, seatStyle } from '../common/seats.js';

export interface PreviewPlayer {
  id: string;
  name: string;
  seat: number;
}

export interface PreviewZone {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  facing: Facing;
  /** The round-1 owner, when the roster fills the map. */
  owner: PreviewPlayer | null;
  teamId: number | null;
  /** Tint: team colour in team mode, else the owner's seat colour (grey when empty). */
  color: string;
}

export interface MapPreview {
  style: MapStyle;
  players: number;
  width: number;
  zones: PreviewZone[];
  /** "close neighbours": Lanes and Islands in free-for-all. */
  closeNeighbours: boolean;
  /** Lanes for 2 teams, Islands for teams of 2 (§9.2). */
  tip: string | null;
  /** Team mode on a map whose team blocks differ: only a multiple of T rounds is fair (`unevenNote`). */
  uneven: boolean;
}

/** The player count a preview is drawn for: the roster, clamped to 2-8. */
export function previewCount(players: number): number {
  return Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, players));
}

/**
 * Style choices for the dropdown (only those that suit the team mode): the
 * default first as "auto" (''), then the other styles. The default is not
 * listed again, so choosing it never pins an override.
 */
export function styleOptions(players: number, mode: TeamMode = 'ffa'): Array<{ value: MapStyle | ''; label: string }> {
  const n = previewCount(players);
  const def = defaultMapStyle(n);
  return [
    { value: '', label: `${MAP_STYLE_INFO[def].label} (auto for ${n} players)` },
    ...validMapStyles(n, mode)
      .filter((s) => s !== def)
      .map((s) => ({ value: s, label: `${MAP_STYLE_INFO[s].label}: ${MAP_STYLE_INFO[s].idea}` })),
  ];
}

/**
 * The dropdown value for a draft override: an override equal to the default
 * (the server stores it as sent, e.g. a scripted `mapStyle: 'duel'`) or no
 * longer valid for the count/mode shows as the "auto" entry, never a blank select.
 */
export function selectedStyleOption(options: ReadonlyArray<{ value: MapStyle | '' }>, override: MapStyle | null): MapStyle | '' {
  return override !== null && options.some((o) => o.value === override) ? override : '';
}

/** Team mode choices for the dropdown ("Free-for-all", "2 teams (3v3)"…). */
export function teamModeOptions(players: number): Array<{ value: TeamMode; label: string }> {
  const n = previewCount(players);
  return validTeamModes(n).map((m) => ({ value: m, label: teamModeLabel(m, n) }));
}

/** The tip for a team mode and style, or null. */
export function styleTip(style: MapStyle, mode: TeamMode, players: number): string | null {
  const T = teamCountOf(mode);
  if (T === 0) return null;
  const n = previewCount(players);
  if (T === 2 && style !== 'lanes' && isValidMapSetup('lanes', mode, n)) return 'Tip: Lanes suits 2 teams (one row each).';
  if (n / T === 2 && style !== 'islands' && isValidMapSetup('islands', mode, n)) return 'Tip: Islands suits teams of 2 (one cluster per team).';
  return null;
}

/**
 * The "team areas differ" warning: on a map whose team blocks aren't mirror
 * images (`uneven`), each team only plays each block equally often when the
 * rounds are a multiple of the team count. Null when that holds.
 */
export function unevenNote(preview: Pick<MapPreview, 'uneven'>, mode: TeamMode, rounds: number): string | null {
  const T = teamCountOf(mode);
  if (!preview.uneven || T < 2 || rounds % T === 0) return null;
  return `Uneven teams on this map: the team areas differ, so pick ${T}, ${T * 2} or ${T * 3} rounds to let every team play each area equally often.`;
}

/**
 * Round-1 zone owners: free-for-all players in join order take
 * `zones[(i + 1) % P]`; in team mode whole teams take blocks (§9.2). Empty
 * when the roster doesn't match the map.
 */
export function roundOneOwners(zones: readonly MapZone[], players: readonly PreviewPlayer[], teams: readonly TeamDTO[] | null, round = 1): Map<number, PreviewPlayer> {
  const out = new Map<number, PreviewPlayer>();
  const byId = new Map(players.map((p) => [p.id, p]));
  const layout = { style: 'corners' as MapStyle, players: zones.length, width: 0, height: 0, zones: [...zones] };
  try {
    const assigned =
      teams && teams.length > 0
        ? assignTeamZones(layout, teams.map((t) => ({ members: t.members })), round)
        : assignMapZones(layout, players.map((p) => p.id), round);
    for (const [id, z] of assigned) {
      const p = byId.get(id);
      if (p) out.set(z.index, p);
    }
  } catch {
    // roster and map don't match (yet): no owners
  }
  return out;
}

/** The preview model of `style` for the roster (an invalid style falls back to the default). */
export function mapPreview(style: MapStyle | null, players: readonly PreviewPlayer[], teams: readonly TeamDTO[] | null, mode: TeamMode = 'ffa'): MapPreview {
  const n = previewCount(players.length);
  const chosen = style && isValidMapSetup(style, mode, n) ? style : defaultMapStyle(n);
  const layout = mapFor(chosen, n);
  const teamOf = new Map<string, number>();
  for (const t of teams ?? []) for (const m of t.members) teamOf.set(m, t.teamId);
  const owners = players.length === n ? roundOneOwners(layout.zones, players, teams && teams.length ? teams : null) : new Map<number, PreviewPlayer>();
  const zones: PreviewZone[] = layout.zones.map((z) => {
    const owner = owners.get(z.index) ?? null;
    const teamId = owner ? (teamOf.get(owner.id) ?? null) : null;
    const color = teamId !== null ? (TEAM_STYLES[teamId]?.color ?? NEUTRAL_SEAT.color) : owner ? seatStyle(owner.seat).color : NEUTRAL_SEAT.color;
    return { index: z.index, x: z.x, y: z.y, width: z.width, height: z.height, facing: z.facing, owner, teamId, color };
  });
  return {
    style: chosen,
    players: n,
    width: layout.width,
    zones,
    closeNeighbours: mode === 'ffa' && CLOSE_NEIGHBOUR_STYLES.includes(chosen),
    tip: styleTip(chosen, mode, n),
    uneven: unevenTeamBlocks(chosen, mode, n),
  };
}
