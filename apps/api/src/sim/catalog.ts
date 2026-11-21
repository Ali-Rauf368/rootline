/** Demo estate: services, dependency graph, repository snapshots and baseline behaviour. */
export const SERVICES = [
  { name: "gateway", display: "API Gateway", tier: 1, team: "edge", deps: ["checkout-api", "catalog", "search"], lang: "go", base: { rps: 950, err: 0.004, p95: 120 } },
  { name: "checkout-api", display: "Checkout API", tier: 1, team: "payments-squad", deps: ["payments", "inventory", "orders-db"], lang: "typescript", base: { rps: 180, err: 0.006, p95: 210 } },
  { name: "payments", display: "Payments", tier: 1, team: "payments-squad", deps: ["stripe-proxy"], lang: "java", base: { rps: 140, err: 0.003, p95: 260 } },
  { name: "inventory", display: "Inventory", tier: 2, team: "fulfilment", deps: ["orders-db"], lang: "go", base: { rps: 320, err: 0.002, p95: 85 } },
  { name: "catalog", display: "Catalog", tier: 2, team: "discovery", deps: [], lang: "typescript", base: { rps: 610, err: 0.001, p95: 60 } },
  { name: "search", display: "Search", tier: 2, team: "discovery", deps: ["catalog"], lang: "python", base: { rps: 400, err: 0.002, p95: 140 } },
  { name: "stripe-proxy", display: "Stripe Proxy", tier: 2, team: "payments-squad", deps: [], lang: "go", base: { rps: 140, err: 0.001, p95: 180 } },
  { name: "orders-db", display: "Orders DB (Postgres)", tier: 1, team: "data-platform", deps: [], lang: "sql", base: { rps: 900, err: 0.0005, p95: 12 } },
  { name: "notifications", display: "Notifications", tier: 3, team: "growth", deps: [], lang: "python", base: { rps: 60, err: 0.004, p95: 300 } },
] as const;

export const REPOS: Record<string, Record<string, string>> = {
  "checkout-api": {
    "config/database.json": JSON.stringify({ host: "orders-db.internal", database: "orders", poolSize: 50, acquireTimeoutMs: 3000, idleTimeoutMs: 30000, statementTimeoutMs: 5000 }, null, 2) + "\n",
    "src/db.ts": `import { Pool } from "pg";\nimport config from "../config/database.json";\n\nexport const pool = new Pool({\n  host: config.host,\n  database: config.database,\n  max: config.poolSize,\n  connectionTimeoutMillis: config.acquireTimeoutMs,\n  idleTimeoutMillis: config.idleTimeoutMs,\n});\n`,
  },
  payments: {
    "config/http.json": JSON.stringify({ upstream: "https://stripe-proxy.internal", timeoutMs: 5000, retries: 3, circuitBreaker: { failureThreshold: 20, resetMs: 30000 } }, null, 2) + "\n",
  },
  inventory: {
    "config/cache.json": JSON.stringify({ backend: "in-process", maxEntries: 50000, ttlSeconds: 300 }, null, 2) + "\n",
    "src/cache.ts": `import config from "../config/cache.json";\nimport { LRUCache } from "lru-cache";\n\nexport const stockCache = new LRUCache<string, number>({\n  max: config.maxEntries,\n  ttl: config.ttlSeconds * 1000,\n});\n`,
  },
};

