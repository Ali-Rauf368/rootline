"use client";
import { use, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, BrainCircuit, RefreshCw, Wrench, GitPullRequestDraft, Check, X, BookOpen, Activity, GitCommitHorizontal, ScrollText, Network, History, Gauge, FileDiff, ChevronDown, ChevronRight, CircleDot, Terminal, AlertTriangle, MessageSquarePlus, ExternalLink, ShieldCheck, Clock3, Sparkles, Users, PauseCircle } from "lucide-react";
import { api, useApi } from "@/lib/api";
import { useLiveEvents, useSession, can, useFlags, usePrefs } from "@/components/shell";
import { useWarRoom, PresenceStack, ChatCard } from "@/components/warroom";
import { Card, CardHeader, Badge, Empty, ErrorBox, Skeleton, ConfidenceBar, Modal, Spinner, Tabs, useToast, cx } from "@/components/ui";
import { SeverityBadge, StatusBadge, STATUS } from "@/components/domain";
import { TimeSeries, pivot, SERIES_COLORS, type Marker } from "@/components/charts";
import { DiffView } from "@/components/diff";
import { Markdown } from "@/components/markdown";
import { ago, clock, duration, dateTime, pct, ms, short } from "@/lib/format";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const LIFECYCLE = ["detected", "investigating", "identified", "mitigating", "resolved"] as const;
const STAMP: Record<string, string> = { detected: "detected_at", investigating: "acknowledged_at", identified: "identified_at", mitigating: "mitigated_at", resolved: "resolved_at" };
const EVIDENCE_ICON: Record<string, typeof Activity> = { metric: Gauge, deploy: GitCommitHorizontal, log: ScrollText, diff: FileDiff, runbook: BookOpen, incident: History, topology: Network };

