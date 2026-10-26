// The isolated-vm runner (the default sandbox mode).
//
// One isolate per player per battle. Each isolate lives in
// its own small child process (ivmChild.ts) rather than in the server process:
// V8 can abort the whole process on some out-of-memory patterns that
// isolated-vm's memoryLimit does not catch (see ivmCore.ts). In a child, that
// only kills the child, and the runner reports the player's sandbox as
// 'crashed'. The child starts with `--no-node-snapshot` and an EMPTY env, so it
// inherits no secrets (ADMIN_PASSWORD…).
//
// `inline: true` runs the isolate in this process instead (faster startup,
// no IPC). Only for trusted code: benchmarks and template-only tests.

import { fork, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ChildReply, ChildRequest } from './ivmChild.js';
import { IvmSession } from './ivmCore.js';
import type { PlayerRunner, RunnerFactory, RunnerLimits, RunnerPlayer, RunnerUnitDesign } from './runner.js';
import {
  DEFAULT_DEADLINE_SLACK_MS,
  HOST_BACKSTOP_MS,
  SessionPlayerRunner,
  capMessage,
  deadlineDetail,
  type CallOptions,
  type CallOutcome,
  type HarnessFn,
  type SandboxSession,
  type SessionOpener,
  type SessionOptions,
} from './session.js';

export interface IvmOptions {
  /** Run the isolate in this process (trusted code only). Default false. */
  inline?: boolean;
}

/** How long a child may take to start and install the harness. */
const OPEN_TIMEOUT_MS = 15_000;
const STDERR_TAIL = 2000;

/** The child entry: the .ts source under tsx (tests/dev), the built .js otherwise. */
function childEntry(): { file: string; execArgv: string[] } {
  const here = import.meta.url;
  if (here.endsWith('.ts')) {
    const tsx = createRequire(here).resolve('tsx');
    return {
      file: fileURLToPath(new URL('./ivmChild.ts', here)),
      execArgv: ['--no-node-snapshot', '--import', pathToFileURL(tsx).href],
    };
  }
  return { file: fileURLToPath(new URL('./ivmChild.js', here)), execArgv: ['--no-node-snapshot'] };
}

type Pending = { resolve: (o: CallOutcome) => void; timer: NodeJS.Timeout };

/** An IvmSession running in a child process. */
export class ChildIvmSession implements SandboxSession {
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private crashedDetail: string | undefined;
  private stderrTail = '';

