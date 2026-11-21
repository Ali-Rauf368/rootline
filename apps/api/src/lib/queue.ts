import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { env } from "./env.js";
import { one, q } from "../db/pool.js";

/**
 * Job queue with two backends:
 *  - BullMQ on Redis when REDIS_URL is set
 *  - otherwise a durable Postgres queue (FOR UPDATE SKIP LOCKED, retries with exponential backoff, dedupe keys)
 * Both expose the same enqueue/handle API.
 */
export type Handler = (payload: any, meta: { attempt: number; jobId: string }) => Promise<void>; // eslint-disable-line @typescript-eslint/no-explicit-any
const handlers = new Map<string, Handler>();
export const QUEUE = "rootline";
export const queueBackend = () => (env.REDIS_URL ? "bullmq" : "postgres");

let bull: Queue | null = null;
const redis = () => new Redis(env.REDIS_URL!, { maxRetriesPerRequest: null });

export function registerHandler(name: string, fn: Handler) { handlers.set(name, fn); }

export async function enqueue(name: string, payload: Record<string, unknown>, opts: { delayMs?: number; dedupeKey?: string; maxAttempts?: number } = {}) {
  if (env.REDIS_URL) {
    bull ??= new Queue(QUEUE, { connection: redis() });
    // BullMQ job ids must not contain ':'
    await bull.add(name, payload, { jobId: opts.dedupeKey?.replace(/:/g, "-"), delay: opts.delayMs, attempts: opts.maxAttempts ?? 3, backoff: { type: "exponential", delay: 2000 }, removeOnComplete: 500, removeOnFail: 1000 });
    return;
  }
  await q(
    `INSERT INTO jobs (queue, name, payload, run_at, max_attempts, dedupe_key) VALUES ($1,$2,$3, now() + ($4 || ' milliseconds')::interval, $5, $6)
     ON CONFLICT (queue, dedupe_key) WHERE status IN ('waiting','active') AND dedupe_key IS NOT NULL DO NOTHING`,
    [QUEUE, name, payload, String(opts.delayMs ?? 0), opts.maxAttempts ?? 3, opts.dedupeKey ?? null]
  );
}

let stopping = false;
let pgLoop: Promise<void> | null = null;
let bullWorker: Worker | null = null;

async function runPgJob() {
  const job = await one<{ id: number; name: string; payload: unknown; attempts: number; max_attempts: number }>(
    `UPDATE jobs SET status = 'active', locked_at = now(), attempts = attempts + 1
     WHERE id = (SELECT id FROM jobs WHERE queue = $1 AND status = 'waiting' AND run_at <= now() ORDER BY run_at, id FOR UPDATE SKIP LOCKED LIMIT 1)
     RETURNING id, name, payload, attempts, max_attempts`, [QUEUE]);
  if (!job) return false;
  const fn = handlers.get(job.name);
  try {
    if (!fn) throw new Error(`no handler for ${job.name}`);
    await fn(job.payload, { attempt: job.attempts, jobId: String(job.id) });
    await q("UPDATE jobs SET status = 'completed', finished_at = now() WHERE id = $1", [job.id]);
  } catch (e) {
    const msg = (e as Error).message;
    const retry = job.attempts < job.max_attempts;
    await q(`UPDATE jobs SET status = $2, last_error = $3, locked_at = NULL, run_at = now() + ($4 || ' milliseconds')::interval, finished_at = CASE WHEN $2 = 'failed' THEN now() END WHERE id = $1`,
      [job.id, retry ? "waiting" : "failed", msg.slice(0, 1000), String(2000 * 2 ** (job.attempts - 1))]);
    console.error(`job ${job.name}#${job.id} attempt ${job.attempts} failed: ${msg}`);
  }
  return true;
}

/** Starts consuming jobs with the given concurrency. */
export function startWorker(concurrency = 3) {
  if (env.REDIS_URL) {
    bullWorker = new Worker(QUEUE, async (job) => {
      const fn = handlers.get(job.name);
      if (!fn) throw new Error(`no handler for ${job.name}`);
      await fn(job.data, { attempt: job.attemptsMade + 1, jobId: String(job.id) });
    }, { connection: redis(), concurrency });
    return;
  }
  // recover jobs abandoned by a crashed worker
  q("UPDATE jobs SET status = 'waiting', locked_at = NULL WHERE status = 'active' AND locked_at < now() - interval '10 minutes'").catch(() => {});
  const lane = async () => {
    while (!stopping) {
      const worked = await runPgJob().catch((e) => { console.error("queue poll:", e.message); return false; });
      if (!worked) await new Promise((r) => setTimeout(r, 500));
    }
  };
  pgLoop = Promise.all(Array.from({ length: concurrency }, lane)).then(() => {});
}

export async function stopWorker() {
  stopping = true;
  await bullWorker?.close();
  await pgLoop;
  await bull?.close();
}

export async function queueStats() {
  if (env.REDIS_URL) {
    bull ??= new Queue(QUEUE, { connection: redis() });
    const c = await bull.getJobCounts("waiting", "active", "completed", "failed", "delayed");
    return { backend: "bullmq", ...c };
  }
  const rows = await q<{ status: string; n: number }>("SELECT status, count(*)::int n FROM jobs WHERE queue = $1 GROUP BY status", [QUEUE]);
  return { backend: "postgres", ...Object.fromEntries(rows.map((r) => [r.status, r.n])) };
}
