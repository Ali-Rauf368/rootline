"use client";
import { useState } from "react";
import { Plug, KeyRound, Github, BrainCircuit, Database, Layers, Copy, Trash2, Check, Radio } from "lucide-react";
import { api, useApi } from "@/lib/api";
import { useSession, can } from "@/components/shell";
import { Card, CardHeader, PageHeader, Badge, Skeleton, ErrorBox, Modal, Spinner, useToast, Tabs } from "@/components/ui";
import { ago } from "@/lib/format";

const SNIPPETS = (origin: string) => ({
  logs: `curl -X POST ${origin}/api/ingest/logs \\
  -H "X-API-Key: $ROOTLINE_KEY" -H "Content-Type: application/json" \\
  -d '[{"service":"checkout-api","level":"error","message":"TimeoutError: could not acquire connection"}]'`,
  metrics: `curl -X POST ${origin}/api/ingest/metrics \\
  -H "X-API-Key: $ROOTLINE_KEY" -H "Content-Type: application/json" \\
  -d '[{"service":"checkout-api","name":"error_rate","value":0.012}]'`,
  deploys: `curl -X POST ${origin}/api/ingest/deploys \\
  -H "X-API-Key: $ROOTLINE_KEY" -H "Content-Type: application/json" \\
  -d "{\\"service\\":\\"checkout-api\\",\\"sha\\":\\"$GITHUB_SHA\\",\\"author\\":\\"$GITHUB_ACTOR\\",\\"message\\":\\"deploy\\",\\"diff\\":$(git show --format= HEAD | jq -Rs .)}"`,
  alertmanager: `# alertmanager.yml
receivers:
  - name: rootline
    webhook_configs:
      - url: ${origin}/api/ingest/alerts
        http_config:
          authorization: { type: Bearer, credentials: <ROOTLINE_KEY> }`,
});

