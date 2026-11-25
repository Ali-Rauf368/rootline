"use client";
import Link from "next/link";
import { AlertOctagon, Timer, Crosshair, Wrench, GitCommitHorizontal, BrainCircuit, CheckCircle2, ArrowRight, GitPullRequestDraft, Activity } from "lucide-react";
import { useApi } from "@/lib/api";
import { useLiveEvents, useSession } from "@/components/shell";
import { Card, CardHeader, Stat, Badge, Empty, ErrorBox, Skeleton, ConfidenceBar, cx } from "@/components/ui";
import { SeverityBadge, StatusBadge, health } from "@/components/domain";
import { TimeSeries, Sparkline, Bars, pivot, SERIES_COLORS } from "@/components/charts";
import { ago, minutes, pct, ms, num, short, duration } from "@/lib/format";

interface Overview {
  kpi: { open_incidents: number; open_major: number; incidents_30d: number; mttd_min: number | null; mttr_min: number | null; mtti_min: number | null; deploys_7d: number; change_failure_rate: number; agent_precision: number | null; fix_approval_rate: number | null; investigations: number };
  services: { name: string; display_name: string; tier: number; owner_team: string; slo_availability: number; slo_latency_ms: number; error_rate: number | null; latency_p95_ms: number | null; rps: number | null; availability_30d: number | null; open_incidents: number; spark: { t: string; e: number; l: number }[] | null }[];
  incidents: { id: number; key: string; title: string; severity: "sev1"; status: "detected"; services: string[]; started_at: string; confidence: number | null; root_cause: string | null }[];
  deploys: { id: number; service: string; sha: string; author: string; message: string; kind: string; deployed_at: string }[];
  errorSeries: { service: string; ts: string; value: number }[];
  weekly: { day: string; incidents: number; deploys: number }[];
}

