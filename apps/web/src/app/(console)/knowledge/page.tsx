"use client";
import { useState } from "react";
import { BookOpen, Search, Plus, FileText, Sparkles } from "lucide-react";
import { api, useApi } from "@/lib/api";
import { useSession, can } from "@/components/shell";
import { Card, CardHeader, PageHeader, Badge, Empty, ErrorBox, Skeleton, Modal, Spinner, useToast, cx } from "@/components/ui";
import { Markdown } from "@/components/markdown";
import { ago } from "@/lib/format";

type Doc = { id: number; kind: string; title: string; service: string | null; updated_at: string; chunks: number; size: number };
type Hit = { chunkId: number; documentId: number; title: string; kind: string; heading: string; content: string; score: number; bm25Rank: number | null; vectorRank: number | null };
const KIND_TONE: Record<string, "accent" | "warn" | "info" | "ok"> = { runbook: "accent", postmortem: "warn", architecture: "info", playbook: "ok" };

export default function KnowledgePage() {
  const docs = useApi<Doc[]>("/api/knowledge");
  const [q, setQ] = useState("could not acquire connection from pool");
  const [hits, setHits] = useState<{ mode: string; hits: Hit[] } | null>(null);
  const [searching, setSearching] = useState(false);
  const [openDoc, setOpenDoc] = useState<{ id: number; highlight?: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const user = useSession();
  const search = async (e?: React.FormEvent) => {
    e?.preventDefault(); if (q.trim().length < 2) return; setSearching(true);
    try { setHits(await api(`/api/knowledge/search?q=${encodeURIComponent(q)}`)); } finally { setSearching(false); }
  };
  return (
    <>
      <PageHeader title="Runbooks & docs" subtitle="The agent retrieves from this knowledge base and must quote it verbatim when citing"
        actions={can(user, "responder") && <button className="btn-primary" onClick={() => setAdding(true)}><Plus className="h-4 w-4" />Add document</button>} />
      <Card className="card-pad mb-6">
        <CardHeader title="Retrieval playground" subtitle="Hybrid search: Postgres full-text + vector similarity, fused with reciprocal-rank fusion" icon={Sparkles} />
        <form onSubmit={search} className="flex gap-2">
          <label className="relative flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" /><input className="input pl-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Paste an error message or describe a symptom" aria-label="Search knowledge" /></label>
          <button className="btn-primary" disabled={searching}>{searching && <Spinner />}Search</button>
        </form>
        {hits && (
          <div className="mt-4 space-y-2">
            <p className="text-xs text-subtle">Mode: {hits.mode}</p>
            {!hits.hits.length && <p className="text-sm text-muted">No relevant passages.</p>}
            {hits.hits.map((h, i) => (
              <button key={h.chunkId} onClick={() => setOpenDoc({ id: h.documentId, highlight: h.content.slice(0, 60) })} className="block w-full rounded-lg border border-line bg-bg/40 p-3 text-left transition hover:border-accent/40">
                <div className="flex flex-wrap items-center gap-2 text-xs"><span className="font-semibold text-accent">#{i + 1}</span><span className="font-medium">{h.title}</span>{h.heading && <span className="text-subtle">› {h.heading}</span>}
                  <span className="ml-auto flex gap-1.5"><Badge>RRF {h.score.toFixed(4)}</Badge><Badge tone={h.bm25Rank ? "info" : "neutral"}>text {h.bm25Rank ? `#${h.bm25Rank}` : "–"}</Badge><Badge tone={h.vectorRank ? "accent" : "neutral"}>vector {h.vectorRank ? `#${h.vectorRank}` : "–"}</Badge></span></div>
                <p className="mt-1.5 line-clamp-2 text-sm text-muted">{h.content}</p>
              </button>
            ))}
          </div>
        )}
      </Card>
      {docs.error ? <ErrorBox message={docs.error} onRetry={docs.reload} /> : !docs.data ? <Skeleton className="h-64" /> : !docs.data.length ? <Card><Empty icon={BookOpen} title="No documents yet" /></Card> : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {docs.data.map((d) => (
            <button key={d.id} onClick={() => setOpenDoc({ id: d.id })} className="card card-pad text-left transition hover:border-accent/40 hover:shadow-glow">
              <div className="flex items-center gap-2"><Badge tone={KIND_TONE[d.kind]}>{d.kind}</Badge>{d.service && <Badge className="mono">{d.service}</Badge>}</div>
              <p className="mt-2 flex items-start gap-2 font-medium"><FileText className="mt-0.5 h-4 w-4 shrink-0 text-subtle" />{d.title}</p>
              <p className="mt-2 text-xs text-subtle">{d.chunks} chunks · {Math.round(d.size / 100) / 10} kB · updated {ago(d.updated_at)}</p>
            </button>
          ))}
        </div>
      )}
      <DocModal doc={openDoc} onClose={() => setOpenDoc(null)} />
      <AddDoc open={adding} onClose={() => setAdding(false)} onSaved={docs.reload} />
    </>
  );
}

function DocModal({ doc, onClose }: { doc: { id: number; highlight?: string } | null; onClose: () => void }) {
  const d = useApi<{ title: string; kind: string; content: string; service: string | null }>(doc ? `/api/knowledge/${doc.id}` : null);
  return <Modal open={!!doc} onClose={onClose} title={d.data?.title ?? "Document"} wide>{d.data ? <Markdown text={d.data.content} highlight={doc?.highlight} /> : <Spinner />}</Modal>;
}

function AddDoc({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ kind: "runbook", title: "", service: "", content: "" });
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const save = async () => {
    setBusy(true);
    try { const r = await api<{ chunks: number }>("/api/knowledge", { method: "POST", json: { ...f, service: f.service || null } }); toast(`Indexed into ${r.chunks} chunks`); onSaved(); onClose(); setF({ kind: "runbook", title: "", service: "", content: "" }); }
    catch (e) { toast((e as Error).message, "bad"); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Add runbook, postmortem or doc" wide footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" onClick={save} disabled={busy || f.title.length < 3 || f.content.length < 20}>{busy && <Spinner />}Index document</button></>}>
      <div className="grid gap-3 sm:grid-cols-3">
        <div><label className="label" htmlFor="k">Type</label><select id="k" className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{["runbook", "postmortem", "architecture", "playbook"].map((k) => <option key={k}>{k}</option>)}</select></div>
        <div className="sm:col-span-2"><label className="label" htmlFor="ti">Title</label><input id="ti" className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></div>
        <div className="sm:col-span-3"><label className="label" htmlFor="sv">Service (optional)</label><input id="sv" className="input mono" value={f.service} onChange={(e) => setF({ ...f, service: e.target.value })} placeholder="checkout-api" /></div>
        <div className="sm:col-span-3"><label className="label" htmlFor="c">Markdown content</label><textarea id="c" className={cx("input min-h-[240px] mono text-xs")} value={f.content} onChange={(e) => setF({ ...f, content: e.target.value })} placeholder={"# Title\n\n## Symptoms\n…\n\n## Mitigation\n…"} /></div>
      </div>
    </Modal>
  );
}
