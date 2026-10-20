// `npm run test:perf`: the wall-clock-sensitive test files (TIMING_FILES in
// vitest.config.ts) on their own, one file at a time, so nothing else competes
// for CPU. Cross-platform replacement for `PIXEL_CLASH_PERF=1 vitest run`.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const vitestCli = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const child = spawn(process.execPath, [vitestCli, 'run', '--no-file-parallelism', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, PIXEL_CLASH_PERF: '1' },
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
