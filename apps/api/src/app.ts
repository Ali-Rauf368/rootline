import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import { env } from "./lib/env.js";
import authRoutes from "./routes/auth.js";
import ingestRoutes from "./routes/ingest.js";
import incidentRoutes from "./routes/incidents.js";
import platformRoutes from "./routes/platform.js";

export async function buildApp() {
  const app = Fastify({
    logger: env.NODE_ENV === "test" ? false : { level: env.LOG_LEVEL, redact: ["req.headers.authorization", "req.headers.cookie", 'req.headers["x-api-key"]'] },
    trustProxy: true,
    bodyLimit: 1024 * 1024,
    genReqId: () => crypto.randomUUID(),
    disableRequestLogging: true,
  });
  // log only what matters: errors, client errors and slow requests (health checks never)
  app.addHook("onResponse", async (req, reply) => {
    if (req.url === "/healthz" || req.url === "/readyz") return;
    const ms = reply.elapsedTime;
    if (reply.statusCode >= 400 || ms > 1000) req.log.info({ method: req.method, url: req.url.split("?")[0], status: reply.statusCode, ms: Math.round(ms) }, "request");
  });
  // keep the raw body for webhook signature verification
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as unknown as { rawBody: string }).rawBody = body as string;
    if (!body) return done(null, {});
    try { done(null, JSON.parse(body as string)); } catch (e) { (e as { statusCode?: number }).statusCode = 400; done(e as Error, undefined); }
  });
  await app.register(cors, { origin: env.WEB_ORIGIN.split(","), credentials: true });
  await app.register(cookie);
  await app.register(rateLimit, { max: Number(process.env.API_RATE_LIMIT ?? 1200), timeWindow: "1 minute" });

  app.setErrorHandler((err: Error, req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: "validation_error", message: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "), issues: err.issues });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    return reply.code(status).send({ error: status >= 500 ? "internal_error" : "request_error", message: status >= 500 && env.NODE_ENV === "production" ? "Internal error" : err.message, requestId: req.id });
  });

  await app.register(authRoutes);
  await app.register(ingestRoutes);
  await app.register(incidentRoutes);
  await app.register(platformRoutes);
  return app;
}
