"use client";
import { useMemo, useState } from "react";
import { Bot, ShieldCheck, Radar, Users, Bell, Volume2, Rows3, Sparkles, Eye, Lock, RotateCcw, Radio, Info } from "lucide-react";
import { api, useApi } from "@/lib/api";
import { useFlags, usePrefs, useSession, can, type Flag, type Prefs } from "@/components/shell";
import { Card, CardHeader, PageHeader, Badge, Modal, Spinner, Toggle, useToast, cx } from "@/components/ui";
import { useLiveEvents } from "@/components/shell";

const GROUP_ICON: Record<string, React.ComponentType<{ className?: string }>> = { Agent: Bot, Safety: ShieldCheck, Detection: Radar, Collaboration: Users };
// toggles that change who gets paged or what reaches production deserve a confirmation
const CONFIRM: Record<string, (on: boolean) => string | null> = {
  maintenance_mode: (on) => (on ? "New incidents will not be opened while maintenance mode is on. Signals are still recorded. Make sure planned work is announced." : null),
  anomaly_detection: (on) => (on ? null : "Metric anomalies will no longer open incidents. Only Alertmanager alerts and manual incidents will page."),
  two_person_approval: (on) => (on ? null : "A single responder will be able to approve fixes and open draft PRs."),
};

export default function SettingsPage() {
  const user = useSession();
  const admin = can(user, "admin");
  const { flags, reload } = useFlags();
  const toast = useToast();
  const [pending, setPending] = useState<string | null>(null);
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({});
  const [confirm, setConfirm] = useState<{ flag: Flag; value: boolean; text: string } | null>(null);
  const rt = useApi<{ sockets: number; warRooms: number }>("/api/realtime", { refreshMs: 10_000 });
  const [lastChange, setLastChange] = useState<string | null>(null);
  useLiveEvents((e) => { if (e.type === "flags.updated") setLastChange(new Date().toLocaleTimeString()); });

  const groups = useMemo(() => {
    const m = new Map<string, Flag[]>();
    for (const f of flags) m.set(f.group, [...(m.get(f.group) ?? []), f]);
    return [...m.entries()];
  }, [flags]);
  const value = (f: Flag) => optimistic[f.key] ?? f.enabled;
  const modified = flags.filter((f) => f.enabled !== f.default);

  const apply = async (patch: Record<string, boolean>) => {
    const keys = Object.keys(patch);
    setPending(keys.length === 1 ? keys[0] : "*");
    setOptimistic((o) => ({ ...o, ...patch }));
    try {
      await api("/api/flags", { method: "PUT", json: patch });
      reload();
      toast(keys.length === 1 ? `${flags.find((f) => f.key === keys[0])?.label}: ${patch[keys[0]] ? "on" : "off"}` : "Toggles reset to defaults", "ok");
    } catch (e) { toast((e as Error).message, "bad"); }
    finally { setOptimistic((o) => { const n = { ...o }; keys.forEach((k) => delete n[k]); return n; }); setPending(null); }
  };
  const flip = (f: Flag, v: boolean) => {
    const text = CONFIRM[f.key]?.(v);
    if (text) setConfirm({ flag: f, value: v, text });
    else apply({ [f.key]: v });
  };

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Platform" title="Settings & feature toggles" subtitle="Runtime switches take effect across the API and every worker within milliseconds, without a deploy. Every change is written to the audit log." />

      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="card-pad flex items-center gap-3"><div className="rounded-lg bg-accent/12 p-2 text-accent"><Radio className="h-5 w-5" /></div><div><p className="text-xs text-muted">Live connections</p><p className="text-lg font-semibold tabular-nums">{rt.data?.sockets ?? "–"}</p></div></Card>
        <Card className="card-pad flex items-center gap-3"><div className="rounded-lg bg-warn/12 p-2 text-warn"><Users className="h-5 w-5" /></div><div><p className="text-xs text-muted">Active war rooms</p><p className="text-lg font-semibold tabular-nums">{rt.data?.warRooms ?? "–"}</p></div></Card>
        <Card className="card-pad flex items-center gap-3"><div className="rounded-lg bg-ok/12 p-2 text-ok"><Sparkles className="h-5 w-5" /></div><div><p className="text-xs text-muted">Toggles changed from default</p><p className="text-lg font-semibold tabular-nums">{modified.length} <span className="text-xs font-normal text-subtle">of {flags.length}</span></p></div></Card>
      </div>

      {!admin && <div className="flex items-center gap-2 rounded-lg border border-line bg-panel px-4 py-3 text-sm text-muted"><Lock className="h-4 w-4 shrink-0" />Only admins can change workspace toggles. You can still set your personal preferences below.</div>}

      <div className="grid gap-5 xl:grid-cols-2">
        {groups.map(([group, items]) => {
          const Icon = GROUP_ICON[group] ?? Info;
          return (
            <Card key={group} className="card-pad">
              <CardHeader title={group} icon={Icon} subtitle={`${items.filter(value).length} of ${items.length} on`} />
              <ul className="divide-y divide-line">
                {items.map((f) => (
                  <li key={f.key} className="flex items-start justify-between gap-4 py-3.5 first:pt-1 last:pb-0">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium">{f.label}</p>
                        {f.enabled !== f.default && <Badge tone="warn">modified</Badge>}
                      </div>
                      <p className="mt-0.5 text-xs leading-relaxed text-muted">{f.description}</p>
                      <p className="mt-1 text-[10px] text-subtle mono">{f.key} · default {f.default ? "on" : "off"}</p>
                    </div>
                    <Toggle label={f.label} checked={value(f)} onChange={(v) => flip(f, v)} disabled={!admin} pending={pending === f.key || pending === "*"} />
                  </li>
                ))}
              </ul>
            </Card>
          );
        })}
      </div>

      {admin && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-subtle">{lastChange ? `Last change pushed live at ${lastChange}` : "Changes are pushed to every open console over Socket.IO."}</p>
          <button className="btn-secondary" disabled={!modified.length || !!pending} onClick={() => apply(Object.fromEntries(modified.map((f) => [f.key, f.default])))}><RotateCcw className="h-4 w-4" />Reset to defaults</button>
        </div>
      )}

      <PersonalPrefs />

      <Modal open={!!confirm} onClose={() => setConfirm(null)} title={`Turn ${confirm?.value ? "on" : "off"} “${confirm?.flag.label}”?`}
        footer={<><button className="btn-secondary" onClick={() => setConfirm(null)}>Cancel</button><button className={confirm?.value ? "btn-primary" : "btn-danger"} onClick={() => { if (confirm) apply({ [confirm.flag.key]: confirm.value }); setConfirm(null); }}>{pending && <Spinner />}Confirm</button></>}>
        <p className="text-sm text-muted">{confirm?.text}</p>
      </Modal>
    </div>
  );
}

