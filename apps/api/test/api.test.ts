import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { setup, login } from "./helpers.js";
import { pool, one, q } from "../src/db/pool.js";
import { runScenario, SCENARIOS } from "../src/sim/engine.js";
import { investigate } from "../src/agent/run.js";
import { runTool } from "../src/agent/tools.js";
import { verifyPatch } from "../src/services/patches.js";
import { searchKnowledge } from "../src/services/knowledge.js";

let app: Awaited<ReturnType<typeof setup>>;
let responder: Record<string, string>, viewer: Record<string, string>;
const ingest = { "x-api-key": "rl_test_ingest" };

beforeAll(async () => {
  app = await setup();
  responder = await login(app);
  viewer = await login(app, "viewer@opsmeridian.dev");
});
afterAll(async () => { await app.close(); await pool.end(); });

/** Feeds N ticks of metrics for a service (baseline, then the given values). */
async function feed(service: string, metric: string, values: number[], startMinutesAgo = values.length) {
  const now = Date.now();
  const points = values.map((value, i) => ({ service, name: metric, value, ts: new Date(now - (startMinutesAgo - i) * 30_000).toISOString() }));
  return app.inject({ method: "POST", url: "/api/ingest/metrics", headers: ingest, payload: points });
}

describe("auth & RBAC", () => {
  it("rejects bad credentials with a generic message", async () => {
    const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "oncall@opsmeridian.dev", password: "nope" } });
    expect(r.statusCode).toBe(401);
  });
  it("requires a session and enforces roles", async () => {
    expect((await app.inject({ url: "/api/overview" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/overview", headers: viewer })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/sim/scenarios/bad-pool-config", headers: viewer })).statusCode).toBe(403);
  });
  it("issues short-lived stream tickets that can't be used as sessions", async () => {
    const { ticket } = (await app.inject({ url: "/api/auth/stream-ticket", headers: viewer })).json();
    expect((await app.inject({ url: "/api/overview", headers: { authorization: `Bearer ${ticket}` } })).statusCode).toBe(401);
  });
});

