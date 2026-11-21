# Architecture

## Data flow
1. **Ingest.** Producers (Fluent Bit, OpenTelemetry collectors, CI, Alertmanager, GitHub) POST to `/api/ingest/*` or `/api/webhooks/github`. Logs are fingerprinted on write (`lib/text.ts`), and metrics are upserted by `(service, name, ts)`.
2. **Detect.** For each incoming metric that has a rule, `services/anomaly.ts` scores the last points against a trailing median/MAD baseline. A sustained breach either opens an incident (unique partial index on `dedupe_key` for open incidents) or joins a correlated one.
3. **Queue.** `lib/queue.ts` enqueues `investigate` jobs with a dedupe key. Backends are BullMQ (Redis) or a Postgres table polled with `FOR UPDATE SKIP LOCKED`, exponential backoff, and recovery of stuck jobs. Workers can run in the API process or separately (`npm run worker`, `WORKER=off` on API pods).
4. **Investigate.** `agent/run.ts` creates an investigation and streams every step:
   - With `ANTHROPIC_API_KEY`: a Claude Messages API tool-use loop (`agent/claude.ts`). Parallel tool results go back in one message, refusals and `pause_turn` are handled, and every tool input is validated with zod.
   - Otherwise, or on any LLM failure: the deterministic `agent/heuristic.ts`, which uses the same tools and the same persistence.
5. **Ground.** `search_runbooks` runs hybrid retrieval (`services/knowledge.ts`). `submit_hypothesis` keeps only citations whose chunk was retrieved in the run and whose quote is verbatim.
6. **Fix.** `propose_fix` patches are verified by `services/patches.ts` against `repo_files` (synced from GitHub or seeded) before anyone sees them.
7. **Decide.** A responder approves; the decision uses an optimistic lock on `status = 'pending_approval'`. `services/github.ts` creates a branch, commits the files and opens a **draft** PR. Everything is written to `audit_log`.
8. **Realtime.** `lib/bus.ts` publishes through `pg_notify`, so API and worker processes share events. `/api/stream` serves SSE, authenticated with 2-minute stream tickets (EventSource can't send headers).

## Why these choices
- **Postgres for everything by default.** Incident state, signals, vectors, the queue and pub/sub in one dependency makes it easy to run and keeps it transactional. Redis/BullMQ and pgvector are drop-in upgrades.
- **Two agent engines.** Responders always get an analysis. The heuristic is also a baseline to evaluate the LLM agent against.
- **Verification before approval.** An unverified patch never reaches a human, so the approval gate isn't spent on patches that don't apply.

## Security
- Sessions are httpOnly JWT cookies with roles viewer/responder/admin. Stream tickets have a separate purpose claim.
- Ingest keys are SHA-256 hashed and revocable. Webhook signatures are compared in constant time.
- Rate limits apply globally, to login and to ingestion. Logs redact authorization headers and cookies.
- Agent tool output is treated as untrusted data. The model can only write through `submit_hypothesis` / `propose_fix`, and both are validated and gated.
