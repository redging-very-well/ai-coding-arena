// `npm run dev`: the server under `tsx watch` (with --no-node-snapshot for
// isolated-vm and the "source" condition so @pixel-clash/shared runs from its
// TS sources) plus the Vite dev server, which proxies /api, /mcp and /ws to
// the server (packages/client/vite.config.ts). Ctrl+C stops both.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { checkNode } from './check-node.mjs';

checkNode();

const require = createRequire(import.meta.url);
const tsxCli = join(dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');
const viteCli = join(dirname(require.resolve('vite/package.json')), 'bin', 'vite.js');
const root = join(dirname(new URL(import.meta.url).pathname), '..');

const children = [
  spawn(
    process.execPath,
    [tsxCli, 'watch', '--clear-screen=false', '--no-node-snapshot', '--conditions=source', 'packages/server/src/index.ts', ...process.argv.slice(2)],
    { cwd: root, stdio: 'inherit', env: { UV_THREADPOOL_SIZE: '8', ...process.env } },
  ),
  spawn(process.execPath, [viteCli], { cwd: join(root, 'packages', 'client'), stdio: 'inherit' }),
];

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500).unref();
}
for (const c of children) c.on('exit', (code) => stop(code ?? 0));
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
