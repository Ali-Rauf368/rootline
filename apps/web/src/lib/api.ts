"use client";
import { useCallback, useEffect, useRef, useState } from "react";

export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }

/** Same-origin fetch through the Next.js rewrite; the session cookie rides along. */
export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const { json, ...rest } = init;
  const res = await fetch(path, { ...rest, credentials: "include", headers: { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...rest.headers }, body: json !== undefined ? JSON.stringify(json) : rest.body });
  if (res.status === 401 && typeof window !== "undefined" && !path.startsWith("/api/auth/")) {
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
    throw new ApiError(401, "Session expired");
  }
  const body = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new ApiError(res.status, (body as { message?: string })?.message ?? res.statusText);
  return body as T;
}

/** Data hook with loading/error, manual reload, optional polling, and stale-while-revalidate behaviour. */
export function useApi<T = any>(path: string | null, { refreshMs }: { refreshMs?: number } = {}) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!path) return;
    const id = ++seq.current;
    setLoading(true);
    try { const d = await api<T>(path); if (id === seq.current) { setData(d); setError(null); } }
    catch (e) { if (id === seq.current) setError((e as Error).message); }
    finally { if (id === seq.current) setLoading(false); }
  }, [path]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!refreshMs) return;
    const t = setInterval(() => document.visibilityState === "visible" && load(), refreshMs);
    return () => clearInterval(t);
  }, [load, refreshMs]);
  return { data, error, loading, reload: load, setData };
}
