import { defineConfig } from '@playwright/test';
import { TEST_HOST_MAP } from './tests/fixtures/sites.js';

const PORT = 3100;
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'test-results/results.json' }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
    screenshot: 'only-on-failure',
  },
  webServer: [
    { command: 'node tests/fixtures/sites.js', port: 4101, reuseExistingServer: false },
    {
      command: 'node server/index.js',
      url: `http://localhost:${PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        PORT: String(PORT),
        PROXY_PORT: String(PORT + 1),
        APP_ORIGIN: `http://localhost:${PORT}`,
        PROXY_ORIGIN: `http://127.0.0.1:${PORT + 1}`,
        TEST_HOST_MAP,
        EMBEDDED_PG_PORT: '54339',
        EMBEDDED_PG_DIR: '/var/lib/agm-pg/test',
        STORAGE_DIR: './data/test-storage',
        NOTIFY_INTERVAL_MS: '4000',
        NOTIFY_CHECK_MS: '1000',
        NOTIFY_SETTLE_MS: '2500',
        DEV_LOGIN_LINKS: 'true',
        PROXY_TIMEOUT_MS: '5000',
      },
    },
  ],
});
