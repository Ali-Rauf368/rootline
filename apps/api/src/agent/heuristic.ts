import { runTool, type RunContext, type ToolName } from "./tools.js";
import { revertDiff, newFileDiff } from "../services/patches.js";
import { tokenize } from "../lib/text.js";
import { q } from "../db/pool.js";

type Recorder = (step: { kind: "thought" | "tool_call" | "conclusion"; tool?: string; input?: unknown; output?: unknown; durationMs?: number }) => Promise<void>;

/**
 * Deterministic investigator used when no LLM is configured (or as a fallback). It follows the same
 * playbook an SRE would: establish onset → list changes in the blast radius → diff new error signatures →
 * score each change by timing, locality and lexical overlap with the errors → retrieve runbooks → cite → propose a revert.
 */
export async function heuristicInvestigate(ctx: RunContext, record: Recorder) {
  const call = async (tool: ToolName, input: Record<string, unknown> = {}) => {
    const t0 = Date.now();
    const output = await runTool(ctx, tool, input);
    await record({ kind: "tool_call", tool, input, output, durationMs: Date.now() - t0 });
    return output as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const think = (text: string) => record({ kind: "thought", output: { text } });

  const context = await call("get_incident_context");
  await think(`Investigating ${context.key}: "${context.title}". First I'll pin down exactly when the regression started.`);

  let onset = new Date(context.onset);
  const metricFindings: string[] = [];
  for (const svc of context.services as string[]) {
    for (const metric of ["error_rate", "latency_p95_ms"]) {
      const m = await call("query_metrics", { service: svc, metric, minutes: 90 });
      if (m.onset) {
        if (new Date(m.onset) < onset) onset = new Date(m.onset);
        metricFindings.push(`${svc} ${metric}: ${m.baseline} → ${m.peak} from ${m.onset.slice(11, 16)}`);
      }
    }
  }
  await think(metricFindings.length ? `Change point(s): ${metricFindings.join("; ")}. Next: what changed in the blast radius shortly before that?` : "No clear change point in the core metrics; widening the search to changes and logs.");

  const topology = await call("get_service_topology");
  const changes: any[] = await call("list_recent_changes", { hours: 6 }); // eslint-disable-line @typescript-eslint/no-explicit-any
  const logs: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  // search the whole blast radius: affected services and their direct dependencies (the origin is often downstream)
  const radius = [...new Set([...context.services, ...(topology as { name: string; depends_on: string[] }[]).filter((s) => context.services.includes(s.name)).flatMap((s) => s.depends_on)])];
  for (const svc of radius) {
    const found = await call("search_logs", { service: svc, minutes: 60 });
    logs.push(...found);
  }
  logs.sort((a, b) => b.since_onset - a.since_onset);
  const newSignatures = logs.filter((l) => l.isNew || l.since_onset > 3 * Math.max(1, l.before));
  await think(newSignatures.length
    ? `${newSignatures.length} error signature(s) appeared or surged after onset, e.g. "${newSignatures[0].sample.slice(0, 140)}".`
    : "No new error signatures; the regression looks like latency/saturation rather than outright failures.");

  const errorTokens = new Set(tokenize(newSignatures.map((l) => l.sample).join(" ")));
  const depOf = new Set((topology as { name: string; depends_on: string[] }[]).filter((s) => context.services.includes(s.name)).flatMap((s) => s.depends_on));

  type Scored = { change: any; score: number; evidence: any[]; overlap: string[] }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const scored: Scored[] = [];
  // Rollbacks and Rootline's own fix deploys restore known-good state: never suspects
  const isRemediation = (c: { kind: string; author: string; message: string }) => c.kind === "rollback" || c.author === "rootline-bot" || /^merge fix for incident/i.test(c.message);
  const excluded = changes.filter(isRemediation);
  if (excluded.length) await think(`Ignoring ${excluded.length} remediation deploy(s) (rollbacks / approved fixes). They restore known-good state.`);
  for (const c of changes.filter((c) => !isRemediation(c) && c.minutesBeforeOnset >= -5 && c.minutesBeforeOnset <= 240)) {
    const d = await call("get_deploy_diff", { deployId: c.id });
    const changedLines = String(d.diff).split("\n").filter((l: string) => /^[+-][^+-]/.test(l)).join(" ");
    const diffTokens = new Set(tokenize(changedLines + " " + (d.files as { path: string }[]).map((f) => f.path).join(" ")));
    const overlap = [...errorTokens].filter((t) => diffTokens.has(t) && t.length > 3);
    const temporal = c.minutesBeforeOnset <= 30 ? 0.42 : c.minutesBeforeOnset <= 90 ? 0.28 : 0.12;
    const locality = context.services.includes(c.service) ? 0.2 : depOf.has(c.service) ? 0.13 : 0.03;
    const lexical = Math.min(0.28, overlap.length * 0.07);
    const kind = c.kind === "config" || /config|values|settings/.test(JSON.stringify(d.files)) ? 0.05 : 0;
    // a change we can't inspect (no diff) is only circumstantial evidence
    const score = String(d.diff).trim() ? Math.min(0.97, temporal + locality + lexical + kind) : Math.min(0.3, (temporal + locality) * 0.6);
    scored.push({
      change: d, score, overlap,
      evidence: [
        { type: "deploy", label: `${c.service}@${c.sha.slice(0, 7)} deployed ${c.minutesBeforeOnset} min before onset`, detail: `${c.author}: ${c.message}`, weight: temporal },
        { type: "topology", label: context.services.includes(c.service) ? "Change is in the affected service" : depOf.has(c.service) ? "Change is in a direct dependency" : "Change is outside the dependency path", detail: `Service ${c.service}`, weight: locality },
        ...(overlap.length ? [{ type: "diff", label: "Diff touches terms that appear in the new errors", detail: overlap.slice(0, 8).join(", "), weight: lexical }] : []),
        ...(newSignatures[0] ? [{ type: "log", label: `New error signature (${newSignatures[0].since_onset} since onset, ${newSignatures[0].before} before)`, detail: newSignatures[0].sample.slice(0, 300), weight: 0.1 }] : []),
        ...(metricFindings[0] ? [{ type: "metric", label: "Change point", detail: metricFindings.join("; "), weight: 0.1 }] : []),
      ],
    });
  }
  scored.sort((a, b) => b.score - a.score);

  // Dependency hypothesis: a dependency is itself unhealthy
  const depSignals: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const dep of [...depOf].slice(0, 3)) {
    const m = await call("query_metrics", { service: dep, metric: "latency_p95_ms", minutes: 90 });
    if (m.onset) depSignals.push({ dep, m });
  }

  const query = [newSignatures[0]?.fingerprint ?? context.title, scored[0]?.overlap.join(" ") ?? "", scored[0]?.change.message ?? ""].join(" ").slice(0, 280);
  const hits: any[] = await call("search_runbooks", { query, service: context.services[0] }); // eslint-disable-line @typescript-eslint/no-explicit-any
  const similar: any[] = await call("similar_incidents", { query: `${context.title} ${scored[0]?.overlap.join(" ") ?? ""}` }); // eslint-disable-line @typescript-eslint/no-explicit-any
  const citations = hits.slice(0, 3).map((h) => ({ chunkId: h.chunkId, quote: bestSentence(h.content, query) })).filter((c) => c.quote && tokenize(c.quote).some((t) => tokenize(query).includes(t) && t.length > 3));

  const citeFor = async (q2: string) => {
    const hs: any[] = q2 === query ? hits : await call("search_runbooks", { query: q2.slice(0, 280), service: context.services[0] }); // eslint-disable-line @typescript-eslint/no-explicit-any
    return hs.slice(0, 3).map((h) => ({ chunkId: h.chunkId, quote: bestSentence(h.content, q2) })).filter((c) => c.quote && h_overlap(c.quote, q2));
  };
  const h_overlap = (a: string, b: string) => { const t = new Set(tokenize(b)); return tokenize(a).some((x) => t.has(x) && x.length > 3); };
  const hypotheses = [];
  for (const [rank, s] of scored.slice(0, 2).entries()) {
    const isConfig = s.change.kind === "config" || /config|values|settings|\.json|\.ya?ml|\.env/.test(JSON.stringify(s.change.files));
    hypotheses.push({
      title: `${isConfig ? "Config" : "Code"} change ${s.change.sha.slice(0, 7)} in ${s.change.service}: ${s.change.message.slice(0, 90)}`,
      description: `The regression began ${Math.max(0, Math.round((onset.getTime() - new Date(s.change.deployed_at).getTime()) / 60000))} minutes after ${s.change.author} deployed ${s.change.sha.slice(0, 7)} to ${s.change.service} ("${s.change.message}"). ${s.overlap.length ? `The diff changes ${s.overlap.slice(0, 5).join(", ")}, which are exactly the terms in the new error signature.` : "No direct lexical link between the diff and the errors, so timing is the main signal."}${similar.length ? ` Similar past incident: ${similar[0].key} (${similar[0].title}).` : ""}`,
      category: isConfig ? "config_change" : "code_change",
      confidence: Math.round(s.score * 100) / 100,
      suspectDeployId: s.change.id,
      evidence: [...s.evidence, ...(similar[0] && rank === 0 ? [{ type: "incident", label: `Similar: ${similar[0].key}`, detail: similar[0].root_cause ?? similar[0].title, weight: 0.05 }] : [])].slice(0, 8),
      citations: rank === 0 ? citations : await citeFor(`${s.change.service} ${s.change.message} ${s.overlap.join(" ")}`),
    });
  }
  if (depSignals.length) {
    const d = depSignals[0];
    hypotheses.push({
      title: `Upstream dependency ${d.dep} degraded`, category: "dependency",
      description: `${d.dep} latency moved from ${d.m.baseline} to ${d.m.peak} ms starting ${d.m.onset.slice(11, 16)}. Callers in ${context.services.join(", ")} inherit the slowdown and time out.`,
      confidence: scored.length ? Math.max(0.1, Math.min(0.5, 0.9 - scored[0].score)) : 0.62,
      suspectDeployId: null, evidence: [{ type: "metric", label: `${d.dep} p95 latency change point`, detail: `${d.m.baseline} → ${d.m.peak} ms`, weight: 0.4 }], citations: await citeFor(`${d.dep} latency timeout upstream degraded`),
    });
  }
  if (!hypotheses.length) hypotheses.push({ title: "No change correlates with the regression", category: "unknown", description: "No deploy or config change in the blast radius precedes the onset. Check traffic patterns, infrastructure events and third-party status pages.", confidence: 0.2, suspectDeployId: null, evidence: [{ type: "metric", label: "Onset", detail: metricFindings.join("; ") || context.summary }], citations });

  for (const h of hypotheses.sort((a, b) => b.confidence - a.confidence)) await call("submit_hypothesis", h);

  const top = ctx.hypotheses[0];
  const suspect = top?.suspectDeployId ? scored.find((s) => s.change.id === top.suspectDeployId)?.change : null;
  if (suspect && suspect.diff && top.confidence >= 0.5) {
    const snapshot = new Set((await q<{ path: string }>("SELECT path FROM repo_files WHERE service = $1", [suspect.service])).map((r) => r.path));
    const patch = await revertDiff(suspect.service, suspect.diff);
    const touched = (suspect.files as { path: string }[]).map((f) => f.path).filter((p) => snapshot.has(p));
    if (patch && touched.length) {
      const testPath = `test/regression/${ctx.incident.key.toLowerCase()}.test.ts`;
      const test = regressionTest(ctx.incident.key, suspect, touched);
      await call("propose_fix", {
        hypothesisIndex: 0, service: suspect.service, strategy: "revert",
        title: `Revert ${suspect.sha.slice(0, 7)}: ${suspect.message.slice(0, 80)}`,
        description: `Reverts only the hunks changed by ${suspect.sha.slice(0, 7)} in ${touched.join(", ")} and adds a regression test so the bad value can't ship again. Mitigates ${ctx.incident.key} while the owning team works on a forward fix.`,
        patch, testPatch: newFileDiff(testPath, test),
      });
    }
  }
  const summary = top
    ? `Most likely cause (${Math.round(top.confidence * 100)}%): ${top.title}. ${ctx.fixes.length ? "A verified revert is waiting for approval." : "No automatic fix proposed. Review the evidence."}`
    : "Inconclusive.";
  await call("finish", { summary });
}

