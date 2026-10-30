import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteHtml, rewriteCss, rewriteSrcset, makeMapper } from '../../server/proxy/rewrite.js';
import { parseSitemapXml, extractLinks } from '../../server/discovery/sitemap.js';
import { isBlockedScriptUrl } from '../../server/proxy/blocklist.js';

const ctx = { token: 'TOK', docUrl: 'https://www.site.com/dir/page', projectHost: 'www.site.com', config: { x: 1 } };
const P = '/p/TOK';

test('URL mapping: relative, root-relative, absolute, protocol-relative, special schemes', () => {
  const { map } = makeMapper(ctx);
  assert.equal(map('img.png'), `${P}/https/www.site.com/dir/img.png`);
  assert.equal(map('/a/b.css?v=1'), `${P}/https/www.site.com/a/b.css?v=1`);
  assert.equal(map('https://cdn.other.io/x.js'), `${P}/https/cdn.other.io/x.js`);
  assert.equal(map('//cdn.site.com/y.png'), `${P}/https/cdn.site.com/y.png`);
  for (const s of ['#top', 'data:image/png;base64,xx', 'mailto:a@b.c', 'tel:123', 'javascript:void(0)']) assert.equal(map(s), s);
  assert.equal(map('https://fonts.googleapis.com/css2?family=Inter'), 'https://fonts.googleapis.com/css2?family=Inter');
  assert.equal(map(`${P}/https/www.site.com/x`), `${P}/https/www.site.com/x`); // idempotent
  assert.equal(map('https://www.youtube.com/embed/x', undefined, { kind: 'frame' }), 'https://www.youtube.com/embed/x');
});

test('CSS url() and @import are rewritten relative to the stylesheet', () => {
  const { map } = makeMapper(ctx);
  const out = rewriteCss(`@import "base.css"; a{background:url('../img/a.png')} b{background:url(data:image/png;base64,AA)}`, 'https://www.site.com/css/main.css', map);
  assert.match(out, /@import "\/p\/TOK\/https\/www\.site\.com\/css\/base\.css"/);
  assert.match(out, /url\('\/p\/TOK\/https\/www\.site\.com\/img\/a\.png'\)/);
  assert.match(out, /url\(data:image\/png;base64,AA\)/);
  assert.equal(rewriteSrcset('/a.png 1x, b.png 2x', ctx.docUrl, map), `${P}/https/www.site.com/a.png 1x, ${P}/https/www.site.com/dir/b.png 2x`);
});

test('HTML: CSP/meta removed, trackers removed, base + shim injected, original <base> honoured', () => {
  const html = `<!doctype html><html><head><base href="https://www.site.com/sub/"><meta http-equiv="Content-Security-Policy" content="default-src 'self'">
<script src="https://www.googletagmanager.com/gtm.js?id=X"></script><script>gtag('config','G-1')</script>
<script src="/app.js" integrity="sha384-x"></script><link rel="stylesheet" href="s.css" integrity="sha-1"><script type="importmap">{"imports":{"lib":"/lib.js"}}</script></head>
<body><a href="about">About</a><img srcset="a.png 1x" data-src="/lazy.png"><div style="background:url(/bg.png)"></div><form action="/send"></form>
<iframe src="https://www.youtube.com/embed/1"></iframe><iframe src="/embed"></iframe><astro-island component-url="/_astro/C.js"></astro-island></body></html>`;
  const { html: out, removed } = rewriteHtml(html, ctx);
  assert.equal(removed.scripts, 2);
  assert.doesNotMatch(out, /Content-Security-Policy/);
  assert.doesNotMatch(out, /googletagmanager/);
  assert.doesNotMatch(out, /integrity=/);
  assert.match(out, /<base href="\/p\/TOK\/https\/www\.site\.com\/sub\/" data-agm="">/);
  assert.match(out, /href="\/p\/TOK\/https\/www\.site\.com\/sub\/about"/); // resolved against original base
  assert.match(out, /src="\/p\/TOK\/https\/www\.site\.com\/app\.js"/);
  assert.match(out, /data-src="\/p\/TOK\/https\/www\.site\.com\/lazy\.png"/);
  assert.match(out, /url\(\/p\/TOK\/https\/www\.site\.com\/bg\.png\)/);
  assert.match(out, /action="\/p\/TOK\/https\/www\.site\.com\/send"/);
  assert.match(out, /src="https:\/\/www\.youtube\.com\/embed\/1"/); // third-party iframe untouched
  assert.match(out, /src="\/p\/TOK\/https\/www\.site\.com\/embed"/);
  assert.match(out, /component-url="\/p\/TOK\/https\/www\.site\.com\/_astro\/C\.js"/);
  assert.match(out, /"lib":"\/p\/TOK\/https\/www\.site\.com\/lib\.js"/);
  assert.match(out, /window\.__AGM__=\{"x":1\}/);
  assert.match(out, /<script src="\/__agm\/overlay\.js" defer="" data-agm=""><\/script><\/body>/);
});

test('blocklist matches trackers but not site or framework scripts', () => {
  assert.ok(isBlockedScriptUrl('https://www.googletagmanager.com/gtag/js?id=1'));
  assert.ok(isBlockedScriptUrl('https://consent.cookiebot.com/uc.js'));
  assert.ok(isBlockedScriptUrl('https://widget.intercom.io/widget/x'));
  assert.ok(!isBlockedScriptUrl('https://www.site.com/js/webflow.js'));
  assert.ok(!isBlockedScriptUrl('https://cdn.shopify.com/s/files/theme.js'));
  assert.ok(!isBlockedScriptUrl('https://framerusercontent.com/sites/x/script_main.mjs'));
});

test('sitemaps: urlset, sitemap index and CDATA; link extraction', () => {
  const idx = parseSitemapXml('<sitemapindex><sitemap><loc>https://s.com/a.xml</loc></sitemap></sitemapindex>');
  assert.equal(idx.isIndex, true);
  assert.deepEqual(idx.locs, ['https://s.com/a.xml']);
  const set = parseSitemapXml('<urlset><url><loc> https://s.com/x?a=1&amp;b=2 </loc></url><url><loc><![CDATA[https://s.com/y]]></loc></url></urlset>');
  assert.deepEqual(set.locs, ['https://s.com/x?a=1&b=2', 'https://s.com/y']);
  const { links, title } = extractLinks('<title>Home</title><a href="/a/">A</a><a href="#x">x</a><a href="mailto:x@y">m</a><a href="b?utm_source=z">b</a>', 'https://s.com/dir/');
  assert.equal(title, 'Home');
  assert.deepEqual(links, ['https://s.com/a', 'https://s.com/dir/b']);
});
