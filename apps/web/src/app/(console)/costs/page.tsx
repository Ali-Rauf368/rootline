"use client";
import { useState } from "react";
import { CircleDollarSign, TrendingDown, GitPullRequest, TrendingUp, FileDiff, Search } from "lucide-react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api, useApi } from "@/lib/api";
import { can, useLiveEvents, useSession } from "@/components/shell";
import { Badge, Card, CardHeader, Empty, ErrorBox, Modal, PageHeader, Skeleton, Stat, Tabs, useToast, type Tone } from "@/components/ui";
import { DiffView } from "@/components/diff";
import { ago } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";

type Status = "open" | "pr_opened" | "intentional" | "resolved";
type Rule = "spike" | "idle" | "overprovisioned" | "unattached";
interface Finding {
  id: number; rule: Rule; provider: string; resource_id: string; service: string; team: string; env: string; monthly_cost: number; max_savings: number;
  status: Status; root_cause: string | null; risk_level: "LOW" | "MEDIUM" | "HIGH" | null; remediation_snippet: string | null;
  estimated_monthly_savings: number | null; analysis_source: "gemini" | "rules" | null; approvals: number[]; decision_note: string | null; evidence: Record<string, unknown>;
}
interface Summary {
  spend30d: number; asOf: string | null; wasteMonthly: number; approvedMonthly: number; openFindings: number; spikes: number; analysis: "gemini" | "rules";
  trend: { date: string; cost: number }[]; services: { service: string; cost: number }[];
  lastBatch: { source: string; status: string; accepted: number; rejected: number; error: string | null; created_at: string } | null;
}
const usd = (v: number | null | undefined) => (v == null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: v < 100 ? 2 : 0 }).format(v));
const RULES: Record<Rule, { label: string; tone: Tone }> = { spike: { label: "Cost spike", tone: "bad" }, idle: { label: "Idle", tone: "warn" }, overprovisioned: { label: "Over-provisioned", tone: "info" }, unattached: { label: "Unattached", tone: "accent" } };
const RISK: Record<string, Tone> = { LOW: "ok", MEDIUM: "warn", HIGH: "bad" };

