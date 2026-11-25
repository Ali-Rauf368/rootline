import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { one, q, tx } from "../db/pool.js";
import { audit } from "../lib/audit.js";
import { requireIngestKey, requireRole } from "../lib/auth.js";
import { publish } from "../lib/bus.js";
import { flag } from "../lib/flags.js";
import { costAi } from "../finops/analyze.js";
import { enqueueBatch } from "../finops/jobs.js";

const Id = z.object({ id: z.coerce.number().int().positive().max(2147483647) });

export default async function costRoutes(app: FastifyInstance) {
  const viewer = { preHandler: requireRole("viewer") }, responder = { preHandler: requireRole("responder") };

  /** NiFi calls this after PutDatabaseRecord has loaded a batch into cost_staging. */
  app.post("/api/webhooks/nifi-batch-complete", { preHandler: requireIngestKey }, async (req, reply) => {
    const { batchId } = z.object({ batchId: z.string().min(1).max(200) }).parse(req.body);
    const queued = await enqueueBatch(batchId);
    return reply.code(queued ? 202 : 200).send(queued ? { queued: true } : { duplicate: true });
  });

  app.get("/api/costs/summary", viewer, async () => {
    const [spend, totals, trend, services, batch] = await Promise.all([
      one("SELECT coalesce(sum(usage_cost), 0) AS v, max(billing_date)::text AS as_of FROM cost_records WHERE billing_date > (SELECT max(billing_date) FROM cost_records) - 30"),
      // spikes are reported separately: adding them to recurring waste would double count
      one(`SELECT coalesce(sum(max_savings) FILTER (WHERE status = 'open' AND rule <> 'spike'), 0) AS waste,
                  coalesce(sum(estimated_monthly_savings) FILTER (WHERE status = 'pr_opened' AND rule <> 'spike'), 0) AS approved,
                  count(*) FILTER (WHERE status = 'open')::int AS open, count(*) FILTER (WHERE status = 'open' AND rule = 'spike')::int AS spikes FROM cost_findings`),
      q("SELECT billing_date::text AS date, sum(usage_cost) AS cost FROM cost_records WHERE billing_date > (SELECT max(billing_date) FROM cost_records) - 30 GROUP BY 1 ORDER BY 1"),
      q("SELECT service, sum(usage_cost) AS cost FROM cost_records WHERE billing_date > (SELECT max(billing_date) FROM cost_records) - 30 GROUP BY 1 ORDER BY 2 DESC LIMIT 8"),
      one("SELECT id, source, status, accepted, rejected, error, created_at FROM cost_batches ORDER BY created_at DESC LIMIT 1"),
    ]);
    return { spend30d: spend!.v, asOf: spend!.as_of, wasteMonthly: totals!.waste, approvedMonthly: totals!.approved, openFindings: totals!.open, spikes: totals!.spikes, trend, services, lastBatch: batch, analysis: costAi() };
  });

  app.get("/api/costs/findings", viewer, async (req) => {
    const f = z.object({ status: z.enum(["open", "pr_opened", "intentional", "resolved"]).default("open"), rule: z.enum(["spike", "idle", "overprovisioned", "unattached"]).optional(), search: z.string().max(100).optional() }).parse(req.query);
    return q(`SELECT * FROM cost_findings WHERE status = $1 AND ($2::text IS NULL OR rule = $2)
              AND ($3::text IS NULL OR strpos(lower(resource_id || ' ' || service || ' ' || team || ' ' || env), lower($3)) > 0) ORDER BY max_savings DESC LIMIT 200`, [f.status, f.rule ?? null, f.search || null]);
  });

  /** Opens a simulated PR record. Nothing is executed and no cloud or GitHub API is called. */
  app.post("/api/costs/findings/:id/approve", responder, async (req, reply) => {
    const { id } = Id.parse(req.params);
    const result = await tx(async (c) => {
      const f = (await c.query("SELECT * FROM cost_findings WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!f) return { code: 404, body: { error: "not_found", message: "Finding not found" } };
      if (f.status !== "open" || !f.analysis_source) return { code: 409, body: { error: "conflict", message: f.status === "open" ? "Analysis hasn't finished" : "Finding has already been decided" } };
      const approvals = [...new Set([...f.approvals, req.user!.id])];
      if (flag("two_person_approval") && approvals.length < 2) {
        await c.query("UPDATE cost_findings SET approvals = $2 WHERE id = $1", [id, approvals]);
        return { code: 202, body: { status: "awaiting_second_approval", approvals: approvals.length, required: 2 } };
      }
      const { rows: [row] } = await c.query(`UPDATE cost_findings SET status = 'pr_opened', approvals = $2, pr_url = $3, decided_by = $4, decided_at = now() WHERE id = $1 RETURNING *`,
        [id, approvals, `https://github.com/example/infrastructure/pull/new/opsmeridian/cost-${id}`, req.user!.id]);
      return { code: 200, body: row };
    });
    if (result.code < 300) { await audit(req.user!.email, result.code === 202 ? "cost.approve_first" : "cost.approve", `cost:${id}`, { simulated: true }, req.ip); await publish({ type: "cost.updated" }); }
    return reply.code(result.code).send(result.body);
  });

  /** Records an exclusion so detection ignores the resource on future runs. */
  app.post("/api/costs/findings/:id/intentional", responder, async (req, reply) => {
    const { id } = Id.parse(req.params);
    const { reason } = z.object({ reason: z.string().trim().max(500).default("") }).parse(req.body ?? {});
    const row = await tx(async (c) => {
      const f = (await c.query("UPDATE cost_findings SET status = 'intentional', decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $1 AND status = 'open' RETURNING *", [id, req.user!.id, reason])).rows[0];
      if (f) await c.query("INSERT INTO cost_exclusions (resource_id, reason, created_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [f.resource_id, reason, req.user!.id]);
      return f;
    });
    if (!row) return reply.code(409).send({ error: "conflict", message: "Finding is not open" });
    await audit(req.user!.email, "cost.intentional", `cost:${id}`, { resource: row.resource_id, reason }, req.ip);
    await publish({ type: "cost.updated" });
    return row;
  });
}
