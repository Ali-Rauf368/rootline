import { EventEmitter } from "node:events";
import pg from "pg";
import { env } from "./env.js";
import { pool } from "../db/pool.js";

/**
 * Realtime event bus. Publishes go through Postgres NOTIFY so every process (API, worker) sees them;
 * the API fans them out to SSE subscribers. No Redis required.
 */
export type BusEvent =
  | { type: "incident.created" | "incident.updated"; incidentId: number }
  | { type: "incident.event"; incidentId: number; event: unknown }
  | { type: "investigation.step"; incidentId: number; investigationId: number; step: unknown }
  | { type: "investigation.status"; incidentId: number; investigationId: number; status: string }
  | { type: "hypotheses.updated" | "fix.updated"; incidentId: number }
  | { type: "metrics.tick"; ts: string }
  | { type: "log"; log: unknown }
  | { type: "deploy"; deploy: unknown }
  | { type: "flags.updated"; flags: Record<string, boolean> }
  | { type: "chat.message"; incidentId: number; message: unknown }
  | { type: "fix.approval"; incidentId: number; fixId: number; approvals: number; required: number; by: string };

const CHANNEL = "rootline_events";
const local = new EventEmitter();
local.setMaxListeners(1000);

export async function publish(event: BusEvent) {
  const payload = JSON.stringify(event);
  // NOTIFY payloads are limited to 8000 bytes; big events are delivered locally only
  if (payload.length < 7900) await pool.query("SELECT pg_notify($1, $2)", [CHANNEL, payload]).catch(() => local.emit("event", event));
  else local.emit("event", event);
}

let listener: pg.Client | null = null;
export async function startBusListener() {
  if (listener) return;
  listener = new pg.Client({ connectionString: env.DATABASE_URL });
  listener.on("error", (e) => { console.error("bus listener error:", e.message); listener = null; setTimeout(startBusListener, 2000); });
  await listener.connect();
  await listener.query(`LISTEN ${CHANNEL}`);
  listener.on("notification", (msg) => { try { local.emit("event", JSON.parse(msg.payload ?? "{}")); } catch { /* ignore */ } });
}
export async function stopBusListener() { await listener?.end().catch(() => {}); listener = null; }

export function subscribe(fn: (e: BusEvent) => void) {
  local.on("event", fn);
  return () => local.off("event", fn);
}
