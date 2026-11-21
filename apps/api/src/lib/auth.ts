import "@fastify/cookie";
import crypto from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "./env.js";
import { one, q } from "../db/pool.js";

const secret = new TextEncoder().encode(env.JWT_SECRET);
export type Role = "viewer" | "responder" | "admin";
export interface SessionUser { id: number; email: string; name: string; role: Role }
const RANK: Record<Role, number> = { viewer: 0, responder: 1, admin: 2 };

export const sign = (u: SessionUser, ttl = "12h", purpose = "session") =>
  new SignJWT({ email: u.email, name: u.name, role: u.role, purpose }).setProtectedHeader({ alg: "HS256" }).setSubject(String(u.id)).setIssuedAt().setExpirationTime(ttl).sign(secret);

export async function verify(token: string, purpose = "session"): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    if (payload.purpose !== purpose) return null;
    return { id: Number(payload.sub), email: String(payload.email), name: String(payload.name), role: payload.role as Role };
  } catch { return null; }
}

declare module "fastify" { interface FastifyRequest { user?: SessionUser } }

function tokenOf(req: FastifyRequest) {
  const h = req.headers.authorization;
  if (h?.startsWith("Bearer ")) return h.slice(7);
  return (req.cookies as Record<string, string> | undefined)?.rl_session;
}

/** Route guard: requires a session with at least the given role. */
export const requireRole = (role: Role) => async (req: FastifyRequest, reply: FastifyReply) => {
  const t = tokenOf(req);
  const user = t ? await verify(t) : null;
  if (!user) return reply.code(401).send({ error: "unauthorized", message: "Sign in required" });
  if (RANK[user.role] < RANK[role]) return reply.code(403).send({ error: "forbidden", message: `Requires ${role} role` });
  req.user = user;
};

export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
export const safeEqual = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

/** Machine ingestion auth: per-source API key (hashed in DB) or the shared INGEST_TOKEN. */
export const requireIngestKey = async (req: FastifyRequest, reply: FastifyReply) => {
  const key = (req.headers["x-api-key"] as string | undefined) ?? (req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : undefined);
  if (!key) return reply.code(401).send({ error: "unauthorized", message: "Missing X-API-Key" });
  if (safeEqual(key, env.INGEST_TOKEN)) return;
  const row = await one("UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1 AND revoked_at IS NULL RETURNING id", [sha256(key)]);
  if (!row) return reply.code(401).send({ error: "unauthorized", message: "Invalid API key" });
};

export async function createApiKey(name: string, userId: number) {
  const key = `rl_${crypto.randomBytes(24).toString("base64url")}`;
  const preview = `${key.slice(0, 7)}…${key.slice(-4)}`;
  const [row] = await q("INSERT INTO api_keys (name, key_hash, preview, created_by) VALUES ($1,$2,$3,$4) RETURNING id, name, preview, created_at", [name, sha256(key), preview, userId]);
  return { ...row, key };
}