function bestSentence(content: string, query: string) {
  const qt = new Set(tokenize(query));
  const sentences = content.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length > 20 && s.length < 380);
  return sentences.map((s) => ({ s, n: tokenize(s).filter((t) => qt.has(t)).length })).sort((a, b) => b.n - a.n)[0]?.s ?? "";
}

function regressionTest(key: string, deploy: { sha: string; diff: string }, files: string[]) {
  const removed = String(deploy.diff).split("\n").filter((l) => /^-[^-]/.test(l)).map((l) => l.slice(1).trim());
  const keys = removed.map((l) => l.match(/["']?([A-Za-z_]+)["']?\s*[:=]\s*(\d+)/)).filter(Boolean).map((m) => ({ key: m![1], value: Number(m![2]) }));
  const asserts = keys.map((k) => `    expect(Number(config.${k.key})).toBeGreaterThanOrEqual(${Math.max(1, Math.floor(k.value * 0.5))}); // ${key}: ${deploy.sha.slice(0, 7)} lowered this`).join("\n") || `    expect(config).toBeDefined();`;
  return `// Regression test generated by Rootline for ${key}
import { describe, it, expect } from "vitest";
import config from "../../${files[0]}";

describe("${key} regression", () => {
  it("keeps safe operating values", () => {
${asserts}
  });
});
`;
}
