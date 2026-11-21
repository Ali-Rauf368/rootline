import { registerHandler } from "./lib/queue.js";
import { investigate } from "./agent/run.js";

/** Job handlers (shared by the in-process worker and the standalone worker entry). */
export function registerJobs() {
  registerHandler("investigate", async ({ incidentId, trigger }) => { await investigate(incidentId, trigger); });
}
