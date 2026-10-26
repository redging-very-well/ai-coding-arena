// The Express app: REST under /api, MCP at /mcp, and the static
// client build with its multi-page routes (/play /screen /admin /setup /guide).

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Game } from './services/game.js';
import { mountMcp } from './mcp.js';
import { adminRoutes } from './routes/admin.js';
import { sendError } from './routes/common.js';
import { playerRoutes } from './routes/player.js';
import { publicRoutes } from './routes/public.js';
import { log } from './util/log.js';
import { defaultPublicDir } from './util/paths.js';

export const PAGES = ['play', 'screen', 'admin', 'setup', 'guide'] as const;

export interface HttpOptions {
  /** The built client (default packages/server/dist/public). */
  publicDir?: string;
  /** The port the server listens on (for the /mcp Origin allowlist). */
  port: () => number;
}

export function createApp(game: Game, opts: HttpOptions): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);

  // MCP has its own JSON parsing and Origin check.
  mountMcp(app, game, { port: opts.port });

  const api = express.Router();
  // Unit sources are ≤ 64 KB; JSON escaping can roughly double that.
  api.use(express.json({ limit: '512kb' }));
  api.use(cookieParser());
  api.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  api.use(publicRoutes(game));
  api.use('/admin', adminRoutes(game));
  api.use(playerRoutes(game));
  app.use('/api', api);

  // Static client.
  const publicDir = opts.publicDir ?? defaultPublicDir();
  app.get('/', (_req, res) => res.redirect('/play'));
  for (const page of PAGES) {
    app.get([`/${page}`, `/${page}/`], (_req, res) => {
      const file = join(publicDir, `${page}.html`);
      if (!existsSync(file)) {
        res.status(404).type('text').send(`The client is not built yet: run "npm run build" (missing ${page}.html).`);
        return;
      }
      res.sendFile(file);
    });
  }
  app.use(express.static(publicDir, { index: false, fallthrough: true }));

  // JSON 404 + error handler.
  app.use((req: Request, res: Response) => {
    if (req.path.startsWith('/api/')) sendError(res, { code: 'NOT_FOUND', message: `No route ${req.method} ${req.path}.` });
    else res.status(404).type('text').send('Not found');
  });
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number; statusCode?: number }).status ?? (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      const type = (err as { type?: string }).type;
      return sendError(res, {
        code: 'BAD_REQUEST',
        message: type === 'entity.too.large' ? 'The request body is too large.' : 'The request body is not valid JSON.',
      });
    }
    log.error('request failed', err);
    if (!res.headersSent) sendError(res, { code: 'INTERNAL', message: 'Something went wrong on the server.' });
  });
  return app;
}
