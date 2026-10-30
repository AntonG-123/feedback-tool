// The website proxy. Runs on its own origin (PROXY_ORIGIN), separate from the
// app, so that site JavaScript can never touch app cookies or storage.
//
// URL scheme:  /p/<signed-token>/<scheme>/<host>/<path>?<query>
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { one } from '../db/index.js';
import { verifyProxyToken } from '../lib/crypto.js';
import { assertSafeUrl, safeFetch, resolvePublic, BlockedUrlError, connectUrl } from '../lib/ssrf.js';
import { rewriteHtml, rewriteCss, makeMapper, sameSite } from './rewrite.js';
import { isPasswordPage, login, siteAuthHeaders, SiteAuthError, clearSiteAuth } from './siteauth.js';
import { isFormEndpoint } from './blocklist.js';
import { errorPage, lostPage } from './pages.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.join(__dirname, 'client');
const projectCache = new Map();
const CTX_COOKIE = 'agm_ctx';

async function getProject(id) {
  const c = projectCache.get(id);
  if (c && c.at > Date.now() - 15000) return c.p;
  const p = await one('SELECT * FROM projects WHERE id = $1', [id]);
  projectCache.set(id, { p, at: Date.now() });
  return p;
}
export function invalidateProjectCache(id) {
  projectCache.delete(id);
  clearSiteAuth(id);
}

const secureCookies = () => config.proxyOrigin.startsWith('https://') || /^http:\/\/(127\.0\.0\.1|localhost)/.test(config.proxyOrigin);
const cookieAttrs = () => (secureCookies() ? 'Path=/; SameSite=None; Secure; Partitioned' : 'Path=/; SameSite=Lax');
const hostKey = (host) => 'h_' + host.toLowerCase().replace(/^www\./, '').replace(/[^a-z0-9]/g, '_') + '__';

