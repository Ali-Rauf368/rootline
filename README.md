# OpsMeridian: incident root-cause and cloud cost intelligence

OpsMeridian ingests logs, metrics, deploys and alerts, detects incidents and investigates them with an AI agent.
The agent correlates spikes with recent changes, cites internal runbooks verbatim, and proposes **verified** code fixes.
A fix becomes a draft pull request only after a human approves it.

```
 webhooks / queues                 ┌──────────── worker (Postgres SKIP LOCKED queue or BullMQ on Redis) ─────────────┐
 logs · metrics · deploys ──► API ─┤ anomaly → incident → investigation agent ── tools ──► Postgres (signals, state)    │
 Alertmanager · GitHub        │    │  Claude tool-use loop  /  offline heuristic        └─► hybrid RAG: FTS + vectors  │
                              │    │  hypotheses (+ cited sources) → fix patch → verification → human approval → PR    │
                              │    └───────────────────────────────────────────────────────────────────────────────────┘
                              └─► SSE (via Postgres LISTEN/NOTIFY) ─► Next.js war room (live timeline, agent steps)
```

## Highlights

| Area | What it does |
|---|---|
| **Ingestion** | `POST /api/ingest/{logs,metrics,deploys,alerts}` with per-source API keys (hashed), batching, zod validation, `Idempotency-Key` replay protection. GitHub webhook with HMAC-SHA256 verification and delivery-id dedupe. Prometheus Alertmanager format. |
| **Detection** | Streaming robust z-score (median/MAD) per metric. Needs 2 consecutive breaches plus a minimum absolute change, so one spike or a statistically large but tiny change doesn't page. Error signatures are normalized into fingerprints. |
| **Correlation** | Anomalies on services that are directly connected in the dependency graph merge into one incident. The incident is renamed around the most likely origin, and correlated signals trigger a re-investigation. |
| **Agent** | Claude (`claude-opus-5-5`, adaptive thinking, server-side refusal fallbacks) runs a tool-use loop over 12 tools: metrics with change points, blast-radius changes, diffs, log-signature diffing, runbook search, similar incidents, topology, repo files, `submit_hypothesis`, `propose_fix`. Without an API key, or if Claude fails, a deterministic heuristic investigator runs the same playbook. |
| **Citations** | Hypotheses may only cite chunks retrieved in that run, and the quote must appear verbatim. Anything else is dropped and reported back to the agent. |
| **Retrieval** | Hybrid search: PostgreSQL full-text (`ts_rank_cd`) plus dense vectors (pgvector when installed, otherwise SQL over `real[]`), fused with Reciprocal Rank Fusion. Chunks are heading-aware. |
| **Fixes** | Reverts are rebuilt against the current repo snapshot. Verification checks: the patch applies without fuzz, files parse, config values fall within safe ranges, and a regression test is included. Failed fixes can't be approved. |
| **Human in the loop** | Approve/reject is limited to the responder role, and a fix can only be decided once. Approval opens a draft PR via the GitHub API (or a simulated one), moves the incident to *mitigating*, and is written to the audit log. |
| **Safety** | Rollbacks and OpsMeridian's own fix deploys are never treated as suspects. Tool output is untrusted data (prompt-injection guidance). Every decision is audited. |
| **War room** | Live SSE: lifecycle stepper, signal chart with onset/deploy/fix markers, ranked hypotheses with evidence and clickable citations, diff viewer, verification checklist, streaming agent steps, timeline and notes. |
| **Dashboards** | MTTD / MTTI / MTTR, change failure rate, agent precision and fix approval rate. Service health with SLO-aware status and sparklines, live dependency map, logs live tail, change history, knowledge base with a retrieval playground. Ctrl+K palette, dark/light themes, responsive layout. |
| **Simulator** | Live traffic for 9 services, plus 4 game-day scenarios: bad pool config, payments timeout, cache leak, upstream Stripe degradation (no deploy). |

## Real-time collaboration & feature toggles

- **Socket.IO gateway** (`apps/api/src/lib/realtime.ts`). It is attached to the Fastify server. Handshakes are authenticated with a 2-minute stream ticket that is fetched again on every reconnect. Events from any API or worker process reach the browser through Postgres `NOTIFY`. If WebSockets are blocked, Socket.IO falls back to long-polling. The SSE endpoint (`/api/stream`) remains for simple clients.
- **War rooms:**
  - live presence (who is viewing an incident)
  - typing indicators
  - persistent chat, which viewers can read but not post to
  - catch-up after a reconnect
