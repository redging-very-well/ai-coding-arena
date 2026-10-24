// Pure helpers of the unit guide (plan §12.1 "📖 Unit guide"): inline markup
// (`code`, **bold**), the search filter and highlighting. Shared by /play's
// overlay and the standalone /guide page; no DOM here (tested in Node).

import type { GuideBlockDTO, GuideDTO, GuideSectionDTO } from '@pixel-clash/shared';

/** One run of inline text: plain, `code` or **bold**. */
export interface InlineRun {
  kind: 'text' | 'code' | 'bold';
  text: string;
}

/** Split `a `b` **c**` into runs. Unclosed markers stay plain text. */
export function parseInline(text: string): InlineRun[] {
  const out: InlineRun[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) });
    out.push(m[1] !== undefined ? { kind: 'code', text: m[1] } : { kind: 'bold', text: m[2]! });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

/** Text without the inline markers (what the player reads, for searching). */
export function plainText(text: string): string {
  return parseInline(text)
    .map((r) => r.text)
    .join('');
}

/** The normalized search query: trimmed, lower case, spaces collapsed; '' = no search. */
export function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Does this (marked-up) text contain the query? */
export function textMatches(text: string, query: string): boolean {
  return query !== '' && plainText(text).toLowerCase().replace(/\s+/g, ' ').includes(query);
}

/** Every searchable string of a block. */
export function blockTexts(block: GuideBlockDTO): string[] {
  switch (block.kind) {
    case 'text':
    case 'tip':
      return [block.text];
    case 'list':
      return block.items;
    case 'table':
      return [block.caption ?? '', ...block.head, ...block.rows.flat()];
    case 'cards':
      return block.cards.flatMap((c) => [c.title, c.text, ...(c.facts ?? [])]);
    case 'code':
      return [block.title, block.text ?? '', block.code];
  }
}

/** How many strings of a section match (title and summary included). */
export function sectionHits(section: GuideSectionDTO, query: string): number {
  if (query === '') return 0;
  const texts = [section.title, section.summary, ...section.blocks.flatMap(blockTexts)];
  return texts.filter((t) => textMatches(t, query)).length;
}

/** Does the section's own heading match (then every row shows)? */
export function headingMatches(section: GuideSectionDTO, query: string): boolean {
  return textMatches(section.title, query) || textMatches(section.summary, query);
}

/** Table rows to show for a query: all when there is no query or the caption/heading matches, else only matching rows. */
export function visibleRows(block: Extract<GuideBlockDTO, { kind: 'table' }>, query: string, showAll: boolean): string[][] {
  if (query === '' || showAll || textMatches(block.caption ?? '', query)) return block.rows;
  return block.rows.filter((row) => row.some((cell) => textMatches(cell, query)));
}

/** Does a block have anything matching (so it is shown while searching)? */
export function blockMatches(block: GuideBlockDTO, query: string): boolean {
  return blockTexts(block).some((t) => textMatches(t, query));
}

export interface GuideSearch {
  query: string;
  /** Section id → number of matching strings (0 = hidden while searching). */
  hits: Record<string, number>;
  /** Total matching strings. */
  total: number;
}

/** Run a search over the whole guide. */
export function searchGuide(guide: GuideDTO, rawQuery: string): GuideSearch {
  const query = normalizeQuery(rawQuery);
  const hits: Record<string, number> = {};
  let total = 0;
  for (const s of guide.sections) {
    const n = sectionHits(s, query);
    hits[s.id] = n;
    total += n;
  }
  return { query, hits, total };
}

/** Split plain text into parts to wrap in <mark> (case-insensitive). */
export function highlightParts(text: string, query: string): Array<{ text: string; hit: boolean }> {
  if (query === '') return [{ text, hit: false }];
  const lower = text.toLowerCase();
  const out: Array<{ text: string; hit: boolean }> = [];
  let at = 0;
  for (let i = lower.indexOf(query); i >= 0; i = lower.indexOf(query, i + query.length)) {
    if (i > at) out.push({ text: text.slice(at, i), hit: false });
    out.push({ text: text.slice(i, i + query.length), hit: true });
    at = i + query.length;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}

/** The standalone page's URL for a section ("/guide#cost"). */
export function guideUrl(sectionId?: string | null): string {
  return sectionId ? `/guide#${encodeURIComponent(sectionId)}` : '/guide';
}