describe("ingestion", () => {
  it("requires an API key", async () => {
    expect((await app.inject({ method: "POST", url: "/api/ingest/logs", payload: { service: "x", message: "hi" } })).statusCode).toBe(401);
  });
  it("accepts single and batched logs and validates input", async () => {
    expect((await app.inject({ method: "POST", url: "/api/ingest/logs", headers: ingest, payload: { service: "catalog", level: "error", message: "boom 42" } })).json().accepted).toBe(1);
    expect((await app.inject({ method: "POST", url: "/api/ingest/logs", headers: ingest, payload: [{ service: "catalog", message: "a" }, { service: "catalog", message: "b" }] })).json().accepted).toBe(2);
    const bad = await app.inject({ method: "POST", url: "/api/ingest/logs", headers: ingest, payload: { service: "catalog", level: "loud", message: "x" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("validation_error");
  });
  it("is idempotent with Idempotency-Key", async () => {
    const h = { ...ingest, "idempotency-key": "batch-1" };
    expect((await app.inject({ method: "POST", url: "/api/ingest/logs", headers: h, payload: { service: "catalog", message: "once" } })).statusCode).toBe(202);
    expect((await app.inject({ method: "POST", url: "/api/ingest/logs", headers: h, payload: { service: "catalog", message: "once" } })).json().duplicate).toBe(true);
  });
  it("issues per-source API keys (admin only) and revokes them", async () => {
    const admin = await login(app, "admin@opsmeridian.dev");
    expect((await app.inject({ method: "POST", url: "/api/keys", headers: responder, payload: { name: "x" } })).statusCode).toBe(403);
    const key = (await app.inject({ method: "POST", url: "/api/keys", headers: admin, payload: { name: "fluent-bit" } })).json();
    expect((await app.inject({ method: "POST", url: "/api/ingest/logs", headers: { "x-api-key": key.key }, payload: { service: "catalog", message: "via key" } })).statusCode).toBe(202);
    await app.inject({ method: "DELETE", url: `/api/keys/${key.id}`, headers: admin });
    expect((await app.inject({ method: "POST", url: "/api/ingest/logs", headers: { "x-api-key": key.key }, payload: { service: "catalog", message: "revoked" } })).statusCode).toBe(401);
  });
  it("verifies GitHub webhook signatures and dedupes deliveries", async () => {
    const body = JSON.stringify({ deployment_status: { state: "success", created_at: new Date().toISOString() }, deployment: { sha: "abc1234def", description: "deploy", creator: { login: "octo" } }, repository: { full_name: "acme/catalog" } });
    const sig = `sha256=${crypto.createHmac("sha256", "whsec_test").update(body).digest("hex")}`;
    const headers = { "content-type": "application/json", "x-github-event": "deployment_status", "x-github-delivery": "d-1" };
    expect((await app.inject({ method: "POST", url: "/api/webhooks/github", headers: { ...headers, "x-hub-signature-256": "sha256=bad" }, payload: body })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/webhooks/github", headers: { ...headers, "x-hub-signature-256": sig }, payload: body })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/webhooks/github", headers: { ...headers, "x-hub-signature-256": sig }, payload: body })).json().duplicate).toBe(true);
    expect(await one("SELECT 1 FROM deploys WHERE sha = 'abc1234def' AND service = 'catalog'")).toBeTruthy();
  });
  it("opens one incident per Alertmanager alert and dedupes refires", async () => {
    const alert = { alerts: [{ status: "firing", labels: { alertname: "HighQueueDepth", service: "notifications", severity: "warning" }, annotations: { summary: "Queue depth high" } }] };
    const a = (await app.inject({ method: "POST", url: "/api/ingest/alerts", headers: ingest, payload: alert })).json().results[0];
    const b = (await app.inject({ method: "POST", url: "/api/ingest/alerts", headers: ingest, payload: alert })).json().results[0];
    expect(a.created).toBe(true);
    expect(b).toMatchObject({ created: false, incidentId: a.incidentId });
  });
});

describe("retrieval", () => {
  it("hybrid search finds the right runbook for an error signature", async () => {
    const hits = await searchKnowledge("could not acquire connection from pool", { service: "checkout-api" });
    expect(hits[0].title).toMatch(/pool exhaustion|pool resize/);
    expect(hits[0].bm25Rank !== null || hits[0].vectorRank !== null).toBe(true);
  });
});

describe("detection → investigation → verified fix → approval", () => {
  let incidentId: number;

  it("detects a sustained anomaly and correlates dependent services into one incident", async () => {
    await runScenario("bad-pool-config"); // config deploy with a real diff + repo snapshot change
    const base = Array.from({ length: 20 }, () => 0.006 + Math.random() * 0.001);
    const r = await feed("checkout-api", "error_rate", [...base, 0.12, 0.13]);
    expect(r.json().anomalies[0]).toMatchObject({ service: "checkout-api", anomalous: true });
    incidentId = r.json().anomalies[0].incidentId;
    const g = await feed("gateway", "error_rate", [...base.map((x) => x * 0.6), 0.05, 0.06]);
    expect(g.json().anomalies[0]).toMatchObject({ incidentId, correlated: true });
    const inc = await one("SELECT services, status FROM incidents WHERE id = $1", [incidentId]);
    expect(inc.services).toEqual(["checkout-api", "gateway"]);
    expect(await one("SELECT 1 FROM jobs WHERE name = 'investigate' AND payload->>'incidentId' = $1", [String(incidentId)])).toBeTruthy();
  });

  it("investigates: blames the config deploy, cites runbooks verbatim, proposes a verified revert", async () => {
    await feed("checkout-api", "latency_p95_ms", [...Array(20).fill(210), 3300, 3500]);
    await app.inject({ method: "POST", url: "/api/ingest/logs", headers: ingest, payload: Array.from({ length: 8 }, (_, i) => ({ service: "checkout-api", level: "error", message: `TimeoutError: could not acquire connection from pool within 3000ms (pool size 5, waiting ${20 + i})` })) });
    await investigate(incidentId, "test");
    const top = await one("SELECT h.*, d.message FROM hypotheses h JOIN deploys d ON d.id = h.suspect_deploy_id WHERE incident_id = $1 AND rank = 1 AND h.status = 'proposed'", [incidentId]);
    expect(top.message).toMatch(/Reduce DB pool/);
    expect(Number(top.confidence)).toBeGreaterThanOrEqual(0.8);
    expect(top.citations.length).toBeGreaterThan(0);
    for (const c of top.citations) {
      const chunk = await one("SELECT content, heading FROM doc_chunks WHERE id = $1", [c.chunkId]);
      expect((chunk.heading + " " + chunk.content).replace(/[`*]/g, "")).toContain(c.quote.replace(/[`*]/g, ""));
    }
    const fix = await one("SELECT * FROM fix_proposals WHERE incident_id = $1", [incidentId]);
    expect(fix.status).toBe("pending_approval");
    expect(fix.verification.passed).toBe(true);
    expect(fix.patch).toMatch(/-\s+"poolSize": 5,\n\+\s+"poolSize": 50,/);
    expect((await one("SELECT status FROM incidents WHERE id = $1", [incidentId])).status).toBe("identified");
  });

  it("verification rejects stale or unsafe patches", async () => {
    const stale = await verifyPatch("checkout-api", `--- a/config/database.json\n+++ b/config/database.json\n@@ -1,3 +1,3 @@\n {\n-  "host": "nope",\n+  "host": "x",\n   "database": "orders",\n`, "+test");
    expect(stale.passed).toBe(false);
    const unsafe = await verifyPatch("checkout-api", `--- a/config/database.json\n+++ b/config/database.json\n@@ -3,3 +3,3 @@\n   "database": "orders",\n-  "poolSize": 5,\n+  "poolSize": 2,\n   "acquireTimeoutMs": 3000,\n`, "+test");
    expect(unsafe.checks.find((c) => c.name.includes("pool size"))?.status).toBe("fail");
  });

  it("drops citations that were not retrieved or not verbatim (citation guard)", async () => {
    const ctx = { incident: await one("SELECT * FROM incidents WHERE id = $1", [incidentId]), retrieved: new Map(), deploysSeen: new Map(), hypotheses: [], fixes: [] };
    const hits = (await runTool(ctx, "search_runbooks", { query: "pool exhaustion" })) as { chunkId: number; content: string }[];
    const r = (await runTool(ctx, "submit_hypothesis", { title: "Pool exhausted", description: "Pool too small for traffic", category: "config_change", confidence: 0.7, evidence: [{ type: "log", label: "x", detail: "y" }],
      citations: [{ chunkId: hits[0].chunkId, quote: hits[0].content.slice(0, 40) }, { chunkId: hits[0].chunkId, quote: "this sentence was invented by the model" }, { chunkId: 999999, quote: "not retrieved at all here" }] })) as { verifiedCitations: number; droppedCitations: number };
    expect(r).toMatchObject({ verifiedCitations: 1, droppedCitations: 2 });
  });

  it("only responders can approve, approval opens a draft PR once, and it is audited", async () => {
    const fix = await one("SELECT id FROM fix_proposals WHERE incident_id = $1", [incidentId]);
    expect((await app.inject({ method: "POST", url: `/api/fixes/${fix.id}/approve`, headers: viewer, payload: {} })).statusCode).toBe(403);
    const ok = await app.inject({ method: "POST", url: `/api/fixes/${fix.id}/approve`, headers: responder, payload: { note: "LGTM" } });
    expect(ok.json()).toMatchObject({ status: "pr_opened", pr_mode: "simulated" });
    expect((await app.inject({ method: "POST", url: `/api/fixes/${fix.id}/approve`, headers: responder, payload: {} })).statusCode).toBe(409);
    expect((await one("SELECT status FROM incidents WHERE id = $1", [incidentId])).status).toBe("mitigating");
    expect(await one("SELECT 1 FROM audit_log WHERE action = 'fix.approve' AND target = $1", [`fix:${fix.id}`])).toBeTruthy();
  });

  it("exposes the war-room view and overview KPIs", async () => {
    const d = (await app.inject({ url: `/api/incidents/${incidentId}`, headers: viewer })).json();
    expect(d.steps.length).toBeGreaterThan(8);
    expect(d.events.map((e: { kind: string }) => e.kind)).toEqual(expect.arrayContaining(["detected", "status", "hypothesis", "fix", "pr"]));
    const o = (await app.inject({ url: "/api/overview", headers: viewer })).json();
    expect(o.kpi.open_incidents).toBeGreaterThan(0);
    expect(o.services.length).toBe(9);
    expect(o.kpi.agent_precision).toBeGreaterThan(0);
  });
});

describe("queue", () => {
  it("processes jobs with retries and dedupe", async () => {
    const { enqueue, registerHandler, startWorker, stopWorker } = await import("../src/lib/queue.js");
    let calls = 0;
    registerHandler("flaky", async () => { calls++; if (calls < 2) throw new Error("transient"); });
    await enqueue("flaky", {}, { dedupeKey: "flaky-1" });
    await enqueue("flaky", {}, { dedupeKey: "flaky-1" }); // deduped
    expect((await q("SELECT count(*)::int n FROM jobs WHERE name = 'flaky'"))[0].n).toBe(1);
    await q("UPDATE jobs SET run_at = now() WHERE name = 'flaky'");
    startWorker(1);
    for (let i = 0; i < 40 && (await one("SELECT status FROM jobs WHERE name = 'flaky'")).status !== "completed"; i++) {
      await new Promise((r) => setTimeout(r, 250));
      await q("UPDATE jobs SET run_at = now() WHERE name = 'flaky' AND status = 'waiting'");
    }
    await stopWorker();
    expect(await one("SELECT status, attempts FROM jobs WHERE name = 'flaky'")).toMatchObject({ status: "completed", attempts: 2 });
  });
});

it("simulator scenarios are well-formed", () => {
  expect(SCENARIOS.map((s) => s.id)).toEqual(["bad-pool-config", "payments-timeout", "inventory-cache-leak", "stripe-outage"]);
});

describe("safety", () => {
  it("never blames a rollback/fix deploy and never correlates into an incident under mitigation", async () => {
    // the earlier checkout incident is now 'mitigating' after approval; a rollback deploy has just landed
    await q("INSERT INTO deploys (service, sha, author, message, kind, files, diff, deployed_at) VALUES ('payments','rb1234567','opsmeridian-bot','Merge fix for incident #1 (rollback)','rollback','[{\"path\":\"config/http.json\"}]', $1, now())",
      [`--- a/config/http.json\n+++ b/config/http.json\n@@ -1,3 +1,3 @@\n {\n-  "timeoutMs": 800,\n+  "timeoutMs": 5000,\n`]);
    const base = Array.from({ length: 20 }, () => 0.003 + Math.random() * 0.0005);
    const r = (await feed("payments", "error_rate", [...base, 0.15, 0.16])).json();
    const mitigating = await one("SELECT id FROM incidents WHERE status = 'mitigating'");
    expect(r.anomalies[0].incidentId).not.toBe(mitigating?.id);
    await investigate(r.anomalies[0].incidentId, "test");
    const blamed = await q("SELECT d.author FROM hypotheses h JOIN deploys d ON d.id = h.suspect_deploy_id WHERE h.incident_id = $1", [r.anomalies[0].incidentId]);
    expect(blamed.map((b) => b.author)).not.toContain("opsmeridian-bot");
    expect(await q("SELECT 1 FROM fix_proposals WHERE incident_id = $1 AND title ILIKE '%rollback%'", [r.anomalies[0].incidentId])).toHaveLength(0);
  });
});
