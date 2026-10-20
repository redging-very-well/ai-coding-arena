// IvmSession: one isolated-vm isolate with the harness installed, in THIS
// process.
//
// WARNING: V8 is not resilient to out-of-memory conditions. Some allocation
// patterns (e.g. `new Array(5e8).fill(0)`, a Map or object growing in an
// endless loop) make V8 abort the WHOLE process instead of disposing the
// isolate, despite `memoryLimit`. The isolated-vm README says the same. So the
// server never runs kid code through this class directly: ivmRunner.ts runs
// each IvmSession inside its own child process (ivmChild.ts). Use the inline
// mode only for trusted code (benchmarks, tests of the templates).

import { createRequire } from 'node:module';
import type * as IVM from 'isolated-vm';
import { HARNESS_GLOBALS, HARNESS_SOURCE, wrapUnit, type HarnessApiFn } from './harness.js';
import {
  capMessage,
  deadlineDetail,
  type CallOptions,
  type CallOutcome,
  type HarnessFn,
  type SandboxSession,
  type SessionOptions,
} from './session.js';

type IvmModule = typeof IVM;
let ivmModule: IvmModule | undefined;

/** Load isolated-vm lazily (it needs `node --no-node-snapshot`). */
export function loadIvm(): IvmModule {
  ivmModule ??= createRequire(import.meta.url)('isolated-vm') as IvmModule;
  return ivmModule;
}

const TIMEOUT_RE = /timed out/i;
const SETUP_TIMEOUT_MS = 1000;
/** Timeout for the harness reset() after a timed-out call (pure harness code). */
const RESET_TIMEOUT_MS = 50;
/**
 * A call still pending this long after its deadline is killed even if it used
 * little CPU (e.g. blocked). Below HOST_BACKSTOP_MS, so the child answers
 * before the server gives up on the whole process.
 */
export const STUCK_WALL_CAP_MS = 250;

type FnRef = IVM.Reference<(...args: unknown[]) => unknown>;
const API_FNS: readonly HarnessApiFn[] = ['reset', 'load', 'seal', 'spawn', 'stats', 'sprite', 'tick'];

export class IvmSession implements SandboxSession {
  private crashedDetail: string | undefined;
  private catastrophic = false;

  private constructor(
    private readonly isolate: IVM.Isolate,
    private readonly context: IVM.Context,
    private readonly refs: Record<HarnessApiFn, FnRef>,
  ) {}

  /**
   * Create an isolate, install the harness and take References to the API
   * object `setup` returns, BEFORE any kid code is evaluated (§8 hardening
   * rules). The API is never published on globalThis, so kid code can't call it.
   * `onCatastrophicError` is called if V8 loses control of the isolate.
   */
  static async open(opts: SessionOptions, onCatastrophicError?: (message: string) => void): Promise<IvmSession> {
    const ivm = loadIvm();
    let session: IvmSession | undefined;
    const isolate = new ivm.Isolate({
      memoryLimit: opts.memoryLimitMb,
      onCatastrophicError: (message: string) => {
        if (session) session.catastrophic = true;
        onCatastrophicError?.(message);
      },
    });
    try {
      const context = await isolate.createContext();
      const setupScript = await isolate.compileScript(HARNESS_SOURCE, { filename: 'harness.js' });
      const setup = (await setupScript.run(context, { reference: true, timeout: SETUP_TIMEOUT_MS })) as IVM.Reference<
        (seed: number) => unknown
      >;
      const api = (await setup.apply(undefined, [opts.seed >>> 0], {
        timeout: SETUP_TIMEOUT_MS,
        result: { reference: true },
      })) as IVM.Reference<Record<HarnessApiFn, unknown>>;
      const refs = {} as Record<HarnessApiFn, FnRef>;
      for (const fn of API_FNS) refs[fn] = api.getSync(fn, { reference: true }) as FnRef;
      api.release();
      setup.release();
      setupScript.release();
      session = new IvmSession(isolate, context, refs);
      return session;
    } catch (err) {
      if (!isolate.isDisposed) isolate.dispose();
      throw err;
    }
  }

  get disposed(): boolean {
    return this.crashedDetail !== undefined || this.isolate.isDisposed;
  }

  async load(unitId: string, filename: string, compiledJs: string, timeoutMs: number, opts: CallOptions = {}): Promise<CallOutcome> {
    if (this.disposed) return { kind: 'crashed', detail: this.crashedDetail ?? 'sandbox disposed' };
    let fn: IVM.Reference<unknown>;
    try {
      // Evaluating the wrapper only creates the function; no kid code runs yet.
      const script = await this.isolate.compileScript(wrapUnit(compiledJs), { filename });
      fn = (await script.run(this.context, { reference: true, timeout: timeoutMs })) as IVM.Reference<unknown>;
      script.release();
    } catch (err) {
      return this.failure(err, 0, opts);
    }
    try {
      return await this.invoke(this.refs.load, [unitId, fn.derefInto()], timeoutMs, opts);
    } finally {
      if (!this.disposed) fn.release();
    }
  }