  private constructor(private readonly child: ChildProcess) {
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL);
    });
    child.on('message', (msg: ChildReply) => {
      if (msg.type !== 'result') return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      const outcome = boundOutcome(msg.outcome);
      if (outcome.kind === 'crashed') this.crash(outcome.detail);
      p.resolve(outcome);
    });
    child.on('exit', (code, signal) => this.crash(this.describeExit(code, signal)));
    child.on('error', (err) => this.crash(`sandbox process error: ${err.message}`));
    // Never keep the server (or a test run) alive just because a sandbox exists;
    // pending calls hold their own timers.
    child.unref();
    (child.channel as { unref?: () => void } | undefined)?.unref?.();
  }

  static open(opts: SessionOptions): Promise<ChildIvmSession> {
    const { file, execArgv } = childEntry();
    const child = fork(file, [], {
      execArgv,
      env: {},
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      serialization: 'advanced',
    });
    const session = new ChildIvmSession(child);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.dispose();
        reject(new Error(`sandbox process did not start within ${OPEN_TIMEOUT_MS} ms`));
      }, OPEN_TIMEOUT_MS);
      const onMessage = (msg: ChildReply) => {
        if (msg.type === 'opened') {
          done();
          resolve(session);
        } else if (msg.type === 'open-failed') {
          done();
          session.dispose();
          reject(new Error(`sandbox failed to start: ${capMessage(msg.message)}`));
        }
      };
      const onExit = () => {
        done();
        reject(new Error(`sandbox process exited during start: ${session.crashedDetail ?? 'unknown'}`));
      };
      const done = () => {
        clearTimeout(timer);
        child.off('message', onMessage);
        child.off('exit', onExit);
      };
      child.on('message', onMessage);
      child.once('exit', onExit);
      child.send({ type: 'open', opts } satisfies ChildRequest);
    });
  }

  get disposed(): boolean {
    return this.crashedDetail !== undefined;
  }

  /** The child process id (tests use it to pause the child). */
  get pid(): number | undefined {
    return this.child.pid;
  }

  load(unitId: string, filename: string, compiledJs: string, timeoutMs: number, opts: CallOptions = {}): Promise<CallOutcome> {
    const deadlineMs = opts.deadlineMs ?? timeoutMs + DEFAULT_DEADLINE_SLACK_MS;
    return this.request((id) => ({ type: 'load', id, unitId, filename, compiledJs, timeoutMs, opts: { ...opts, deadlineMs } }), deadlineMs);
  }

  call(fn: HarnessFn, args: readonly string[], timeoutMs: number, opts: CallOptions = {}): Promise<CallOutcome> {
    const deadlineMs = opts.deadlineMs ?? timeoutMs + DEFAULT_DEADLINE_SLACK_MS;
    return this.request((id) => ({ type: 'call', id, fn, args: [...args], timeoutMs, opts: { ...opts, deadlineMs } }), deadlineMs);
  }

  /**
   * Send a request. The child enforces `deadlineMs` itself; the host only
   * kills the child when nothing came back long after that (a hung child).
   */
  private request(build: (id: number) => ChildRequest, deadlineMs: number): Promise<CallOutcome> {
    if (this.crashedDetail !== undefined) return Promise.resolve({ kind: 'crashed', detail: this.crashedDetail });
    const id = this.nextId++;
    return new Promise<CallOutcome>((resolve) => {
      const timer = setTimeout(() => {
        // A reply may already be waiting in the poll phase (the event loop was
        // busy): look again after it before giving up on the child.
        setImmediate(() => {
          if (this.pending.has(id)) this.crash(deadlineDetail(deadlineMs + HOST_BACKSTOP_MS));
        });
      }, deadlineMs + HOST_BACKSTOP_MS);
      this.pending.set(id, { resolve, timer });
      try {
        this.child.send(build(id));
      } catch (err) {
        this.crash(`could not reach the sandbox process: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  private describeExit(code: number | null, signal: NodeJS.Signals | null): string {
    const tail = this.stderrTail;
    if (/out of memory|heap limit|allocation failed|invalid table size|CALL_AND_RETRY_LAST/i.test(tail)) {
      return 'ran out of memory';
    }
    if (signal) return `sandbox process killed (${signal})`;
    return `sandbox process exited (code ${String(code)})`;
  }

  /** Mark the session dead, kill the child and fail every pending call. */
  private crash(detail: string): void {
    this.crashedDetail ??= detail;
    if (this.child.exitCode === null && this.child.signalCode === null) {
      try {
        this.child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.resolve({ kind: 'crashed', detail: this.crashedDetail });
    }
  }

  dispose(): void {
    this.crash('sandbox disposed');
  }
}

/** Cap every string that came out of the child (defence in depth). */
function boundOutcome(o: CallOutcome): CallOutcome {
  switch (o.kind) {
    case 'error':
      return { ...o, message: capMessage(o.message) };
    case 'crashed':
      return { ...o, detail: capMessage(o.detail) };
    default:
      return o;
  }
}

/** Open an isolated-vm session (child process by default). */
export function ivmSessionOpener(options: IvmOptions = {}): SessionOpener {
  return options.inline ? (opts) => IvmSession.open(opts) : (opts) => ChildIvmSession.open(opts);
}

/** The default RunnerFactory (mode 'ivm'). */
export function createIvmRunnerFactory(options: IvmOptions = {}): RunnerFactory {
  const open = ivmSessionOpener(options);
  return {
    mode: 'ivm',
    create(player: RunnerPlayer, units: readonly RunnerUnitDesign[], limits: RunnerLimits): Promise<PlayerRunner> {
      return SessionPlayerRunner.create(open, player, units, limits);
    },
  };
}
