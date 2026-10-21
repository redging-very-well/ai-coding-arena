// Map positions in compiled unit code back to the player's original source.
//
// The validator's transpile step appends an inline source map to
// `compiledJs` (esbuild reprints code, so lines move). Errors thrown inside a
// sandbox carry a V8 stack like "at Foo.update (unit-0.js:12:7)"; we find the
// first frame in a unit script, undo the wrapper line and map it back.

import { WRAPPER_LINE_OFFSET } from './harness.js';

const INLINE_MAP_RE = /\n?\/\/# sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,([A-Za-z0-9+/=]+)\s*$/;

/** A decoded mapping segment: [generatedColumn, originalLine, originalColumn] (all 0-based). */
type Segment = [number, number, number];

export interface Position {
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  column: number;
}

/** Split `compiledJs` into code and its inline source map's `mappings` (if any). */
export function splitInlineSourceMap(compiledJs: string): { code: string; mappings?: string } {
  const m = INLINE_MAP_RE.exec(compiledJs);
  if (!m?.[1]) return { code: compiledJs };
  try {
    const json = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')) as { mappings?: unknown };
    return {
      code: compiledJs.slice(0, m.index),
      ...(typeof json.mappings === 'string' ? { mappings: json.mappings } : {}),
    };
  } catch {
    return { code: compiledJs.slice(0, m.index) };
  }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]));

/** Decode a source map `mappings` string into segments per generated line. */
export function decodeMappings(mappings: string): Segment[][] {
  const lines: Segment[][] = [];
  let srcLine = 0;
  let srcCol = 0;
  for (const lineStr of mappings.split(';')) {
    const segs: Segment[] = [];
    let genCol = 0;
    for (const segStr of lineStr.split(',')) {
      if (!segStr) continue;
      const fields: number[] = [];
      let value = 0;
      let shift = 0;
      for (const ch of segStr) {
        const digit = B64_INDEX.get(ch);
        if (digit === undefined) break;
        value += (digit & 31) << shift;
        if (digit & 32) {
          shift += 5;
        } else {
          fields.push(value & 1 ? -(value >>> 1) : value >>> 1);
          value = 0;
          shift = 0;
        }
      }
      genCol += fields[0] ?? 0;
      if (fields.length >= 4) {
        srcLine += fields[2] ?? 0;
        srcCol += fields[3] ?? 0;
        segs.push([genCol, srcLine, srcCol]);
      }
    }
    lines.push(segs);
  }
  return lines;
}

/** Maps compiled-code positions to original-source positions for one design. */
export class LineMapper {
  private decoded: Segment[][] | undefined;
  constructor(private readonly mappings: string | undefined) {}

  /** `pos` is in the compiled code (1-based). Returns the original position, or `pos` unchanged without a map. */
  map(pos: Position): Position {
    if (!this.mappings) return pos;
    this.decoded ??= decodeMappings(this.mappings);
    const segs = this.decoded[pos.line - 1];
    if (!segs || segs.length === 0) {
      // No mapping on this line: use the nearest earlier mapped line.
      for (let l = pos.line - 2; l >= 0; l--) {
        const prev = this.decoded[l];
        const last = prev?.[prev.length - 1];
        if (last) return { line: last[1] + 1, column: last[2] + 1 };
      }
      return pos;
    }
    // Last segment that starts at or before the column.
    const col0 = pos.column - 1;
    let best = segs[0]!;
    for (const s of segs) {
      if (s[0] <= col0) best = s;
      else break;
    }
    return { line: best[1] + 1, column: best[2] + 1 + Math.max(0, col0 - best[0]) };
  }
}

const FRAME_RE = /unit-(\d+)\.js:(\d+):(\d+)/;

/**
 * Find the first stack frame inside a unit script. Returns the design index
 * and the position in the compiled code (wrapper line removed), or undefined.
 */
export function findUnitFrame(stack: string | undefined): { index: number; pos: Position } | undefined {
  if (!stack) return undefined;
  const m = FRAME_RE.exec(stack);
  if (!m) return undefined;
  const line = Number(m[2]) - WRAPPER_LINE_OFFSET;
  if (line < 1) return undefined;
  return { index: Number(m[1]), pos: { line, column: Number(m[3]) } };
}
