import crypto from 'node:crypto';
import { config } from '../config.js';

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function hmac(data) {
  return crypto.createHmac('sha256', config.appSecret).update(data).digest('base64url');
}

export function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// AES-256-GCM for secrets at rest (site passwords, site auth cookies).
export function encrypt(plain) {
  if (plain == null) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', config.encryptionKey, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
}

export function decrypt(blob) {
  if (!blob) return null;
  try {
    const [iv, tag, enc] = blob.split('.').map((s) => Buffer.from(s, 'base64url'));
    const d = crypto.createDecipheriv('aes-256-gcm', config.encryptionKey, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// Signed, expiring proxy token: "<projectId>.<expUnix>.<sig>".
// The proxy origin is stateless about authorization: a valid token means the
// app (owner session or valid share link) granted access to this project.
export function signProxyToken(projectId, ttlSeconds = config.proxy.tokenTtlSeconds) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const short = projectId.replace(/-/g, '');
  const body = `${short}.${exp.toString(36)}`;
  return `${body}.${hmac('proxy:' + body).slice(0, 22)}`;
}

export function verifyProxyToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [short, exp36, sig] = parts;
  if (!/^[0-9a-f]{32}$/.test(short)) return null;
  if (!safeEqual(hmac(`proxy:${short}.${exp36}`).slice(0, 22), sig)) return null;
  if (parseInt(exp36, 36) * 1000 < Date.now()) return null;
  const id = `${short.slice(0, 8)}-${short.slice(8, 12)}-${short.slice(12, 16)}-${short.slice(16, 20)}-${short.slice(20)}`;
  return { projectId: id };
}
