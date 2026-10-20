// §7 step 1: normalize the submitted source.
//
//  - Reject sources over the size cap (bytes, UTF-8) -> SOURCE_TOO_LARGE.
//  - CRLF/CR -> LF, strip a BOM.
//  - If the text contains markdown code fences, keep only the code: the best
//    fenced block (a js/ts block containing `export default`, else the
//    longest js/ts/untagged block). Prose outside the fences is dropped.
//  - Nothing left -> EMPTY_SOURCE.

import type { ValidationError } from '@pixel-clash/shared';

export type NormalizeResult = { ok: true; source: string } | { ok: false; error: ValidationError };

const FENCE_RE = /^[ \t]*(`{3,}|~{3,})[ \t]*([\w+-]*)[^\n]*$/;
const CODE_LANGS = new Set(['', 'js', 'javascript', 'mjs', 'cjs', 'ts', 'typescript', 'jsx', 'tsx']);

interface Block {
  lang: string;
  code: string;
}

/** Extract fenced code blocks. Returns undefined when the text has no fences. */
export function extractFencedBlocks(text: string): Block[] | undefined {
  const lines = text.split('\n');
  const blocks: Block[] = [];
  let open: { fence: string; lang: string; lines: string[] } | undefined;
  for (const line of lines) {
    const m = FENCE_RE.exec(line);
    if (!open) {
      if (m) open = { fence: m[1]!, lang: (m[2] ?? '').toLowerCase(), lines: [] };
      continue;
    }
    // A closing fence uses the same character, at least as long, and no info string.
    const trimmed = line.trim();
    if (m && trimmed.startsWith(open.fence[0]!.repeat(open.fence.length)) && /^[`~]+$/.test(trimmed)) {
      blocks.push({ lang: open.lang, code: open.lines.join('\n') });
      open = undefined;
    } else {
      open.lines.push(line);
    }
  }
  // An unclosed fence runs to the end of the text.
  if (open) blocks.push({ lang: open.lang, code: open.lines.join('\n') });
  return blocks.length > 0 ? blocks : undefined;
}

function pickBlock(blocks: Block[]): string {
  const code = blocks.filter((b) => CODE_LANGS.has(b.lang));
  const pool = code.length > 0 ? code : blocks;
  const withExport = pool.filter((b) => /\bexport\s+default\b/.test(b.code));
  const candidates = withExport.length > 0 ? withExport : pool;
  return candidates.reduce((a, b) => (b.code.length > a.code.length ? b : a)).code;
}

export function normalizeSource(input: unknown, maxBytes: number): NormalizeResult {
  if (typeof input !== 'string') {
    return {
      ok: false,
      error: {
        code: 'EMPTY_SOURCE',
        field: 'source',
        message: 'No source code was sent (the source must be a string).',
        fix: 'Send the whole unit file as one string in the "source" argument.',
      },
    };
  }
  const bytes = Buffer.byteLength(input, 'utf8');
  if (bytes > maxBytes) {
    return {
      ok: false,
      error: {
        code: 'SOURCE_TOO_LARGE',
        field: 'source',
        value: bytes,
        allowed: { maxBytes },
        message: `The source is ${bytes} bytes but the limit is ${maxBytes} bytes (${Math.round(maxBytes / 1024)} KB).`,
        fix: `Make the unit shorter: remove long comments, unused helpers and big data tables until it is under ${Math.round(maxBytes / 1024)} KB.`,
      },
    };
  }
  let text = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const blocks = extractFencedBlocks(text);
  if (blocks) text = pickBlock(blocks);
  text = text.trim();
  if (text.length === 0) {
    return {
      ok: false,
      error: {
        code: 'EMPTY_SOURCE',
        field: 'source',
        message: 'The source is empty.',
        fix: 'Send the whole unit file: one class, exported with `export default class … { constructor() { … } update(self, enemies, allies, world) { … } }`.',
      },
    };
  }
  return { ok: true, source: `${text}\n` };
}

/** Three lines of source around a 1-based line, numbered, for `excerpt`. */
export function excerptAround(source: string, line: number): string {
  const lines = source.split('\n');
  const from = Math.max(1, line - 1);
  const to = Math.min(lines.length, line + 1);
  const out: string[] = [];
  for (let n = from; n <= to; n++) {
    out.push(`${n === line ? '>' : ' '} ${String(n).padStart(3)} | ${lines[n - 1] ?? ''}`);
  }
  return out.join('\n');
}
