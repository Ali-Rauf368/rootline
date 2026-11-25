"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertOctagon, Boxes, ScrollText, GitCommitHorizontal, BookOpen, Plug, ShieldCheck, Menu, X, Sun, Moon, LogOut, Search, Zap, ChevronRight, CornerDownLeft, Settings2, Wrench, CircleDollarSign } from "lucide-react";
import { api, useApi } from "@/lib/api";
import { useRealtime, type LiveEvent, type LiveState } from "@/lib/live";
import type { Socket } from "socket.io-client";
import { LiveDot, SeverityBadge } from "./domain";
import { Modal, Spinner, ToastProvider, useToast, cx } from "./ui";

export interface User { id: number; name: string; email: string; role: "viewer" | "responder" | "admin" }
const SessionCtx = createContext<User | null>(null);
export const useSession = () => useContext(SessionCtx);
export const can = (u: User | null, role: User["role"]) => !!u && ["viewer", "responder", "admin"].indexOf(u.role) >= ["viewer", "responder", "admin"].indexOf(role);

/** One Socket.IO connection for the whole console; components subscribe to the events they care about. */
type Listener = (e: LiveEvent) => void;
const LiveCtx = createContext<{ state: LiveState; subscribe: (l: Listener) => () => void; socket: Socket | null }>({ state: "connecting", subscribe: () => () => {}, socket: null });
export const useSocket = () => useContext(LiveCtx).socket;

/** Feature toggles (server-side, admin-controlled), pushed live when flipped. */
export interface Flag { key: string; label: string; description: string; group: string; default: boolean; enabled: boolean }
const FlagsCtx = createContext<{ flags: Flag[]; on: (k: string) => boolean; reload: () => void }>({ flags: [], on: () => true, reload: () => {} });
export const useFlags = () => useContext(FlagsCtx);

