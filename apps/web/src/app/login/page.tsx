"use client";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Radar, GitPullRequestDraft, BookOpenCheck, Workflow } from "lucide-react";
import { api } from "@/lib/api";
import { Spinner } from "@/components/ui";

const DEMO = [["oncall@opsmeridian.dev", "Responder"], ["admin@opsmeridian.dev", "Admin"], ["viewer@opsmeridian.dev", "Viewer"]];

function LoginForm() {
  const [email, setEmail] = useState("oncall@opsmeridian.dev");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const next = useSearchParams().get("next") || "/";
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError("");
    try { await api("/api/auth/login", { method: "POST", json: { email, password } }); router.replace(next.startsWith("/") ? next : "/"); }
    catch (err) { setError((err as Error).message); setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      {error && <p className="rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-sm text-bad" role="alert">{error}</p>}
      <div><label className="label" htmlFor="email">Work email</label><input id="email" className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
      <div><label className="label" htmlFor="password">Password</label><input id="password" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></div>
      <button className="btn-primary w-full py-2.5" disabled={busy}>{busy && <Spinner />}Sign in</button>
      <div className="rounded-lg border border-dashed border-line p-3 text-xs text-muted">
        <p className="mb-2 font-medium text-fg">Demo accounts · password <code className="mono text-accent">opsmeridian-demo</code></p>
        <div className="flex flex-wrap gap-1.5">{DEMO.map(([e, r]) => <button type="button" key={e} onClick={() => { setEmail(e); setPassword("opsmeridian-demo"); }} className="rounded-md border border-line bg-raised px-2 py-1 hover:border-accent/50">{r}</button>)}</div>
      </div>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      <div className="relative hidden overflow-hidden border-r border-line bg-panel p-12 lg:flex lg:flex-col lg:justify-between">
        <div className="pointer-events-none absolute -left-40 -top-40 h-[32rem] w-[32rem] rounded-full bg-accent/20 blur-3xl" />
        <div className="relative flex items-center gap-3"><img src="/favicon.svg" alt="" className="h-9 w-9" /><span className="text-lg font-semibold">OpsMeridian</span></div>
        <div className="relative">
          <h1 className="max-w-md text-4xl font-semibold leading-tight tracking-tight">From first alert to verified fix, in minutes.</h1>
          <ul className="mt-8 space-y-4 text-sm text-muted">
            {[[Radar, "Detects anomalies across logs, metrics and deploys, and correlates them through your dependency graph"], [Workflow, "An AI agent investigates like your best SRE: timeline, blast radius, diffs, error signatures"], [BookOpenCheck, "Every hypothesis cites the exact runbook and postmortem passages it relies on"], [GitPullRequestDraft, "Verified patches become draft PRs only after a human approves"]].map(([Icon, t], i) => {
              const I = Icon as typeof Radar;
              return <li key={i} className="flex gap-3"><I className="mt-0.5 h-4 w-4 shrink-0 text-accent" />{t as string}</li>;
            })}
          </ul>
        </div>
        <p className="relative text-xs text-subtle">Autonomous production incident &amp; root-cause investigator</p>
      </div>
      <div className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="mb-8 lg:hidden"><img src="/favicon.svg" alt="" className="h-10 w-10" /></div>
          <h2 className="text-2xl font-semibold tracking-tight">Sign in</h2>
          <p className="mb-6 mt-1 text-sm text-muted">Access your incident command center</p>
          <Suspense fallback={<Spinner />}><LoginForm /></Suspense>
        </div>
      </div>
    </div>
  );
}
