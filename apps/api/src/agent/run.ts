import Anthropic from "@anthropic-ai/sdk";
import { one, q } from "../db/pool.js";
import { env } from "../lib/env.js";
import { publish } from "../lib/bus.js";
import { audit } from "../lib/audit.js";
import { addEvent, setStatus } from "../services/incidents.js";
import { verifyPatch } from "../services/patches.js";
import { heuristicInvestigate } from "./heuristic.js";
import { claudeInvestigate, claudeConfigured } from "./claude.js";
import type { RunContext } from "./tools.js";

export const agentMode = () => (env.AGENT_MODE === "heuristic" ? "heuristic" : env.AGENT_MODE === "claude" || claudeConfigured() ? "claude" : "heuristic");

/** Runs one investigation end-to-end and persists every step, hypothesis and verified fix. */
export async function investigate(incidentId: number, trigger = "auto") {
  const incident = await one("SELECT * FROM incidents WHERE id = $1", [incidentId]);
  if (!incident) throw new Error(`incident ${incidentId} not found`);
  let mode = agentMode();
  const inv = await one("INSERT INTO investigations (incident_id, status, mode, model, started_at) VALUES ($1,'running',$2,$3,now()) RETURNING *", [incidentId, mode, mode === "claude" ? env.ANTHROPIC_MODEL : null]);
  const publishStatus = (status: string) => publish({ type: "investigation.status", incidentId, investigationId: inv.id, status });
  await publishStatus("running");
  if (incident.status === "detected") await setStatus(incidentId, "investigating", "rootline-agent", `Investigation started (${mode}, trigger: ${trigger})`);
  else await addEvent(incidentId, "agent", `Investigation started (${mode})`, `Trigger: ${trigger}`, "rootline-agent");

  let seq = 0;
  const record = async (s: { kind: string; tool?: string; input?: unknown; output?: unknown; durationMs?: number }) => {
    const step = await one("INSERT INTO investigation_steps (investigation_id, seq, kind, tool, input, output, duration_ms) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *",
      [inv.id, ++seq, s.kind, s.tool ?? null, s.input === undefined ? null : JSON.stringify(s.input), s.output === undefined ? null : JSON.stringify(s.output), s.durationMs ?? null]);
    await publish({ type: "investigation.step", incidentId, investigationId: inv.id, step: { ...step, output: summariseForBus(step.output) } });
  };
  const ctx: RunContext = { incident, retrieved: new Map(), deploysSeen: new Map(), hypotheses: [], fixes: [] };
  const usage = { input: 0, output: 0 };

  try {
    if (mode === "claude") {
      try { await claudeInvestigate(ctx, record, usage); }
      catch (e) {
        // Robustness: an LLM outage must never leave responders without an analysis
        const reason = e instanceof Anthropic.AuthenticationError ? "authentication failed" : e instanceof Anthropic.RateLimitError ? "rate limited" : e instanceof Anthropic.APIError ? `API error ${e.status}` : (e as Error).message;
        await record({ kind: "error", output: { error: `Claude unavailable (${reason}); continuing with the heuristic investigator.` } });
        mode = "heuristic";
        await q("UPDATE investigations SET mode = 'claude+heuristic' WHERE id = $1", [inv.id]);
        if (!ctx.hypotheses.length) await heuristicInvestigate(ctx, record);
      }
    } else await heuristicInvestigate(ctx, record);

    // Persist hypotheses ranked by confidence
    const ranked = ctx.hypotheses.map((h, i) => ({ h, i })).sort((a, b) => b.h.confidence - a.h.confidence);
    const idMap = new Map<number, number>();
    await q("UPDATE hypotheses SET status = 'rejected' WHERE incident_id = $1 AND status = 'proposed'", [incidentId]); // superseded by this run
    for (const [rank, { h, i }] of ranked.entries()) {
      const citations = h.citations.map((c) => { const chunk = ctx.retrieved.get(c.chunkId)!; return { chunkId: c.chunkId, documentId: chunk.documentId, title: chunk.title, heading: chunk.heading, kind: chunk.kind, quote: c.quote }; });
      const row = await one(`INSERT INTO hypotheses (incident_id, investigation_id, rank, title, description, category, confidence, suspect_deploy_id, evidence, citations) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [incidentId, inv.id, rank + 1, h.title, h.description, h.category, h.confidence, h.suspectDeployId ?? null, JSON.stringify(h.evidence), JSON.stringify(citations)]);
      idMap.set(i, row.id);
    }
    const top = ranked[0]?.h;
    if (top) {
      await q("UPDATE incidents SET root_cause = $2, confidence = $3, updated_at = now() WHERE id = $1", [incidentId, top.title, top.confidence]);
      await addEvent(incidentId, "hypothesis", `Top hypothesis (${Math.round(top.confidence * 100)}%): ${top.title}`, top.description, "rootline-agent", { confidence: top.confidence });
      if (top.confidence >= 0.6) await setStatus(incidentId, "identified", "rootline-agent", "Root cause identified with high confidence. Awaiting human confirmation.");
    }
    await publish({ type: "hypotheses.updated", incidentId });

    // Verify and store fix proposals (never auto-applied)
    for (const f of ctx.fixes) {
      // identical patch already awaiting approval (e.g. from an earlier run) → keep that one
      if (await one("SELECT 1 FROM fix_proposals WHERE incident_id = $1 AND patch = $2 AND status IN ('pending_approval','approved','pr_opened')", [incidentId, f.patch])) continue;
      await q("UPDATE fix_proposals SET status = 'rejected', decision_note = 'Superseded by a newer investigation' WHERE incident_id = $1 AND status = 'pending_approval'", [incidentId]);
      const verification = await verifyPatch(f.service, f.patch, f.testPatch);
      const fix = await one(`INSERT INTO fix_proposals (incident_id, hypothesis_id, service, title, description, strategy, patch, test_patch, verification, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [incidentId, idMap.get(f.hypothesisIndex) ?? null, f.service, f.title, f.description, f.strategy, f.patch, f.testPatch, JSON.stringify(verification), verification.passed ? "pending_approval" : "failed"]);
      await addEvent(incidentId, "fix", verification.passed ? `Fix proposed and verified: ${f.title}` : `Fix proposed but failed verification: ${f.title}`,
        verification.checks.map((c) => `${c.status === "pass" ? "✓" : c.status === "fail" ? "✗" : "–"} ${c.name}`).join("\n"), "rootline-agent", { fixId: fix.id, passed: verification.passed });
    }
    if (ctx.fixes.length) await publish({ type: "fix.updated", incidentId });

    const summary = ctx.summary ?? (top ? `Most likely cause: ${top.title}` : "Investigation finished without a conclusive root cause.");
    await record({ kind: "conclusion", output: { text: summary } });
    await q("UPDATE investigations SET status = 'completed', finished_at = now(), summary = $2, input_tokens = $3, output_tokens = $4 WHERE id = $1", [inv.id, summary, usage.input, usage.output]);
    await addEvent(incidentId, "agent", "Investigation completed", summary, "rootline-agent", { investigationId: inv.id, steps: seq });
    await audit("rootline-agent", "investigation.completed", `incident:${incidentId}`, { investigationId: inv.id, mode, hypotheses: ctx.hypotheses.length, fixes: ctx.fixes.length });
    await publishStatus("completed");
  } catch (e) {
    const msg = (e as Error).message;
    await record({ kind: "error", output: { error: msg } }).catch(() => {});
    await q("UPDATE investigations SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1", [inv.id, msg.slice(0, 1000)]);
    await addEvent(incidentId, "agent", "Investigation failed", msg, "rootline-agent");
    await publishStatus("failed");
    throw e;
  }
  return inv.id;
}

/** Keep bus payloads small; clients fetch full step output on demand. */
function summariseForBus(output: unknown) {
  const s = JSON.stringify(output ?? null);
  return s.length > 6000 ? { truncated: true, preview: s.slice(0, 1500) } : output;
}
