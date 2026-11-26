import { createReadStream, readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { type Connect, type Plugin, defineConfig, loadEnv } from 'vite';

// The development extension's id, pinned by its manifest `key`
// (web/extension/dev-key/). Read at build time so the page can message it.
function devExtensionId(): string {
  try {
    return readFileSync(new URL('../extension/dev-key/extension-id.txt', import.meta.url), 'utf8').trim();
  } catch {
    return '';
  }
}

// The party server's address stays out of the repo: .env.local here, a
// Cloudflare Pages variable in production. Without it Listen Together can't
// make a party, so a production build stops instead of shipping that.
function requirePartyServer(mode: string): void {
  const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), 'VITE_');
  if (!env.VITE_PARTY_SERVER_URL?.trim()) {
    throw new Error('VITE_PARTY_SERVER_URL is not set (app/.env.local, or the Cloudflare Pages environment).');
  }
}

function contentTypeFor(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case '.zip':
      return 'application/zip';
    case '.json':
      return 'application/json; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

// Never let missing `/downloads/*` assets fall through Vite's SPA fallback to index.html.
function attachDownloadsMiddleware(middlewares: Connect.Server, downloadsDir: string): void {
  const root = resolve(downloadsDir);
  middlewares.use((req, res, next) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname !== '/downloads' && !pathname.startsWith('/downloads/')) return next();

    const fail = (status: number, body: string) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.end(body);
    };

    if (pathname === '/downloads' || pathname.endsWith('/')) return fail(404, 'Not found');
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405, 'Method not allowed');

    let relPath: string;
    try {
      relPath = decodeURIComponent(pathname.slice('/downloads/'.length));
    } catch {
      return fail(400, 'Invalid download path');
    }

    const filePath = resolve(root, relPath);
    if (!filePath.startsWith(`${root}${sep}`)) return fail(403, 'Forbidden');

    const stat = statSync(filePath, { throwIfNoEntry: false });
    if (!stat?.isFile()) return fail(404, 'Download artifact not found');

    res.statusCode = 200;
    res.setHeader('Content-Type', contentTypeFor(filePath));
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(filePath).pipe(res);
  });
}

function downloadsGuardPlugin(): Plugin {
  const appRoot = fileURLToPath(new URL('.', import.meta.url));
  return {
    name: 'nikomusic-downloads-guard',
    configureServer(server) {
      attachDownloadsMiddleware(server.middlewares, resolve(appRoot, 'public/downloads'));
    },
    configurePreviewServer(server) {
      const outDir = resolve(appRoot, server.config.build.outDir, 'downloads');
      attachDownloadsMiddleware(server.middlewares, outDir);
    },
  };
}

export default defineConfig(({ command, mode }) => {
  if (command === 'build') requirePartyServer(mode);
  return {
    plugins: [downloadsGuardPlugin(), react(), tailwindcss()],
    define: {
      DEV_EXTENSION_ID: JSON.stringify(devExtensionId()),
    },
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    // AutoMix's analysis worker (playback/automix): essentia.js's 2021-era
    // Emscripten glue breaks under dep pre-bundling, and the worker is a module.
    optimizeDeps: { exclude: ['essentia.js'] },
    worker: { format: 'es' },
    server: {
      // The extension's externally_connectable and DNR rules name this origin
      // exactly, so the port must not drift to 5174 when 5173 is busy.
      port: 5173,
      strictPort: true,
    },
  };
});
