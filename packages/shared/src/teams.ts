// Team modes, auto-balance, swaps and team colours (plan §9.2 Team modes,
// Auto-balance). Pure data + functions shared by server and client.
//
//   * `teamMode`: 'ffa' (default) or 'teams2' / 'teams3' / 'teams4' (T teams).
//     A mode is valid for P players when every team gets ≥ 1 player (P ≥ T).
//     Teams may be unequal: 5 → 3v2; the host can also move players between
//     teams in LOBBY (e.g. 4v2), as long as no team is left empty.
//   * `autoBalance` deals players (join order) into teams with a snake:
//     A B B A …, so 6p 3 teams = A B C C B A.
//   * Free-for-all is the special case "every player is their own team" with
//     teamId = seat (§5 contract comment).

import type { TeamDTO, TeamPattern } from './protocol.js';

export const TEAM_MODES = ['ffa', 'teams2', 'teams3', 'teams4'] as const;
export type TeamMode = (typeof TEAM_MODES)[number];

export function isTeamMode(v: unknown): v is TeamMode {
  return typeof v === 'string' && (TEAM_MODES as readonly string[]).includes(v);
}

/** Number of teams T of a mode (0 for free-for-all). */
export function teamCountOf(mode: TeamMode): number {
  return mode === 'ffa' ? 0 : Number(mode.slice('teams'.length));
}

/** The mode with T teams. */
export function teamModeFor(teams: number): TeamMode {
  const mode = `teams${teams}`;
  if (!isTeamMode(mode) || mode === 'ffa') throw new RangeError(`no team mode with ${teams} teams`);
  return mode;
}

/** Whether `mode` works for P players (free-for-all always does). */
export function isValidTeamMode(mode: TeamMode, players: number): boolean {
  if (mode === 'ffa') return true;
  const T = teamCountOf(mode);
  return players >= T;
}

/** The snake team sizes for P players in T teams, e.g. 5p 2 teams → [3, 2]. */
export function snakeTeamSizes(players: number, teams: number): number[] {
  const sizes = Array.from({ length: teams }, () => 0);
  for (let i = 0; i < players; i++) sizes[snakeTeamOf(i, teams)]!++;
  return sizes;
}

/** The member counts of teams (in team order). */
export function teamSizesOf(teams: readonly { members: readonly unknown[] }[]): number[] {
  return teams.map((t) => t.members.length);
}

/** Whether all team sizes are equal. */
export function equalTeamSizes(sizes: readonly number[]): boolean {
  return sizes.every((n) => n === sizes[0]);
}

/** The modes valid for P players, free-for-all first. */
export function validTeamModes(players: number): TeamMode[] {
  return TEAM_MODES.filter((m) => isValidTeamMode(m, players));
}

/**
 * UI label, e.g. "2 teams (3v3)", "3 teams / teams of 2 (2v2v2)", "2 teams
 * (3v2)". `sizes` (the actual team sizes) defaults to the snake deal.
 */
export function teamModeLabel(mode: TeamMode, players: number, sizes?: readonly number[]): string {
  if (mode === 'ffa') return 'Free-for-all';
  const T = teamCountOf(mode);
  const s = sizes && sizes.length === T ? sizes : snakeTeamSizes(Math.max(players, T), T);
  const vs = [...s].sort((a, b) => b - a).join('v');
  return s[0] === 2 && T > 2 && equalTeamSizes(s) ? `${T} teams / teams of 2 (${vs})` : `${T} teams (${vs})`;
}

/** The four team looks: ground-ring colour + pattern, so teams never rely on colour alone. */
export const TEAM_STYLES: ReadonlyArray<{ name: string; color: string; pattern: TeamPattern }> = [
  { name: 'Team 1', color: '#FFC93C', pattern: 'solid' }, // gold
  { name: 'Team 2', color: '#3CD6FF', pattern: 'dashed' }, // cyan
  { name: 'Team 3', color: '#FF5AC8', pattern: 'double' }, // magenta
  { name: 'Team 4', color: '#9BEA3C', pattern: 'dotted' }, // lime
];

/** Empty teams 0..T−1 with their names, colours and patterns. */
export function emptyTeams(teams: number): TeamDTO[] {
  if (!Number.isInteger(teams) || teams < 1 || teams > TEAM_STYLES.length) throw new RangeError(`unsupported team count ${teams}`);
  return TEAM_STYLES.slice(0, teams).map((s, teamId) => ({ teamId, name: s.name, color: s.color, pattern: s.pattern, members: [] }));
}

/**
 * The snake position of the i-th player (join order) among T teams: `i % T`
 * on even passes (floor(i / T) even), `T − 1 − i % T` on odd passes.
 */
export function snakeTeamOf(i: number, teams: number): number {
  const pos = i % teams;
  return Math.floor(i / teams) % 2 === 0 ? pos : teams - 1 - pos;
}

/**
 * Deal players (join order) into the mode's teams with the snake (§9.2
 * Auto-balance). Returns null for free-for-all. Members stay in join order.
 * Throws a RangeError when the mode isn't valid for this many players.
 */
