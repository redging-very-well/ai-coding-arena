// Pure view-model helpers for the projector /screen. DOM-free so
// tests can import them.

import {
  BADGES,
  BADGE_IDS,
  producesOf,
  type BadgeId,
  type MinionKind,
  type BattleEndDTO,
  type BattleRevealDTO,
  type GameStateDTO,
  type Phase,
  type PlayerStatusDTO,
  type ScoreboardEntryDTO,
  type TeamDTO,
  type TeamPattern,
  type TeamTableRowDTO,
} from '@pixel-clash/shared';
import { countdownTitle } from '../common/advance.js';

// ---------------------------------------------------------------------------
// Battle end
// ---------------------------------------------------------------------------

/**
 * RESULTS banner over the arena. A host Skip ends the battle at the playback
 * tick and ranks from there, so a skip after real fighting reads like
 * any other end; "No battle this time" only when nothing was fought (skipped
 * before the first frame, or before anybody dealt damage).
 */
export function endReasonText(end: Pick<BattleEndDTO, 'reason' | 'endTick' | 'ranking'>): string {
  if (end.reason === 'elimination') return 'Last army standing!';
  if (end.reason === 'timeout') return "Time's up!";
  const fought = end.endTick > 0 && end.ranking.some((r) => r.damage > 0 || r.kills > 0);
  if (!fought) return 'No battle this time';
  // Armies (teams in team mode) still alive where the battle was stopped.
  const alive = new Set(end.ranking.filter((r) => r.livingCost > 0).map((r) => (r.teamId !== undefined ? `t${r.teamId}` : r.playerId)));
  return alive.size <= 1 ? 'Last army standing!' : 'Battle over!';
}

// ---------------------------------------------------------------------------
// Timers
// ---------------------------------------------------------------------------

/** The phase timer between 1 Hz state pushes: counts down locally unless paused. */
export function liveSecondsLeft(secondsLeft: number | null, receivedAt: number, paused: boolean, now: number): number | null {
  if (secondsLeft === null) return null;
  if (paused) return secondsLeft;
  return Math.max(0, secondsLeft - (now - receivedAt) / 1000);
}

/** Battle countdown (seconds) from the playback tick. */
export function battleSecondsLeft(tick: number, totalTicks: number, ticksPerSecond = 60): number {
  return Math.max(0, (totalTicks - tick) / ticksPerSecond);
}

/** The countdown turns red in the last 10 seconds. */
export const URGENT_SECONDS = 10;

export function isUrgent(seconds: number | null): boolean {
  return seconds !== null && seconds <= URGENT_SECONDS;
}

// ---------------------------------------------------------------------------
// START reveal: "3-2-1 CLASH!"
// ---------------------------------------------------------------------------

/** One count step and the CLASH! word; drop-in starts with CLASH!. */
export const REVEAL_STEP_MS = 650;
export const REVEAL_STEPS = ['3', '2', '1', 'CLASH!'] as const;
/** When the units start dropping in (ms after the reveal): on "1", so they land by CLASH!. */
export const REVEAL_DROP_AT_MS = REVEAL_STEP_MS * 2;
/** The overlay is gone after this. */
export const REVEAL_TOTAL_MS = REVEAL_STEP_MS * 3 + 1000;

/** The overlay text `ms` after the reveal, or null when it is over. */
export function revealStep(ms: number): string | null {
  if (ms < 0 || ms >= REVEAL_TOTAL_MS) return null;
  return REVEAL_STEPS[Math.min(REVEAL_STEPS.length - 1, Math.floor(ms / REVEAL_STEP_MS))]!;
}

// ---------------------------------------------------------------------------
// Army value bars
// ---------------------------------------------------------------------------

export interface ArmyValue {
  playerId: string;
  name: string;
  seat: number;
  /** Team mode: the player's team. */
  teamId?: number;
  /** Living value at START (walls count $0). */
  start: number;
  /** Living value now: soldiers/towers their cost, walls $0, factories body + unmade minions, minions minionValue. */
  living: number;
  /** Fighters (soldiers, towers, factories) still standing; walls aren't counted. */
  aliveCount: number;
  fieldedCount: number;
  /** Minions alive (M8.5). */
  minions: number;
  /** Walls placed (M8.5): they protect but add nothing to the bar. */
  walls: number;
}

