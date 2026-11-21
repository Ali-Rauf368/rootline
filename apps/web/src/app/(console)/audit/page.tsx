"use client";
import { ShieldCheck } from "lucide-react";
import { useApi } from "@/lib/api";
import { Card, PageHeader, Badge, Empty, ErrorBox, Skeleton } from "@/components/ui";
import { dateTime } from "@/lib/format";

export default function AuditPage() {
  const a = useApi<any[]>("/api/audit?limit=300", { refreshMs: 15_000 }); // eslint-disable-line @typescript-eslint/no-explicit-any
  if (a.error) return <ErrorBox message={a.error} onRetry={a.reload} />;
  return (
    <>
      <PageHeader title="Audit log" subtitle="Append-only record of human and agent decisions: approvals, rejections, status changes, keys, logins" />
      {!a.data ? <Skeleton className="h-96" /> : !a.data.length ? <Card><Empty icon={ShieldCheck} title="Nothing recorded yet" /></Card> : (
        <Card className="overflow-hidden"><div className="overflow-x-auto">
          <table className="w-full min-w-[700px] text-sm">
            <thead className="border-b border-line text-left text-xs text-subtle"><tr><th className="px-4 py-2.5 font-medium">When</th><th className="px-3 font-medium">Actor</th><th className="px-3 font-medium">Action</th><th className="px-3 font-medium">Target</th><th className="px-4 font-medium">Details</th></tr></thead>
            <tbody>{a.data.map((r) => (
              <tr key={r.id} className="table-row">
                <td className="whitespace-nowrap px-4 py-2.5 text-xs text-muted">{dateTime(r.ts)}</td>
                <td className="px-3 text-xs">{r.actor}</td>
                <td className="px-3"><Badge tone={r.action.includes("approve") ? "ok" : r.action.includes("reject") || r.action.includes("failed") || r.action.includes("revoked") ? "bad" : r.action.startsWith("investigation") ? "accent" : "neutral"}>{r.action}</Badge></td>
                <td className="px-3 text-xs mono text-muted">{r.target}</td>
                <td className="max-w-md truncate px-4 text-xs text-subtle mono">{Object.keys(r.data ?? {}).length ? JSON.stringify(r.data) : ""}</td>
              </tr>))}</tbody>
          </table>
        </div></Card>
      )}
    </>
  );
}
