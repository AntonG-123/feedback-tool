import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { initDb, closeDb, query } from './db/index.js';
import { identify, HttpError } from './lib/auth.js';
import { authRouter } from './routes/auth.js';
import { projectsRouter } from './routes/projects.js';
import { commentsRouter } from './routes/comments.js';
import { proxyApp, handleUpgrade } from './proxy/index.js';
import { registerJob, setFinalFailureHandler, startJobRunner, stopJobRunner } from './lib/jobs.js';
import { captureCommentScreenshots, markScreenshotsFailed } from './screenshots/worker.js';
import { closeBrowser } from './screenshots/browser.js';
import { discoverPages } from './discovery/sitemap.js';
import { startDigestLoop, stopDigestLoop } from './notifications/digest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '..', 'dist');

function appServer() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use((req, res, next) => {
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
    res.setHeader('permissions-policy', 'microphone=(self), camera=(), geolocation=()');
    res.setHeader(
      'content-security-policy',
      [
        "default-src 'self'",
        `frame-src ${config.proxyOrigin}`,
        "img-src 'self' data: blob:",
        "media-src 'self' blob:",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "script-src 'self'",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join('; '),
    );
    next();
  });
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.get(['/api/health', '/__agm/health'], async (_req, res) => {
    await query('SELECT 1');
    res.json({ ok: true, role: 'app' });
  });
  app.use('/api', identify, authRouter, projectsRouter, commentsRouter);
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : err.type === 'entity.too.large' ? 413 : 500);
    if (status >= 500) console.error(`[app] ${req.method} ${req.path}`, err);
    res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message, code: err.code || undefined });
  });
  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir, { index: false, maxAge: '1h', setHeaders: (res, p) => /assets/.test(p) && res.setHeader('cache-control', 'public, max-age=31536000, immutable') }));
    app.get('/{*splat}', (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
  }
  return app;
}

function registerJobs() {
  registerJob('screenshot', captureCommentScreenshots, { concurrency: 2 });
  setFinalFailureHandler('screenshot', markScreenshotsFailed);
  registerJob('discover', async ({ projectId }) => {
    const project = (await query('SELECT * FROM projects WHERE id = $1', [projectId])).rows[0];
    if (!project) return;
    await query(`UPDATE projects SET discovery_status = 'running' WHERE id = $1`, [projectId]);
    try {
      const { pages, log } = await discoverPages(project);
      for (const p of pages) {
        const u = new URL(p.url);
        await query(
          `INSERT INTO pages (project_id, url, path, title, source) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (project_id, url) DO UPDATE SET title = COALESCE(pages.title, EXCLUDED.title)`,
          [projectId, p.url, u.pathname + u.search, p.title, p.source],
        );
      }
      await query(`UPDATE projects SET discovery_status = 'done', discovery_error = NULL WHERE id = $1`, [projectId]);
      console.log(`[discover] ${project.origin}: ${pages.length} pages (${log.slice(-3).join('; ')})`);
    } catch (e) {
      await query(`UPDATE projects SET discovery_status = 'failed', discovery_error = $2 WHERE id = $1`, [projectId, e.message.slice(0, 500)]);
      throw e;
    }
  });
}

export async function start() {
  await initDb();
  const servers = [];
  if (config.mode === 'all' || config.mode === 'app') {
    const s = http.createServer(appServer());
    await new Promise((r) => s.listen(config.port, r));
    console.log(`[app] listening on :${config.port} (${config.appOrigin})`);
    servers.push(s);
  }
  if (config.mode === 'all' || config.mode === 'proxy') {
    const s = http.createServer(proxyApp(express));
    s.on('upgrade', handleUpgrade);
    s.headersTimeout = 65000;
    await new Promise((r) => s.listen(config.mode === 'proxy' ? config.port : config.proxyPort, r));
    console.log(`[proxy] listening on :${config.mode === 'proxy' ? config.port : config.proxyPort} (${config.proxyOrigin})`);
    servers.push(s);
  }
  if (config.workersEnabled && config.mode !== 'proxy') {
    registerJobs();
    startJobRunner();
    startDigestLoop();
  }
  const shutdown = async () => {
    stopJobRunner();
    stopDigestLoop();
    for (const s of servers) s.close();
    await closeBrowser();
    await closeDb();
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return servers;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
