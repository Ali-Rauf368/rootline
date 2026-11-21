import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { io as connect, type Socket } from "socket.io-client";
import { setup, login } from "./helpers.js";
import { pool, one, q } from "../src/db/pool.js";
import { startBusListener, stopBusListener } from "../src/lib/bus.js";
import { attachRealtime } from "../src/lib/realtime.js";
import { flag, setFlags } from "../src/lib/flags.js";
import { runScenario } from "../src/sim/engine.js";
import { investigate } from "../src/agent/run.js";

let app: Awaited<ReturnType<typeof setup>>, rt: ReturnType<typeof attachRealtime>, url = "";
let admin: Record<string, string>, oncall: Record<string, string>, viewer: Record<string, string>;
const sockets: Socket[] = [];

beforeAll(async () => {
  app = await setup();
  await startBusListener();
  rt = attachRealtime(app.server);
  await app.listen({ port: 0, host: "127.0.0.1" });
  url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  [admin, oncall, viewer] = await Promise.all([login(app, "admin@rootline.dev"), login(app), login(app, "viewer@rootline.dev")]);
});
afterAll(async () => { sockets.forEach((s) => s.close()); await rt.close(); await app.close(); await stopBusListener(); await pool.end(); });

async function socketFor(headers: Record<string, string>) {
  const { ticket } = (await app.inject({ url: "/api/auth/stream-ticket", headers })).json();
  const s = connect(url, { auth: { ticket }, transports: ["websocket"], forceNew: true });
  sockets.push(s);
  await new Promise<void>((res, rej) => { s.once("ready", () => res()); s.once("connect_error", rej); });
  return s;
}
const ingest = { "x-api-key": "rl_test_ingest" };
async function spike(service: string) {
  const now = Date.now();
  const values = [...Array.from({ length: 20 }, () => 0.006 + Math.random() * 0.001), 0.12, 0.13];
  const points = values.map((value, i) => ({ service, name: "error_rate", value, ts: new Date(now - (values.length - i) * 30_000).toISOString() }));
  return (await app.inject({ method: "POST", url: "/api/ingest/metrics", headers: ingest, payload: points })).json();
}
const next = <T>(s: Socket, ev: string, pred: (x: T) => boolean = () => true) =>
  new Promise<T>((res, rej) => { const t = setTimeout(() => rej(new Error(`timeout waiting for ${ev}`)), 5000); const h = (x: T) => { if (pred(x)) { clearTimeout(t); s.off(ev, h); res(x); } }; s.on(ev, h); });

describe("feature toggles", () => {
  it("everyone can read flags; only admins can flip them, and flips are audited", async () => {
    const list = (await app.inject({ url: "/api/flags", headers: viewer })).json();
    expect(list.find((f: { key: string }) => f.key === "auto_investigate")).toMatchObject({ enabled: true, group: "Agent" });
    expect((await app.inject({ method: "PUT", url: "/api/flags", headers: oncall, payload: { maintenance_mode: true } })).statusCode).toBe(403);
    expect((await app.inject({ method: "PUT", url: "/api/flags", headers: admin, payload: { nope: true } })).statusCode).toBe(400);
    const r = await app.inject({ method: "PUT", url: "/api/flags", headers: admin, payload: { maintenance_mode: true } });
    expect(r.json().maintenance_mode).toBe(true);
    expect(flag("maintenance_mode")).toBe(true);
    expect(await one("SELECT 1 FROM audit_log WHERE action = 'flags.update'")).toBeTruthy();
  });
  it("maintenance mode records anomalies without opening incidents", async () => {
    const before = (await one("SELECT count(*)::int AS n FROM incidents")).n;
    const r = await spike("catalog");
    expect(r.anomalies[0]).toMatchObject({ anomalous: true, suppressed: "maintenance_mode" });
    expect((await one("SELECT count(*)::int AS n FROM incidents")).n).toBe(before);
    expect(await one("SELECT 1 FROM anomalies WHERE incident_id IS NULL")).toBeTruthy();
    await setFlags({ maintenance_mode: false });
  });
});

