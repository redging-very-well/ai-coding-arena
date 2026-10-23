// The read-only sprite() range of the unit editor (plan §12.1): a state field
// holding the protected range (mapped through every edit) and a transaction
// filter that drops any edit touching it. Typing right before or right after
// the method is fine; edits inside it (or a selection that reaches into it)
// are refused, and `onBlocked` tells the page so it can say "Ask Claude to
// change how it looks". State-only (no DOM), so tests can run it.

import { Annotation, EditorState, StateEffect, StateField, type Extension, type Transaction } from '@codemirror/state';
import type { Span } from './logic.js';

/** Replace (or clear) the protected range, e.g. after "Reload latest". */
export const setProtected = StateEffect.define<Span | null>();

/** A transaction that may change the protected range (a full reload of the code). */
export const allowProtectedEdit = Annotation.define<boolean>();

export const protectedRange = StateField.define<Span | null>({
  create: () => null,
  update(range, tr) {
    for (const e of tr.effects) if (e.is(setProtected)) return e.value;
    if (!range || !tr.docChanged) return range;
    // Text typed at the start goes before it, at the end after it.
    const from = tr.changes.mapPos(range.from, 1);
    const to = tr.changes.mapPos(range.to, -1);
    return to > from ? { from, to } : null;
  },
});

/** Does an edit of [from, to) touch the protected range? Insertions at its edges don't. */
export function touchesProtected(range: Span, from: number, to: number): boolean {
  if (from === to) return from > range.from && from < range.to;
  return from < range.to && to > range.from;
}

/** True if the transaction edits inside the protected range. */
export function editsProtected(tr: Transaction): boolean {
  if (!tr.docChanged || tr.annotation(allowProtectedEdit)) return false;
  const range = tr.startState.field(protectedRange, false);
  if (!range) return false;
  let hit = false;
  tr.changes.iterChangedRanges((fromA, toA) => {
    if (touchesProtected(range, fromA, toA)) hit = true;
  });
  return hit;
}

/** The field and the filter; `onBlocked` runs (async) when an edit was refused. */
export function protectSprite(initial: Span | null, onBlocked?: () => void): Extension {
  return [
    protectedRange.init(() => initial),
    EditorState.transactionFilter.of((tr) => {
      if (!editsProtected(tr)) return tr;
      if (onBlocked) queueMicrotask(onBlocked);
      return [];
    }),
  ];
}
