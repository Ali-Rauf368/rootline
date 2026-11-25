import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { setup, login } from "./helpers.js";
import { pool, one, q } from "../src/db/pool.js";
import { processBatch, stopCostJobs, startCostWorker } from "../src/finops/jobs.js";
import { analyzeOpenFindings, reconcile, ruleAnalysis, type Finding } from "../src/finops/analyze.js";
import { seedCosts } from "../src/finops/demo.js";
import { setFlags } from "../src/lib/flags.js";

let app: Awaited<ReturnType<typeof setup>>;
let responder: Record<string, string>, viewer: Record<string, string>, admin: Record<string, string>;
beforeAll(async () => { app = await setup(); [responder, viewer, admin] = await Promise.all([login(app), login(app, "viewer@opsmeridian.dev"), login(app, "admin@opsmeridian.dev")]); });
afterAll(async () => { await stopCostJobs(); await app.close(); await pool.end(); });
beforeEach(() => q("TRUNCATE cost_staging, cost_batches, cost_records, cost_findings, cost_exclusions"));

type Row = { id?: string; type?: string; svc?: string; cost?: unknown; cpu?: unknown; att?: string; tags?: string; date: string };
const day = (n: number) => new Date(Date.UTC(2026, 0, n)).toISOString().slice(0, 10);
async function stage(batch: string, rows: Row[]) {
  for (const r of rows) await q("INSERT INTO cost_staging (batch_id, provider, resource_id, resource_type, service, usage_cost, cpu_avg, attached_instance_id, tags, billing_date) VALUES ($1,'AWS',$2,$3,$4,$5,$6,$7,$8,$9)",
    [batch, r.id ?? "i-1", r.type ?? "instance", r.svc ?? "EC2", String(r.cost ?? 10), r.cpu ?? null, r.att ?? null, r.tags ?? '{"env":"staging","owner":"checkout-team"}', r.date]);
  await q("INSERT INTO cost_batches (id) VALUES ($1)", [batch]);
}
const load = async (batch: string, rows: Row[]) => { await stage(batch, rows); return processBatch(batch); };
const days = (n: number, f: (d: number) => Partial<Row>) => Array.from({ length: n }, (_, i) => ({ date: day(i + 1), ...f(i + 1) }));
const call = (url: string, headers: Record<string, string>, payload: object = {}) => app.inject({ method: "POST", url, headers, payload });

describe("cost ingestion", () => {
  it("rejects invalid rows without failing the batch and sums duplicate lines", async () => {
    const r = await load("b1", [{ date: day(1), cost: 5 }, { date: day(1), cost: 7 }, { date: "2026-13-40" }, { date: day(2), cost: "NaN" }, { date: day(2), cpu: "250" }, { date: day(2), tags: "not json" }, { date: day(2), tags: "[1]" }]);
    expect(r).toEqual({ accepted: 2, rejected: 5 });
    expect((await one("SELECT usage_cost FROM cost_records")).usage_cost).toBe(12);
  });
  it("re-importing a day overwrites it", async () => {
    await load("b1", [{ date: day(1), cost: 5 }]); await load("b2", [{ date: day(1), cost: 8 }]);
    expect(await q("SELECT usage_cost FROM cost_records")).toEqual([{ usage_cost: 8 }]);
  });
  it("webhook needs a key, dedupes, and pg-boss runs the batch", async () => {
    const url = "/api/webhooks/nifi-batch-complete", key = { "x-api-key": "rl_test_ingest" };
    expect((await call(url, {}, { batchId: "w" })).statusCode).toBe(401);
    expect((await call(url, key, {})).statusCode).toBe(400);
    await q("INSERT INTO cost_staging (batch_id, provider, resource_id, service, usage_cost, billing_date) VALUES ('w','aws','r','S3','3','2026-01-01')");
    await startCostWorker();
    expect((await call(url, key, { batchId: "w" })).statusCode).toBe(202);
    expect((await call(url, key, { batchId: "w" })).json()).toEqual({ duplicate: true });
    await expect.poll(async () => (await one("SELECT status FROM cost_batches WHERE id = 'w'")).status, { timeout: 15_000 }).toBe("completed");
    expect((await one("SELECT count(*)::int n FROM cost_records")).n).toBe(1);
  });
});

