// The archetype brains as real unit code, for the sandbox runners (balance
// tooling, plan §14). `brainUnitSource` is the text of helpers/brains.ts (the
// very functions the lean BrainRunner calls) plus a unit class whose update()
// calls `actFor`; it goes through the validator's transpile like a player's
// unit, and the sandbox runs it with the harness's seeded Math.random as `rng`.
//
// `sandboxRunner` builds a PlayerRunner for an archetype on a real sandbox:
//   'ivm' isolated-vm in a child process per player (the server default);
//   'vm'  node:vm in this process (the 'inproc-unsafe' runner: trusted code only).
// The limits are generous (the brains are ours; a loaded test machine must not
// hand out slow strikes), so a battle is decided by the code alone.
// tests/balance-parity.test.ts checks both give the lean runner's battles bit
// for bit.

import { readFileSync } from 'node:fs';
import type { StatsSnapshot } from '@pixel-clash/shared';
import { runsCode } from '@pixel-clash/shared';
import { createInprocRunnerFactory } from '../../packages/server/src/sandbox/inprocRunner.js';
import { createIvmRunnerFactory } from '../../packages/server/src/sandbox/ivmRunner.js';
import type { PlayerRunner, RunnerLimits, RunnerPlayer } from '../../packages/server/src/sandbox/runner.js';
import { transpile } from '../../packages/server/src/validator/transpile.js';
import type { BrainOptions } from './brains.js';

/** Which runner plays the archetype brains: the lean in-process one, or a real sandbox. */
export type BalanceRunnerKind = 'lean' | 'ivm' | 'vm';

const BRAINS_SOURCE = readFileSync(new URL('./brains.ts', import.meta.url), 'utf8');

/** The unit source (TypeScript, like a player's) of an army with these brain options. */
export function brainUnitSource(opts: BrainOptions): string {
  return `${BRAINS_SOURCE}
const OPTS: BrainOptions = ${JSON.stringify(opts)};

export default class BalanceBrain {
  update(self: SelfView, enemies: OtherView[], allies: OtherView[], world: WorldView) {
    return actFor(self, enemies, allies, world, Math.random, OPTS);
  }
}
`;
}

const compiled = new Map<string, Promise<string>>();

/** The transpiled unit code (CJS, as the validator stores it), cached per brain options. */
export function brainUnitJs(opts: BrainOptions): Promise<string> {
  const key = JSON.stringify(opts);
  let js = compiled.get(key);
  if (!js) {
    js = transpile(brainUnitSource(opts)).then((r) => {
      if (!r.ok) throw new Error(`brain unit does not transpile: ${JSON.stringify(r.error)}`);
      return r.compiledJs;
    });
    compiled.set(key, js);
  }
  return js;
}

/** Generous limits: our own bot code, judged by its moves, never by a busy machine. */
export const BALANCE_SANDBOX_LIMITS: RunnerLimits = {
  memoryLimitMb: 64,
  hardTimeoutMs: 2000,
  softTimeoutMs: 2000,
  disposeGraceMs: 2000,
  culpritProbeTimeoutMs: 50,
  constructTimeoutMs: 2000,
  loadTimeoutMs: 5000,
};

/** A real sandbox runner for one player's archetype (walls run no code, §5.2). */
export async function sandboxRunner(
  kind: Exclude<BalanceRunnerKind, 'lean'>,
  player: RunnerPlayer,
  units: ReadonlyArray<{ unitId: string; stats: StatsSnapshot }>,
  opts: BrainOptions,
): Promise<PlayerRunner> {
  const compiledJs = await brainUnitJs(opts);
  const factory = kind === 'ivm' ? createIvmRunnerFactory() : createInprocRunnerFactory({ unsafe: true });
  const designs = units.filter((u) => runsCode(u.stats.type)).map((u) => ({ unitId: u.unitId, compiledJs, stats: u.stats }));
  const runner = await factory.create(player, designs, BALANCE_SANDBOX_LIMITS);
  if (runner.loadErrors.size > 0) {
    runner.dispose();
    throw new Error(`brain units failed to load: ${JSON.stringify([...runner.loadErrors])}`);
  }
  return runner;
}