  call(fn: HarnessFn, args: readonly string[], timeoutMs: number, opts: CallOptions = {}): Promise<CallOutcome> {
    if (this.disposed) return Promise.resolve({ kind: 'crashed', detail: this.crashedDetail ?? 'sandbox disposed' });
    return this.invoke(this.refs[fn], [...args], timeoutMs, opts);
  }

  private async invoke(
    ref: IVM.Reference<(...args: unknown[]) => unknown>,
    args: unknown[],
    timeoutMs: number,
    opts: CallOptions,
  ): Promise<CallOutcome> {
    const start = performance.now();
    const call = ref.apply(undefined, args as never[], { timeout: timeoutMs }).then(
      (value): CallOutcome =>
        typeof value === 'string'
          ? { kind: 'ok', value, elapsedMs: performance.now() - start }
          : { kind: 'error', message: 'harness returned a non-string', elapsedMs: performance.now() - start },
      (err: unknown) => this.failure(err, performance.now() - start, opts),
    );
    if (opts.deadlineMs === undefined) return call;
    return this.withDeadline(call, opts.deadlineMs, start);
  }

  /**
   * Backstop for a call the isolated-vm `timeout` did not stop (a microtask
   * loop, a huge allocation): kill the isolate once it is really stuck.
   *
   * "Stuck" is judged by CPU time, not only by the wall clock. If this process
   * is simply not scheduled for a while (a busy laptop, VM preemption, a GC
   * pause), the deadline timer and the finished call become ready together,
   * and libuv runs expired timers BEFORE it polls for the result. Killing then
   * would disable a healthy player's whole army. So when the timer fires:
   *   1. wait one more turn of the event loop (setImmediate, after the poll
   *      phase) and let a reply that is already waiting win;
   *   2. kill only if this process has burned `deadlineMs` of CPU since the
   *      call started (the isolate really is spinning), or if the call is
   *      still pending STUCK_WALL_CAP_MS after its deadline whatever the CPU.
   * Otherwise check again later. In a child sandbox process (the default) the
   * isolate is the only thing using CPU, so process CPU is the isolate's.
   */
  private async withDeadline(call: Promise<CallOutcome>, deadlineMs: number, start: number): Promise<CallOutcome> {
    let settled = false;
    void call.then(() => {
      settled = true;
    });
    const cpu0 = process.cpuUsage();
    let timer: NodeJS.Timeout | undefined;
    let immediate: NodeJS.Immediate | undefined;
    const deadline = new Promise<CallOutcome>((resolve) => {
      const check = () => {
        immediate = setImmediate(() => {
          immediate = undefined;
          if (settled) return;
          const cpu = process.cpuUsage(cpu0);
          const cpuMs = (cpu.user + cpu.system) / 1000;
          const waitedMs = performance.now() - start;
          if (cpuMs >= deadlineMs || waitedMs >= deadlineMs + STUCK_WALL_CAP_MS) {
            const detail = deadlineDetail(Math.round(waitedMs));
            this.kill(detail);
            resolve({ kind: 'crashed', detail });
            return;
          }
          // Not scheduled, not stuck: look again when the CPU budget could be used up.
          const nextMs = Math.min(Math.max(1, deadlineMs - cpuMs), deadlineMs + STUCK_WALL_CAP_MS - waitedMs);
          timer = setTimeout(check, Math.max(1, nextMs));
        });
      };
      timer = setTimeout(check, deadlineMs);
    });
    try {
      return await Promise.race([call, deadline]);
    } finally {
      clearTimeout(timer);
      if (immediate) clearImmediate(immediate);
    }
  }

  private failure(err: unknown, elapsedMs: number, opts: CallOptions): CallOutcome {
    // Never pass an unbounded string on (a kid can throw a 12 MB message).
    const message = capMessage(err instanceof Error ? err.message : String(err));
    if (this.catastrophic || this.isolate.isDisposed) {
      this.kill(message);
      return { kind: 'crashed', detail: this.crashedDetail ?? message };
    }
    if (TIMEOUT_RE.test(message)) {
      const culprit = opts.probeCulpritMs !== undefined ? this.probeCulprit(opts.probeCulpritMs) : undefined;
      this.resetHarness();
      return { kind: 'timeout', elapsedMs, ...(culprit ? { culprit } : {}) };
    }
    return { kind: 'error', message, elapsedMs };
  }

  /** A timeout terminated the harness mid-call; clear its running state. */
  private resetHarness(): void {
    try {
      this.refs.reset.applySync(undefined, [], { timeout: RESET_TIMEOUT_MS });
    } catch {
      /* the next call reports the problem */
    }
  }

  /** Read `__current` with a separate short call (§8). */
  private probeCulprit(timeoutMs: number): string | undefined {
    try {
      const v = this.isolate.compileScriptSync(HARNESS_GLOBALS.current).runSync(this.context, { timeout: timeoutMs });
      return typeof v === 'string' && v ? v : undefined;
    } catch {
      return undefined;
    }
  }

  private kill(detail: string): void {
    this.crashedDetail ??= detail;
    if (!this.isolate.isDisposed) {
      try {
        this.isolate.dispose();
      } catch {
        /* already gone */
      }
    }
  }

  dispose(): void {
    this.kill('sandbox disposed');
  }
}
