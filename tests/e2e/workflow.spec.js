// End-to-end acceptance workflow (spec section 19) against local fixture sites.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { loginAsOwner, createProject, frame, waitFrameReady, clickInFrame, pinVsElement } from './helpers.js';

test.describe.configure({ mode: 'serial' });
const shared = {};
const PNG = path.resolve('tests/fixtures/sample.png');

test.beforeAll(() => {
  if (!fs.existsSync(PNG)) {
    fs.writeFileSync(PNG, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAGklEQVR42mNkYPhfz0AEYBxVSF+FAP5FBQ0Gx8XyAAAAAElFTkSuQmCC', 'base64'));
  }
});

test('owner logs in, creates project, website renders through proxy', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  shared.email = await loginAsOwner(page);
  shared.projectId = await createProject(page, 'https://static.test/');
  await waitFrameReady(page);
  const f = frame(page);
  await expect(f.locator('.hero-heading')).toHaveText('Build better websites');
  // CSS (including @import + url()) applied
  await expect(f.locator('.hero-heading')).toHaveCSS('font-size', '48px');
  await expect(f.locator('.footer')).toHaveCSS('background-color', 'rgb(34, 34, 34)');
  // site JS executed, root-relative fetch and JS-created image went through the proxy
  await expect(f.locator('#api-status')).toHaveText('API: ok');
  await expect.poll(() => f.locator('#dyn-img').evaluate((i) => i.naturalWidth)).toBe(1);
  await expect.poll(() => f.locator('img.hero-img').evaluate((i) => i.complete && i.naturalWidth)).toBe(1);
  // tracking, chat and consent scripts removed, cookie banner hidden
  expect(await f.locator('script[src*="googletagmanager"], script[src*="intercom"], script[src*="cookiebot"]').count()).toBe(0);
  await expect(f.locator('#CybotCookiebotDialog')).toBeHidden();
  // sitemap discovered and organised hierarchically
  await expect(page.getByTestId('pages-tree').locator('[data-path="/services"]')).toBeVisible();
  await page.getByTestId('pages-tree').locator('[data-path="/services"] [data-testid=tree-toggle]').click();
  await expect(page.getByTestId('pages-tree').locator('[data-path="/services/seo"]')).toBeVisible();
  await expect(page.getByTestId('pages-tree').locator('[data-path="/files/brochure.pdf"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('vague feedback is blocked with follow-up questions; specific feedback submits', async ({ page }) => {
  await loginAsOwner(page, shared.email);
  await page.goto(`/projects/${shared.projectId}`);
  await waitFrameReady(page);
  await clickInFrame(page, '.hero-heading', { x: 40, y: 20 });
  const composer = page.getByTestId('composer');
  await expect(composer).toBeVisible();
  await expect(page.getByTestId('pending-pin')).toBeVisible();
  const input = page.getByTestId('comment-input');
  const submit = page.getByTestId('submit-comment');
  await expect(submit).toBeDisabled();

  await input.fill('Make it bigger.');
  await expect(page.getByTestId('validation')).toContainText('enlarged');
  await expect(submit).toBeDisabled();
  await input.fill('Make it bigger please please please now');
  await expect(page.getByTestId('validation')).toContainText('enlarged');
  await expect(submit).toBeDisabled();

  await input.fill('Just adjust it.');
  await expect(page.getByTestId('validation')).toHaveText('What exactly would you like me to adjust?');

  // drawing tools before submission
  await page.getByTestId('draw-toggle').click();
  const layer = page.getByTestId('draw-layer');
  const box = await layer.boundingBox();
  await page.getByTestId('tool-rect').click();
  await page.mouse.move(box.x + 30, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + 400, box.y + 160, { steps: 5 });
  await page.mouse.up();
  await page.getByTestId('tool-arrow').click();
  await page.mouse.move(box.x + 600, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(box.x + 420, box.y + 150, { steps: 5 });
  await page.mouse.up();
  await page.getByTestId('draw-done').click();
  await expect(composer).toContainText('2 drawings');

  await input.fill('Make the heading 20% bigger and bolder');
  await expect(page.getByTestId('validation')).toHaveCount(0);
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByTestId('thread')).toBeVisible();
  await expect(page.locator('[data-testid=pin][data-number="1"]')).toBeVisible();
  shared.firstCommentNumber = 1;
});

test('screenshots (full + crop with drawings) are stored and downloadable', async ({ page, request }) => {
  await loginAsOwner(page, shared.email);
  await page.goto(`/projects/${shared.projectId}`);
  await waitFrameReady(page);
  await page.locator('[data-testid=pin][data-number="1"]').click();
  await expect(page.getByTestId('shot-crop').locator('img')).toBeVisible({ timeout: 60_000 });
  const crop = page.getByTestId('shot-crop').locator('img');
  await expect.poll(() => crop.evaluate((i) => i.naturalWidth)).toBeGreaterThan(300);
  const href = await page.getByTestId('shot-download').getAttribute('href');
  const res = await page.request.get(href);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-disposition']).toContain('attachment');
  const buf = await res.body();
  expect(buf[0]).toBe(0xff); // JPEG
  fs.mkdirSync('test-results/artifacts', { recursive: true });
  fs.writeFileSync('test-results/artifacts/comment-1-crop.jpg', buf);
  const comments = (await (await page.request.get(`/api/projects/${shared.projectId}/comments`)).json()).comments;
  const full = comments[0].screenshots.full;
  expect(full.status).toBe('ready');
  expect(full.height).toBeGreaterThan(1000);
  fs.writeFileSync('test-results/artifacts/comment-1-full.jpg', await (await page.request.get(full.downloadUrl)).body());
  expect(comments[0].drawing.length).toBe(2);
  expect(comments[0].drawing[0].points[0].rel).toBeTruthy();
});

test('pin stays anchored after reload, scrolling and breakpoint switching', async ({ page }) => {
  await loginAsOwner(page, shared.email);
  await page.goto(`/projects/${shared.projectId}`);
  await waitFrameReady(page);
  let { pin, el } = await pinVsElement(page, 1, '.hero-heading');
  // pin tip sits inside the heading's box
  expect(pin.x).toBeGreaterThanOrEqual(el.x - 4);
  expect(pin.x).toBeLessThanOrEqual(el.x + el.width);
  expect(pin.y + pin.height).toBeGreaterThanOrEqual(el.y - 4);
  expect(pin.y + pin.height).toBeLessThanOrEqual(el.y + el.height + 4);

  await frame(page).locator('body').evaluate(() => window.scrollTo(0, 120));
  await expect.poll(async () => (await pinVsElement(page, 1, '.hero-heading')).pin.y).toBeLessThan(pin.y - 100);
  ({ pin, el } = await pinVsElement(page, 1, '.hero-heading'));
  expect(Math.abs(pin.y + pin.height - (el.y + 20))).toBeLessThan(12);

  // comment was made on desktop: it is not shown on mobile
  await page.getByTestId('bp-mobile').click();
  await expect(page.getByTestId('device')).toHaveAttribute('data-bp', 'mobile');
  await expect(page.locator('[data-testid=pin][data-number="1"]')).toHaveCount(0);
  await page.getByTestId('bp-desktop').click();
  await expect(page.locator('[data-testid=pin][data-number="1"]')).toBeVisible();
});

test('owner can resolve (green), hide resolved, reopen, reply and edit', async ({ page }) => {
  await loginAsOwner(page, shared.email);
  await page.goto(`/projects/${shared.projectId}`);
  await waitFrameReady(page);
  await page.locator('[data-testid=pin][data-number="1"]').click();
  await page.getByTestId('reply-input').fill('On it!');
  await page.getByTestId('send-reply').click();
  await expect(page.getByTestId('thread-reply')).toContainText('On it!');

  await page.getByTestId('thread-root').getByTestId('comment-menu').click();
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByTestId('edit-input').fill('Make it bigger');
  await page.getByTestId('save-edit').click();
  await expect(page.getByTestId('thread-root')).toContainText('enlarged'); // edit validated too
  await page.getByTestId('edit-input').fill('Make the heading 30% bigger');
  await page.getByTestId('save-edit').click();
  await expect(page.getByTestId('thread-root').getByTestId('comment-text')).toHaveText('Make the heading 30% bigger');

  await page.getByTestId('resolve-toggle').click();
  const pin = page.locator('[data-testid=pin][data-number="1"]');
  await expect(pin).toHaveAttribute('data-status', 'resolved');
  await expect(pin).toHaveCSS('background-color', 'rgb(31, 164, 99)');
  await page.getByTestId('thread').getByLabel('Close').click();
  await page.getByTestId('pins-menu').click();
  await page.getByTestId('pins-open').click();
  await expect(pin).toHaveCount(0);
  await page.getByTestId('pins-menu').click();
  await page.getByTestId('pins-all').click();
  await expect(pin).toBeVisible();
  await pin.click();
  await page.getByTestId('resolve-toggle').click();
  await expect(pin).toHaveAttribute('data-status', 'open');
  await page.getByTestId('pins-menu').click();
  await page.getByTestId('pins-none').click();
  await expect(page.locator('[data-testid=pin]')).toHaveCount(0);
});

test('share link: guest navigates inside the proxy and comments without an account', async ({ page, browser }) => {
  await loginAsOwner(page, shared.email);
  await page.goto(`/projects/${shared.projectId}`);
  await page.getByTestId('share').click();
  const shareUrl = await page.getByTestId('share-url').inputValue();
  expect(shareUrl).toMatch(/\/s\/[A-Za-z0-9_-]{30,}$/);
  shared.shareUrl = shareUrl;

  const guestCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const g = await guestCtx.newPage();
  await g.goto(shareUrl);
  await waitFrameReady(g);
  await expect(g.getByTestId('share')).toHaveCount(0);
  // navigate via an in-page link (browse mode): stays inside the proxy
  await g.getByTestId('mode-browse').click();
  await frame(g).locator('nav a', { hasText: 'About' }).click();
  await expect(frame(g).locator('.page-title')).toHaveText('About us');
  await expect(g.getByTestId('current-url')).toHaveText('/about');
  await expect(g.getByTestId('pages-tree').locator('.tree-row.active')).toContainText('About');
  // root-relative redirect followed inside the proxy
  // back home through the sitemap
  await g.getByTestId('pages-tree').locator('[data-path="/"]').click();
  await expect(frame(g).locator('.hero-heading')).toBeVisible();
  await g.getByTestId('mode-comment').click();
  await clickInFrame(g, 'img.hero-img');
  await expect(g.getByTestId('name-prompt')).toBeVisible();
  await g.getByPlaceholder('Your name').fill('Gina Guest');
  await g.getByRole('button', { name: 'Continue' }).click();
  await g.getByTestId('comment-input').fill('Change the image.');
  await expect(g.getByTestId('validation')).toHaveText("Please attach the image you'd like to use to this comment.");
  await expect(g.getByTestId('submit-comment')).toBeDisabled();
  await g.locator('input[type=file]').first().setInputFiles(PNG);
  await expect(g.getByTestId('composer').locator('.thumb img')).toBeVisible();
  await expect(g.getByTestId('validation')).toHaveCount(0);
  await expect(g.getByTestId('submit-comment')).toBeEnabled();
  await g.getByTestId('submit-comment').click();
  await expect(g.getByTestId('thread')).toContainText('Gina Guest');
  await expect(g.getByTestId('thread').locator('.thumb img')).toBeVisible();

  // guests cannot edit someone else's comment (enforced server-side)
  const list = await (await g.request.get(`/api/projects/${shared.projectId}/comments`, { headers: { 'x-share-token': shareUrl.split('/s/')[1] } })).json();
  const ownerComment = list.comments.find((c) => c.number === 1);
  const r = await g.request.patch(`/api/comments/${ownerComment.id}`, {
    headers: { 'x-share-token': shareUrl.split('/s/')[1], 'content-type': 'application/json' },
    data: { body: 'Hacked: make the heading red' },
  });
  expect(r.status()).toBe(403);
  // name is remembered for the next comment
  await g.reload();
  await waitFrameReady(g);
  await clickInFrame(g, '.hero-sub');
  await expect(g.getByTestId('name-prompt')).toHaveCount(0);
  await expect(g.getByTestId('composer')).toContainText('Gina Guest');
  await guestCtx.close();
});

test('comment overview filters and jumps to the pin', async ({ page }) => {
  await loginAsOwner(page, shared.email);
  await page.goto(`/projects/${shared.projectId}/comments`);
  await expect(page.getByTestId('ov-row')).toHaveCount(2);
  await page.getByTestId('ov-filter-resolved').click();
  await expect(page.getByTestId('ov-row')).toHaveCount(0);
  await page.getByTestId('ov-filter-open').click();
  await expect(page.getByTestId('ov-row')).toHaveCount(2);
  await page.getByTestId('ov-row').filter({ hasText: 'Change the image' }).click();
  await expect(page).toHaveURL(/comment=/);
  await waitFrameReady(page);
  await expect(page.getByTestId('thread')).toContainText('Change the image.');
  await expect(page.locator('[data-testid=pin].selected')).toBeVisible();
});

test('share link can be disabled and regenerated', async ({ page, browser }) => {
  await loginAsOwner(page, shared.email);
  await page.goto(`/projects/${shared.projectId}`);
  await page.getByTestId('share').click();
  await page.getByTestId('share-enabled').click();
  await expect(page.getByTestId('share-enabled')).not.toBeChecked();
  const guest = await browser.newPage();
  await guest.goto(shared.shareUrl);
  await expect(guest.locator('body')).toContainText('disabled');
  await page.getByTestId('share-enabled').click();
  await expect(page.getByTestId('share-enabled')).toBeChecked();
  await guest.goto(shared.shareUrl);
  await waitFrameReady(guest);
  page.once('dialog', (d) => d.accept());
  await page.getByTestId('share-regenerate').click();
  await expect(page.getByTestId('share-url')).not.toHaveValue(shared.shareUrl);
  await guest.goto(shared.shareUrl);
  await expect(guest.locator('body')).toContainText(/disabled|does not exist|no longer/);
  const fresh = await page.getByTestId('share-url').inputValue();
  await guest.goto(fresh);
  await waitFrameReady(guest);
  await expect(frame(guest).locator('.hero-heading')).toBeVisible();
  await guest.close();
});

test('guests may resolve but not delete others\' comments; owner can delete any comment', async ({ page, browser }) => {
  await loginAsOwner(page, shared.email);
  const share = (await (await page.request.get(`/api/projects/${shared.projectId}`)).json()).share.url;
  const token = share.split('/s/')[1];
  const guest = await browser.newContext();
  const g = await (await guest.request.post('/api/guests', { data: { name: 'Second Guest' } })).json();
  const headers = { 'x-share-token': token, 'x-guest-token': g.token };
  const list = (await (await guest.request.get(`/api/projects/${shared.projectId}/comments`, { headers })).json()).comments;
  const ownerComment = list.find((c) => c.authorType === 'owner');
  const guestComment = list.find((c) => c.authorType === 'guest');
  expect((await guest.request.delete(`/api/comments/${ownerComment.id}`, { headers })).status()).toBe(403);
  const res = await guest.request.post(`/api/comments/${ownerComment.id}/resolve`, { headers, data: { resolved: true } });
  expect(res.status()).toBe(200);
  expect((await res.json()).comment.resolvedByName).toBe('Second Guest');
  // without the share token there is no access at all
  expect((await guest.request.get(`/api/projects/${shared.projectId}/comments`)).status()).toBe(401);
  await guest.close();

  await page.goto(`/projects/${shared.projectId}?comment=${guestComment.id}`);
  await waitFrameReady(page);
  await page.getByTestId('thread-root').getByTestId('comment-menu').click();
  page.once('dialog', (d) => d.accept());
  await page.getByTestId('delete-comment').click();
  await expect(page.getByTestId('thread')).toHaveCount(0);
  await expect(page.locator(`[data-testid=pin][data-number="${guestComment.number}"]`)).toHaveCount(0);
  const after = (await (await page.request.get(`/api/projects/${shared.projectId}/comments`)).json()).comments;
  expect(after.map((c) => c.id)).not.toContain(guestComment.id);
});
