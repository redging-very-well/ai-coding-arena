// `--config` for the balance CLIs (scripts/balance.ts, scripts/balance-exploit.ts):
// the archetypes are fitted to the config when tests/helpers/balance.ts loads
// (the padded units, the max-cost brick and every 'fill' are priced on
// `BALANCE_FIT`). A patch given on the command line therefore needs a fresh
// process with BALANCE_FIT set: this re-runs the same command with it (unless
// `--no-refit`, which fights the default-config armies on the patched rules)
// and exits with the child's code. Returns when no re-run is needed.

import { spawnSync } from 'node:child_process';

export function refitForPatch(configPatch: unknown, argv: string[]): void {
  if (configPatch === undefined || process.env.BALANCE_FIT !== undefined || argv.includes('--no-refit')) return;
  const r = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    stdio: 'inherit',
    env: { ...process.env, BALANCE_FIT: JSON.stringify(configPatch) },
  });
  process.exit(r.status ?? 1);
}
