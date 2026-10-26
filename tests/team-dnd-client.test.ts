// Drag-and-drop team setup in /admin Match setup (plan §9.2, §12.3), DOM-free
// logic: drop results (move, same team, LAST_MEMBER, bad team), the optimistic
// view, and the chip's move/swap fallback menu.

import { describe, expect, it } from 'vitest';
import type { TeamDTO } from '@pixel-clash/shared';
import { applyMove, canDrop, dropResult, menuChoices, parseChoice, teamIdOf } from '../packages/client/src/admin/teamDnd.js';

const team = (teamId: number, members: string[]): TeamDTO => ({ teamId, name: `Team ${teamId + 1}`, color: '#fff', pattern: 'solid', members });
const teams = [team(0, ['a', 'b']), team(1, ['c']), team(2, ['d', 'e'])];

describe('teamDnd', () => {
  it('finds a player team', () => {
    expect(teamIdOf(teams, 'c')).toBe(1);
    expect(teamIdOf(teams, 'zz')).toBeUndefined();
  });

  it('moves a player to another team', () => {
    expect(dropResult(teams, 'a', 1)).toEqual({ kind: 'move', playerId: 'a', teamId: 1 });
    expect(canDrop(teams, 'a', 2)).toBe(true);
  });

  it('does nothing on the own team', () => {
    expect(dropResult(teams, 'a', 0)).toEqual({ kind: 'none' });
    expect(canDrop(teams, 'a', 0)).toBe(false);
  });

  it('refuses moving the last player of a team (LAST_MEMBER)', () => {
    const r = dropResult(teams, 'c', 0);
    expect(r.kind).toBe('refused');
    expect(r.kind === 'refused' && r.code).toBe('LAST_MEMBER');
    expect(r.kind === 'refused' && r.text).toMatch(/at least 1 player/);
    expect(r.kind === 'refused' && r.text).not.toMatch(/\bkids?\b/i);
    expect(canDrop(teams, 'c', 2)).toBe(false);
  });

  it('refuses unknown teams and players', () => {
    expect(dropResult(teams, 'a', 9)).toMatchObject({ kind: 'refused', code: 'BAD_TEAM' });
    expect(dropResult(teams, 'zz', 1)).toMatchObject({ kind: 'refused', code: 'UNKNOWN_PLAYER' });
  });

  it('applies a move optimistically without mutating the input', () => {
    const next = applyMove(teams, 'a', 1);
    expect(next.map((t) => t.members)).toEqual([['b'], ['c', 'a'], ['d', 'e']]);
    expect(teams[0]!.members).toEqual(['a', 'b']);
    expect(applyMove(teams, 'c', 0).map((t) => t.members)).toEqual(teams.map((t) => t.members));
  });

  it('builds the fallback menu: moves (last player disabled) and swaps', () => {
    const name = (id: string) => id.toUpperCase();
    const a = menuChoices(teams, 'a', name);
    expect(a.moves).toEqual([
      { value: 'move:1', label: 'Move to Team 2', disabled: false },
      { value: 'move:2', label: 'Move to Team 3', disabled: false },
    ]);
    expect(a.swaps.map((s) => s.value)).toEqual(['swap:c', 'swap:d', 'swap:e']);
    expect(a.swaps[0]!.label).toBe('Swap with C (Team 2)');
    const c = menuChoices(teams, 'c', name);
    expect(c.moves.every((m) => m.disabled)).toBe(true);
    expect(c.swaps).toHaveLength(4);
  });

  it('parses menu values', () => {
    expect(parseChoice('move:2')).toEqual({ kind: 'move', teamId: 2 });
    expect(parseChoice('swap:abc')).toEqual({ kind: 'swap', playerId: 'abc' });
    expect(parseChoice('')).toBeNull();
    expect(parseChoice('move:x')).toBeNull();
    expect(parseChoice('swap:')).toBeNull();
  });
});