/** What the bars need from the current frame besides the living ids (M8.5). */
export interface ArmyLive {
  /** Minions each living factory is worth: canMake + stored (`frame.fac`, minionsLeft in older frames; `factoryWorth`). */
  factoryLeft?: ReadonlyMap<string, number>;
}

/** The factory instanceId of a minion id ("2-0-3-m4" → "2-0-3"). */
function factoryOfMinion(id: string): string | null {
  const m = /^(.+)-m\d+$/.exec(id);
  return m ? m[1]! : null;
}

/**
 * Per-player living army value from the reveal and the ids alive in
 * the current frame (null = START: everything fielded). Walls are worth $0,
 * a factory its body cost plus minionValue per minion it can still make, a
 * minion minionValue.
 */
export function armyValues(reveal: BattleRevealDTO, aliveIds: ReadonlySet<string> | null, live: ArmyLive = {}): ArmyValue[] {
  const gruntValue = reveal.minion?.value ?? 0;
  // M8.6: each factory's minions are worth its kind's value.
  const valueOf = (d: { stats: { produces?: MinionKind } } | undefined) => {
    const kind = d ? producesOf(d.stats) : 'grunt';
    return reveal.minions?.[kind]?.value ?? gruntValue;
  };
  // Living minions per factory.
  const minionsOf = new Map<string, number>();
  for (const id of aliveIds ?? []) {
    const f = factoryOfMinion(id);
    if (f) minionsOf.set(f, (minionsOf.get(f) ?? 0) + 1);
  }
  return reveal.players.map((p) => {
    const designs = new Map(p.units.map((u) => [u.unitId, u]));
    let start = 0;
    let living = 0;
    let aliveCount = 0;
    let fieldedCount = 0;
    let minions = 0;
    let walls = 0;
    for (const inst of p.instances) {
      const d = designs.get(inst.unitId);
      const c = d?.cost ?? 0;
      const type = d?.stats.type ?? 'soldier';
      const out = minionsOf.get(inst.instanceId) ?? 0;
      const minionValue = valueOf(d);
      minions += out;
      living += out * minionValue;
      if (type === 'wall') {
        walls++;
        continue;
      }
      fieldedCount++;
      start += c;
      if (aliveIds && !aliveIds.has(inst.instanceId)) continue;
      aliveCount++;
      if (type === 'factory') {
        // As the server counts it: body + minionValue × the minions it can still make.
        const left = aliveIds ? live.factoryLeft?.get(inst.instanceId) : undefined;
        living += left === undefined || d?.bodyCost === undefined ? c : d.bodyCost + minionValue * left;
      } else living += c;
    }
    const team = reveal.teams && reveal.teams.length > 0 && p.teamId !== undefined ? { teamId: p.teamId } : {};
    return { playerId: p.playerId, name: p.name, seat: p.seat, ...team, start, living, aliveCount, fieldedCount, minions, walls };
  });
}

/** The /screen caption under the army bars in the first battle with walls. */
export const WALLS_CAPTION = 'Walls protect, but only fighters count!';

/** Whether a reveal fields any wall. */
export function revealHasWalls(reveal: BattleRevealDTO | null | undefined): boolean {
  if (!reveal) return false;
  return reveal.players.some((p) => {
    const walls = new Set(p.units.filter((u) => u.stats.type === 'wall').map((u) => u.unitId));
    return walls.size > 0 && p.instances.some((i) => walls.has(i.unitId));
  });
}

export interface TeamArmy {
  team: TeamDTO;
  start: number;
  living: number;
  /** The members' bars, in seat order (the team bar is split by member). */
  members: ArmyValue[];
}

/** Team mode: one army bar per team, split by member. Empty in free-for-all. */
export function teamArmyValues(values: readonly ArmyValue[], teams: readonly TeamDTO[] | null | undefined): TeamArmy[] {
  if (!teams || teams.length === 0) return [];
  return teams.map((team) => {
    const members = values.filter((v) => v.teamId === team.teamId).sort((a, b) => a.seat - b.seat);
    return {
      team,
      members,
      start: members.reduce((s, v) => s + v.start, 0),
      living: members.reduce((s, v) => s + v.living, 0),
    };
  });
}

// ---------------------------------------------------------------------------
// Player tiles (status ticks only, no unit data before START)
// ---------------------------------------------------------------------------

