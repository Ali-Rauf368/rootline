import { q, one, tx, hasPgvector } from "../db/pool.js";
import { chunkMarkdown, embed, cosine } from "../lib/text.js";

export interface Hit { chunkId: number; documentId: number; title: string; kind: string; service: string | null; heading: string; content: string; score: number; bm25Rank: number | null; vectorRank: number | null }

export async function upsertDocument(doc: { kind: string; title: string; service?: string | null; content: string; sourceUrl?: string | null }, id?: number) {
  return tx(async (c) => {
    const row = id
      ? (await c.query("UPDATE documents SET kind=$1, title=$2, service=$3, content=$4, source_url=$5, updated_at=now() WHERE id=$6 RETURNING *", [doc.kind, doc.title, doc.service ?? null, doc.content, doc.sourceUrl ?? null, id])).rows[0]
      : (await c.query("INSERT INTO documents (kind, title, service, content, source_url) VALUES ($1,$2,$3,$4,$5) RETURNING *", [doc.kind, doc.title, doc.service ?? null, doc.content, doc.sourceUrl ?? null])).rows[0];
    if (!row) return null;
    await c.query("DELETE FROM doc_chunks WHERE document_id = $1", [row.id]);
    const chunks = chunkMarkdown(doc.content);
    for (const [i, ch] of chunks.entries()) {
      await c.query("INSERT INTO doc_chunks (document_id, idx, heading, content, embedding) VALUES ($1,$2,$3,$4,$5)", [row.id, i, ch.heading, ch.content, embed(`${doc.title} ${ch.heading} ${ch.content}`)]);
    }
    return { ...row, chunks: chunks.length };
  });
}

/**
 * Hybrid retrieval: Postgres full-text (ts_rank_cd) + dense vectors, fused with Reciprocal Rank Fusion (k=60).
 * Uses pgvector's <=> when the extension exists, otherwise ranks real[] embeddings in-process.
 */
export async function searchKnowledge(query: string, opts: { k?: number; service?: string } = {}): Promise<Hit[]> {
  const k = opts.k ?? 6;
  const svc = opts.service ?? null;
  const lexical = await q<{ id: number; rank: number }>(
    `SELECT c.id, ts_rank_cd(c.tsv, query) AS rank
     FROM doc_chunks c JOIN documents d ON d.id = c.document_id, websearch_to_tsquery('english', $1) query
     WHERE c.tsv @@ query OR c.tsv @@ to_tsquery('english', $2)
     ORDER BY (CASE WHEN $3::text IS NOT NULL AND d.service = $3 THEN 1 ELSE 0 END) DESC, rank DESC LIMIT 30`,
    [query, orQuery(query), svc]);
  const qv = embed(query);
  let dense: { id: number; sim: number }[];
  if (await hasPgvector()) {
    dense = await q(`SELECT id, 1 - (embedding::vector <=> $1::vector) AS sim FROM doc_chunks ORDER BY embedding::vector <=> $1::vector LIMIT 30`, [`[${qv.join(",")}]`]);
  } else {
    const all = await q<{ id: number; embedding: number[] }>("SELECT id, embedding FROM doc_chunks");
    dense = all.map((r) => ({ id: r.id, sim: cosine(qv, r.embedding) })).sort((a, b) => b.sim - a.sim).slice(0, 30);
  }
  const scores = new Map<number, { s: number; l: number | null; v: number | null }>();
  lexical.forEach((r, i) => scores.set(r.id, { s: 1 / (60 + i + 1), l: i + 1, v: null }));
  dense.filter((r) => r.sim > 0.05).forEach((r, i) => { const e = scores.get(r.id) ?? { s: 0, l: null, v: null }; e.s += 1 / (60 + i + 1); e.v = i + 1; scores.set(r.id, e); });
  const top = [...scores.entries()].sort((a, b) => b[1].s - a[1].s).slice(0, k * 2);
  if (!top.length) return [];
  const rows = await q(`SELECT c.id AS "chunkId", c.document_id AS "documentId", d.title, d.kind, d.service, c.heading, c.content FROM doc_chunks c JOIN documents d ON d.id = c.document_id WHERE c.id = ANY($1)`, [top.map(([id]) => id)]);
  const byId = new Map(rows.map((r) => [r.chunkId, r]));
  return top
    .map(([id, sc]) => ({ ...byId.get(id), score: Math.round(sc.s * 10000) / 10000 * (svc && byId.get(id)?.service === svc ? 1.15 : 1), bm25Rank: sc.l, vectorRank: sc.v }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k) as Hit[];
}

const orQuery = (s: string) => (s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).slice(0, 12).join(" | ") || "x";

export const getDocument = (id: number) => one("SELECT * FROM documents WHERE id = $1", [id]);
