// `npm start`: a tiny cross-platform launcher (plan §13) for the built server:
//   UV_THREADPOOL_SIZE=16 node --no-node-snapshot packages/server/dist/index.js
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
  env: { ...process.env, UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE ?? '16' },
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
