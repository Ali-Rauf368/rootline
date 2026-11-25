-- OpsMeridian schema (idempotent). Incident state, signals, knowledge, agent runs, audit, job queue.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('viewer','responder','admin')) DEFAULT 'responder',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT UNIQUE NOT NULL,
  preview TEXT NOT NULL,
  scopes TEXT[] NOT NULL DEFAULT '{ingest}',
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS services (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  tier INT NOT NULL DEFAULT 2 CHECK (tier BETWEEN 1 AND 3),
  owner_team TEXT NOT NULL DEFAULT 'platform',
  repo TEXT,                      -- owner/name on GitHub
  language TEXT,
  slo_availability NUMERIC NOT NULL DEFAULT 99.9,
  slo_latency_ms INT NOT NULL DEFAULT 400,
  depends_on TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deploys (
  id SERIAL PRIMARY KEY,
  service TEXT NOT NULL REFERENCES services(name) ON DELETE CASCADE,
  sha TEXT NOT NULL,
  author TEXT NOT NULL,
  message TEXT NOT NULL,
  pr_number INT,
  kind TEXT NOT NULL DEFAULT 'code' CHECK (kind IN ('code','config','infra','rollback')),
  files JSONB NOT NULL DEFAULT '[]',     -- [{path, additions, deletions}]
  diff TEXT NOT NULL DEFAULT '',          -- unified diff
  deployed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source TEXT NOT NULL DEFAULT 'webhook',
  UNIQUE (service, sha)
);
CREATE INDEX IF NOT EXISTS deploys_service_time ON deploys (service, deployed_at DESC);

CREATE TABLE IF NOT EXISTS log_events (
  id BIGSERIAL PRIMARY KEY,
  service TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('debug','info','warn','error','fatal')),
  message TEXT NOT NULL,
  fingerprint TEXT NOT NULL,              -- normalised message signature (numbers/ids stripped)
  trace_id TEXT,
  attrs JSONB NOT NULL DEFAULT '{}',
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', message)) STORED
);
CREATE INDEX IF NOT EXISTS logs_service_ts ON log_events (service, ts DESC);
CREATE INDEX IF NOT EXISTS logs_level_ts ON log_events (level, ts DESC) WHERE level IN ('error','fatal');
CREATE INDEX IF NOT EXISTS logs_fp ON log_events (fingerprint, ts DESC);
CREATE INDEX IF NOT EXISTS logs_tsv ON log_events USING GIN (tsv);

CREATE TABLE IF NOT EXISTS metric_points (
  service TEXT NOT NULL,
  name TEXT NOT NULL,                     -- error_rate | latency_p95_ms | rps | cpu | memory_mb | saturation
  ts TIMESTAMPTZ NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (service, name, ts)
);
CREATE INDEX IF NOT EXISTS metrics_name_ts ON metric_points (name, ts DESC);

CREATE TABLE IF NOT EXISTS anomalies (
  id SERIAL PRIMARY KEY,
  service TEXT NOT NULL,
  metric TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  baseline DOUBLE PRECISION NOT NULL,
  zscore DOUBLE PRECISION NOT NULL,
  incident_id INT
);
CREATE INDEX IF NOT EXISTS anomalies_service_ts ON anomalies (service, ts DESC);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  source TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source, delivery_id)
);

