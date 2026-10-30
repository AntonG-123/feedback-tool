// Batched owner notifications: new comments are queued; at most one email per
// owner per NOTIFY_INTERVAL_MS (default 1 hour) summarises everything queued.
// Sending also waits NOTIFY_SETTLE_MS after the oldest pending comment, so
// a review session produces one email instead of one per comment.
import { query, tx } from '../db/index.js';
import { config } from '../config.js';
import { sendEmail, escapeHtml } from '../lib/email.js';

export async function queueNotification({ ownerId, projectId, commentId }) {
  await query('INSERT INTO notification_queue (owner_id, project_id, comment_id) VALUES ($1, $2, $3)', [ownerId, projectId, commentId]);
}

export async function sendDueDigests() {
  const intervalSec = Math.round(config.notifications.intervalMs / 1000);
  const settleSec = config.notifications.settleMs / 1000;
  const owners = (
    await query(
      `SELECT q.owner_id, u.email FROM notification_queue q JOIN users u ON u.id = q.owner_id
       WHERE q.batch_id IS NULL
       GROUP BY q.owner_id, u.email
       HAVING min(q.created_at) <= now() - ($2 || ' seconds')::interval
       AND NOT EXISTS (
         SELECT 1 FROM notification_batches b WHERE b.owner_id = q.owner_id AND b.sent_at > now() - ($1 || ' seconds')::interval
       )`,
      [String(intervalSec), String(settleSec)],
    )
  ).rows;
  let sent = 0;
  for (const o of owners) {
    await tx(async (c) => {
      const items = (
        await c.query(
          `SELECT q.id, c.number, c.body, c.author_name, c.created_at, c.parent_id, p.name AS project_name, p.id AS project_id, pg.path
           FROM notification_queue q JOIN comments c ON c.id = q.comment_id JOIN projects p ON p.id = q.project_id
           JOIN pages pg ON pg.id = c.page_id
           WHERE q.owner_id = $1 AND q.batch_id IS NULL ORDER BY q.created_at FOR UPDATE OF q SKIP LOCKED`,
          [o.owner_id],
        )
      ).rows;
      if (!items.length) return;
      const byProject = new Map();
      for (const it of items) {
        if (!byProject.has(it.project_id)) byProject.set(it.project_id, { name: it.project_name, items: [] });
        byProject.get(it.project_id).items.push(it);
      }
      const text = [...byProject.entries()].map(([id, p]) =>
        `${p.name} (${p.items.length})\n${config.appOrigin}/projects/${id}/comments\n` +
        p.items.map((i) => `  #${i.number ?? ''} ${i.parent_id ? '(reply) ' : ''}${i.author_name} on ${i.path}: ${i.body.slice(0, 200)}`).join('\n'),
      ).join('\n\n');
      const html = [...byProject.entries()].map(([id, p]) =>
        `<h3 style="margin:16px 0 4px">${escapeHtml(p.name)} — ${p.items.length} new</h3><ul>` +
        p.items.map((i) => `<li><b>${escapeHtml(i.author_name)}</b> ${i.parent_id ? 'replied' : `commented #${i.number}`} on <code>${escapeHtml(i.path)}</code>: ${escapeHtml(i.body.slice(0, 200))}</li>`).join('') +
        `</ul><a href="${escapeHtml(`${config.appOrigin}/projects/${id}/comments`)}">Open comments</a>`,
      ).join('');
      const delivery = await sendEmail({
        to: o.email,
        subject: `${items.length} new comment${items.length > 1 ? 's' : ''} on AGM Feedback`,
        text: `You have new feedback:\n\n${text}`,
        html: `<div style="font-family:system-ui,sans-serif">${html}</div>`,
      });
      const b = (await c.query('INSERT INTO notification_batches (owner_id, comment_count, delivery) VALUES ($1, $2, $3) RETURNING id', [o.owner_id, items.length, delivery])).rows[0];
      await c.query('UPDATE notification_queue SET batch_id = $1 WHERE id = ANY($2)', [b.id, items.map((i) => i.id)]);
      sent++;
    });
  }
  return sent;
}

let timer;
export function startDigestLoop() {
  const run = () => sendDueDigests().catch((e) => console.error('[notify]', e.message));
  timer = setInterval(run, config.notifications.checkEveryMs);
  setTimeout(run, 5000);
}
export function stopDigestLoop() {
  clearInterval(timer);
}
