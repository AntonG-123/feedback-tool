// Small in-memory fixed-window rate limiter (per client IP). Sufficient for a
// single-instance deployment; use a shared store when running replicas.
import { HttpError } from './auth.js';

export function rateLimit({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => hits.clear(), windowMs).unref();
  return (req, _res, next) => {
    const key = req.ip;
    const n = (hits.get(key) || 0) + 1;
    hits.set(key, n);
    if (n > max) return next(new HttpError(429, 'Too many requests, please slow down', 'rate_limited'));
    next();
  };
}
