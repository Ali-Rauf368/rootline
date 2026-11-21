import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./pool.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Applies the idempotent schema; enables pgvector when available (optional). */
export async function migrate() {
  await pool.query(fs.readFileSync(path.join(here, "schema.sql"), "utf8"));
  try {
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
  } catch {
    /* pgvector not installed: vector search falls back to SQL over real[] */
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await migrate();
  console.log("schema applied");
  await pool.end();
}
