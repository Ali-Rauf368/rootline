"use client";
import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AlertOctagon, Search, Plus, GitPullRequestDraft } from "lucide-react";
import { api, useApi } from "@/lib/api";
import { useLiveEvents, useSession, can } from "@/components/shell";
import { Card, PageHeader, Tabs, Empty, ErrorBox, Skeleton, Badge, ConfidenceBar, Modal, Spinner, useToast } from "@/components/ui";
import { SeverityBadge, StatusBadge } from "@/components/domain";
import { ago, duration } from "@/lib/format";

function IncidentsInner() {
  const sp = useSearchParams();
  const [status, setStatus] = useState(sp.get("status") ?? "open");
  const [severity, setSeverity] = useState("");
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const qs = new URLSearchParams({ limit: "100", ...(status !== "all" ? { status } : {}), ...(severity ? { severity } : {}), ...(q ? { q } : {}) });
  const list = useApi<any[]>(`/api/incidents?${qs}`); // eslint-disable-line @typescript-eslint/no-explicit-any
  const user = useSession();
  useLiveEvents((e) => { if (e.type.startsWith("incident") || e.type === "fix.updated") list.reload(); });

  return (
    <>
      <PageHeader title="Incidents" subtitle="Detected automatically from anomalies and alerts, or declared manually"
        actions={can(user, "responder") && <button className="btn-primary" onClick={() => setCreating(true)}><Plus className="h-4 w-4" />Declare incident</button>} />
      <Card className="mb-4 flex flex-col gap-3 p-3 md:flex-row md:items-center">
        <Tabs value={status} onChange={setStatus} options={[{ value: "open", label: "Open" }, { value: "resolved", label: "Resolved" }, { value: "all", label: "All" }]} />
        <select className="input md:w-36" value={severity} onChange={(e) => setSeverity(e.target.value)} aria-label="Severity"><option value="">All severities</option>{["sev1", "sev2", "sev3", "sev4"].map((s) => <option key={s} value={s}>{s.toUpperCase()}</option>)}</select>
        <label className="relative flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" /><input className="input pl-9" placeholder="Search title, key or root cause" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search incidents" /></label>
      </Card>
      {list.error ? <ErrorBox message={list.error} onRetry={list.reload} /> : !list.data ? <Skeleton className="h-96" /> : !list.data.length ? (
        <Card><Empty icon={AlertOctagon} title={status === "open" ? "No open incidents" : "No incidents match"} message="Use Simulate in the top bar to run a failure scenario." /></Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="border-b border-line text-left text-xs text-subtle"><tr><th className="px-4 py-2.5 font-medium">Incident</th><th className="px-3 font-medium">Status</th><th className="px-3 font-medium">Services</th><th className="px-3 font-medium">Likely cause</th><th className="px-3 font-medium">Duration</th><th className="px-4 text-right font-medium">Detected</th></tr></thead>
              <tbody>{list.data.map((i) => (
                <tr key={i.id} className="table-row">
                  <td className="px-4 py-3"><Link href={`/incidents/${i.id}`} className="group flex items-start gap-2.5"><SeverityBadge s={i.severity} /><span><span className="block font-medium group-hover:text-accent">{i.title}</span><span className="text-xs text-subtle mono">{i.key}</span></span></Link></td>
                  <td className="px-3"><div className="flex flex-col items-start gap-1"><StatusBadge s={i.status} />{i.pending_fixes > 0 && <Badge tone="warn"><GitPullRequestDraft className="h-3 w-3" />fix awaiting approval</Badge>}</div></td>
                  <td className="px-3"><div className="flex flex-wrap gap-1">{i.services.map((s: string) => <Badge key={s} className="mono">{s}</Badge>)}</div></td>
                  <td className="max-w-xs px-3">{i.root_cause ? <><p className="line-clamp-2 text-xs">{i.root_cause}</p>{i.confidence != null && <ConfidenceBar value={Number(i.confidence)} className="mt-1 max-w-[160px]" />}</> : <span className="text-xs text-subtle">—</span>}</td>
                  <td className="whitespace-nowrap px-3 text-xs text-muted tabular-nums">{duration(i.started_at, i.resolved_at)}</td>
                  <td className="whitespace-nowrap px-4 text-right text-xs text-muted">{ago(i.detected_at)}</td>
                </tr>))}</tbody>
            </table>
          </div>
        </Card>
      )}
      <DeclareIncident open={creating} onClose={() => setCreating(false)} onCreated={list.reload} />
    </>
  );
}

function DeclareIncident({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const services = useApi<{ name: string; display_name: string }[]>(open ? "/api/services" : null);
  const [form, setForm] = useState({ title: "", severity: "sev2", services: [] as string[], summary: "" });
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const submit = async () => {
    setBusy(true);
    try { const inc = await api<{ id: number; key: string }>("/api/incidents", { method: "POST", json: form }); toast(`${inc.key} declared. Investigation started.`); onCreated(); onClose(); window.location.href = `/incidents/${inc.id}`; }
    catch (e) { toast((e as Error).message, "bad"); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Declare an incident" footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" onClick={submit} disabled={busy || form.title.length < 5 || !form.services.length}>{busy && <Spinner />}Declare</button></>}>
      <div className="space-y-4">
        <div><label className="label" htmlFor="t">Title</label><input id="t" className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Checkout returns 502 for some users" /></div>
        <div><label className="label" htmlFor="sev">Severity</label><select id="sev" className="input" value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })}>{["sev1", "sev2", "sev3", "sev4"].map((s) => <option key={s} value={s}>{s.toUpperCase()}</option>)}</select></div>
        <fieldset><legend className="label">Affected services</legend><div className="flex flex-wrap gap-1.5">{(services.data ?? []).map((s) => { const on = form.services.includes(s.name); return <button type="button" key={s.name} aria-pressed={on} onClick={() => setForm({ ...form, services: on ? form.services.filter((x) => x !== s.name) : [...form.services, s.name] })} className={`rounded-md border px-2 py-1 text-xs mono ${on ? "border-accent bg-accent/15 text-accent" : "border-line"}`}>{s.name}</button>; })}</div></fieldset>
        <div><label className="label" htmlFor="sum">What do you see?</label><textarea id="sum" className="input min-h-[80px]" value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} /></div>
      </div>
    </Modal>
  );
}

export default function IncidentsPage() { return <Suspense fallback={<Skeleton className="h-96" />}><IncidentsInner /></Suspense>; }
