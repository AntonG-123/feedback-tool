// Proxy engine: SPA routing, password-protected sites, error states, form
// blocking, SSRF protection and snapshot mode.
import { test, expect } from '@playwright/test';
import { loginAsOwner, frame, waitFrameReady, clickInFrame } from './helpers.js';

test.describe.configure({ mode: 'serial' });
const OWNER = `proxy-owner-${Date.now()}@example.com`;

async function newProject(page, url, patch) {
  const r = await page.request.post('/api/projects', { data: { url } });
  expect(r.status(), await r.text()).toBe(201);
  const { project } = await r.json();
  if (patch) expect((await page.request.patch(`/api/projects/${project.id}`, { data: patch })).status()).toBe(200);
  return project.id;
}
async function proxyToken(page, id) {
  return (await (await page.request.get(`/api/projects/${id}`)).json()).proxy;
}

test('SPA: client-side routing, root-relative fetch, dynamic import and pathname stay correct', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await loginAsOwner(page, OWNER);
  const id = await newProject(page, 'https://spa.test/');
  await page.goto(`/projects/${id}`);
  await waitFrameReady(page);
  const f = frame(page);
  await expect(f.locator('.spa-title')).toHaveText('SPA Home'); // location.pathname === '/'
  await expect(f.locator('#chunk')).toHaveText('chunk loaded');
  await expect.poll(() => f.locator('.spa-img').evaluate((i) => i.naturalWidth)).toBe(1);
  await page.getByTestId('mode-browse').click();
  await f.locator('.spa-link').click();
  await expect(f.locator('.spa-title')).toHaveText('Products');
  await expect(f.locator('.item')).toHaveCount(3);
  await expect(page.getByTestId('current-url')).toHaveText('/products');
  // the visited route is added to the sitemap automatically
  await expect(page.getByTestId('pages-tree').locator('[data-path="/products"]')).toBeVisible();
  // comment on a client-rendered route
  await page.getByTestId('mode-comment').click();
  await clickInFrame(page, '.item >> nth=1');
  await page.getByTestId('comment-input').fill('Rename this item to "Beta Plus"');
  await expect(page.getByTestId('submit-comment')).toBeEnabled();
  await page.getByTestId('submit-comment').click();
  await expect(page.getByTestId('thread')).toBeVisible();
  // reload the route directly (deep link): still resolves and the pin re-anchors
  await page.reload();
  await waitFrameReady(page);
  await page.getByTestId('pages-tree').locator('[data-path="/products"]').click();
  await expect(frame(page).locator('.item')).toHaveCount(3);
  await expect(page.locator('[data-testid=pin][data-number="1"]')).toBeVisible();
  expect(errors).toEqual([]);
});

test('Webflow password-protected site: server-side login, guests never see the password', async ({ page }) => {
  await loginAsOwner(page, OWNER);
  const id = await newProject(page, 'https://wfpass.test/');
  await page.goto(`/projects/${id}`);
  await expect(page.getByTestId('frame-error')).toHaveAttribute('data-code', 'auth_required');
  // wrong password -> clear error
  await page.request.patch(`/api/projects/${id}`, { data: { siteAuth: { type: 'webflow', password: 'nope' } } });
  await page.reload();
  await expect(page.getByTestId('frame-error')).toHaveAttribute('data-code', 'auth_failed');
  // correct password set through the settings dialog
  await page.getByRole('button', { name: 'Add site password' }).click();
  await page.getByTestId('auth-password').fill('secret123');
  await page.getByTestId('settings-save').click();
  await waitFrameReady(page);
  await expect(frame(page).locator('.secret-title')).toHaveText('Protected webflow content');
  // project API never returns the secret
  const d = await (await page.request.get(`/api/projects/${id}`)).json();
  expect(JSON.stringify(d)).not.toContain('secret123');
  expect(d.project.hasSitePassword).toBe(true);
});

test('Shopify storefront password', async ({ page }) => {
  await loginAsOwner(page, OWNER);
  const id = await newProject(page, 'https://shoppass.test/', { siteAuth: { type: 'shopify', password: 'secret123' } });
  await page.goto(`/projects/${id}`);
  await waitFrameReady(page);
  await expect(frame(page).locator('.secret-title')).toHaveText('Protected shopify content');
});

