import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { one, q } from "../db/pool.js";
import { requireRole } from "../lib/auth.js";
import { audit } from "../lib/audit.js";
import { publish } from "../lib/bus.js";
import { flag } from "../lib/flags.js";
import { recentMessages } from "../lib/realtime.js";
import { addEvent, setStatus, startInvestigation, openIncident, STATUSES } from "../services/incidents.js";
import { openDraftPr } from "../services/github.js";
import { onFixMerged } from "../sim/engine.js";

const idParam = z.object({ id: z.coerce.number().int().positive() });

export default async function incidentRoutes(app: FastifyInstance) {
  const viewer = { preHandler: requireRole("viewer") };
  const responder = { preHandler: requireRole("responder") };

  app.get("/api/incidents", viewer, async (req) => {
    const f = z.object({ status: z.string().optional(), severity: z.string().optional(), q: z.string().max(100).optional(), service: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    const where = ["1=1"], params: unknown[] = [];
    if (f.status === "open") where.push("status <> 'resolved'");
    else if (f.status) { params.push(f.status); where.push(`status = $${params.length}`); }
    if (f.severity) { params.push(f.severity); where.push(`severity = $${params.length}`); }
    if (f.service) { params.push(f.service); where.push(`$${params.length} = ANY(services)`); }
    if (f.q) { params.push(`%${f.q}%`); where.push(`(title ILIKE $${params.length} OR key ILIKE $${params.length} OR root_cause ILIKE $${params.length})`); }
    params.push(f.limit);
    return q(`SELECT i.*, (SELECT count(*)::int FROM fix_proposals fp WHERE fp.incident_id = i.id AND fp.status = 'pending_approval') AS pending_fixes
              FROM incidents i WHERE ${where.join(" AND ")} ORDER BY (status = 'resolved'), detected_at DESC LIMIT $${params.length}`, params);
  });

  app.get("/api/incidents/:id", viewer, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const incident = await one("SELECT i.*, u.name AS commander_name FROM incidents i LEFT JOIN users u ON u.id = i.commander WHERE i.id = $1", [id]);
    if (!incident) return reply.code(404).send({ error: "not_found" });
    const [events, investigations, hypotheses, fixes] = await Promise.all([
      q("SELECT * FROM incident_events WHERE incident_id = $1 ORDER BY ts", [id]),
      q("SELECT * FROM investigations WHERE incident_id = $1 ORDER BY id DESC", [id]),
      q(`SELECT h.*, d.sha AS deploy_sha, d.service AS deploy_service, d.message AS deploy_message FROM hypotheses h LEFT JOIN deploys d ON d.id = h.suspect_deploy_id WHERE h.incident_id = $1 ORDER BY (h.status = 'rejected'), h.investigation_id DESC NULLS LAST, h.rank`, [id]),
      q(`SELECT f.*, u.name AS decided_by_name,
           COALESCE((SELECT json_agg(json_build_object('userId', a.user_id, 'name', au.name, 'at', a.created_at) ORDER BY a.created_at) FROM fix_approvals a JOIN users au ON au.id = a.user_id WHERE a.fix_id = f.id), '[]') AS approvals
         FROM fix_proposals f LEFT JOIN users u ON u.id = f.decided_by WHERE f.incident_id = $1 ORDER BY f.id DESC`, [id]),
    ]);
    const steps = investigations[0] ? await q("SELECT * FROM investigation_steps WHERE investigation_id = $1 ORDER BY seq", [investigations[0].id]) : [];
    return { incident, events, investigations, steps, hypotheses, fixes };
  });

  /** Metrics + deploy markers around the incident window for the war room chart */
  app.get("/api/incidents/:id/signals", viewer, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const inc = await one("SELECT * FROM incidents WHERE id = $1", [id]);
    if (!inc) return reply.code(404).send({ error: "not_found" });
    const from = new Date(new Date(inc.started_at).getTime() - 30 * 60_000);
    const to = inc.resolved_at ? new Date(new Date(inc.resolved_at).getTime() + 15 * 60_000) : new Date();
    const metrics = await q(`SELECT service, name, date_trunc('minute', ts) AS ts, avg(value) AS value FROM metric_points
                             WHERE service = ANY($1) AND name IN ('error_rate','latency_p95_ms','rps','saturation') AND ts BETWEEN $2 AND $3
                             GROUP BY 1,2,3 ORDER BY 3`, [inc.services, from, to]);
    const deploys = await q("SELECT id, service, sha, message, author, kind, deployed_at FROM deploys WHERE deployed_at BETWEEN $1 AND $2 ORDER BY deployed_at", [from, to]);
    const errors = await q(`SELECT fingerprint, service, count(*)::int AS n, min(ts) AS first_seen, (array_agg(message ORDER BY ts DESC))[1] AS sample
                            FROM log_events WHERE service = ANY($1) AND level IN ('error','fatal') AND ts BETWEEN $2 AND $3 GROUP BY 1,2 ORDER BY n DESC LIMIT 8`, [inc.services, from, to]);
    return { from, to, metrics, deploys, errors };
  });

  app.get("/api/investigations/:id/steps", viewer, async (req) => q("SELECT * FROM investigation_steps WHERE investigation_id = $1 ORDER BY seq", [idParam.parse(req.params).id]));

  app.post("/api/incidents", responder, async (req, reply) => {
    const b = z.object({ title: z.string().min(5).max(200), severity: z.enum(["sev1", "sev2", "sev3", "sev4"]), services: z.array(z.string()).min(1).max(10), summary: z.string().max(2000).default("") }).parse(req.body);
    const { incident } = await openIncident({ ...b, startedAt: new Date(), source: "manual", dedupeKey: `manual:${Date.now()}` });
    await audit(req.user!.email, "incident.created", `incident:${incident.id}`, b, req.ip);
    return reply.code(201).send(incident);
  });

  app.patch("/api/incidents/:id", responder, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ status: z.enum(STATUSES).optional(), severity: z.enum(["sev1", "sev2", "sev3", "sev4"]).optional(), commander: z.number().int().nullable().optional(), note: z.string().max(2000).optional() }).parse(req.body);
    const inc = await one("SELECT * FROM incidents WHERE id = $1", [id]);
    if (!inc) return reply.code(404).send({ error: "not_found" });
    if (b.severity && b.severity !== inc.severity) { await q("UPDATE incidents SET severity = $2 WHERE id = $1", [id, b.severity]); await addEvent(id, "status", `Severity ${inc.severity} → ${b.severity}`, "", req.user!.name); }
    if (b.commander !== undefined) { await q("UPDATE incidents SET commander = $2 WHERE id = $1", [id, b.commander]); await addEvent(id, "status", b.commander ? "Incident commander assigned" : "Incident commander cleared", "", req.user!.name); }
    if (b.status && b.status !== inc.status) await setStatus(id, b.status, req.user!.name, b.note ?? "");
    await audit(req.user!.email, "incident.updated", `incident:${id}`, b, req.ip);
    await publish({ type: "incident.updated", incidentId: id });
    return one("SELECT * FROM incidents WHERE id = $1", [id]);
  });

  app.post("/api/incidents/:id/notes", responder, async (req) => {
    const { id } = idParam.parse(req.params);
    const { body } = z.object({ body: z.string().min(1).max(4000) }).parse(req.body);
    return addEvent(id, "note", "Note", body, req.user!.name);
  });

  app.post("/api/incidents/:id/investigate", responder, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const running = await one("SELECT 1 FROM investigations WHERE incident_id = $1 AND status IN ('queued','running')", [id]);
    if (running) return reply.code(409).send({ error: "conflict", message: "An investigation is already running" });
    await startInvestigation(id, `manual by ${req.user!.name}`);
    await audit(req.user!.email, "investigation.requested", `incident:${id}`, {}, req.ip);
    return reply.code(202).send({ queued: true });
  });

  app.post("/api/hypotheses/:id/:decision", responder, async (req, reply) => {
    const { id, decision } = z.object({ id: z.coerce.number().int(), decision: z.enum(["confirm", "reject"]) }).parse(req.params);
    const h = await one("UPDATE hypotheses SET status = $2 WHERE id = $1 RETURNING *", [id, decision === "confirm" ? "confirmed" : "rejected"]);
    if (!h) return reply.code(404).send({ error: "not_found" });
    if (decision === "confirm") await q("UPDATE incidents SET root_cause = $2, confidence = $3 WHERE id = $1", [h.incident_id, h.title, h.confidence]);
    await addEvent(h.incident_id, "hypothesis", `Hypothesis ${decision === "confirm" ? "confirmed" : "rejected"}: ${h.title}`, "", req.user!.name, { hypothesisId: id });
    await audit(req.user!.email, `hypothesis.${decision}`, `hypothesis:${id}`, {}, req.ip);
    await publish({ type: "hypotheses.updated", incidentId: h.incident_id });
    return h;
  });

  app.get("/api/incidents/:id/messages", viewer, async (req) => recentMessages(idParam.parse(req.params).id));

  /** Human-in-the-loop gate: only an approval by a responder opens a (draft) PR. */
  app.post("/api/fixes/:id/:decision", responder, async (req, reply) => {
    const { id, decision } = z.object({ id: z.coerce.number().int(), decision: z.enum(["approve", "reject"]) }).parse(req.params);
    const { note } = z.object({ note: z.string().max(1000).optional() }).parse(req.body ?? {});
    // two-person rule: collect distinct approvals first; the second one falls through to the normal gate
    if (decision === "approve" && flag("two_person_approval")) {
      const pending = await one("SELECT incident_id FROM fix_proposals WHERE id = $1 AND status = 'pending_approval'", [id]);
      if (!pending) return reply.code(409).send({ error: "conflict", message: "Fix is not pending approval (already decided or failed verification)" });
      await q("INSERT INTO fix_approvals (fix_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [id, req.user!.id]);
      const { n } = (await one<{ n: number }>("SELECT count(*)::int AS n FROM fix_approvals WHERE fix_id = $1", [id]))!;
      if (n < 2) {
        await audit(req.user!.email, "fix.approve_first", `fix:${id}`, { note }, req.ip);
        await addEvent(pending.incident_id, "fix", `First approval by ${req.user!.name} (1 of 2)`, "Two-person approval is on: a different responder must also approve.", req.user!.name, { fixId: id });
        await publish({ type: "fix.approval", incidentId: pending.incident_id, fixId: id, approvals: n, required: 2, by: req.user!.name });
        await publish({ type: "fix.updated", incidentId: pending.incident_id });
        return reply.code(202).send({ status: "awaiting_second_approval", approvals: n, required: 2 });
      }
    }
    // optimistic lock: only a pending fix can be decided, and only once
    const fix = await one(`UPDATE fix_proposals SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1 AND status = 'pending_approval' RETURNING *`,
      [id, decision === "approve" ? "approved" : "rejected", req.user!.id, note ?? null]);
    if (!fix) return reply.code(409).send({ error: "conflict", message: "Fix is not pending approval (already decided or failed verification)" });
    await audit(req.user!.email, `fix.${decision}`, `fix:${id}`, { note }, req.ip);
    if (decision === "reject") {
      await addEvent(fix.incident_id, "fix", `Fix rejected by ${req.user!.name}`, note ?? "", req.user!.name, { fixId: id });
      await publish({ type: "fix.updated", incidentId: fix.incident_id });
      return fix;
    }
    const [svc, inc] = await Promise.all([one("SELECT repo FROM services WHERE name = $1", [fix.service]), one("SELECT key, title FROM incidents WHERE id = $1", [fix.incident_id])]);
    try {
      const pr = await openDraftPr({
        repo: svc?.repo ?? null, service: fix.service, branch: `rootline/${inc.key.toLowerCase()}-fix-${id}`, title: `[${inc.key}] ${fix.title}`,
        body: `## ${inc.key}: ${inc.title}\n\n${fix.description}\n\n### Verification\n${fix.verification.checks.map((c: { status: string; name: string; detail: string }) => `- ${c.status === "pass" ? "✅" : "❌"} **${c.name}**: ${c.detail}`).join("\n")}\n\n_Approved by ${req.user!.name} in Rootline. Drafted by the Rootline agent; review before merging._`,
        verification: fix.verification, testPatch: fix.test_patch,
      });
      const updated = await one("UPDATE fix_proposals SET status = 'pr_opened', pr_url = $2, pr_number = $3, pr_mode = $4 WHERE id = $1 RETURNING *", [id, pr.url, pr.number, pr.mode]);
      await addEvent(fix.incident_id, "pr", `Draft PR opened${pr.mode === "simulated" ? " (simulated)" : ""}`, pr.url, req.user!.name, { fixId: id, url: pr.url });
      await setStatus(fix.incident_id, "mitigating", req.user!.name, `Fix ${fix.title} approved`);
      if (pr.mode === "simulated") onFixMerged(fix.incident_id, fix.service, fix.verification.files ?? []);
      await publish({ type: "fix.updated", incidentId: fix.incident_id });
      return updated;
    } catch (e) {
      await q("UPDATE fix_proposals SET status = 'failed', decision_note = $2 WHERE id = $1", [id, `PR creation failed: ${(e as Error).message}`]);
      await addEvent(fix.incident_id, "pr", "PR creation failed", (e as Error).message, "rootline");
      await publish({ type: "fix.updated", incidentId: fix.incident_id });
      return reply.code(502).send({ error: "github_error", message: (e as Error).message });
    }
  });
}
