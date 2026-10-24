// The round-robin rules of plan §14 / §6 ("no single archetype dominates") as
// data, shared by tests/balance.test.ts (the caps and the stated outcomes) and
// the fast balance CLI (scripts/balance.ts), which checks every rule below
// with early stopping (helpers/balanceFast.ts). The shape checks mirror the
// expectations in tests/balance.test.ts's round-robin tests: keep them in step.

import { ALL_ARCHETYPES, ARCHETYPES, BUILDING_ARCHETYPES, KIND_ARCHETYPES } from './balance.js';

/** §6 "no single archetype dominates": the most of its round-robin battles any archetype may win. */
export const ROUND_ROBIN_WIN_CAP = 0.7;

/** The 17×17 (M8.6) part: 188-0-68 (73%): loses to the walled nests, the sealed fortress and walls + rush. */
export const KIND_DOMINANCE_EXCEPTIONS: Record<string, { roundRobinWinCap: number }> = {
  bricks: { roundRobinWinCap: 188 / 256 },
};
/** The full M8.8 matrix (37 archetypes): 410-0-166 (71%): loses to the walled nests, ice + fire and the shatter squad. */
export const FULL_DOMINANCE_EXCEPTIONS: Record<string, { roundRobinWinCap: number }> = {
  bricks: { roundRobinWinCap: 410 / 576 },
};

/** [A, B, why]: A wins most of its battles against B (≥ 9 of 16; ≥ 5 of 8 on one seed). */
export const STATED: Array<[string, string, string]> = [
  ['shatter', 'bricks', 'fire on frozen bricks shatters them'],
  ['shatter', 'bigFriends', 'and the Huge Tank'],
  ['frostnest', 'bricks', 'ice is the anti-brick counter'],
  ['blizzard', 'bricks', 'so is a freezing totem with fire soldiers round it'],
  ['blizzard', 'buffedrush', 'a frozen rush is a slow rush'],
  ['mortars', 'scoutsFilled', 'splash is the anti-swarm counter'],
  ['firenest', 'storm', 'fire splash behind walls stops a soldier crowd'],
  ['icewall', 'wallrush', 'ice behind walls stops a soldier rush'],
  ['healerball', 'templates', 'healing wins a fair fight'],
  ['shatter', 'healerball', 'but fire beats medics (a heal on a burning ally only cleanses)'],
  ['firenest', 'healerball', 'fire splash too'],
  ['buffedrush', 'templates', 'might and haste make 6 soldiers beat 7 templates'],
  ['buffedrush', 'shatter', 'and the shatter squad'],
  ['shieldwall', 'glass', 'a 25% shield blunts the Glass Cannons'],
  ['bigFriends', 'bombard', 'a Huge Tank with a medic walks through the catapults'],
  ['bigFriends', 'longbow', 'and the Max Snipers'],
  ['elemfactories', 'runners', 'ice archers and fire brutes beat plain runners'],
  ['medictent', 'mixed', 'medics on guard keep the tanks going'],
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

/** The matrices of tests/balance.test.ts (6, 13, 17 and all 37 archetypes), restricted to `keys`. */
export function testMatrices(keys: string[]): MatrixDef[] {
  const six = ARCHETYPES.map((a) => a.key);
  const m85 = [...six, ...BUILDING_ARCHETYPES.map((a) => a.key)];
  const m86 = [...m85, ...KIND_ARCHETYPES.map((a) => a.key)];
  const all = ALL_ARCHETYPES.map((a) => a.key);
  const have = new Set(keys);
  const defs: MatrixDef[] = [
    { name: '6', keys: six, caps: {}, losingMatchup: false },
    { name: '13', keys: m85, caps: {}, losingMatchup: true },
    { name: '17', keys: m86, caps: capsOf(KIND_DOMINANCE_EXCEPTIONS), losingMatchup: true },
    { name: 'full', keys: all, caps: capsOf(FULL_DOMINANCE_EXCEPTIONS), losingMatchup: true },
  ];
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
  // Shape checks (tests/balance.test.ts, the round-robin describe).
  cell('bricks', 'tanks', 'beats', 'shape: bricks beat tanks');
  cell('turtle', 'templates', 'beats', 'shape: turtle beats templates');
  cell('scouts', 'snipers', 'beats', 'shape: scouts beat snipers');
  cell('tanks', 'turtle', 'notBeats', "shape: tanks don't beat the turtle");
  cell('snipers', 'bricks', 'beats', 'shape: snipers beat bricks');
  for (const melee of ['tanks', 'bricks', 'scouts']) cell('fortress', melee, 'beats', `shape: fortress beats ${melee}`);
  for (const breaker of ['turtle', 'snipers', 'swarm', 'bunker']) cell('fortress', breaker, 'losesMore', `shape: fortress loses to ${breaker}`);
  cell('swarm', 'turtle', 'beats', 'shape: swarm beats turtle');
  cell('swarm', 'bunker', 'beats', 'shape: swarm beats bunker');
  cell('tanks', 'swarm', 'beats', 'shape: tanks beat swarm');
  cell('wallrush', 'templates', 'beats', 'shape: wallrush beats templates');
  cell('brutes', 'fortress', { winFrac: 0.75 }, 'shape: brutes beat fortress ≥ 3 in 4');
  for (const walled of ['turtle', 'fortress', 'snipewall']) cell('archers', walled, 'beats', `shape: archers beat ${walled}`);
  cell('homeguard', 'bunker', 'beats', 'shape: homeguard beats bunker');
  for (const [a, b, why] of STATED) cell(a, b, 'winsMost', `stated: ${a} > ${b} (${why})`, true);
  if (have.has('storm') && have.has('scoutsFilled') && have.has('runners')) {
    rules.push({
      kind: 'cells',
      checks: [
        { a: 'storm', b: 'scoutsFilled', pred: 'winsMost' },
        { a: 'storm', b: 'runners', pred: 'winsMost' },
      ],
      all: false,
      label: 'stated: storm > scoutsFilled or runners (lightning is anti-swarm)',
      stated: true,
    });
  }
  return { matrices, rules };
}
