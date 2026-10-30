import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePageUrl, isSameSite, isLikelyPage } from '../../shared/urls.js';
import { buildTree } from '../../web/src/util.ts';

test('page URL normalisation de-duplicates variants', () => {
  const same = ['https://Site.com/about/', 'https://site.com/about#team', 'https://site.com:443/about?utm_source=x', 'https://site.com/about'];
  assert.equal(new Set(same.map((u) => normalizePageUrl(u))).size, 1);
  assert.equal(normalizePageUrl('https://site.com/'), 'https://site.com/');
  assert.ok(isSameSite('https://www.site.com/x', 'https://site.com'));
  assert.ok(!isSameSite('https://evil.com/x', 'https://site.com'));
  assert.ok(!isLikelyPage('https://site.com/file.pdf'));
});

test('sitemap tree: categories, subcategories, counts', () => {
  const p = (path, open = 0, resolved = 0) => ({ id: path, url: 'https://s.com' + path, path, title: null, source: 'sitemap', openCount: open, resolvedCount: resolved });
  const tree = buildTree([p('/'), p('/services', 1), p('/services/web/design', 2), p('/services/web/seo'), p('/services/branding', 0, 3), p('/blog/post-1')]);
  assert.equal(tree.page.path, '/');
  const services = tree.children.find((c) => c.key === '/services');
  assert.equal(services.page.path, '/services'); // category that is also a page
  assert.equal(services.open, 3);
  assert.equal(services.resolved, 3);
  const web = services.children.find((c) => c.key === '/services/web');
  assert.equal(web.page, undefined); // pure subcategory
  assert.deepEqual(web.children.map((c) => c.label), ['Design', 'Seo']);
});