export default function CostsPage() {
  const user = useSession(), toast = useToast();
  const [status, setStatus] = useState<Status>("open");
  const [rule, setRule] = useState("");
  const [text, setText] = useState("");
  const search = useDebounced(text);
  const [fix, setFix] = useState<Finding | null>(null);
  const [exclude, setExclude] = useState<Finding | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const summary = useApi<Summary>("/api/costs/summary");
  const list = useApi<Finding[]>(`/api/costs/findings?${new URLSearchParams({ status, ...(rule && { rule }), ...(search && { search }) })}`);
  const reload = () => { summary.reload(); list.reload(); };
  useLiveEvents((e) => { if (e.type === "cost.updated") reload(); });

  const decide = async (f: Finding, action: "approve" | "intentional", json: object = {}) => {
    setBusy(true);
    try {
      const r = await api<{ status: string }>(`/api/costs/findings/${f.id}/${action}`, { method: "POST", json });
      toast(action === "intentional" ? `${f.resource_id} will be ignored on future runs` : r.status === "awaiting_second_approval" ? "First approval recorded. A different responder must also approve." : "Simulated PR created");
      setFix(null); setExclude(null); reload();
    } catch (e) { toast((e as Error).message, "bad"); }
    finally { setBusy(false); }
  };
  const s = summary.data, max = Math.max(1, ...(s?.services ?? []).map((x) => x.cost));
  const decidable = (f: Finding) => can(user, "responder") && f.status === "open";

  return (
    <>
      <PageHeader title="Cloud costs" subtitle={s ? <>Data through {s.asOf ?? "—"} · analysis by {s.analysis === "gemini" ? "Gemini" : "built-in rules"}{s.lastBatch && <> · last batch {ago(s.lastBatch.created_at)} via {s.lastBatch.source}: {s.lastBatch.accepted} rows, {s.lastBatch.rejected} rejected ({s.lastBatch.status})</>}</> : "Spend, waste and approved savings"} />
      {summary.error && <div className="mb-4"><ErrorBox message={summary.error} onRetry={summary.reload} /></div>}
      {!s ? !summary.error && <Skeleton className="mb-6 h-28" /> : (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Total spend" value={usd(s.spend30d)} hint="last 30 days" icon={CircleDollarSign} />
            <Stat label="Detected waste" value={usd(s.wasteMonthly)} hint="per month, excluding spikes" icon={TrendingDown} tone="warn" />
            <Stat label="Approved savings" value={usd(s.approvedMonthly)} hint="estimated per month" icon={GitPullRequest} tone="ok" />
            <Stat label="Open findings" value={s.openFindings} hint={`${s.spikes} cost spike${s.spikes === 1 ? "" : "s"}`} icon={TrendingUp} tone="bad" />
          </div>
          <div className="mb-6 grid gap-3 lg:grid-cols-3">
            <Card className="card-pad lg:col-span-2">
              <CardHeader title="Daily spend" subtitle="All providers, last 30 days" />
              <div className="h-48" role="img" aria-label="Daily spend over the last 30 days">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={s.trend} margin={{ left: 0, right: 8, top: 4, bottom: 0 }}>
                    <CartesianGrid stroke="rgb(var(--line))" vertical={false} />
                    <XAxis dataKey="date" tickFormatter={(d: string) => d.slice(5)} tick={{ fontSize: 11, fill: "rgb(var(--muted))" }} minTickGap={32} axisLine={false} tickLine={false} />
                    <YAxis tickFormatter={(v: number) => `$${v}`} tick={{ fontSize: 11, fill: "rgb(var(--muted))" }} width={52} axisLine={false} tickLine={false} />
                    <Tooltip formatter={(v) => [usd(Number(v)), "Spend"]} contentStyle={{ background: "rgb(var(--panel))", border: "1px solid rgb(var(--line))", borderRadius: 8, fontSize: 12 }} />
                    <Area dataKey="cost" stroke="rgb(var(--accent))" strokeWidth={2} fill="rgb(var(--accent))" fillOpacity={0.12} isAnimationActive={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </Card>
            <Card className="card-pad">
              <CardHeader title="Spend by service" subtitle="Last 30 days" />
              <ul className="space-y-2.5">{s.services.map((x) => (
                <li key={x.service} className="text-xs"><div className="mb-1 flex justify-between gap-2"><span className="truncate">{x.service}</span><span className="tabular-nums text-muted">{usd(x.cost)}</span></div><div className="h-1.5 rounded-full bg-raised"><div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(1, (x.cost / max) * 100)}%` }} /></div></li>
              ))}</ul>
            </Card>
          </div>
        </>
      )}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Tabs<Status> value={status} onChange={setStatus} options={[{ value: "open", label: "Open" }, { value: "pr_opened", label: "Approved" }, { value: "intentional", label: "Intentional" }, { value: "resolved", label: "Resolved" }]} />
        <select className="input w-44" value={rule} onChange={(e) => setRule(e.target.value)} aria-label="Finding type"><option value="">All types</option>{Object.entries(RULES).map(([k, r]) => <option key={k} value={k}>{r.label}</option>)}</select>
        <label className="relative min-w-0 flex-1 sm:max-w-xs"><Search className="absolute left-3 top-2.5 h-4 w-4 text-subtle" /><input className="input pl-9" value={text} onChange={(e) => setText(e.target.value)} placeholder="Resource, service, team…" aria-label="Search findings" /></label>
      </div>
      {list.error ? <ErrorBox message={list.error} onRetry={list.reload} /> : !list.data ? <Skeleton className="h-64" /> : !list.data.length ? <Card><Empty icon={CircleDollarSign} title="No findings" message="Nothing matches these filters." /></Card> : (
        <Card className="divide-y divide-line">
          {list.data.map((f) => (
            <div key={f.id} className="flex flex-col gap-3 px-4 py-3 lg:flex-row lg:items-center">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5"><span className="mono break-all text-sm font-medium">{f.resource_id}</span><Badge tone={RULES[f.rule].tone}>{RULES[f.rule].label}</Badge>{f.risk_level && <Badge tone={RISK[f.risk_level]}>{f.risk_level.toLowerCase()} risk</Badge>}{f.status === "open" && f.approvals.length > 0 && <Badge>{f.approvals.length} of 2 approvals</Badge>}</div>
                <p className="mt-1 text-sm text-muted">{f.root_cause ?? "Analysis pending…"}</p>
                <p className="mt-1 text-xs text-subtle">{f.provider.toUpperCase()} · {f.service} · {f.env} · {f.team}{f.analysis_source && <> · {f.analysis_source === "gemini" ? "AI analysis" : "rule-based analysis"}</>}{f.decision_note && <> · “{f.decision_note}”</>}</p>
              </div>
              <div className="shrink-0 lg:w-36 lg:text-right"><p className="font-semibold tabular-nums">{usd(f.estimated_monthly_savings ?? f.max_savings)}<span className="text-xs font-normal text-muted">/mo</span></p><p className="text-xs text-muted">{f.rule === "spike" ? "if the spike persists" : `of ${usd(f.monthly_cost)} spend`}</p></div>
              <div className="flex shrink-0 gap-2">
                {f.remediation_snippet && <button className="btn-secondary px-2.5 py-1 text-xs" onClick={() => setFix(f)}><FileDiff className="h-3.5 w-3.5" />Review fix</button>}
                {decidable(f) && <button className="btn-ghost px-2.5 py-1 text-xs" onClick={() => { setReason(""); setExclude(f); }}>Mark intentional</button>}
              </div>
            </div>
          ))}
        </Card>
      )}
      <Modal open={!!fix} onClose={() => setFix(null)} title={fix ? `Proposed fix: ${fix.resource_id}` : ""} wide
        footer={fix && decidable(fix) ? <button className="btn-primary" disabled={busy} onClick={() => decide(fix, "approve")}>Approve &amp; create PR</button> : undefined}>
        {fix && <><p className="mb-3 text-sm text-muted">{fix.root_cause}</p><DiffView diff={fix.remediation_snippet ?? ""} /><p className="mt-3 text-xs text-muted">A suggestion that hasn&apos;t been checked against your Terraform state. Approving records a simulated PR; nothing is run against your cloud account.</p></>}
      </Modal>
      <Modal open={!!exclude} onClose={() => setExclude(null)} title="Mark as intentional" footer={exclude ? <button className="btn-primary" disabled={busy} onClick={() => decide(exclude, "intentional", { reason })}>Ignore in future runs</button> : undefined}>
        <label className="label" htmlFor="reason">Reason (optional)</label>
        <input id="reason" className="input" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this expected?" />
        <p className="mt-3 text-xs text-muted">{exclude?.resource_id} will be excluded from cost detection.</p>
      </Modal>
    </>
  );
}
