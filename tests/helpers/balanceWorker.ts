// One worker of helpers/balancePool.ts: reads JSON lines on stdin, the first
// { configPatch, runner }, then { id, job } per duel; plays each duel with
// `playJob` and answers { id, rec } (or { id, error }) on stdout. Started
// under tsx with --conditions=source, so it runs the workspace sources like
// the tests. It exits when stdin closes.

import { createInterface } from 'node:readline';
import type { GameConfig } from '@pixel-clash/shared';
import { balanceConfig, playJob, type BattleJob } from './balance.js';
import type { BalanceRunnerKind } from './brainUnits.js';

let config: GameConfig | undefined;
let runner: BalanceRunnerKind = 'lean';
// One duel at a time, in arrival order.
let chain = Promise.resolve();

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line) return;
  const msg = JSON.parse(line) as { configPatch?: unknown; runner?: BalanceRunnerKind; id?: number; job?: BattleJob };
  if (msg.id === undefined) {
    config = balanceConfig(msg.configPatch);
    runner = msg.runner ?? 'lean';
    return;
  }
  const { id, job } = msg as { id: number; job: BattleJob };
  chain = chain.then(async () => {
    try {
      const rec = await playJob(job, config, runner);
      process.stdout.write(`${JSON.stringify({ id, rec })}\n`);
    } catch (err) {
      process.stdout.write(`${JSON.stringify({ id, error: err instanceof Error ? (err.stack ?? err.message) : String(err) })}\n`);
    }
  });
});
