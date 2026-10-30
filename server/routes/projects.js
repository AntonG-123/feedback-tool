import { Router } from 'express';
import { one, query, tx } from '../db/index.js';
import { HttpError, requireUser, projectAccess, validShareLink } from '../lib/auth.js';
import { randomToken, signProxyToken, encrypt } from '../lib/crypto.js';
import { normalizeInputUrl, normalizePageUrl, isSameSite, pathOf } from '../lib/urls.js';
import { assertSafeUrl, resolvePublic, BlockedUrlError } from '../lib/ssrf.js';
import { enqueue } from '../lib/jobs.js';
import { config } from '../config.js';
import { invalidateProjectCache } from '../proxy/index.js';

export const projectsRouter = Router();

const shareUrl = (token) => `${config.appOrigin}/s/${token}`;

function projectDto(p) {
  return {
    id: p.id, name: p.name, url: p.url, origin: p.origin, renderMode: p.render_mode,
    siteAuthType: p.site_auth_type, siteAuthUser: p.site_auth_user, hasSitePassword: !!p.site_auth_secret_enc,
    discoveryStatus: p.discovery_status, createdAt: p.created_at,
  };
}

export async function upsertPage(projectId, url, { title = null, source = 'visited' } = {}) {
  const norm = normalizePageUrl(url);
  return one(
    `INSERT INTO pages (project_id, url, path, title, source) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (project_id, url) DO UPDATE SET title = COALESCE(pages.title, EXCLUDED.title)
     RETURNING id, url, path, title, source`,
    [projectId, norm, pathOf(norm), title ? String(title).slice(0, 200) : null, source],
  );
}

projectsRouter.get('/projects', requireUser, async (req, res) => {
  const rows = (
    await query(
      `SELECT p.*,
        (SELECT count(*)::int FROM pages WHERE project_id = p.id) AS page_count,
        (SELECT count(*)::int FROM comments WHERE project_id = p.id AND parent_id IS NULL AND status = 'open') AS open_count,
        (SELECT count(*)::int FROM comments WHERE project_id = p.id AND parent_id IS NULL) AS comment_count,
        (SELECT max(created_at) FROM comments WHERE project_id = p.id) AS last_comment_at
       FROM projects p WHERE owner_id = $1 ORDER BY p.created_at DESC`,
      [req.user.id],
    )
  ).rows;
  res.json({
    projects: rows.map((p) => ({ ...projectDto(p), pageCount: p.page_count, openCount: p.open_count, commentCount: p.comment_count, lastCommentAt: p.last_comment_at })),
  });
});

projectsRouter.post('/projects', requireUser, async (req, res) => {
  const url = normalizeInputUrl(req.body?.url);
  if (!url) throw new HttpError(400, 'Please enter a valid website URL, e.g. https://example.com', 'invalid_url');
  try {
    const u = assertSafeUrl(url);
    await resolvePublic(u.hostname);
  } catch (e) {
    if (e instanceof BlockedUrlError) {
      throw new HttpError(400, e.code === 'dns_failed' ? 'This website could not be found. Check the address.' : e.message, e.code);
    }
    if (/ENOTFOUND|EAI_AGAIN/.test(e.code || e.message)) throw new HttpError(400, 'This website could not be found. Check the address.', 'dns_failed');
    throw e;
  }
  const u = new URL(url);
  const name = String(req.body?.name || '').trim().slice(0, 120) || u.hostname.replace(/^www\./, '');
  const project = await tx(async (c) => {
    const p = (await c.query(`INSERT INTO projects (owner_id, name, url, origin) VALUES ($1, $2, $3, $4) RETURNING *`, [req.user.id, name, url, u.origin])).rows[0];
    await c.query(`INSERT INTO pages (project_id, url, path, source) VALUES ($1, $2, $3, 'start')`, [p.id, url, pathOf(url)]);
    await c.query(`INSERT INTO share_links (project_id, token) VALUES ($1, $2)`, [p.id, randomToken(24)]);
    return p;
  });
  await enqueue('discover', { projectId: project.id }, { maxAttempts: 2 });
  res.status(201).json({ project: projectDto(project) });
});

projectsRouter.get('/projects/:id', async (req, res) => {
  const { project, role } = await projectAccess(req, req.params.id);
  const out = {
    project: projectDto(project),
    role,
    proxy: { origin: config.proxyOrigin, token: signProxyToken(project.id) },
    me: role === 'owner' ? { type: 'owner', id: req.user.id, name: req.user.name || req.user.email.split('@')[0] } : req.guest ? { type: 'guest', id: req.guest.id, name: req.guest.name } : null,
  };
  if (role === 'owner') {
    const link = await one(`SELECT * FROM share_links WHERE project_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`, [project.id]);
    out.share = link ? { url: shareUrl(link.token), enabled: link.enabled, expiresAt: link.expires_at } : null;
  }
  if (role === 'guest') {
    delete out.project.siteAuthUser;
    delete out.project.siteAuthType;
    delete out.project.hasSitePassword;
  }
  res.json(out);
});

