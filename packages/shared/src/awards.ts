// Match awards (plan §9 Match awards): the end-of-match titles the /screen
// ceremony reveals one by one at MATCH_RESULTS, each with its winner(s), the
// stat that won it and a "best unit" (sprite of a design that was revealed
// when it was fielded; never source). Computed by the server from the
// per-match stats it keeps across rounds (services/awards.ts). Ties share an
// award; an award nobody earned (value 0) is left out. Like badges they give
// no points.

import type { SpriteSpec, StatsSnapshot } from './contract.js';

/** In ceremony (reveal) order: specialist and story awards first, the Champion last. */
export const AWARD_IDS = [
  'masterBuilder',
  'factoryBoss',
  'bestMedic',
  'comboMaster',
  'survivor',
  'teamPlayer',
  'armoryStar',
  'inventor',
  'sharpshooter',
  'comeback',
  'biggestArmy',
  'giantSlayer',
  'biggestHitter',
  'mostWins',
  'champion',
] as const;
export type AwardId = (typeof AWARD_IDS)[number];

export type AwardGroup = 'core' | 'specialist' | 'story';

export interface AwardInfo {
  emoji: string;
  title: string;
  /** How it is won (one short line). */
  rule: string;
  group: AwardGroup;
}

export const AWARDS: Record<AwardId, AwardInfo> = {
  champion: { emoji: '🏆', title: 'Champion', rule: 'most points this game (1st in the final standings)', group: 'core' },
  mostWins: { emoji: '🥇', title: 'Most Wins', rule: 'most rounds finished 1st', group: 'core' },
  biggestHitter: { emoji: '💥', title: 'Biggest Hitter', rule: 'most damage dealt this game', group: 'core' },
  giantSlayer: { emoji: '🗡️', title: 'Giant Slayer', rule: 'most enemy value destroyed this game', group: 'core' },
  biggestArmy: { emoji: '🪖', title: 'Biggest Army', rule: 'most units placed this game (walls not counted)', group: 'core' },
  armoryStar: { emoji: '💡', title: 'Armory Star', rule: 'their Open Armory units were borrowed most by other players', group: 'core' },
  bestMedic: { emoji: '💚', title: 'Best Medic', rule: 'most HP healed this game', group: 'specialist' },
  comboMaster: { emoji: '⚡', title: 'Combo Master', rule: 'most shatters and overload zaps this game', group: 'specialist' },
  masterBuilder: { emoji: '🧱', title: 'Master Builder', rule: 'most walls placed this game', group: 'specialist' },
  factoryBoss: { emoji: '🏭', title: 'Factory Boss', rule: 'most minions made this game', group: 'specialist' },
  survivor: { emoji: '🛡️', title: 'Survivor', rule: 'most units still standing at the end of the rounds (walls not counted)', group: 'specialist' },
  comeback: { emoji: '📈', title: 'Comeback', rule: 'biggest climb from their lowest place in the standings to their final place', group: 'story' },
  inventor: { emoji: '🧪', title: 'Inventor', rule: 'most different own unit designs fielded', group: 'story' },
  sharpshooter: { emoji: '🎯', title: 'Sharpshooter', rule: 'longest-range knockout (edge to edge)', group: 'story' },
  teamPlayer: { emoji: '🤝', title: 'Team Player', rule: 'most Open Armory units borrowed and fielded', group: 'story' },
};

/** A winner's "best unit": a design they fielded (revealed at START), drawn with its sprite. */
export interface AwardUnitDTO {
  unitId: string;
  /** The name it fought under ("Ogre (Ninja Sam)" for a borrowed one). */
  name: string;
  stats?: StatsSnapshot;
  /** null when there is none or it is hidden (draw the fallback from stats). */
  sprite: SpriteSpec | null;
  spriteHidden: boolean;
  /** Borrowed from the Open Armory: the creator's name. */
  borrowedFrom?: string;
}

export interface AwardWinnerDTO {
  playerId: string;
  name: string;
  seat: number;
  /** Team mode: the player's team. */
  teamId?: number;
  bestUnit: AwardUnitDTO | null;
  /** Extra words for this winner, e.g. "4th → 1st" (Comeback) or the KO unit (Sharpshooter). */
  detail?: string;
}

/** One award of the match (`GameStateDTO.matchAwards`, MATCH_RESULTS only). */
export interface MatchAwardDTO {
  id: AwardId;
  emoji: string;
  title: string;
  rule: string;
  /** The winning stat (whole number, > 0); every winner has it. */
  value: number;
  /** The stat in words: "312 px KO", "3 rounds won" (awardStatText). */
  text: string;
  /** One or more (ties share the award). */
  winners: AwardWinnerDTO[];
}

const n = (v: number) => Math.round(v).toLocaleString('en-US');
const plural = (v: number, one: string, many: string) => `${n(v)} ${Math.round(v) === 1 ? one : many}`;

/** The stat in words for an award value (also used for the count-up on /screen). */
export function awardStatText(id: AwardId, value: number): string {
  switch (id) {
    case 'champion':
      return plural(value, 'point', 'points');
    case 'mostWins':
      return plural(value, 'round won', 'rounds won');
    case 'biggestHitter':
      return `${n(value)} damage`;
    case 'giantSlayer':
      return `$${n(value)} destroyed`;
    case 'biggestArmy':
      return plural(value, 'unit placed', 'units placed');
    case 'armoryStar':
      return `borrowed ${plural(value, 'time', 'times')}`;
    case 'bestMedic':
      return `${n(value)} HP healed`;
    case 'comboMaster':
      return plural(value, 'combo', 'combos');
    case 'masterBuilder':
      return plural(value, 'wall', 'walls');
    case 'factoryBoss':
      return plural(value, 'minion', 'minions');
    case 'survivor':
      return plural(value, 'unit survived', 'units survived');
    case 'comeback':
      return `climbed ${plural(value, 'place', 'places')}`;
    case 'inventor':
      return plural(value, 'design', 'designs');
    case 'sharpshooter':
      return `${n(value)} px KO`;
    case 'teamPlayer':
      return plural(value, 'unit borrowed', 'units borrowed');
  }
}
