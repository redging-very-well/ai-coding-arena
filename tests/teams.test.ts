// Team modes, snake auto-balance, swaps and team looks (plan §9.2).

import { describe, expect, it } from 'vitest';
import {
  TEAM_MODES,
  TEAM_STYLES,
  autoBalance,
  emptyTeams,
  isTeamMode,
  isValidTeamMode,
  snakeTeamOf,
  swapTeamPlayers,
  teamCountOf,
  teamIdsByPlayer,
  teamModeFor,
  teamModeLabel,
  teamOf,
  validTeamModes,
} from '@pixel-clash/shared';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);
const letters = (n: number, mode: Parameters<typeof autoBalance>[1]) => {
  const teams = autoBalance(ids(n), mode)!;
  const byPlayer = teamIdsByPlayer(teams);
  return ids(n).map((id) => 'ABCD'[byPlayer.get(id)!]).join(' ');
};

describe('team modes', () => {
  it('ffa, teams2, teams3, teams4', () => {
    expect(TEAM_MODES).toEqual(['ffa', 'teams2', 'teams3', 'teams4']);
    expect(TEAM_MODES.map(teamCountOf)).toEqual([0, 2, 3, 4]);
    expect(teamModeFor(3)).toBe('teams3');
    expect(() => teamModeFor(5)).toThrow(RangeError);
    expect(isTeamMode('teams2')).toBe(true);
    expect(isTeamMode('teams5')).toBe(false);
  });

  it('valid when P is divisible by T and every team has ≥ 2 players', () => {
    expect(validTeamModes(2)).toEqual(['ffa']);
    expect(validTeamModes(3)).toEqual(['ffa']);
    expect(validTeamModes(4)).toEqual(['ffa', 'teams2']);
    expect(validTeamModes(5)).toEqual(['ffa']);
    expect(validTeamModes(6)).toEqual(['ffa', 'teams2', 'teams3']);
    expect(validTeamModes(7)).toEqual(['ffa']);
    expect(validTeamModes(8)).toEqual(['ffa', 'teams2', 'teams4']);
    expect(isValidTeamMode('teams4', 4)).toBe(false); // teams of 1
    expect(isValidTeamMode('teams3', 8)).toBe(false); // not divisible
  });

  it('UI labels', () => {
    expect(teamModeLabel('ffa', 4)).toBe('Free-for-all');
    expect(teamModeLabel('teams2', 4)).toBe('2 teams (2v2)');
    expect(teamModeLabel('teams2', 6)).toBe('2 teams (3v3)');
    expect(teamModeLabel('teams3', 6)).toBe('3 teams / teams of 2 (2v2v2)');
    expect(teamModeLabel('teams2', 8)).toBe('2 teams (4v4)');
    expect(teamModeLabel('teams4', 8)).toBe('4 teams / teams of 2 (2v2v2v2)');
  });
});

describe('auto-balance: a snake by join order', () => {
  it('4p 2 teams = A B B A; 6p 3 teams = A B C C B A; 8p 2 teams = A B B A A B B A', () => {
    expect(letters(4, 'teams2')).toBe('A B B A');
    expect(letters(6, 'teams3')).toBe('A B C C B A');
    expect(letters(6, 'teams2')).toBe('A B B A A B');
    expect(letters(8, 'teams2')).toBe('A B B A A B B A');
    expect(letters(8, 'teams4')).toBe('A B C D D C B A');
    expect([0, 1, 2, 3, 4, 5].map((i) => snakeTeamOf(i, 3))).toEqual([0, 1, 2, 2, 1, 0]);
  });

  it('teams are balanced, keep join order and carry name, colour and pattern', () => {
    for (const [n, mode] of [[4, 'teams2'], [6, 'teams2'], [6, 'teams3'], [8, 'teams2'], [8, 'teams4']] as const) {
      const teams = autoBalance(ids(n), mode)!;
      expect(teams).toHaveLength(teamCountOf(mode));
      for (const t of teams) {
        expect(t.members).toHaveLength(n / teams.length);
        expect([...t.members].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))).toEqual(t.members);
      }
      expect(new Set(teams.flatMap((t) => t.members)).size).toBe(n);
    }
    const [t0] = autoBalance(ids(4), 'teams2')!;
    expect(t0).toEqual({ teamId: 0, name: 'Team 1', color: '#FFC93C', pattern: 'solid', members: ['p0', 'p3'] });
  });

  it('free-for-all has no teams; an invalid mode throws', () => {
    expect(autoBalance(ids(5), 'ffa')).toBeNull();
    expect(() => autoBalance(ids(5), 'teams2')).toThrow(RangeError);
  });

  it('four distinct team looks: gold solid, cyan dashed, magenta double, lime dotted', () => {
    expect(TEAM_STYLES.map((s) => [s.color, s.pattern])).toEqual([
      ['#FFC93C', 'solid'],
      ['#3CD6FF', 'dashed'],
      ['#FF5AC8', 'double'],
      ['#9BEA3C', 'dotted'],
    ]);
    expect(emptyTeams(3).map((t) => t.name)).toEqual(['Team 1', 'Team 2', 'Team 3']);
    expect(() => emptyTeams(5)).toThrow(RangeError);
  });
});

describe('swaps', () => {
  it('two players on different teams trade slots (sizes and slot order kept)', () => {
    const teams = autoBalance(ids(4), 'teams2')!; // [p0, p3] [p1, p2]
    const r = swapTeamPlayers(teams, 'p0', 'p2');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.teams.map((t) => t.members)).toEqual([['p2', 'p3'], ['p1', 'p0']]);
    expect(teams.map((t) => t.members)).toEqual([['p0', 'p3'], ['p1', 'p2']]); // input untouched
    expect(teamOf(r.teams, 'p0')!.teamId).toBe(1);
  });

  it('SAME_TEAM, NOT_FOUND and NO_TEAMS', () => {
    const teams = autoBalance(ids(4), 'teams2')!;
    expect(swapTeamPlayers(teams, 'p0', 'p3')).toEqual({ ok: false, code: 'SAME_TEAM' });
    expect(swapTeamPlayers(teams, 'p0', 'zz')).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(swapTeamPlayers(null, 'p0', 'p1')).toEqual({ ok: false, code: 'NO_TEAMS' });
  });
});
