import type { PoolClient } from "pg";
import { tx } from "../db/pool.js";

/** Validates a staged batch and merges it into cost_records. Re-importing the same days overwrites them. */
export async function mergeBatch(c: PoolClient, batchId: string) {
  const { rows: [{ total }] } = await c.query("SELECT count(*)::int AS total FROM cost_staging WHERE batch_id = $1", [batchId]);
  const { rows: [{ accepted }] } = await c.query(`
    WITH valid AS MATERIALIZED (
      SELECT * FROM cost_staging
      WHERE batch_id = $1
        AND coalesce(provider, '') <> '' AND coalesce(resource_id, '') <> '' AND coalesce(service, '') <> ''
        AND usage_cost ~ '^-?[0-9]{1,9}([.][0-9]+)?$'
        AND pg_input_is_valid(billing_date, 'date') AND billing_date ~ '^[0-9]{4}-'
        AND (coalesce(cpu_avg, '') = '' OR cpu_avg ~ '^([0-9]{1,2}([.][0-9]+)?|100([.]0+)?)$')
        AND (coalesce(tags, '') = '' OR (pg_input_is_valid(tags, 'jsonb') AND left(ltrim(tags), 1) = '{'))
    ), merged AS (
      INSERT INTO cost_records (provider, resource_id, resource_type, service, usage_cost, cpu_avg, attached_instance_id, tags, billing_date, batch_id)
      SELECT lower(provider), resource_id, max(coalesce(nullif(resource_type, ''), 'other')), service, sum(usage_cost::numeric),
             avg(nullif(cpu_avg, '')::numeric), max(nullif(attached_instance_id, '')),
             coalesce((array_agg(nullif(tags, '')::jsonb) FILTER (WHERE nullif(tags, '') IS NOT NULL))[1], '{}'), billing_date::date, $1
      FROM valid GROUP BY lower(provider), resource_id, service, billing_date::date
      ON CONFLICT (provider, resource_id, service, billing_date) DO UPDATE SET
        resource_type = EXCLUDED.resource_type, usage_cost = EXCLUDED.usage_cost, cpu_avg = EXCLUDED.cpu_avg,
        attached_instance_id = EXCLUDED.attached_instance_id, tags = EXCLUDED.tags, batch_id = EXCLUDED.batch_id
    ) SELECT count(*)::int AS accepted FROM valid`, [batchId]);
  await c.query("DELETE FROM cost_staging WHERE batch_id = $1", [batchId]);
  return { accepted: accepted as number, rejected: (total - accepted) as number };
}

/** Daily service cost > 125% of the average of the 7 preceding days (latest day per service). Excluded resources don't count. */
const SPIKE_SQL = `
  WITH daily AS (
    SELECT provider, service, billing_date, sum(usage_cost) AS daily_cost
    FROM cost_records r WHERE NOT EXISTS (SELECT 1 FROM cost_exclusions x WHERE x.resource_id = r.resource_id)
    GROUP BY 1, 2, 3
  ), rolling AS (
    SELECT *, avg(daily_cost) OVER w AS baseline, count(*) OVER w AS days,
           row_number() OVER (PARTITION BY provider, service ORDER BY billing_date DESC) AS rn
    FROM daily WINDOW w AS (PARTITION BY provider, service ORDER BY billing_date ROWS BETWEEN 7 PRECEDING AND 1 PRECEDING)
  ), spikes AS (
    SELECT *, 'service:' || provider || '/' || service AS rid FROM rolling
    WHERE rn = 1 AND days = 7 AND baseline > 0 AND daily_cost > baseline * 1.25 AND daily_cost - baseline >= 1
  )
  INSERT INTO cost_findings (dedupe_key, rule, provider, resource_id, service, team, env, monthly_cost, max_savings, evidence)
  SELECT 'spike:' || rid || ':' || billing_date, 'spike', provider, rid, service,
         coalesce(top.tags->>'owner', 'unassigned'), coalesce(top.tags->>'env', 'unknown'),
         daily_cost * 30, (daily_cost - baseline) * 30,
         jsonb_build_object('billingDate', billing_date, 'dailyCost', round(daily_cost, 2), 'baseline', round(baseline, 2),
           'increasePct', round((daily_cost / baseline - 1) * 100, 1), 'topResource', top.resource_id, 'tags', top.tags)
  FROM spikes s CROSS JOIN LATERAL (
    -- the resource that grew most against its own previous week
    SELECT r.resource_id, r.tags FROM cost_records r
    WHERE r.provider = s.provider AND r.service = s.service AND r.billing_date = s.billing_date
      AND NOT EXISTS (SELECT 1 FROM cost_exclusions x WHERE x.resource_id = r.resource_id)
    ORDER BY r.usage_cost - coalesce((SELECT avg(p.usage_cost) FROM cost_records p WHERE p.provider = r.provider AND p.resource_id = r.resource_id
      AND p.service = r.service AND p.billing_date BETWEEN r.billing_date - 7 AND r.billing_date - 1), 0) DESC LIMIT 1
  ) top
  WHERE NOT EXISTS (SELECT 1 FROM cost_exclusions x WHERE x.resource_id = s.rid)
  ON CONFLICT (dedupe_key) DO NOTHING`;