export function autoBalance(playerIdsInJoinOrder: readonly string[], mode: TeamMode): TeamDTO[] | null {
  if (mode === 'ffa') return null;
  const P = playerIdsInJoinOrder.length;
  if (!isValidTeamMode(mode, P)) throw new RangeError(`${mode} is not valid for ${P} players`);
  const teams = emptyTeams(teamCountOf(mode));
  playerIdsInJoinOrder.forEach((id, i) => teams[snakeTeamOf(i, teams.length)]!.members.push(id));
  return teams;
}

/** The team a player is on, or undefined. */
export function teamOf(teams: readonly TeamDTO[] | null | undefined, playerId: string): TeamDTO | undefined {
  return teams?.find((t) => t.members.includes(playerId));
}

export type SwapResult = { ok: true; teams: TeamDTO[] } | { ok: false; code: 'NO_TEAMS' | 'NOT_FOUND' | 'SAME_TEAM' };

/**
 * Swap two players on different teams (§9.2 Swap; LOBBY only, the caller
 * checks the phase). Each takes the other's slot, so team sizes and block
 * order stay the same. Returns new team objects; the input is not changed.
 */
export function swapTeamPlayers(teams: readonly TeamDTO[] | null | undefined, a: string, b: string): SwapResult {
  if (!teams || teams.length === 0) return { ok: false, code: 'NO_TEAMS' };
  const ta = teamOf(teams, a);
  const tb = teamOf(teams, b);
  if (!ta || !tb) return { ok: false, code: 'NOT_FOUND' };
  if (ta.teamId === tb.teamId) return { ok: false, code: 'SAME_TEAM' };
  return {
    ok: true,
    teams: teams.map((t) => ({ ...t, members: t.members.map((m) => (m === a ? b : m === b ? a : m)) })),
  };
}

export type MoveResult = { ok: true; teams: TeamDTO[] } | { ok: false; code: 'NO_TEAMS' | 'NOT_FOUND' | 'BAD_TEAM' | 'SAME_TEAM' | 'LAST_MEMBER' };

/**
 * Move a player to another team (§9.2 Move; LOBBY only, the caller checks the
 * phase). The player joins the end of the new team. Refused when it would
 * leave their old team empty (every team keeps ≥ 1 player). Returns new team
 * objects; the input is not changed.
 */
export function moveTeamPlayer(teams: readonly TeamDTO[] | null | undefined, playerId: string, teamId: number): MoveResult {
  if (!teams || teams.length === 0) return { ok: false, code: 'NO_TEAMS' };
  const from = teamOf(teams, playerId);
  if (!from) return { ok: false, code: 'NOT_FOUND' };
  if (!teams.some((t) => t.teamId === teamId)) return { ok: false, code: 'BAD_TEAM' };
  if (from.teamId === teamId) return { ok: false, code: 'SAME_TEAM' };
  if (from.members.length <= 1) return { ok: false, code: 'LAST_MEMBER' };
  return {
    ok: true,
    teams: teams.map((t) =>
      t.teamId === from.teamId
        ? { ...t, members: t.members.filter((m) => m !== playerId) }
        : t.teamId === teamId
          ? { ...t, members: [...t.members, playerId] }
          : { ...t, members: [...t.members] },
    ),
  };
}

/** playerId → teamId. */
export function teamIdsByPlayer(teams: readonly TeamDTO[] | null | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of teams ?? []) for (const m of t.members) out.set(m, t.teamId);
  return out;
}

// ---------------------------------------------------------------------------
// Scaled round points (§9 Points, §9.2 Team scoring)
// ---------------------------------------------------------------------------

/**
 * Place points of a player whose side is in place k (1-based; tied sides
 * share the better place), with P ranked players and T ranked sides (T = P
 * free-for-all): round-half-up((P − 1) × (T − k) / (T − 1)). Free-for-all
 * this is P − k: 1st gets P − 1 down to 0 for last. 0 when T ≤ 1.
 */
export function placePointsFor(place: number, players: number, sides: number = players): number {
  if (sides <= 1 || players <= 1) return 0;
  const k = Math.min(Math.max(place, 1), sides);
  // Integer half-up: floor((2·(P−1)(T−k) + (T−1)) / (2·(T−1))).
  return Math.floor((2 * (players - 1) * (sides - k) + (sides - 1)) / (2 * (sides - 1)));
}

/** Place points for places 1..T, e.g. 4p free-for-all [3, 2, 1, 0], 6p 2v2v2 [5, 3, 0]. */
export function placePointsTable(players: number, sides: number = players): number[] {
  return Array.from({ length: Math.max(sides, 1) }, (_, i) => placePointsFor(i + 1, players, sides));
}

/** A bonus maximum (config value at 4 players) scaled × P/4 (§9 Points). Exact in binary (quarters). */
export function scaledBonusMax(maxAt4: number, players: number): number {
  return (maxAt4 * players) / 4;
}