/** Free seats to show as empty tiles: fill up to 4 tiles (then to an even count), never past 8 seats. */
export function freeTiles(players: number, maxPlayers = 8): number {
  const target = Math.min(maxPlayers, Math.max(4, players + (players % 2)));
  return Math.max(0, target - players);
}

export interface StatusTick {
  label: string;
  done: boolean;
}

export function statusTicks(p: PlayerStatusDTO, phase: Phase): StatusTick[] {
  if (!p.active && phase !== 'LOBBY') return [{ label: 'Joins next round', done: false }];
  switch (phase) {
    case 'LOBBY':
      return [{ label: 'Joined', done: true }];
    case 'PLAN':
      return [
        { label: 'New unit', done: p.submitted },
        { label: 'Army picked', done: p.selected },
        { label: 'Ready', done: p.ready },
      ];
    case 'PLACEMENT':
      return [
        { label: 'Army picked', done: p.selected },
        { label: 'Ready', done: p.ready },
      ];
    default:
      return [];
  }
}

/**
 * A tile lights up when the player is done for the phase: in PLAN and
 * PLACEMENT that is Ready (a new unit is optional), in LOBBY having joined.
 */
export function tileDone(p: PlayerStatusDTO, phase: Phase): boolean {
  if (!p.active && phase !== 'LOBBY') return false;
  if (phase === 'PLAN' || phase === 'PLACEMENT') return p.ready;
  const ticks = statusTicks(p, phase);
  return ticks.length > 0 && ticks.every((t) => t.done);
}

export interface ReadyBanner {
  title: string;
  sub: string;
  /** A countdown to the next step runs: its whole seconds left (shown big). */
  countdown?: number;
}

/**
 * The banner over the top of the arena, from the public flags: the
 * countdown to the next step while one runs (even if someone un-readied
 * during a host countdown), else "time's up" (PLACEMENT timer ran out), else
 * "everyone's ready". Null otherwise.
 */
export function readyBanner(
  state: (Pick<GameStateDTO, 'phase' | 'allReady' | 'pendingAdvance'> & Partial<Pick<GameStateDTO, 'timer'>>) | null | undefined,
  /** The facilitator's go control: on RESULTS it gets a small banner to sit on. */
  goLabel?: string | null,
): ReadyBanner | null {
  if (!state) return null;
  const p = state.pendingAdvance;
  if (p && (state.phase === 'PLAN' || state.phase === 'PLACEMENT' || state.phase === 'RESULTS')) {
    return {
      title: countdownTitle(p),
      sub: p.by === 'auto' ? "Everyone's ready! 🎉" : 'Get ready!',
      countdown: p.secondsLeft,
    };
  }
  // Results: only the facilitator's browser shows a banner (with the go button); everyone else sees the results.
  if (state.phase === 'RESULTS') return goLabel ? { title: 'Round over!', sub: 'Ready when you are' } : null;
  // The PLACEMENT timer ran out: placement is closed, START works without everyone Ready.
  if (state.phase === 'PLACEMENT' && state.timer?.expired) return { title: "Time's up!", sub: 'Waiting for the host to press START' };
  if (!state.allReady) return null;
  if (state.phase === 'PLAN') return { title: "Everyone's ready! 🎉", sub: 'Waiting for the host to start placement' };
  if (state.phase === 'PLACEMENT') return { title: "Everyone's placed and ready!", sub: 'START when you like!' };
  return null;
}

/** All-ready just switched on within the same phase (the projector's soft chime). */
export function becameAllReady(
  prev: Pick<GameStateDTO, 'phase' | 'allReady'> | null | undefined,
  next: Pick<GameStateDTO, 'phase' | 'allReady'>,
): boolean {
  return !!prev && prev.phase === next.phase && !prev.allReady && !!next.allReady && (next.phase === 'PLAN' || next.phase === 'PLACEMENT');
}

// ---------------------------------------------------------------------------
// Results / podium
// ---------------------------------------------------------------------------

