// Boot (plan §13 `start`): bind 0.0.0.0:${PORT:-8080}, then print every LAN
// URL, a terminal QR for /play, the /setup and /admin URLs, the admin
// password and the sandbox mode.
//
//   node --no-node-snapshot packages/server/dist/index.js [--unsafe]
//   env: PORT, HOST, ADMIN_PASSWORD, DATA_DIR (default ./data)

import { resolve } from 'node:path';
import qrcode from 'qrcode-terminal';
import { startServer } from './server.js';
import { lanUrls } from './util/lan.js';
import { log } from './util/log.js';

async function main(): Promise<void> {
  const unsafe = process.argv.includes('--unsafe');
  const port = process.env.PORT ? Number(process.env.PORT) : 8080;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid PORT ${process.env.PORT}`);
  const host = process.env.HOST ?? '0.0.0.0';
  const server = await startServer({
    port,
    host,
    dataDir: resolve(process.env.DATA_DIR ?? 'data'),
    ...(process.env.ADMIN_PASSWORD ? { adminPassword: process.env.ADMIN_PASSWORD } : {}),
    unsafe,
  });
  const { game } = server;
  // Bound to one address (e.g. HOST=127.0.0.1): print that, not LAN URLs that won't answer.
  const urls = host === '0.0.0.0' || host === '::' ? lanUrls(server.port) : [`http://${host.includes(':') ? `[${host}]` : host}:${server.port}`];
  const main = urls[0] ?? `http://localhost:${server.port}`;
  const mode = game.config.sandbox.mode;

  const lines = [
    '',
    '  PIXEL CLASH is running',
    '',
    ...(urls.length ? urls.map((u) => `  Players:   ${u}/play`) : [`  Players:   http://localhost:${server.port}/play  (no LAN address found!)`]),
    `  Projector: ${main}/screen`,
    `  Setup:     ${main}/setup`,
    `  Admin:     ${main}/admin`,
    `  MCP:       ${main}/mcp`,
    '',
    `  Admin password: ${game.auth.adminPassword}${game.auth.adminPasswordGenerated ? '  (generated; set ADMIN_PASSWORD to choose one)' : ''}`,
    mode === 'ivm'
      ? '  Sandbox: isolated-vm'
      : `  !!! SANDBOX: ${mode.toUpperCase()} — NOT the isolated-vm sandbox. Do not run untrusted code. !!!`,
    `  Phase: ${game.store.match.phase}${game.store.match.round ? ` (round ${game.store.match.round})` : ''}`,
    '',
  ];
  console.log(lines.join('\n'));
  qrcode.generate(`${main}/play`, { small: true }, (qr) => console.log(qr));

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal}: saving and shutting down`);
    void server.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

main().catch((err: unknown) => {
  log.error('could not start the server', err);
  process.exit(1);
});
