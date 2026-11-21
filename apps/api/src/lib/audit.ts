import { q } from "../db/pool.js";

/** Append-only audit trail for every human and agent decision. */
export function audit(actor: string, action: string, target = "", data: Record<string, unknown> = {}, ip?: string) {
  return q("INSERT INTO audit_log (actor, action, target, data, ip) VALUES ($1,$2,$3,$4,$5)", [actor, action, target, data, ip ?? null]).catch((e) => console.error("audit failed:", e.message));
}
