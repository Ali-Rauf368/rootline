import { env } from "./lib/env.js";
import { buildApp } from "./app.js";
import { migrate } from "./db/migrate.js";
import { pool } from "./db/pool.js";
import { seed } from "./sim/seed.js";
import { startBusListener, stopBusListener } from "./lib/bus.js";
import { startWorker, stopWorker, queueBackend } from "./lib/queue.js";
import { registerJobs } from "./worker.js";
import { startSimulator, stopSimulator } from "./sim/engine.js";
import { agentMode } from "./agent/run.js";
import { loadFlags } from "./lib/flags.js";
import { startCostWorker, stopCostJobs } from "./finops/jobs.js";
import { seedCosts } from "./finops/demo.js";
import { attachRealtime } from "./lib/realtime.js";

await migrate();
if (env.SIMULATOR === "on" && (await seed())) console.log("seeded demo data (admin@opsmeridian.dev / oncall@opsmeridian.dev, password opsmeridian-demo)");
await startBusListener();
await loadFlags();
registerJobs();
if (env.SIMULATOR === "on") await seedCosts();
// WORKER=off runs the API only (scale workers separately with `npm run worker`)
if (process.env.WORKER !== "off") { startWorker(Number(process.env.WORKER_CONCURRENCY ?? 3)); await startCostWorker(); }
if (env.SIMULATOR === "on") startSimulator(Number(process.env.SIM_INTERVAL_MS ?? 10_000));

const app = await buildApp();
const realtime = attachRealtime(app.server);
await app.listen({ port: env.PORT, host: process.env.HOST ?? "127.0.0.1" });
app.log.info(`OpsMeridian API on :${env.PORT} · queue=${queueBackend()} · agent=${agentMode()} · simulator=${env.SIMULATOR}`);

for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, async () => {
    app.log.info(`${sig}: draining`);
    stopSimulator();
    setTimeout(() => process.exit(1), 15_000).unref();
    await realtime.close();
    await app.close();
    await stopWorker();
    await stopCostJobs();
    await stopBusListener();
    await pool.end();
    process.exit(0);
  });
