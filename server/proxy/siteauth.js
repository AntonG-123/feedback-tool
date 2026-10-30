// Authentication against password-protected sites, performed server-side so
// that guests never see the site password.
//
//   webflow  - POST /.wf_auth (pass, path, page) -> wf_auth cookie
//   shopify  - POST /password (form_type=storefront_password) -> storefront_digest cookie
//   basic    - HTTP Basic Authorization header
//
// The password is stored AES-GCM encrypted; obtained cookies are stored
// encrypted as well and cached in memory. A password page seen again later
// (expired session) triggers one automatic re-login.
import { query, one } from '../db/index.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { safeFetch } from '../lib/ssrf.js';

const cache = new Map(); // projectId -> { cookies: {name: value}, at }
const inflight = new Map();

export class SiteAuthError extends Error {
  constructor(msg, code) {
    super(msg);
    this.code = code;
  }
}

export function isPasswordPage(html, type) {
  if (type === 'webflow' || type === 'any') {
    if (/action=["'][^"']*\.wf_auth/i.test(html) || /class=["'][^"']*w-password-page/i.test(html)) return 'webflow';
  }
  if (type === 'shopify' || type === 'any') {
    if (/form_type["']?\s*value=["']storefront_password/i.test(html) || /action=["']\/password["']/i.test(html)) return 'shopify';
  }
  return null;
}

function parseSetCookies(res) {
  const out = {};
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const sc of list) {
    const [pair] = sc.split(';');
    const i = pair.indexOf('=');
    if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return out;
}

async function loadState(project) {
  if (cache.has(project.id)) return cache.get(project.id);
  const s = project.site_auth_state_enc ? JSON.parse(decrypt(project.site_auth_state_enc) || 'null') : null;
  if (s) cache.set(project.id, s);
  return s;
}

export function clearSiteAuth(projectId) {
  cache.delete(projectId);
}

async function doLogin(project) {
  const password = decrypt(project.site_auth_secret_enc);
  if (!password) throw new SiteAuthError('This website is password protected. Add the site password in the project settings.', 'auth_required');
  const origin = project.origin;
  let res;
  const headers = { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Mozilla/5.0 AGMFeedback' };
  if (project.site_auth_type === 'webflow') {
    const body = new URLSearchParams({ pass: password, path: '/', page: '/' });
    res = await safeFetch(`${origin}/.wf_auth`, { method: 'POST', headers, body: body.toString() });
  } else if (project.site_auth_type === 'shopify') {
    const body = new URLSearchParams({ form_type: 'storefront_password', utf8: '✓', password });
    res = await safeFetch(`${origin}/password`, { method: 'POST', headers, body: body.toString() });
  } else {
    return null;
  }
  const cookies = parseSetCookies(res);
  await res.body?.cancel().catch(() => {});
  const ok = project.site_auth_type === 'webflow' ? !!cookies.wf_auth : !!cookies.storefront_digest;
  if (!ok) throw new SiteAuthError('The site password was rejected by the website. Check the password in the project settings.', 'auth_failed');
  const state = { cookies, at: Date.now() };
  cache.set(project.id, state);
  await query('UPDATE projects SET site_auth_state_enc = $2 WHERE id = $1', [project.id, encrypt(JSON.stringify(state))]);
  return state;
}

export async function login(project) {
  if (!inflight.has(project.id)) {
    inflight.set(project.id, doLogin(project).finally(() => setTimeout(() => inflight.delete(project.id), 0)));
  }
  return inflight.get(project.id);
}

// Extra request headers for upstream requests to the project's own site.
export async function siteAuthHeaders(project, url) {
  if (!project || project.site_auth_type === 'none') return {};
  try {
    if (new URL(url).host !== new URL(project.origin).host) return {};
  } catch {
    return {};
  }
  if (project.site_auth_type === 'basic') {
    const pw = decrypt(project.site_auth_secret_enc) || '';
    return { authorization: 'Basic ' + Buffer.from(`${project.site_auth_user || ''}:${pw}`).toString('base64') };
  }
  let state = await loadState(project);
  if (!state) state = await login(project).catch(() => null);
  if (!state) return {};
  return { cookie: Object.entries(state.cookies).map(([k, v]) => `${k}=${v}`).join('; ') };
}

export async function getProjectForAuth(projectId) {
  return one('SELECT * FROM projects WHERE id = $1', [projectId]);
}