test('clear error states: unavailable site, timeout, expired preview token', async ({ page }) => {
  await loginAsOwner(page, OWNER);
  // project creation validates the address first
  const bad = await page.request.post('/api/projects', { data: { url: 'https://does-not-exist.invalid/' } });
  expect(bad.status()).toBe(400);
  expect((await bad.json()).code).toBe('dns_failed');
  expect((await page.request.post('/api/projects', { data: { url: 'not a url ::' } })).status()).toBe(400);

  const id = await newProject(page, 'https://static.test/');
  await page.goto(`/projects/${id}?page=${encodeURIComponent('https://static.test/slow')}`);
  await expect(page.getByTestId('frame-error')).toHaveAttribute('data-code', 'timeout', { timeout: 20_000 });
  await expect(page.getByTestId('frame-error')).toContainText('took too long');

  const proxy = await proxyToken(page, id);
  const r = await page.request.get(`${proxy.origin}/p/${proxy.token.slice(0, -2)}xx/https/static.test/`);
  expect(r.status()).toBe(401);
  expect(await r.text()).toContain('expired');
});

test('forms are not submitted from the preview; search forms still work', async ({ page }) => {
  await loginAsOwner(page, OWNER);
  const id = await newProject(page, 'https://static.test/');
  await page.goto(`/projects/${id}`);
  await waitFrameReady(page);
  await page.getByTestId('mode-browse').click();
  const f = frame(page);
  await f.locator('.contact-form input').fill('x@example.com');
  await f.locator('.submit-btn').click();
  await expect(page.locator('.toast')).toContainText('Form submissions are disabled');
  await expect(f.locator('.hero-heading')).toBeVisible(); // still on the same page
  // direct POST to the site through the proxy is refused as well
  const proxy = await proxyToken(page, id);
  const r = await page.request.post(`${proxy.origin}/p/${proxy.token}/https/static.test/contact`, {
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-dest': 'document' }, data: 'email=x',
  });
  expect(r.status()).toBe(403);
  expect(await r.text()).not.toContain('FORM WAS SUBMITTED');
  await f.locator('input[type=search]').fill('pricing');
  await f.locator('input[type=search]').press('Enter');
  await expect(f.locator('.search-title')).toHaveText('Results for pricing');
});

test('external links open outside the proxy; redirects stay inside', async ({ page, context }) => {
  await loginAsOwner(page, OWNER);
  const id = await newProject(page, 'https://static.test/');
  await page.goto(`/projects/${id}`);
  await waitFrameReady(page);
  await page.getByTestId('mode-browse').click();
  // the sandbox has no internet: answer the external host locally
  await context.route('https://external.example.org/**', (r) => r.fulfill({ body: 'external site', contentType: 'text/html' }));
  const popup = context.waitForEvent('page');
  await frame(page).locator('a.ext').click();
  const p = await popup;
  await p.waitForLoadState();
  expect(p.url()).toBe('https://external.example.org/x');
  await p.close();
  await expect(frame(page).locator('.hero-heading')).toBeVisible();
  // a 301 redirect on the site is followed inside the proxy
  const proxy = await proxyToken(page, id);
  const r = await page.request.get(`${proxy.origin}/p/${proxy.token}/https/static.test/old-page`, { maxRedirects: 0 });
  expect(r.status()).toBe(301);
  expect(r.headers().location).toBe(`/p/${proxy.token}/https/static.test/about`);
});

test('SSRF: the proxy refuses internal and private addresses', async ({ page }) => {
  await loginAsOwner(page, OWNER);
  for (const url of ['http://localhost:3100/', 'http://127.0.0.1/', 'http://10.0.0.5/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://2130706433/', 'file:///etc/passwd', 'http://192.168.1.1:22/']) {
    const r = await page.request.post('/api/projects', { data: { url } });
    expect(r.status(), url).toBe(400);
  }
  const id = await newProject(page, 'https://static.test/');
  const proxy = await proxyToken(page, id);
  for (const path of ['http/127.0.0.1:3100/api/health', 'http/169.254.169.254/latest/meta-data/', 'http/[::ffff:127.0.0.1]/', 'http/localhost:3100/', 'http/10.1.2.3/', 'https/metadata.google.internal/']) {
    const r = await page.request.get(`${proxy.origin}/p/${proxy.token}/${path}`);
    expect(r.status(), path).toBe(403);
  }
  // no token -> nothing is fetched
  expect((await page.request.get(`${proxy.origin}/p/garbage/https/static.test/`)).status()).toBe(401);
});

test('snapshot render mode serves a server-rendered copy without site scripts', async ({ page }) => {
  await loginAsOwner(page, OWNER);
  const id = await newProject(page, 'https://static.test/', { renderMode: 'snapshot' });
  await page.goto(`/projects/${id}`);
  await waitFrameReady(page);
  const f = frame(page);
  await expect(f.locator('.hero-heading')).toHaveText('Build better websites');
  await expect(f.locator('#api-status')).toHaveText('API: ok'); // content produced by JS during rendering
  expect(await f.locator('script:not([data-agm])').count()).toBe(0);
  await clickInFrame(page, '.hero-heading');
  await expect(page.getByTestId('composer')).toBeVisible();
});
