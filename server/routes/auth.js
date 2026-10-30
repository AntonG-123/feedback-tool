import { Router } from 'express';
import { one, query, tx } from '../db/index.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { sendEmail, emailDelivery, escapeHtml } from '../lib/email.js';
import { config } from '../config.js';
import { HttpError, SESSION_COOKIE, sessionCookieOptions } from '../lib/auth.js';

export const authRouter = Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

authRouter.post('/auth/request', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 200) throw new HttpError(400, 'Please enter a valid email address', 'invalid_email');
  const recent = await one(
    `SELECT count(*)::int AS n FROM magic_links WHERE email = $1 AND created_at > now() - interval '15 minutes'`,
    [email],
  );
  if (recent.n >= 5) throw new HttpError(429, 'Too many login requests. Please wait a few minutes.', 'rate_limited');

  const token = randomToken(32);
  await query(`INSERT INTO magic_links (email, token_hash, expires_at) VALUES ($1, $2, now() + interval '20 minutes')`, [email, sha256(token)]);
  const link = `${config.appOrigin}/auth/verify?token=${token}`;
  const delivery = await sendEmail({
    to: email,
    subject: 'Your AGM Feedback login link',
    text: `Click to log in to AGM Feedback:\n\n${link}\n\nThe link expires in 20 minutes. If you did not request it, ignore this email.`,
    html: `<p>Click to log in to AGM Feedback:</p><p><a href="${escapeHtml(link)}">Log in to AGM Feedback</a></p><p style="color:#666">The link expires in 20 minutes. If you did not request it, ignore this email.</p>`,
  });
  const out = { ok: true, delivery };
  // Evaluation mode only: no email provider configured, so show the link.
  if (delivery === 'log' && config.devLoginLinks) out.devLink = link;
  res.json(out);
});

authRouter.post('/auth/verify', async (req, res) => {
  const token = String(req.body?.token || '');
  const result = await tx(async (c) => {
    const ml = (await c.query(`SELECT * FROM magic_links WHERE token_hash = $1 FOR UPDATE`, [sha256(token)])).rows[0];
    if (!ml) throw new HttpError(400, 'This login link is invalid.', 'invalid_link');
    if (ml.used_at) throw new HttpError(400, 'This login link has already been used. Please request a new one.', 'used_link');
    if (new Date(ml.expires_at) < new Date()) throw new HttpError(400, 'This login link has expired. Please request a new one.', 'expired_link');
    await c.query('UPDATE magic_links SET used_at = now() WHERE id = $1', [ml.id]);
    const user = (
      await c.query(
        `INSERT INTO users (email, last_login_at) VALUES ($1, now())
         ON CONFLICT (email) DO UPDATE SET last_login_at = now() RETURNING id, email, name`,
        [ml.email],
      )
    ).rows[0];
    const st = randomToken(32);
    await c.query(`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '30 days')`, [user.id, sha256(st)]);
    return { user, st };
  });
  res.cookie(SESSION_COOKIE, result.st, sessionCookieOptions());
  res.json({ user: result.user });
});

authRouter.get('/auth/me', (req, res) => {
  res.json({ user: req.user || null, emailDelivery: emailDelivery() });
});

authRouter.patch('/auth/me', async (req, res) => {
  if (!req.user) throw new HttpError(401, 'Please log in');
  const name = String(req.body?.name || '').trim().slice(0, 80) || null;
  const user = await one('UPDATE users SET name = $2 WHERE id = $1 RETURNING id, email, name', [req.user.id, name]);
  res.json({ user });
});

authRouter.post('/auth/logout', async (req, res) => {
  const st = req.cookies?.[SESSION_COOKIE];
  if (st) await query('DELETE FROM sessions WHERE token_hash = $1', [sha256(st)]);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

// Guest identity: name only, plus a secret that proves ownership of comments.
authRouter.post('/guests', async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 80);
  if (name.length < 2) throw new HttpError(400, 'Please enter your name', 'invalid_name');
  const secret = randomToken(24);
  const g = await one('INSERT INTO guests (name, secret_hash) VALUES ($1, $2) RETURNING id, name', [name, sha256(secret)]);
  res.json({ guest: g, token: `${g.id}.${secret}` });
});

authRouter.patch('/guests/me', async (req, res) => {
  if (!req.guest) throw new HttpError(401, 'Unknown guest');
  const name = String(req.body?.name || '').trim().slice(0, 80);
  if (name.length < 2) throw new HttpError(400, 'Please enter your name', 'invalid_name');
  const g = await one('UPDATE guests SET name = $2 WHERE id = $1 RETURNING id, name', [req.guest.id, name]);
  res.json({ guest: g });
});
