import { expect } from '@playwright/test';

const sessions = new Map();

// Logs in through the real magic-link flow once per email, then reuses the
// session cookie (the login endpoint is rate limited per email).
export async function loginAsOwner(page, email = `owner-${Date.now()}@example.com`) {
  if (sessions.has(email)) {
    await page.context().addCookies(sessions.get(email));
    return email;
  }
  await page.goto('/login');
  await page.getByLabel('Work email').fill(email);
  await page.getByRole('button', { name: 'Send magic link' }).click();
  await page.getByTestId('dev-login-link').click();
  await expect(page).toHaveURL(/\/projects$/);
  sessions.set(email, (await page.context().cookies()).filter((c) => c.name === 'agm_session'));
  return email;
}

export async function createProject(page, url) {
  await page.getByLabel('Website URL').fill(url);
  await page.getByRole('button', { name: /Create project/ }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}/);
  return page.url().match(/projects\/([0-9a-f-]{36})/)[1];
}

export const frame = (page) => page.frameLocator('[data-testid=preview-frame]');

export async function waitFrameReady(page) {
  await expect(page.locator('.state-cover')).toHaveCount(0, { timeout: 30_000 });
}

// Clicks an element inside the proxied page in comment mode.
export async function clickInFrame(page, selector, position) {
  await frame(page).locator(selector).first().click({ position });
}

// Screen coordinates of a pin vs. the element it is anchored to.
export async function pinVsElement(page, number, selector) {
  const pin = await page.locator(`[data-testid=pin][data-number="${number}"]`).boundingBox();
  const el = await frame(page).locator(selector).first().boundingBox();
  return { pin, el };
}
