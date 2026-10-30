// Thin API client. Guests authenticate with the share token (X-Share-Token)
// and their guest identity (X-Guest-Token, stored in localStorage).

const GUEST_KEY = 'agm_guest';
let shareToken: string | null = null;

export function setShareToken(t: string | null) {
  shareToken = t;
}

export type Guest = { id: string; name: string; token: string };

export function getGuest(): Guest | null {
  try {
    return JSON.parse(localStorage.getItem(GUEST_KEY) || 'null');
  } catch {
    return null;
  }
}
export function saveGuest(g: Guest) {
  try {
    localStorage.setItem(GUEST_KEY, JSON.stringify(g));
  } catch {}
}

export class ApiError extends Error {
  status: number;
  code?: string;
  data?: any;
  constructor(status: number, message: string, code?: string, data?: any) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

function headers(extra: Record<string, string> = {}) {
  const h: Record<string, string> = { ...extra };
  if (shareToken) h['x-share-token'] = shareToken;
  const g = getGuest();
  if (g?.token) h['x-guest-token'] = g.token;
  return h;
}

export async function api<T = any>(path: string, opts: { method?: string; body?: any; form?: FormData; signal?: AbortSignal } = {}): Promise<T> {
  const init: RequestInit = { method: opts.method || (opts.body || opts.form ? 'POST' : 'GET'), credentials: 'same-origin', signal: opts.signal };
  if (opts.form) {
    init.body = opts.form;
    init.headers = headers();
  } else if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    init.headers = headers({ 'content-type': 'application/json' });
  } else init.headers = headers();
  let res: Response;
  try {
    res = await fetch('/api' + path, init);
  } catch (e: any) {
    if (e?.name === 'AbortError') throw e;
    throw new ApiError(0, 'Network error — check your connection.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || res.statusText, data.code, data);
  return data;
}

export async function ensureGuest(name: string): Promise<Guest> {
  const existing = getGuest();
  if (existing && existing.name === name) return existing;
  if (existing) {
    try {
      await api('/guests/me', { method: 'PATCH', body: { name } });
      const g = { ...existing, name };
      saveGuest(g);
      return g;
    } catch {}
  }
  const r = await api('/guests', { body: { name } });
  const g = { id: r.guest.id, name: r.guest.name, token: r.token };
  saveGuest(g);
  return g;
}
