// The round-robin rules of plan §14 / §6 ("no single archetype dominates") as
// data, shared by tests/balance.test.ts (the caps and the stated outcomes) and
// the fast balance CLI (scripts/balance.ts), which checks every rule below
// with early stopping (helpers/balanceFast.ts). The shape checks mirror the
// expectations in tests/balance.test.ts's round-robin tests: keep them in step.

import { ALL_ARCHETYPES } from './balance.js';

/** §6 "no single archetype dominates": the most of its round-robin battles any archetype may win. */
export const ROUND_ROBIN_WIN_CAP = 0.7;

/**
 * The $10,000 redesign's full matrix (48 archetypes; docs/balance.md): the one
 * recorded exception key left from M8.8, re-recorded at the measured value
 * (both seeds; the one-seed default run measures at or under it) and never
 * above the M8.6 cap (220/256). 546-0-206 (72.6%): loses to the walled nests,
 * splash and the turtle, shield wall and the combo armies.
 */
export const FULL_DOMINANCE_EXCEPTIONS: Record<string, { roundRobinWinCap: number }> = {
  bricks: { roundRobinWinCap: 546 / 752 },
};
/**
 * WATCH ITEMS (the user accepted the "12 fighters, make them count" meta: a
 * padded one-design army slightly over 70% is recorded and capped, not a
 * blocker; no other new exception). The padded soldiers (the Basic Soldier with
 * HP and damage raised until the copy ramp and the budget stop it, 9 copies):
 * 540-0-212 (71.8%), losing only to splash, walls, the shield wall and combos.
 */
export const WATCH_ITEMS: Record<string, { roundRobinWinCap: number }> = {
  soldiersFilled: { roundRobinWinCap: 540 / 752 },
};

/** [A, B, why]: A wins most of its battles against B (≥ 9 of 16; ≥ 5 of 8 on one seed). The redesign's re-recorded list (§14). */
export const STATED: Array<[string, string, string]> = [
  ['splashline', 'soldiersFilled', 'splash answers the padded one-design army'],
  ['bombard', 'soldiersFilled', 'so does fire splash from range'],
  ['firenest', 'soldiersFilled', 'and fire splash behind walls'],
  ['overload', 'soldiersFilled', 'a combo army (lightning round fire towers: kindle + overload) beats the padded mono army'],
  ['overload', 'bricks', 'and the bricks'],
  ['mortars', 'rush', 'splash beats the template rush'],
  ['splashline', 'rush', 'a splash line too'],
  ['guardedcatapults', 'bricks', 'shield bearers in front of catapults stop two bricks'],
  ['shieldwall', 'bricks', 'a 25% shield blunts the bricks'],
  ['icewall', 'healerball', 'ice and snipers behind walls beat healing'],
  ['icebreak', 'healerball', 'brittle: frozen tanks take extra hits'],
  ['shatter', 'bigFriends', 'fire on frozen bodies shatters the Huge Tank'],
  ['firenest', 'storm', 'fire splash behind walls stops a soldier crowd'],
  ['mortars', 'storm', 'so does plain splash'],
  ['storm', 'runners', 'lightning is the anti-swarm element'],
  ['icemortars', 'buffedrush', 'a frozen rush is a slow rush'],
  ['factories5', 'mortars', 'five factories flood a splash battery with minions'],
  ['homeguard', 'mortars', 'and so does a grunt home guard'],
  ['icewall', 'wallrush', 'ice behind walls stops a soldier rush'],
  ['healerball', 'templates', 'healing wins a fair fight'],
  ['firenest', 'healerball', 'fire splash beats medics'],
  ['buffedrush', 'templates', 'might and haste make soldiers beat the templates'],
  ['shieldwall', 'glass', 'a 25% shield blunts the Glass Cannons'],
  ['bigFriends', 'bombard', 'a Huge Tank with medics walks through the catapults'],
  ['bigFriends', 'longbow', 'and the Max Snipers'],
  ['elemfactories', 'runners', 'ice archers and fire brutes beat plain runners'],
  ['tmix', 'templates', 'all four templates beat soldiers and towers alone'],
];

/** What a rule asks of one matchup cell (A's wins W, draws D, losses L over its n battles). */
export type CellPred =
  /** W > L ("A beats B"). */
  | 'beats'
  /** not W > L. */
  | 'notBeats'
  /** 2W > n (a stated outcome: A wins most). */
  | 'winsMost'
  /** L > W. */
  | 'losesMore'
  /** W ≥ frac·n. */
  | { winFrac: number };

export interface CellCheck {
  a: string;
  b: string;
  pred: CellPred;
}

