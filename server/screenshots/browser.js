// Shared headless Chromium for the screenshot pipeline and snapshot mode.
import { chromium } from 'playwright';
import { config } from '../config.js';
import { assertSafeUrl, isPublicIp, resolvePublic } from '../lib/ssrf.js';
import { hmac } from '../lib/crypto.js';

let browserPromise = null;

export async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium
      .launch({
        executablePath: config.screenshots.chromiumPath || undefined,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars', '--mute-audio'],
      })
      .then((b) => {
        b.on('disconnected', () => (browserPromise = null));
        return b;
      })
      .catch((e) => {
        browserPromise = null;
        throw e;
      });
  }
  return browserPromise;
}

export async function closeBrowser() {
  if (browserPromise) (await browserPromise.catch(() => null))?.close().catch(() => {});
  browserPromise = null;
}

// SSRF guard for the server-side browser: pages are always loaded through
// our proxy, but site JavaScript could still try to request other hosts
// directly. Only the internal proxy origin and public addresses are allowed.
export async function guardRoutes(context) {
  const internal = new URL(config.proxyInternalOrigin).origin;
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (/^(data|blob|about):/.test(url)) return route.continue();
    try {
      const u = new URL(url);
      if (u.origin === internal) return route.continue();
      assertSafeUrl(u);
      const host = u.hostname.replace(/^\[|\]$/g, '');
      if (!config.proxy.testHostMap[host.toLowerCase()]) {
        const addrs = await resolvePublic(host);
        if (!addrs.every((a) => isPublicIp(a.address))) return route.abort('blockedbyclient');
      }
      return route.continue();
    } catch {
      return route.abort('blockedbyclient');
    }
  });
}

export const renderHeaderValue = (token) => hmac('render:' + token).slice(0, 22);

const snapshotCache = new Map();

// Snapshot mode: render the page in headless Chromium THROUGH THE PROXY (same
// token as the viewer, so SSRF checks, site auth and URL rewriting all apply),
// let its scripts run, then return the serialized DOM without our injected
// elements. The proxy strips scripts from it before serving.
export async function renderSnapshot(project, url, token) {
  const key = `${project.id}|${url}`;
  const hit = snapshotCache.get(key);
  if (hit && hit.at > Date.now() - 10 * 60 * 1000) return hit.html;
  const browser = await getBrowser();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { 'x-agm-render': renderHeaderValue(token) } });
  try {
    await guardRoutes(context);
    const page = await context.newPage();
    const u = new URL(url);
    await page.goto(`${config.proxyInternalOrigin}/p/${token}/${u.protocol.slice(0, -1)}/${u.host}${u.pathname}${u.search}`, { waitUntil: 'load', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    if (await page.$('[data-agm-error]')) throw new Error('Snapshot render failed: ' + (await page.$eval('[data-agm-error]', (e) => e.getAttribute('data-agm-error'))));
    await autoScroll(page);
    const html = await page.evaluate(() => {
      document.querySelectorAll('[data-agm], agm-overlay').forEach((e) => e.remove());
      return '<!doctype html>' + document.documentElement.outerHTML;
    });
    snapshotCache.set(key, { html, at: Date.now() });
    return html;
  } finally {
    await context.close().catch(() => {});
  }
}

export async function autoScroll(page, maxSteps = 12) {
  await page
    .evaluate(async (max) => {
      const step = Math.max(400, innerHeight * 0.9);
      for (let i = 0; i < max; i++) {
        const before = scrollY;
        scrollBy(0, step);
        await new Promise((r) => setTimeout(r, 120));
        if (scrollY === before) break;
      }
      scrollTo(0, 0);
      await new Promise((r) => setTimeout(r, 150));
    }, maxSteps)
    .catch(() => {});
}
