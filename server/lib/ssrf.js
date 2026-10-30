// SSRF protection for every outbound request the proxy, discovery and
// screenshot pipelines make.
//
// - Only http/https, only standard web ports.
// - Hostnames are resolved and EVERY resolved address must be public.
// - The validated address is the one used for the connection (custom lookup
//   on the undici Agent), so DNS rebinding between check and connect is not
//   possible.
// - Redirects are never followed automatically; each hop is re-validated.
import net from 'node:net';
import dns from 'node:dns';
import { Agent } from 'undici';
import { config } from '../config.js';

const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
  ['2001:db8::', 32], ['100::', 64], ['2001::', 23],
  // NAT64 prefixes can embed any IPv4 address (incl. 127.0.0.1) in hex form.
  ['64:ff9b::', 96], ['64:ff9b:1::', 48],
]) blocked.addSubnet(addr, prefix, 'ipv6');

const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);

export class BlockedUrlError extends Error {
  constructor(msg, code = 'blocked_url') {
    super(msg);
    this.code = code;
  }
}

export function isPublicIp(ip) {
  let family = net.isIP(ip);
  if (!family) return false;
  if (family === 6) {
    const lower = ip.toLowerCase();
    // IPv4-mapped / NAT64 embedded addresses: validate the embedded IPv4.
    const m = lower.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPublicIp(m[1]);
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(lower)) return false;
    return !blocked.check(ip, 'ipv6');
  }
  return !blocked.check(ip, 'ipv4');
}

function testMapping(hostname) {
  return config.proxy.testHostMap[hostname.toLowerCase()] || null;
}

// Synchronous checks on the URL itself (no DNS).
export function assertSafeUrl(input) {
  let u;
  try {
    u = input instanceof URL ? input : new URL(String(input));
  } catch {
    throw new BlockedUrlError('Invalid URL', 'invalid_url');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new BlockedUrlError('Only http and https URLs are supported', 'invalid_url');
  if (u.username || u.password) throw new BlockedUrlError('URLs with embedded credentials are not allowed', 'invalid_url');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (testMapping(host)) return u;
  if (!ALLOWED_PORTS.has(u.port)) throw new BlockedUrlError('Port not allowed');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.') && !net.isIP(host)) {
    throw new BlockedUrlError('Internal hostnames are not allowed');
  }
  if (net.isIP(host) && !isPublicIp(host)) throw new BlockedUrlError('Private or reserved IP addresses are not allowed');
  return u;
}

// dns.lookup-compatible function used for the actual socket connection.
function safeLookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  const mapped = testMapping(hostname);
  if (mapped) {
    return options.all ? callback(null, [{ address: mapped.ip, family: 4 }]) : callback(null, mapped.ip, 4);
  }
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err);
    if (!addresses.length) return callback(new BlockedUrlError('Host did not resolve', 'dns_failed'));
    const bad = addresses.find((a) => !isPublicIp(a.address));
    if (bad) return callback(new BlockedUrlError(`Host resolves to a non-public address (${bad.address})`));
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

export async function resolvePublic(hostname) {
  return new Promise((resolve, reject) =>
    safeLookup(hostname, { all: true }, (e, a) => (e ? reject(e) : resolve(a))),
  );
}

export const safeAgent = new Agent({
  connect: { lookup: safeLookup, timeout: 10000 },
  headersTimeout: config.proxy.upstreamTimeoutMs,
  bodyTimeout: 60000,
  keepAliveTimeout: 10000,
  connections: 64,
});

// For test-mapped hosts the port in the URL is meaningless (fixtures listen on
// loopback ports), so rewrite the URL to the mapped port.
export function connectUrl(u) {
  const m = testMapping(u.hostname);
  if (!m?.port) return u.toString();
  const c = new URL(u);
  c.protocol = 'http:';
  c.port = String(m.port);
  return c.toString();
}

// fetch() through the safe agent, never following redirects.
export async function safeFetch(url, init = {}) {
  const u = assertSafeUrl(url);
  const { fetch } = await import('undici');
  return fetch(connectUrl(u), {
    ...init,
    redirect: 'manual',
    dispatcher: safeAgent,
    signal: init.signal || AbortSignal.timeout(config.proxy.upstreamTimeoutMs),
    headers: init.headers || {},
  });
}

// Follows up to `max` redirects, validating each hop. For server-side fetches
// (discovery, site auth) — the browser-facing proxy rewrites redirects instead.
export async function safeFetchFollow(url, init = {}, max = 5) {
  let current = String(url);
  for (let i = 0; i <= max; i++) {
    const res = await safeFetch(current, init);
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), current).toString();
      await res.body?.cancel().catch(() => {});
      continue;
    }
    return { res, finalUrl: current };
  }
  throw new BlockedUrlError('Too many redirects', 'too_many_redirects');
}
