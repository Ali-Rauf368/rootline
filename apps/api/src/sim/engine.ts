import { createTwoFilesPatch } from "diff";
import { cleanDiff } from "../services/patches.js";
import crypto from "node:crypto";
import { q } from "../db/pool.js";
import { publish } from "../lib/bus.js";
import { ingestLogs, ingestMetrics, ingestDeploy } from "../services/ingest.js";
import { addEvent } from "../services/incidents.js";
import { SERVICES } from "./catalog.js";

/**
 * Live traffic simulator: emits metrics every tick and logs for every service, and can inject realistic
 * failure scenarios (bad config deploy, code regression, upstream dependency outage) for demos and game days.
 */
interface Effect { service: string; err?: number; p95?: number; sat?: number; memGrowth?: number; logs?: { level: "error" | "warn"; msg: () => string; perTick: number }[] }
interface Active { id: string; startedAt: number; effects: Effect[]; ramp: number; resolved?: boolean }
const active: Active[] = [];
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const sha = () => crypto.randomBytes(20).toString("hex");
const traceId = () => crypto.randomBytes(8).toString("hex");

async function changeFile(service: string, path: string, edit: (s: string) => string) {
  const [row] = await q<{ content: string }>("SELECT content FROM repo_files WHERE service = $1 AND path = $2", [service, path]);
  const before = row?.content ?? "";
  const after = edit(before);
  await q("INSERT INTO repo_files (service, path, content) VALUES ($1,$2,$3) ON CONFLICT (service, path) DO UPDATE SET content = EXCLUDED.content, updated_at = now()", [service, path, after]);
  const diff = cleanDiff(createTwoFilesPatch(`a/${path}`, `b/${path}`, before, after, "", "", { context: 3 }));
  const adds = diff.split("\n").filter((l) => /^\+[^+]/.test(l)).length, dels = diff.split("\n").filter((l) => /^-[^-]/.test(l)).length;
  return { diff, file: { path, additions: adds, deletions: dels } };
}

