import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { one, q, pool } from "../db/pool.js";
import { migrate } from "../db/migrate.js";
import { upsertDocument } from "../services/knowledge.js";
import { SERVICES, REPOS, KNOWLEDGE, PAST_INCIDENTS } from "./catalog.js";

/** Idempotent demo seed: runs only when no users exist. */
export async function seed({ force = false } = {}) {
  if (!force && (await one("SELECT 1 FROM users LIMIT 1"))) return false;
  const hash = await bcrypt.hash("rootline-demo", 10);
  for (const [email, name, role] of [["admin@rootline.dev", "Alex Admin", "admin"], ["oncall@rootline.dev", "Riley On-call", "responder"], ["viewer@rootline.dev", "Vic Viewer", "viewer"]])
    await q("INSERT INTO users (email, name, password_hash, role) VALUES ($1,$2,$3,$4) ON CONFLICT (email) DO NOTHING", [email, name, hash, role]);

  for (const s of SERVICES)
    await q(`INSERT INTO services (name, display_name, tier, owner_team, language, depends_on, repo, slo_latency_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (name) DO UPDATE SET display_name = EXCLUDED.display_name, tier = EXCLUDED.tier, owner_team = EXCLUDED.owner_team, depends_on = EXCLUDED.depends_on`,
      [s.name, s.display, s.tier, s.team, s.lang, s.deps, `acme/${s.name}`, Math.round(s.base.p95 * 2.5)]);
  for (const [service, files] of Object.entries(REPOS))
    for (const [p, content] of Object.entries(files)) await q("INSERT INTO repo_files (service, path, content) VALUES ($1,$2,$3) ON CONFLICT (service, path) DO UPDATE SET content = EXCLUDED.content", [service, p, content]);
  for (const d of KNOWLEDGE) await upsertDocument({ ...d });

  // 24 h of metric history at 2-minute resolution (live simulator continues at 10 s)
  const now = Date.now();
  for (const s of SERVICES) {
    const rows: unknown[] = [];
    for (let t = now - 24 * 3600_000; t < now - 5 * 60_000; t += 120_000) {
      const ts = new Date(t), diurnal = 1 + 0.25 * Math.sin((ts.getHours() + ts.getMinutes() / 60 - 8) / 24 * 2 * Math.PI);
      const j = () => 0.9 + Math.random() * 0.2;
      rows.push([s.name, "rps", ts, s.base.rps * diurnal * j()], [s.name, "error_rate", ts, s.base.err * j()], [s.name, "latency_p95_ms", ts, s.base.p95 * j()], [s.name, "saturation", ts, 0.35 * j()], [s.name, "cpu", ts, 45 * j()], [s.name, "memory_mb", ts, 900 * j()]);
    }
    for (let i = 0; i < rows.length; i += 2000) {
      const batch = rows.slice(i, i + 2000) as unknown[][];
      await q(`INSERT INTO metric_points (service, name, ts, value) VALUES ${batch.map((_, k) => `($${k * 4 + 1},$${k * 4 + 2},$${k * 4 + 3},$${k * 4 + 4})`).join(",")} ON CONFLICT DO NOTHING`, batch.flat());
    }
  }

  // two weeks of deploy history
  const authors = ["jordan.lee", "priya.n", "sam.k", "mia.r", "deploy-bot"];
  const msgs = ["Bump dependencies", "Add tracing to handlers", "Refactor retry policy", "Tune autoscaling thresholds", "Fix pagination edge case", "Feature flag: new checkout UI", "Improve cache hit rate", "Update TLS ciphers"];
  for (let d = 14; d >= 0; d--)
    for (let k = 0; k < 2 + Math.floor(Math.random() * 4); k++) {
      const s = SERVICES[Math.floor(Math.random() * SERVICES.length)];
      const when = new Date(now - d * 864e5 - Math.random() * 864e5 * 0.6 - 3600_000);
      await q("INSERT INTO deploys (service, sha, author, message, kind, files, deployed_at, source) VALUES ($1,$2,$3,$4,'code','[]',$5,'seed') ON CONFLICT DO NOTHING",
        [s.name, crypto.randomBytes(20).toString("hex"), authors[k % authors.length], msgs[Math.floor(Math.random() * msgs.length)], when]);
    }

  // resolved incidents with full lifecycle → realistic MTTD/MTTR, agent precision and similar-incident recall
  const admin = await one("SELECT id FROM users WHERE role = 'responder' LIMIT 1");
  for (const p of PAST_INCIDENTS) {
    const started = new Date(now - p.daysAgo * 864e5);
    const detected = new Date(started.getTime() + (2 + Math.random() * 4) * 60_000);
    const identified = new Date(started.getTime() + p.tti * 60_000);
    const resolved = new Date(started.getTime() + p.ttr * 60_000);
    const inc = await one(`INSERT INTO incidents (title, severity, status, services, source, root_cause, confidence, started_at, detected_at, acknowledged_at, identified_at, mitigated_at, resolved_at, commander, summary)
                           VALUES ($1,$2,'resolved',$3,'anomaly',$4,$5,$6,$7,$7,$8,$8,$9,$10,$11) RETURNING id`,
      [p.title, p.sev, p.services, p.cause, 0.82, started, detected, identified, resolved, admin?.id ?? null, `Resolved: ${p.cause}`]);
    for (const [ts, kind, title] of [[detected, "detected", "Incident detected via anomaly"], [identified, "hypothesis", `Root cause identified: ${p.cause}`], [resolved, "status", "Status → resolved"]] as const)
      await q("INSERT INTO incident_events (incident_id, ts, kind, title, actor) VALUES ($1,$2,$3,$4,'rootline')", [inc.id, ts, kind, title]);
    await q("INSERT INTO hypotheses (incident_id, rank, title, description, category, confidence, status, evidence) VALUES ($1,1,$2,$2,'config_change',0.82,$3,'[]')", [inc.id, p.cause, p.daysAgo === 9 ? "rejected" : "confirmed"]);
  }
  await q("SELECT setval('incident_key_seq', greatest((SELECT count(*) FROM incidents) + 1000, 1001))");
  return true;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await migrate();
  const force = process.argv.includes("--force");
  console.log((await seed({ force })) ? "demo data seeded" : "already seeded (use --force)");
  await pool.end();
}
