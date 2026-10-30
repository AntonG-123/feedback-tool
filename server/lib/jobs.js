// Minimal durable job queue on Postgres (FOR UPDATE SKIP LOCKED). Used for
// screenshots and page discovery so expensive work never blocks a request.
import { query, one } from '../db/index.js';

const handlers = new Map();
let running = false;
let active = 0;

export function registerJob(type, handler, { concurrency = 1 } = {}) {
  handlers.set(type, { handler, concurrency });
}

export async function enqueue(type, payload, { delayMs = 0, maxAttempts = 3 } = {}) {
  return one(
    `INSERT INTO jobs (type, payload, run_at, max_attempts) VALUES ($1, $2, now() + ($3 || ' milliseconds')::interval, $4) RETURNING id`,
    [type, payload, String(delayMs), maxAttempts],
  );
}

async function claim(types) {
  return one(
    `UPDATE jobs SET status = 'running', locked_at = now(), attempts = attempts + 1
     WHERE id = (
       SELECT id FROM jobs WHERE status = 'queued' AND run_at <= now() AND type = ANY($1)
       ORDER BY run_at LIMIT 1 FOR UPDATE SKIP LOCKED
     ) RETURNING *`,
    [types],
  );
}

async function runOne(job) {
  const h = handlers.get(job.type);
  try {
    await h.handler(job.payload, job);
    await query(`UPDATE jobs SET status = 'done', last_error = NULL WHERE id = $1`, [job.id]);
  } catch (e) {
    const retry = job.attempts < job.max_attempts;
    console.error(`[jobs] ${job.type}#${job.id} attempt ${job.attempts} failed: ${e.message}`);
    await query(
      `UPDATE jobs SET status = $2, last_error = $3, run_at = now() + ($4 || ' seconds')::interval WHERE id = $1`,
      [job.id, retry ? 'queued' : 'failed', String(e.stack || e.message).slice(0, 2000), String(5 * job.attempts ** 2)],
    );
    if (!retry) await h.onFinalFailure?.(job.payload, e).catch(() => {});
  }
}

export function setFinalFailureHandler(type, fn) {
  handlers.get(type).onFinalFailure = fn;
}

export function startJobRunner() {
  if (running) return;
  running = true;
  // Jobs left "running" by a crashed process go back to the queue.
  query(`UPDATE jobs SET status = 'queued' WHERE status = 'running' AND locked_at < now() - interval '5 minutes'`).catch(() => {});
  const maxActive = Math.max(...[...handlers.values()].map((h) => h.concurrency), 1) + 1;
  const tick = async () => {
    if (!running) return;
    try {
      while (active < maxActive) {
        const job = await claim([...handlers.keys()]);
        if (!job) break;
        active++;
        runOne(job).finally(() => active--);
      }
    } catch (e) {
      console.error('[jobs] poll error', e.message);
    }
    setTimeout(tick, 700);
  };
  tick();
}

export function stopJobRunner() {
  running = false;
}
