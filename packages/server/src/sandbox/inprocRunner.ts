// The 'inproc-unsafe' runner: node:vm in this process. FOR TESTS AND DEV ONLY.
//
// node:vm is NOT a security boundary (the Node docs say so): there is no
// memory limit, and a prototype escape reaches the host. It exists so the sim
// and validator can be exercised without the native addon. Creating the
// factory throws unless the caller passes `{ unsafe: true }` explicitly, and the
// server refuses this mode at startup unless `--unsafe` is given (§8).
//
// The harness is the same as in isolated-vm. Strings are the only values the
// host hands to the context (via the `__in` slot), so no host object (and no
// host Function constructor) is ever reachable from player code through us.
//
// The harness API object returned by `setup` is bound to a top-level `const`
// with a random name. Later scripts in the same context can use it (scripts
// share the global lexical scope), but it is not a property of globalThis, so
// player code can't find it.

import { randomBytes } from 'node:crypto';
import vm from 'node:vm';
import { HARNESS_GLOBALS, HARNESS_SOURCE, wrapUnit } from './harness.js';
import type { PlayerRunner, RunnerFactory, RunnerLimits, RunnerPlayer, RunnerUnitDesign } from './runner.js';
import {
  SessionPlayerRunner,
  type CallOptions,
  type CallOutcome,
  type HarnessFn,
  type SandboxSession,
  type SessionOpener,
  type SessionOptions,
  capMessage,
} from './session.js';

const TIMEOUT_CODE = 'ERR_SCRIPT_EXECUTION_TIMEOUT';

function isTimeout(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === TIMEOUT_CODE || /timed out/i.test(String(err));
}

export class VmSession implements SandboxSession {
  private closed = false;
  private readonly tickScript: vm.Script;
  private readonly probeScript = new vm.Script(HARNESS_GLOBALS.current);
  private readonly resetScript: vm.Script;

  private constructor(
    private readonly context: vm.Context,
    /** Name of the context-lexical binding that holds the harness API. */
    private readonly api: string,
  ) {
    this.tickScript = new vm.Script(`${api}.tick(${HARNESS_GLOBALS.input})`);
    this.resetScript = new vm.Script(`${api}.reset()`);
  }

  static open(opts: SessionOptions): Promise<VmSession> {
    // 'afterEvaluate' runs microtasks inside each call, under its timeout.
    const context = vm.createContext({}, { microtaskMode: 'afterEvaluate', codeGeneration: { strings: true, wasm: false } });
    const api = `__api_${randomBytes(16).toString('hex')}`;
    // Runs no player code: evaluate setup, call it, keep its API in a lexical binding.
    vm.runInContext(`const ${api} = (${HARNESS_SOURCE})(${opts.seed >>> 0});`, context, { filename: 'harness.js', timeout: 1000 });
    return Promise.resolve(new VmSession(context, api));
  }

  get disposed(): boolean {
    return this.closed;
  }

  private run(script: vm.Script, timeoutMs: number, opts: CallOptions): CallOutcome {
    if (this.closed) return { kind: 'crashed', detail: 'sandbox disposed' };
    const start = performance.now();
    try {
      const value: unknown = script.runInContext(this.context, { timeout: timeoutMs });
      const elapsedMs = performance.now() - start;
      return typeof value === 'string'
        ? { kind: 'ok', value, elapsedMs }
        : { kind: 'error', message: 'harness returned a non-string', elapsedMs };
    } catch (err) {
      const elapsedMs = performance.now() - start;
      if (isTimeout(err)) {
        const culprit = opts.probeCulpritMs !== undefined ? this.probe(opts.probeCulpritMs) : undefined;
        this.reset();
        return { kind: 'timeout', elapsedMs, ...(culprit ? { culprit } : {}) };
      }
      return { kind: 'error', message: capMessage(err instanceof Error ? err.message : String(err)), elapsedMs };
    } finally {
      this.setInput('');
    }
  }

  private probe(timeoutMs: number): string | undefined {
    try {
      const v: unknown = this.probeScript.runInContext(this.context, { timeout: timeoutMs });
      return typeof v === 'string' && v ? v : undefined;
    } catch {
      return undefined;
    }
  }

  /** Clear the harness's running state after a timeout terminated a call. */
  private reset(): void {
    try {
      this.resetScript.runInContext(this.context, { timeout: 50 });
    } catch {
      /* the next call reports the problem */
    }
  }

  /** Write the `__in` slot (a non-configurable data property, so never a player setter). */
  private setInput(value: unknown): void {
    (this.context as Record<string, unknown>)[HARNESS_GLOBALS.input] = value;
  }

  load(unitId: string, filename: string, compiledJs: string, timeoutMs: number, opts: CallOptions = {}): Promise<CallOutcome> {
    if (this.closed) return Promise.resolve({ kind: 'crashed', detail: 'sandbox disposed' });
    let fn: unknown;
    try {
      fn = new vm.Script(wrapUnit(compiledJs), { filename }).runInContext(this.context, { timeout: timeoutMs });
    } catch (err) {
      return Promise.resolve({ kind: 'error', message: capMessage(err instanceof Error ? err.message : String(err)), elapsedMs: 0 });
    }
    // fn belongs to the context realm, so handing it back in is safe.
    this.setInput(fn);
    const script = new vm.Script(`${this.api}.load(${JSON.stringify(unitId)}, ${HARNESS_GLOBALS.input})`);
    return Promise.resolve(this.run(script, timeoutMs, opts));
  }

  call(fn: HarnessFn, args: readonly string[], timeoutMs: number, opts: CallOptions = {}): Promise<CallOutcome> {
    if (fn === 'tick') {
      this.setInput(args[0] ?? '');
      return Promise.resolve(this.run(this.tickScript, timeoutMs, opts));
    }
    // seal/spawn/stats are rare: inline the (string) arguments as JSON literals.
    const script = new vm.Script(`${this.api}.${fn}(${args.map((a) => JSON.stringify(a)).join(', ')})`);
    return Promise.resolve(this.run(script, timeoutMs, opts));
  }

  dispose(): void {
    this.closed = true;
  }
}

export const vmSessionOpener: SessionOpener = (opts) => VmSession.open(opts);

/** The 'inproc-unsafe' RunnerFactory. Throws unless `unsafe: true` is passed. */
export function createInprocRunnerFactory(options: { unsafe: boolean }): RunnerFactory {
  if (options.unsafe !== true) {
    throw new Error("The 'inproc-unsafe' sandbox (node:vm) is not a security boundary; pass { unsafe: true } (tests/dev only).");
  }
  return {
    mode: 'inproc-unsafe',
    create(player: RunnerPlayer, units: readonly RunnerUnitDesign[], limits: RunnerLimits): Promise<PlayerRunner> {
      return SessionPlayerRunner.create(vmSessionOpener, player, units, limits);
    },
  };
}
