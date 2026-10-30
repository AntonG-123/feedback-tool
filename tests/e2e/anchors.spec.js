// Anchor robustness: text changes, DOM restructuring, removed elements,
// duplicate-looking elements, viewport changes and breakpoint separation.
import { test, expect } from '@playwright/test';
import { loginAsOwner, frame, waitFrameReady, clickInFrame, pinVsElement } from './helpers.js';

test.describe.configure({ mode: 'serial' });
const OWNER = `anchor-owner-${Date.now()}@example.com`;
const FIXTURE = 'http://127.0.0.1:4101/__fixture/state';
let projectId;

async function setSite(request, state) {
  await request.post(FIXTURE, { data: state || {} });
}
async function comment(page, selector, text, position) {
  await clickInFrame(page, selector, position);
  await page.getByTestId('comment-input').fill(text);
  await expect(page.getByTestId('submit-comment')).toBeEnabled();
  await page.getByTestId('submit-comment').click();
  await expect(page.getByTestId('thread')).toBeVisible();
  await page.getByTestId('thread').getByLabel('Close').click();
}
function inside(pin, el, tol = 6) {
  const tipX = pin.x + 2, tipY = pin.y + pin.height;
  return tipX >= el.x - tol && tipX <= el.x + el.width + tol && tipY >= el.y - tol && tipY <= el.y + el.height + tol;
}

test.beforeAll(async ({ request }) => setSite(request));
test.afterAll(async ({ request }) => setSite(request));

test('setup: comments on heading, subline and the second of three similar cards', async ({ page }) => {
  await loginAsOwner(page, OWNER);
  const r = await page.request.post('/api/projects', { data: { url: 'https://static.test/' } });
  projectId = (await r.json()).project.id;
  await page.goto(`/projects/${projectId}`);
  await waitFrameReady(page);
  await comment(page, '.hero-heading', 'Make the heading 10% smaller', { x: 30, y: 25 });
  await comment(page, '.hero-sub', 'Change this text to "We build fast websites"', { x: 10, y: 8 });
  await comment(page, '.card-title >> nth=1', 'Rename this to "Service Two"', { x: 10, y: 10 });
  for (const n of [1, 2, 3]) await expect(page.locator(`[data-testid=pin][data-number="${n}"]`)).toBeVisible();
  expect(inside((await pinVsElement(page, 3, '.card-title >> nth=1')).pin, (await pinVsElement(page, 3, '.card-title >> nth=1')).el)).toBe(true);
});

test('pins survive text changes and DOM restructuring', async ({ page, request }) => {
  await loginAsOwner(page, OWNER);
  await setSite(request, { heroText: 'Build much better websites today', insertWrapper: true });
  await page.goto(`/projects/${projectId}`);
  await waitFrameReady(page);
  await expect(frame(page).locator('.wrap .hero-heading')).toHaveText('Build much better websites today');
  const { pin, el } = await pinVsElement(page, 1, '.hero-heading');
  expect(inside(pin, el)).toBe(true);
  await expect(page.locator('[data-testid=pin][data-number="1"]')).toHaveText('1'); // not flagged
  const c3 = await pinVsElement(page, 3, '.card-title >> nth=1');
  expect(inside(c3.pin, c3.el)).toBe(true); // still the second card, not the first
});

test('a removed element is flagged instead of attaching to something unrelated', async ({ page, request }) => {
  await loginAsOwner(page, OWNER);
  await setSite(request, { removeSub: true });
  await page.goto(`/projects/${projectId}`);
  await waitFrameReady(page);
  const pin2 = page.locator('[data-testid=pin][data-number="2"]');
  await expect(pin2).toHaveText('!');
  await expect(pin2).toHaveClass(/attention/);
  await pin2.click();
  await expect(page.getByTestId('anchor-attention')).toBeVisible();
  // the state is persisted for the overview / other viewers
  await expect.poll(async () => {
    const list = (await (await page.request.get(`/api/projects/${projectId}/comments`)).json()).comments;
    return list.find((c) => c.number === 2).anchor.state;
  }).toBe('needs_attention');
  // element comes back -> anchor recovers
  await setSite(request, {});
  await page.reload();
  await waitFrameReady(page);
  await expect(page.locator('[data-testid=pin][data-number="2"]')).toHaveText('2');
});

test('viewport resize keeps pins on their elements; breakpoints are separate', async ({ page }) => {
  await loginAsOwner(page, OWNER);
  await page.goto(`/projects/${projectId}`);
  await waitFrameReady(page);
  await page.setViewportSize({ width: 1200, height: 800 });
  await expect.poll(async () => { const r = await pinVsElement(page, 3, '.card-title >> nth=1'); return inside(r.pin, r.el); }).toBe(true);

  await page.getByTestId('bp-tablet').click();
  for (const n of [1, 2, 3]) await expect(page.locator(`[data-testid=pin][data-number="${n}"]`)).toHaveCount(0);
  await comment(page, '.cards .card >> nth=2', 'Make this card full width on tablet', { x: 20, y: 20 });
  await expect(page.locator('[data-testid=pin][data-number="4"]')).toBeVisible();
  await page.getByTestId('bp-desktop').click();
  await expect(page.locator('[data-testid=pin][data-number="4"]')).toHaveCount(0);
  await expect(page.locator('[data-testid=pin][data-number="1"]')).toBeVisible();
  await page.getByTestId('bp-tablet').click();
  await page.reload();
  await waitFrameReady(page);
  await page.getByTestId('bp-tablet').click();
  await expect.poll(async () => { const r = await pinVsElement(page, 4, '.cards .card >> nth=2'); return inside(r.pin, r.el); }).toBe(true);
  const list = (await (await page.request.get(`/api/projects/${projectId}/comments`)).json()).comments;
  const c4 = list.find((c) => c.number === 4);
  expect(c4.breakpoint).toBe('tablet');
  expect(c4.anchor.viewportW).toBe(768);
});
