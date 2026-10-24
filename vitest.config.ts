import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// PIXEL_CLASH_PERF: '1' = the timing files, 'balance' = the balance file, unset = the rest.
const PERF = process.env.PIXEL_CLASH_PERF;
const TIMING_FILES = ['tests/integration.test.ts', 'tests/sandbox.test.ts', 'tests/buildings-perf.test.ts'];
// The balance round robin shares thousands of battles out over its own worker
// processes (helpers/balance.ts playPairs); inside the parallel main pass they
// oversubscribe the CPU and push timed tests elsewhere past their limits.
const BALANCE_FILES = ['tests/balance.test.ts'];

export default defineConfig({
  resolve: {
    // Tests always run against the TS sources of the workspace packages.
    alias: {
      '@pixel-clash/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    // Wall-clock-sensitive files (real sandbox timeouts, and the M2 acceptance
    // perf checks: 5400 ticks < 2 s, p99 < 8 ms/tick) run in their own pass
    // (`npm run test:perf`, chained after the main suite by `npm test`) so
    // parallel test files booting servers don't steal their CPU. The balance
    // file runs on its own after them, so its workers steal neither the main
    // pass's CPU nor the timing files'.
    include: PERF === '1' ? TIMING_FILES : PERF === 'balance' ? BALANCE_FILES : ['tests/**/*.test.ts'],
    exclude: PERF ? [] : [...TIMING_FILES, ...BALANCE_FILES],
    // isolated-vm requires --no-node-snapshot on Node >= 20; forks pass it on.
    pool: 'forks',
    execArgv: ['--no-node-snapshot'],
  },
});
