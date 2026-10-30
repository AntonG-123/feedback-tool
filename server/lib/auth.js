import { one } from '../db/index.js';
import { sha256, safeEqual } from './crypto.js';
import { config } from '../config.js';

export const SESSION_COOKIE = 'agm_session';

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.appOrigin.startsWith('https://'),
    maxAge: 30 * 24 * 3600 * 1000,
    path: '/',
  };
}

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Populates req.user (owner session) and req.guest (guest identity) when present.
export async function identify(req, _res, next) {
  try {
    const st = req.cookies?.[SESSION_COOKIE];
    if (st) {
      req.user = await one(
        `SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > now()`,
        [sha256(st)],
      );
    }
    const gt = req.get('x-guest-token');
    if (gt && gt.includes('.')) {
      const [gid, secret] = gt.split('.');
      if (/^[0-9a-f-]{36}$/.test(gid)) {
        const g = await one('SELECT id, name, secret_hash FROM guests WHERE id = $1', [gid]);
        if (g && safeEqual(g.secret_hash, sha256(secret))) req.guest = { id: g.id, name: g.name };
      }
    }
    next();
  } catch (e) {
    next(e);
  }
}

export function requireUser(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Please log in', 'unauthenticated'));
  next();
}

// Returns the share link row if the token is valid for use right now.
export async function validShareLink(token) {
  if (!token || token.length < 20) return null;
  const link = await one('SELECT * FROM share_links WHERE token = $1', [token]);
  if (!link) return null;
  if (!link.enabled || link.revoked_at) return { ...link, invalidReason: 'revoked' };
  if (link.expires_at && new Date(link.expires_at) < new Date()) return { ...link, invalidReason: 'expired' };
  return link;
}

// Resolves what the caller may do in a project:
//   owner  - logged-in owner of the project
//   guest  - holder of a valid share link (X-Share-Token header)
export async function projectAccess(req, projectId) {
  if (!/^[0-9a-f-]{36}$/.test(projectId)) throw new HttpError(404, 'Project not found');
  const project = await one('SELECT * FROM projects WHERE id = $1', [projectId]);
  if (!project) throw new HttpError(404, 'Project not found');
  if (req.user && project.owner_id === req.user.id) return { project, role: 'owner' };
  const st = req.get('x-share-token');
  if (st) {
    const link = await validShareLink(st);
    if (link && !link.invalidReason && link.project_id === projectId) return { project, role: 'guest' };
    if (link?.invalidReason) throw new HttpError(410, 'This share link is no longer valid', 'share_' + link.invalidReason);
  }
  throw new HttpError(req.user ? 403 : 401, 'You do not have access to this project', 'forbidden');
}

// The identity that authors comments. Owners comment as themselves; guests
// need a registered guest identity (name prompt on first comment).
export function authorOf(req, role) {
  if (role === 'owner') return { userId: req.user.id, guestId: null, name: req.user.name || req.user.email.split('@')[0], key: `user:${req.user.id}` };
  if (!req.guest) throw new HttpError(401, 'Please enter your name before commenting', 'guest_required');
  return { userId: null, guestId: req.guest.id, name: req.guest.name, key: `guest:${req.guest.id}` };
}