function PersonalPrefs() {
  const { prefs, setPref } = usePrefs();
  const toast = useToast();
  const items: { key: keyof Prefs; label: string; description: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { key: "desktopNotifications", label: "Desktop notifications", description: "Notify me about new incidents while this tab is in the background.", icon: Bell },
    { key: "soundAlerts", label: "Sound alerts", description: "Play a short chime when a new incident opens.", icon: Volume2 },
    { key: "followAgent", label: "Follow agent activity", description: "Auto-scroll the agent feed as new steps stream in.", icon: Eye },
    { key: "compact", label: "Compact density", description: "Tighter cards and tables to fit more on screen.", icon: Rows3 },
    { key: "reduceMotion", label: "Reduce motion", description: "Turn off animations and pulsing indicators.", icon: Sparkles },
  ];
  const set = async (k: keyof Prefs, v: boolean) => {
    if (k === "desktopNotifications" && v) {
      if (typeof Notification === "undefined") return toast("This browser does not support notifications", "bad");
      const p = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
      if (p !== "granted") return toast("Notifications are blocked for this site in your browser settings", "bad");
    }
    setPref(k, v);
  };
  return (
    <Card className="card-pad">
      <CardHeader title="Personal preferences" subtitle="Saved in this browser only" icon={Users} />
      <ul className="grid gap-x-8 sm:grid-cols-2">
        {items.map(({ key, label, description, icon: Icon }) => (
          <li key={key} className="flex items-start justify-between gap-4 border-b border-line py-3.5 last:border-0 sm:[&:nth-last-child(2):nth-child(odd)]:border-0">
            <div className="flex min-w-0 gap-3"><Icon className={cx("mt-0.5 h-4 w-4 shrink-0", prefs[key] ? "text-accent" : "text-subtle")} /><div><p className="text-sm font-medium">{label}</p><p className="mt-0.5 text-xs text-muted">{description}</p></div></div>
            <Toggle size="sm" label={label} checked={prefs[key]} onChange={(v) => set(key, v)} />
          </li>
        ))}
      </ul>
    </Card>
  );
}
