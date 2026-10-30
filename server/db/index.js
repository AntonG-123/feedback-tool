import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pool;
let embedded;

// Local development / tests: start an embedded Postgres when no DATABASE_URL is
// configured. Production always uses DATABASE_URL.
async function ensureDatabaseUrl() {
  if (config.databaseUrl) return config.databaseUrl;
  if (config.isProd) throw new Error('DATABASE_URL must be set in production');
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const port = Number(process.env.EMBEDDED_PG_PORT || 54329);
  const dir = process.env.EMBEDDED_PG_DIR || '/var/lib/agm-pg/data';
  embedded = new EmbeddedPostgres({ databaseDir: dir, user: 'agm', password: 'agm', port, persistent: true, onLog: () => {} });
  if (!fs.existsSync(path.join(dir, 'PG_VERSION'))) await embedded.initialise();
  await embedded.start();
  const dbName = process.env.EMBEDDED_PG_DB || 'agm';
  await embedded.createDatabase(dbName).catch(() => {});
  return `postgres://agm:agm@127.0.0.1:${port}/${dbName}`;
}

export async function initDb() {
  const url = await ensureDatabaseUrl();
  const ssl = /sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined;
  pool = new pg.Pool({ connectionString: url, ssl, max: Number(process.env.PG_POOL_MAX || 10) });
  pool.on('error', (e) => console.error('[db] pool error', e.message));
  await migrate();
  return pool;
}

export async function closeDb() {
  await pool?.end();
  await embedded?.stop();
}

export function query(text, params) {
  return pool.query(text, params);
}

export async function one(text, params) {
  const r = await pool.query(text, params);
  return r.rows[0] || null;
}

export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function migrate() {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const done = new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    await tx(async (c) => {
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
    });
    console.log(`[db] applied migration ${f}`);
  }
}
