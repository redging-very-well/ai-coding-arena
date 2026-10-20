import { fileURLToPath } from 'node:url';
import { defaultClientConditions, defineConfig, type Plugin } from 'vite';

const page = (name: string) => fileURLToPath(new URL(`./${name}.html`, import.meta.url));
const PAGES = ['play', 'screen', 'admin', 'setup'];

/** The game server the dev server proxies to (`npm run dev` starts it on 8080). */
const target = `http://localhost:${process.env.PORT ?? 8080}`;

/** Dev only: serve /play, /screen, /admin, /setup like the game server does. */
function pageRoutes(): Plugin {
  return {
    name: 'pixel-clash-pages',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const path = (req.url ?? '').split('?')[0]!.replace(/\/$/, '');
        if (path === '') req.url = '/play.html';
        else if (PAGES.includes(path.slice(1))) req.url = `${path}.html${(req.url ?? '').slice(path.length).replace(/^\//, '')}`;
        next();
      });
    },
  };
}

// Multi-page Vite build (plan §13): play, screen, admin, setup. The dev server
// proxies /api, /mcp and /ws to the game server. Preact JSX is compiled by
// Vite's built-in transform via tsconfig `jsxImportSource` (no Babel preset).
export default defineConfig({
  resolve: { conditions: ['source', ...defaultClientConditions] },
  plugins: [pageRoutes()],
  server: {
    host: true,
    proxy: {
      '/api': { target },
      '/mcp': { target },
      '/ws': { target, ws: true },
    },
  },
  build: {
    outDir: '../server/dist/public',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        play: page('play'),
        screen: page('screen'),
        admin: page('admin'),
        setup: page('setup'),
      },
    },
  },
});
