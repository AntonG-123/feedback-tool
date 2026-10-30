// Central runtime configuration. Every value comes from the environment so the
// same build runs locally, in tests and in production.
import path from 'node:path';
import crypto from 'node:crypto';

const env = process.env;
const isProd = env.NODE_ENV === 'production';

function bool(v, dflt = false) {
  if (v === undefined || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

const port = Number(env.PORT || 3000);
const proxyPort = Number(env.PROXY_PORT || port + 1);

let appSecret = env.APP_SECRET;
if (!appSecret) {
  if (isProd) throw new Error('APP_SECRET must be set in production');
  appSecret = 'dev-insecure-secret-change-me';
}

export const config = {
  isProd,
  // all = app + proxy in one process (two listeners); app / proxy = single role
  mode: env.SERVICE_MODE || 'all',
  port,
  proxyPort,
  appOrigin: (env.APP_ORIGIN || `http://localhost:${port}`).replace(/\/$/, ''),
  // The proxy MUST live on a different origin than the app so proxied site JS
  // can never read app cookies or storage.
  proxyOrigin: (env.PROXY_ORIGIN || `http://127.0.0.1:${proxyPort}`).replace(/\/$/, ''),
  // Internal URL the screenshot worker uses to reach the proxy listener.
  proxyInternalOrigin: (env.PROXY_INTERNAL_ORIGIN || `http://127.0.0.1:${proxyPort}`).replace(/\/$/, ''),
  databaseUrl: env.DATABASE_URL || '',
  appSecret,
  encryptionKey: crypto.createHash('sha256').update('enc:' + appSecret).digest(),
  storageDir: path.resolve(env.STORAGE_DIR || './data/storage'),
  email: {
    from: env.EMAIL_FROM || 'AGM Feedback <no-reply@agm-feedback.local>',
    resendApiKey: env.RESEND_API_KEY || '',
    smtpUrl: env.SMTP_URL || '',
  },
  // When no email provider is configured the login link can be shown on screen.
  // Only for evaluation deployments; never enable on a real production system.
  devLoginLinks: bool(env.DEV_LOGIN_LINKS, !isProd),
  validation: {
    provider: env.VALIDATION_PROVIDER || (env.ANTHROPIC_API_KEY ? 'anthropic' : 'rules'),
    anthropicApiKey: env.ANTHROPIC_API_KEY || '',
    anthropicModel: env.ANTHROPIC_MODEL || 'claude-opus-5-5',
    timeoutMs: Number(env.VALIDATION_TIMEOUT_MS || 10000),
  },
  transcription: {
    openaiApiKey: env.OPENAI_API_KEY || '',
    deepgramApiKey: env.DEEPGRAM_API_KEY || '',
  },
  proxy: {
    tokenTtlSeconds: Number(env.PROXY_TOKEN_TTL || 60 * 60 * 12),
    upstreamTimeoutMs: Number(env.PROXY_TIMEOUT_MS || 20000),
    maxRewriteBytes: Number(env.PROXY_MAX_REWRITE_BYTES || 15 * 1024 * 1024),
    // Test-only: "host=ip:port,host2=ip:port". Lets fixture sites on loopback be
    // proxied. Refused in production.
    testHostMap: isProd ? {} : parseHostMap(env.TEST_HOST_MAP || ''),
  },
  screenshots: {
    enabled: bool(env.SCREENSHOTS_ENABLED, true),
    chromiumPath: env.CHROMIUM_PATH || '',
    maxFullPageHeight: Number(env.SCREENSHOT_MAX_HEIGHT || 12000),
  },
  notifications: {
    intervalMs: Number(env.NOTIFY_INTERVAL_MS || 60 * 60 * 1000),
    checkEveryMs: Number(env.NOTIFY_CHECK_MS || 60 * 1000),
    // A burst of comments is collected into one email: wait until the oldest
    // pending comment is this old before sending.
    settleMs: Number(env.NOTIFY_SETTLE_MS || 10 * 60 * 1000),
  },
  workersEnabled: bool(env.WORKERS_ENABLED, true),
};

function parseHostMap(s) {
  const out = {};
  for (const part of s.split(',').map((x) => x.trim()).filter(Boolean)) {
    const [host, target] = part.split('=');
    const [ip, p] = target.split(':');
    out[host.toLowerCase()] = { ip, port: p ? Number(p) : undefined };
  }
  return out;
}
