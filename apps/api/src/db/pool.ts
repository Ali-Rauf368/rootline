import pg from "pg";
import { env } from "../lib/env.js";

// BIGINT counts come back as strings by default; they are safe as JS numbers at our scale.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

export const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 15, idleTimeoutMillis: 30_000 });
pool.on("error", (e) => console.error("pg pool error:", e.message));

export async function q<T = any>(text: string, params: unknown[] = []): Promise<T[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  return (await pool.query(text, params)).rows as T[];
}
export async function one<T = any>(text: string, params: unknown[] = []): Promise<T | null> { // eslint-disable-line @typescript-eslint/no-explicit-any
  return (await pool.query(text, params)).rows[0] ?? null;
}

/** Runs fn inside a transaction on one client. */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

let vectorSupport: boolean | null = null;
/** pgvector is used when the extension is installed; otherwise embeddings are stored as real[] and ranked in SQL. */
export async function hasPgvector(): Promise<boolean> {
  if (vectorSupport === null) vectorSupport = Boolean(await one("SELECT 1 FROM pg_extension WHERE extname = 'vector'"));
  return vectorSupport;
}
