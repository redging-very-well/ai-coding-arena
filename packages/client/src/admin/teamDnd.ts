// Drag-and-drop team setup in /admin Match setup, DOM-free:
// what dropping a player chip on a team box does, the move/swap choices of the
// keyboard/click fallback menu, and the optimistic team lists shown while a
// move is on its way to the server (POST /admin/teams/move). The server stays
// the judge: every team keeps ≥ 1 player (LAST_MEMBER).

import type { TeamDTO } from '@pixel-clash/shared';

export const LAST_MEMBER_TEXT = 'Every team needs at least 1 player.';

export type DropResult =
  | { kind: 'move'; playerId: string; teamId: number }
  | { kind: 'none' }
  | { kind: 'refused'; code: 'LAST_MEMBER' | 'BAD_TEAM' | 'UNKNOWN_PLAYER'; text: string };

/** The team a player is on, or undefined. */
export function teamIdOf(teams: readonly TeamDTO[], playerId: string): number | undefined {
  return teams.find((t) => t.members.includes(playerId))?.teamId;
}

/** What dropping `playerId` on team `teamId` does. Same team = nothing. */
export function dropResult(teams: readonly TeamDTO[], playerId: string, teamId: number): DropResult {
  const from = teams.find((t) => t.members.includes(playerId));
  if (!from) return { kind: 'refused', code: 'UNKNOWN_PLAYER', text: 'That player is not on a team.' };
  if (!teams.some((t) => t.teamId === teamId)) return { kind: 'refused', code: 'BAD_TEAM', text: 'No such team.' };
  if (from.teamId === teamId) return { kind: 'none' };
  if (from.members.length <= 1) return { kind: 'refused', code: 'LAST_MEMBER', text: `${from.name} would be empty. ${LAST_MEMBER_TEXT}` };
  return { kind: 'move', playerId, teamId };
}

/** True when the chip may be dropped on that team (for the drop-zone highlight). */
export function canDrop(teams: readonly TeamDTO[], playerId: string, teamId: number): boolean {
  return dropResult(teams, playerId, teamId).kind === 'move';
}

/** The teams as they will look after the move (the optimistic view); unchanged when the move is refused. */
export function applyMove(teams: readonly TeamDTO[], playerId: string, teamId: number): TeamDTO[] {
  if (dropResult(teams, playerId, teamId).kind !== 'move') return teams.slice();
  return teams.map((t) =>
    t.teamId === teamId ? { ...t, members: [...t.members, playerId] } : t.members.includes(playerId) ? { ...t, members: t.members.filter((m) => m !== playerId) } : t,
  );
}

export interface MenuChoice {
  /** `move:<teamId>` or `swap:<playerId>`. */
  value: string;
  label: string;
  disabled: boolean;
}

/** The fallback menu of a chip: move to each other team, then swap with each player on another team. */
export function menuChoices(teams: readonly TeamDTO[], playerId: string, nameOf: (id: string) => string): { moves: MenuChoice[]; swaps: MenuChoice[] } {
  const from = teamIdOf(teams, playerId);
  const others = teams.filter((t) => t.teamId !== from);
  const moves = others.map((t) => ({ value: `move:${t.teamId}`, label: `Move to ${t.name}`, disabled: !canDrop(teams, playerId, t.teamId) }));
  const swaps = others.flatMap((t) => t.members.map((m) => ({ value: `swap:${m}`, label: `Swap with ${nameOf(m)} (${t.name})`, disabled: false })));
  return { moves, swaps };
}

/** Parse a menu value back into an action. */
export function parseChoice(value: string): { kind: 'move'; teamId: number } | { kind: 'swap'; playerId: string } | null {
  if (value.startsWith('move:')) {
    const teamId = Number(value.slice(5));
    return Number.isInteger(teamId) && teamId >= 0 ? { kind: 'move', teamId } : null;
  }
  if (value.startsWith('swap:') && value.length > 5) return { kind: 'swap', playerId: value.slice(5) };
  return null;
}
