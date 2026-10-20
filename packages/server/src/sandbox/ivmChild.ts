// Child-process entry that hosts ONE IvmSession (isolated-vm isolate).
//
// Started by ivmRunner.ts with `--no-node-snapshot` and an empty env. If V8
// runs out of memory in a way isolated-vm can't recover from, only this
// process dies; the server sees the exit and reports the sandbox as crashed.
//
// Protocol (IPC, structured clone):
//   host -> child  { type: 'open', opts }                         -> { type: 'opened' } | { type: 'open-failed', message }
//   host -> child  { type: 'load', id, unitId, filename, compiledJs, timeoutMs, opts }
//   host -> child  { type: 'call', id, fn, args, timeoutMs, opts } -> { type: 'result', id, outcome }

import { writeSync } from 'node:fs';
import { IvmSession } from './ivmCore.js';
import type { CallOptions, CallOutcome, HarnessFn, SessionOptions } from './session.js';

export type ChildRequest =
  | { type: 'open'; opts: SessionOptions }
  | { type: 'load'; id: number; unitId: string; filename: string; compiledJs: string; timeoutMs: number; opts: CallOptions }
  | { type: 'call'; id: number; fn: HarnessFn; args: string[]; timeoutMs: number; opts: CallOptions };

export type ChildReply =
  | { type: 'opened' }
  | { type: 'open-failed'; message: string }
  | { type: 'result'; id: number; outcome: CallOutcome };

let session: IvmSession | undefined;

function send(msg: ChildReply): void {
  process.send?.(msg);
}

function die(message: string): never {
  // stderr writes are synchronous for pipes on Linux; writeSync makes sure.
  try {
    writeSync(2, `pixel-clash sandbox fatal: ${message}\n`);
  } catch {
    /* ignore */
  }
  process.kill(process.pid, 'SIGKILL');
  throw new Error('unreachable');
}

process.on('message', (raw: ChildRequest) => {
  void (async () => {
    switch (raw.type) {
      case 'open':
        try {
          session = await IvmSession.open(raw.opts, (m) => die(`out of memory (catastrophic: ${m})`));
          send({ type: 'opened' });
        } catch (err) {
          send({ type: 'open-failed', message: err instanceof Error ? err.message : String(err) });
        }
        return;
      case 'load':
      case 'call': {
        if (!session) {
          send({ type: 'result', id: raw.id, outcome: { kind: 'crashed', detail: 'session not open' } });
          return;
        }
        // The call's deadline is enforced HERE, next to the isolate: this
        // process's event loop only waits for isolated-vm, so its timer is
        // reliable. (The server keeps a generous backstop for a hung child.)
        const opts = raw.opts;
        const outcome =
          raw.type === 'load'
            ? await session.load(raw.unitId, raw.filename, raw.compiledJs, raw.timeoutMs, opts)
            : await session.call(raw.fn, raw.args, raw.timeoutMs, opts);
        send({ type: 'result', id: raw.id, outcome });
        // A crashed isolate is useless: exit so the host sees it.
        if (outcome.kind === 'crashed') setImmediate(() => process.exit(0));
        return;
      }
    }
  })();
});

// The host went away: nothing left to do.
process.on('disconnect', () => process.exit(0));