projectsRouter.patch('/projects/:id', requireUser, async (req, res) => {
  const { project, role } = await projectAccess(req, req.params.id);
  if (role !== 'owner') throw new HttpError(403, 'Only the project owner can change settings');
  const b = req.body || {};
  const sets = [];
  const vals = [project.id];
  const set = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (b.name !== undefined) set('name', String(b.name).trim().slice(0, 120) || project.name);
  if (b.renderMode !== undefined) {
    if (!['live', 'snapshot'].includes(b.renderMode)) throw new HttpError(400, 'Invalid render mode');
    set('render_mode', b.renderMode);
  }
  if (b.siteAuth !== undefined) {
    const type = b.siteAuth?.type || 'none';
    if (!['none', 'webflow', 'shopify', 'basic'].includes(type)) throw new HttpError(400, 'Invalid site authentication type');
    set('site_auth_type', type);
    set('site_auth_user', type === 'basic' ? String(b.siteAuth.user || '').slice(0, 200) : null);
    if (type === 'none') set('site_auth_secret_enc', null);
    else if (b.siteAuth.password) set('site_auth_secret_enc', encrypt(String(b.siteAuth.password).slice(0, 500)));
    set('site_auth_state_enc', null);
  }
  if (sets.length) {
    sets.push('updated_at = now()');
    await query(`UPDATE projects SET ${sets.join(', ')} WHERE id = $1`, vals);
    invalidateProjectCache(project.id);
  }
  res.json({ project: projectDto(await one('SELECT * FROM projects WHERE id = $1', [project.id])) });
});

projectsRouter.delete('/projects/:id', requireUser, async (req, res) => {
  const { project, role } = await projectAccess(req, req.params.id);
  if (role !== 'owner') throw new HttpError(403, 'Only the project owner can delete the project');
  await query('DELETE FROM projects WHERE id = $1', [project.id]);
  invalidateProjectCache(project.id);
  res.json({ ok: true });
});

projectsRouter.post('/projects/:id/rediscover', requireUser, async (req, res) => {
  const { project, role } = await projectAccess(req, req.params.id);
  if (role !== 'owner') throw new HttpError(403, 'Only the project owner can do this');
  await query(`UPDATE projects SET discovery_status = 'pending' WHERE id = $1`, [project.id]);
  await enqueue('discover', { projectId: project.id }, { maxAttempts: 2 });
  res.json({ ok: true });
});

// ---- share link management (owner) ----
projectsRouter.post('/projects/:id/share', requireUser, async (req, res) => {
  const { project, role } = await projectAccess(req, req.params.id);
  if (role !== 'owner') throw new HttpError(403, 'Only the project owner can manage sharing');
  const action = req.body?.action;
  let link = await one(`SELECT * FROM share_links WHERE project_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`, [project.id]);
  if (action === 'regenerate' || !link) {
    await query(`UPDATE share_links SET revoked_at = now(), enabled = false WHERE project_id = $1 AND revoked_at IS NULL`, [project.id]);
    link = await one(`INSERT INTO share_links (project_id, token) VALUES ($1, $2) RETURNING *`, [project.id, randomToken(24)]);
  } else if (action === 'disable' || action === 'enable') {
    link = await one(`UPDATE share_links SET enabled = $2 WHERE id = $1 RETURNING *`, [link.id, action === 'enable']);
  } else if (action === 'expiry') {
    const days = req.body?.days == null ? null : Math.min(365, Math.max(1, Number(req.body.days)));
    link = await one(`UPDATE share_links SET expires_at = ${days ? `now() + ($2 || ' days')::interval` : 'NULL'} WHERE id = $1 RETURNING *`, days ? [link.id, String(days)] : [link.id]);
  } else {
    throw new HttpError(400, 'Unknown action');
  }
  res.json({ share: { url: shareUrl(link.token), enabled: link.enabled, expiresAt: link.expires_at } });
});

// Public: resolve a share token (guest landing page).
projectsRouter.get('/share/:token', async (req, res) => {
  const link = await validShareLink(req.params.token);
  if (!link) throw new HttpError(404, 'This share link does not exist.', 'share_not_found');
  if (link.invalidReason === 'revoked') throw new HttpError(410, 'This share link has been disabled by the project owner.', 'share_revoked');
  if (link.invalidReason === 'expired') throw new HttpError(410, 'This share link has expired.', 'share_expired');
  const p = await one('SELECT id, name FROM projects WHERE id = $1', [link.project_id]);
  res.json({ projectId: p.id, name: p.name });
});

// ---- pages ----
projectsRouter.get('/projects/:id/pages', async (req, res) => {
  const { project } = await projectAccess(req, req.params.id);
  const rows = (
    await query(
      `SELECT pg.id, pg.url, pg.path, pg.title, pg.source,
         count(c.id) FILTER (WHERE c.status = 'open')::int AS open_count,
         count(c.id) FILTER (WHERE c.status = 'resolved')::int AS resolved_count
       FROM pages pg LEFT JOIN comments c ON c.page_id = pg.id AND c.parent_id IS NULL
       WHERE pg.project_id = $1 GROUP BY pg.id ORDER BY pg.path`,
      [project.id],
    )
  ).rows;
  res.json({
    discoveryStatus: project.discovery_status,
    pages: rows.map((r) => ({ id: r.id, url: r.url, path: r.path, title: r.title, source: r.source, openCount: r.open_count, resolvedCount: r.resolved_count })),
  });
});

projectsRouter.post('/projects/:id/pages', async (req, res) => {
  const { project } = await projectAccess(req, req.params.id);
  const url = String(req.body?.url || '');
  let norm;
  try {
    norm = normalizePageUrl(url);
  } catch {
    throw new HttpError(400, 'Invalid page URL');
  }
  if (!isSameSite(norm, project.origin)) throw new HttpError(400, 'Page is not part of this website', 'other_site');
  const page = await upsertPage(project.id, norm, { title: req.body?.title, source: 'visited' });
  res.json({ page });
});
