import { PgBoss } from "pg-boss";
import { q } from "../db/pool.js";
import { env } from "../lib/env.js";
import { publish } from "../lib/bus.js";
import { ingestBatch } from "./detect.js";
import { analyzeOpenFindings } from "./analyze.js";

/** Cost jobs run on pg-boss (PostgreSQL only), independent of whether Redis is configured for incident jobs. */
const QUEUE = "cost-batch";
let boss: Promise<PgBoss> | null = null;

function getBoss() {
  boss ??= (async () => {
    const b = new PgBoss({ connectionString: env.DATABASE_URL, max: 4 });
    b.on("error", (e) => console.error("pg-boss:", e.message));
    await b.start();
    await b.createQueue(QUEUE, { retryLimit: 3, retryDelay: 5, retryBackoff: true });
    return b;
  })().catch((e) => { boss = null; throw e; });
  return boss;
}

export async function processBatch(batchId: string) {
  await q("UPDATE cost_batches SET status = 'processing', error = NULL WHERE id = $1", [batchId]);
  try {
    const r = await ingestBatch(batchId);
    await analyzeOpenFindings();
    await q("UPDATE cost_batches SET status = 'completed', finished_at = now() WHERE id = $1", [batchId]);
    return r;
  } catch (e) {
    await q("UPDATE cost_batches SET status = 'failed', error = $2 WHERE id = $1", [batchId, (e as Error).message.slice(0, 1000)]);
    throw e;
  } finally { await publish({ type: "cost.updated" }); }
}

/** Registers the batch and queues it. Returns false for a batch that was already announced, unless it failed. */
export async function enqueueBatch(batchId: string, source = "nifi") {
  const fresh = await q(`INSERT INTO cost_batches (id, source) VALUES ($1,$2)
    ON CONFLICT (id) DO UPDATE SET status = 'queued', error = NULL WHERE cost_batches.status = 'failed' RETURNING id`, [batchId, source]);
  if (!fresh.length) return false;
  try { await (await getBoss()).send(QUEUE, { batchId }); }
  catch (e) { await q("UPDATE cost_batches SET status = 'failed', error = 'could not be queued' WHERE id = $1", [batchId]); throw e; }
  return true;
}

export async function startCostWorker() {
  await (await getBoss()).work<{ batchId: string }>(QUEUE, async (jobs) => { for (const j of jobs) await processBatch(j.data.batchId); });
}
export async function stopCostJobs() { const b = await boss?.catch(() => null); boss = null; await b?.stop({ graceful: true, timeout: 10_000 }); }
