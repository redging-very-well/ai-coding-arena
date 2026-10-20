// Config editor helpers (DOM-free, tested): the minimal patch between the
// loaded config and the edited JSON, so PUT /admin/config stores only what
// the facilitator actually changed (arrays are replaced as a whole).

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The deep partial of `next` that differs from `base`: changed leaves and
 * arrays, and keys that are new in `next`. Keys removed in `next` are ignored
 * (a partial config can't delete a setting). Returns undefined when equal.
 */
export function configDiff(base: unknown, next: unknown): unknown {
  if (isObject(base) && isObject(next)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(next)) {
      const d = k in base ? configDiff(base[k], v) : v;
      if (d !== undefined) out[k] = d;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return sameJson(base, next) ? undefined : next;
}

/** Parse the editor text; a readable error instead of a throw. */
export function parseConfigText(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    const value = JSON.parse(text) as unknown;
    if (!isObject(value)) return { ok: false, error: 'The config must be a JSON object { … }.' };
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: `Not valid JSON: ${(err as Error).message}` };
  }
}