export const KNOWLEDGE = [
  { kind: "runbook", service: "checkout-api", title: "Checkout API: database connection pool exhaustion", content: `# Checkout API: database connection pool exhaustion

## Symptoms
- p95 latency on checkout-api jumps from ~200 ms to several seconds.
- Errors like \`TimeoutError: could not acquire connection from pool\` in checkout-api logs.
- Gateway 5xx rate rises on /checkout routes while orders-db itself looks healthy (low CPU, few active connections).

## Cause
The pool size in config/database.json (\`poolSize\`) is too small for current traffic. At peak, checkout needs at least 40 concurrent connections; requests queue for a connection until acquireTimeoutMs elapses and then fail.

## Mitigation
1. Check for a recent change to config/database.json. If poolSize was lowered, roll it back immediately. Reverting the config change is the fastest safe mitigation.
2. Do not raise acquireTimeoutMs above 5000 ms; it only hides the problem and ties up gateway workers.
3. Confirm recovery: p95 latency back under 400 ms and the pool timeout errors stop within 2 minutes of the rollback.

## Prevention
poolSize must stay between 40 and 200. Changes to database configuration require a load test and a review from data-platform.` },
  { kind: "runbook", service: "payments", title: "Payments: upstream timeouts to stripe-proxy", content: `# Payments: upstream timeouts to stripe-proxy

## Symptoms
- Payments error rate rises; logs show \`UpstreamTimeout: stripe-proxy did not respond within\` a short deadline.
- Checkout reports payment authorisation failures.

## Diagnosis
Compare payments' configured client timeout (config/http.json \`timeoutMs\`) with stripe-proxy p95 latency. Stripe authorisations legitimately take up to 2.5 s at p99, so a client timeout below 3000 ms causes false failures even when stripe-proxy is healthy.
If stripe-proxy latency itself is elevated, the problem is upstream: check the Stripe status page and fail over to the secondary region.

## Mitigation
- If timeoutMs was recently lowered, revert it. The safe range is 3000-10000 ms with 2-3 retries.
- If stripe-proxy is degraded, enable the payments circuit breaker and queue authorisations for retry.` },
  { kind: "runbook", service: "inventory", title: "Inventory: memory growth and cache eviction", content: `# Inventory: memory growth and cache eviction

## Symptoms
- Inventory memory grows steadily after a deploy; GC pauses increase p95 latency.
- Logs show \`GC overhead\` warnings and eventually \`OutOfMemoryError\` restarts.

## Cause
The in-process stock cache must be bounded. config/cache.json \`maxEntries\` controls the LRU bound; removing or massively raising it lets the cache grow without limit.

## Mitigation
Restore a bounded maxEntries (≤ 100000) and redeploy. Restarting pods buys time but does not fix the leak.` },
  { kind: "postmortem", service: "checkout-api", title: "Postmortem INC-0942: checkout outage after pool resize", content: `# Postmortem INC-0942: checkout outage after pool resize

## Summary
For 47 minutes checkout requests failed or took over 3 s. A configuration change reduced the checkout-api database pool from 50 to 8 connections to "save connections on orders-db".

## Timeline
- 14:02 config change deployed (poolSize 50 → 8)
- 14:06 p95 latency alert fired
- 14:31 pool exhaustion identified from \`could not acquire connection from pool\` errors
- 14:49 config reverted, recovery confirmed

## Root cause
Pool size below peak concurrency. Connections were not the bottleneck on orders-db.

## Lessons
- Time to identify was 25 minutes because nobody connected the config deploy with the latency alert. Correlate deploys with alerts automatically.
- Add a regression test that fails if poolSize < 40.` },
  { kind: "architecture", service: "gateway", title: "Architecture: checkout request path", content: `# Architecture: checkout request path

Requests enter through the API Gateway, which routes /checkout to checkout-api.
checkout-api reserves stock in inventory, authorises payment through payments (which calls stripe-proxy), then writes the order to orders-db (Postgres, primary + 2 replicas).

## Failure propagation
- Slow orders-db queries or an undersized checkout-api pool raise checkout latency first, then gateway 5xx (gateway timeout is 5 s).
- payments failures surface as checkout 502s but leave inventory and catalog healthy.
- catalog and search are independent of the checkout path.

## Ownership
checkout-api, payments and stripe-proxy: payments-squad. inventory: fulfilment. orders-db: data-platform. gateway: edge.` },
  { kind: "playbook", service: null, title: "Incident response & change rollback policy", content: `# Incident response & change rollback policy

## Severity
- SEV1: customer-facing outage of a tier-1 service (checkout, payments, gateway). Page the incident commander.
- SEV2: degraded tier-1 or outage of tier-2. SEV3: limited impact.

## Rollback first
If a change deployed in the last 2 hours correlates with the regression, roll it back before debugging forward. A rollback needs approval from one responder; the change author does not need to be present.

## Communication
Post a status update every 30 minutes for SEV1/SEV2. Record decisions in the incident timeline.` },
] as const;

export const PAST_INCIDENTS = [
  { title: "Checkout latency after database pool resize", sev: "sev1", services: ["checkout-api"], cause: "Config change lowered checkout-api poolSize below peak concurrency (pool exhaustion)", daysAgo: 21, ttr: 47, tti: 25 },
  { title: "Payments authorisation failures (stripe-proxy timeout)", sev: "sev2", services: ["payments"], cause: "payments client timeoutMs reduced to 1000 ms; stripe authorisations exceed it at p99", daysAgo: 12, ttr: 31, tti: 9 },
  { title: "Search relevance degraded after index rebuild", sev: "sev3", services: ["search"], cause: "Index rebuild used stale synonym dictionary", daysAgo: 9, ttr: 140, tti: 60 },
  { title: "Inventory pods OOMKilled", sev: "sev2", services: ["inventory"], cause: "Unbounded in-process cache after maxEntries removed", daysAgo: 6, ttr: 38, tti: 12 },
  { title: "Notification emails delayed", sev: "sev3", services: ["notifications"], cause: "Third-party email provider rate limiting", daysAgo: 3, ttr: 95, tti: 20 },
  { title: "Gateway 5xx burst during certificate rotation", sev: "sev2", services: ["gateway"], cause: "TLS certificate rotation restarted all gateway pods at once", daysAgo: 1, ttr: 18, tti: 6 },
] as const;
