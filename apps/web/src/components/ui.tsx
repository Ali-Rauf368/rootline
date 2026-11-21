"use client";
import clsx from "clsx";
import { Loader2, X, Inbox, AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";

export const cx = clsx;

export function Spinner({ className = "h-4 w-4" }: { className?: string }) { return <Loader2 className={cx("animate-spin", className)} aria-label="Loading" />; }

export function Card({ className, children, ...p }: React.HTMLAttributes<HTMLDivElement>) { return <div className={cx("card", className)} {...p}>{children}</div>; }

export function CardHeader({ title, subtitle, action, icon: Icon }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode; icon?: React.ComponentType<{ className?: string }> }) {
  return (
    <div className="mb-4 flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-2.5">
        {Icon && <Icon className="mt-0.5 h-4 w-4 shrink-0 text-accent" />}
        <div className="min-w-0"><h2 className="text-sm font-semibold">{title}</h2>{subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}</div>
      </div>
      {action}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions, eyebrow }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1 text-xs font-medium uppercase tracking-wider text-accent">{eyebrow}</div>}
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

const TONES = {
  neutral: "bg-raised text-muted border-line", accent: "bg-accent/12 text-accent border-accent/25", ok: "bg-ok/12 text-ok border-ok/25",
  warn: "bg-warn/12 text-warn border-warn/30", bad: "bg-bad/12 text-bad border-bad/30", info: "bg-info/12 text-info border-info/25",
} as const;
export type Tone = keyof typeof TONES;
export function Badge({ tone = "neutral", children, className, dot }: { tone?: Tone; children: ReactNode; className?: string; dot?: boolean }) {
  return <span className={cx("inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[11px] font-medium", TONES[tone], className)}>{dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}{children}</span>;
}

export function Stat({ label, value, hint, icon: Icon, tone = "accent", trend }: { label: string; value: ReactNode; hint?: ReactNode; icon?: React.ComponentType<{ className?: string }>; tone?: Tone; trend?: ReactNode }) {
  return (
    <Card className="card-pad relative overflow-hidden">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted">{label}</p>
        {Icon && <span className={cx("flex h-7 w-7 items-center justify-center rounded-lg border", TONES[tone])}><Icon className="h-3.5 w-3.5" /></span>}
      </div>
      <p className="mt-2 text-2xl font-semibold tabular-nums tracking-tight">{value}</p>
      <div className="mt-1 flex items-center gap-2 text-xs text-muted">{trend}{hint}</div>
    </Card>
  );
}

export function Empty({ icon: Icon = Inbox, title, message, action }: { icon?: React.ComponentType<{ className?: string }>; title: string; message?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-line bg-raised text-subtle"><Icon className="h-5 w-5" /></div>
      <p className="text-sm font-medium">{title}</p>
      {message && <p className="mt-1 max-w-sm text-sm text-muted">{message}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-bad/30 bg-bad/10 p-4 text-sm text-bad" role="alert">
      <AlertTriangle className="h-4 w-4 shrink-0" /><span className="flex-1">{message}</span>
      {onRetry && <button className="btn-secondary px-2.5 py-1 text-xs" onClick={onRetry}>Retry</button>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) { return <div className={cx("animate-pulse rounded-lg bg-raised", className)} />; }

export function Tabs<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; count?: number }[] }) {
  return (
    <div className="inline-flex rounded-lg border border-line bg-raised p-0.5" role="tablist">
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={value === o.value} onClick={() => onChange(o.value)}
          className={cx("flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition", value === o.value ? "bg-panel text-fg shadow-sm" : "text-muted hover:text-fg")}>
          {o.label}{o.count !== undefined && <span className="rounded bg-line/70 px-1 text-[10px] tabular-nums">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", k);
    ref.current?.querySelector<HTMLElement>("input,textarea,select")?.focus();
    return () => document.removeEventListener("keydown", k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 backdrop-blur-sm sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal aria-label={title} className={cx("card max-h-[92vh] w-full animate-fadeIn overflow-y-auto rounded-b-none shadow-2xl sm:rounded-xl", wide ? "max-w-3xl" : "max-w-lg")}>
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5"><h3 className="text-sm font-semibold">{title}</h3><button className="btn-ghost p-1.5" onClick={onClose} aria-label="Close"><X className="h-4 w-4" /></button></div>
        <div className="p-5">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfidenceBar({ value, className }: { value: number; className?: string }) {
  const v = Math.round(value * 100);
  const tone = v >= 75 ? "bg-ok" : v >= 50 ? "bg-warn" : "bg-subtle";
  return (
    <div className={cx("flex items-center gap-2", className)} title={`Confidence ${v}%`}>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised" role="meter" aria-valuenow={v} aria-valuemin={0} aria-valuemax={100} aria-label="Confidence">
        <div className={cx("h-full rounded-full transition-all duration-700", tone)} style={{ width: `${v}%` }} />
      </div>
      <span className="w-9 text-right text-xs font-semibold tabular-nums">{v}%</span>
    </div>
  );
}

// ---- toasts ----
type Toast = { id: number; tone: "ok" | "bad" | "info"; text: string };
const ToastCtx = createContext<(text: string, tone?: Toast["tone"]) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Toast["tone"] = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, tone, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "bad" ? 6000 : 3500);
  }, []);
  const Icon = { ok: CheckCircle2, bad: AlertTriangle, info: Info };
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
        {toasts.map((t) => { const I = Icon[t.tone]; return (
          <div key={t.id} className="card pointer-events-auto flex animate-fadeIn items-start gap-2.5 p-3 text-sm shadow-xl">
            <I className={cx("mt-0.5 h-4 w-4 shrink-0", t.tone === "ok" ? "text-ok" : t.tone === "bad" ? "text-bad" : "text-info")} /><span>{t.text}</span>
          </div>); })}
      </div>
    </ToastCtx.Provider>
  );
}

/** Accessible switch (role="switch"), keyboard operable, with an optional pending state. */
export function Toggle({ checked, onChange, disabled, pending, label, size = "md" }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; pending?: boolean; label: string; size?: "sm" | "md" }) {
  const dims = size === "sm" ? { track: "h-5 w-9", knob: "h-4 w-4", on: "translate-x-4" } : { track: "h-6 w-11", knob: "h-5 w-5", on: "translate-x-5" };
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled || pending} onClick={() => onChange(!checked)}
      className={cx("relative inline-flex shrink-0 items-center rounded-full border border-transparent transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-not-allowed disabled:opacity-50",
        dims.track, checked ? "bg-accent" : "bg-line")}>
      <span className={cx("pointer-events-none flex items-center justify-center rounded-full bg-white shadow-sm ring-0 transition-transform duration-200", dims.knob, checked ? dims.on : "translate-x-0.5")}>
        {pending && <Loader2 className="h-3 w-3 animate-spin text-accent" />}
      </span>
    </button>
  );
}
