// The unit guide view (plan §12.1 "📖 Unit guide"): the server-built GuideDTO
// (GET /guide) with a sticky table of contents, a search box that filters and
// highlights sections, collapsible "For Claude / code" boxes, and either a
// close button + "Open in new tab ↗" (the /play overlay) or a print button
// (the standalone /guide page).

import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { GuideBlockDTO, GuideDTO, GuideSectionDTO } from '@pixel-clash/shared';
import { cx } from '../common/ui.js';
import { blockMatches, guideUrl, headingMatches, highlightParts, parseInline, searchGuide, visibleRows } from './logic.js';

/** DOM id of a section (prefixed: the overlay shares the /play document). */
export const sectionDomId = (id: string) => `guide-${id}`;

function Marked({ text, q }: { text: string; q: string }) {
  return (
    <>
      {highlightParts(text, q).map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : p.text))}
    </>
  );
}

/** Inline markup (`code`, **bold**) with the search highlighted. */
export function Inline({ text, q }: { text: string; q: string }) {
  return (
    <>
      {parseInline(text).map((r, i) =>
        r.kind === 'code' ? (
          <code key={i}>
            <Marked text={r.text} q={q} />
          </code>
        ) : r.kind === 'bold' ? (
          <strong key={i}>
            <Marked text={r.text} q={q} />
          </strong>
        ) : (
          <Marked key={i} text={r.text} q={q} />
        ),
      )}
    </>
  );
}