export const SCENARIOS = [
  {
    id: "bad-pool-config", service: "checkout-api", name: "Checkout: database pool shrunk by config deploy",
    description: "A config deploy lowers checkout-api's DB pool from 50 to 5 connections. Latency explodes and requests start timing out.",
    async inject() {
      const c = await changeFile("checkout-api", "config/database.json", (s) => s.replace(/"poolSize": \d+/, '"poolSize": 5'));
      await ingestDeploy({ service: "checkout-api", sha: sha(), author: "jordan.lee", message: "Reduce DB pool to save connections on orders-db", kind: "config", files: [c.file], diff: c.diff, source: "simulator", prNumber: 4821 });
      return [
        { service: "checkout-api", err: 0.11, p95: 3400, sat: 0.98, logs: [{ level: "error" as const, perTick: 6, msg: () => `TimeoutError: could not acquire connection from pool within 3000ms (pool size 5, waiting ${Math.round(rnd(20, 60))}) [order ${crypto.randomUUID()}]` }, { level: "warn" as const, perTick: 2, msg: () => `slow request POST /checkout took ${Math.round(rnd(2800, 4200))}ms` }] },
        { service: "gateway", err: 0.035, p95: 900, logs: [{ level: "error" as const, perTick: 2, msg: () => `upstream checkout-api responded 504 after 5000ms route=/checkout` }] },
      ];
    },
  },
  {
    id: "payments-timeout", service: "payments", name: "Payments: client timeout lowered below Stripe p99",
    description: "A deploy cuts the payments HTTP client timeout from 5000 ms to 800 ms and disables retries. Authorisations fail.",
    async inject() {
      const c = await changeFile("payments", "config/http.json", (s) => s.replace(/"timeoutMs": \d+/, '"timeoutMs": 800').replace(/"retries": \d+/, '"retries": 0'));
      await ingestDeploy({ service: "payments", sha: sha(), author: "priya.n", message: "Fail fast on slow Stripe calls", kind: "config", files: [c.file], diff: c.diff, source: "simulator", prNumber: 1290 });
      return [
        { service: "payments", err: 0.16, p95: 820, logs: [{ level: "error" as const, perTick: 5, msg: () => `UpstreamTimeout: stripe-proxy did not respond within 800ms (attempt 1/1, retries 0) authorisation=${traceId()}` }] },
        { service: "checkout-api", err: 0.06, p95: 600, logs: [{ level: "error" as const, perTick: 2, msg: () => `PaymentAuthorisationFailed: payments returned 502 for order ${crypto.randomUUID()}` }] },
      ];
    },
  },
  {
    id: "inventory-cache-leak", service: "inventory", name: "Inventory: unbounded cache after code change",
    description: "A code deploy raises the stock cache bound to effectively unlimited. Memory climbs, GC pauses inflate latency.",
    async inject() {
      const c = await changeFile("inventory", "config/cache.json", (s) => s.replace(/"maxEntries": \d+/, '"maxEntries": 50000000'));
      await ingestDeploy({ service: "inventory", sha: sha(), author: "sam.k", message: "Cache all SKUs to cut DB reads", kind: "code", files: [c.file], diff: c.diff, source: "simulator", prNumber: 733 });
      return [{ service: "inventory", err: 0.05, p95: 1400, sat: 0.93, memGrowth: 40, logs: [{ level: "warn" as const, perTick: 3, msg: () => `GC overhead limit approaching: heap ${Math.round(rnd(3.1, 3.9) * 10) / 10}GB of 4GB, pause ${Math.round(rnd(300, 900))}ms` }, { level: "error" as const, perTick: 1, msg: () => `OutOfMemoryError: Java heap space while caching stock entries (cache size ${Math.round(rnd(4, 9))}M)` }] }];
    },
  },
  {
    id: "stripe-outage", service: "stripe-proxy", name: "Upstream: Stripe proxy degradation (no deploy)",
    description: "stripe-proxy latency degrades without any internal change. A good test of the agent's dependency reasoning.",
    async inject() {
      return [
        { service: "stripe-proxy", err: 0.04, p95: 4200, logs: [{ level: "warn" as const, perTick: 3, msg: () => `upstream api.stripe.com slow: ${Math.round(rnd(3500, 6000))}ms region=eu-west-1` }] },
        { service: "payments", err: 0.09, p95: 4800, logs: [{ level: "error" as const, perTick: 3, msg: () => `UpstreamTimeout: stripe-proxy did not respond within 5000ms (attempt 3/3)` }] },
      ];
    },
  },
] as const;

export async function runScenario(id: string) {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw Object.assign(new Error(`unknown scenario ${id}`), { statusCode: 404 });
  if (active.some((a) => a.id === id && !a.resolved)) return { started: false, message: "Scenario already running" };
  const effects = await s.inject();
  active.push({ id, startedAt: Date.now(), effects, ramp: 0 });
  return { started: true, scenario: id, message: `${s.name} injected. Expect detection within about a minute.` };
}

/** Called when a fix PR is "merged" in simulated mode: deploy the fix, recover metrics. */
export function onFixMerged(incidentId: number, service: string, files: { path: string; after: string }[]) {
  setTimeout(async () => {
    try {
      const changes = [];
      for (const f of files) changes.push(await changeFile(service, f.path, () => f.after));
      await ingestDeploy({ service, sha: sha(), author: "opsmeridian-bot", message: `Merge fix for incident #${incidentId} (rollback)`, kind: "rollback", files: changes.map((c) => c.file), diff: changes.map((c) => c.diff).join("\n"), source: "simulator" });
      for (const a of active) if (a.effects.some((e) => e.service === service)) a.resolved = true;
      setTimeout(() => addEvent(incidentId, "signal", "Metrics recovering", "Error rate and latency are returning to baseline after the fix deployed.", "opsmeridian").catch(() => {}), 45_000);
    } catch (e) { console.error("sim merge failed:", (e as Error).message); }
  }, 15_000);
}

