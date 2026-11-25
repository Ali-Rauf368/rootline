// Creates and starts the billing flow in a local NiFi through its REST API:  node infra/nifi/setup-flow.mjs
// GetFile (CRON) → UpdateAttribute → QueryRecord (CSV → normalised JSON) → PutDatabaseRecord (cost_staging) → ReplaceText → InvokeHTTP
import https from "node:https";

const E = process.env;
const cfg = {
  url: new URL(E.NIFI_URL ?? "https://localhost:8443"), user: E.NIFI_USER ?? "admin", password: E.NIFI_PASSWORD ?? "opsmeridian-local-nifi",
  inbox: E.NIFI_INBOX ?? "/billing/inbox", failed: E.NIFI_FAILED ?? "/billing/failed", cron: E.NIFI_CRON ?? "0 */5 * * * ?",
  jdbcUrl: E.NIFI_JDBC_URL ?? "jdbc:postgresql://postgres:5432/rootline", jdbcJar: E.NIFI_JDBC_JAR ?? "/drivers/postgresql.jar",
  dbUser: E.NIFI_DB_USER ?? "rootline", dbPassword: E.NIFI_DB_PASSWORD ?? "rootline",
  webhook: E.NIFI_WEBHOOK_URL ?? "http://api:4100/api/webhooks/nifi-batch-complete", key: E.INGEST_TOKEN ?? "rl_dev_ingest_token",
};
// NiFi's local certificate is self-signed, so verification is skipped for loopback only.
const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(cfg.url.hostname);
let token = "";
function http(method, path, body, form) {
  const data = form ? new URLSearchParams(form).toString() : body ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const r = https.request(new URL(`/nifi-api${path}`, cfg.url), { method, rejectUnauthorized: !loopback, headers: { ...(token && { authorization: `Bearer ${token}` }), ...(data && { "content-type": form ? "application/x-www-form-urlencoded" : "application/json", "content-length": Buffer.byteLength(data) }) } }, (res) => {
      let t = ""; res.on("data", (d) => (t += d)); res.on("end", () => {
        if (res.statusCode >= 300) return reject(new Error(`${method} ${path}: ${res.statusCode} ${t}`));
        try { resolve(JSON.parse(t)); } catch { resolve(t); }
      });
    });
    r.on("error", reject); r.end(data);
  });
}
const rev = { version: 0 };
token = await http("POST", "/access/token", null, { username: cfg.user, password: cfg.password });

const NAME = "OpsMeridian billing";
const root = await http("GET", "/flow/process-groups/root");
if (root.processGroupFlow.flow.processGroups.some((g) => g.component.name === NAME)) { console.log(`"${NAME}" already exists. Stop and delete that process group in NiFi to recreate it.`); process.exit(0); }
const types = [...(await http("GET", "/flow/processor-types")).processorTypes, ...(await http("GET", "/flow/controller-service-types")).controllerServiceTypes];
const type = (n) => { const t = types.find((x) => x.type.split(".").pop() === n); if (!t) throw new Error(`NiFi doesn't provide ${n}`); return { type: t.type, bundle: t.bundle }; };
const pg = (await http("POST", `/process-groups/${root.processGroupFlow.id}/process-groups`, { revision: rev, component: { name: NAME, position: { x: 0, y: 0 } } })).id;

async function service(name, kind, properties) { return (await http("POST", `/process-groups/${pg}/controller-services`, { revision: rev, component: { name, ...type(kind), properties } })).id; }
async function processor(name, kind, x, y, properties, config = {}) {
  return (await http("POST", `/process-groups/${pg}/processors`, { revision: rev, component: { name, ...type(kind), position: { x, y }, config: { properties, ...config } } })).id;
}
const connect = (from, to, rels) => http("POST", `/process-groups/${pg}/connections`, { revision: rev, component: { source: { id: from, groupId: pg, type: "PROCESSOR" }, destination: { id: to, groupId: pg, type: "PROCESSOR" }, selectedRelationships: rels } });

const reader = await service("Billing CSV", "CSVReader", { "Schema Access Strategy": "csv-header-derived", "Treat First Line as Header": "true" });
const jsonOut = await service("JSON out", "JsonRecordSetWriter", {});
const jsonIn = await service("JSON in", "JsonTreeReader", {});
const db = await service("OpsMeridian PostgreSQL", "DBCPConnectionPool", { "Database Connection URL": cfg.jdbcUrl, "Database Driver Class Name": "org.postgresql.Driver", "Database Driver Locations": cfg.jdbcJar, "Database User": cfg.dbUser, Password: cfg.dbPassword });
const enabling = [reader, jsonOut, jsonIn, db];
for (const id of enabling) { const s = await http("GET", `/controller-services/${id}`); await http("PUT", `/controller-services/${id}/run-status`, { revision: s.revision, state: "ENABLED" }); }
for (const id of enabling) for (let i = 0; ; i++) {
  const s = await http("GET", `/controller-services/${id}`);
  if (s.component.state === "ENABLED") break;
  if (i > 30) throw new Error(`${s.component.name} did not start: ${JSON.stringify(s.component.validationErrors)}`);
  await new Promise((r) => setTimeout(r, 1000));
}