function Block({ block, q, showAll }: { block: GuideBlockDTO; q: string; showAll: boolean }) {
  switch (block.kind) {
    case 'text':
      return (
        <p>
          <Inline text={block.text} q={q} />
        </p>
      );
    case 'tip':
      return (
        <p class="guide-tip">
          <span aria-hidden="true">💡 </span>
          <Inline text={block.text} q={q} />
        </p>
      );
    case 'list':
      return (
        <ul class="guide-list">
          {block.items.map((t, i) => (
            <li key={i}>
              <Inline text={t} q={q} />
            </li>
          ))}
        </ul>
      );
    case 'cards':
      return (
        <div class="guide-cards">
          {block.cards.map((c) => (
            <div key={c.title} class="guide-card">
              <div class="guide-card-head">
                <span class="guide-card-icon" aria-hidden="true">
                  {c.icon}
                </span>
                <strong>
                  <Marked text={c.title} q={q} />
                </strong>
              </div>
              <p>
                <Inline text={c.text} q={q} />
              </p>
              {c.facts && c.facts.length > 0 && (
                <div class="guide-facts">
                  {c.facts.map((f) => (
                    <span key={f} class="guide-fact">
                      <Inline text={f} q={q} />
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      );
    case 'table': {
      const rows = visibleRows(block, q, showAll);
      return (
        <div class="guide-table">
          {block.caption && (
            <h4>
              <Inline text={block.caption} q={q} />
            </h4>
          )}
          <div class="guide-table-wrap">
            <table>
              <thead>
                <tr>
                  {block.head.map((h) => (
                    <th key={h} scope="col">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i}>
                    {row.map((cell, j) => (
                      <td key={j}>
                        <Inline text={cell} q={q} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );
    }
    case 'code':
      return (
        <details class="guide-code" open={q !== '' && blockMatches(block, q) ? true : undefined}>
          <summary>
            <span aria-hidden="true">🤖 </span>
            <Marked text={block.title} q={q} />
          </summary>
          {block.text && (
            <p>
              <Inline text={block.text} q={q} />
            </p>
          )}
          <pre>
            <code>
              <Marked text={block.code} q={q} />
            </code>
          </pre>
        </details>
      );
  }
}

function Section({ section, q }: { section: GuideSectionDTO; q: string }) {
  const showAll = q === '' || headingMatches(section, q);
  const blocks = showAll ? section.blocks : section.blocks.filter((b) => blockMatches(b, q));
  return (
    <section id={sectionDomId(section.id)} class="guide-section" aria-labelledby={`${sectionDomId(section.id)}-h`}>
      <h3 id={`${sectionDomId(section.id)}-h`}>
        <span aria-hidden="true">{section.icon} </span>
        <Marked text={section.title} q={q} />
      </h3>
      <p class="guide-summary">
        <Inline text={section.summary} q={q} />
      </p>
      {blocks.map((b, i) => (
        <Block key={i} block={b} q={q} showAll={showAll} />
      ))}
    </section>
  );
}

export interface GuideViewProps {
  guide: GuideDTO | null;
  error?: string | null;
  mode: 'overlay' | 'page';
  /** Overlay: close it (✕ and Esc). */
  onClose?: () => void;
  /** A short "numbers updated" note after a live config change. */
  updated?: boolean;
  /** Extra toolbar buttons (the page's Print). */
  actions?: ComponentChildren;
  /** Section to show first (the page's #hash). */
  initialSection?: string | null;
}

export function GuideView({ guide, error, mode, onClose, updated, actions, initialSection }: GuideViewProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<string | null>(initialSection ?? null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const search = useMemo(() => (guide ? searchGuide(guide, query) : null), [guide, query]);
  const q = search?.query ?? '';
  const sections = guide ? guide.sections.filter((s) => q === '' || (search?.hits[s.id] ?? 0) > 0) : [];

  // The overlay takes the focus from the terminal, so Esc and typing reach it.
  useEffect(() => {
    if (mode === 'overlay') searchRef.current?.focus({ preventScroll: true });
  }, [mode]);

  // Jump to the #hash section once the guide is there.
  const jumped = useRef(false);
  useEffect(() => {
    if (!guide || jumped.current || !initialSection) return;
    jumped.current = true;
    document.getElementById(sectionDomId(initialSection))?.scrollIntoView({ block: 'start' });
  }, [guide, initialSection]);

  // The TOC follows the section at the top of the view.
  useEffect(() => {
    if (!guide || typeof IntersectionObserver === 'undefined') return;
    const root = mode === 'overlay' ? scrollRef.current : null;
    const seen = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.isIntersecting);
        const first = guide.sections.find((s) => seen.get(sectionDomId(s.id)));
        if (first) setActive(first.id);
      },
      { root, rootMargin: '-80px 0px -55% 0px' },
    );
    for (const s of guide.sections) {
      const el = document.getElementById(sectionDomId(s.id));
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [guide, mode, q]);

  // The chip-row TOC (narrow) keeps the active chip in view.
  const tocRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const toc = tocRef.current;
    const link = active ? toc?.querySelector<HTMLElement>(`a[href="#${active}"]`) : null;
    if (!toc || !link || toc.scrollWidth <= toc.clientWidth) return;
    toc.scrollLeft = Math.max(0, link.offsetLeft - toc.offsetLeft - 16);
  }, [active]);

  const goTo = (id: string) => {
    setActive(id);
    document.getElementById(sectionDomId(id))?.scrollIntoView({ block: 'start' });
    if (mode === 'page') history.replaceState(null, '', `#${id}`);
  };

  return (
    <div class={cx('guide', `guide-${mode}`)}>
      <div class="guide-bar">
        <h2 class="pixel guide-title">📖 Unit guide</h2>
        <label class="guide-search">
          <span class="guide-sr">Search the guide</span>
          <input
            ref={searchRef}
            type="search"
            placeholder="Search: heal, splash, burst…"
            value={query}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && sections[0]) goTo(sections[0].id);
            }}
          />
        </label>
        {q !== '' && search && (
          <span class={cx('guide-hits', search.total === 0 && 'none')} aria-live="polite">
            {search.total === 0 ? 'No match' : `${search.total} match${search.total === 1 ? '' : 'es'}`}
          </span>
        )}
        {updated && (
          <span class="guide-updated" role="status">
            New numbers from the host!
          </span>
        )}
        <span class="guide-bar-end">
          {actions}
          {mode === 'overlay' && (
            <a class="guide-btn guide-newtab" href={guideUrl(active)} target="_blank" rel="noopener">
              Open in new tab ↗
            </a>
          )}
          {onClose && (
            <button class="guide-btn guide-close" onClick={onClose} aria-label="Close the unit guide" title="Close (Esc)">
              ✕
            </button>
          )}
        </span>
      </div>
      <div ref={scrollRef} class="guide-scroll">
        <nav ref={tocRef} class="guide-toc" aria-label="Unit guide sections">
          <ol>
            {(guide?.sections ?? []).map((s) => {
              const hits = search?.hits[s.id] ?? 0;
              const off = q !== '' && hits === 0;
              return (
                <li key={s.id}>
                  <a
                    href={`#${s.id}`}
                    class={cx(active === s.id && 'on', off && 'off')}
                    aria-current={active === s.id ? 'true' : undefined}
                    onClick={(e) => {
                      e.preventDefault();
                      if (!off) goTo(s.id);
                    }}
                  >
                    <span aria-hidden="true">{s.icon}</span> {s.title}
                    {q !== '' && hits > 0 && <span class="guide-toc-hits">{hits}</span>}
                  </a>
                </li>
              );
            })}
          </ol>
        </nav>
        <div class="guide-content">
          {error && <p class="guide-note bad">{error}</p>}
          {!guide && !error && <p class="guide-dim">Loading the guide…</p>}
          {guide && q === '' && <p class="guide-intro">{guide.intro}</p>}
          {guide && q !== '' && sections.length === 0 && (
            <p class="guide-note">Nothing matches "{query.trim()}". Try another word, like "fire" or "cooldown".</p>
          )}
          {sections.map((s) => (
            <Section key={s.id} section={s} q={q} />
          ))}
        </div>
      </div>
    </div>
  );
}