const greeting = () => { const h = new Date().getHours(); return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"; };

export default function OverviewPage() {
  const { data: o, error, reload } = useApi<Overview>("/api/overview", { refreshMs: 20_000 });
  const user = useSession();
  useLiveEvents((e) => { if (["incident.created", "incident.updated", "hypotheses.updated", "fix.updated", "metrics.tick", "deploy"].includes(e.type)) reload(); });

  if (error && !o) return <ErrorBox message={error} onRetry={reload} />;
  if (!o) return <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-28" />)}<Skeleton className="h-80 sm:col-span-2 lg:col-span-6" /></div>;

  const k = o.kpi;
  const major = o.incidents.filter((i) => i.severity === "sev1" || i.severity === "sev2");
  const svcNames = [...new Set(o.errorSeries.map((r) => r.service))];
  const errData = pivot(o.errorSeries, "service");

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-sm text-muted">{greeting()}, {user?.name.split(" ")[0]}</p>
          <h1 className="text-2xl font-semibold tracking-tight">Production overview</h1>
        </div>
        <div className={cx("flex items-center gap-3 rounded-xl border px-4 py-2.5 text-sm", k.open_incidents ? "border-bad/30 bg-bad/10" : "border-ok/30 bg-ok/10")}>
          {k.open_incidents ? <AlertOctagon className="h-4 w-4 text-bad" /> : <CheckCircle2 className="h-4 w-4 text-ok" />}
          <span className="font-medium">{k.open_incidents ? `${k.open_incidents} open incident${k.open_incidents > 1 ? "s" : ""}${k.open_major ? ` · ${k.open_major} major` : ""}` : "All systems operational"}</span>
          {k.open_incidents > 0 && <Link href="/incidents?status=open" className="text-xs font-medium text-accent hover:underline">Respond →</Link>}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Open incidents" value={k.open_incidents} hint={`${k.incidents_30d} in 30 days`} icon={AlertOctagon} tone={k.open_incidents ? "bad" : "ok"} />
        <Stat label="MTTD" value={minutes(k.mttd_min)} hint="onset → detection" icon={Activity} tone="info" />
        <Stat label="MTTI" value={minutes(k.mtti_min)} hint="onset → root cause" icon={Crosshair} tone="accent" />
        <Stat label="MTTR" value={minutes(k.mttr_min)} hint="onset → resolved" icon={Timer} tone="warn" />
        <Stat label="Change failure rate" value={`${k.change_failure_rate}%`} hint={`${k.deploys_7d} deploys / 7d`} icon={GitCommitHorizontal} tone={k.change_failure_rate > 15 ? "bad" : "ok"} />
        <Stat label="Agent precision" value={k.agent_precision == null ? "—" : `${k.agent_precision}%`} hint={k.fix_approval_rate == null ? `${k.investigations} investigations` : `${k.fix_approval_rate}% fixes approved`} icon={BrainCircuit} tone="accent" />
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="card-pad xl:col-span-2">
          <CardHeader title="Active incidents" subtitle="Sorted by severity · updates live" icon={AlertOctagon} action={<Link href="/incidents" className="text-xs font-medium text-accent hover:underline">All incidents</Link>} />
          {o.incidents.length ? (
            <div className="space-y-2.5">
              {o.incidents.map((i) => (
                <Link key={i.id} href={`/incidents/${i.id}`} className="group block rounded-xl border border-line bg-bg/40 p-3.5 transition hover:border-accent/40 hover:shadow-glow">
                  <div className="flex flex-wrap items-center gap-2">
                    <SeverityBadge s={i.severity} /><StatusBadge s={i.status} />
                    <span className="text-xs text-subtle mono">{i.key}</span>
                    <span className="ml-auto text-xs text-muted">open {duration(i.started_at)}</span>
                  </div>
                  <p className="mt-2 font-medium group-hover:text-accent">{i.title}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">{i.services.map((s) => <Badge key={s} className="mono">{s}</Badge>)}</div>
                  {i.root_cause && (
                    <div className="mt-3 rounded-lg bg-raised/70 p-2.5">
                      <p className="mb-1.5 flex items-center gap-1.5 text-xs text-muted"><BrainCircuit className="h-3.5 w-3.5 text-accent" />Likely root cause</p>
                      <p className="text-sm">{i.root_cause}</p>
                      {i.confidence != null && <ConfidenceBar value={Number(i.confidence)} className="mt-2" />}
                    </div>
                  )}
                </Link>
              ))}
            </div>
          ) : <Empty icon={CheckCircle2} title="No active incidents" message="OpsMeridian is watching logs, metrics and deploys. Use Simulate in the top bar to run a game day." />}
        </Card>

        <Card className="card-pad">
          <CardHeader title="Incidents vs. deploys" subtitle="Last 14 days" icon={GitPullRequestDraft} />
          <Bars data={o.weekly.map((w) => ({ label: new Date(w.day).toLocaleDateString(undefined, { day: "numeric", month: "short" }), deploys: w.deploys, incidents: w.incidents }))}
            keys={[{ key: "deploys", label: "Deploys", color: "#818cf8" }, { key: "incidents", label: "Incidents", color: "#f87171" }]} height={210} />
          <div className="mt-4 grid grid-cols-2 gap-2 text-center">
            <div className="rounded-lg bg-raised/70 p-2"><p className="text-xs text-muted">Major open</p><p className="text-lg font-semibold tabular-nums">{major.length}</p></div>
            <div className="rounded-lg bg-raised/70 p-2"><p className="text-xs text-muted">Investigations</p><p className="text-lg font-semibold tabular-nums">{k.investigations}</p></div>
          </div>
        </Card>
      </div>

      <Card className="card-pad">
        <CardHeader title="Service health" subtitle="Current error rate & p95 latency against SLO · 2h trend" icon={Activity} action={<Link href="/services" className="text-xs font-medium text-accent hover:underline">Dependency map</Link>} />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
          {o.services.map((s) => {
            const h = health(s);
            const spark = (s.spark ?? []).map((p) => Number(p.l));
            return (
              <Link key={s.name} href={`/services/${s.name}`} className={cx("rounded-xl border p-3.5 transition hover:shadow-glow", h.tone === "bad" ? "border-bad/40 bg-bad/5" : h.tone === "warn" ? "border-warn/40 bg-warn/5" : "border-line bg-bg/40 hover:border-accent/40")}>
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0"><p className="truncate text-sm font-medium">{s.display_name}</p><p className="text-[11px] text-subtle">Tier {s.tier} · {s.owner_team}</p></div>
                  <Badge tone={h.tone} dot>{h.label}</Badge>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-1 text-xs">
                  <div><p className="text-subtle">Errors</p><p className={cx("font-semibold tabular-nums", h.tone === "bad" && "text-bad")}>{pct(s.error_rate, 2)}</p></div>
                  <div><p className="text-subtle">p95</p><p className="font-semibold tabular-nums">{ms(s.latency_p95_ms)}</p></div>
                  <div><p className="text-subtle">RPS</p><p className="font-semibold tabular-nums">{num(s.rps)}</p></div>
                </div>
                <div className="mt-2"><Sparkline values={spark} color={h.tone === "bad" ? "#f87171" : h.tone === "warn" ? "#fbbf24" : "#818cf8"} /></div>
                <p className="mt-1 text-[11px] text-subtle">30d availability {s.availability_30d == null ? "—" : `${(Number(s.availability_30d) * 100).toFixed(3)}%`} · SLO {s.slo_availability}%</p>
              </Link>
            );
          })}
        </div>
      </Card>

      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="card-pad xl:col-span-2">
          <CardHeader title="Error rate by service" subtitle="Last 3 hours · deploys marked" icon={Activity} />
          <TimeSeries data={errData} series={svcNames.map((s, i) => ({ key: s, label: s, color: SERIES_COLORS[i % SERIES_COLORS.length] }))} format={(v) => `${(v * 100).toFixed(1)}%`} area={false} height={280}
            markers={o.deploys.filter((d) => Date.now() - new Date(d.deployed_at).getTime() < 3 * 3600_000).slice(0, 4).map((d) => ({ ts: d.deployed_at, label: `${d.service}@${short(d.sha)}` }))} />
        </Card>
        <Card className="card-pad">
          <CardHeader title="Recent changes" icon={GitCommitHorizontal} action={<Link href="/changes" className="text-xs font-medium text-accent hover:underline">All</Link>} />
          <ul className="space-y-3">
            {o.deploys.map((d) => (
              <li key={d.id} className="flex gap-3">
                <div className="mt-1 h-2 w-2 shrink-0 rounded-full bg-accent" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{d.message}</p>
                  <p className="text-xs text-muted"><span className="mono text-accent">{d.service}@{short(d.sha)}</span> · {d.author} · {ago(d.deployed_at)}</p>
                </div>
                {d.kind !== "code" && <Badge tone={d.kind === "rollback" ? "ok" : "warn"}>{d.kind}</Badge>}
              </li>
            ))}
          </ul>
          <Link href="/changes" className="mt-4 flex items-center gap-1 text-xs font-medium text-accent hover:underline">Change history <ArrowRight className="h-3 w-3" /></Link>
        </Card>
      </div>
      <p className="flex items-center gap-1.5 text-xs text-subtle"><Wrench className="h-3 w-3" />Fixes are never applied automatically. Every proposed patch is verified, then waits for a responder's approval.</p>
    </div>
  );
}
