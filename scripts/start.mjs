// `npm start`: a tiny cross-platform launcher (plan §13) for the built server:
//   UV_THREADPOOL_SIZE=16 MALLOC_ARENA_MAX=2 node --no-node-snapshot packages/server/dist/index.js
// Extra arguments (e.g. --unsafe) are passed through.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkNode } from './check-node.mjs';

checkNode();
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'packages', 'server', 'dist', 'index.js');
if (!existsSync(entry)) {
  console.error('The server is not built yet. Run "npm run build" first.');
  process.exit(1);
}
const child = spawn(process.execPath, ['--no-node-snapshot', entry, ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE ?? '16',
    // Linux/glibc: one malloc arena per busy thread (16 pool threads) let the
    // server's RSS creep from ~360 to ~540 MB over a few 8-player matches in
    // the M6 load test; 2 arenas kept it at ~250-300 MB (docs/load.md).
    // Ignored on macOS and Windows.
    MALLOC_ARENA_MAX: process.env.MALLOC_ARENA_MAX ?? '2',
  },
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
