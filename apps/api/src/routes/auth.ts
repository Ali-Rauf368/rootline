import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { one } from "../db/pool.js";
import { sign, requireRole } from "../lib/auth.js";
import { audit } from "../lib/audit.js";
import { env } from "../lib/env.js";

const DUMMY_HASH = bcrypt.hashSync("timing-equaliser", 10);
const cookie = { httpOnly: true, sameSite: "lax" as const, secure: env.NODE_ENV === "production", path: "/", maxAge: 12 * 3600 };

export default async function authRoutes(app: FastifyInstance) {
  app.post("/api/auth/login", { config: { rateLimit: { max: Number(process.env.LOGIN_RATE_LIMIT ?? 10), timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = z.object({ email: z.string().email().toLowerCase(), password: z.string().min(1).max(200) }).parse(req.body);
    const user = await one("SELECT * FROM users WHERE email = $1", [body.email]);
    const ok = user ? await bcrypt.compare(body.password, user.password_hash) : (await bcrypt.compare(body.password, DUMMY_HASH), false);
    if (!user || !ok) { await audit(body.email, "auth.login_failed", "", {}, req.ip); return reply.code(401).send({ error: "unauthorized", message: "Invalid email or password" }); }
    const session = { id: user.id, email: user.email, name: user.name, role: user.role };
    const token = await sign(session);
    await audit(user.email, "auth.login", "", {}, req.ip);
    return reply.setCookie("rl_session", token, cookie).send({ user: session, token });
  });

  app.post("/api/auth/logout", async (_req, reply) => reply.clearCookie("rl_session", { path: "/" }).send({ ok: true }));
  app.get("/api/auth/me", { preHandler: requireRole("viewer") }, async (req) => ({ user: req.user }));
  /** Short-lived ticket for EventSource (which can't send auth headers cross-origin). */
  app.get("/api/auth/stream-ticket", { preHandler: requireRole("viewer") }, async (req) => ({ ticket: await sign(req.user!, "2m", "stream") }));
}
