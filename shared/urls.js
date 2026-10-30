const TRACKING = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|_hsenc|_hsmi|hsCtaTracking|ref_src)$/i;
const NON_PAGE_EXT = /\.(pdf|jpe?g|png|gif|webp|avif|svg|ico|css|js|mjs|json|xml|txt|zip|gz|rar|7z|mp4|webm|mov|mp3|wav|ogg|woff2?|ttf|otf|eot|docx?|xlsx?|pptx?|csv|rss|atom)$/i;

export function normalizeInputUrl(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  try {
    return normalizePageUrl(s);
  } catch {
    return null;
  }
}

// Canonical form used to de-duplicate pages: no hash, no tracking params,
// lower-case host, no default port, no trailing slash (except root).
export function normalizePageUrl(input, base) {
  const u = new URL(input, base);
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) u.port = '';
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  u.search = u.searchParams.toString() ? '?' + u.searchParams.toString() : '';
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '');
  return u.toString();
}

const bareHost = (h) => h.toLowerCase().replace(/^www\./, '');

export function isSameSite(url, origin) {
  try {
    return bareHost(new URL(url).hostname) === bareHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export function isLikelyPage(url) {
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !NON_PAGE_EXT.test(u.pathname);
  } catch {
    return false;
  }
}

export function pathOf(url) {
  const u = new URL(url);
  return u.pathname + u.search;
}
