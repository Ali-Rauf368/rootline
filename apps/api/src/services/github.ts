import { Octokit } from "@octokit/rest";
import { parsePatch } from "diff";
import { env } from "../lib/env.js";
import type { Verification } from "./patches.js";

/**
 * Opens a draft PR for an approved fix. With GITHUB_TOKEN and a service repo configured it uses the GitHub API
 * (branch from default branch → commit patched files → draft PR). Otherwise it records a simulated PR so the
 * full workflow can be exercised locally.
 */
export async function openDraftPr(input: { repo: string | null; service: string; branch: string; title: string; body: string; verification: Verification; testPatch: string }) {
  if (!env.GITHUB_TOKEN || !input.repo) {
    return { mode: "simulated" as const, url: `https://github.com/${input.repo ?? `example/${input.service}`}/pull/new/${input.branch}`, number: null };
  }
  const [owner, repo] = input.repo.split("/");
  const gh = new Octokit({ auth: env.GITHUB_TOKEN });
  const { data: r } = await gh.repos.get({ owner, repo });
  const { data: ref } = await gh.git.getRef({ owner, repo, ref: `heads/${r.default_branch}` });
  await gh.git.createRef({ owner, repo, ref: `refs/heads/${input.branch}`, sha: ref.object.sha });

  const files = [...input.verification.files.map((f) => ({ path: f.path, content: f.after }))];
  for (const p of parsePatch(input.testPatch)) {
    const path = (p.newFileName ?? "").replace(/^b\//, "");
    if (path) files.push({ path, content: p.hunks.flatMap((h) => h.lines.filter((l) => l.startsWith("+")).map((l) => l.slice(1))).join("\n") + "\n" });
  }
  for (const f of files) {
    let sha: string | undefined;
    try { const { data } = await gh.repos.getContent({ owner, repo, path: f.path, ref: input.branch }); if (!Array.isArray(data)) sha = data.sha; } catch { /* new file */ }
    await gh.repos.createOrUpdateFileContents({ owner, repo, path: f.path, branch: input.branch, message: `${input.title} (${f.path})`, content: Buffer.from(f.content).toString("base64"), sha });
  }
  const { data: pr } = await gh.pulls.create({ owner, repo, head: input.branch, base: r.default_branch, title: input.title, body: input.body, draft: true });
  return { mode: "github" as const, url: pr.html_url, number: pr.number };
}
