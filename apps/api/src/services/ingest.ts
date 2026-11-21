import { z } from "zod";
import { one, q } from "../db/pool.js";
import { publish } from "../lib/bus.js";
import { fingerprint } from "../lib/text.js";
import { detect, METRIC_RULES } from "./anomaly.js";
import { openIncident, addEvent, SEVERITY_FOR_TIER, startInvestigation } from "./incidents.js";

export const LogIn = z.object({
  service: z.string().min(1).max(100),
  ts: z.coerce.date().optional(),
  level: z.enum(["debug", "info", "warn", "error", "fatal"]).default("info"),
  message: z.string().min(1).max(8000),
  traceId: z.string().max(100).optional(),
  attrs: z.record(z.unknown()).optional(),
});
export const MetricIn = z.object({
  service: z.string().min(1).max(100),
  name: z.string().regex(/^[a-z0-9_]{1,60}$/),
  ts: z.coerce.date().optional(),
  value: z.number().finite(),
});
export const DeployIn = z.object({
  service: z.string().min(1).max(100),
  sha: z.string().min(4).max(64),
  author: z.string().max(100).default("unknown"),
  message: z.string().max(2000).default(""),
  prNumber: z.number().int().optional(),
  kind: z.enum(["code", "config", "infra", "rollback"]).default("code"),
  files: z.array(z.object({ path: z.string(), additions: z.number().int().default(0), deletions: z.number().int().default(0) })).default([]),
  diff: z.string().max(500_000).default(""),
  deployedAt: z.coerce.date().optional(),
  source: z.string().max(40).default("webhook"),
});

async function ensureService(name: string) {
  await q("INSERT INTO services (name, display_name) VALUES ($1, $1) ON CONFLICT (name) DO NOTHING", [name]);
}

/** Bulk log insert (single statement); returns count. */
export async function ingestLogs(logs: z.infer<typeof LogIn>[]) {
  if (!logs.length) return 0;
  const services = [...new Set(logs.map((l) => l.service))];
  for (const s of services) await ensureService(s);
  const cols = ["service", "ts", "level", "message", "fingerprint", "trace_id", "attrs"];
  const values: unknown[] = [];
  const rows = logs.map((l, i) => {
    values.push(l.service, l.ts ?? new Date(), l.level, l.message, fingerprint(l.message), l.traceId ?? null, l.attrs ?? {});
    return `(${cols.map((_, j) => `$${i * cols.length + j + 1}`).join(",")})`;
  });
  const inserted = await q(`INSERT INTO log_events (${cols.join(",")}) VALUES ${rows.join(",")} RETURNING id, service, ts, level, message, fingerprint, trace_id`, values);
  for (const l of inserted.filter((x) => x.level === "error" || x.level === "fatal").slice(0, 20)) await publish({ type: "log", log: l });
  return inserted.length;
}

