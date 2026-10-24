// A pool of balance worker processes (helpers/balanceWorker.ts under tsx):
// each worker plays duels one at a time; the pool hands the next job to
// whichever worker is free (long battles don't hold up a whole shard) and
// keeps the workers alive across `run` calls, so the rounds of an early-
// stopping run (scripts/balance.ts) pay the tsx start-up once.
//
// Protocol: JSON lines. The first line to a worker is { configPatch, runner };
// then { id, job } per duel, answered by { id, rec } (or { id, error }).

import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { BattleJob, BattleRecord } from './balance.js';
import type { BalanceRunnerKind } from './brainUnits.js';

/** Jobs in flight per worker (one queued behind the running one hides the round trip). */
const IN_FLIGHT = 2;

interface Worker {
  child: ChildProcess;
  busy: number;
  stderr: string;
}

export class BalancePool {
  private readonly workers: Worker[] = [];
  private readonly waiting = new Map<number, { resolve: (r: BattleRecord) => void; reject: (e: Error) => void; worker: Worker }>();
  private nextId = 1;
  private queue: Array<{ id: number; job: BattleJob }> = [];
  private failure: Error | undefined;

  constructor(
    readonly size: number,
    configPatch?: unknown,
    runner: BalanceRunnerKind = 'lean',
  ) {
    const require = createRequire(import.meta.url);
    const tsxCli = join(dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');
    const entry = fileURLToPath(new URL('./balanceWorker.ts', import.meta.url));
    for (let n = 0; n < size; n++) {
      const child = spawn(process.execPath, ['--no-node-snapshot', tsxCli, '--conditions=source', entry], { stdio: ['pipe', 'pipe', 'pipe'] });
      const w: Worker = { child, busy: 0, stderr: '' };
      child.stderr!.on('data', (d: Buffer) => (w.stderr = (w.stderr + d.toString()).slice(-4000)));
      createInterface({ input: child.stdout! }).on('line', (line) => this.reply(w, line));
      child.on('exit', (code) => {
        if (code !== 0 && code !== null) this.fail(new Error(`balance worker exited ${code}: ${w.stderr}`));
        else if (code === null && !this.closed) this.fail(new Error(`balance worker killed: ${w.stderr}`));
      });
      child.on('error', (err) => this.fail(err));
      child.stdin!.write(`${JSON.stringify({ configPatch, runner })}\n`);
      this.workers.push(w);
    }
  }

  private closed = false;

  private reply(w: Worker, line: string): void {
    const msg = JSON.parse(line) as { id: number; rec?: BattleRecord; error?: string };
    const p = this.waiting.get(msg.id);
    if (!p) return;
    this.waiting.delete(msg.id);
    w.busy--;
    if (msg.error !== undefined) p.reject(new Error(msg.error));
    else p.resolve(msg.rec!);
    this.pump();
  }

  private fail(err: Error): void {
    this.failure ??= err;
    for (const p of this.waiting.values()) p.reject(err);
    this.waiting.clear();
  }

  private pump(): void {
    for (const w of this.workers) {
      while (w.busy < IN_FLIGHT && this.queue.length > 0) {
        const next = this.queue.shift()!;
        w.busy++;
        const entry = this.waiting.get(next.id)!;
        entry.worker = w;
        w.child.stdin!.write(`${JSON.stringify(next)}\n`);
      }
    }
  }

  /** Play the jobs; records come back in job order. */
  async run(jobs: BattleJob[], onProgress?: (done: number, total: number) => void): Promise<BattleRecord[]> {
    if (this.failure) throw this.failure;
    let done = 0;
    const promises = jobs.map((job) => {
      const id = this.nextId++;
      this.queue.push({ id, job });
      return new Promise<BattleRecord>((resolve, reject) => {
        this.waiting.set(id, {
          resolve: (r) => {
            done++;
            if (onProgress && (done % 50 === 0 || done === jobs.length)) onProgress(done, jobs.length);
            resolve(r);
          },
          reject,
          worker: this.workers[0]!,
        });
      });
    });
    this.pump();
    return Promise.all(promises);
  }

  close(): void {
    this.closed = true;
    for (const w of this.workers) w.child.stdin!.end();
  }
}
