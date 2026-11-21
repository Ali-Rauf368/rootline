import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { one, q, hasPgvector } from "../db/pool.js";
import { requireRole, verify, createApiKey } from "../lib/auth.js";
import { audit } from "../lib/audit.js";
import { subscribe } from "../lib/bus.js";
import { env } from "../lib/env.js";
import { queueStats, queueBackend } from "../lib/queue.js";
import { searchKnowledge, upsertDocument } from "../services/knowledge.js";
import { agentMode } from "../agent/run.js";
import { SCENARIOS, runScenario } from "../sim/engine.js";
import { FLAG_DEFS, allFlags, setFlags, type FlagName } from "../lib/flags.js";
import { realtimeStats } from "../lib/realtime.js";

export default async function platformRoutes(app: FastifyInstance) {
  const viewer = { preHandler: requireRole("viewer") };
  const responder = { preHandler: requireRole("responder") };
  const admin = { preHandler: requireRole("admin") };

  app.get("/healthz", async () => ({ ok: true }));
  app.get("/readyz", async (_req, reply) => {
    try { await one("SELECT 1"); return { ok: true, db: "up", queue: queueBackend(), agent: agentMode() }; }
    catch { return reply.code(503).send({ ok: false, db: "down" }); }
  });

  /** Overview dashboard: DORA-style incident KPIs, service health, live incidents, recent changes. */
  app.get("/api/overview", viewer, async () => {
    const [kpi] = await q(`
      SELECT count(*) FILTER (WHERE status <> 'resolved')::int AS open_incidents,
             count(*) FILTER (WHERE status <> 'resolved' AND severity IN ('sev1','sev2'))::int AS open_major,
             count(*) FILTER (WHERE detected_at > now() - interval '30 days')::int AS incidents_30d,
             round(avg(extract(epoch FROM (detected_at - started_at))) FILTER (WHERE detected_at > now() - interval '30 days') / 60, 1)::float AS mttd_min,
             round(avg(extract(epoch FROM (resolved_at - started_at))) FILTER (WHERE resolved_at > now() - interval '30 days') / 60, 1)::float AS mttr_min,
             round(avg(extract(epoch FROM (identified_at - started_at))) FILTER (WHERE identified_at > now() - interval '30 days') / 60, 1)::float AS mtti_min
      FROM incidents`);
    const [agent] = await q(`
      SELECT count(*) FILTER (WHERE status = 'confirmed' AND rank = 1)::int AS top_confirmed,
             count(*) FILTER (WHERE status IN ('confirmed','rejected') AND rank = 1)::int AS top_decided,
             (SELECT count(*)::int FROM fix_proposals WHERE status IN ('approved','pr_opened')) AS fixes_approved,
             (SELECT count(*)::int FROM fix_proposals WHERE status <> 'failed') AS fixes_total,
             (SELECT count(*)::int FROM investigations WHERE status = 'completed') AS investigations
      FROM hypotheses`);
    const [changes] = await q(`SELECT count(*)::int AS deploys_7d,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM hypotheses h WHERE h.suspect_deploy_id = d.id AND h.status <> 'rejected' AND h.rank = 1))::int AS failed_7d
      FROM deploys d WHERE deployed_at > now() - interval '7 days'`);
    const services = await q(`
      SELECT s.name, s.display_name, s.tier, s.owner_team, s.slo_availability, s.slo_latency_ms, s.depends_on,
        (SELECT json_agg(json_build_object('t', t, 'e', e, 'l', l) ORDER BY t) FROM (
            SELECT date_trunc('minute', ts) - (extract(minute FROM ts)::int % 5) * interval '1 minute' AS t,
                   avg(value) FILTER (WHERE name = 'error_rate') AS e, avg(value) FILTER (WHERE name = 'latency_p95_ms') AS l
            FROM metric_points WHERE service = s.name AND ts > now() - interval '2 hours' AND name IN ('error_rate','latency_p95_ms') GROUP BY 1) x) AS spark,
        (SELECT avg(value) FROM metric_points WHERE service = s.name AND name = 'error_rate' AND ts > now() - interval '2 minutes') AS error_rate,
        (SELECT avg(value) FROM metric_points WHERE service = s.name AND name = 'latency_p95_ms' AND ts > now() - interval '2 minutes') AS latency_p95_ms,
        (SELECT avg(value) FROM metric_points WHERE service = s.name AND name = 'rps' AND ts > now() - interval '2 minutes') AS rps,
        (SELECT 1 - avg(value) FROM metric_points WHERE service = s.name AND name = 'error_rate' AND ts > now() - interval '30 days') AS availability_30d,
        (SELECT count(*)::int FROM incidents i WHERE s.name = ANY(i.services) AND i.status <> 'resolved') AS open_incidents
      FROM services s ORDER BY s.tier, s.name`);
    const incidents = await q("SELECT id, key, title, severity, status, services, started_at, detected_at, confidence, root_cause FROM incidents WHERE status <> 'resolved' ORDER BY severity, detected_at DESC LIMIT 10");
    const recentIncidents = await q("SELECT id, key, title, severity, status, services, started_at, resolved_at FROM incidents ORDER BY detected_at DESC LIMIT 8");
    const deploys = await q("SELECT id, service, sha, author, message, kind, deployed_at FROM deploys ORDER BY deployed_at DESC LIMIT 8");
    const errorSeries = await q(`SELECT service, date_trunc('minute', ts) AS ts, avg(value) AS value FROM metric_points WHERE name = 'error_rate' AND ts > now() - interval '3 hours' GROUP BY 1,2 ORDER BY 2`);
    const weekly = await q(`SELECT date_trunc('day', d)::date AS day, (SELECT count(*)::int FROM incidents WHERE detected_at::date = d::date) AS incidents,
                                   (SELECT count(*)::int FROM deploys WHERE deployed_at::date = d::date) AS deploys
                            FROM generate_series(now() - interval '13 days', now(), interval '1 day') d ORDER BY 1`);
    return {
      kpi: { ...kpi, ...changes, change_failure_rate: changes.deploys_7d ? Math.round((changes.failed_7d / changes.deploys_7d) * 1000) / 10 : 0,
        agent_precision: agent.top_decided ? Math.round((agent.top_confirmed / agent.top_decided) * 100) : null, fix_approval_rate: agent.fixes_total ? Math.round((agent.fixes_approved / agent.fixes_total) * 100) : null, investigations: agent.investigations },
      services, incidents, recentIncidents, deploys, errorSeries, weekly,
    };
  });

  app.get("/api/services", viewer, async () => q("SELECT * FROM services ORDER BY tier, name"));
  app.get("/api/services/:name", viewer, async (req, reply) => {
    const { name } = z.object({ name: z.string() }).parse(req.params);
    const service = await one("SELECT * FROM services WHERE name = $1", [name]);
    if (!service) return reply.code(404).send({ error: "not_found" });
    const minutes = z.coerce.number().int().min(15).max(1440).default(180).parse((req.query as Record<string, unknown>).minutes);
    const bucket = minutes > 360 ? "10 minutes" : "1 minute";
    const [metrics, deploys, incidents, topErrors, dependents] = await Promise.all([
      q(`SELECT name, date_bin($3::interval, ts, 'epoch') AS ts, avg(value) AS value FROM metric_points WHERE service = $1 AND ts > now() - ($2 || ' minutes')::interval GROUP BY 1,2 ORDER BY 2`, [name, String(minutes), bucket]),
      q("SELECT id, sha, author, message, kind, files, deployed_at FROM deploys WHERE service = $1 ORDER BY deployed_at DESC LIMIT 15", [name]),
      q("SELECT id, key, title, severity, status, detected_at, resolved_at FROM incidents WHERE $1 = ANY(services) ORDER BY detected_at DESC LIMIT 10", [name]),
      q(`SELECT fingerprint, level, count(*)::int AS n, max(ts) AS last_seen, (array_agg(message ORDER BY ts DESC))[1] AS sample FROM log_events
         WHERE service = $1 AND level IN ('warn','error','fatal') AND ts > now() - interval '1 hour' GROUP BY 1,2 ORDER BY n DESC LIMIT 10`, [name]),
      q("SELECT name FROM services WHERE $1 = ANY(depends_on)", [name]),
    ]);
    return { service, metrics, deploys, incidents, topErrors, dependents: dependents.map((d) => d.name) };
  });
  app.put("/api/services/:name", admin, async (req) => {
    const { name } = z.object({ name: z.string() }).parse(req.params);
    const b = z.object({ display_name: z.string().max(80).optional(), tier: z.number().int().min(1).max(3).optional(), owner_team: z.string().max(80).optional(), repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).nullable().optional(), depends_on: z.array(z.string()).optional(), slo_availability: z.number().min(90).max(100).optional(), slo_latency_ms: z.number().int().min(10).optional() }).parse(req.body);
    const sets = Object.keys(b).map((k, i) => `${k} = $${i + 2}`);
    if (!sets.length) return one("SELECT * FROM services WHERE name = $1", [name]);
    await audit(req.user!.email, "service.updated", `service:${name}`, b, req.ip);
    return one(`UPDATE services SET ${sets.join(", ")} WHERE name = $1 RETURNING *`, [name, ...Object.values(b)]);
  });

  app.get("/api/logs", viewer, async (req) => {
    const f = z.object({ service: z.string().optional(), level: z.enum(["debug", "info", "warn", "error", "fatal"]).optional(), q: z.string().max(200).optional(), before: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(500).default(150) }).parse(req.query);
    const where = ["ts > now() - interval '24 hours'"], p: unknown[] = [];
    if (f.service) { p.push(f.service); where.push(`service = $${p.length}`); }
    // warn/error mean "at least this severe"; debug/info/fatal are exact
    if (f.level === "warn") where.push("level IN ('warn','error','fatal')");
    else if (f.level === "error") where.push("level IN ('error','fatal')");
    else if (f.level) { p.push(f.level); where.push(`level = $${p.length}`); }
    if (f.q) { p.push(f.q); where.push(`tsv @@ plainto_tsquery('simple', $${p.length})`); }
    if (f.before) { p.push(f.before); where.push(`id < $${p.length}`); }
    p.push(f.limit);
    return q(`SELECT id, service, ts, level, message, fingerprint, trace_id, attrs FROM log_events WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT $${p.length}`, p);
  });

  app.get("/api/deploys", viewer, async (req) => {
    const f = z.object({ service: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    return q(`SELECT d.id, d.service, d.sha, d.author, d.message, d.kind, d.files, d.deployed_at, d.source,
                (SELECT json_agg(json_build_object('key', i.key, 'id', i.id, 'confidence', h.confidence)) FROM hypotheses h JOIN incidents i ON i.id = h.incident_id WHERE h.suspect_deploy_id = d.id AND h.status <> 'rejected' AND h.rank = 1) AS implicated
              FROM deploys d WHERE ($1::text IS NULL OR service = $1) ORDER BY deployed_at DESC LIMIT $2`, [f.service ?? null, f.limit]);
  });
  app.get("/api/deploys/:id", viewer, async (req, reply) => (await one("SELECT * FROM deploys WHERE id = $1", [z.coerce.number().parse((req.params as { id: string }).id)])) ?? reply.code(404).send({ error: "not_found" }));

  // Knowledge base (runbooks, postmortems, architecture)
  app.get("/api/knowledge", viewer, async () => q("SELECT d.id, d.kind, d.title, d.service, d.source_url, d.updated_at, length(d.content) AS size, (SELECT count(*)::int FROM doc_chunks c WHERE c.document_id = d.id) AS chunks FROM documents d ORDER BY d.kind, d.title"));
  app.get("/api/knowledge/search", viewer, async (req) => {
    const f = z.object({ q: z.string().min(2).max(300), service: z.string().optional() }).parse(req.query);
    return { mode: (await hasPgvector()) ? "fts+pgvector" : "fts+vector(sql)", hits: await searchKnowledge(f.q, { k: 8, service: f.service }) };
  });
  app.get("/api/knowledge/:id", viewer, async (req, reply) => {
    const id = z.coerce.number().parse((req.params as { id: string }).id);
    const doc = await one("SELECT * FROM documents WHERE id = $1", [id]);
    if (!doc) return reply.code(404).send({ error: "not_found" });
    return { ...doc, chunks: await q("SELECT id, idx, heading, content FROM doc_chunks WHERE document_id = $1 ORDER BY idx", [id]) };
  });
  const DocIn = z.object({ kind: z.enum(["runbook", "postmortem", "architecture", "playbook"]), title: z.string().min(3).max(200), service: z.string().max(100).nullable().optional(), content: z.string().min(20).max(200_000), sourceUrl: z.string().url().nullable().optional() });
  app.post("/api/knowledge", responder, async (req, reply) => {
    const doc = await upsertDocument(DocIn.parse(req.body));
    await audit(req.user!.email, "knowledge.created", `document:${doc!.id}`, { title: doc!.title }, req.ip);
    return reply.code(201).send(doc);
  });
  app.put("/api/knowledge/:id", responder, async (req, reply) => {
    const id = z.coerce.number().parse((req.params as { id: string }).id);
    const doc = await upsertDocument(DocIn.parse(req.body), id);
    if (!doc) return reply.code(404).send({ error: "not_found" });
    await audit(req.user!.email, "knowledge.updated", `document:${id}`, {}, req.ip);
    return doc;
  });
  app.delete("/api/knowledge/:id", admin, async (req) => {
    const id = z.coerce.number().parse((req.params as { id: string }).id);
    await q("DELETE FROM documents WHERE id = $1", [id]);
    await audit(req.user!.email, "knowledge.deleted", `document:${id}`, {}, req.ip);
    return { ok: true };
  });

  app.get("/api/integrations", viewer, async () => ({
    agent: { mode: agentMode(), model: agentMode() === "claude" ? env.ANTHROPIC_MODEL : null, maxSteps: env.AGENT_MAX_STEPS },
    queue: await queueStats(),
    vector: (await hasPgvector()) ? "pgvector" : "postgres real[] (in-SQL ranking)",
    github: { prs: env.GITHUB_TOKEN ? "enabled" : "simulated", webhookSecret: Boolean(env.GITHUB_WEBHOOK_SECRET) },
    simulator: env.SIMULATOR,
    endpoints: ["/api/ingest/logs", "/api/ingest/metrics", "/api/ingest/deploys", "/api/ingest/alerts", "/api/webhooks/github"],
    keys: await q("SELECT id, name, preview, scopes, last_used_at, revoked_at, created_at FROM api_keys ORDER BY id DESC"),
    stats: (await q(`SELECT (SELECT count(*)::int FROM log_events WHERE ts > now() - interval '1 hour') AS logs_1h,
                            (SELECT count(*)::int FROM metric_points WHERE ts > now() - interval '1 hour') AS metrics_1h,
                            (SELECT count(*)::int FROM deploys WHERE deployed_at > now() - interval '24 hours') AS deploys_24h,
                            (SELECT count(*)::int FROM doc_chunks) AS chunks`))[0],
  }));
  app.post("/api/keys", admin, async (req, reply) => {
    const { name } = z.object({ name: z.string().min(2).max(60) }).parse(req.body);
    const key = await createApiKey(name, req.user!.id);
    await audit(req.user!.email, "apikey.created", `key:${key.id}`, { name }, req.ip);
    return reply.code(201).send(key);
  });
  app.delete("/api/keys/:id", admin, async (req) => {
    const id = z.coerce.number().parse((req.params as { id: string }).id);
    await q("UPDATE api_keys SET revoked_at = now() WHERE id = $1", [id]);
    await audit(req.user!.email, "apikey.revoked", `key:${id}`, {}, req.ip);
    return { ok: true };
  });

  app.get("/api/audit", responder, async (req) => {
    const f = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), actor: z.string().optional() }).parse(req.query);
    return q("SELECT * FROM audit_log WHERE ($1::text IS NULL OR actor = $1) ORDER BY id DESC LIMIT $2", [f.actor ?? null, f.limit]);
  });
  /** Feature toggles: readable by everyone (the UI adapts), writable by admins, every flip audited. */
  app.get("/api/flags", viewer, async () => {
    const values = allFlags();
    return Object.entries(FLAG_DEFS).map(([key, d]) => ({ key, label: d.label, description: d.description, group: d.group, default: d.default, enabled: values[key as FlagName] }));
  });
  app.put("/api/flags", admin, async (req) => {
    const patch = z.record(z.enum(Object.keys(FLAG_DEFS) as [FlagName, ...FlagName[]]), z.boolean()).parse(req.body);
    const before = allFlags();
    const after = await setFlags(patch);
    const changed = Object.fromEntries(Object.entries(patch).filter(([k, v]) => before[k as FlagName] !== v));
    if (Object.keys(changed).length) await audit(req.user!.email, "flags.update", "flags", { changed }, req.ip);
    return after;
  });
  app.get("/api/realtime", viewer, async () => realtimeStats());

  app.get("/api/users", viewer, async () => q("SELECT id, name, email, role FROM users ORDER BY name"));

  // Failure simulator (demo / game days)
  app.get("/api/sim/scenarios", viewer, async () => SCENARIOS.map(({ id, name, description, service }) => ({ id, name, description, service })));
  app.post("/api/sim/scenarios/:id", responder, async (req, reply) => {
    if (env.SIMULATOR !== "on") return reply.code(403).send({ error: "forbidden", message: "Simulator disabled" });
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const r = await runScenario(id);
    await audit(req.user!.email, "sim.scenario", id, {}, req.ip);
    return reply.code(202).send(r);
  });

  /** Server-Sent Events: live incident, investigation and signal updates. */
  app.get("/api/stream", async (req, reply) => {
    const { ticket, incident } = z.object({ ticket: z.string(), incident: z.coerce.number().optional() }).parse(req.query);
    const user = await verify(ticket, "stream");
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no", "Access-Control-Allow-Origin": env.WEB_ORIGIN, "Access-Control-Allow-Credentials": "true" });
    res.write(`retry: 3000\n\n`);
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send("ready", { user: user.name });
    const unsub = subscribe((e) => {
      if (incident && "incidentId" in e && e.incidentId !== incident) return;
      if (incident && (e.type === "log" || e.type === "metrics.tick")) return;
      send(e.type, e);
    });
    const ping = setInterval(() => res.write(`: ping\n\n`), 15_000);
    req.raw.on("close", () => { clearInterval(ping); unsub(); });
  });
}
