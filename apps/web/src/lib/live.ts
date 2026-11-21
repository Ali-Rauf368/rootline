"use client";
import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { api } from "./api";

const API_PUBLIC = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4100";
export type LiveEvent = { type: string; incidentId?: number; [k: string]: unknown };
export type LiveState = "connecting" | "live" | "offline";

/**
 * One Socket.IO connection for the console. Auth is a fresh 2-minute stream ticket fetched on
 * every (re)connect attempt, so long-lived tabs never hold a reusable credential. Socket.IO handles
 * reconnect with backoff and falls back from WebSocket to HTTP long-polling behind strict proxies.
 */
export function useRealtime(onEvent: (e: LiveEvent) => void) {
  const [state, setState] = useState<LiveState>("connecting");
  const [socket, setSocket] = useState<Socket | null>(null);
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    const s = io(API_PUBLIC, {
      path: "/socket.io",
      transports: ["websocket", "polling"],
      withCredentials: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 15_000,
      auth: (cb) => { api<{ ticket: string }>("/api/auth/stream-ticket").then(({ ticket }) => cb({ ticket }), () => cb({})); },
    });
    s.on("ready", () => setState("live"));
    s.on("disconnect", () => setState("offline"));
    s.on("connect_error", () => setState("offline"));
    s.io.on("reconnect_attempt", () => setState("connecting"));
    s.onAny((type: string, payload: unknown) => {
      if (type === "ready") return;
      handler.current({ ...(payload && typeof payload === "object" ? payload : {}), type } as LiveEvent);
    });
    setSocket(s);
    return () => { s.removeAllListeners(); s.close(); setSocket(null); };
  }, []);
  return { state, socket };
}
