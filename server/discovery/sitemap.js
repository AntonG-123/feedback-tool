// Page discovery: robots.txt -> sitemap(s) (incl. sitemap indexes, gzip),
// common sitemap locations, then a shallow link crawl of rendered HTML as a
// fallback for sites without a usable sitemap.
import zlib from 'node:zlib';
import { parse } from 'parse5';
import { safeFetchFollow } from '../lib/ssrf.js';
import { normalizePageUrl, isSameSite, isLikelyPage } from '../lib/urls.js';
import { siteAuthHeaders } from '../proxy/siteauth.js';

const UA = 'Mozilla/5.0 (compatible; AGMFeedbackBot/1.0; +page discovery for review)';
const MAX_PAGES = 500;

async function getText(url, project, accept = '*/*') {
  const headers = { 'user-agent': UA, accept, ...(await siteAuthHeaders(project, url)) };
  const { res, finalUrl } = await safeFetchFollow(url, { headers });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const body = buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf;
  return { text: body.toString('utf8'), finalUrl, type: res.headers.get('content-type') || '' };
}

export function parseSitemapXml(xml) {
  const locs = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) =>
    m[1].replace(/&amp;/g, '&').trim(),
  );
  return { isIndex: /<sitemapindex[\s>]/i.test(xml), locs };
}

async function fromSitemaps(project, log) {
  const origin = project.origin;
  const candidates = new Set();
  const robots = await getText(`${origin}/robots.txt`, project, 'text/plain').catch(() => null);
  if (robots?.text) {
    for (const m of robots.text.matchAll(/^\s*sitemap:\s*(\S+)/gim)) candidates.add(m[1]);
  }
  for (const p of ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/wp-sitemap.xml']) candidates.add(origin + p);

  const pages = new Set();
  const seenMaps = new Set();
  const queue = [...candidates].map((u) => ({ u, depth: 0 }));
  while (queue.length && seenMaps.size < 25 && pages.size < MAX_PAGES) {
    const { u, depth } = queue.shift();
    if (seenMaps.has(u)) continue;
    seenMaps.add(u);
    const r = await getText(u, project, 'application/xml,text/xml').catch((e) => (log.push(`sitemap ${u}: ${e.message}`), null));
    if (!r || !/<(urlset|sitemapindex)[\s>]/i.test(r.text)) continue;
    const { isIndex, locs } = parseSitemapXml(r.text);
    log.push(`sitemap ${u}: ${isIndex ? 'index' : 'urlset'} with ${locs.length} entries`);
    if (isIndex) {
      if (depth < 2) for (const l of locs.slice(0, 20)) queue.push({ u: l, depth: depth + 1 });
    } else {
      for (const l of locs) {
        if (pages.size >= MAX_PAGES) break;
        if (isSameSite(l, origin) && isLikelyPage(l)) pages.add(normalizePageUrl(l));
      }
    }
    // A site with one good sitemap doesn't need the guessed locations too.
    if (pages.size && queue.every((q) => q.depth === 0)) break;
  }
  return [...pages];
}

export function extractLinks(html, baseUrl) {
  const doc = parse(html);
  const out = { links: [], title: null };
  let base = baseUrl;
  const walk = (n) => {
    if (n.tagName === 'base') {
      const h = n.attrs.find((a) => a.name === 'href')?.value;
      if (h) try { base = new URL(h, baseUrl).toString(); } catch {}
    }
    if (n.tagName === 'title' && !out.title) out.title = (n.childNodes?.[0]?.value || '').trim().slice(0, 200) || null;
    if (n.tagName === 'a') {
      const h = n.attrs.find((a) => a.name === 'href')?.value;
      if (h && !/^(#|mailto:|tel:|javascript:)/i.test(h.trim())) {
        try { out.links.push(normalizePageUrl(h.trim(), base)); } catch {}
      }
    }
    for (const c of n.childNodes || []) walk(c);
    if (n.content) walk(n.content);
  };
  walk(doc);
  return out;
}

async function fromCrawl(project, log, { maxPages = 60, maxDepth = 2 } = {}) {
  const found = new Map(); // url -> title
  const queue = [{ u: normalizePageUrl(project.url), d: 0 }];
  const seen = new Set();
  while (queue.length && seen.size < maxPages) {
    const batch = queue.splice(0, 4);
    await Promise.all(
      batch.map(async ({ u, d }) => {
        if (seen.has(u)) return;
        seen.add(u);
        const r = await getText(u, project, 'text/html').catch((e) => (log.push(`crawl ${u}: ${e.message}`), null));
        if (!r || !/html/i.test(r.type)) return;
        const { links, title } = extractLinks(r.text, r.finalUrl);
        found.set(u, title);
        if (d >= maxDepth) return;
        for (const l of links) if (isSameSite(l, project.origin) && isLikelyPage(l) && !seen.has(l)) queue.push({ u: l, d: d + 1 });
      }),
    );
  }
  log.push(`crawl: fetched ${seen.size}, pages ${found.size}`);
  return found;
}

export async function discoverPages(project) {
  const log = [];
  const sitemapPages = await fromSitemaps(project, log).catch((e) => (log.push('sitemaps failed: ' + e.message), []));
  // Crawl always runs (shallow) to pick up titles and navigation-only pages.
  const crawl = await fromCrawl(project, log, sitemapPages.length ? { maxPages: 15, maxDepth: 1 } : {});
  const pages = new Map();
  for (const u of sitemapPages) pages.set(u, { url: u, title: crawl.get(u) || null, source: 'sitemap' });
  for (const [u, t] of crawl) if (!pages.has(u)) pages.set(u, { url: u, title: t, source: 'crawl' });
  else if (t) pages.get(u).title = t;
  return { pages: [...pages.values()].slice(0, MAX_PAGES), log };
}