CREATE SEQUENCE IF NOT EXISTS incident_key_seq START 1001;
CREATE TABLE IF NOT EXISTS incidents (
  id SERIAL PRIMARY KEY,
  key TEXT UNIQUE NOT NULL DEFAULT ('INC-' || nextval('incident_key_seq')),
  title TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('sev1','sev2','sev3','sev4')),
  status TEXT NOT NULL CHECK (status IN ('detected','investigating','identified','mitigating','resolved')) DEFAULT 'detected',
  summary TEXT NOT NULL DEFAULT '',
  services TEXT[] NOT NULL,
  source TEXT NOT NULL DEFAULT 'anomaly',  -- anomaly | alert | manual
  dedupe_key TEXT,
  commander INT REFERENCES users(id) ON DELETE SET NULL,
  root_cause TEXT,
  confidence NUMERIC,
  started_at TIMESTAMPTZ NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at TIMESTAMPTZ,
  identified_at TIMESTAMPTZ,
  mitigated_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS incidents_status ON incidents (status, detected_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS incidents_open_dedupe ON incidents (dedupe_key) WHERE status <> 'resolved' AND dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS incident_events (
  id BIGSERIAL PRIMARY KEY,
  incident_id INT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind TEXT NOT NULL,                     -- detected | status | note | agent | hypothesis | fix | deploy | alert | pr
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT 'system',
  data JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS incident_events_incident ON incident_events (incident_id, ts);

CREATE TABLE IF NOT EXISTS investigations (
  id SERIAL PRIMARY KEY,
  incident_id INT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed')) DEFAULT 'queued',
  mode TEXT NOT NULL,                     -- claude | heuristic
  model TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  input_tokens INT NOT NULL DEFAULT 0,
  output_tokens INT NOT NULL DEFAULT 0,
  summary TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS investigation_steps (
  id BIGSERIAL PRIMARY KEY,
  investigation_id INT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  seq INT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('thought','tool_call','conclusion','error')),
  tool TEXT,
  input JSONB,
  output JSONB,
  duration_ms INT,
  ts TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS steps_investigation ON investigation_steps (investigation_id, seq);

CREATE TABLE IF NOT EXISTS hypotheses (
  id SERIAL PRIMARY KEY,
  incident_id INT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  investigation_id INT REFERENCES investigations(id) ON DELETE SET NULL,
  rank INT NOT NULL DEFAULT 1,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'code_change', -- code_change | config_change | dependency | capacity | unknown
  confidence NUMERIC NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  status TEXT NOT NULL CHECK (status IN ('proposed','confirmed','rejected')) DEFAULT 'proposed',
  suspect_deploy_id INT REFERENCES deploys(id) ON DELETE SET NULL,
  evidence JSONB NOT NULL DEFAULT '[]',    -- [{type, label, detail, weight}]
  citations JSONB NOT NULL DEFAULT '[]',   -- [{documentId, chunkId, title, heading, quote}]
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fix_proposals (
  id SERIAL PRIMARY KEY,
  incident_id INT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  hypothesis_id INT REFERENCES hypotheses(id) ON DELETE SET NULL,
  service TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  strategy TEXT NOT NULL DEFAULT 'patch',  -- revert | patch | config
  patch TEXT NOT NULL,                     -- unified diff
  test_patch TEXT NOT NULL DEFAULT '',
  verification JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('pending_approval','approved','rejected','pr_opened','failed')) DEFAULT 'pending_approval',
  pr_url TEXT,
  pr_number INT,
  pr_mode TEXT,                            -- github | simulated
  decided_by INT REFERENCES users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  decision_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Snapshot of repository files (from GitHub or the demo seed) used to verify patches before any PR is opened
CREATE TABLE IF NOT EXISTS repo_files (
  service TEXT NOT NULL,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (service, path)
);

CREATE TABLE IF NOT EXISTS documents (
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('runbook','postmortem','architecture','playbook')),
  title TEXT NOT NULL,
  service TEXT,
  content TEXT NOT NULL,
  source_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS doc_chunks (
  id SERIAL PRIMARY KEY,
  document_id INT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  idx INT NOT NULL,
  heading TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  embedding REAL[] NOT NULL,
  tsv tsvector GENERATED ALWAYS AS (setweight(to_tsvector('english', heading), 'A') || to_tsvector('english', content)) STORED
);
CREATE INDEX IF NOT EXISTS chunks_tsv ON doc_chunks USING GIN (tsv);
CREATE INDEX IF NOT EXISTS chunks_doc ON doc_chunks (document_id, idx);

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  data JSONB NOT NULL DEFAULT '{}',
  ip TEXT
);
CREATE INDEX IF NOT EXISTS audit_ts ON audit_log (ts DESC);

-- Durable job queue (used when Redis/BullMQ is not configured): FOR UPDATE SKIP LOCKED workers
CREATE TABLE IF NOT EXISTS jobs (
  id BIGSERIAL PRIMARY KEY,
  queue TEXT NOT NULL,
  name TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('waiting','active','completed','failed')) DEFAULT 'waiting',
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  last_error TEXT,
  dedupe_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS jobs_ready ON jobs (queue, run_at) WHERE status = 'waiting';
CREATE UNIQUE INDEX IF NOT EXISTS jobs_dedupe ON jobs (queue, dedupe_key) WHERE status IN ('waiting','active') AND dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS war_room_messages (
  id BIGSERIAL PRIMARY KEY,
  incident_id BIGINT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS war_room_messages_incident ON war_room_messages (incident_id, id);

CREATE TABLE IF NOT EXISTS fix_approvals (
  fix_id BIGINT NOT NULL REFERENCES fix_proposals(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (fix_id, user_id)
);

-- ───────────── Cloud cost (FinOps) ─────────────
-- Landing table for NiFi: everything is TEXT so one bad cell can't fail a bulk insert; validated when the batch is merged.
CREATE TABLE IF NOT EXISTS cost_staging (
  batch_id TEXT NOT NULL,
  provider TEXT, resource_id TEXT, resource_type TEXT, service TEXT, usage_cost TEXT,
  cpu_avg TEXT, attached_instance_id TEXT, tags TEXT, billing_date TEXT,
  loaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cost_staging_batch ON cost_staging (batch_id);

CREATE TABLE IF NOT EXISTS cost_batches (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'nifi',
  status TEXT NOT NULL CHECK (status IN ('queued','processing','completed','failed')) DEFAULT 'queued',
  accepted INT NOT NULL DEFAULT 0,
  rejected INT NOT NULL DEFAULT 0,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS cost_records (
  provider TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  service TEXT NOT NULL,
  usage_cost NUMERIC(14,4) NOT NULL,
  cpu_avg NUMERIC(5,2),
  attached_instance_id TEXT,
  tags JSONB NOT NULL DEFAULT '{}',
  billing_date DATE NOT NULL,
  batch_id TEXT,
  PRIMARY KEY (provider, resource_id, service, billing_date)
);
CREATE INDEX IF NOT EXISTS cost_records_date ON cost_records (billing_date);

CREATE TABLE IF NOT EXISTS cost_findings (
  id SERIAL PRIMARY KEY,
  dedupe_key TEXT UNIQUE NOT NULL,
  rule TEXT NOT NULL CHECK (rule IN ('spike','idle','overprovisioned','unattached')),
  provider TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  service TEXT NOT NULL,
  team TEXT NOT NULL DEFAULT 'unassigned',
  env TEXT NOT NULL DEFAULT 'unknown',
  monthly_cost NUMERIC(14,2) NOT NULL,
  max_savings NUMERIC(14,2) NOT NULL,       -- deterministic ceiling; an AI estimate can never exceed it
  evidence JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('open','pr_opened','intentional','resolved')) DEFAULT 'open',
  root_cause TEXT,
  risk_level TEXT CHECK (risk_level IN ('LOW','MEDIUM','HIGH')),
  remediation_snippet TEXT,
  estimated_monthly_savings NUMERIC(14,2),
  analysis_source TEXT,                     -- gemini | rules
  approvals INT[] NOT NULL DEFAULT '{}',
  pr_url TEXT,
  decided_by INT REFERENCES users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  decision_note TEXT,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cost_findings_status ON cost_findings (status, max_savings DESC);

CREATE TABLE IF NOT EXISTS cost_exclusions (
  resource_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT '',
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
