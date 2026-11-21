"use client";
import { use, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Activity, GitCommitHorizontal, AlertOctagon, ScrollText } from "lucide-react";
import { useApi } from "@/lib/api";
import { useLiveEvents } from "@/components/shell";
import { Card, CardHeader, PageHeader, Badge, Skeleton, ErrorBox, Tabs, Empty } from "@/components/ui";
import { SeverityBadge, StatusBadge } from "@/components/domain";
import { TimeSeries, pivot } from "@/components/charts";
import { ago, pct, ms, short } from "@/lib/format";

const METRICS = [
  { key: "error_rate", label: "Error rate", fmt: (v: number) => pct(v, 1), color: "#f87171" },
  { key: "latency_p95_ms", label: "p95 latency", fmt: ms, color: "#818cf8" },
  { key: "rps", label: "Throughput (rps)", fmt: (v: number) => String(Math.round(v)), color: "#34d399" },
  { key: "saturation", label: "Saturation", fmt: (v: number) => pct(v, 0), color: "#fbbf24" },
  { key: "memory_mb", label: "Memory (MB)", fmt: (v: number) => String(Math.round(v)), color: "#38bdf8" },
  { key: "cpu", label: "CPU %", fmt: (v: number) => `${Math.round(v)}%`, color: "#c084fc" },
];

export default function ServicePage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = use(params);
  const [minutes, setMinutes] = useState("180");
  const d = useApi<any>(`/api/services/${name}?minutes=${minutes}`, { refreshMs: 20_000 }); // eslint-disable-line @typescript-eslint/no-explicit-any
  useLiveEvents((e) => { if (e.type === "deploy" || e.type.startsWith("incident")) d.reload(); });
  if (d.error) return <ErrorBox message={d.error} onRetry={d.reload} />;
  if (!d.data) return <Skeleton className="h-96" />;
  const { service: s, metrics, deploys, incidents, topErrors, dependents } = d.data;
  const markers = deploys.filter((x: { deployed_at: string }) => Date.now() - new Date(x.deployed_at).getTime() < Number(minutes) * 60_000).map((x: { deployed_at: string; sha: string; kind: string }) => ({ ts: x.deployed_at, label: short(x.sha), tone: x.kind === "rollback" ? "fix" as const : "deploy" as const }));
  return (
    <>
      <Link href="/services" className="mb-3 inline-flex items-center gap-1.5 text-xs text-muted hover:text-fg"><ArrowLeft className="h-3.5 w-3.5" />Services</Link>
      <PageHeader eyebrow={`Tier ${s.tier} · ${s.owner_team}`} title={s.display_name} subtitle={<span className="mono">{s.name}{s.repo ? ` · ${s.repo}` : ""}</span>}
        actions={<Tabs value={minutes} onChange={setMinutes} options={[{ value: "60", label: "1h" }, { value: "180", label: "3h" }, { value: "720", label: "12h" }, { value: "1440", label: "24h" }]} />} />
      <div className="mb-6 flex flex-wrap gap-2 text-xs"><span className="text-muted">Depends on</span>{s.depends_on.length ? s.depends_on.map((x: string) => <Link key={x} href={`/services/${x}`}><Badge className="mono">{x}</Badge></Link>) : <span className="text-subtle">nothing</span>}<span className="ml-3 text-muted">Used by</span>{dependents.length ? dependents.map((x: string) => <Link key={x} href={`/services/${x}`}><Badge className="mono">{x}</Badge></Link>) : <span className="text-subtle">no one</span>}</div>
      <div className="grid gap-4 lg:grid-cols-2">
        {METRICS.map((m) => { const rows = metrics.filter((r: { name: string }) => r.name === m.key); return (
          <Card key={m.key} className="card-pad"><CardHeader title={m.label} icon={Activity} />
            {rows.length ? <TimeSeries data={pivot(rows, "name")} series={[{ key: m.key, label: m.label, color: m.color }]} format={m.fmt} markers={markers} height={190} /> : <Empty title="No data" />}
          </Card>); })}
      </div>
      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <Card className="card-pad"><CardHeader title="Deploys" icon={GitCommitHorizontal} />
          <ul className="space-y-3">{deploys.map((x: any) => ( // eslint-disable-line @typescript-eslint/no-explicit-any
            <li key={x.id} className="text-sm"><p className="truncate">{x.message}</p><p className="text-xs text-muted"><span className="mono text-accent">{short(x.sha)}</span> · {x.author} · {ago(x.deployed_at)} {x.kind !== "code" && <Badge tone={x.kind === "rollback" ? "ok" : "warn"}>{x.kind}</Badge>}</p></li>))}</ul>
        </Card>
        <Card className="card-pad"><CardHeader title="Incidents" icon={AlertOctagon} />
          {incidents.length ? <ul className="space-y-2.5">{incidents.map((i: any) => <li key={i.id}><Link href={`/incidents/${i.id}`} className="block rounded-lg p-2 hover:bg-raised"><div className="flex items-center gap-2"><SeverityBadge s={i.severity} /><StatusBadge s={i.status} /><span className="ml-auto text-xs text-subtle">{ago(i.detected_at)}</span></div><p className="mt-1 text-sm">{i.title}</p></Link></li>)}</ul> : <Empty title="No incidents" />} {/* eslint-disable-line @typescript-eslint/no-explicit-any */}
        </Card>
        <Card className="card-pad"><CardHeader title="Top warnings & errors (1h)" icon={ScrollText} action={<Link href={`/logs?service=${s.name}`} className="text-xs text-accent hover:underline">Logs</Link>} />
          {topErrors.length ? <ul className="space-y-2">{topErrors.map((e: any) => <li key={e.fingerprint} className="rounded-lg bg-raised/60 p-2"><div className="flex items-center justify-between text-xs"><Badge tone={e.level === "warn" ? "warn" : "bad"}>{e.level}</Badge><span className="tabular-nums text-muted">{e.n}×</span></div><p className="mt-1 line-clamp-2 text-xs mono">{e.sample}</p></li>)}</ul> : <Empty title="Quiet" />} {/* eslint-disable-line @typescript-eslint/no-explicit-any */}
        </Card>
      </div>
    </>
  );
}
