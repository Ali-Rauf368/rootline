import { z } from "zod";
import { one, q } from "../db/pool.js";
import { searchKnowledge, type Hit } from "../services/knowledge.js";
import { robustZ } from "../services/anomaly.js";
import { tokenize } from "../lib/text.js";

/** Context shared by every tool call during one investigation. */
export interface RunContext {
  incident: { id: number; key: string; title: string; services: string[]; started_at: Date; detected_at: Date; summary: string; severity: string };
  retrieved: Map<number, Hit>;          // chunks seen this run → only these may be cited
  deploysSeen: Map<number, any>;        // eslint-disable-line @typescript-eslint/no-explicit-any
  hypotheses: HypothesisDraft[];
  fixes: FixDraft[];
  summary?: string;
}
export interface HypothesisDraft { title: string; description: string; category: string; confidence: number; suspectDeployId?: number | null; evidence: { type: string; label: string; detail: string; weight?: number }[]; citations: { chunkId: number; quote: string }[] }
export interface FixDraft { hypothesisIndex: number; strategy: "revert" | "patch" | "config"; title: string; description: string; patch: string; testPatch: string; service: string }

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
const iso = (d: Date | string) => new Date(d).toISOString();

export const TOOL_SCHEMAS = {
  get_incident_context: z.object({}),
  query_metrics: z.object({ service: z.string(), metric: z.enum(["error_rate", "latency_p95_ms", "rps", "cpu", "memory_mb", "saturation"]), minutes: z.number().int().min(5).max(360).default(60) }),
  list_recent_changes: z.object({ services: z.array(z.string()).optional(), hours: z.number().min(0.25).max(72).default(6) }),
  get_deploy_diff: z.object({ deployId: z.number().int() }),
  search_logs: z.object({ service: z.string().optional(), query: z.string().max(200).optional(), minutes: z.number().int().min(5).max(720).default(60) }),
  search_runbooks: z.object({ query: z.string().min(2).max(300), service: z.string().optional() }),
  similar_incidents: z.object({ query: z.string().min(2).max(300) }),
  get_service_topology: z.object({}),
  read_file: z.object({ service: z.string(), path: z.string().max(300) }),
  submit_hypothesis: z.object({
    title: z.string().min(5).max(160),
    description: z.string().min(10).max(2000),
    category: z.enum(["code_change", "config_change", "dependency", "capacity", "unknown"]),
    confidence: z.number().min(0).max(1),
    suspectDeployId: z.number().int().nullable().optional(),
    evidence: z.array(z.object({ type: z.enum(["metric", "deploy", "log", "diff", "runbook", "incident", "topology"]), label: z.string().max(160), detail: z.string().max(600), weight: z.number().min(0).max(1).optional() })).min(1).max(8),
    citations: z.array(z.object({ chunkId: z.number().int(), quote: z.string().min(8).max(400) })).max(6).default([]),
  }),
  propose_fix: z.object({
    hypothesisIndex: z.number().int().min(0),
    service: z.string(),
    strategy: z.enum(["revert", "patch", "config"]),
    title: z.string().min(5).max(160),
    description: z.string().min(10).max(2000),
    patch: z.string().min(10).max(50_000),
    testPatch: z.string().max(50_000).default(""),
  }),
  finish: z.object({ summary: z.string().min(10).max(3000) }),
};
export type ToolName = keyof typeof TOOL_SCHEMAS;

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  get_incident_context: "Get the incident: title, affected services, onset time, severity and detection summary. Call this first.",
  query_metrics: "Get a metric time series for a service with a detected change point (onset), baseline and peak.",
  list_recent_changes: "List deploys/config changes for services (defaults to affected services and their dependencies) within N hours before now, with minutes-before-onset.",
  get_deploy_diff: "Get the unified diff and changed files of a deploy by id.",
  search_logs: "Summarise error/warn log signatures (fingerprints) for a service: counts since onset vs the same window before, first seen, and sample messages.",
  search_runbooks: "Hybrid search (full-text + vector) over runbooks, postmortems and architecture docs. Returns chunk ids you can cite.",
  similar_incidents: "Find resolved past incidents with similar titles/root causes.",
  get_service_topology: "Get services, tiers, owners and dependency edges.",
  read_file: "Read a file from the service's repository snapshot (to write precise patches).",
  submit_hypothesis: "Record a root-cause hypothesis with calibrated confidence (0-1), evidence, and citations. Citations must use chunkIds returned by search_runbooks and quote text that appears verbatim in that chunk.",
  propose_fix: "Propose a fix for a submitted hypothesis as a unified diff against the repository snapshot (paths like a/config/x.json b/config/x.json), plus a regression test as a new-file unified diff. It will be verified and needs human approval before any PR is opened.",
  finish: "End the investigation with a concise summary for responders.",
};