- **Feature toggles** (Settings & toggles page, `PUT /api/flags`, admin only, audited). Every process caches them and the event bus refreshes them, so a flip takes effect without a redeploy.

  | Toggle | Effect |
  |---|---|
  | `auto_investigate` | Start the RCA agent automatically (manual runs are always allowed) |
  | `claude_agent` | Use Claude when a key is configured (off forces the heuristic investigator) |
  | `fix_generation` | Draft and verify patches |
  | `two_person_approval` | A fix needs two different responders before a draft PR opens |
  | `anomaly_detection` | Open incidents from metric anomalies |
  | `maintenance_mode` | Record anomalies and alerts but don't open incidents (shown as a banner) |
  | `war_room_chat`, `presence` | Collaboration features |

- **Personal preferences** (stored in the browser):
  - desktop notifications
  - sound alerts
  - auto-follow of the agent feed
  - compact density
  - reduced motion

## Cloud costs

```
billing CSV ─► Apache NiFi ─► cost_staging ─► POST /api/webhooks/nifi-batch-complete ─► pg-boss ─► validate + merge
             (normalise AWS/GCP)                                                          └► detect in SQL ─► Gemini or rules ─► human decision
```

- **Detection is SQL only** (`apps/api/src/finops/detect.ts`): daily service cost over 125% of its 7-day rolling average; CPU under 2% (idle) or 10% (over-provisioned) for 14 days; unattached volumes and IPs.
- **Analysis** (`analyze.ts`): findings are grouped by service and team, up to 15 per prompt. Output is Zod-validated and savings are capped at the SQL estimate. Without `GEMINI_API_KEY`, or if Gemini fails, built-in rules are used. With a key, resource IDs, tags and costs are sent to Google.
- **Decisions**: *Approve & create PR* records a **simulated** PR; nothing is executed. *Mark intentional* excludes the resource from future runs. Two-person approval applies.
- A billing file should contain complete days: re-importing a resource's day overwrites it.

`npm run dev` loads 30 days of demo costs, so NiFi isn't needed to try it. To run the pipeline with Docker:

```bash
mkdir -p infra/nifi/billing/inbox infra/nifi/billing/failed && chmod -R a+rwX infra/nifi/billing
docker compose --profile nifi up -d --build
node infra/nifi/setup-flow.mjs                                  # once NiFi answers on https://localhost:8443
cp infra/nifi/samples/*.csv infra/nifi/billing/inbox/           # picked up every 5 minutes, then removed
```
The default passwords and tokens are for local use only. Failed files are kept in `billing/failed`.

## Run locally

```bash
npm run dev     # PostgreSQL :55434 (project-local) · API + worker + simulator :4100 · web :3100
```
Open http://localhost:3100 and sign in as **oncall@opsmeridian.dev** / `opsmeridian-demo` (also `admin@` and `viewer@`).
Click **Simulate** to inject a failure and watch it be detected, investigated, cited and fixed.

Optional (`apps/api/.env`, see `.env.example`):
- `ANTHROPIC_API_KEY`: enables the Claude agent.
- `GEMINI_API_KEY`: enables AI cost analysis.
- `REDIS_URL`: switches the incident queue to BullMQ.
- `GITHUB_TOKEN` (plus `services.repo`): opens real draft PRs.
- `GITHUB_WEBHOOK_SECRET`: verifies GitHub webhooks.

Docker: `docker compose up -d --build` runs PostgreSQL + pgvector, Redis/BullMQ, the API, 2 workers and the web app.

## Tests
```bash
npm test                         # API: 46 Vitest tests against a real PostgreSQL (auth/RBAC, ingestion, webhook signatures,
                                 # detection, correlation, investigation, citation guard, patch verification, approval, queue, safety)
cd e2e && npx playwright test    # browser: game day end-to-end + viewer permissions (needs `npm run dev`)
npm run typecheck                # API + web
```

## Layout
```
apps/api   Fastify + TypeScript · src/{routes, services, agent, lib, db, sim} · test/
infra/nifi NiFi flow setup script and sample billing files
apps/web   Next.js 15 App Router + Tailwind + Recharts · src/{app, components, lib}
e2e        Playwright
docs       architecture.md
```