export interface RankRow {
  playerId: string;
  name: string;
  seat: number;
  place: number;
  /** Round points = placePoints + damageBonus + valueBonus. */
  pointsGained: number;
  placePoints: number;
  damage: number;
  damageBonus: number;
  valueDestroyed: number;
  valueBonus: number;
  badges: BadgeId[];
  /** 💡 Inventor: other players who fielded this player's Armory units. */
  inventorUsedBy?: number;
  /** Match total after this round. */
  total: number;
  livingCost: number;
  eliminatedAtTick: number | null;
}

/** The released ranking joined with names and totals. */
export function rankRows(state: Pick<GameStateDTO, 'lastBattle' | 'players' | 'scoreboard'>): RankRow[] {
  const lb = state.lastBattle;
  if (!lb) return [];
  const board = new Map<string, ScoreboardEntryDTO>(lb.scoreboard.map((s) => [s.playerId, s]));
  const players = new Map(state.players.map((p) => [p.id, p]));
  return [...lb.ranking]
    .sort((a, b) => a.place - b.place)
    .map((r) => {
      const s = board.get(r.playerId);
      const p = players.get(r.playerId);
      return {
        playerId: r.playerId,
        name: s?.name ?? p?.name ?? '?',
        seat: s?.seat ?? p?.seat ?? -1,
        place: r.place,
        pointsGained: r.pointsGained,
        placePoints: r.placePoints ?? r.pointsGained,
        damage: r.damage ?? 0,
        damageBonus: r.damageBonus ?? 0,
        valueDestroyed: r.valueDestroyed ?? 0,
        valueBonus: r.valueBonus ?? 0,
        badges: r.badges ?? [],
        ...(r.inventorUsedBy !== undefined ? { inventorUsedBy: r.inventorUsedBy } : {}),
        total: s?.points ?? p?.points ?? 0,
        livingCost: r.livingCost,
        eliminatedAtTick: r.eliminatedAtTick,
      };
    });
}

export interface TeamRankRow {
  teamId: number;
  name: string;
  color: string;
  pattern: TeamPattern;
  memberNames: string[];
  /** This round's team place (1-based, ties share) and the place points every member got. */
  place: number;
  placePoints: number;
  livingCost: number;
  /** Team table after this round: average member total and its place. */
  points: number;
  tablePlace: number;
}

/**
 * Team mode RESULTS: this round's team ranking joined with the team
 * table and names, by round place. Empty in free-for-all.
 */
export function teamRankRows(state: Pick<GameStateDTO, 'lastBattle' | 'players' | 'match'>): TeamRankRow[] {
  const lb = state.lastBattle;
  const ranks = lb?.teams ?? [];
  if (ranks.length === 0) return [];
  const table = new Map((lb?.teamTable ?? state.match?.teamTable ?? []).map((t) => [t.teamId, t]));
  const teams = new Map((state.match?.teams ?? []).map((t) => [t.teamId, t]));
  const names = new Map(state.players.map((p) => [p.id, p.name]));
  return [...ranks]
    .sort((a, b) => a.place - b.place || a.teamId - b.teamId)
    .map((r) => {
      const t = table.get(r.teamId);
      const team = teams.get(r.teamId);
      const members = t?.members ?? team?.members ?? r.members;
      return {
        teamId: r.teamId,
        name: t?.name ?? team?.name ?? `Team ${r.teamId + 1}`,
        color: t?.color ?? team?.color ?? '#9AA0AA',
        pattern: t?.pattern ?? team?.pattern ?? 'solid',
        memberNames: members.map((id) => names.get(id) ?? '?'),
        place: r.place,
        placePoints: r.placePoints,
        livingCost: r.livingCost,
        points: t?.points ?? 0,
        tablePlace: t?.place ?? r.place,
      };
    });
}

/** The team table by place (team podium, MATCH_RESULTS). */
export function teamStandings(table: readonly TeamTableRowDTO[] | null | undefined): TeamTableRowDTO[] {
  return [...(table ?? [])].sort((a, b) => a.place - b.place || b.points - a.points || a.teamId - b.teamId);
}

export type PodiumEntry = ScoreboardEntryDTO;

/**
 * Final standings: total points, then total match damage,
 * then a shared place. Recomputed here so the order never depends on the
 * payload's order.
 */
