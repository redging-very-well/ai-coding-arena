// §7 steps 2-3: transpile with esbuild (TS syntax tolerated, CJS output) and
// reject imports.
//
// esbuild `transform` with loader 'ts', format 'cjs', target 'es2022'. CJS
// avoids isolated-vm module linking entirely: the sandbox wraps the output as
// `(function(module, exports){ … })` and reads `module.exports.default`.
//
// `verbatimModuleSyntax` stops esbuild's TS loader from silently DROPPING
// unused imports (`import fs from 'fs'` must be rejected, not ignored).
//
// The output keeps an inline source map (no sourcesContent) so runtime errors
// can be mapped back to the kid's original line numbers (sandbox/sourcemap.ts).

import { transform, type Message } from 'esbuild';
import type { ValidationError } from '@pixel-clash/shared';
import { excerptAround } from './normalize.js';

export type TranspileResult =
  | { ok: true; code: string; compiledJs: string }
  | { ok: false; error: ValidationError };

/** `require(` or `import(` anywhere in the compiled code (§7 step 3). */
export const IMPORT_RE = /\brequire\s*\(|\bimport\s*\(/;
/** Where an import/require appears in the ORIGINAL source (for the line number). */
const SOURCE_IMPORT_RE = /\bimport\b\s*(?:[\w${*\s},]*\bfrom\b\s*)?['"(]|\brequire\s*\(|\bimport\s*\(/;

export async function transpile(source: string): Promise<TranspileResult> {
  let code: string;
  let map: string;
  try {
    const out = await transform(source, {
      loader: 'ts',
      format: 'cjs',
      target: 'es2022',
      sourcemap: 'external',
      sourcesContent: false,
      sourcefile: 'unit.ts',
      logLevel: 'silent',
      tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true, useDefineForClassFields: true } },
    });
    code = out.code;
    map = out.map;
  } catch (err) {
    return { ok: false, error: syntaxError(source, err) };
  }

  if (IMPORT_RE.test(code)) {
    return { ok: false, error: importError(source) };
  }

  const compiledJs = `${code.replace(/\n+$/, '')}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(map).toString('base64')}\n`;
  return { ok: true, code, compiledJs };
}

function syntaxError(source: string, err: unknown): ValidationError {
  const first = (err as { errors?: Message[] }).errors?.[0];
  const loc = first?.location;
  const text = first?.text ?? (err instanceof Error ? err.message : String(err));
  if (!loc) {
    return {
      code: 'SYNTAX_ERROR',
      message: `The code could not be parsed: ${text}`,
      fix: 'Fix the JavaScript syntax error. Check for missing brackets, braces or quotes.',
      errorMessage: text,
    };
  }
  const line = loc.line;
  // esbuild counts the column in UTF-8 bytes; report characters (1-based).
  const column = Buffer.from(loc.lineText, 'utf8').subarray(0, loc.column).toString('utf8').length + 1;
  return {
    code: 'SYNTAX_ERROR',
    line,
    column,
    excerpt: excerptAround(source, line),
    errorMessage: text,
    message: `Syntax error on line ${line}, column ${column}: ${text}`,
    fix: `Fix the syntax on line ${line} (${text}). Check for missing or extra brackets, braces, commas or quotes around there.`,
  };
}

function importError(source: string): ValidationError {
  const lines = source.split('\n');
  const idx = lines.findIndex((l) => SOURCE_IMPORT_RE.test(l));
  const line = idx >= 0 ? idx + 1 : undefined;
  return {
    code: 'IMPORT_NOT_ALLOWED',
    field: 'source',
    ...(line !== undefined ? { line, excerpt: excerptAround(source, line) } : {}),
    message: `Units cannot import or require other code${line !== undefined ? ` (line ${line})` : ''}. Nothing outside the unit file exists in the game.`,
    fix: 'Remove every import/require/import() and write the helper code you need inside the unit file. Everything the unit needs is passed to update(self, enemies, allies, world).',
  };
}
