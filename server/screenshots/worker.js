// Screenshot job: renders the commented page server-side at the comment's
// viewport through our own proxy, resolves the anchor, burns drawings and the
// pin into the page (SVG layer), then stores a full-page and an element crop.
import { one, query } from '../db/index.js';
import { config } from '../config.js';
import { signProxyToken } from '../lib/crypto.js';
import * as storage from '../lib/storage.js';
import { getBrowser, autoScroll, guardRoutes } from './browser.js';

const PIN_COLOR = '#5b5bf6';

export function proxyUrlFor(projectId, pageUrl) {
  const u = new URL(pageUrl);
  return `${config.proxyInternalOrigin}/p/${signProxyToken(projectId, 600)}/${u.protocol.slice(0, -1)}/${u.host}${u.pathname}${u.search}`;
}

// Converts stored drawing shapes to document coordinates of the freshly
// rendered page: element-relative points are preferred, so the drawing
// follows the element even when the layout above it changed.
export function placeShapes(shapes, elementRect, foundElement) {
  return (shapes || []).map((s) => ({
    ...s,
    points: (s.points || []).map((p) =>
      foundElement && p.rel ? { x: elementRect.x + p.rel.x, y: elementRect.y + p.rel.y } : { x: p.x, y: p.y },
    ),
  }));
}

export function cropRegion(target, shapes, page, { pad = 160, minW = 720, minH = 420 } = {}) {
  let x1 = target.x, y1 = target.y, x2 = target.x + target.w, y2 = target.y + target.h;
  for (const s of shapes) for (const p of s.points) {
    x1 = Math.min(x1, p.x); y1 = Math.min(y1, p.y); x2 = Math.max(x2, p.x); y2 = Math.max(y2, p.y);
  }
  x1 -= pad; y1 -= pad; x2 += pad; y2 += pad;
  if (x2 - x1 < minW) { const c = (x1 + x2) / 2; x1 = c - minW / 2; x2 = c + minW / 2; }
  if (y2 - y1 < minH) { const c = (y1 + y2) / 2; y1 = c - minH / 2; y2 = c + minH / 2; }
  const w = Math.min(x2 - x1, page.w), h = Math.min(y2 - y1, Math.min(page.h, 3000));
  x1 = Math.max(0, Math.min(x1, page.w - w));
  y1 = Math.max(0, Math.min(y1, page.h - h));
  return { x: Math.round(x1), y: Math.round(y1), width: Math.round(w), height: Math.round(h) };
}

export async function captureCommentScreenshots({ commentId }) {
  const c = await one(
    `SELECT c.id, c.number, c.project_id, p.url AS page_url, a.locator, a.offset_rx, a.offset_ry, a.doc_x, a.doc_y,
            a.viewport_w, a.viewport_h, d.shapes
     FROM comments c JOIN pages p ON p.id = c.page_id
     JOIN comment_anchors a ON a.comment_id = c.id
     LEFT JOIN drawings d ON d.comment_id = c.id
     WHERE c.id = $1`,
    [commentId],
  );
  if (!c) return; // comment deleted meanwhile
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: Math.max(320, Math.min(c.viewport_w, 2560)), height: Math.max(480, Math.min(c.viewport_h, 1600)) },
    deviceScaleFactor: 1,
  });
  try {
    await guardRoutes(context);
    const page = await context.newPage();
    await page.goto(proxyUrlFor(c.project_id, c.page_url), { waitUntil: 'load', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
    const err = await page.$('[data-agm-error]');
    if (err) throw new Error('Proxy error page: ' + (await err.getAttribute('data-agm-error')));
    await autoScroll(page);
    await page.waitForFunction(() => !!window.__agmResolve, null, { timeout: 10000 });
    const res = await page.evaluate(
      ([L, rx, ry, dx, dy]) => window.__agmResolve(L, rx, ry, dx, dy),
      [c.locator, c.offset_rx, c.offset_ry, c.doc_x, c.doc_y],
    );
    const shapes = placeShapes(c.shapes, res.rect, res.found);
    const size = await page.evaluate(
      ([s, pin]) => window.__agmAnnotate(s, pin),
      [shapes, { x: res.point.x, y: res.point.y, number: c.number, color: PIN_COLOR }],
    );
    await page.waitForTimeout(150);

    const maxH = config.screenshots.maxFullPageHeight;
    const full = await page.screenshot({
      fullPage: true, type: 'jpeg', quality: 78,
      ...(size.h > maxH ? { clip: { x: 0, y: 0, width: size.w, height: maxH } } : {}),
    });
    const target = { x: res.rect.x, y: res.rect.y, w: res.rect.w, h: res.rect.h };
    const region = cropRegion(target, shapes, size);
    const crop = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 85, clip: region });

    for (const [kind, buf, w, h] of [
      ['full', full, size.w, Math.min(size.h, maxH)],
      ['crop', crop, region.width, region.height],
    ]) {
      const key = storage.newKey(`screenshots/${c.project_id}`, '.jpg');
      await storage.put(key, buf);
      await query(
        `UPDATE screenshots SET status = 'ready', storage_key = $3, width = $4, height = $5, error = NULL, updated_at = now()
         WHERE comment_id = $1 AND kind = $2`,
        [c.id, kind, key, Math.round(w), Math.round(h)],
      );
    }
    if (!res.found) await query(`UPDATE comment_anchors SET state = 'needs_attention', last_checked_at = now() WHERE comment_id = $1`, [c.id]);
  } finally {
    await context.close().catch(() => {});
  }
}

export async function markScreenshotsFailed({ commentId }, e) {
  await query(`UPDATE screenshots SET status = 'failed', error = $2, updated_at = now() WHERE comment_id = $1 AND status = 'pending'`, [
    commentId,
    String(e?.message || e).slice(0, 500),
  ]);
}