/** Personal preferences (this browser only). */
export interface Prefs { desktopNotifications: boolean; soundAlerts: boolean; compact: boolean; reduceMotion: boolean; followAgent: boolean }
const DEFAULT_PREFS: Prefs = { desktopNotifications: false, soundAlerts: false, compact: false, reduceMotion: false, followAgent: true };
const PrefsCtx = createContext<{ prefs: Prefs; setPref: <K extends keyof Prefs>(k: K, v: Prefs[K]) => void }>({ prefs: DEFAULT_PREFS, setPref: () => {} });
export const usePrefs = () => useContext(PrefsCtx);
function usePrefsState() {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  useEffect(() => { try { setPrefs({ ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem("rl-prefs") ?? "{}") }); } catch { /* ignore */ } }, []);
  useEffect(() => {
    document.documentElement.classList.toggle("compact", prefs.compact);
    document.documentElement.classList.toggle("reduce-motion", prefs.reduceMotion);
  }, [prefs.compact, prefs.reduceMotion]);
  const setPref = useCallback(<K extends keyof Prefs>(k: K, v: Prefs[K]) => setPrefs((p) => { const n = { ...p, [k]: v }; try { localStorage.setItem("rl-prefs", JSON.stringify(n)); } catch { /* ignore */ } return n; }), []);
  return { prefs, setPref };
}
function chime() {
  try {
    const ctx = new AudioContext(), o = ctx.createOscillator(), g = ctx.createGain();
    o.type = "sine"; o.frequency.setValueAtTime(880, ctx.currentTime); o.frequency.setValueAtTime(660, ctx.currentTime + 0.12);
    g.gain.setValueAtTime(0.0001, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.4);
  } catch { /* audio unavailable */ }
}
export function useLiveEvents(fn: Listener, deps: unknown[] = []) {
  const { subscribe } = useContext(LiveCtx);
  const ref = useRef(fn); ref.current = fn;
  useEffect(() => subscribe((e) => ref.current(e)), [subscribe, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
}

const NAV = [
  { group: "Operate", items: [
    { href: "/", label: "Overview", icon: Activity },
    { href: "/incidents", label: "Incidents", icon: AlertOctagon, badge: "incidents" },
    { href: "/services", label: "Services", icon: Boxes },
    { href: "/logs", label: "Logs", icon: ScrollText },
    { href: "/changes", label: "Changes", icon: GitCommitHorizontal },
    { href: "/costs", label: "Cloud costs", icon: CircleDollarSign },
  ] },
  { group: "Knowledge", items: [{ href: "/knowledge", label: "Runbooks & docs", icon: BookOpen }] },
  { group: "Platform", items: [{ href: "/integrations", label: "Integrations", icon: Plug }, { href: "/audit", label: "Audit log", icon: ShieldCheck }, { href: "/settings", label: "Settings & toggles", icon: Settings2 }] },
];

function useTheme() {
  const [dark, setDark] = useState(true);
  useEffect(() => setDark(document.documentElement.classList.contains("dark")), []);
  const toggle = () => { const next = !dark; setDark(next); document.documentElement.classList.toggle("dark", next); try { localStorage.setItem("rl-theme", next ? "dark" : "light"); } catch { /* ignore */ } };
  return { dark, toggle };
}

export function Shell({ children }: { children: ReactNode }) {
  return <ToastProvider><ShellInner>{children}</ShellInner></ToastProvider>;
}

function ShellInner({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const me = useApi<{ user: User }>("/api/auth/me");
  const open = useApi<{ id: number }[]>("/api/incidents?status=open&limit=200", { refreshMs: 30_000 });
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  const [sim, setSim] = useState(false);
  const { dark, toggle } = useTheme();
  const listeners = useRef(new Set<Listener>());
  const toast = useToast();
  const router = useRouter();

  const flagsApi = useApi<Flag[]>("/api/flags");
  const { prefs, setPref } = usePrefsState();
  const prefsRef = useRef(prefs); prefsRef.current = prefs;
  const { state, socket } = useRealtime((e) => {
    listeners.current.forEach((l) => l(e));
    if (e.type === "flags.updated") flagsApi.reload();
    if (e.type === "incident.created") {
      open.reload();
      toast("New incident detected. The agent is investigating.", "info");
      if (prefsRef.current.soundAlerts) chime();
      if (prefsRef.current.desktopNotifications && typeof Notification !== "undefined" && Notification.permission === "granted" && document.hidden) {
        const n = new Notification("OpsMeridian: new incident", { body: "The agent has started investigating.", tag: `inc-${e.incidentId}`, icon: "/favicon.svg" });
        n.onclick = () => { window.focus(); router.push(`/incidents/${e.incidentId}`); };
      }
    }
    if (e.type === "incident.updated") open.reload();
  });
  const subscribe = useCallback((l: Listener) => { listeners.current.add(l); return () => { listeners.current.delete(l); }; }, []);
  const live = useMemo(() => ({ state, subscribe, socket }), [state, subscribe, socket]);
  const flagList = flagsApi.data;
  const flags = useMemo(() => ({ flags: flagList ?? [], on: (k: string) => flagList?.find((f) => f.key === k)?.enabled ?? true, reload: flagsApi.reload }), [flagList, flagsApi.reload]);
  const prefsValue = useMemo(() => ({ prefs, setPref }), [prefs, setPref]);

  useEffect(() => setDrawer(false), [pathname]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette((p) => !p); } };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  if (!me.data) return <div className="flex h-screen items-center justify-center text-accent">{me.error ? <p className="text-sm text-bad">{me.error}</p> : <Spinner className="h-6 w-6" />}</div>;
  const user = me.data.user;
  const openCount = open.data?.length ?? 0;
  const logout = async () => { await api("/api/auth/logout", { method: "POST" }); router.push("/login"); };

  const nav = (
    <nav className="flex h-full flex-col" aria-label="Main">
      <Link href="/" className="mb-6 flex items-center gap-2.5 px-3 pt-1">
        <img src="/favicon.svg" alt="" className="h-8 w-8" />
        <div><p className="text-sm font-semibold leading-tight">OpsMeridian</p><p className="text-[11px] text-subtle">Incident &amp; cost intelligence</p></div>
      </Link>
      <div className="flex-1 space-y-5 overflow-y-auto">
        {NAV.map((g) => (
          <div key={g.group}>
            <p className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-wider text-subtle">{g.group}</p>
            {g.items.map(({ href, label, icon: Icon, badge }) => {
              const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
              return (
                <Link key={href} href={href} className={cx("group mb-0.5 flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition", active ? "bg-accent/12 font-medium text-accent" : "text-muted hover:bg-raised hover:text-fg")}>
                  <Icon className="h-4 w-4" /><span className="flex-1">{label}</span>
                  {badge && openCount > 0 && <span className="rounded-full bg-bad px-1.5 text-[10px] font-semibold text-white tabular-nums">{openCount}</span>}
                </Link>
              );
            })}
          </div>
        ))}
      </div>
      <div className="mt-4 border-t border-line pt-3">
        <div className="flex items-center gap-2.5 px-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-accent/15 text-xs font-semibold text-accent">{user.name.split(" ").map((p) => p[0]).join("").slice(0, 2)}</div>
          <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{user.name}</p><p className="text-[11px] capitalize text-subtle">{user.role}</p></div>
          <button onClick={logout} className="btn-ghost p-1.5" aria-label="Sign out" title="Sign out"><LogOut className="h-4 w-4" /></button>
        </div>
      </div>
    </nav>
  );

  return (
    <SessionCtx.Provider value={user}>
      <LiveCtx.Provider value={live}><FlagsCtx.Provider value={flags}><PrefsCtx.Provider value={prefsValue}>
        <div className="min-h-screen">
          <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-line bg-panel p-3 lg:block">{nav}</aside>
          {drawer && <div className="fixed inset-0 z-40 lg:hidden"><div className="absolute inset-0 bg-black/50" onClick={() => setDrawer(false)} /><aside className="absolute inset-y-0 left-0 w-72 animate-fadeIn border-r border-line bg-panel p-3"><button className="btn-ghost absolute right-2 top-2 p-1.5" onClick={() => setDrawer(false)} aria-label="Close menu"><X className="h-4 w-4" /></button>{nav}</aside></div>}
          <div className="lg:pl-60">
            <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-line bg-bg/80 px-4 backdrop-blur sm:px-6">
              <button className="btn-ghost p-1.5 lg:hidden" onClick={() => setDrawer(true)} aria-label="Open menu"><Menu className="h-5 w-5" /></button>
              <button onClick={() => setPalette(true)} className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-line bg-panel px-3 text-sm text-subtle transition hover:border-accent/40 sm:max-w-sm">
                <Search className="h-4 w-4 shrink-0" /><span className="truncate">Jump to incident, service, page…</span><span className="kbd ml-auto hidden sm:inline">Ctrl K</span>
              </button>
              <div className="ml-auto flex items-center gap-1.5 sm:gap-3">
                <LiveDot state={state} />
                {can(user, "responder") && <button className="btn-secondary px-2.5 py-1.5 text-xs" onClick={() => setSim(true)} title="Inject a failure scenario"><Zap className="h-3.5 w-3.5 text-warn" /><span className="hidden sm:inline">Simulate</span></button>}
                <button className="btn-ghost p-2" onClick={toggle} aria-label="Toggle theme">{dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}</button>
              </div>
            </header>
            {flags.on("maintenance_mode") && (
              <div className="flex items-center gap-2 border-b border-warn/30 bg-warn/10 px-4 py-2 text-xs text-warn sm:px-6" role="status">
                <Wrench className="h-3.5 w-3.5 shrink-0" /><span><b>Maintenance mode is on.</b> Signals are still recorded, but no new incidents will be opened.</span>
                {can(user, "admin") && <Link href="/settings" className="ml-auto shrink-0 font-medium underline underline-offset-2">Manage</Link>}
              </div>
            )}
            <main className="mx-auto max-w-[1500px] px-4 py-6 sm:px-6 lg:px-8">{children}</main>
          </div>
          <CommandPalette open={palette} onClose={() => setPalette(false)} />
          <SimulateDialog open={sim} onClose={() => setSim(false)} />
        </div>
      </PrefsCtx.Provider></FlagsCtx.Provider></LiveCtx.Provider>
    </SessionCtx.Provider>
  );
}

function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [qText, setQ] = useState("");
  const [active, setActive] = useState(0);
  const incidents = useApi<{ id: number; key: string; title: string; severity: "sev1" }[]>(open ? "/api/incidents?limit=50" : null);
  const services = useApi<{ name: string; display_name: string }[]>(open ? "/api/services" : null);
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setQ(""); setActive(0); setTimeout(() => inputRef.current?.focus(), 10); } }, [open]);
  const ql = qText.toLowerCase();
  const items = [
    ...(incidents.data ?? []).filter((i) => !ql || `${i.key} ${i.title}`.toLowerCase().includes(ql)).slice(0, 6).map((i) => ({ href: `/incidents/${i.id}`, label: `${i.key} · ${i.title}`, group: "Incidents", sev: i.severity })),
    ...(services.data ?? []).filter((s) => !ql || `${s.name} ${s.display_name}`.toLowerCase().includes(ql)).slice(0, 5).map((s) => ({ href: `/services/${s.name}`, label: s.display_name, group: "Services", sev: undefined })),
    ...NAV.flatMap((g) => g.items).filter((n) => !ql || n.label.toLowerCase().includes(ql)).map((n) => ({ href: n.href, label: n.label, group: "Pages", sev: undefined })),
  ].slice(0, 14);
  useEffect(() => setActive(0), [qText]);
  if (!open) return null;
  const go = (href: string) => { onClose(); router.push(href); };
  let last = "";
  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-black/50 p-4 pt-[12vh] backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="card w-full max-w-xl animate-fadeIn overflow-hidden shadow-2xl" role="dialog" aria-label="Command palette">
        <div className="flex items-center gap-3 border-b border-line px-4">
          <Search className="h-4 w-4 text-subtle" />
          <input ref={inputRef} value={qText} onChange={(e) => setQ(e.target.value)} placeholder="Search incidents, services, pages…" className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-subtle"
            onKeyDown={(e) => { if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1)); } if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); } if (e.key === "Enter" && items[active]) go(items[active].href); if (e.key === "Escape") onClose(); }} />
          <span className="kbd">ESC</span>
        </div>
        <ul className="max-h-[55vh] overflow-y-auto p-2" role="listbox">
          {items.map((it, i) => {
            const header = it.group !== last ? (last = it.group) : null;
            return (
              <li key={`${it.href}-${i}`}>
                {header && <p className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-subtle">{header}</p>}
                <button role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onClick={() => go(it.href)} className={cx("flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm", i === active ? "bg-accent text-white" : "")}>
                  {it.sev && <SeverityBadge s={it.sev} />}<span className="flex-1 truncate">{it.label}</span>{i === active ? <CornerDownLeft className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5 text-subtle" />}
                </button>
              </li>
            );
          })}
          {!items.length && <li className="px-3 py-8 text-center text-sm text-muted">No matches</li>}
        </ul>
      </div>
    </div>
  );
}

function SimulateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const scenarios = useApi<{ id: string; name: string; description: string; service: string }[]>(open ? "/api/sim/scenarios" : null);
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();
  const run = async (id: string) => {
    setBusy(id);
    try { const r = await api<{ message: string }>(`/api/sim/scenarios/${id}`, { method: "POST" }); toast(r.message, "info"); onClose(); }
    catch (e) { toast((e as Error).message, "bad"); }
    finally { setBusy(null); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Game day: inject a failure" wide>
      <p className="mb-4 text-sm text-muted">Each scenario ships a realistic change and degrades live telemetry. Watch OpsMeridian detect it, correlate signals, investigate and propose a verified fix.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {(scenarios.data ?? []).map((s) => (
          <button key={s.id} onClick={() => run(s.id)} disabled={!!busy} className="card group flex flex-col items-start gap-2 p-4 text-left transition hover:border-accent/50 hover:shadow-glow">
            <span className="flex w-full items-center justify-between"><span className="text-xs font-medium text-accent mono">{s.service}</span>{busy === s.id ? <Spinner /> : <Zap className="h-4 w-4 text-warn opacity-60 group-hover:opacity-100" />}</span>
            <span className="text-sm font-semibold">{s.name}</span>
            <span className="text-xs text-muted">{s.description}</span>
          </button>
        ))}
        {scenarios.loading && <Spinner />}
      </div>
    </Modal>
  );
}