/** Metric insert + anomaly check per (service, metric). Opens incidents on sustained deviation. */
export async function ingestMetrics(points: z.infer<typeof MetricIn>[]) {
  if (!points.length) return { inserted: 0, anomalies: [] as unknown[] };
  for (const s of new Set(points.map((p) => p.service))) await ensureService(s);
  const values: unknown[] = [];
  const rows = points.map((p, i) => { values.push(p.service, p.name, p.ts ?? new Date(), p.value); return `($${i * 4 + 1},$${i * 4 + 2},$${i * 4 + 3},$${i * 4 + 4})`; });
  await q(`INSERT INTO metric_points (service, name, ts, value) VALUES ${rows.join(",")} ON CONFLICT (service, name, ts) DO UPDATE SET value = EXCLUDED.value`, values);

  const anomalies = [];
  const keys = [...new Map(points.filter((p) => METRIC_RULES[p.name]).map((p) => [`${p.service}|${p.name}`, p])).values()];
  for (const p of keys) {
    const series = (await q<{ value: number; ts: Date }>("SELECT value, ts FROM metric_points WHERE service = $1 AND name = $2 AND ts > now() - interval '45 minutes' ORDER BY ts DESC LIMIT 60", [p.service, p.name])).reverse();
    const rule = METRIC_RULES[p.name];
    const d = detect(series.map((s) => s.value), { threshold: rule.threshold, minAbsoluteDelta: rule.minAbsoluteDelta });
    if (!d.anomalous) continue;
    const svc = await one<{ tier: number; display_name: string }>("SELECT tier, display_name FROM services WHERE name = $1", [p.service]);
    // Correlate: an open incident (last 20 min) that already includes this service, or a direct dependency /
    // dependent of it, absorbs the signal instead of paging twice for one failure.
    const related = await one<{ id: number; services: string[]; title: string }>(`SELECT i.id, i.services, i.title FROM incidents i, services s
       WHERE i.status IN ('detected','investigating','identified') AND i.detected_at > now() - interval '20 minutes' AND s.name = $1
         AND ($1 = ANY(i.services) OR i.services && s.depends_on
              OR EXISTS (SELECT 1 FROM services d WHERE d.name = ANY(i.services) AND $1 = ANY(d.depends_on)))
       ORDER BY ($1 = ANY(i.services)) DESC, i.detected_at LIMIT 1`, [p.service]);
    if (related) {
      const label = svc?.display_name ?? p.service;
      if (!related.services.includes(p.service)) {
        await q("UPDATE incidents SET services = array_append(services, $2), updated_at = now() WHERE id = $1", [related.id, p.service]);
        // the service deeper in the call chain is the likely origin: retitle around it
        const isDependency = await one("SELECT 1 FROM services WHERE name = ANY($1) AND $2 = ANY(depends_on)", [related.services, p.service]);
        if (isDependency) await q("UPDATE incidents SET title = $2 WHERE id = $1", [related.id, `${rule.label} spike on ${label} (impacting ${related.services.join(", ")})`]);
        // the blast radius changed: re-investigate with the new evidence (deduped while one is queued)
        await startInvestigation(related.id, `blast radius grew: ${p.service}`);
      }
      const seen = await one("SELECT 1 FROM incident_events WHERE incident_id = $1 AND kind = 'signal' AND data->>'metric' = $2 AND data->>'service' = $3", [related.id, p.name, p.service]);
      if (!seen) await addEvent(related.id, "signal", `${label}: ${rule.label.toLowerCase()} anomalous${related.services.includes(p.service) ? "" : " (correlated via dependency graph)"}`, `${fmt(d.value, p.name)} vs ${fmt(d.baseline, p.name)} (z = ${d.zscore})`, "rootline", { metric: p.name, service: p.service });
      await q("INSERT INTO anomalies (service, metric, ts, value, baseline, zscore, incident_id) VALUES ($1,$2,now(),$3,$4,$5,$6)", [p.service, p.name, d.value, d.baseline, d.zscore, related.id]);
      await publish({ type: "incident.updated", incidentId: related.id });
      anomalies.push({ service: p.service, metric: p.name, ...d, incidentId: related.id, correlated: true });
      continue;
    }
    // onset = first point of the current breach run
    const onset = series.at(-2)?.ts ?? new Date();
    const { incident, created } = await openIncident({
      title: `${rule.label} spike on ${svc?.display_name ?? p.service}`,
      severity: SEVERITY_FOR_TIER(svc?.tier ?? 2, p.name),
      services: [p.service],
      startedAt: onset,
      source: "anomaly",
      dedupeKey: `anomaly:${p.service}`,
      summary: `${rule.label} at ${fmt(d.value, p.name)} vs baseline ${fmt(d.baseline, p.name)} (robust z = ${d.zscore}).`,
      data: { metric: p.name, value: d.value, baseline: d.baseline, zscore: d.zscore },
    });
    await q("INSERT INTO anomalies (service, metric, ts, value, baseline, zscore, incident_id) VALUES ($1,$2,now(),$3,$4,$5,$6)", [p.service, p.name, d.value, d.baseline, d.zscore, incident?.id ?? null]);
    if (!created && incident) {
      // record additional affected signals on an already-open incident (once per metric)
      const seen = await one("SELECT 1 FROM incident_events WHERE incident_id = $1 AND kind = 'signal' AND data->>'metric' = $2", [incident.id, p.name]);
      if (!seen) await addEvent(incident.id, "signal", `${rule.label} also anomalous`, `${fmt(d.value, p.name)} vs ${fmt(d.baseline, p.name)} (z = ${d.zscore})`, "rootline", { metric: p.name });
    }
    anomalies.push({ service: p.service, metric: p.name, ...d, incidentId: incident?.id });
  }
  return { inserted: points.length, anomalies };
}