export function standings(scoreboard: readonly ScoreboardEntryDTO[]): PodiumEntry[] {
  const cmp = (a: ScoreboardEntryDTO, b: ScoreboardEntryDTO) => b.points - a.points || (b.damage ?? 0) - (a.damage ?? 0);
  const sorted = [...scoreboard].sort((a, b) => cmp(a, b) || a.seat - b.seat);
  let place = 0;
  return sorted.map((s, i) => {
    if (i === 0 || cmp(sorted[i - 1]!, s) !== 0) place = i + 1;
    return { ...s, place };
  });
}

/** A badge's emoji and title ("💡 Inventor · used by 2 players" with a use count). */
export function badgeLabel(id: BadgeId, usedBy?: number): string {
  const b = BADGES[id];
  const uses = id === 'inventor' && usedBy ? ` · used by ${usedBy} player${usedBy === 1 ? '' : 's'}` : '';
  return `${b.emoji} ${b.title}${uses}`;
}

/** Badges won this match, as "🏆×2" chips (badges with a zero count are left out). */
export function badgeCounts(entry: Pick<ScoreboardEntryDTO, 'badges'>): Array<{ id: BadgeId; emoji: string; title: string; count: number }> {
  return BADGE_IDS.filter((id) => (entry.badges?.[id] ?? 0) > 0).map((id) => ({
    id,
    emoji: BADGES[id].emoji,
    title: BADGES[id].title,
    count: entry.badges[id],
  }));
}

/** Podium column order: 2nd, 1st, 3rd (only those present). */
export function podiumOrder<T>(top: readonly T[]): T[] {
  const [a, b, c] = top;
  return [b, a, c].filter((x): x is T => x !== undefined);
}

/** Count-up animation value: ease-out from 0 to `target` over `durationMs`. */
export function countUp(target: number, elapsedMs: number, durationMs = 1200): number {
  if (elapsedMs >= durationMs) return target;
  const t = Math.max(0, elapsedMs / durationMs);
  return Math.round(target * (1 - (1 - t) ** 3));
}

// ---------------------------------------------------------------------------
// Results animation timing (shared by the view and the badge-pop sounds)
// ---------------------------------------------------------------------------

/** The points count-up of ranking row `i` starts this long after the ranking shows. */
export function countUpStartMs(i: number): number {
  return 300 + i * 250;
}

/** Badge `j` of ranking row `i` pops in this long after the ranking shows (after its row's count-up). */
export function badgePopDelayMs(i: number, j: number): number {
  return 1600 + i * 250 + j * 300;
}

/** Every badge pop of a ranking (rows in display order), in time order: one "pop" sound each. */
export function badgePopSchedule(rows: ReadonlyArray<{ badges: readonly unknown[] }>): number[] {
  const out: number[] = [];
  rows.forEach((r, i) => r.badges.forEach((_, j) => out.push(badgePopDelayMs(i, j))));
  return out.sort((a, b) => a - b);
}

/**
 * The badge "pop" sounds of RESULTS. Only the free-for-all ranking staggers
 * its badges; the team tables and reduced motion show them all at once, so
 * those get a single pop right away (none without badges).
 */
export function resultsBadgePops(
  rows: ReadonlyArray<{ badges: readonly unknown[] }>,
  opts: { teamMode: boolean; reducedMotion: boolean },
): number[] {
  if (!opts.teamMode && !opts.reducedMotion) return badgePopSchedule(rows);
  return rows.some((r) => r.badges.length > 0) ? [0] : [];
}

/**
 * What players finished between two state pushes (projector sounds): how many
 * became ready (PLAN or PLACEMENT, a chime) and how many other status ticks turned on
 * (a new unit or a picked army in PLAN, a blip). Only within the same phase.
 */
export function newlyDone(
  prev: readonly PlayerStatusDTO[] | null | undefined,
  next: readonly PlayerStatusDTO[],
  phase: Phase,
): { ready: number; ticks: number } {
  if (!prev) return { ready: 0, ticks: 0 };
  const before = new Map(prev.map((p) => [p.id, p]));
  let ready = 0;
  let ticks = 0;
  for (const p of next) {
    const b = before.get(p.id);
    if (!b) continue;
    if ((phase === 'PLAN' || phase === 'PLACEMENT') && p.ready && !b.ready) ready++;
    if (phase === 'PLAN' && p.submitted && !b.submitted) ticks++;
    if ((phase === 'PLAN' || phase === 'PLACEMENT') && p.selected && !b.selected) ticks++;
  }
  return { ready, ticks };
}
