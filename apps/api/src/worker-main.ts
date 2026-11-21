// Standalone worker process: npm run worker (use with WORKER=off on API instances to scale independently)
import { startBusListener } from "./lib/bus.js";
import { startWorker, queueBackend } from "./lib/queue.js";
import { registerJobs } from "./worker.js";
import { loadFlags } from "./lib/flags.js";
import { migrate } from "./db/migrate.js";

await migrate();
await startBusListener();
await loadFlags();
registerJobs();
startWorker(Number(process.env.WORKER_CONCURRENCY ?? 4));
console.log(`Rootline worker started (queue=${queueBackend()})`);
