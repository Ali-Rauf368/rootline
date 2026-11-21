"use client";
import { FormEvent, useEffect, useRef, useState } from "react";
import { MessagesSquare, Send, Lock } from "lucide-react";
import { useApi } from "@/lib/api";
import { ago, clock } from "@/lib/format";
import { useSocket, useSession, useFlags, useLiveEvents, can } from "./shell";
import { Card, CardHeader, Empty, Spinner, useToast, cx } from "./ui";

export interface Viewer { id: number; name: string; role: string; since: number }
interface Message { id: number; user_id: number | null; author: string; body: string; created_at: string }

const initials = (n: string) => n.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase();
const HUES = ["bg-accent/20 text-accent", "bg-ok/20 text-ok", "bg-warn/20 text-warn", "bg-bad/20 text-bad", "bg-fuchsia-500/20 text-fuchsia-400", "bg-sky-500/20 text-sky-400"];
const hue = (id: number) => HUES[id % HUES.length];

/** Joins the incident's Socket.IO room for as long as the war room is open (re-joins on reconnect). */
export function useWarRoom(incidentId: number) {
  const socket = useSocket();
  const [viewers, setViewers] = useState<Viewer[]>([]);
  const [typing, setTyping] = useState<Record<number, { name: string; at: number }>>({});
  useEffect(() => {
    if (!socket) return;
    const join = () => socket.emit("incident:join", { incidentId });
    const onPresence = (p: { incidentId: number; viewers: Viewer[] }) => p.incidentId === incidentId && setViewers(p.viewers);
    const onTyping = (t: { incidentId: number; user: { id: number; name: string }; typing: boolean }) => {
      if (t.incidentId !== incidentId) return;
      setTyping((m) => { const n = { ...m }; if (t.typing) n[t.user.id] = { name: t.user.name, at: Date.now() }; else delete n[t.user.id]; return n; });
    };
    if (socket.connected) join();
    socket.on("connect", join);
    socket.on("presence", onPresence);
    socket.on("chat:typing", onTyping);
    return () => { socket.emit("incident:leave", { incidentId }); socket.off("connect", join); socket.off("presence", onPresence); socket.off("chat:typing", onTyping); setViewers([]); };
  }, [socket, incidentId]);
  // typing indicators expire if the "stopped" event is lost
  useEffect(() => {
    const t = setInterval(() => setTyping((m) => Object.fromEntries(Object.entries(m).filter(([, v]) => Date.now() - v.at < 6000))), 2000);
    return () => clearInterval(t);
  }, []);
  return { viewers, typing };
}

export function PresenceStack({ viewers }: { viewers: Viewer[] }) {
  const me = useSession();
  if (!viewers.length) return null;
  const shown = viewers.slice(0, 5);
  return (
    <div className="flex items-center gap-2" aria-label={`${viewers.length} people viewing`}>
      <div className="flex -space-x-2">
        {shown.map((v) => (
          <span key={v.id} title={`${v.name}${v.id === me?.id ? " (you)" : ""} · ${v.role} · here ${ago(new Date(v.since).toISOString())}`}
            className={cx("relative flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-semibold ring-2 ring-panel", hue(v.id))}>
            {initials(v.name)}<span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-ok ring-2 ring-panel" />
          </span>
        ))}
        {viewers.length > shown.length && <span className="flex h-7 w-7 items-center justify-center rounded-full bg-raised text-[10px] font-semibold ring-2 ring-panel">+{viewers.length - shown.length}</span>}
      </div>
      <span className="text-xs text-muted">{viewers.length === 1 ? "Only you here" : `${viewers.length} in the war room`}</span>
    </div>
  );
}