function parseCookieHeader(h) {
  const out = [];
  for (const part of String(h || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out.push([part.slice(0, i).trim(), part.slice(i + 1).trim()]);
  }
  return out;
}

// Browser cookies (stored on the proxy origin) -> Cookie header for upstream.
function upstreamCookies(req, target, project) {
  const key = hostKey(target.hostname);
  const own = sameSite(target.hostname, new URL(project.origin).hostname);
  const parts = [];
  for (const [k, v] of parseCookieHeader(req.headers.cookie)) {
    if (k === CTX_COOKIE) continue;
    if (k.startsWith(key)) parts.push(`${k.slice(key.length)}=${v}`);
    else if (own && !k.startsWith('h_')) parts.push(`${k}=${v}`); // set by site JS via document.cookie
  }
  return parts;
}

// Upstream Set-Cookie -> cookies on the proxy origin, namespaced per site.
function rewriteSetCookie(sc, target) {
  const segs = sc.split(';').map((s) => s.trim());
  const [pair, ...attrs] = segs;
  const keep = attrs.filter((a) => /^(expires|max-age|httponly)/i.test(a));
  return `${hostKey(target.hostname)}${pair}; ${[...keep, cookieAttrs()].join('; ')}`;
}

const DROP_RESPONSE_HEADERS = new Set([
  'content-security-policy', 'content-security-policy-report-only', 'x-frame-options', 'strict-transport-security',
  'content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'set-cookie', 'alt-svc',
  'report-to', 'nel', 'cross-origin-opener-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy',
  'permissions-policy', 'clear-site-data', 'link', 'referrer-policy', 'location', 'access-control-allow-origin',
  'access-control-allow-credentials', 'origin-agent-cluster', 'x-xss-protection', 'expect-ct', 'server-timing', 'service-worker-allowed',
]);
const FORWARD_REQUEST_HEADERS = [
  'accept', 'accept-language', 'user-agent', 'range', 'if-none-match', 'if-modified-since', 'if-range',
  'content-type', 'cache-control', 'pragma', 'x-requested-with', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
];

// /p/<token>/<scheme>/<host>/<rest>
function parseProxyPath(rawUrl) {
  const m = rawUrl.match(/^\/p\/([^/]+)\/(https?|wss?)\/([^/?#]+)(\/[^?#]*)?(\?[^#]*)?/);
  if (!m) return null;
  return { token: m[1], scheme: m[2], host: m[3], path: m[4] || '/', search: m[5] || '' };
}

// Original URL of a proxied URL (used for Referer / Origin translation).
function unproxy(urlStr) {
  try {
    const u = new URL(urlStr);
    const p = parseProxyPath(u.pathname + u.search);
    if (!p) return null;
    return new URL(`${p.scheme}://${p.host}${p.path}${p.search}`);
  } catch {
    return null;
  }
}

const isDocumentRequest = (req) =>
  req.headers['sec-fetch-dest'] === 'document' || req.headers['sec-fetch-dest'] === 'iframe' ||
  (!req.headers['sec-fetch-dest'] && /text\/html/.test(req.headers.accept || ''));

async function decodeBody(res) {
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get('content-type') || '';
  let charset = (ct.match(/charset=([^;]+)/i)?.[1] || '').trim().toLowerCase();
  if (!charset) charset = (buf.subarray(0, 2048).toString('latin1').match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] || 'utf-8').toLowerCase();
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

export function sendError(res, code, message, { status = 502, document = true, detail } = {}) {
  if (res.headersSent) return res.end();
  res.status(status);
  res.set('cache-control', 'no-store');
  if (!document) return res.type('text/plain').send(`${code}: ${message}`);
  res.type('html').send(errorPage({ code, message, detail, appOrigin: config.appOrigin }));
}

function errorInfo(e) {
  if (e instanceof SiteAuthError) return { code: e.code, message: e.message, status: 401 };
  if (e instanceof BlockedUrlError) {
    if (e.code === 'dns_failed') return { code: 'site_unavailable', message: 'The website could not be found (DNS lookup failed).', status: 502 };
    return { code: e.code === 'invalid_url' ? 'invalid_url' : 'blocked_url', message: e.message, status: 403 };
  }
  const c = e.cause?.code || e.code || '';
  if (e.name === 'TimeoutError' || /TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_CONNECT_TIMEOUT/.test(c))
    return { code: 'timeout', message: 'The website took too long to respond.', status: 504 };
  if (/ENOTFOUND|EAI_AGAIN/.test(c) || /ENOTFOUND/.test(e.message)) return { code: 'site_unavailable', message: 'The website could not be found (DNS lookup failed).', status: 502 };
  if (e.cause instanceof BlockedUrlError) return errorInfo(e.cause);
  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|CERT|SSL|ERR_TLS/.test(c + ' ' + (e.cause?.message || '')))
    return { code: 'site_unavailable', message: 'The website refused the connection or has an invalid certificate.', status: 502 };
  return { code: 'render_failed', message: 'The page could not be loaded through the proxy.', status: 502 };
}

async function fetchUpstream(req, target, project, { body } = {}) {
  const headers = {};
  for (const h of FORWARD_REQUEST_HEADERS) if (req.headers[h]) headers[h] = req.headers[h];
  headers['accept-encoding'] = 'gzip, deflate, br';
  const ref = req.headers.referer && unproxy(req.headers.referer);
  if (ref) headers.referer = ref.toString();
  if (req.headers.origin) headers.origin = ref ? ref.origin : project.origin;
  const cookies = upstreamCookies(req, target, project);
  const auth = await siteAuthHeaders(project, target.toString());
  if (auth.cookie) cookies.push(auth.cookie);
  if (auth.authorization) headers.authorization = auth.authorization;
  if (cookies.length) headers.cookie = cookies.join('; ');
  const method = req.method;
  const init = { method, headers };
  if (!['GET', 'HEAD'].includes(method)) {
    init.body = body ?? Readable.toWeb(req);
    init.duplex = 'half';
  }
  return safeFetch(target, init);
}

export async function handleProxy(req, res) {
  const parsed = parseProxyPath(req.url);
  const doc = isDocumentRequest(req);
  if (!parsed) return sendError(res, 'invalid_url', 'Malformed preview URL', { status: 400, document: doc });
  const tok = verifyProxyToken(parsed.token);
  if (!tok) return sendError(res, 'session_expired', 'This preview session has expired. Reload the project to continue.', { status: 401, document: doc });
  const project = await getProject(tok.projectId);
  if (!project) return sendError(res, 'not_found', 'Project not found', { status: 404, document: doc });

  let target;
  try {
    target = assertSafeUrl(`${parsed.scheme}://${parsed.host}${parsed.path}${parsed.search}`);
  } catch (e) {
    const info = errorInfo(e);
    return sendError(res, info.code, info.message, { status: info.status, document: doc });
  }

  // Never let the preview submit real form data.
  if (req.method === 'POST' && (isFormEndpoint(target.toString()) || (doc && /form-urlencoded|multipart/.test(req.headers['content-type'] || '')))) {
    return sendError(res, 'form_blocked', 'Form submissions are disabled in the review preview.', { status: 403, document: doc });
  }

  if (doc && project.render_mode === 'snapshot' && req.method === 'GET' && sameSite(target.hostname, new URL(project.origin).hostname)) {
    const { renderSnapshot, renderHeaderValue } = await import('../screenshots/browser.js');
    if (req.headers['x-agm-render'] !== renderHeaderValue(parsed.token)) try {
      const html = await renderSnapshot(project, target.toString(), parsed.token);
      return sendDocument(res, html, target, parsed, project, { snapshot: true });
    } catch (e) {
      const info = errorInfo(e);
      return sendError(res, info.code, info.message, { status: info.status, detail: e.message });
    }
  }

  let upstream;
  let bodyBuf;
  try {
    if (!['GET', 'HEAD'].includes(req.method)) bodyBuf = await readBody(req);
    upstream = await fetchUpstream(req, target, project, { body: bodyBuf });
  } catch (e) {
    const info = errorInfo(e);
    if (!doc) console.warn(`[proxy] ${req.method} ${target} failed: ${info.code} ${e.cause?.message || e.message}`);
    return sendError(res, info.code, info.message, { status: info.status, document: doc, detail: e.cause?.message || e.message });
  }

  const { map } = makeMapper({ token: parsed.token, docUrl: target.toString(), projectHost: new URL(project.origin).hostname });
  res.status(upstream.status);
  upstream.headers.forEach((v, k) => {
    if (!DROP_RESPONSE_HEADERS.has(k)) res.setHeader(k, v);
  });
  const setCookies = (upstream.headers.getSetCookie?.() || []).map((sc) => rewriteSetCookie(sc, target));
  if (setCookies.length) res.setHeader('set-cookie', setCookies);
  const loc = upstream.headers.get('location');
  if (loc) {
    let abs;
    try { abs = new URL(loc, target); } catch {}
    if (abs && (abs.protocol === 'http:' || abs.protocol === 'https:')) res.setHeader('location', map(abs.toString(), target.toString()));
  }
  if (upstream.status >= 300 && upstream.status < 400 || req.method === 'HEAD' || upstream.status === 204 || upstream.status === 304) {
    await upstream.body?.cancel().catch(() => {});
    return res.end();
  }

  const ct = (upstream.headers.get('content-type') || '').toLowerCase();
  if (/text\/html|application\/xhtml/.test(ct)) {
    let html;
    try {
      html = await decodeBody(upstream);
    } catch (e) {
      return sendError(res, 'render_failed', 'The page could not be read.', { detail: e.message });
    }
    if (doc) {
      const pw = isPasswordPage(html, project.site_auth_type === 'none' ? 'any' : project.site_auth_type);
      if (pw) {
        if (project.site_auth_type === 'none' || project.site_auth_type === 'basic') {
          return sendError(res, 'auth_required', `This ${pw === 'webflow' ? 'Webflow' : 'Shopify'} site is password protected. The project owner can add the site password in the project settings.`, { status: 401 });
        }
        try {
          clearSiteAuth(project.id);
          await login(project);
          upstream = await fetchUpstream(req, target, project, { body: bodyBuf });
          html = await decodeBody(upstream);
          if (isPasswordPage(html, project.site_auth_type)) throw new SiteAuthError('The site password was rejected by the website. Check the password in the project settings.', 'auth_failed');
        } catch (e) {
          const info = errorInfo(e);
          return sendError(res, info.code, info.message, { status: info.status });
        }
      }
    }
    return sendDocument(res, html, target, parsed, project, { isFrameDoc: req.headers['sec-fetch-dest'] === 'iframe' });
  }
  if (/text\/css/.test(ct)) {
    const css = await decodeBody(upstream);
    res.type('text/css; charset=utf-8');
    return res.send(rewriteCss(css, target.toString(), map));
  }
  if (!upstream.body) return res.end();
  Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
}

function readBody(req, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendDocument(res, html, target, parsed, project, { snapshot = false } = {}) {
  if (html.length > config.proxy.maxRewriteBytes) return sendError(res, 'unsupported', 'This page is too large to render in the preview.', { status: 413 });
  const out = rewriteHtml(html, {
    token: parsed.token,
    docUrl: target.toString(),
    projectHost: new URL(project.origin).hostname,
    stripScripts: snapshot,
    config: {
      token: parsed.token,
      target: target.toString(),
      projectOrigin: project.origin,
      appOrigin: config.appOrigin,
      proxyOrigin: config.proxyOrigin,
      snapshot,
    },
  }).html;
  res.removeHeader('etag');
  res.removeHeader('last-modified');
  res.setHeader('cache-control', 'no-store');
  res.append('set-cookie', `${CTX_COOKIE}=${encodeURIComponent(`${parsed.token}|${target.protocol.slice(0, -1)}|${target.host}`)}; ${cookieAttrs()}`);
  res.type('text/html; charset=utf-8').send(out);
}

// Requests that arrive without the /p/<token>/ prefix (root-relative URLs
// created by site JavaScript that the shim did not catch). Recover the
// context from the Referer or the context cookie.
export function recoverContext(req) {
  const ref = req.headers.referer;
  if (ref) {
    try {
      const p = parseProxyPath(new URL(ref).pathname);
      if (p) return { token: p.token, scheme: p.scheme, host: p.host };
    } catch {}
  }
  const c = parseCookieHeader(req.headers.cookie).find(([k]) => k === CTX_COOKIE);
  if (c) {
    const [token, scheme, host] = decodeURIComponent(c[1]).split('|');
    if (token && scheme && host) return { token, scheme, host };
  }
  return null;
}

export function proxyApp(express) {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.get('/__agm/health', (_req, res) => res.json({ ok: true, role: 'proxy' }));
  app.get(['/__agm/shim.js', '/__agm/overlay.js'], (req, res) => {
    const file = path.join(clientDir, path.basename(req.path));
    res.type('application/javascript');
    res.set('cache-control', config.isProd ? 'public, max-age=300' : 'no-store');
    res.send(fs.readFileSync(file, 'utf8'));
  });
  app.get('/__agm/lost', (req, res) => res.type('html').send(lostPage(String(req.query.path || '/'), config.appOrigin)));
  app.use(async (req, res) => {
    try {
      if (req.url.startsWith('/p/')) return await handleProxy(req, res);
      if (req.url === '/favicon.ico' && !req.headers.referer) return res.status(204).end();
      const ctx = recoverContext(req);
      const doc = isDocumentRequest(req);
      if (!ctx) {
        if (doc) return res.redirect(302, `/__agm/lost?path=${encodeURIComponent(req.url)}`);
        return res.status(404).type('text/plain').send('Not found');
      }
      const rewritten = `/p/${ctx.token}/${ctx.scheme}/${ctx.host}${req.url}`;
      if (doc && req.method === 'GET') return res.redirect(302, rewritten);
      req.url = rewritten;
      return await handleProxy(req, res);
    } catch (e) {
      console.error('[proxy] unhandled', e);
      sendError(res, 'render_failed', 'The page could not be loaded through the proxy.', { document: isDocumentRequest(req) });
    }
  });
  return app;
}

// WebSocket tunnelling: /p/<token>/wss/<host>/<path>
export async function handleUpgrade(req, socket, head) {
  const fail = () => socket.destroy();
  try {
    const p = parseProxyPath(req.url);
    if (!p || !verifyProxyToken(p.token)) return fail();
    const secure = p.scheme === 'wss' || p.scheme === 'https';
    const httpUrl = assertSafeUrl(`${secure ? 'https' : 'http'}://${p.host}${p.path}${p.search}`);
    const mapped = new URL(connectUrl(httpUrl));
    const [addr] = await resolvePublic(httpUrl.hostname);
    const port = Number(mapped.port || (secure ? 443 : 80));
    const upstream = secure && mapped.protocol === 'https:'
      ? tls.connect({ host: addr.address, port, servername: httpUrl.hostname })
      : net.connect({ host: addr.address, port });
    upstream.setTimeout(15000, () => upstream.destroy());
    upstream.once('connect', () => upstream.setTimeout(0));
    const lines = [`GET ${httpUrl.pathname}${httpUrl.search} HTTP/1.1`, `Host: ${httpUrl.host}`];
    for (const [k, v] of Object.entries(req.headers)) {
      if (['host', 'cookie', 'origin', 'referer'].includes(k)) continue;
      lines.push(`${k}: ${v}`);
    }
    lines.push(`Origin: https://${httpUrl.host}`);
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
    upstream.on('error', fail);
    socket.on('error', () => upstream.destroy());
  } catch {
    fail();
  }
}
