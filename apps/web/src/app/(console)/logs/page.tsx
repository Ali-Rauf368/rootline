"use client";
import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ScrollText, Pause, Play, Search } from "lucide-react";
import { useApi } from "@/lib/api";
import { useLiveEvents } from "@/components/shell";
import { Card, PageHeader, Badge, Empty, ErrorBox, Skeleton, cx } from "@/components/ui";
import { clock } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";

type Log = { id: number; service: string; ts: string; level: string; message: string; trace_id: string | null };
const LEVEL_TONE: Record<string, "neutral" | "info" | "warn" | "bad"> = { debug: "neutral", info: "info", warn: "warn", error: "bad", fatal: "bad" };

function LogsInner() {
  const sp = useSearchParams();
  const [service, setService] = useState(sp.get("service") ?? "");
  const [level, setLevel] = useState(sp.get("level") ?? "");
  const [q, setQ] = useState("");
  const [paused, setPaused] = useState(false);
  const [tail, setTail] = useState<Log[]>([]);
  const dq = useDebounced(q, 300);
  const services = useApi<{ name: string }[]>("/api/services");
  const qs = new URLSearchParams({ limit: "200", ...(service ? { service } : {}), ...(level ? { level } : {}), ...(dq ? { q: dq } : {}) });
  const logs = useApi<Log[]>(`/api/logs?${qs}`, { refreshMs: paused ? undefined : 10_000 });
  const pausedRef = useRef(paused); pausedRef.current = paused;
  useEffect(() => setTail([]), [service, level, dq]);
  // live tail: errors stream over SSE between refreshes
  useLiveEvents((e) => {
    if (e.type !== "log" || pausedRef.current) return;
    const l = e.log as Log;
    if ((service && l.service !== service) || (dq && !l.message.toLowerCase().includes(dq.toLowerCase()))) return;
    setTail((t) => [l, ...t].slice(0, 100));
  }, [service, dq]);
  const rows = [...tail.filter((t) => !(logs.data ?? []).some((l) => l.id === t.id)), ...(logs.data ?? [])];
  return (
    <>
      <PageHeader title="Logs" subtitle="Last 24 hours · errors stream in live" actions={<button className="btn-secondary" onClick={() => setPaused((p) => !p)}>{paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}{paused ? "Resume" : "Pause"} tail</button>} />
      <Card className="mb-4 grid gap-3 p-3 md:grid-cols-[180px_160px_1fr]">
        <select className="input" value={service} onChange={(e) => setService(e.target.value)} aria-label="Service"><option value="">All services</option>{(services.data ?? []).map((s) => <option key={s.name}>{s.name}</option>)}</select>
        <select className="input" value={level} onChange={(e) => setLevel(e.target.value)} aria-label="Level"><option value="">All levels</option><option value="warn">Warn and above</option><option value="error">Errors only</option><option value="info">Info</option></select>
        <label className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" /><input className="input pl-9" placeholder="Full-text search (e.g. timeout pool)" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search logs" /></label>
      </Card>
      {logs.error ? <ErrorBox message={logs.error} onRetry={logs.reload} /> : !logs.data ? <Skeleton className="h-[60vh]" /> : !rows.length ? <Card><Empty icon={ScrollText} title="No log lines match" /></Card> : (
        <Card className="overflow-hidden">
          <div className="max-h-[70vh] overflow-auto">
            <table className="w-full text-[12.5px] mono">
              <tbody>{rows.map((l) => (
                <tr key={l.id} className={cx("border-b border-line/50 align-top hover:bg-raised/60", (l.level === "error" || l.level === "fatal") && "bg-bad/[0.04]")}>
                  <td className="whitespace-nowrap px-3 py-1.5 text-subtle">{clock(l.ts)}</td>
                  <td className="px-2 py-1.5"><Badge tone={LEVEL_TONE[l.level]}>{l.level}</Badge></td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-accent">{l.service}</td>
                  <td className="break-all px-3 py-1.5">{l.message}</td>
                </tr>))}</tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
export default function LogsPage() { return <Suspense fallback={<Skeleton className="h-96" />}><LogsInner /></Suspense>; }
