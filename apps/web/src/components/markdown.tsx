"use client";
import { Fragment, ReactNode } from "react";

/** Minimal, safe markdown renderer for runbooks (headings, lists, code, bold, inline code). No HTML injection. */
export function Markdown({ text, highlight }: { text: string; highlight?: string }) {
  const out: ReactNode[] = [];
  let list: ReactNode[] = [], ordered = false, code: string[] | null = null;
  const flushList = () => { if (list.length) { out.push(ordered ? <ol key={out.length} className="my-2 list-decimal space-y-1 pl-5">{list}</ol> : <ul key={out.length} className="my-2 list-disc space-y-1 pl-5">{list}</ul>); list = []; } };
  const inline = (s: string) => {
    const parts = s.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
    return parts.map((p, i) => p.startsWith("`") ? <code key={i} className="rounded bg-raised px-1 py-0.5 text-[0.85em] mono">{p.slice(1, -1)}</code> : p.startsWith("**") ? <strong key={i}>{p.slice(2, -2)}</strong> : <Fragment key={i}>{mark(p)}</Fragment>);
  };
  const mark = (s: string) => {
    if (!highlight) return s;
    const i = s.toLowerCase().indexOf(highlight.toLowerCase().slice(0, 60));
    if (i < 0) return s;
    return <>{s.slice(0, i)}<mark className="rounded bg-warn/30 px-0.5 text-fg">{s.slice(i, i + highlight.length)}</mark>{s.slice(i + highlight.length)}</>;
  };
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) { if (code) { out.push(<pre key={out.length} className="my-2 overflow-x-auto rounded-lg bg-raised p-3 text-xs mono">{code.join("\n")}</pre>); code = null; } else { flushList(); code = []; } continue; }
    if (code) { code.push(line); continue; }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) { flushList(); const sz = ["text-lg", "text-base", "text-sm", "text-sm"][h[1].length - 1]; out.push(<p key={out.length} className={`mt-4 mb-1 font-semibold first:mt-0 ${sz}`}>{inline(h[2])}</p>); continue; }
    const li = line.match(/^\s*([-*]|\d+\.)\s+(.*)/);
    if (li) { ordered = /\d/.test(li[1]); list.push(<li key={list.length}>{inline(li[2])}</li>); continue; }
    flushList();
    if (line.trim()) out.push(<p key={out.length} className="my-1.5 leading-relaxed">{inline(line)}</p>);
  }
  flushList();
  return <div className="text-sm text-fg/90">{out}</div>;
}
