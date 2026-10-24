// One worker of helpers/balance.ts `playPairs` (M8.8): reads
// {pairs, seeds, configPatch} as JSON on stdin, plays every pair with
// `playPair` and writes the PairResult[] as JSON on stdout. Started under tsx
// with --conditions=source, so it runs the workspace sources like the tests.

import { archetypeByKey, balanceConfig, playPair, type PairResult } from './balance.js';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d: string) => (input += d));
process.stdin.on('end', () => {
  void (async () => {
    const job = JSON.parse(input) as { pairs: Array<[string, string]>; seeds: number[]; configPatch?: unknown };
    const config = balanceConfig(job.configPatch);
    const out: PairResult[] = [];
    for (const [a, b] of job.pairs) out.push(await playPair(archetypeByKey(a), archetypeByKey(b), job.seeds, config));
    process.stdout.write(JSON.stringify(out));
  })().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
});