export default function WarRoom({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const detail = useApi<Json>(`/api/incidents/${id}`);
  const signals = useApi<Json>(`/api/incidents/${id}/signals`, { refreshMs: 30_000 });
  const [liveSteps, setLiveSteps] = useState<Json[]>([]);
  const [running, setRunning] = useState<number | null>(null);
  const user = useSession();
  const toast = useToast();
  const { on } = useFlags();
  const room = useWarRoom(Number(id));

  useLiveEvents((e) => {
    if (e.type === "fix.approval" && e.incidentId === Number(id) && e.by !== user?.name) toast(`${e.by} approved a fix (${e.approvals} of ${e.required}). One more approval needed.`, "info");
    if (e.incidentId !== Number(id)) return;
    if (e.type === "investigation.step") { setRunning(e.investigationId as number); setLiveSteps((s) => [...s, e.step]); }
    else if (e.type === "investigation.status") { if (e.status === "running") { setLiveSteps([]); setRunning(e.investigationId as number); } else { setRunning(null); detail.reload(); signals.reload(); } }
    else detail.reload();
  }, [id]);

  if (detail.error && !detail.data) return <ErrorBox message={detail.error} onRetry={detail.reload} />;
  if (!detail.data) return <div className="space-y-4"><Skeleton className="h-24" /><div className="grid gap-4 xl:grid-cols-3"><Skeleton className="h-96 xl:col-span-2" /><Skeleton className="h-96" /></div></div>;

  const { incident: inc, events, investigations, steps, hypotheses, fixes } = detail.data;
  const latestInv = investigations[0];
  const shownSteps = running && liveSteps.length ? mergeSteps(steps, liveSteps) : steps;
  const isRunning = running != null || latestInv?.status === "running" || latestInv?.status === "queued";
  const responder = can(user, "responder");

  const setStatus = async (status: string) => {
    try { await api(`/api/incidents/${id}`, { method: "PATCH", json: { status } }); toast(`Status → ${STATUS[status as keyof typeof STATUS].label}`); detail.reload(); }
    catch (e) { toast((e as Error).message, "bad"); }
  };
  const rerun = async () => {
    try { await api(`/api/incidents/${id}/investigate`, { method: "POST" }); toast("Investigation queued", "info"); }
    catch (e) { toast((e as Error).message, "bad"); }
  };

  return (
    <div className="space-y-5">
      <Link href="/incidents" className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-fg"><ArrowLeft className="h-3.5 w-3.5" />Incidents</Link>

      {/* header */}
      <Card className="card-pad relative overflow-hidden">
        {inc.status !== "resolved" && <div className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-bad via-warn to-accent" />}
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2"><SeverityBadge s={inc.severity} /><StatusBadge s={inc.status} /><span className="text-xs text-subtle mono">{inc.key}</span><Badge tone="neutral">via {inc.source}</Badge></div>
            <h1 className="mt-2 text-xl font-semibold tracking-tight sm:text-2xl">{inc.title}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted">
              <span className="flex items-center gap-1"><Clock3 className="h-3.5 w-3.5" />started {dateTime(inc.started_at)} · {inc.status === "resolved" ? `lasted ${duration(inc.started_at, inc.resolved_at)}` : `open ${duration(inc.started_at)}`}</span>
              <span className="flex flex-wrap items-center gap-1">{inc.services.map((s: string) => <Link key={s} href={`/services/${s}`}><Badge className="mono hover:border-accent/50">{s}</Badge></Link>)}</span>
            </div>
            {on("presence") && <div className="mt-3"><PresenceStack viewers={room.viewers} /></div>}
          </div>
          {responder && (
            <div className="flex flex-wrap gap-2">
              <button className="btn-secondary" onClick={rerun} disabled={isRunning}>{isRunning ? <Spinner /> : <RefreshCw className="h-4 w-4" />}{isRunning ? "Investigating…" : "Re-investigate"}</button>
              {inc.status !== "resolved" && <button className="btn-ok" onClick={() => setStatus("resolved")}><Check className="h-4 w-4" />Resolve</button>}
            </div>
          )}
        </div>
        {/* lifecycle */}
        <ol className="mt-5 grid grid-cols-5 gap-1.5">
          {LIFECYCLE.map((s, i) => {
            const reached = LIFECYCLE.indexOf(inc.status) >= i;
            const ts = inc[STAMP[s]];
            return (
              <li key={s}>
                <button disabled={!responder || inc.status === s} onClick={() => setStatus(s)} className={cx("w-full rounded-lg border px-2 py-2 text-left transition", reached ? "border-accent/40 bg-accent/10" : "border-line bg-bg/40", responder && inc.status !== s && "hover:border-accent/60")} title={responder ? `Set status: ${s}` : undefined}>
                  <div className={cx("h-1 rounded-full", reached ? "bg-accent" : "bg-line")} />
                  <p className={cx("mt-1.5 text-[11px] font-medium sm:text-xs", reached ? "text-fg" : "text-subtle")}>{STATUS[s].label}</p>
                  <p className="hidden text-[10px] text-subtle sm:block">{ts ? `+${duration(inc.started_at, ts)}` : "—"}</p>
                </button>
              </li>
            );
          })}
        </ol>
      </Card>

      {!on("auto_investigate") && !latestInv && inc.status !== "resolved" && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-warn/30 bg-warn/10 px-4 py-3 text-sm">
          <PauseCircle className="h-4 w-4 shrink-0 text-warn" /><span className="flex-1">Auto-investigation is turned off, so the agent has not started.</span>
          {responder && <button className="btn-primary px-3 py-1.5 text-xs" onClick={rerun}><Sparkles className="h-3.5 w-3.5" />Start investigation</button>}
        </div>
      )}

      <div className="grid gap-5 xl:grid-cols-3">
        <div className="min-w-0 space-y-5 xl:col-span-2">
          <SignalsCard data={signals.data} incident={inc} fixes={fixes} />
          <HypothesesCard hypotheses={hypotheses} running={isRunning} responder={responder} reload={detail.reload} />
          <FixesCard fixes={fixes} responder={responder} reload={detail.reload} twoPerson={on("two_person_approval")} />
        </div>
        <div className="min-w-0 space-y-5">
          {(on("war_room_chat") || room.viewers.length > 0) && <ChatCard incidentId={inc.id} typing={room.typing} />}
          <AgentFeed steps={shownSteps} investigation={latestInv} running={isRunning} />
          <TimelineCard events={events} incidentId={inc.id} responder={responder} reload={detail.reload} />
          {signals.data?.errors?.length > 0 && (
            <Card className="card-pad">
              <CardHeader title="Error signatures" subtitle="In the incident window" icon={ScrollText} />
              <ul className="space-y-2">{signals.data.errors.map((e: Json) => (
                <li key={e.fingerprint + e.service} className="rounded-lg bg-raised/60 p-2.5">
                  <div className="flex items-center justify-between gap-2 text-xs"><span className="mono text-accent">{e.service}</span><Badge tone="bad">{e.n}×</Badge></div>
                  <p className="mt-1 line-clamp-3 text-xs mono">{e.sample}</p>
                  <p className="mt-1 text-[10px] text-subtle">first seen {clock(e.first_seen)}</p>
                </li>))}</ul>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function mergeSteps(saved: Json[], live: Json[]) {
  const ids = new Set(saved.map((s) => s.id));
  return [...saved, ...live.filter((s) => !ids.has(s.id))];
}

function SignalsCard({ data, incident, fixes }: { data: Json; incident: Json; fixes: Json[] }) {
  const [metric, setMetric] = useState<"error_rate" | "latency_p95_ms" | "rps" | "saturation">("error_rate");
  const rows = useMemo(() => (data?.metrics ?? []).filter((m: Json) => m.name === metric), [data, metric]);
  const series = [...new Set(rows.map((r: Json) => r.service))] as string[];
  const markers: Marker[] = [
    { ts: incident.started_at, label: "onset", tone: "onset" },
    ...(data?.deploys ?? []).map((d: Json) => ({ ts: d.deployed_at, label: `${d.kind === "rollback" ? "↩ " : ""}${d.service}@${short(d.sha)}`, tone: d.kind === "rollback" ? "fix" : "deploy" }) as Marker),
  ];
  const fmt = metric === "error_rate" ? (v: number) => pct(v, 1) : metric === "latency_p95_ms" ? (v: number) => ms(v) : metric === "saturation" ? (v: number) => pct(v, 0) : (v: number) => String(Math.round(v));
  return (
    <Card className="card-pad">
      <CardHeader title="Signals" subtitle={`${incident.services.join(", ")} · deploys and onset marked`} icon={Activity}
        action={<Tabs value={metric} onChange={setMetric} options={[{ value: "error_rate", label: "Errors" }, { value: "latency_p95_ms", label: "p95" }, { value: "rps", label: "RPS" }, { value: "saturation", label: "Saturation" }]} />} />
      {!data ? <Skeleton className="h-64" /> : rows.length ? (
        <TimeSeries data={pivot(rows, "service")} series={series.map((s, i) => ({ key: s, label: s, color: SERIES_COLORS[i] }))} format={fmt} markers={markers} height={260}
          window={{ from: new Date(incident.started_at).getTime(), to: new Date(incident.resolved_at ?? Date.now()).getTime() }} />
      ) : <Empty title="No metrics in this window" />}
      {fixes.some((f) => f.status === "pr_opened") && <p className="mt-2 text-xs text-muted">Green markers are rollbacks/fix deploys. Watch the lines return to baseline.</p>}
    </Card>
  );
}

function HypothesesCard({ hypotheses, running, responder, reload }: { hypotheses: Json[]; running: boolean; responder: boolean; reload: () => void }) {
  const [cite, setCite] = useState<Json | null>(null);
  const [showRejected, setShowRejected] = useState(false);
  const toast = useToast();
  const active = hypotheses.filter((h) => h.status !== "rejected");
  const rejected = hypotheses.filter((h) => h.status === "rejected");
  const decide = async (hid: number, d: "confirm" | "reject") => {
    try { await api(`/api/hypotheses/${hid}/${d}`, { method: "POST" }); toast(d === "confirm" ? "Root cause confirmed" : "Hypothesis rejected"); reload(); }
    catch (e) { toast((e as Error).message, "bad"); }
  };
  return (
    <Card className="card-pad">
      <CardHeader title="Root-cause hypotheses" subtitle="Ranked by calibrated confidence · every claim cites its evidence" icon={BrainCircuit} />
      {!active.length ? (running ? <div className="flex items-center gap-2 py-8 text-sm text-muted"><Spinner />The agent is gathering evidence…</div> : <Empty icon={BrainCircuit} title="No hypotheses yet" />) : (
        <div className="space-y-3">
          {active.map((h, i) => (
            <div key={h.id} className={cx("rounded-xl border p-4 animate-fadeIn", i === 0 ? "border-accent/40 bg-accent/[0.06]" : "border-line bg-bg/40", h.status === "confirmed" && "border-ok/50 bg-ok/[0.06]")}>
              <div className="flex flex-wrap items-center gap-2">
                <span className={cx("flex h-6 w-6 items-center justify-center rounded-md text-xs font-bold", i === 0 ? "bg-accent text-white" : "bg-raised text-muted")}>#{i + 1}</span>
                <Badge tone="neutral">{String(h.category).replace("_", " ")}</Badge>
                {h.status === "confirmed" && <Badge tone="ok" dot>Confirmed</Badge>}
                {h.deploy_sha && <Badge tone="warn" className="mono">{h.deploy_service}@{short(h.deploy_sha)}</Badge>}
              </div>
              <p className="mt-2 font-medium leading-snug">{h.title}</p>
              <ConfidenceBar value={Number(h.confidence)} className="mt-2.5 max-w-sm" />
              <p className="mt-3 text-sm leading-relaxed text-muted">{h.description}</p>
              <div className="mt-3 grid gap-1.5 sm:grid-cols-2">
                {h.evidence.map((ev: Json, j: number) => { const I = EVIDENCE_ICON[ev.type] ?? CircleDot; return (
                  <div key={j} className="flex gap-2 rounded-lg bg-raised/60 p-2 text-xs">
                    <I className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
                    <div className="min-w-0"><p className="font-medium">{ev.label}</p><p className="mt-0.5 line-clamp-2 break-words text-muted">{ev.detail}</p></div>
                  </div>); })}
              </div>
              {h.citations.length > 0 && (
                <div className="mt-3">
                  <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-subtle">Sources</p>
                  <div className="space-y-1.5">{h.citations.map((c: Json, j: number) => (
                    <button key={j} onClick={() => setCite(c)} className="flex w-full items-start gap-2 rounded-lg border border-line bg-panel p-2 text-left text-xs transition hover:border-accent/50">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-accent/15 text-[10px] font-bold text-accent">{j + 1}</span>
                      <span className="min-w-0"><span className="font-medium">{c.title}</span>{c.heading && <span className="text-subtle"> › {c.heading}</span>}<span className="mt-0.5 block italic text-muted">“{c.quote}”</span></span>
                    </button>))}</div>
                </div>
              )}
              {responder && h.status === "proposed" && (
                <div className="mt-3 flex gap-2">
                  <button className="btn-secondary px-2.5 py-1.5 text-xs" onClick={() => decide(h.id, "confirm")}><Check className="h-3.5 w-3.5 text-ok" />Confirm root cause</button>
                  <button className="btn-ghost px-2.5 py-1.5 text-xs" onClick={() => decide(h.id, "reject")}><X className="h-3.5 w-3.5" />Reject</button>
                </div>
              )}
            </div>
          ))}
          {rejected.length > 0 && <button className="text-xs text-muted hover:text-fg" onClick={() => setShowRejected((v) => !v)}>{showRejected ? "Hide" : "Show"} {rejected.length} rejected / superseded</button>}
          {showRejected && rejected.map((h) => <p key={h.id} className="text-xs text-subtle line-through">{h.title} ({Math.round(h.confidence * 100)}%)</p>)}
        </div>
      )}
      <CitationDrawer citation={cite} onClose={() => setCite(null)} />
    </Card>
  );
}

function CitationDrawer({ citation, onClose }: { citation: Json | null; onClose: () => void }) {
  const doc = useApi<Json>(citation ? `/api/knowledge/${citation.documentId}` : null);
  return (
    <Modal open={!!citation} onClose={onClose} title={citation?.title ?? "Source"} wide>
      {doc.data ? (
        <>
          <div className="mb-3 flex items-center gap-2 text-xs text-muted"><Badge tone="accent">{doc.data.kind}</Badge>{doc.data.service && <Badge className="mono">{doc.data.service}</Badge>}<span>chunk #{citation.chunkId} · highlighted passage is what the agent quoted</span></div>
          <Markdown text={doc.data.content} highlight={citation.quote} />
        </>
      ) : <Spinner />}
    </Modal>
  );
}

function FixesCard({ fixes, responder, reload, twoPerson }: { fixes: Json[]; responder: boolean; reload: () => void; twoPerson: boolean }) {
  const me = useSession();
  const [view, setView] = useState<Record<number, "patch" | "test" | "checks">>({});
  const [confirm, setConfirm] = useState<{ fix: Json; decision: "approve" | "reject" } | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  if (!fixes.length) return null;
  const decide = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      const r = await api<Json>(`/api/fixes/${confirm.fix.id}/${confirm.decision}`, { method: "POST", json: { note: note || undefined } });
      toast(r.status === "awaiting_second_approval" ? "Approval recorded (1 of 2). A second responder must approve." : confirm.decision === "approve" ? `Draft PR opened${r.pr_mode === "simulated" ? " (simulated)" : ""}` : "Fix rejected", confirm.decision === "approve" ? "ok" : "info");
      setConfirm(null); setNote(""); reload();
    } catch (e) { toast((e as Error).message, "bad"); }
    finally { setBusy(false); }
  };
  const STATUS_TONE: Record<string, "warn" | "ok" | "bad" | "info" | "neutral"> = { pending_approval: "warn", approved: "info", pr_opened: "ok", rejected: "neutral", failed: "bad" };
  return (
    <Card className="card-pad">
      <CardHeader title="Proposed fixes" subtitle="Verified against the repository snapshot · human approval required" icon={Wrench} />
      <div className="space-y-4">
        {fixes.map((f) => {
          const tab = view[f.id] ?? "patch";
          const checks = f.verification?.checks ?? [];
          return (
            <div key={f.id} className={cx("rounded-xl border p-4", f.status === "pending_approval" ? "border-warn/40 bg-warn/[0.05]" : "border-line bg-bg/40")}>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={STATUS_TONE[f.status]} dot>{String(f.status).replace("_", " ")}</Badge>
                <Badge tone="neutral">{f.strategy}</Badge><Badge className="mono">{f.service}</Badge>
                <span className={cx("ml-auto flex items-center gap-1 text-xs font-medium", f.verification?.passed ? "text-ok" : "text-bad")}><ShieldCheck className="h-3.5 w-3.5" />{checks.filter((c: Json) => c.status === "pass").length}/{checks.length} checks</span>
              </div>
              <p className="mt-2 font-medium">{f.title}</p>
              <p className="mt-1 text-sm text-muted">{f.description}</p>
              <div className="mt-3"><Tabs value={tab} onChange={(v) => setView({ ...view, [f.id]: v })} options={[{ value: "patch", label: "Patch" }, { value: "test", label: "Regression test" }, { value: "checks", label: "Verification", count: checks.length }]} /></div>
              <div className="mt-3">
                {tab === "patch" && <DiffView diff={f.patch} />}
                {tab === "test" && (f.test_patch ? <DiffView diff={f.test_patch} /> : <p className="text-sm text-muted">No test.</p>)}
                {tab === "checks" && (
                  <ul className="space-y-1.5">{checks.map((c: Json, i: number) => (
                    <li key={i} className="flex items-start gap-2 rounded-lg bg-raised/60 p-2 text-sm">
                      {c.status === "pass" ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-ok" /> : c.status === "fail" ? <X className="mt-0.5 h-4 w-4 shrink-0 text-bad" /> : <CircleDot className="mt-0.5 h-4 w-4 text-subtle" />}
                      <div><p className="font-medium">{c.name}</p><p className="text-xs text-muted">{c.detail}</p></div>
                    </li>))}</ul>
                )}
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                {f.status === "pending_approval" && twoPerson && (
                  <span className="flex items-center gap-1.5 rounded-lg border border-line bg-raised/60 px-2.5 py-1.5 text-xs" title={f.approvals?.map((a: Json) => a.name).join(", ")}>
                    <Users className="h-3.5 w-3.5 text-accent" /><b className="tabular-nums">{f.approvals?.length ?? 0} of 2</b> approvals{f.approvals?.length ? ` · ${f.approvals.map((a: Json) => a.name).join(", ")}` : ""}
                  </span>
                )}
                {f.status === "pending_approval" && responder && <>
                  {twoPerson && f.approvals?.some((a: Json) => a.userId === me?.id)
                    ? <span className="text-xs text-muted">You approved. Waiting for a second responder.</span>
                    : <button className="btn-ok" onClick={() => setConfirm({ fix: f, decision: "approve" })}><GitPullRequestDraft className="h-4 w-4" />{twoPerson && f.approvals?.length ? "Add second approval & open PR" : twoPerson ? "Approve (1 of 2)" : "Approve & open draft PR"}</button>}
                  <button className="btn-secondary" onClick={() => setConfirm({ fix: f, decision: "reject" })}><X className="h-4 w-4" />Reject</button>
                </>}
                {f.pr_url && <a href={f.pr_url} target="_blank" rel="noreferrer" className="btn-secondary"><ExternalLink className="h-4 w-4" />View PR{f.pr_mode === "simulated" ? " (simulated)" : f.pr_number ? ` #${f.pr_number}` : ""}</a>}
                {f.decided_by_name && <span className="text-xs text-muted">{f.status === "rejected" ? "Rejected" : "Approved"} by {f.decided_by_name} {ago(f.decided_at)}{f.decision_note ? `: “${f.decision_note}”` : ""}</span>}
                {f.status === "failed" && <span className="flex items-center gap-1 text-xs text-bad"><AlertTriangle className="h-3.5 w-3.5" />Failed verification. It cannot be approved.</span>}
              </div>
            </div>
          );
        })}
      </div>
      <Modal open={!!confirm} onClose={() => setConfirm(null)} title={confirm?.decision === "approve" ? "Approve fix and open a draft PR?" : "Reject this fix?"}
        footer={<><button className="btn-secondary" onClick={() => setConfirm(null)}>Cancel</button><button className={confirm?.decision === "approve" ? "btn-ok" : "btn-danger"} onClick={decide} disabled={busy}>{busy && <Spinner />}{confirm?.decision === "approve" ? "Approve" : "Reject"}</button></>}>
        <p className="text-sm text-muted">{confirm?.decision === "approve" ? "Rootline will create a branch, commit the verified patch and regression test, and open a draft pull request for review. Nothing is merged automatically." : "The agent's proposal will be marked as rejected. You can re-run the investigation afterwards."}</p>
        <label className="label mt-4" htmlFor="note">Note for the audit log (optional)</label>
        <textarea id="note" className="input min-h-[70px]" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
      </Modal>
    </Card>
  );
}

function AgentFeed({ steps, investigation, running }: { steps: Json[]; investigation: Json; running: boolean }) {
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const { prefs } = usePrefs();
  const feed = useRef<HTMLOListElement>(null);
  useEffect(() => { if (prefs.followAgent && running && feed.current) feed.current.scrollTop = feed.current.scrollHeight; }, [steps.length, running, prefs.followAgent]);
  return (
    <Card className="card-pad">
      <CardHeader title="Agent activity" icon={Sparkles}
        subtitle={investigation ? `${investigation.mode}${investigation.model ? ` · ${investigation.model}` : ""} · ${investigation.status}${investigation.input_tokens ? ` · ${(investigation.input_tokens + investigation.output_tokens).toLocaleString()} tokens` : ""}` : "Not started"}
        action={running ? <Badge tone="warn" dot>running</Badge> : investigation?.status === "completed" ? <Badge tone="ok">done</Badge> : undefined} />
      {!steps.length ? <p className="text-sm text-muted">{running ? "Starting…" : "No investigation yet."}</p> : (
        <ol ref={feed} className="relative max-h-[560px] space-y-0 overflow-y-auto pr-1">
          {steps.map((s, i) => {
            const isTool = s.kind === "tool_call";
            const text = s.output?.text ?? s.output?.error;
            return (
              <li key={s.id ?? i} className="relative animate-fadeIn pb-3 pl-6">
                {i < steps.length - 1 && <span className="absolute left-[7px] top-4 h-full w-px bg-line" />}
                <span className={cx("absolute left-0 top-1 flex h-[15px] w-[15px] items-center justify-center rounded-full border", s.kind === "conclusion" ? "border-ok bg-ok/20" : s.kind === "error" ? "border-bad bg-bad/20" : isTool ? "border-accent bg-accent/20" : "border-subtle bg-raised")}>
                  {isTool && <Terminal className="h-2 w-2 text-accent" />}
                </span>
                {isTool ? (
                  <button className="w-full text-left" onClick={() => setOpen({ ...open, [i]: !open[i] })}>
                    <span className="flex items-center gap-1.5 text-xs"><span className="font-medium mono text-accent">{s.tool}</span>{s.duration_ms != null && <span className="text-subtle">{s.duration_ms}ms</span>}{open[i] ? <ChevronDown className="ml-auto h-3 w-3" /> : <ChevronRight className="ml-auto h-3 w-3" />}</span>
                    {s.input && Object.keys(s.input).length > 0 && <span className="mt-0.5 block truncate text-[11px] text-muted mono">{JSON.stringify(s.input)}</span>}
                  </button>
                ) : (
                  <p className={cx("text-xs leading-relaxed", s.kind === "conclusion" ? "font-medium text-ok" : s.kind === "error" ? "text-bad" : "text-fg/90", s.output?.reasoning && "italic text-muted")}>{text}</p>
                )}
                {isTool && open[i] && <pre className="mt-1.5 max-h-60 overflow-auto rounded-lg bg-bg p-2 text-[10.5px] leading-4 text-muted mono">{JSON.stringify(s.output, null, 2)}</pre>}
              </li>
            );
          })}
          {running && <li className="flex items-center gap-2 pl-6 text-xs text-muted"><Spinner className="h-3 w-3" />working…</li>}
        </ol>
      )}
    </Card>
  );
}

function TimelineCard({ events, incidentId, responder, reload }: { events: Json[]; incidentId: number; responder: boolean; reload: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const add = async (e: React.FormEvent) => {
    e.preventDefault(); if (!note.trim()) return; setBusy(true);
    try { await api(`/api/incidents/${incidentId}/notes`, { method: "POST", json: { body: note } }); setNote(""); reload(); }
    catch (err) { toast((err as Error).message, "bad"); } finally { setBusy(false); }
  };
  const TONE: Record<string, string> = { detected: "bg-bad", signal: "bg-warn", hypothesis: "bg-accent", fix: "bg-info", pr: "bg-ok", status: "bg-subtle", note: "bg-fg", deploy: "bg-warn", agent: "bg-accent", alert: "bg-bad" };
  return (
    <Card className="card-pad">
      <CardHeader title="Timeline" subtitle={`${events.length} events`} icon={History} />
      {responder && (
        <form onSubmit={add} className="mb-4 flex gap-2">
          <input className="input" placeholder="Add a note for responders…" value={note} onChange={(e) => setNote(e.target.value)} maxLength={4000} aria-label="Note" />
          <button className="btn-secondary shrink-0" disabled={busy || !note.trim()} aria-label="Add note"><MessageSquarePlus className="h-4 w-4" /></button>
        </form>
      )}
      <ol className="max-h-[460px] space-y-3 overflow-y-auto pr-1">
        {[...events].reverse().map((e) => (
          <li key={e.id} className="flex gap-3">
            <span className={cx("mt-1.5 h-2 w-2 shrink-0 rounded-full", TONE[e.kind] ?? "bg-subtle")} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium leading-snug">{e.title}</p>
              {e.body && <p className="mt-0.5 whitespace-pre-line break-words text-xs text-muted">{e.body.length > 300 ? `${e.body.slice(0, 300)}…` : e.body}</p>}
              <p className="mt-0.5 text-[10px] text-subtle">{clock(e.ts)} · {e.actor}</p>
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}