describe("socket.io war room", () => {
  let incidentId = 0;
  beforeAll(async () => {
    await runScenario("bad-pool-config");
    await q("DELETE FROM anomalies");
    const r = await spike("checkout-api");
    incidentId = r.anomalies?.[0]?.incidentId;
    if (!incidentId) throw new Error(JSON.stringify(r));
    await app.inject({ method: "POST", url: "/api/ingest/logs", headers: ingest, payload: Array.from({ length: 8 }, (_, i) => ({ service: "checkout-api", level: "error", message: `TimeoutError: could not acquire connection from pool within 3000ms (pool size 5, waiting ${20 + i})` })) });
  });

  it("rejects handshakes without a valid stream ticket", async () => {
    const s = connect(url, { auth: { ticket: "garbage" }, transports: ["websocket"], forceNew: true });
    sockets.push(s);
    const err = await new Promise<Error>((res) => s.once("connect_error", res));
    expect(err.message).toBe("unauthorized");
  });

  it("tracks presence, relays typing, persists chat, and blocks viewers from posting", async () => {
    const a = await socketFor(oncall), v = await socketFor(viewer);
    const seen = next<{ viewers: { name: string }[] }>(a, "presence", (p) => p.viewers.length === 2);
    await a.emitWithAck("incident:join", { incidentId });
    await v.emitWithAck("incident:join", { incidentId });
    expect((await seen).viewers.map((x) => x.name).sort()).toHaveLength(2);

    const typing = next<{ typing: boolean }>(v, "chat:typing");
    a.emit("chat:typing", { incidentId, typing: true });
    expect((await typing).typing).toBe(true);

    const got = next<{ message: { body: string } }>(v, "chat.message");
    const ack = await a.emitWithAck("chat:send", { incidentId, body: "Rolling back pool config" });
    expect(ack.ok).toBe(true);
    expect((await got).message.body).toBe("Rolling back pool config");
    expect((await v.emitWithAck("chat:send", { incidentId, body: "hi" })).ok).toBe(false);
    const history = (await app.inject({ url: `/api/incidents/${incidentId}/messages`, headers: viewer })).json();
    expect(history.map((m: { body: string }) => m.body)).toEqual(["Rolling back pool config"]);

    const left = next<{ viewers: unknown[] }>(a, "presence", (p) => p.viewers.length === 1);
    v.close();
    await left;
  });

  it("chat can be switched off at runtime", async () => {
    const a = await socketFor(oncall);
    await a.emitWithAck("incident:join", { incidentId });
    const pushed = next(a, "flags.updated");
    await app.inject({ method: "PUT", url: "/api/flags", headers: admin, payload: { war_room_chat: false } });
    await pushed;
    expect(await a.emitWithAck("chat:send", { incidentId, body: "x" })).toMatchObject({ ok: false, error: expect.stringMatching(/disabled/) });
    await setFlags({ war_room_chat: true });
  });

  it("two-person approval needs two distinct responders before a PR opens", async () => {
    await setFlags({ two_person_approval: true });
    await investigate(incidentId, "manual test");
    const fix = await one("SELECT id FROM fix_proposals WHERE incident_id = $1 AND status = 'pending_approval'", [incidentId]);
    const first = await app.inject({ method: "POST", url: `/api/fixes/${fix.id}/approve`, headers: oncall, payload: {} });
    expect(first.statusCode).toBe(202);
    expect((await app.inject({ method: "POST", url: `/api/fixes/${fix.id}/approve`, headers: oncall, payload: {} })).statusCode).toBe(202); // same person doesn't count twice
    const second = await app.inject({ method: "POST", url: `/api/fixes/${fix.id}/approve`, headers: admin, payload: {} });
    expect(second.json()).toMatchObject({ status: "pr_opened" });
    await setFlags({ two_person_approval: false });
  });
});
