"use client";
import Link from "next/link";
import { useMemo } from "react";
import { Boxes, Network } from "lucide-react";
import { useApi } from "@/lib/api";
import { useLiveEvents } from "@/components/shell";
import { Card, CardHeader, PageHeader, Badge, Skeleton, ErrorBox, cx } from "@/components/ui";
import { health } from "@/components/domain";
import { pct, ms, num } from "@/lib/format";

type Svc = { name: string; display_name: string; tier: number; owner_team: string; depends_on: string[]; slo_availability: number; slo_latency_ms: number; error_rate: number | null; latency_p95_ms: number | null; rps: number | null; open_incidents: number };

/** Layered dependency graph: callers on the left, dependencies to the right; edges and nodes coloured by health. */
function DependencyMap({ services }: { services: Svc[] }) {
  const layout = useMemo(() => {
    const byName = new Map(services.map((s) => [s.name, s]));
    const depth = new Map<string, number>();
    const visit = (n: string, d: number, seen = new Set<string>()) => {
      if (seen.has(n)) return; seen.add(n);
      depth.set(n, Math.max(depth.get(n) ?? 0, d));
      for (const c of byName.get(n)?.depends_on ?? []) visit(c, d + 1, new Set(seen));
    };
    const roots = services.filter((s) => !services.some((o) => o.depends_on.includes(s.name)));
    roots.forEach((r) => visit(r.name, 0));
    services.forEach((s) => !depth.has(s.name) && depth.set(s.name, 0));
    const cols = new Map<number, string[]>();
    for (const [n, d] of depth) cols.set(d, [...(cols.get(d) ?? []), n]);
    const W = 210, H = 74, gapX = 70, gapY = 18;
    const pos = new Map<string, { x: number; y: number }>();
    const maxRows = Math.max(...[...cols.values()].map((c) => c.length));
    for (const [d, names] of cols) names.sort().forEach((n, i) => pos.set(n, { x: d * (W + gapX), y: i * (H + gapY) + ((maxRows - names.length) * (H + gapY)) / 2 }));
    return { pos, W, H, width: (Math.max(...cols.keys()) + 1) * (W + gapX) - gapX, height: maxRows * (H + gapY) - gapY, byName };
  }, [services]);

  return (
    <div className="overflow-x-auto pb-2">
      <svg width={layout.width + 4} height={layout.height + 4} className="mx-auto block" role="img" aria-label="Service dependency map">
        {services.flatMap((s) => s.depends_on.filter((d) => layout.pos.has(d)).map((d) => {
          const a = layout.pos.get(s.name)!, b = layout.pos.get(d)!;
          const bad = health(layout.byName.get(d)!).tone === "bad";
          const x1 = a.x + layout.W, y1 = a.y + layout.H / 2, x2 = b.x, y2 = b.y + layout.H / 2;
          return <path key={`${s.name}-${d}`} d={`M${x1},${y1} C${x1 + 35},${y1} ${x2 - 35},${y2} ${x2},${y2}`} fill="none" strokeWidth={bad ? 2.2 : 1.4} stroke={bad ? "rgb(var(--bad))" : "rgb(var(--line))"} strokeDasharray={bad ? "5 4" : undefined} className={bad ? "animate-pulse" : undefined} />;
        }))}
        {services.map((s) => {
          const p = layout.pos.get(s.name)!; const h = health(s);
          const stroke = h.tone === "bad" ? "rgb(var(--bad))" : h.tone === "warn" ? "rgb(var(--warn))" : "rgb(var(--line))";
          return (
            <a key={s.name} href={`/services/${s.name}`}>
              <g transform={`translate(${p.x + 2},${p.y + 2})`} className="cursor-pointer">
                <rect width={layout.W} height={layout.H} rx={12} fill="rgb(var(--panel))" stroke={stroke} strokeWidth={h.tone === "ok" ? 1 : 2} />
                <circle cx={16} cy={20} r={4.5} fill={h.tone === "bad" ? "rgb(var(--bad))" : h.tone === "warn" ? "rgb(var(--warn))" : "rgb(var(--ok))"} />
                <text x={28} y={24} fontSize={12.5} fontWeight={600} fill="rgb(var(--fg))">{s.display_name.length > 22 ? s.display_name.slice(0, 21) + "…" : s.display_name}</text>
                <text x={14} y={44} fontSize={11} fill="rgb(var(--muted))">err {pct(s.error_rate, 2)} · p95 {ms(s.latency_p95_ms)}</text>
                <text x={14} y={61} fontSize={10.5} fill="rgb(var(--subtle))">tier {s.tier} · {s.owner_team}</text>
              </g>
            </a>
          );
        })}
      </svg>
    </div>
  );
}

export default function ServicesPage() {
  const o = useApi<{ services: Svc[] }>("/api/overview", { refreshMs: 15_000 });
  useLiveEvents((e) => { if (e.type === "metrics.tick" || e.type.startsWith("incident")) o.reload(); });
  if (o.error) return <ErrorBox message={o.error} onRetry={o.reload} />;
  const services = o.data?.services ?? [];
  return (
    <>
      <PageHeader title="Services" subtitle="Live dependency map and SLO posture. Red edges show where failures propagate." />
      <Card className="card-pad mb-6"><CardHeader title="Dependency map" subtitle="Callers → dependencies" icon={Network} />{o.data ? <DependencyMap services={services} /> : <Skeleton className="h-72" />}</Card>
      <Card className="overflow-hidden">
        <div className="border-b border-line px-5 py-3"><CardHeader title="Service catalog" icon={Boxes} /></div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="border-b border-line text-left text-xs text-subtle"><tr><th className="px-5 py-2.5 font-medium">Service</th><th className="px-3 font-medium">Health</th><th className="px-3 text-right font-medium">Error rate</th><th className="px-3 text-right font-medium">p95 / SLO</th><th className="px-3 text-right font-medium">RPS</th><th className="px-5 font-medium">Depends on</th></tr></thead>
            <tbody>{services.map((s) => { const h = health(s); return (
              <tr key={s.name} className="table-row">
                <td className="px-5 py-3"><Link href={`/services/${s.name}`} className="font-medium hover:text-accent">{s.display_name}</Link><p className="text-xs text-subtle mono">{s.name} · tier {s.tier} · {s.owner_team}</p></td>
                <td className="px-3"><Badge tone={h.tone} dot>{h.label}</Badge></td>
                <td className={cx("px-3 text-right tabular-nums", h.tone === "bad" && "text-bad")}>{pct(s.error_rate, 2)}</td>
                <td className="px-3 text-right tabular-nums">{ms(s.latency_p95_ms)} <span className="text-subtle">/ {ms(s.slo_latency_ms)}</span></td>
                <td className="px-3 text-right tabular-nums">{num(s.rps)}</td>
                <td className="px-5"><div className="flex flex-wrap gap-1">{s.depends_on.map((d) => <Badge key={d} className="mono">{d}</Badge>)}</div></td>
              </tr>); })}</tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
