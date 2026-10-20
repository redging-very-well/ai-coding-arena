// Programmatic server start (used by index.ts and the tests): one process,
// one port serving the static client, REST, MCP and the WebSocket (§2).

import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEFAULT_CONFIG, parseConfig, type GameConfig } from '@pixel-clash/shared';
import { Game, type GameOptions } from './services/game.js';
import { createApp } from './http.js';
import { log } from './util/log.js';
import { repoPath } from './util/paths.js';
import { WsHub } from './ws.js';

export interface ServerOptions extends GameOptions {
  /** Default 8080; 0 picks a free port. */
  port?: number;
  /** Default 0.0.0.0. */
  host?: string;
  publicDir?: string;
  /** Read config/default.json from the repo (default true). */
  loadConfigFile?: boolean;
}

export interface RunningServer {
  game: Game;
  hub: WsHub;
  http: Server;
  port: number;
  /** http://127.0.0.1:<port> */
  url: string;
  close(): Promise<void>;
}

/** DEFAULT_CONFIG merged with config/default.json (if present). */
export function loadBaseConfig(): GameConfig {
  const file = repoPath('config', 'default.json');
  if (!existsSync(file)) return DEFAULT_CONFIG;
  return parseConfig(JSON.parse(readFileSync(file, 'utf8')) as unknown);
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const baseConfig = opts.baseConfig ?? (opts.loadConfigFile === false ? DEFAULT_CONFIG : loadBaseConfig());
  const game = new Game({ ...opts, baseConfig });
  if (game.config.sandbox.mode === 'inproc-unsafe' && !opts.unsafe) {
    throw new Error("sandbox mode 'inproc-unsafe' is for development only; start with --unsafe to allow it.");
  }
  await game.init();

  let port = opts.port ?? 8080;
  const app = createApp(game, { port: () => port, ...(opts.publicDir ? { publicDir: opts.publicDir } : {}) });
  const http = createServer(app);
  const hub = new WsHub(game);
  hub.attach(http);
  game.setNotifier(hub);

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, opts.host ?? '0.0.0.0', () => {
      http.off('error', reject);
      resolve();
    });
  });
  port = (http.address() as AddressInfo).port;
  game.visibility.port = port;

  let closed = false;
  return {
    game,
    hub,
    http,
    port,
    url: `http://127.0.0.1:${port}`,
    async close() {
      if (closed) return;
      closed = true;
      hub.close();
      await game.shutdown();
      await new Promise<void>((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      });
      log.debug('server closed');
    },
  };
}