export default function IntegrationsPage() {
  const d = useApi<any>("/api/integrations", { refreshMs: 15_000 }); // eslint-disable-line @typescript-eslint/no-explicit-any
  const user = useSession();
  const [tab, setTab] = useState<"logs" | "metrics" | "deploys" | "alertmanager">("logs");
  const [newKey, setNewKey] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  if (d.error) return <ErrorBox message={d.error} onRetry={d.reload} />;
  if (!d.data) return <Skeleton className="h-96" />;
  const x = d.data;
  const origin = typeof window !== "undefined" ? window.location.origin.replace(":3100", ":4100") : "";
  const create = async () => {
    setBusy(true);
    try { const r = await api<{ key: string }>("/api/keys", { method: "POST", json: { name } }); setNewKey(r.key); setName(""); d.reload(); }
    catch (e) { toast((e as Error).message, "bad"); } finally { setBusy(false); }
  };
  const revoke = async (id: number) => { await api(`/api/keys/${id}`, { method: "DELETE" }); toast("Key revoked"); d.reload(); };
  const tiles = [
    { icon: BrainCircuit, title: "Investigation agent", value: x.agent.mode === "claude" ? `Claude · ${x.agent.model}` : "Heuristic (offline)", hint: x.agent.mode === "claude" ? `Tool-use loop, max ${x.agent.maxSteps} turns, heuristic fallback` : "Set ANTHROPIC_API_KEY to enable the LLM agent", ok: true },
    { icon: Layers, title: "Job queue", value: x.queue.backend === "bullmq" ? "BullMQ on Redis" : "Postgres (SKIP LOCKED)", hint: `${x.queue.waiting ?? 0} waiting · ${x.queue.active ?? 0} active · ${x.queue.failed ?? 0} failed`, ok: true },
    { icon: Database, title: "Vector store", value: x.vector, hint: `${x.stats.chunks} indexed chunks`, ok: true },
    { icon: Github, title: "GitHub", value: x.github.prs === "enabled" ? "Draft PRs enabled" : "Simulated PRs", hint: x.github.webhookSecret ? "Webhook signature verification on" : "Set GITHUB_WEBHOOK_SECRET", ok: x.github.prs === "enabled" },
    { icon: Radio, title: "Ingestion (1h)", value: `${x.stats.logs_1h.toLocaleString()} logs`, hint: `${x.stats.metrics_1h.toLocaleString()} metric points · ${x.stats.deploys_24h} deploys/24h`, ok: true },
  ];
  return (
    <>
      <PageHeader title="Integrations" subtitle="Connect telemetry sources, CI/CD and GitHub" />
      <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {tiles.map((t) => (
          <Card key={t.title} className="card-pad">
            <div className="flex items-center justify-between"><t.icon className="h-4 w-4 text-accent" /><Badge tone={t.ok ? "ok" : "warn"} dot>{t.ok ? "active" : "optional"}</Badge></div>
            <p className="mt-3 text-xs text-muted">{t.title}</p><p className="mt-0.5 text-sm font-semibold">{t.value}</p><p className="mt-1 text-xs text-subtle">{t.hint}</p>
          </Card>
        ))}
      </div>
      <div className="grid gap-6 xl:grid-cols-5">
        <Card className="card-pad xl:col-span-3">
          <CardHeader title="Send data" subtitle="Webhook & ingestion endpoints (API key auth, idempotent with Idempotency-Key)" icon={Plug} action={<Tabs value={tab} onChange={setTab} options={[{ value: "logs", label: "Logs" }, { value: "metrics", label: "Metrics" }, { value: "deploys", label: "Deploys" }, { value: "alertmanager", label: "Alertmanager" }]} />} />
          <div className="relative"><pre className="overflow-x-auto rounded-lg bg-bg p-4 text-xs leading-5 mono">{SNIPPETS(origin)[tab]}</pre>
            <button className="btn-ghost absolute right-2 top-2 p-1.5" onClick={() => { navigator.clipboard?.writeText(SNIPPETS(origin)[tab]); toast("Copied"); }} aria-label="Copy"><Copy className="h-3.5 w-3.5" /></button></div>
          <ul className="mt-4 grid gap-1.5 text-xs sm:grid-cols-2">{x.endpoints.map((e: string) => <li key={e} className="rounded-md bg-raised px-2 py-1.5 mono">POST {e}</li>)}</ul>
          <p className="mt-3 text-xs text-muted">GitHub: add a webhook for <code className="mono">deployment_status</code> and <code className="mono">push</code> events pointing at <code className="mono">/api/webhooks/github</code> with your secret.</p>
        </Card>
        <Card className="card-pad xl:col-span-2">
          <CardHeader title="API keys" subtitle="Per-source keys; only a hash is stored" icon={KeyRound} />
          {can(user, "admin") && (
            <form onSubmit={(e) => { e.preventDefault(); create(); }} className="mb-4 flex gap-2">
              <input className="input" placeholder="Key name, e.g. fluent-bit-prod" value={name} onChange={(e) => setName(e.target.value)} aria-label="Key name" />
              <button className="btn-primary shrink-0" disabled={busy || name.length < 2}>{busy && <Spinner />}Create</button>
            </form>
          )}
          <ul className="space-y-2">
            {x.keys.map((k: any) => ( // eslint-disable-line @typescript-eslint/no-explicit-any
              <li key={k.id} className="flex items-center gap-2 rounded-lg bg-raised/60 p-2.5 text-sm">
                <div className="min-w-0 flex-1"><p className="font-medium">{k.name}</p><p className="text-xs text-muted mono">{k.preview} · {k.last_used_at ? `used ${ago(k.last_used_at)}` : "never used"}</p></div>
                {k.revoked_at ? <Badge>revoked</Badge> : can(user, "admin") && <button className="btn-ghost p-1.5 hover:text-bad" onClick={() => revoke(k.id)} aria-label="Revoke"><Trash2 className="h-4 w-4" /></button>}
              </li>
            ))}
            {!x.keys.length && <p className="text-sm text-muted">No keys yet. The shared <code className="mono">INGEST_TOKEN</code> works for local testing.</p>}
          </ul>
        </Card>
      </div>
      <Modal open={!!newKey} onClose={() => setNewKey(null)} title="API key created">
        <p className="mb-3 text-sm text-warn">Copy it now. It won't be shown again.</p>
        <div className="flex gap-2"><code className="input select-all break-all text-xs mono">{newKey}</code><button className="btn-secondary" onClick={() => { navigator.clipboard?.writeText(newKey ?? ""); toast("Copied"); }}><Check className="h-4 w-4" /></button></div>
      </Modal>
    </>
  );
}
