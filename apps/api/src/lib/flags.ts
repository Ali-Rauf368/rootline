import { pool } from "../db/pool.js";
import { publish, subscribe } from "./bus.js";

/**
 * Runtime feature toggles. Stored in `settings` (key "flags"), cached in every process and
 * refreshed through the event bus, so a flip in the UI takes effect in API and workers within ms.
 */
export const FLAG_DEFS = {
  auto_investigate: { label: "Auto-investigate new incidents", description: "Start the RCA agent as soon as an incident opens or its blast radius grows.", group: "Agent", default: true },
  claude_agent: { label: "Use Claude when configured", description: "Run investigations with Claude if an API key is set. Off forces the deterministic heuristic investigator.", group: "Agent", default: true },
  fix_generation: { label: "Generate fix proposals", description: "Let the agent draft and verify patches. Off keeps analysis-only investigations.", group: "Agent", default: true },
  cost_ai: { label: "AI cost analysis", description: "Explain cost findings with Gemini if an API key is set. Off uses the built-in rules.", group: "Agent", default: true },
  two_person_approval: { label: "Two-person approval", description: "A fix needs approvals from two different responders before a draft PR is opened.", group: "Safety", default: false },
  anomaly_detection: { label: "Metric anomaly detection", description: "Open incidents automatically from sustained metric deviations.", group: "Detection", default: true },
  maintenance_mode: { label: "Maintenance mode", description: "Keep ingesting and recording anomalies, but don't open new incidents (planned work).", group: "Detection", default: false },
  war_room_chat: { label: "War-room chat", description: "Real-time responder chat in every incident (Socket.IO).", group: "Collaboration", default: true },
  presence: { label: "Live presence", description: "Show who is viewing an incident and who is typing.", group: "Collaboration", default: true },
} as const;
export type FlagName = keyof typeof FLAG_DEFS;
export type Flags = Record<FlagName, boolean>;

const defaults = () => Object.fromEntries(Object.entries(FLAG_DEFS).map(([k, d]) => [k, d.default])) as Flags;
let cache: Flags = defaults();
let started = false;

export async function loadFlags(): Promise<Flags> {
  const { rows } = await pool.query("SELECT value FROM settings WHERE key = 'flags'");
  cache = { ...defaults(), ...(rows[0]?.value ?? {}) };
  if (!started) { started = true; subscribe((e) => { if (e.type === "flags.updated") loadFlags().catch(() => {}); }); }
  return cache;
}
/** Synchronous read from the process cache (kept fresh by the bus). */
export const flag = (name: FlagName) => cache[name];
export const allFlags = () => ({ ...cache });

export async function setFlags(patch: Partial<Flags>) {
  const clean = Object.fromEntries(Object.entries(patch).filter(([k, v]) => k in FLAG_DEFS && typeof v === "boolean"));
  const { rows } = await pool.query(
    `INSERT INTO settings (key, value) VALUES ('flags', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = settings.value || EXCLUDED.value RETURNING value`, [JSON.stringify(clean)]);
  cache = { ...defaults(), ...rows[0].value };
  await publish({ type: "flags.updated", flags: cache });
  return cache;
}
