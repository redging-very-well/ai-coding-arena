// The unit guide (plan §10.3 GET /guide, §12.1 "📖 Unit guide"): the full
// rulebook for units, built on the server from the LIVE config and the §5
// contract, rendered by /play's overlay and the standalone /guide page.
//
// The shape is deliberately generic (sections of blocks) so the client only
// renders it; every number is filled in by the server
// (packages/server/src/services/guide.ts).
//
// Inline markup in every text: `code` and **bold**. Nothing else.

import type { CostStats } from './contract.js';

/** One piece of a section. */
export type GuideBlockDTO =
  | { kind: 'text'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'table'; caption?: string; head: string[]; rows: string[][] }
  | { kind: 'cards'; cards: GuideCardDTO[] }
  /** A collapsible "For Claude / code" box: exact field names and a snippet. */
  | { kind: 'code'; title: string; text?: string; code: string }
  | { kind: 'tip'; text: string };

export interface GuideCardDTO {
  icon: string;
  title: string;
  text: string;
  facts?: string[];
}

export interface GuideSectionDTO {
  /** Anchor id (stable): types, stats, elements, support, view, actions, factories, cost, budget, battles. */
  id: string;
  icon: string;
  title: string;
  /** One line under the title. */
  summary: string;
  blocks: GuideBlockDTO[];
}

/** A live example price (the templates and a few archetypes), computed with `computeCost` under the current config. */
export interface GuideExampleDTO {
  id: string;
  name: string;
  group: 'template' | 'archetype';
  /** What the example shows, in player words. */
  note: string;
  stats: CostStats;
  cost: number;
  /** cost > caps.unitCost: too expensive to submit. */
  overCap: boolean;
}

export interface GuideDTO {
  /** Changes whenever a number in the guide changes (a hash of the config parts it uses). */
  stamp: string;
  title: string;
  intro: string;
  sections: GuideSectionDTO[];
  examples: GuideExampleDTO[];
}

/** The section ids in display order. */
export const GUIDE_SECTION_IDS = [
  'types',
  'stats',
  'elements',
  'support',
  'view',
  'actions',
  'factories',
  'cost',
  'budget',
  'battles',
] as const;
export type GuideSectionId = (typeof GUIDE_SECTION_IDS)[number];