async function changePoint(service: string, metric: string, minutes: number) {
  const pts = await q<{ ts: Date; value: number }>("SELECT ts, value FROM metric_points WHERE service = $1 AND name = $2 AND ts > $3 ORDER BY ts", [service, metric, minutesAgo(minutes)]);
  if (pts.length < 6) return { points: pts.length, onset: null, baseline: null, peak: null, latest: pts.at(-1)?.value ?? null, series: [] };
  const firstHalf = pts.slice(0, Math.max(6, Math.floor(pts.length / 2))).map((p) => p.value);
  let onset: Date | null = null;
  for (let i = 6; i < pts.length; i++) {
    const { z } = robustZ(pts.slice(0, i).map((p) => p.value), pts[i].value);
    if (z > 6 && pts[i + 1] && robustZ(pts.slice(0, i).map((p) => p.value), pts[i + 1].value).z > 6) { onset = pts[i].ts; break; }
  }
  const baseline = firstHalf.sort((a, b) => a - b)[firstHalf.length >> 1];
  const step = Math.max(1, Math.floor(pts.length / 24));
  return {
    points: pts.length, onset: onset ? iso(onset) : null, baseline: round(baseline), peak: round(Math.max(...pts.map((p) => p.value))), latest: round(pts.at(-1)!.value),
    series: pts.filter((_, i) => i % step === 0).map((p) => [iso(p.ts).slice(11, 16), round(p.value)]),
  };
}
const round = (n: number) => Math.round(n * 1000) / 1000;

