// Captures the main screens at a fixed desktop viewport into docs/screenshots
// (used for visual review / regression comparison in docs/testing-report.md).
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { loginAsOwner, createProject, frame, waitFrameReady, clickInFrame } from './helpers.js';

const OUT = 'docs/screenshots';
test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 1440, height: 900 } });

test('capture screens', async ({ page }) => {
  fs.mkdirSync(OUT, { recursive: true });
  await page.goto('/login');
  await page.screenshot({ path: `${OUT}/01-login.png` });
  await loginAsOwner(page, `visual-${Date.now()}@example.com`);
  const id = await createProject(page, 'https://static.test/');
  await waitFrameReady(page);
  await expect(frame(page).locator('.hero-heading')).toBeVisible();
  await page.getByTestId('pages-tree').locator('[data-path="/services"] [data-testid=tree-toggle]').click();
  await page.screenshot({ path: `${OUT}/03-workspace.png` });

  await clickInFrame(page, '.hero-heading', { x: 60, y: 24 });
  await page.getByTestId('comment-input').fill('Please replace the image.');
  await expect(page.getByTestId('validation')).toBeVisible();
  await page.screenshot({ path: `${OUT}/04-composer-validation.png` });
  await page.getByTestId('comment-input').fill('Change the headline to "Websites that convert visitors"');
  await page.getByTestId('draw-toggle').click();
  const b = await page.getByTestId('draw-layer').boundingBox();
  await page.mouse.move(b.x + 20, b.y + 70); await page.mouse.down(); await page.mouse.move(b.x + 560, b.y + 150, { steps: 4 }); await page.mouse.up();
  await page.screenshot({ path: `${OUT}/05-drawing.png` });
  await page.getByTestId('draw-done').click();
  await page.getByTestId('submit-comment').click();
  await expect(page.getByTestId('shot-crop')).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/06-thread.png` });
  await page.getByTestId('tab-comments').click();
  await page.getByTestId('bp-tablet').click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/07-tablet-comments.png` });
  await page.getByTestId('bp-mobile').click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/08-mobile.png` });
  await page.getByTestId('bp-desktop').click();
  await page.getByTestId('fullscreen').click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/09-fullscreen.png` });
  await page.getByTestId('exit-fullscreen').click();
  await page.getByTestId('share').click();
  await page.screenshot({ path: `${OUT}/10-share.png` });
  await page.keyboard.press('Escape');
  await page.goto(`/projects/${id}/comments`);
  await expect(page.getByTestId('ov-row')).toHaveCount(1);
  await page.screenshot({ path: `${OUT}/11-overview.png` });
  await page.goto('/projects');
  await page.screenshot({ path: `${OUT}/02-projects.png` });
});