/** Idle (<2% CPU), over-provisioned (<10% CPU) over 14 full days; storage/IPs with no attachment. */
const WASTE_SQL = `
  WITH latest AS (SELECT provider, max(billing_date) AS d FROM cost_records GROUP BY 1),
  usage AS (
    SELECT r.provider, r.resource_id, r.service, avg(r.cpu_avg) AS cpu, count(DISTINCT r.billing_date) FILTER (WHERE r.cpu_avg IS NOT NULL) AS cpu_days,
           count(DISTINCT r.billing_date) AS days, sum(r.usage_cost) / count(DISTINCT r.billing_date) * 30 AS monthly,
           max(r.billing_date) = max(l.d) AS current,
           (array_agg(r.resource_type ORDER BY r.billing_date DESC))[1] AS type,
           (array_agg(r.attached_instance_id ORDER BY r.billing_date DESC))[1] AS attached,
           (array_agg(r.tags ORDER BY r.billing_date DESC))[1] AS tags
    FROM cost_records r JOIN latest l ON l.provider = r.provider AND r.billing_date > l.d - 14
    WHERE NOT EXISTS (SELECT 1 FROM cost_exclusions x WHERE x.resource_id = r.resource_id)
    GROUP BY 1, 2, 3
  ), hits AS (
    SELECT *, CASE
        WHEN type IN ('volume', 'ip') AND attached IS NULL THEN 'unattached'
        WHEN cpu_days >= 14 AND cpu < 2 THEN 'idle'
        WHEN cpu_days >= 14 AND cpu < 10 THEN 'overprovisioned' END AS rule
    FROM usage WHERE current AND monthly > 0
  ), upserted AS (
    INSERT INTO cost_findings (dedupe_key, rule, provider, resource_id, service, team, env, monthly_cost, max_savings, evidence)
    SELECT 'waste:' || provider || ':' || service || ':' || resource_id, rule, provider, resource_id, service,
           coalesce(tags->>'owner', 'unassigned'), coalesce(tags->>'env', 'unknown'), monthly,
           CASE rule WHEN 'overprovisioned' THEN monthly / 2 ELSE monthly END,
           jsonb_build_object('resourceType', type, 'cpuAvg14d', round(cpu, 2), 'days', days, 'attachedInstanceId', attached, 'tags', tags)
    FROM hits WHERE rule IS NOT NULL
    ON CONFLICT (dedupe_key) DO UPDATE SET monthly_cost = EXCLUDED.monthly_cost, max_savings = EXCLUDED.max_savings, evidence = EXCLUDED.evidence,
      rule = EXCLUDED.rule, team = EXCLUDED.team, env = EXCLUDED.env, status = 'open', approvals = CASE WHEN cost_findings.rule = EXCLUDED.rule AND cost_findings.status = 'open' THEN cost_findings.approvals ELSE '{}' END,
      -- a different problem needs a new analysis; a lower ceiling caps the old estimate
      analysis_source = CASE WHEN cost_findings.rule = EXCLUDED.rule AND cost_findings.status = 'open' THEN cost_findings.analysis_source END,
      estimated_monthly_savings = least(cost_findings.estimated_monthly_savings, EXCLUDED.max_savings)
      WHERE cost_findings.status IN ('open', 'resolved')
    RETURNING id
  )
  UPDATE cost_findings SET status = 'resolved'
  WHERE rule <> 'spike' AND status = 'open' AND dedupe_key NOT IN (SELECT 'waste:' || provider || ':' || service || ':' || resource_id FROM hits WHERE rule IS NOT NULL)`;

/** All of the maths, in PostgreSQL. No LLM is involved in deciding what is waste. */
export async function detect(c: PoolClient) {
  await c.query(SPIKE_SQL);
  await c.query(WASTE_SQL);
}

/** Merge + detect commit together, so a crash leaves the staged rows for the retry. */
export const ingestBatch = (batchId: string) => tx(async (c) => {
  await c.query("SELECT pg_advisory_xact_lock(hashtext('opsmeridian.finops'))");
  const done = (await c.query("SELECT accepted, rejected FROM cost_batches WHERE id = $1 AND accepted + rejected > 0", [batchId])).rows[0];
  if (done) return done as { accepted: number; rejected: number }; // merged on an earlier attempt
  const r = await mergeBatch(c, batchId);
  await detect(c);
  await c.query("UPDATE cost_batches SET accepted = $2, rejected = $3 WHERE id = $1", [batchId, r.accepted, r.rejected]);
  return r;
});
