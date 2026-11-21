import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { one, q } from "../db/pool.js";
import { requireIngestKey, safeEqual } from "../lib/auth.js";
import { env } from "../lib/env.js";
import { LogIn, MetricIn, DeployIn, AlertIn, ingestLogs, ingestMetrics, ingestDeploy, ingestAlerts } from "../services/ingest.js";

const many = <T extends z.ZodTypeAny>(s: T, max: number) => z.union([z.array(s).max(max), s.transform((x) => [x])]);

/** Idempotency: replays with the same Idempotency-Key are acknowledged without re-processing. */
async function seen(req: FastifyRequest, source: string) {
  const key = req.headers["idempotency-key"] as string | undefined;
  if (!key) return false;
  const row = await one("INSERT INTO webhook_deliveries (source, delivery_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING 1", [source, key.slice(0, 200)]);
  return !row;
}

export default async function ingestRoutes(app: FastifyInstance) {
  const opts = { preHandler: requireIngestKey, config: { rateLimit: { max: Number(process.env.INGEST_RATE_LIMIT ?? 1200), timeWindow: "1 minute" } } };

  app.post("/api/ingest/logs", { ...opts, bodyLimit: 5 * 1024 * 1024 }, async (req, reply) => {
    if (await seen(req, "logs")) return reply.code(200).send({ duplicate: true });
    const logs = many(LogIn, 2000).parse(req.body);
    return reply.code(202).send({ accepted: await ingestLogs(logs) });
  });
  app.post("/api/ingest/metrics", opts, async (req, reply) => {
    if (await seen(req, "metrics")) return reply.code(200).send({ duplicate: true });
    const r = await ingestMetrics(many(MetricIn, 5000).parse(req.body));
    return reply.code(202).send(r);
  });
  app.post("/api/ingest/deploys", { ...opts, bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => reply.code(201).send(await ingestDeploy(DeployIn.parse(req.body))));
  /** Prometheus Alertmanager webhook format (also accepts generic {alerts:[…]}) */
  app.post("/api/ingest/alerts", opts, async (req, reply) => {
    if (await seen(req, "alerts")) return reply.code(200).send({ duplicate: true });
    return reply.code(202).send({ results: await ingestAlerts(AlertIn.parse(req.body)) });
  });

  /** GitHub webhook: HMAC-SHA256 signature check, delivery-id dedupe; deployment_status → deploy, push → recorded changes. */
  app.post("/api/webhooks/github", { config: { rawBody: true }, bodyLimit: 5 * 1024 * 1024 }, async (req, reply) => {
    const raw = (req as FastifyRequest & { rawBody?: string }).rawBody ?? JSON.stringify(req.body);
    if (env.GITHUB_WEBHOOK_SECRET) {
      const sig = String(req.headers["x-hub-signature-256"] ?? "");
      const expected = `sha256=${crypto.createHmac("sha256", env.GITHUB_WEBHOOK_SECRET).update(raw).digest("hex")}`;
      if (!sig || !safeEqual(sig, expected)) return reply.code(401).send({ error: "invalid signature" });
    } else if (env.NODE_ENV === "production") return reply.code(503).send({ error: "GITHUB_WEBHOOK_SECRET not configured" });
    const delivery = String(req.headers["x-github-delivery"] ?? crypto.randomUUID());
    const fresh = await one("INSERT INTO webhook_deliveries (source, delivery_id) VALUES ('github',$1) ON CONFLICT DO NOTHING RETURNING 1", [delivery]);
    if (!fresh) return { duplicate: true };
    const event = String(req.headers["x-github-event"] ?? "");
    const body = req.body as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const repo = body?.repository?.full_name as string | undefined;
    const svc = repo ? (await one("SELECT name FROM services WHERE repo = $1", [repo]))?.name ?? repo.split("/")[1] : "unknown";
    if (event === "deployment_status" && body.deployment_status?.state === "success") {
      const d = body.deployment;
      return ingestDeploy({ service: svc, sha: d.sha, author: d.creator?.login ?? "github", message: d.description ?? d.ref, kind: "code", files: [], diff: "", source: "github", deployedAt: new Date(body.deployment_status.created_at) });
    }
    if (event === "push" && Array.isArray(body.commits)) {
      for (const c of body.commits.slice(0, 20)) {
        const files = [...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])].map((p: string) => ({ path: p, additions: 0, deletions: 0 }));
        if (body.ref === `refs/heads/${body.repository?.default_branch}`) await q("INSERT INTO deploys (service, sha, author, message, files, source, kind) VALUES ($1,$2,$3,$4,$5,'github-push','code') ON CONFLICT DO NOTHING", [svc, c.id, c.author?.username ?? c.author?.name ?? "github", c.message, JSON.stringify(files)]);
      }
      return { recorded: body.commits.length };
    }
    return { ignored: event };
  });
}