describe("cost detection", () => {
  const rules = async () => (await q("SELECT rule FROM cost_findings WHERE status = 'open'")).map((r) => r.rule);
  it("flags spikes strictly above 25% of the 7-day average", async () => {
    await load("a", days(8, (d) => ({ cost: d === 8 ? 12.5 : 10 }))); expect(await rules()).toEqual([]);
    await load("b", [{ date: day(8), cost: 12.6 }]); expect(await rules()).toEqual(["spike"]);
  });
  it("needs a full week of history for a spike", async () => { await load("a", days(7, (d) => ({ cost: d === 7 ? 90 : 10 }))); expect(await rules()).toEqual([]); });
  it("separates idle from over-provisioned and needs 14 days", async () => {
    await load("a", [...days(14, () => ({ id: "idle", cpu: 1 })), ...days(14, () => ({ id: "big", cpu: 9.9 })), ...days(14, () => ({ id: "ok", cpu: 10 })), ...days(14, (d) => ({ id: "new", cpu: d > 2 ? 1 : undefined }))]);
    expect(await q("SELECT resource_id, rule, max_savings FROM cost_findings ORDER BY 1")).toEqual([{ resource_id: "big", rule: "overprovisioned", max_savings: 150 }, { resource_id: "idle", rule: "idle", max_savings: 300 }]);
  });
  it("flags unattached volumes only, and resolves them once attached", async () => {
    await load("a", [{ date: day(1), id: "vol", type: "volume" }, { date: day(1), id: "used", type: "volume", att: "i-9" }, { date: day(1), id: "bucket", type: "bucket" }]);
    expect(await q("SELECT resource_id FROM cost_findings")).toEqual([{ resource_id: "vol" }]);
    await load("b", [{ date: day(2), id: "vol", type: "volume", att: "i-9" }]);
    expect((await one("SELECT status FROM cost_findings")).status).toBe("resolved");
  });
});

describe("cost analysis", () => {
  it("caps savings, ignores unknown ids and fills gaps", async () => {
    const f = (id: number) => ({ id, rule: "idle", provider: "aws", resource_id: `i-${id}`, service: "EC2", team: "t", env: "staging", monthly_cost: 10, max_savings: 10, evidence: {} }) as Finding;
    const a = (findingId: number) => ({ findingId, rootCause: "x", riskLevel: "LOW" as const, remediationSnippet: "y", estimatedMonthlySavings: 999 });
    const out = reconcile([f(1), f(2)], [a(1), a(77)]);
    expect(out.map((o) => [o.findingId, o.source, o.estimatedMonthlySavings])).toEqual([[1, "gemini", 10], [2, "rules", 10]]);
  });
  it("falls back to rules when the model fails, and batches by service and team", async () => {
    await load("a", Array.from({ length: 17 }, (_, i) => ({ date: day(1), id: `vol-${i}`, type: "volume" })));
    expect((await one("SELECT count(*)::int n FROM cost_findings WHERE analysis_source = 'rules'")).n).toBe(17);
    await q("UPDATE cost_findings SET analysis_source = NULL");
    const sizes: number[] = [];
    await analyzeOpenFindings(async (fs) => { sizes.push(fs.length); throw new Error("quota"); }, true);
    expect(sizes).toEqual([15, 2]);
    expect((await one("SELECT count(*)::int n FROM cost_findings WHERE analysis_source = 'rules'")).n).toBe(17);
  });
  it("neutralises hostile resource ids in Terraform", () => {
    const s = ruleAnalysis({ id: 1, rule: "idle", provider: "aws", resource_id: 'x"\n}\nresource "evil" "${a}', service: "s", team: "t", env: "e", monthly_cost: 1, max_savings: 1, evidence: {} }).remediationSnippet;
    expect(s.split("\n")).toHaveLength(3); expect(s).not.toMatch(/[^$]\$\{/);
  });
});

describe("cost decisions", () => {
  const finding = async () => { await load("a", [{ date: day(1), id: "vol", type: "volume" }]); return (await one("SELECT id FROM cost_findings")).id as number; };
  it("enforces roles and decides once, with audit", async () => {
    const id = await finding();
    expect((await call(`/api/costs/findings/${id}/approve`, viewer)).statusCode).toBe(403);
    expect((await call(`/api/costs/findings/${id}/approve`, responder)).json().status).toBe("pr_opened");
    expect((await call(`/api/costs/findings/${id}/approve`, responder)).statusCode).toBe(409);
    expect(await one("SELECT 1 FROM audit_log WHERE action = 'cost.approve' AND target = $1", [`cost:${id}`])).toBeTruthy();
    expect((await app.inject({ url: "/api/costs/summary", headers: viewer })).json()).toMatchObject({ wasteMonthly: 0, approvedMonthly: 300 });
  });
  it("honours two-person approval", async () => {
    const id = await finding(); await setFlags({ two_person_approval: true });
    try {
      for (let i = 0; i < 2; i++) expect((await call(`/api/costs/findings/${id}/approve`, responder)).statusCode).toBe(202);
      expect((await call(`/api/costs/findings/${id}/approve`, admin)).json().status).toBe("pr_opened");
    } finally { await setFlags({ two_person_approval: false }); }
  });
  it("intentional resources are ignored on later runs", async () => {
    const id = await finding();
    expect((await call(`/api/costs/findings/${id}/intentional`, responder, { reason: "kept for audit" })).statusCode).toBe(200);
    await q("DELETE FROM cost_findings"); await load("b", [{ date: day(2), id: "vol", type: "volume" }]);
    expect(await q("SELECT 1 FROM cost_findings")).toHaveLength(0);
  });
  it("demo data exercises every rule", async () => {
    await seedCosts();
    expect((await q("SELECT DISTINCT rule FROM cost_findings ORDER BY 1")).map((r) => r.rule)).toEqual(["idle", "overprovisioned", "spike", "unattached"]);
    const list = (await app.inject({ url: "/api/costs/findings?search=CHECKOUT", headers: viewer })).json();
    expect(list.length).toBeGreaterThan(0);
  });
});
