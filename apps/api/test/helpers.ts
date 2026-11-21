import { pool } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { seed } from "../src/sim/seed.js";
import { buildApp } from "../src/app.js";
import { registerJobs } from "../src/worker.js";

export async function setup() {
  await migrate();
  await pool.query(`TRUNCATE users, api_keys, services, deploys, log_events, metric_points, anomalies, webhook_deliveries, incidents, incident_events,
    investigations, investigation_steps, hypotheses, fix_proposals, repo_files, documents, doc_chunks, audit_log, jobs, settings RESTART IDENTITY CASCADE`);
  await seed({ force: true });
  registerJobs();
  const app = await buildApp();
  await app.ready();
  return app;
}

export async function login(app: Awaited<ReturnType<typeof setup>>, email = "oncall@rootline.dev") {
  const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "rootline-demo" } });
  return { authorization: `Bearer ${r.json().token}` };
}
