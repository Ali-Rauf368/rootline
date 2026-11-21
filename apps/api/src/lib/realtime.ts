import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { z } from "zod";
import { env } from "./env.js";
import { verify, type SessionUser } from "./auth.js";
import { publish, subscribe, type BusEvent } from "./bus.js";
import { flag, allFlags } from "./flags.js";
import { one, q } from "../db/pool.js";

/**
 * Socket.IO gateway. Rooms: "console" (everyone), "incident:<id>" (war rooms).
 * Bus events from any process are fanned out to the right rooms; presence and typing are
 * per-API-process and chat messages are persisted and re-broadcast through the bus.
 */
type Viewer = { id: number; name: string; role: string; since: number };
let io: Server | null = null;
const presence = new Map<number, Map<string, Viewer>>(); // incidentId -> socketId -> viewer

const room = (id: number) => `incident:${id}`;
const roster = (id: number) => {
  const seen = new Map<number, Viewer>();
  for (const v of presence.get(id)?.values() ?? []) if (!seen.has(v.id)) seen.set(v.id, v);
  return [...seen.values()].sort((a, b) => a.since - b.since);
};
const emitPresence = (id: number) => io?.to(room(id)).emit("presence", { incidentId: id, viewers: flag("presence") ? roster(id) : [] });

export function attachRealtime(server: HttpServer) {
  io = new Server(server, { path: "/socket.io", cors: { origin: env.WEB_ORIGIN.split(","), credentials: true }, pingInterval: 20_000, pingTimeout: 15_000 });

  // auth: short-lived stream ticket in the handshake (same as SSE), never the raw session cookie
  io.use(async (socket, next) => {
    const ticket = socket.handshake.auth?.ticket;
    const user = typeof ticket === "string" ? await verify(ticket, "stream") : null;
    if (!user) return next(new Error("unauthorized"));
    socket.data.user = user;
    next();
  });

  io.on("connection", (socket: Socket) => {
    const user = socket.data.user as SessionUser;
    socket.join("console");
    socket.emit("ready", { user: user.name, flags: allFlags() });
    const joined = new Set<number>();
    let lastChat = 0;

    socket.on("incident:join", (raw, ack?: (r: unknown) => void) => {
      const id = Number(raw?.incidentId);
      if (!Number.isInteger(id)) return ack?.({ ok: false });
      socket.join(room(id)); joined.add(id);
      if (!presence.has(id)) presence.set(id, new Map());
      presence.get(id)!.set(socket.id, { id: user.id, name: user.name, role: user.role, since: Date.now() });
      emitPresence(id);
      ack?.({ ok: true });
    });
    socket.on("incident:leave", (raw) => leave(Number(raw?.incidentId)));

    socket.on("chat:typing", (raw) => {
      const id = Number(raw?.incidentId);
      if (!joined.has(id) || !flag("presence")) return;
      socket.to(room(id)).emit("chat:typing", { incidentId: id, user: { id: user.id, name: user.name }, typing: !!raw?.typing });
    });

    socket.on("chat:send", async (raw, ack?: (r: unknown) => void) => {
      try {
        if (!flag("war_room_chat")) return ack?.({ ok: false, error: "War-room chat is disabled" });
        const { incidentId, body } = z.object({ incidentId: z.number().int(), body: z.string().trim().min(1).max(2000) }).parse(raw);
        if (!joined.has(incidentId)) return ack?.({ ok: false, error: "Join the incident first" });
        if (user.role === "viewer") return ack?.({ ok: false, error: "Viewers can read the chat but not post" });
        if (Date.now() - lastChat < 400) return ack?.({ ok: false, error: "Slow down" });
        lastChat = Date.now();
        if (!(await one("SELECT 1 FROM incidents WHERE id = $1", [incidentId]))) return ack?.({ ok: false, error: "Incident not found" });
        const message = await one("INSERT INTO war_room_messages (incident_id, user_id, author, body) VALUES ($1,$2,$3,$4) RETURNING *", [incidentId, user.id, user.name, body]);
        await publish({ type: "chat.message", incidentId, message });
        ack?.({ ok: true, message });
      } catch (e) { ack?.({ ok: false, error: e instanceof z.ZodError ? "Message must be 1–2000 characters" : "Could not send" }); }
    });

    const leave = (id: number) => {
      if (!joined.delete(id)) return;
      socket.leave(room(id));
      presence.get(id)?.delete(socket.id);
      if (!presence.get(id)?.size) presence.delete(id);
      emitPresence(id);
    };
    socket.on("disconnect", () => { for (const id of [...joined]) leave(id); });
  });

  const unsub = subscribe((e: BusEvent) => {
    if (!io) return;
    if (e.type === "flags.updated") { io.to("console").emit("flags.updated", e); for (const id of presence.keys()) emitPresence(id); return; }
    // war-room scoped events go to the incident room; everything else to the console
    if (e.type === "chat.message") { io.to(room(e.incidentId)).emit(e.type, e); return; }
    io.to("console").emit(e.type, e);
  });
  return { close: async () => { unsub(); await io?.close(); io = null; } };
}

export const realtimeStats = () => ({ sockets: io?.engine.clientsCount ?? 0, warRooms: presence.size });
export async function recentMessages(incidentId: number, limit = 100) {
  const rows = await q("SELECT * FROM (SELECT * FROM war_room_messages WHERE incident_id = $1 ORDER BY id DESC LIMIT $2) m ORDER BY id", [incidentId, limit]);
  return rows;
}