export async function ingestDeploy(d: z.infer<typeof DeployIn>) {
  await ensureService(d.service);
  const row = await one(
    `INSERT INTO deploys (service, sha, author, message, pr_number, kind, files, diff, deployed_at, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (service, sha) DO UPDATE SET message = EXCLUDED.message RETURNING *`,
    [d.service, d.sha, d.author, d.message, d.prNumber ?? null, d.kind, JSON.stringify(d.files), d.diff, d.deployedAt ?? new Date(), d.source]);
  await publish({ type: "deploy", deploy: { id: row.id, service: row.service, sha: row.sha, message: row.message, deployed_at: row.deployed_at } });
  // annotate open incidents on this service: a deploy during an incident is important context
  for (const inc of await q("SELECT id FROM incidents WHERE status <> 'resolved' AND $1 = ANY(services)", [d.service]))
    await addEvent(inc.id, "deploy", `Deploy ${d.sha.slice(0, 7)} to ${d.service}`, d.message, d.author, { deployId: row.id });
  return row;
}

const fmt = (v: number, metric: string) => (metric === "error_rate" ? `${(v * 100).toFixed(1)}%` : metric.endsWith("_ms") ? `${Math.round(v)} ms` : v.toFixed(2));

/** Alertmanager / generic alert webhook → incident (firing) or note (resolved). */
export const AlertIn = z.object({
  alerts: z.array(z.object({
    status: z.enum(["firing", "resolved"]).default("firing"),
    labels: z.record(z.string()).default({}),
    annotations: z.record(z.string()).default({}),
    startsAt: z.coerce.date().optional(),
    fingerprint: z.string().optional(),
  })).min(1).max(200),
});
export async function ingestAlerts(body: z.infer<typeof AlertIn>) {
  const out = [];
  for (const a of body.alerts) {
    const service = a.labels.service ?? a.labels.job ?? a.labels.app ?? "unknown";
    const name = a.labels.alertname ?? "Alert";
    await ensureService(service);
    if (a.status === "resolved") {
      const inc = await one("SELECT id FROM incidents WHERE dedupe_key = $1 AND status <> 'resolved'", [`alert:${service}:${name}`]);
      if (inc) await addEvent(inc.id, "alert", `Alert resolved: ${name}`, a.annotations.summary ?? "", "alertmanager");
      out.push({ service, name, status: "resolved", incidentId: inc?.id ?? null });
      continue;
    }
    const sevLabel = (a.labels.severity ?? "").toLowerCase();
    const severity = sevLabel === "critical" || sevLabel === "page" ? "sev1" : sevLabel === "warning" ? "sev3" : "sev2";
    const { incident, created } = await openIncident({ title: a.annotations.summary ?? `${name} on ${service}`, severity, services: [service], startedAt: a.startsAt ?? new Date(), source: "alert", dedupeKey: `alert:${service}:${name}`, summary: a.annotations.description ?? "", data: { labels: a.labels } });
    out.push({ service, name, status: "firing", incidentId: incident?.id, created });
  }
  return out;
}
