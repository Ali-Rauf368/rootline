"use client";
import { Badge, cx } from "./ui";
import { Flame, Search, Crosshair, ShieldCheck, CheckCircle2, Radar } from "lucide-react";

export const SEV = { sev1: { tone: "bad", label: "SEV1" }, sev2: { tone: "warn", label: "SEV2" }, sev3: { tone: "info", label: "SEV3" }, sev4: { tone: "neutral", label: "SEV4" } } as const;
export function SeverityBadge({ s }: { s: keyof typeof SEV }) { return <Badge tone={SEV[s]?.tone ?? "neutral"} className="font-semibold">{SEV[s]?.label ?? s}</Badge>; }

export const STATUS = {
  detected: { tone: "bad", label: "Detected", icon: Radar },
  investigating: { tone: "warn", label: "Investigating", icon: Search },
  identified: { tone: "accent", label: "Identified", icon: Crosshair },
  mitigating: { tone: "info", label: "Mitigating", icon: ShieldCheck },
  resolved: { tone: "ok", label: "Resolved", icon: CheckCircle2 },
} as const;
export function StatusBadge({ s }: { s: keyof typeof STATUS }) { const x = STATUS[s]; return <Badge tone={x?.tone ?? "neutral"} dot>{x?.label ?? s}</Badge>; }

export function LiveDot({ state }: { state: "connecting" | "live" | "offline" }) {
  const color = state === "live" ? "bg-ok" : state === "connecting" ? "bg-warn" : "bg-bad";
  return (
    <span className="inline-flex items-center gap-2 text-xs text-muted" title={`Realtime: ${state}`}>
      <span className="relative flex h-2 w-2">{state === "live" && <span className={cx("absolute inset-0 animate-pulseRing rounded-full", color)} />}<span className={cx("relative h-2 w-2 rounded-full", color)} /></span>
      <span className="hidden sm:inline">{state === "live" ? "Live" : state === "connecting" ? "Connecting" : "Reconnecting"}</span>
    </span>
  );
}

/** Health from current error rate vs SLO budget and latency vs SLO. */
export function health(s: { error_rate: number | null; latency_p95_ms: number | null; slo_availability: number; slo_latency_ms: number; open_incidents?: number }) {
  const budget = 1 - Number(s.slo_availability) / 100;
  const e = Number(s.error_rate ?? 0), l = Number(s.latency_p95_ms ?? 0);
  if ((s.open_incidents ?? 0) > 0 || e > budget * 20 || l > s.slo_latency_ms * 3) return { tone: "bad" as const, label: "Degraded", icon: Flame };
  if (e > budget * 5 || l > s.slo_latency_ms) return { tone: "warn" as const, label: "At risk" };
  return { tone: "ok" as const, label: "Healthy" };
}
