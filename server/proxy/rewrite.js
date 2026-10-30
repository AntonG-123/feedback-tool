// Server-side HTML and CSS rewriting for proxied documents.
//
// Every URL in markup and stylesheets is mapped into the proxy namespace:
//   https://www.site.com/a/b.css  ->  /p/<token>/https/www.site.com/a/b.css
// so that the browser requests everything through the proxy origin. URLs that
// are created at runtime by site JavaScript are handled by the in-page shim
// (client/shim.js).
import { parse, serialize } from 'parse5';
import { isBlockedScriptUrl, isBlockedInlineScript, HIDE_CSS } from './blocklist.js';

// Public CDNs that are loaded directly (permissive CORS, no cookies, no
// referrer checks). Everything else goes through the proxy.
const PASSTHROUGH_HOSTS = new Set([
  'fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'unpkg.com',
  'ajax.googleapis.com', 'code.jquery.com', 'www.youtube.com', 'player.vimeo.com', 'www.google.com',
]);

export function makeMapper({ token, docUrl, projectHost }) {
  const prefix = `/p/${token}`;
  const proxify = (abs) => {
    const u = abs instanceof URL ? abs : new URL(abs);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return u.toString();
    return `${prefix}/${u.protocol.slice(0, -1)}/${u.host}${u.pathname}${u.search}${u.hash}`;
  };
  const map = (raw, base = docUrl, { kind } = {}) => {
    if (raw == null) return raw;
    const s = String(raw).trim();
    if (!s || /^(#|data:|blob:|javascript:|mailto:|tel:|about:|sms:)/i.test(s)) return raw;
    if (s.startsWith(prefix + '/')) return raw;
    let u;
    try {
      u = new URL(s, base);
    } catch {
      return raw;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return raw;
    if (PASSTHROUGH_HOSTS.has(u.hostname)) return u.toString();
    // Third-party iframes (maps, video players, ...) load from their real origin.
    if (kind === 'frame' && !sameSite(u.hostname, projectHost)) return u.toString();
    return proxify(u);
  };
  return { proxify, map, prefix };
}

const bare = (h) => h.toLowerCase().replace(/^www\./, '');
export const sameSite = (a, b) => bare(a) === bare(b) || bare(a).endsWith('.' + bare(b)) || bare(b).endsWith('.' + bare(a));

export function rewriteSrcset(value, base, map) {
  return String(value)
    .split(/,(?=\s*\S)/)
    .map((part) => {
      const m = part.trim().match(/^(\S+)(\s+.*)?$/);
      if (!m) return part;
      return map(m[1], base) + (m[2] || '');
    })
    .join(', ');
}

export function rewriteCss(css, base, map) {
  return String(css)
    .replace(/url\(\s*(['"]?)([^'")]+?)\1\s*\)/gi, (all, q, url) => {
      if (/^(data:|#|about:)/i.test(url.trim())) return all;
      return `url(${q}${map(url, base)}${q})`;
    })
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (all, q, url) => `@import ${q}${map(url, base)}${q}`);
}

function rewriteInlineModule(code, base, map) {
  return code.replace(/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])((?:\/|https?:\/\/)[^'"]+)\2/g, (all, kw, q, spec) => `${kw}${q}${map(spec, base)}${q}`);
}

function rewriteImportMap(json, base, map) {
  try {
    const m = JSON.parse(json);
    const fix = (obj) => {
      if (!obj) return;
      for (const k of Object.keys(obj)) if (typeof obj[k] === 'string') obj[k] = map(obj[k], base);
    };
    fix(m.imports);
    if (m.scopes) for (const s of Object.keys(m.scopes)) fix(m.scopes[s]);
    return JSON.stringify(m);
  } catch {
    return json;
  }
}

const URL_ATTRS = {
  a: ['href'], area: ['href'], link: ['href'], img: ['src', 'srcset', 'data-src', 'data-srcset', 'data-lazy-src', 'data-original'],
  script: ['src'], iframe: ['src'], frame: ['src'], embed: ['src'], source: ['src', 'srcset', 'data-src', 'data-srcset'],
  track: ['src'], audio: ['src'], video: ['src', 'poster', 'data-src'], input: ['src', 'formaction'], button: ['formaction'],
  form: ['action'], object: ['data'], image: ['href', 'xlink:href'], use: ['href', 'xlink:href'], body: ['background'],
  'astro-island': ['component-url', 'renderer-url', 'before-hydration-url'],
};
const ANY_URL_ATTRS = ['data-bg', 'data-background', 'data-background-image', 'data-bg-src'];

const getAttr = (n, name) => n.attrs?.find((a) => a.name === name);
const removeAttr = (n, name) => (n.attrs = n.attrs.filter((a) => a.name !== name));
const el = (tagName, attrs, text) => {
  const node = { nodeName: tagName, tagName, attrs: Object.entries(attrs).map(([name, value]) => ({ name, value })), namespaceURI: 'http://www.w3.org/1999/xhtml', childNodes: [] };
  if (text != null) node.childNodes.push({ nodeName: '#text', value: text, parentNode: node });
  return node;
};

/**
 * @param {string} html
 * @param {object} ctx { token, docUrl, projectHost, config: object for window.__AGM__, stripScripts?: boolean }
 */
export function rewriteHtml(html, ctx) {
  const doc = parse(html);
  let baseUrl = ctx.docUrl;
  const { map } = makeMapper(ctx);
  let head = null;
  let body = null;
  const removed = { scripts: 0 };

  // First pass: find <base> so relative URLs resolve like the original page.
  const findBase = (n) => {
    if (n.tagName === 'base' && getAttr(n, 'href')) {
      try { baseUrl = new URL(getAttr(n, 'href').value, ctx.docUrl).toString(); } catch {}
      return true;
    }
    return (n.childNodes || []).some(findBase);
  };
  findBase(doc);

  const walk = (n) => {
    const kids = n.childNodes || [];
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      const tag = c.tagName;
      if (!tag) continue;
      if (tag === 'head' && !head) head = c;
      if (tag === 'body' && !body) body = c;

      if (tag === 'base') { kids.splice(i--, 1); continue; }
      if (tag === 'meta') {
        const he = (getAttr(c, 'http-equiv')?.value || '').toLowerCase();
        const name = (getAttr(c, 'name')?.value || '').toLowerCase();
        if (he === 'content-security-policy' || he === 'x-frame-options' || name === 'referrer') { kids.splice(i--, 1); continue; }
        if (he === 'refresh') {
          const content = getAttr(c, 'content');
          content.value = content.value.replace(/(url\s*=\s*)(['"]?)([^'";]+)\2/i, (a, p, q, u) => `${p}${q}${map(u, baseUrl)}${q}`);
        }
      }
      if (tag === 'script') {
        const type = (getAttr(c, 'type')?.value || '').toLowerCase();
        const src = getAttr(c, 'src');
        const text = c.childNodes?.[0]?.value || '';
        let abs = null;
        if (src) try { abs = new URL(src.value, baseUrl).toString(); } catch {}
        if (ctx.stripScripts || type === 'speculationrules' || (abs && isBlockedScriptUrl(abs)) || (!src && text && isBlockedInlineScript(text))) {
          kids.splice(i--, 1);
          removed.scripts++;
          continue;
        }
        removeAttr(c, 'integrity');
        if (!src && text) {
          if (type === 'importmap') c.childNodes[0].value = rewriteImportMap(text, baseUrl, map);
          else if (type === 'module') c.childNodes[0].value = rewriteInlineModule(text, baseUrl, map);
        }
      }
      if (tag === 'link') {
        const rel = (getAttr(c, 'rel')?.value || '').toLowerCase();
        if (/\b(preconnect|dns-prefetch|manifest|serviceworker)\b/.test(rel)) { kids.splice(i--, 1); continue; }
        removeAttr(c, 'integrity');
        const href = getAttr(c, 'href');
        if (href) try { if (isBlockedScriptUrl(new URL(href.value, baseUrl).toString())) { kids.splice(i--, 1); continue; } } catch {}
        const srcset = getAttr(c, 'imagesrcset');
        if (srcset) srcset.value = rewriteSrcset(srcset.value, baseUrl, map);
      }
      if (tag === 'style' && c.childNodes?.[0]) c.childNodes[0].value = rewriteCss(c.childNodes[0].value, baseUrl, map);

      const names = [...(URL_ATTRS[tag] || []), ...ANY_URL_ATTRS];
      for (const a of c.attrs || []) {
        if (a.name === 'style') a.value = rewriteCss(a.value, baseUrl, map);
        else if (!names.includes(a.name)) continue;
        else if (a.name.endsWith('srcset')) a.value = rewriteSrcset(a.value, baseUrl, map);
        else a.value = map(a.value, baseUrl, { kind: tag === 'iframe' || tag === 'frame' ? 'frame' : undefined });
      }
      if (tag === 'iframe') removeAttr(c, 'csp');
      walk(c);
      if (c.content) walk(c.content); // <template>
    }
  };
  walk(doc);

  if (head) {
    const { proxify } = makeMapper(ctx);
    const inject = [
      el('base', { href: proxify(baseUrl), 'data-agm': '' }),
      el('script', { 'data-agm': '' }, `window.__AGM__=${JSON.stringify(ctx.config).replace(/</g, '\\u003c')};`),
      el('script', { src: '/__agm/shim.js', 'data-agm': '' }),
      el('style', { 'data-agm': '' }, HIDE_CSS),
    ];
    for (const n of inject) n.parentNode = head;
    head.childNodes.unshift(...inject);
  }
  if (body && !ctx.noOverlay) {
    const s = el('script', { src: '/__agm/overlay.js', defer: '', 'data-agm': '' });
    s.parentNode = body;
    body.childNodes.push(s);
  }
  return { html: serialize(doc), removed };
}
