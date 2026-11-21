"use client";
import { cx } from "./ui";

/** Unified diff viewer with line numbers and add/remove highlighting. */
export function DiffView({ diff, maxHeight = 420 }: { diff: string; maxHeight?: number }) {
  let oldN = 0, newN = 0;
  const lines = diff.split("\n").filter((l) => !/^(={3,}|Index:|\\ No newline)/.test(l));
  return (
    <div className="overflow-auto rounded-lg border border-line bg-bg text-[12px] leading-5 mono" style={{ maxHeight }}>
      <table className="w-full border-collapse">
        <tbody>
          {lines.map((l, i) => {
            const hunk = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
            if (hunk) { oldN = Number(hunk[1]); newN = Number(hunk[2]); return <tr key={i} className="bg-info/10 text-info"><td colSpan={3} className="px-3 py-0.5">{l}</td></tr>; }
            if (l.startsWith("---") || l.startsWith("+++")) return <tr key={i} className="text-muted"><td colSpan={3} className="px-3 py-0.5 font-semibold">{l}</td></tr>;
            const add = l.startsWith("+"), del = l.startsWith("-");
            const o = add ? "" : oldN++, n = del ? "" : newN++;
            return (
              <tr key={i} className={cx(add && "bg-ok/12", del && "bg-bad/12")}>
                <td className="w-10 select-none border-r border-line/60 px-2 text-right text-subtle">{o}</td>
                <td className="w-10 select-none border-r border-line/60 px-2 text-right text-subtle">{n}</td>
                <td className={cx("whitespace-pre px-3", add && "text-ok", del && "text-bad")}>{l || " "}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
