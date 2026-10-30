import { Router } from 'express';
import multer from 'multer';
import { one, query, tx } from '../db/index.js';
import { HttpError, projectAccess, authorOf } from '../lib/auth.js';
import { hmac, safeEqual } from '../lib/crypto.js';
import * as storage from '../lib/storage.js';
import { enqueue } from '../lib/jobs.js';
import { isSameSite, normalizePageUrl } from '../lib/urls.js';
import { validate } from '../validation/index.js';
import { transcribe, serverTranscriptionProvider } from '../lib/transcribe.js';
import { queueNotification } from '../notifications/digest.js';
import { upsertPage } from './projects.js';
import { rateLimit } from '../lib/ratelimit.js';

export const commentsRouter = Router();
const BREAKPOINTS = ['desktop', 'tablet', 'mobile'];

// ---- signed file URLs (usable in <img>/<audio> without headers) ----
function signedUrl(type, id, { download = false } = {}) {
  const exp = Math.ceil(Date.now() / 3600000) * 3600 + 12 * 3600; // hour-aligned: cache friendly
  const sig = hmac(`file:${type}:${id}:${exp}`).slice(0, 24);
  return `/api/files/${type}/${id}?exp=${exp}&sig=${sig}${download ? '&download=1' : ''}`;
}

commentsRouter.get('/files/:type/:id', async (req, res) => {
  const { type, id } = req.params;
  const exp = Number(req.query.exp);
  if (!['att', 'shot'].includes(type) || !/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(404, 'Not found');
  if (!exp || exp * 1000 < Date.now() || !safeEqual(hmac(`file:${type}:${id}:${exp}`).slice(0, 24), String(req.query.sig || ''))) {
    throw new HttpError(403, 'Link expired');
  }
  const row = type === 'att'
    ? await one('SELECT storage_key, mime, original_name FROM attachments WHERE id = $1', [id])
    : await one(`SELECT s.storage_key, 'image/jpeg' AS mime, c.number, s.kind FROM screenshots s JOIN comments c ON c.id = s.comment_id WHERE s.id = $1 AND s.status = 'ready'`, [id]);
  if (!row?.storage_key) throw new HttpError(404, 'Not found');
  const st = await storage.stat(row.storage_key);
  if (!st) throw new HttpError(404, 'File missing');
  res.setHeader('content-type', row.mime);
  res.setHeader('content-length', st.size);
  res.setHeader('cache-control', 'private, max-age=3600');
  res.setHeader('x-content-type-options', 'nosniff');
  if (req.query.download) {
    const name = type === 'att' ? row.original_name || 'attachment' : `comment-${row.number}-${row.kind}.jpg`;
    res.setHeader('content-disposition', `attachment; filename="${name.replace(/[^\w.-]+/g, '_')}"`);
  }
  storage.stream(row.storage_key).pipe(res);
});

// ---- serialisation ----
async function loadThreads(projectId, where = '', params = [], viewer) {
  const roots = (
    await query(
      `SELECT c.*, pg.url AS page_url, pg.path AS page_path, pg.title AS page_title,
              a.locator, a.offset_rx, a.offset_ry, a.doc_x, a.doc_y, a.viewport_w, a.viewport_h, a.state AS anchor_state,
              d.shapes
       FROM comments c JOIN pages pg ON pg.id = c.page_id
       LEFT JOIN comment_anchors a ON a.comment_id = c.id
       LEFT JOIN drawings d ON d.comment_id = c.id
       WHERE c.project_id = $1 AND c.parent_id IS NULL ${where}
       ORDER BY c.number`,
      [projectId, ...params],
    )
  ).rows;
  if (!roots.length) return [];
  const ids = roots.map((r) => r.id);
  const replies = (await query(`SELECT * FROM comments WHERE parent_id = ANY($1) ORDER BY created_at`, [ids])).rows;
  const allIds = [...ids, ...replies.map((r) => r.id)];
  const atts = (
    await query(
      `SELECT a.*, t.text AS transcript, t.provider AS transcript_provider, t.status AS transcript_status
       FROM attachments a LEFT JOIN transcriptions t ON t.attachment_id = a.id WHERE a.comment_id = ANY($1) ORDER BY a.created_at`,
      [allIds],
    )
  ).rows;
  const shots = (await query(`SELECT * FROM screenshots WHERE comment_id = ANY($1)`, [ids])).rows;
  const isMine = (c) => (viewer.userId && c.author_user_id === viewer.userId) || (viewer.guestId && c.author_guest_id === viewer.guestId);
  const attDto = (a) => ({
    id: a.id, kind: a.kind, mime: a.mime, name: a.original_name, size: a.size_bytes,
    url: signedUrl('att', a.id), downloadUrl: signedUrl('att', a.id, { download: true }),
    transcript: a.transcript || null, transcriptProvider: a.transcript_provider || null,
  });
  const base = (c) => ({
    id: c.id, authorName: c.author_name, authorType: c.author_user_id ? 'owner' : 'guest', isMine: !!isMine(c),
    body: c.body, createdAt: c.created_at, editedAt: c.edited_at,
    attachments: atts.filter((a) => a.comment_id === c.id).map(attDto),
  });
  return roots.map((c) => {
    const s = {};
    for (const sh of shots.filter((x) => x.comment_id === c.id)) {
      s[sh.kind] = {
        id: sh.id, status: sh.status, width: sh.width, height: sh.height, error: sh.status === 'failed' ? sh.error : undefined,
        url: sh.status === 'ready' ? signedUrl('shot', sh.id) : null,
        downloadUrl: sh.status === 'ready' ? signedUrl('shot', sh.id, { download: true }) : null,
      };
    }
    return {
      ...base(c),
      number: c.number, status: c.status, resolvedAt: c.resolved_at, resolvedByName: c.resolved_by_name,
      breakpoint: c.breakpoint, pageId: c.page_id, pageUrl: c.page_url, pagePath: c.page_path, pageTitle: c.page_title,
      anchor: c.locator ? { locator: c.locator, rx: c.offset_rx, ry: c.offset_ry, docX: c.doc_x, docY: c.doc_y, viewportW: c.viewport_w, viewportH: c.viewport_h, state: c.anchor_state } : null,
      drawing: c.shapes || null,
      screenshots: s,
      replies: replies.filter((r) => r.parent_id === c.id).map(base),
    };
  });
}

const viewerOf = (req, role) => ({ userId: role === 'owner' ? req.user.id : null, guestId: req.guest?.id || null });

commentsRouter.get('/projects/:id/comments', async (req, res) => {
  const { project, role } = await projectAccess(req, req.params.id);
  const conds = [];
  const params = [];
  if (req.query.pageId) { params.push(String(req.query.pageId)); conds.push(`AND c.page_id = $${params.length + 1}`); }
  if (['open', 'resolved'].includes(req.query.status)) { params.push(req.query.status); conds.push(`AND c.status = $${params.length + 1}`); }
  if (BREAKPOINTS.includes(req.query.breakpoint)) { params.push(req.query.breakpoint); conds.push(`AND c.breakpoint = $${params.length + 1}`); }
  res.json({ comments: await loadThreads(project.id, conds.join(' '), params, viewerOf(req, role)) });
});

async function loadOne(req, commentId) {
  if (!/^[0-9a-f-]{36}$/.test(commentId)) throw new HttpError(404, 'Comment not found');
  const c = await one('SELECT * FROM comments WHERE id = $1', [commentId]);
  if (!c) throw new HttpError(404, 'Comment not found');
  const access = await projectAccess(req, c.project_id);
  return { c, ...access };
}

function checkShapes(shapes) {
  if (shapes == null) return null;
  if (!Array.isArray(shapes) || shapes.length > 100) throw new HttpError(400, 'Invalid drawing');
  let total = 0;
  return shapes.map((s) => {
    if (!['arrow', 'circle', 'rect', 'free'].includes(s?.type)) throw new HttpError(400, 'Invalid drawing shape');
    const pts = (s.points || []).slice(0, 2000).map((p) => ({
      x: Number(p.x), y: Number(p.y), ...(p.rel ? { rel: { x: Number(p.rel.x), y: Number(p.rel.y) } } : {}),
    }));
    total += pts.length;
    if (total > 6000 || pts.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw new HttpError(400, 'Invalid drawing');
    return { type: s.type, color: /^#[0-9a-f]{3,8}$/i.test(s.color) ? s.color : '#ef4444', width: Math.min(12, Math.max(1, Number(s.width) || 4)), points: pts };
  });
}

commentsRouter.post('/projects/:id/comments', rateLimit({ windowMs: 60000, max: 30 }), async (req, res) => {
  const { project, role } = await projectAccess(req, req.params.id);
  const author = authorOf(req, role);
  const b = req.body || {};
  const body = String(b.body || '').trim().slice(0, 5000);
  const attachmentIds = Array.isArray(b.attachmentIds) ? b.attachmentIds.filter((x) => /^[0-9a-f-]{36}$/.test(x)).slice(0, 10) : [];
  const atts = attachmentIds.length
    ? (await query(`SELECT id, kind FROM attachments WHERE id = ANY($1) AND project_id = $2 AND comment_id IS NULL AND uploader_key = $3`, [attachmentIds, project.id, author.key])).rows
    : [];
  if (atts.length !== attachmentIds.length) throw new HttpError(400, 'One of the attachments is invalid or already used');

  // ---- reply ----
  if (b.parentId) {
    const parent = await one('SELECT * FROM comments WHERE id = $1 AND project_id = $2 AND parent_id IS NULL', [b.parentId, project.id]);
    if (!parent) throw new HttpError(404, 'Thread not found');
    if (!body && !atts.length) throw new HttpError(400, 'Reply cannot be empty');
    const reply = await tx(async (c) => {
      const r = (await c.query(
        `INSERT INTO comments (project_id, page_id, parent_id, author_user_id, author_guest_id, author_name, body) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [project.id, parent.page_id, parent.id, author.userId, author.guestId, author.name, body],
      )).rows[0];
      if (atts.length) await c.query('UPDATE attachments SET comment_id = $1 WHERE id = ANY($2)', [r.id, attachmentIds]);
      return r;
    });
    if (role !== 'owner') await queueNotification({ ownerId: project.owner_id, projectId: project.id, commentId: reply.id });
    const [thread] = await loadThreads(project.id, 'AND c.id = $2', [parent.id], viewerOf(req, role));
    return res.status(201).json({ comment: thread });
  }

  // ---- new thread ----
  if (!BREAKPOINTS.includes(b.breakpoint)) throw new HttpError(400, 'Invalid breakpoint');
  const a = b.anchor || {};
  if (!a.locator || typeof a.locator !== 'object' || JSON.stringify(a.locator).length > 30000) throw new HttpError(400, 'Invalid anchor');
  const nums = ['rx', 'ry', 'docX', 'docY', 'viewportW', 'viewportH'].map((k) => Number(a[k]));
  if (nums.some((n) => !Number.isFinite(n))) throw new HttpError(400, 'Invalid anchor');
  let pageUrl;
  try { pageUrl = normalizePageUrl(String(b.pageUrl)); } catch { throw new HttpError(400, 'Invalid page URL'); }
  if (!isSameSite(pageUrl, project.origin)) throw new HttpError(400, 'Page is not part of this website');
  const shapes = checkShapes(b.drawing?.shapes?.length ? b.drawing.shapes : null);

  const validation = await validate({
    text: body,
    attachments: { images: atts.filter((x) => x.kind === 'image').length, audio: atts.filter((x) => x.kind === 'audio').length },
    element: { tag: a.locator.tag, isImage: !!a.locator.isImage },
  });
  if (!validation.canSubmit) return res.status(422).json({ error: 'Feedback needs more detail', code: 'validation_failed', validation });

  const page = await upsertPage(project.id, pageUrl, { title: b.pageTitle });
  const created = await tx(async (c) => {
    const n = (await c.query('UPDATE projects SET next_comment_number = next_comment_number + 1 WHERE id = $1 RETURNING next_comment_number - 1 AS n', [project.id])).rows[0].n;
    const r = (await c.query(
      `INSERT INTO comments (project_id, page_id, number, breakpoint, author_user_id, author_guest_id, author_name, body)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [project.id, page.id, n, b.breakpoint, author.userId, author.guestId, author.name, body],
    )).rows[0];
    const [rx, ry, docX, docY, vw, vh] = nums;
    await c.query(
      `INSERT INTO comment_anchors (comment_id, breakpoint, viewport_w, viewport_h, locator, offset_rx, offset_ry, doc_x, doc_y)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [r.id, b.breakpoint, Math.round(vw), Math.round(vh), a.locator, Math.min(1, Math.max(0, rx)), Math.min(1, Math.max(0, ry)), docX, docY],
    );
    if (shapes) await c.query('INSERT INTO drawings (comment_id, shapes) VALUES ($1, $2)', [r.id, JSON.stringify(shapes)]);
    if (atts.length) await c.query('UPDATE attachments SET comment_id = $1 WHERE id = ANY($2)', [r.id, attachmentIds]);
    await c.query(`INSERT INTO screenshots (comment_id, kind) VALUES ($1, 'full'), ($1, 'crop')`, [r.id]);
    return r;
  });
  await enqueue('screenshot', { commentId: created.id }, { maxAttempts: 3 });
  if (role !== 'owner') await queueNotification({ ownerId: project.owner_id, projectId: project.id, commentId: created.id });
  const [thread] = await loadThreads(project.id, 'AND c.id = $2', [created.id], viewerOf(req, role));
  res.status(201).json({ comment: thread, validation });
});

commentsRouter.patch('/comments/:id', async (req, res) => {
  const { c, project, role } = await loadOne(req, req.params.id);
  const isAuthor = (role === 'owner' && c.author_user_id === req.user?.id) || (req.guest && c.author_guest_id === req.guest.id);
  if (!isAuthor) throw new HttpError(403, 'You can only edit your own comments');
  const body = String(req.body?.body || '').trim().slice(0, 5000);
  if (!body) throw new HttpError(400, 'Comment cannot be empty');
  if (!c.parent_id) {
    const anchor = await one('SELECT locator FROM comment_anchors WHERE comment_id = $1', [c.id]);
    const imgs = await one(`SELECT count(*)::int AS n FROM attachments WHERE comment_id = $1 AND kind = 'image'`, [c.id]);
    const validation = await validate({ text: body, attachments: { images: imgs.n }, element: { tag: anchor?.locator?.tag, isImage: !!anchor?.locator?.isImage } });
    if (!validation.canSubmit) return res.status(422).json({ error: 'Feedback needs more detail', code: 'validation_failed', validation });
  }
  await query('UPDATE comments SET body = $2, edited_at = now() WHERE id = $1', [c.id, body]);
  const [thread] = await loadThreads(project.id, 'AND c.id = $2', [c.parent_id || c.id], viewerOf(req, role));
  res.json({ comment: thread });
});

commentsRouter.delete('/comments/:id', async (req, res) => {
  const { c, project, role } = await loadOne(req, req.params.id);
  const isAuthor = (role === 'owner' && c.author_user_id === req.user?.id) || (req.guest && c.author_guest_id === req.guest.id);
  if (!isAuthor && role !== 'owner') throw new HttpError(403, 'You can only delete your own comments');
  const files = (
    await query(
      `SELECT storage_key FROM attachments WHERE comment_id = $1 OR comment_id IN (SELECT id FROM comments WHERE parent_id = $1)
       UNION ALL SELECT storage_key FROM screenshots WHERE comment_id = $1 AND storage_key IS NOT NULL`,
      [c.id],
    )
  ).rows;
  await query('DELETE FROM comments WHERE id = $1', [c.id]);
  for (const f of files) await storage.remove(f.storage_key).catch(() => {});
  res.json({ ok: true, projectId: project.id });
});

commentsRouter.post('/comments/:id/resolve', async (req, res) => {
  const { c, project, role } = await loadOne(req, req.params.id);
  if (c.parent_id) throw new HttpError(400, 'Only threads can be resolved');
  const resolved = !!req.body?.resolved;
  const by = role === 'owner' ? req.user.name || req.user.email.split('@')[0] : req.guest?.name;
  if (role === 'guest' && !req.guest) throw new HttpError(401, 'Please enter your name first', 'guest_required');
  await query(
    `UPDATE comments SET status = $2, resolved_at = CASE WHEN $2 = 'resolved' THEN now() END, resolved_by_name = CASE WHEN $2 = 'resolved' THEN $3 END WHERE id = $1`,
    [c.id, resolved ? 'resolved' : 'open', by],
  );
  const [thread] = await loadThreads(project.id, 'AND c.id = $2', [c.id], viewerOf(req, role));
  res.json({ comment: thread });
});

// The viewer's browser reports whether the anchor could be found again.
commentsRouter.post('/comments/:id/anchor-state', async (req, res) => {
  const { c } = await loadOne(req, req.params.id);
  const state = req.body?.state === 'ok' ? 'ok' : 'needs_attention';
  await query('UPDATE comment_anchors SET state = $2, last_checked_at = now() WHERE comment_id = $1', [c.id, state]);
  res.json({ ok: true });
});

commentsRouter.post('/comments/:id/screenshots/retry', async (req, res) => {
  const { c } = await loadOne(req, req.params.id);
  await query(`UPDATE screenshots SET status = 'pending', error = NULL WHERE comment_id = $1 AND status = 'failed'`, [c.id]);
  await enqueue('screenshot', { commentId: c.id }, { maxAttempts: 2 });
  res.json({ ok: true });
});

// ---- validation (live, while typing) ----
commentsRouter.post('/validate', rateLimit({ windowMs: 60000, max: 120 }), async (req, res) => {
  const b = req.body || {};
  res.json(await validate({ text: String(b.text || '').slice(0, 5000), attachments: b.attachments || {}, element: b.element || {} }));
});

// ---- uploads ----
const IMAGE_TYPES = { 'image/png': [0x89, 0x50], 'image/jpeg': [0xff, 0xd8], 'image/gif': [0x47, 0x49], 'image/webp': [0x52, 0x49] };
const AUDIO_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/x-m4a', 'audio/aac'];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });

commentsRouter.post('/projects/:id/attachments', rateLimit({ windowMs: 60000, max: 40 }), upload.single('file'), async (req, res) => {
  const { project, role } = await projectAccess(req, req.params.id);
  const author = authorOf(req, role);
  const f = req.file;
  if (!f) throw new HttpError(400, 'No file uploaded');
  const mime = f.mimetype.split(';')[0].toLowerCase();
  let kind;
  if (IMAGE_TYPES[mime]) {
    const magic = IMAGE_TYPES[mime];
    if (f.buffer[0] !== magic[0] || f.buffer[1] !== magic[1]) throw new HttpError(400, 'The file is not a valid image');
    if (f.size > 10 * 1024 * 1024) throw new HttpError(400, 'Images can be at most 10 MB');
    kind = 'image';
  } else if (AUDIO_TYPES.includes(mime)) {
    kind = 'audio';
  } else {
    throw new HttpError(400, 'Only PNG, JPEG, GIF and WebP images or audio recordings can be attached');
  }
  const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' }[mime] || (mime.includes('ogg') ? '.ogg' : mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac') ? '.m4a' : mime.includes('mpeg') ? '.mp3' : mime.includes('wav') ? '.wav' : '.webm');
  const key = storage.newKey(`attachments/${project.id}`, ext);
  await storage.put(key, f.buffer);
  const att = await one(
    `INSERT INTO attachments (project_id, kind, storage_key, mime, size_bytes, original_name, uploader_key) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [project.id, kind, key, mime, f.size, String(f.originalname || '').slice(0, 200), author.key],
  );
  let transcript = null;
  if (kind === 'audio') {
    let provider = 'browser-speech';
    let text = String(req.body?.transcript || '').trim().slice(0, 10000) || null;
    let status = text ? 'done' : 'failed';
    let error = text ? null : 'No transcription available';
    if (serverTranscriptionProvider()) {
      try {
        const r = await transcribe(f.buffer, mime);
        provider = r.provider;
        text = r.text;
        status = 'done';
        error = null;
      } catch (e) {
        error = e.message;
        if (!text) status = 'failed';
      }
    }
    await query('INSERT INTO transcriptions (attachment_id, text, provider, status, error) VALUES ($1,$2,$3,$4,$5)', [att.id, text, provider, status, error]);
    transcript = { text, provider, status, error };
  }
  res.status(201).json({ attachment: { id: att.id, kind, mime, name: f.originalname, size: f.size, url: signedUrl('att', att.id), transcript } });
});

commentsRouter.delete('/attachments/:id', async (req, res) => {
  const a = await one('SELECT * FROM attachments WHERE id = $1 AND comment_id IS NULL', [req.params.id]);
  if (!a) throw new HttpError(404, 'Attachment not found');
  const { role } = await projectAccess(req, a.project_id);
  if (authorOf(req, role).key !== a.uploader_key) throw new HttpError(403, 'Not your attachment');
  await query('DELETE FROM attachments WHERE id = $1', [a.id]);
  await storage.remove(a.storage_key).catch(() => {});
  res.json({ ok: true });
});
