"use client";
import { useState } from "react";
import Link from "next/link";
import { GitCommitHorizontal, FileDiff } from "lucide-react";
import { useApi } from "@/lib/api";
import { useLiveEvents } from "@/components/shell";
import { Card, PageHeader, Badge, Empty, ErrorBox, Skeleton, Modal, Spinner } from "@/components/ui";
import { DiffView } from "@/components/diff";
import { ago, dateTime, short } from "@/lib/format";

export default function ChangesPage() {
  const [service, setService] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const services = useApi<{ name: string }[]>("/api/services");
  const list = useApi<any[]>(`/api/deploys?limit=100${service ? `&service=${service}` : ""}`); // eslint-disable-line @typescript-eslint/no-explicit-any
  const detail = useApi<any>(open ? `/api/deploys/${open}` : null); // eslint-disable-line @typescript-eslint/no-explicit-any
  useLiveEvents((e) => { if (e.type === "deploy" || e.type === "hypotheses.updated") list.reload(); });
  return (
    <>
      <PageHeader title="Changes" subtitle="Deploys and config changes from CI/CD webhooks. Changes the agent implicated are flagged."
        actions={<select className="input w-48" value={service} onChange={(e) => setService(e.target.value)} aria-label="Service"><option value="">All services</option>{(services.data ?? []).map((s) => <option key={s.name}>{s.name}</option>)}</select>} />
      {list.error ? <ErrorBox message={list.error} onRetry={list.reload} /> : !list.data ? <Skeleton className="h-96" /> : !list.data.length ? <Card><Empty icon={GitCommitHorizontal} title="No changes recorded" /></Card> : (
        <Card className="divide-y divide-line">
          {list.data.map((d) => (
            <div key={d.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{d.message}</p>
                <p className="mt-0.5 text-xs text-muted"><span className="mono text-accent">{d.service}@{short(d.sha)}</span> · {d.author} · {dateTime(d.deployed_at)} ({ago(d.deployed_at)}) · via {d.source}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {d.kind !== "code" && <Badge tone={d.kind === "rollback" ? "ok" : "warn"}>{d.kind}</Badge>}
                {d.implicated?.map((i: { id: number; key: string; confidence: number }) => <Link key={i.id} href={`/incidents/${i.id}`}><Badge tone="bad">suspect in {i.key} ({Math.round(i.confidence * 100)}%)</Badge></Link>)}
                {d.files?.length > 0 && <button className="btn-secondary px-2.5 py-1 text-xs" onClick={() => setOpen(d.id)}><FileDiff className="h-3.5 w-3.5" />{d.files.length} file{d.files.length > 1 ? "s" : ""}</button>}
              </div>
            </div>
          ))}
        </Card>
      )}
      <Modal open={!!open} onClose={() => setOpen(null)} title={detail.data ? `${detail.data.service}@${short(detail.data.sha)}: ${detail.data.message}` : "Change"} wide>
        {detail.data ? (detail.data.diff ? <DiffView diff={detail.data.diff} maxHeight={520} /> : <p className="text-sm text-muted">No diff captured for this change.</p>) : <Spinner />}
      </Modal>
    </>
  );
}