const memory: Record<string, number> = {};
let tickCount = 0;

/** One simulator tick: metrics + logs for every service. */
export async function tick(now = new Date()) {
  tickCount++;
  const metrics: { service: string; name: string; ts: Date; value: number }[] = [];
  const logs: { service: string; ts: Date; level: "info" | "warn" | "error"; message: string; traceId: string }[] = [];
  const diurnal = 1 + 0.25 * Math.sin((now.getHours() + now.getMinutes() / 60 - 8) / 24 * 2 * Math.PI);

  for (const a of active) a.ramp = a.resolved ? Math.max(0, a.ramp - 0.25) : Math.min(1, a.ramp + 0.5);
  for (let i = active.length - 1; i >= 0; i--) if (active[i].resolved && active[i].ramp === 0) active.splice(i, 1);

  for (const s of SERVICES) {
    const effects = active.flatMap((a) => a.effects.filter((e) => e.service === s.name).map((e) => ({ e, r: a.ramp })));
    const lerp = (base: number, key: "err" | "p95" | "sat") => effects.reduce((v, { e, r }) => (e[key] !== undefined ? v + (e[key]! - base) * r : v), base);
    const rps = s.base.rps * diurnal * rnd(0.93, 1.07);
    const err = Math.max(0, lerp(s.base.err, "err") * rnd(0.75, 1.25));
    const p95 = lerp(s.base.p95, "p95") * rnd(0.9, 1.12);
    const sat = Math.min(1, lerp(0.35, "sat") * rnd(0.92, 1.08));
    const growth = effects.reduce((g, { e, r }) => g + (e.memGrowth ?? 0) * r, 0);
    memory[s.name] = growth ? Math.min(3900, (memory[s.name] ?? 900) + growth) : (memory[s.name] ?? 900) * 0.9 + 90 * rnd(9.5, 10.5) * 0.1;
    metrics.push(
      { service: s.name, name: "rps", ts: now, value: round(rps) }, { service: s.name, name: "error_rate", ts: now, value: round(err, 4) },
      { service: s.name, name: "latency_p95_ms", ts: now, value: round(p95) }, { service: s.name, name: "saturation", ts: now, value: round(sat, 3) },
      { service: s.name, name: "cpu", ts: now, value: round(Math.min(100, 30 + sat * 50 * rnd(0.9, 1.1))) }, { service: s.name, name: "memory_mb", ts: now, value: round(memory[s.name]) });
    if (Math.random() < 0.35) logs.push({ service: s.name, ts: now, level: "info", message: `${["GET", "POST"][Math.round(Math.random())]} /${s.name.split("-")[0]}/${Math.round(rnd(1, 900))} 200 in ${Math.round(p95 * rnd(0.2, 0.6))}ms`, traceId: traceId() });
    if (Math.random() < s.base.err * 15) logs.push({ service: s.name, ts: now, level: "warn", message: `retrying request to ${s.deps[0] ?? "cache"} after transient error (attempt 1)`, traceId: traceId() });
    for (const { e, r } of effects) for (const l of e.logs ?? []) for (let k = 0; k < Math.round(l.perTick * r); k++) logs.push({ service: s.name, ts: new Date(now.getTime() - k * 300), level: l.level, message: l.msg(), traceId: traceId() });
  }
  await ingestMetrics(metrics);
  await ingestLogs(logs);
  if (tickCount % 3 === 0) await publish({ type: "metrics.tick", ts: now.toISOString() });
}
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

let timer: NodeJS.Timeout | null = null;
export function startSimulator(intervalMs = 10_000) {
  const run = () => tick().catch((e) => console.error("simulator tick:", e.message));
  run();
  timer = setInterval(run, intervalMs);
  timer.unref();
}
export const stopSimulator = () => timer && clearInterval(timer);