// "normalized" is the QueryRecord relationship; every column is landed as text and validated in PostgreSQL.
const col = (c) => `CAST("${c}" AS VARCHAR)`;
const select = (provider, m) => `SELECT '\${batch.id}' AS batch_id, '${provider}' AS provider, ${Object.entries(m).map(([k, v]) => `${col(v)} AS ${k}`).join(", ")} FROM FLOWFILE`;
const SOURCES = {
  aws: select("aws", { resource_id: "lineItem/ResourceId", resource_type: "product/resourceType", service: "product/servicecode", usage_cost: "lineItem/UnblendedCost", cpu_avg: "cpu_avg", attached_instance_id: "attached_instance_id", tags: "resourceTags", billing_date: "lineItem/UsageStartDate" }),
  gcp: select("gcp", { resource_id: "resource.name", resource_type: "resource.type", service: "service.description", usage_cost: "cost", cpu_avg: "cpu_avg", attached_instance_id: "attached_instance_id", tags: "labels", billing_date: "usage_start_time" }),
};
const retry = { retryCount: 5, backoffMechanism: "PENALIZE_FLOWFILE", maxBackoffPeriod: "5 mins" };

const load = await processor("Load into cost_staging", "PutDatabaseRecord", 500, 600, { "Record Reader": jsonIn, "Database Type": "PostgreSQL", "Statement Type": "INSERT", "Database Connection Pooling Service": db, "Schema Name": "public", "Table Name": "cost_staging", "Unmatched Column Behavior": "Ignore Unmatched Columns" }, { ...retry, retriedRelationships: ["failure"], autoTerminatedRelationships: ["retry"] });
const body = await processor("Build webhook body", "ReplaceText", 500, 800, { "Replacement Strategy": "Always Replace", "Evaluation Mode": "Entire text", "Replacement Value": '{"batchId":"${batch.id}"}' });
const notify = await processor("Notify OpsMeridian", "InvokeHTTP", 500, 1000, { "HTTP Method": "POST", "HTTP URL": cfg.webhook, "Request Content-Type": "application/json", "X-API-Key": cfg.key },
  { ...retry, sensitiveDynamicPropertyNames: ["X-API-Key"], retriedRelationships: ["Retry", "Failure"], autoTerminatedRelationships: ["Original", "Response"] });
const failed = await processor("Keep failed files", "PutFile", 1100, 800, { Directory: cfg.failed, "Conflict Resolution Strategy": "replace" }, { autoTerminatedRelationships: ["success", "failure"] });
const ids = [load, body, notify, failed];
let x = 0;
for (const [provider, sql] of Object.entries(SOURCES)) {
  const get = await processor(`Get ${provider} billing CSV`, "GetFile", x, 0, { "Input Directory": cfg.inbox, "File Filter": `${provider}-.*\\.csv`, "Keep Source File": "false" }, { schedulingStrategy: "CRON_DRIVEN", schedulingPeriod: cfg.cron });
  const tag = await processor(`Tag ${provider} batch`, "UpdateAttribute", x, 200, { "batch.id": "${uuid}" });
  const norm = await processor(`Normalise ${provider}`, "QueryRecord", x, 400, { "Record Reader": reader, "Record Writer": jsonOut, normalized: sql }, { autoTerminatedRelationships: ["original"] });
  await connect(get, tag, ["success"]); await connect(tag, norm, ["success"]); await connect(norm, load, ["normalized"]); await connect(norm, failed, ["failure"]);
  ids.push(get, tag, norm); x += 1000;
}
await connect(load, body, ["success"]); await connect(load, failed, ["failure"]);
await connect(body, notify, ["success"]); await connect(body, failed, ["failure"]); await connect(notify, failed, ["Retry", "No Retry", "Failure"]);

// Validate every processor before starting any of them.
for (const id of ids) for (let i = 0; ; i++) {
  const p = await http("GET", `/processors/${id}`);
  if (p.component.validationStatus === "VALID") break;
  if (p.component.validationStatus === "INVALID" || i > 20) throw new Error(`${p.component.name}: ${JSON.stringify(p.component.validationErrors)}`);
  await new Promise((r) => setTimeout(r, 500));
}
await http("PUT", `/flow/process-groups/${pg}`, { id: pg, state: "RUNNING" });
console.log(`"${NAME}" is running. Drop aws-*.csv or gcp-*.csv into the inbox (schedule: ${cfg.cron}).`);
