import crypto from "node:crypto";
import { one, q } from "../db/pool.js";
import { processBatch } from "./jobs.js";

/** 30 days of demo billing, loaded through the same staging → merge → detect path NiFi uses. */
export async function seedCosts() {
  if (await one("SELECT 1 FROM cost_records LIMIT 1")) return false;
  type R = { p: string; id: string; type: string; svc: string; cost: number; cpu?: number; att?: string; env: string; owner: string; spike?: number };
  const fleet: R[] = [
    { p: "aws", id: "i-0checkout-api", type: "instance", svc: "AmazonEC2", cost: 42, cpu: 46, env: "production", owner: "checkout-team" },
    { p: "aws", id: "i-0reporting-batch", type: "instance", svc: "AmazonEC2", cost: 31, cpu: 6.5, env: "production", owner: "data-team" },
    { p: "aws", id: "i-0staging-runner", type: "instance", svc: "AmazonEC2", cost: 14, cpu: 0.8, env: "staging", owner: "checkout-team" },
    ...Array.from({ length: 5 }, (_, i): R => ({ p: "aws", id: `vol-0staging${i + 1}`, type: "volume", svc: "AmazonEBS", cost: 1.6 + i * 0.4, env: "staging", owner: "checkout-team" })),
    { p: "aws", id: "vol-0orders-db", type: "volume", svc: "AmazonEBS", cost: 9, att: "i-0checkout-api", env: "production", owner: "checkout-team" },
    { p: "aws", id: "media-assets", type: "bucket", svc: "AmazonS3", cost: 18, env: "production", owner: "media-team", spike: 2.1 },
    { p: "gcp", id: "analytics-worker", type: "instance", svc: "Compute Engine", cost: 22, cpu: 4.2, env: "development", owner: "data-team" },
    { p: "gcp", id: "legacy-nat-ip", type: "ip", svc: "Networking", cost: 0.8, env: "production", owner: "platform-team" },
    { p: "gcp", id: "warehouse", type: "dataset", svc: "BigQuery", cost: 36, env: "production", owner: "data-team" },
  ];
  const batch = `demo-${crypto.randomUUID()}`;
  for (let d = 30; d >= 1; d--) for (const r of fleet) {
    const wobble = 1 + 0.04 * Math.sin(d * 1.7 + r.id.length), date = new Date(Date.now() - d * 86400_000).toISOString().slice(0, 10);
    await q("INSERT INTO cost_staging (batch_id, provider, resource_id, resource_type, service, usage_cost, cpu_avg, attached_instance_id, tags, billing_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [batch, r.p, r.id, r.type, r.svc, (r.cost * wobble * (d === 1 ? r.spike ?? 1 : 1)).toFixed(4), r.cpu === undefined ? null : (r.cpu * wobble).toFixed(2), r.att ?? null, JSON.stringify({ env: r.env, owner: r.owner }), date]);
  }
  await q("INSERT INTO cost_batches (id, source) VALUES ($1,'demo')", [batch]);
  await processBatch(batch);
  return true;
}