/** One (sub-)matrix the structural rules apply to. */
export interface MatrixDef {
  name: string;
  keys: string[];
  /** Per-archetype win caps (the recorded exceptions); everyone else ROUND_ROBIN_WIN_CAP. */
  caps: Record<string, number>;
  /** Everyone must also lose to someone. */
  losingMatchup: boolean;
}

export type Rule =
  | { kind: 'cap'; matrix: string; row: string; cap: number; label: string }
  | { kind: 'struct'; matrix: string; row: string; what: 'beatsSomeone' | 'notBeatsAll' | 'losesToSomeone'; label: string }
  | { kind: 'cells'; checks: CellCheck[]; /** true: every check must hold; false: at least one. */ all: boolean; label: string; stated?: boolean };

const capsOf = (e: Record<string, { roundRobinWinCap: number }>) => Object.fromEntries(Object.entries(e).map(([k, v]) => [k, v.roundRobinWinCap]));


/**
 * The matrix of tests/balance.test.ts (all archetypes), restricted to `keys`.
 * The redesign rebuilt the pool for the $10,000 economy, so the old 6, 13 and
 * 17 sub-matrices (M6-M8.6 subsets with their own history) are gone: the full
 * matrix carries every structural rule.
 */
export function testMatrices(keys: string[]): MatrixDef[] {
  const all = ALL_ARCHETYPES.map((a) => a.key);
  const have = new Set(keys);
  const defs: MatrixDef[] = [{ name: 'full', keys: all, caps: { ...capsOf(FULL_DOMINANCE_EXCEPTIONS), ...capsOf(WATCH_ITEMS) }, losingMatchup: true }];
  // A matrix is checked only when all its archetypes are in the run; a custom selection is its own matrix.
  const out = defs.filter((d) => d.keys.every((k) => have.has(k)));
  if (!out.some((d) => d.keys.length === keys.length)) out.push({ name: 'selected', keys, caps: {}, losingMatchup: true });
  return out;
}

/** Every rule of the balance test's round robin that the archetypes in `keys` allow. */
export function testRules(keys: string[]): { matrices: MatrixDef[]; rules: Rule[] } {
  const matrices = testMatrices(keys);
  const rules: Rule[] = [];
  for (const m of matrices) {
    for (const row of m.keys) {
      const cap = m.caps[row] ?? ROUND_ROBIN_WIN_CAP;
      rules.push({ kind: 'cap', matrix: m.name, row, cap, label: `${m.name}: ${row} wins ≤ ${(100 * cap).toFixed(1)}%` });
      rules.push({ kind: 'struct', matrix: m.name, row, what: 'notBeatsAll', label: `${m.name}: ${row} doesn't beat everyone` });
      rules.push({ kind: 'struct', matrix: m.name, row, what: 'beatsSomeone', label: `${m.name}: ${row} beats someone` });
      if (m.losingMatchup) rules.push({ kind: 'struct', matrix: m.name, row, what: 'losesToSomeone', label: `${m.name}: ${row} loses to someone` });
    }
  }
  const have = new Set(keys);
  const cell = (a: string, b: string, pred: CellPred, label: string, stated = false) => {
    if (have.has(a) && have.has(b)) rules.push({ kind: 'cells', checks: [{ a, b, pred }], all: true, label, stated });
  };
  // Shape checks (tests/balance.test.ts, the round-robin describe), re-recorded for the redesign (§14).
  cell('bricks', 'tanks', 'beats', 'shape: bricks beat tanks');
  cell('turtle', 'templates', 'beats', 'shape: turtle beats templates');
  cell('tanks', 'turtle', 'notBeats', "shape: tanks don't beat the turtle");
  for (const melee of ['tanks', 'bricks', 'scouts', 'soldiersFilled', 'rush']) cell('fortress', melee, 'beats', `shape: fortress beats ${melee}`);
  for (const breaker of ['turtle', 'snipers']) cell('fortress', breaker, 'losesMore', `shape: fortress loses to ${breaker}`);
  cell('swarm', 'bunker', 'beats', 'shape: swarm beats bunker');
  cell('tanks', 'swarm', 'beats', 'shape: tanks beat swarm');
  cell('wallrush', 'templates', 'beats', 'shape: wallrush beats templates');
  cell('brutes', 'fortress', { winFrac: 0.75 }, 'shape: brutes beat fortress ≥ 3 in 4');
  for (const walled of ['turtle', 'fortress', 'snipewall']) cell('archers', walled, 'beats', `shape: archers beat ${walled}`);
  cell('homeguard', 'bunker', 'beats', 'shape: homeguard beats bunker');
  for (const [a, b, why] of STATED) cell(a, b, 'winsMost', `stated: ${a} > ${b} (${why})`, true);
  return { matrices, rules };
}
