import { applyPatch, createTwoFilesPatch, parsePatch, reversePatch } from "diff";
import { q } from "../db/pool.js";

/**
 * Builds a clean a→b revert of a deploy's diff against the current repository snapshot:
 * reverse the deploy's hunks, apply them to HEAD, then re-diff HEAD → reverted content.
 */
export async function revertDiff(service: string, diff: string): Promise<string> {
  const out: string[] = [];
  for (const p of parsePatch(diff).filter((x) => x.hunks.length)) {
    const path = (p.newFileName ?? p.oldFileName ?? "").replace(/^[ab]\//, "");
    const [snap] = await q<{ content: string }>("SELECT content FROM repo_files WHERE service = $1 AND path = $2", [service, path]);
    if (!snap) continue;
    const reverted = applyPatch(snap.content, reversePatch(p), { fuzzFactor: 0 });
    if (reverted === false || reverted === snap.content) continue;
    out.push(cleanDiff(createTwoFilesPatch(`a/${path}`, `b/${path}`, snap.content, reverted, "", "", { context: 3 })));
  }
  return out.join("\n");
}

/** Strips jsdiff's "Index:"/"====" preamble and empty header timestamps. */
export const cleanDiff = (d: string) => d.replace(/^Index:.*\n/m, "").replace(/^=+\n/m, "").replace(/^(---|\+\+\+) (\S+)\t$/gm, "$1 $2");

export interface Verification {
  passed: boolean;
  checks: { name: string; status: "pass" | "fail" | "skip"; detail: string }[];
  files: { path: string; before: string; after: string }[];
  verifiedAt: string;
}

const CONFIG_RULES: { file: RegExp; key: RegExp; min?: number; max?: number; label: string }[] = [
  { file: /config|settings|\.env|values/i, key: /pool_?size|max_?connections/i, min: 10, max: 500, label: "connection pool size" },
  { file: /config|settings|\.env|values/i, key: /timeout_?ms/i, min: 500, max: 60000, label: "timeout (ms)" },
  { file: /config|settings|\.env|values/i, key: /max_?entries|cache_?size/i, min: 1, max: 1_000_000, label: "cache bound" },
  { file: /config|settings|\.env|values/i, key: /retries/i, min: 0, max: 10, label: "retry count" },
];

/**
 * Verifies a patch before any PR exists:
 *  1. applies cleanly (no fuzz) to the current repository snapshot
 *  2. results parse (JSON/YAML-ish key/values are well-formed; braces balanced in source)
 *  3. configuration values are within safe operating ranges
 *  4. a regression test accompanies the change
 */
export async function verifyPatch(service: string, patch: string, testPatch: string): Promise<Verification> {
  const checks: Verification["checks"] = [];
  const files: Verification["files"] = [];
  let parsed: ReturnType<typeof parsePatch> = [];
  try { parsed = parsePatch(patch).filter((p) => p.hunks.length); } catch (e) { parsed = []; checks.push({ name: "Patch parses", status: "fail", detail: (e as Error).message }); }
  if (!parsed.length) checks.push({ name: "Patch parses", status: "fail", detail: "No hunks found in patch" });

  for (const p of parsed) {
    const path = (p.newFileName ?? p.oldFileName ?? "").replace(/^[ab]\//, "");
    const [snap] = await q<{ content: string }>("SELECT content FROM repo_files WHERE service = $1 AND path = $2", [service, path]);
    if (!snap) { checks.push({ name: `Apply to ${path}`, status: "fail", detail: "File not found in repository snapshot" }); continue; }
    const result = applyPatch(snap.content, p, { fuzzFactor: 0 });
    if (result === false) { checks.push({ name: `Apply to ${path}`, status: "fail", detail: "Hunks do not match HEAD (patch is stale or wrong)" }); continue; }
    checks.push({ name: `Apply to ${path}`, status: "pass", detail: `${p.hunks.length} hunk(s) applied without fuzz` });
    files.push({ path, before: snap.content, after: result });

    // syntax sanity
    if (path.endsWith(".json")) {
      try { JSON.parse(result); checks.push({ name: `Valid JSON: ${path}`, status: "pass", detail: "Parses" }); }
      catch (e) { checks.push({ name: `Valid JSON: ${path}`, status: "fail", detail: (e as Error).message }); }
    } else if (/\.(ts|js|go|java|py)$/.test(path)) {
      const balanced = ["()", "{}", "[]"].every(([o, c]) => result.split(o).length === result.split(c).length);
      checks.push({ name: `Syntax balance: ${path}`, status: balanced ? "pass" : "fail", detail: balanced ? "Brackets balanced" : "Unbalanced brackets after patch" });
    }
    // config ranges
    for (const rule of CONFIG_RULES.filter((r) => r.file.test(path))) {
      for (const line of result.split("\n")) {
        const m = line.match(/["']?([A-Za-z_]+)["']?\s*[:=]\s*(\d+)/);
        if (m && rule.key.test(m[1])) {
          const v = Number(m[2]);
          const ok = (rule.min === undefined || v >= rule.min) && (rule.max === undefined || v <= rule.max);
          checks.push({ name: `Safe ${rule.label}: ${m[1]}`, status: ok ? "pass" : "fail", detail: `${m[1]} = ${v} (allowed ${rule.min ?? "-∞"}…${rule.max ?? "∞"})` });
        }
      }
    }
  }
  checks.push(testPatch.trim()
    ? { name: "Regression test included", status: "pass", detail: `${testPatch.split("\n").filter((l) => l.startsWith("+")).length} added test lines (executed by CI on the PR)` }
    : { name: "Regression test included", status: "fail", detail: "No test accompanies the fix" });
  return { passed: checks.length > 0 && checks.every((c) => c.status !== "fail"), checks, files, verifiedAt: new Date().toISOString() };
}

/** Builds a "new file" unified diff for a generated regression test. */
export const newFileDiff = (path: string, content: string) => cleanDiff(createTwoFilesPatch(`/dev/null`, `b/${path}`, "", content, "", "", { context: 3 }));
