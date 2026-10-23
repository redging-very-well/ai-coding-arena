import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const PERF = process.env.PIXEL_CLASH_PERF === '1';
const TIMING_FILES = ['tests/integration.test.ts', 'tests/sandbox.test.ts', 'tests/buildings-perf.test.ts'];

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
    // parallel test files booting servers don't steal their CPU.
    include: PERF ? TIMING_FILES : ['tests/**/*.test.ts'],
    exclude: PERF ? [] : TIMING_FILES,
    // isolated-vm requires --no-node-snapshot on Node >= 20; forks pass it on.
    pool: 'forks',
    execArgv: ['--no-node-snapshot'],
  },
});
