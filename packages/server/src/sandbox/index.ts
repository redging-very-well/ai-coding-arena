// Sandbox entry point: pick the RunnerFactory for `config.sandbox.mode` (§8).

import type { SandboxMode } from '@pixel-clash/shared';
import { createInprocRunnerFactory } from './inprocRunner.js';
import { createIvmRunnerFactory } from './ivmRunner.js';
import type { RunnerFactory } from './runner.js';

export * from './runner.js';
export { createIvmRunnerFactory, ivmSessionOpener, type IvmOptions } from './ivmRunner.js';
export { createInprocRunnerFactory, vmSessionOpener } from './inprocRunner.js';
export { StrikeTracker, napMessage, timedOutOnceMessage, type StrikeEvent, type StrikeLimits } from './strikes.js';
export { parseTickOutput, type SandboxSession, type SessionOpener } from './session.js';
export { createSplitRunner, needsSplit } from './splitRunner.js';

/**
 * The factory for a sandbox mode. 'inproc-unsafe' needs `unsafe: true` (the
 * server passes it only with `--unsafe`). 'process' is the §8 fallback, which
 * is not built because isolated-vm passed the M0 check.
 */
export function createRunnerFactory(mode: SandboxMode, opts: { unsafe?: boolean } = {}): RunnerFactory {
  switch (mode) {
    case 'ivm':
      return createIvmRunnerFactory();
    case 'inproc-unsafe':
      return createInprocRunnerFactory({ unsafe: opts.unsafe === true });
    case 'process':
      throw new Error("sandbox mode 'process' is not built (isolated-vm passed the M0 check); use 'ivm'.");
  }
}
