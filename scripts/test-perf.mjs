// `npm run test:perf`: the wall-clock-sensitive test files (TIMING_FILES in
// vitest.config.ts) on their own, one file at a time, so nothing else competes
// for CPU; then the balance round robin (BALANCE_FILES), whose worker
// processes would otherwise steal the timing files' CPU. Cross-platform
// replacement for `PIXEL_CLASH_PERF=1 vitest run` + `PIXEL_CLASH_PERF=balance vitest run`.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const vitestCli = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const args = process.argv.slice(2);
// A file filter may match only one of the two passes.
const extra = args.length > 0 ? ['--passWithNoTests'] : [];

function pass(perf) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [vitestCli, 'run', '--no-file-parallelism', ...extra, ...args], {
      stdio: 'inherit',
      env: { ...process.env, PIXEL_CLASH_PERF: perf },
    });
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

const timing = await pass('1');
const balance = await pass('balance');
process.exit(timing || balance);
