import { flag } from "../lib/flags.js";
import { one, q } from "../db/pool.js";
import { publish } from "../lib/bus.js";
import { enqueue } from "../lib/queue.js";

export const STATUSES = ["detected", "investigating", "identified", "mitigating", "resolved"] as const;
export type Status = (typeof STATUSES)[number];
const STAMP: Partial<Record<Status, string>> = { identified: "identified_at", mitigating: "mitigated_at", resolved: "resolved_at" };

export async function addEvent(incidentId: number, kind: string, title: string, body = "", actor = "system", data: Record<string, unknown> = {}) {
  const ev = await one("INSERT INTO incident_events (incident_id, kind, title, body, actor, data) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *", [incidentId, kind, title, body, actor, data]);
  await q("UPDATE incidents SET updated_at = now() WHERE id = $1", [incidentId]);
  await publish({ type: "incident.event", incidentId, event: ev });
  return ev;
}

/**
 * Opens an incident unless one is already open for the same dedupe key (service + signal).
 * Returns { incident, created }. New incidents automatically get an investigation queued.
 */
export async function openIncident(input: { title: string; severity: "sev1" | "sev2" | "sev3" | "sev4"; services: string[]; startedAt: Date; source: string; dedupeKey: string; summary?: string; data?: Record<string, unknown> }) {
  const existing = await one("SELECT * FROM incidents WHERE dedupe_key = $1 AND status <> 'resolved'", [input.dedupeKey]);
  if (existing) return { incident: existing, created: false };
  const incident = await one(
    `INSERT INTO incidents (title, severity, services, started_at, source, dedupe_key, summary) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (dedupe_key) WHERE status <> 'resolved' AND dedupe_key IS NOT NULL DO NOTHING RETURNING *`,
    [input.title, input.severity, input.services, input.startedAt, input.source, input.dedupeKey, input.summary ?? ""]);
  if (!incident) return { incident: await one("SELECT * FROM incidents WHERE dedupe_key = $1 AND status <> 'resolved'", [input.dedupeKey]), created: false };
  await addEvent(incident.id, "detected", `Incident detected via ${input.source}`, input.summary ?? "", "opsmeridian", input.data ?? {});
  await publish({ type: "incident.created", incidentId: incident.id });
  await startInvestigation(incident.id, "auto");
  return { incident, created: true };
}

export async function startInvestigation(incidentId: number, trigger: string) {
  if (!trigger.startsWith("manual") && !flag("auto_investigate")) { await addEvent(incidentId, "agent", "Auto-investigation is turned off", `Trigger: ${trigger}. Start it manually from the war room.`, "opsmeridian"); return; }
  await enqueue("investigate", { incidentId, trigger }, { dedupeKey: `investigate-${incidentId}`, maxAttempts: 2 });
}

export async function setStatus(incidentId: number, status: Status, actor: string, note = "") {
  const col = STAMP[status];
  const inc = await one(
    `UPDATE incidents SET status = $2, updated_at = now() ${col ? `, ${col} = COALESCE(${col}, now())` : ""}
       ${status !== "detected" ? ", acknowledged_at = COALESCE(acknowledged_at, now())" : ""}
     WHERE id = $1 RETURNING *`, [incidentId, status]);
  if (!inc) return null;
  await addEvent(incidentId, "status", `Status → ${status}`, note, actor);
  await publish({ type: "incident.updated", incidentId });
  return inc;
}

export const SEVERITY_FOR_TIER = (tier: number, metric: string): "sev1" | "sev2" | "sev3" => (tier === 1 && metric === "error_rate" ? "sev1" : tier === 1 ? "sev2" : tier === 2 ? "sev2" : "sev3");
