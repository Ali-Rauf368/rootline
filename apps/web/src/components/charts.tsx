"use client";
import { ResponsiveContainer, AreaChart, Area, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ReferenceArea, BarChart, Bar, Legend } from "recharts";
import { hm } from "@/lib/format";

export const SERIES_COLORS = ["#818cf8", "#34d399", "#fbbf24", "#f87171", "#38bdf8", "#c084fc", "#2dd4bf", "#fb923c", "#a3e635"];
const axis = { fill: "rgb(var(--subtle))", fontSize: 11 };
const tooltip = { contentStyle: { background: "rgb(var(--panel))", border: "1px solid rgb(var(--line))", borderRadius: 10, fontSize: 12, color: "rgb(var(--fg))" }, labelStyle: { color: "rgb(var(--muted))" } };

export interface Marker { ts: string | number; label: string; tone?: "deploy" | "onset" | "fix" }

/** Multi-series time chart with deploy/onset markers and an optional highlighted incident window. */
export function TimeSeries({ data, series, height = 240, format = (v: number) => String(v), markers = [], window: win, area = true }: {
  data: Record<string, number | string | null>[]; series: { key: string; label: string; color?: string }[]; height?: number;
  format?: (v: number) => string; markers?: Marker[]; window?: { from: number; to: number }; area?: boolean;
}) {
  const Chart = area ? AreaChart : LineChart;
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer>
        <Chart data={data} margin={{ top: 12, right: 8, left: 0, bottom: 0 }}>
          <defs>{series.map((s, i) => <linearGradient key={s.key} id={`g-${s.key}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={s.color ?? SERIES_COLORS[i]} stopOpacity={0.35} /><stop offset="100%" stopColor={s.color ?? SERIES_COLORS[i]} stopOpacity={0} /></linearGradient>)}</defs>
          <CartesianGrid vertical={false} stroke="rgb(var(--line))" strokeDasharray="3 3" />
          <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={(v) => hm(new Date(v))} tick={axis} tickLine={false} axisLine={false} minTickGap={40} />
          <YAxis tick={axis} tickLine={false} axisLine={false} width={52} tickFormatter={(v) => format(Number(v))} />
          <Tooltip {...tooltip} labelFormatter={(v) => new Date(v as number).toLocaleTimeString()} formatter={(v: number, n: string) => [format(Number(v)), n]} />
          {win && <ReferenceArea x1={win.from} x2={win.to} fill="rgb(var(--bad))" fillOpacity={0.07} strokeOpacity={0} />}
          {markers.map((m, i) => (
            <ReferenceLine key={i} x={new Date(m.ts).getTime()} stroke={m.tone === "onset" ? "rgb(var(--bad))" : m.tone === "fix" ? "rgb(var(--ok))" : "rgb(var(--warn))"} strokeDasharray="4 3"
              label={{ value: m.label, position: "insideTopLeft", fill: m.tone === "onset" ? "rgb(var(--bad))" : m.tone === "fix" ? "rgb(var(--ok))" : "rgb(var(--warn))", fontSize: 10 }} />
          ))}
          {series.map((s, i) => area
            ? <Area key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color ?? SERIES_COLORS[i]} strokeWidth={1.8} fill={`url(#g-${s.key})`} dot={false} isAnimationActive={false} connectNulls />
            : <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color ?? SERIES_COLORS[i]} strokeWidth={1.8} dot={false} isAnimationActive={false} connectNulls />)}
          {series.length > 1 && <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />}
        </Chart>
      </ResponsiveContainer>
    </div>
  );
}

export function Sparkline({ values, color = "#818cf8", height = 32 }: { values: number[]; color?: string; height?: number }) {
  const data = values.map((v, i) => ({ i, v }));
  return (
    <div style={{ height }} className="w-full" aria-hidden>
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 2, right: 0, left: 0, bottom: 2 }}>
          <defs><linearGradient id={`sp-${color.slice(1)}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity={0.35} /><stop offset="100%" stopColor={color} stopOpacity={0} /></linearGradient></defs>
          <YAxis hide domain={["dataMin", "dataMax"]} />
          <Area type="monotone" dataKey="v" stroke={color} strokeWidth={1.5} fill={`url(#sp-${color.slice(1)})`} dot={false} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function Bars({ data, keys, height = 180 }: { data: Record<string, unknown>[]; keys: { key: string; label: string; color: string }[]; height?: number }) {
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 8, right: 0, left: -18, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="rgb(var(--line))" strokeDasharray="3 3" />
          <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={false} />
          <YAxis tick={axis} tickLine={false} axisLine={false} allowDecimals={false} />
          <Tooltip {...tooltip} cursor={{ fill: "rgb(var(--raised))" }} />
          <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
          {keys.map((k) => <Bar key={k.key} dataKey={k.key} name={k.label} fill={k.color} radius={[4, 4, 0, 0]} maxBarSize={18} />)}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Pivot long rows [{service|name, ts, value}] → wide rows keyed by series for Recharts. */
export function pivot(rows: { ts: string; value: number; [k: string]: unknown }[], seriesKey: string) {
  const map = new Map<number, Record<string, number>>();
  for (const r of rows) {
    const t = new Date(r.ts).getTime();
    const row = map.get(t) ?? { t };
    row[String(r[seriesKey])] = Number(r.value);
    map.set(t, row);
  }
  return [...map.values()].sort((a, b) => a.t - b.t);
}