export function ChatCard({ incidentId, typing }: { incidentId: number; typing: Record<number, { name: string }> }) {
  const socket = useSocket();
  const me = useSession();
  const { on } = useFlags();
  const toast = useToast();
  const history = useApi<Message[]>(`/api/incidents/${incidentId}/messages`);
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const typingSent = useRef(0);
  const stopTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => { if (history.data) setMessages(history.data); }, [history.data]);
  useLiveEvents((e) => {
    if (e.type !== "chat.message" || e.incidentId !== incidentId) return;
    const m = e.message as Message;
    setMessages((ms) => (ms.some((x) => x.id === m.id) ? ms : [...ms, m]));
  }, [incidentId]);
  // after a reconnect, catch up on anything missed
  useEffect(() => { if (!socket) return; const h = () => history.reload(); socket.on("connect", h); return () => { socket.off("connect", h); }; }, [socket, history.reload]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const el = list.current; if (el) el.scrollTop = el.scrollHeight; }, [messages.length]);

  const enabled = on("war_room_chat");
  const canPost = can(me, "responder");
  const others = Object.entries(typing).filter(([id]) => Number(id) !== me?.id).map(([, v]) => v.name);

  const emitTyping = (v: boolean) => { if (on("presence")) socket?.emit("chat:typing", { incidentId, typing: v }); };
  const onChange = (v: string) => {
    setText(v);
    if (Date.now() - typingSent.current > 2500) { typingSent.current = Date.now(); emitTyping(true); }
    clearTimeout(stopTimer.current);
    stopTimer.current = setTimeout(() => { typingSent.current = 0; emitTyping(false); }, 3000);
  };
  const send = async (ev: FormEvent) => {
    ev.preventDefault();
    const body = text.trim();
    if (!body || !socket) return;
    setSending(true);
    try {
      const r = await socket.timeout(5000).emitWithAck("chat:send", { incidentId, body }) as { ok: boolean; error?: string; message?: Message };
      if (!r.ok) throw new Error(r.error ?? "Could not send");
      setText(""); clearTimeout(stopTimer.current); typingSent.current = 0; emitTyping(false);
      if (r.message) setMessages((ms) => (ms.some((x) => x.id === r.message!.id) ? ms : [...ms, r.message!]));
    } catch (e) { toast((e as Error).message === "operation has timed out" ? "Not connected. Message not sent." : (e as Error).message, "bad"); }
    finally { setSending(false); }
  };

  return (
    <Card className="card-pad flex flex-col">
      <CardHeader title="War-room chat" subtitle={enabled ? "Live over Socket.IO · saved with the incident" : "Turned off by an admin"} icon={MessagesSquare} />
      <div ref={list} className="-mx-1 max-h-80 min-h-[8rem] flex-1 space-y-2.5 overflow-y-auto px-1" aria-live="polite">
        {history.loading && !messages.length ? <div className="flex justify-center py-6 text-accent"><Spinner /></div>
          : !messages.length ? <Empty icon={MessagesSquare} title="No messages yet" message="Coordinate the response here. Everyone in the war room sees messages instantly." />
          : messages.map((m, i) => {
            const mine = m.user_id === me?.id;
            const grouped = i > 0 && messages[i - 1].user_id === m.user_id && new Date(m.created_at).getTime() - new Date(messages[i - 1].created_at).getTime() < 120_000;
            return (
              <div key={m.id} className={cx("flex gap-2", mine && "flex-row-reverse", grouped && "-mt-1.5")}>
                {grouped ? <span className="w-7 shrink-0" /> : <span className={cx("flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold", hue(m.user_id ?? 0))}>{initials(m.author)}</span>}
                <div className={cx("max-w-[80%]", mine && "text-right")}>
                  {!grouped && <p className="mb-0.5 text-[10px] text-subtle">{mine ? "You" : m.author} · {clock(m.created_at)}</p>}
                  <p className={cx("inline-block whitespace-pre-wrap break-words rounded-xl px-3 py-1.5 text-left text-sm", mine ? "bg-accent text-white" : "bg-raised")}>{m.body}</p>
                </div>
              </div>
            );
          })}
      </div>
      <p className="h-5 pt-1 text-[11px] text-subtle" aria-live="polite">{others.length ? `${others.slice(0, 2).join(" and ")}${others.length > 2 ? ` and ${others.length - 2} more` : ""} ${others.length === 1 ? "is" : "are"} typing…` : ""}</p>
      {!enabled ? <p className="flex items-center gap-2 rounded-lg bg-raised/60 px-3 py-2 text-xs text-muted"><Lock className="h-3.5 w-3.5" />Chat is disabled in Settings. History stays readable.</p>
        : !canPost ? <p className="flex items-center gap-2 rounded-lg bg-raised/60 px-3 py-2 text-xs text-muted"><Lock className="h-3.5 w-3.5" />Viewers can read the chat. Ask a responder to post.</p>
        : (
          <form onSubmit={send} className="flex gap-2">
            <input className="input flex-1" value={text} onChange={(e) => onChange(e.target.value)} maxLength={2000} placeholder="Message the war room…" aria-label="Chat message" />
            <button className="btn-primary px-3" disabled={!text.trim() || sending} aria-label="Send">{sending ? <Spinner /> : <Send className="h-4 w-4" />}</button>
          </form>
        )}
    </Card>
  );
}
