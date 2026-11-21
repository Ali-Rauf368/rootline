/** Normalises a log message into a stable signature: numbers, ids, hex, quoted values and durations removed. */
export function fingerprint(message: string): string {
  return message
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
    .replace(/\b[0-9a-f]{16,}\b/gi, "<hash>")
    .replace(/(["'])(?:(?=(\\?))\2.)*?\1/g, "<str>")
    .replace(/\b\d+(\.\d+)?(ms|s|m|h|kb|mb|gb|%)?\b/gi, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

const STOP = new Set("a an the and or of to in on for is are was were be been it this that with as at by from not no into than then there these those which who what when where how why do does did can could should would will".split(" "));
/** Lower-cased word tokens; camelCase / snake_case identifiers are split so "poolSize" matches "pool size". */
export const tokenize = (s: string) =>
  (s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase().match(/[a-z0-9]{2,}/g) ?? []).filter((w) => !STOP.has(w));

/**
 * Local embedding model: signed feature hashing of unigrams + bigrams + char trigrams into 384 dims, L2-normalised.
 * Deterministic, dependency-free and good enough for runbook retrieval; swap for a hosted embedding model via EMBEDDINGS_URL.
 */
export const EMBED_DIM = 384;
function hash32(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
export function embed(text: string): number[] {
  const v = new Float64Array(EMBED_DIM);
  const toks = tokenize(text);
  const feats: [string, number][] = [];
  toks.forEach((t, i) => { feats.push([t, 1]); if (i) feats.push([`${toks[i - 1]}_${t}`, 0.7]); if (t.length > 4) for (let j = 0; j < t.length - 2; j++) feats.push([`#${t.slice(j, j + 3)}`, 0.25]); });
  for (const [f, w] of feats) { const h = hash32(f); v[h % EMBED_DIM] += (h & 0x80000000 ? -1 : 1) * w; }
  const norm = Math.hypot(...v) || 1;
  return Array.from(v, (x) => Math.round((x / norm) * 1e5) / 1e5);
}
export const cosine = (a: number[], b: number[]) => { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d; };

/** Splits markdown into heading-aware chunks of ~220 words. */
export function chunkMarkdown(md: string, maxWords = 220): { heading: string; content: string }[] {
  const out: { heading: string; content: string }[] = [];
  let heading = "", buf: string[] = [];
  const flush = () => { const text = buf.join("\n").trim(); if (text) out.push({ heading, content: text }); buf = []; };
  for (const line of md.split("\n")) {
    const h = line.match(/^#{1,4}\s+(.*)/);
    if (h) { flush(); heading = h[1].trim(); continue; }
    buf.push(line);
    if (buf.join(" ").split(/\s+/).length >= maxWords) flush();
  }
  flush();
  return out;
}