export async function runTool(ctx: RunContext, name: ToolName, raw: unknown): Promise<unknown> {
  const input = TOOL_SCHEMAS[name].parse(raw ?? {}) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const inc = ctx.incident;
  switch (name) {
    case "get_incident_context": {
      const events = await q("SELECT ts, kind, title, body FROM incident_events WHERE incident_id = $1 ORDER BY ts LIMIT 20", [inc.id]);
      return { key: inc.key, title: inc.title, severity: inc.severity, services: inc.services, onset: iso(inc.started_at), detectedAt: iso(inc.detected_at), summary: inc.summary, timeline: events };
    }
    case "query_metrics":
      return { service: input.service, metric: input.metric, ...(await changePoint(input.service, input.metric, input.minutes)) };
    case "list_recent_changes": {
      const svcs: string[] = input.services ?? (await topologyNeighbours(inc.services));
      const rows = await q(`SELECT id, service, sha, author, message, kind, files, deployed_at, pr_number FROM deploys WHERE service = ANY($1) AND deployed_at > $2 ORDER BY deployed_at DESC LIMIT 20`, [svcs, new Date(Date.now() - input.hours * 3600_000)]);
      for (const r of rows) ctx.deploysSeen.set(r.id, r);
      return rows.map((r) => ({ ...r, deployed_at: iso(r.deployed_at), minutesBeforeOnset: Math.round((new Date(inc.started_at).getTime() - new Date(r.deployed_at).getTime()) / 60000) }));
    }
    case "get_deploy_diff": {
      const d = await one("SELECT id, service, sha, author, message, kind, files, diff, deployed_at FROM deploys WHERE id = $1", [input.deployId]);
      if (!d) throw new Error(`deploy ${input.deployId} not found`);
      ctx.deploysSeen.set(d.id, d);
      return { ...d, diff: d.diff.length > 12000 ? `${d.diff.slice(0, 12000)}\n… (truncated)` : d.diff };
    }
    case "search_logs": {
      const onset = new Date(inc.started_at);
      const window = input.minutes * 60_000;
      const svc = input.service ?? null;
      const rows = await q(
        `SELECT fingerprint, service,
                count(*) FILTER (WHERE ts >= $1)::int AS since_onset,
                count(*) FILTER (WHERE ts < $1)::int AS before,
                min(ts) AS first_seen, max(ts) AS last_seen,
                (array_agg(message ORDER BY ts DESC))[1] AS sample,
                max(level) AS level
         FROM log_events
         WHERE ts > $2 AND level IN ('warn','error','fatal') AND ($3::text IS NULL OR service = $3)
           AND ($4::text IS NULL OR tsv @@ plainto_tsquery('simple', $4))
         GROUP BY fingerprint, service ORDER BY since_onset DESC LIMIT 12`,
        [onset, new Date(onset.getTime() - window), svc, input.query ?? null]);
      return rows.map((r) => ({ ...r, first_seen: iso(r.first_seen), last_seen: iso(r.last_seen), isNew: r.before === 0, sample: String(r.sample).slice(0, 500) }));
    }
    case "search_runbooks": {
      const hits = await searchKnowledge(input.query, { service: input.service ?? inc.services[0], k: 5 });
      for (const h of hits) ctx.retrieved.set(h.chunkId, h);
      return hits.map((h) => ({ chunkId: h.chunkId, document: h.title, kind: h.kind, service: h.service, heading: h.heading, score: h.score, content: h.content.slice(0, 1200) }));
    }
    case "similar_incidents": {
      const toks = tokenize(input.query).slice(0, 10);
      if (!toks.length) return [];
      return q(`SELECT key, title, root_cause, severity, resolved_at, services FROM incidents
               WHERE status = 'resolved' AND id <> $1 AND to_tsvector('english', title || ' ' || coalesce(root_cause,'')) @@ to_tsquery('english', $2)
               ORDER BY resolved_at DESC LIMIT 5`, [inc.id, toks.join(" | ")]);
    }
    case "get_service_topology":
      return q("SELECT name, display_name, tier, owner_team, depends_on, repo FROM services ORDER BY tier, name");
    case "read_file": {
      const f = await one("SELECT path, content FROM repo_files WHERE service = $1 AND path = $2", [input.service, input.path.replace(/^[ab]\//, "")]);
      if (!f) return { error: "not found", available: (await q("SELECT path FROM repo_files WHERE service = $1 ORDER BY path", [input.service])).map((r) => r.path) };
      return f;
    }
    case "submit_hypothesis": {
      // Citation guard: drop anything not retrieved in this run or whose quote isn't verbatim in the chunk
      const citations = (input.citations as HypothesisDraft["citations"]).filter((c) => {
        const chunk = ctx.retrieved.get(c.chunkId);
        return chunk && normalise(chunk.content + " " + chunk.heading).includes(normalise(c.quote));
      });
      const dropped = input.citations.length - citations.length;
      if (input.suspectDeployId && !ctx.deploysSeen.has(input.suspectDeployId)) input.suspectDeployId = null;
      ctx.hypotheses.push({ ...input, citations });
      return { recorded: true, index: ctx.hypotheses.length - 1, verifiedCitations: citations.length, droppedCitations: dropped, ...(dropped ? { note: "Some citations were dropped: cite only chunkIds from search_runbooks and quote their text verbatim." } : {}) };
    }
    case "propose_fix": {
      if (!ctx.hypotheses[input.hypothesisIndex]) throw new Error(`no hypothesis at index ${input.hypothesisIndex}`);
      ctx.fixes.push(input);
      return { recorded: true, note: "The patch will be verified against the repository snapshot and requires human approval." };
    }
    case "finish":
      ctx.summary = input.summary;
      return { done: true };
  }
}

const normalise = (s: string) => s.toLowerCase().replace(/[`*_>#]/g, "").replace(/\s+/g, " ").trim();

export async function topologyNeighbours(services: string[]) {
  const rows = await q<{ name: string; depends_on: string[] }>("SELECT name, depends_on FROM services");
  const set = new Set(services);
  for (const r of rows) if (services.includes(r.name)) r.depends_on.forEach((d) => set.add(d));
  return [...set];
}
