"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";

const API_PUBLIC = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4100";
export type LiveEvent = { type: string; incidentId?: number; [k: string]: unknown };

/**
 * Server-Sent Events with a short-lived ticket, automatic reconnect with backoff,
 * and a connection state for the UI's "live" indicator.
 */
export function useLive(onEvent: (e: LiveEvent) => void, { incident }: { incident?: number } = {}) {
  const [state, setState] = useState<"connecting" | "live" | "offline">("connecting");
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    let es: EventSource | null = null, stopped = false, retry = 0, timer: ReturnType<typeof setTimeout>;
    const types = ["incident.created", "incident.updated", "incident.event", "investigation.step", "investigation.status", "hypotheses.updated", "fix.updated", "metrics.tick", "log", "deploy"];
    const connect = async () => {
      try {
        const { ticket } = await api<{ ticket: string }>("/api/auth/stream-ticket");
        if (stopped) return;
        es = new EventSource(`${API_PUBLIC}/api/stream?ticket=${encodeURIComponent(ticket)}${incident ? `&incident=${incident}` : ""}`);
        es.addEventListener("ready", () => { retry = 0; setState("live"); });
        for (const t of types) es.addEventListener(t, (m) => { try { handler.current(JSON.parse((m as MessageEvent).data)); } catch { /* ignore */ } });
        es.onerror = () => { es?.close(); setState("offline"); schedule(); };
      } catch { setState("offline"); schedule(); }
    };
    const schedule = () => { if (!stopped) timer = setTimeout(connect, Math.min(15_000, 1000 * 2 ** retry++)); };
    connect();
    return () => { stopped = true; clearTimeout(timer); es?.close(); };
  }, [incident]);
  return state;
}
