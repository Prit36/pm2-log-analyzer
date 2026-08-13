import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { AggregatedEndpoint, HourlyBucket } from "../parser";
import { formatMs, formatNum } from "../utils/format";
import { Activity, BarChart3, Clock, Flame } from "lucide-react";

import { useAnalysisStore } from "../store/analysisStore";

type ChartMode = "timeOfDay" | "throughput" | "distribution" | "topP95";

export function LatencyChart({
  rows,
  hourlyStats = [],
}: {
  rows: AggregatedEndpoint[];
  hourlyStats?: HourlyBucket[] | undefined;
}) {
  const [mode, setMode] = useState<ChartMode>("timeOfDay");
  const theme = useAnalysisStore((s) => s.theme);
  const isDark = theme === "dark";

  const gridStroke = isDark ? "#1e293b" : "#f1f5f9";
  const tickColor = isDark ? "#94a3b8" : "#64748b";
  const categoryTickColor = isDark ? "#cbd5e1" : "#334155";
  const tooltipStyle = isDark
    ? {
        fontSize: 12,
        borderRadius: 8,
        backgroundColor: "#0f172a",
        border: "1px solid #334155",
        color: "#f8fafc",
        boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.5)",
      }
    : { fontSize: 12, borderRadius: 6, border: "1px solid #cbd5e1" };

  const top20Data = useMemo(
    () =>
      rows.slice(0, 20).map((r) => ({
        name: `${r.method} ${r.path.length > 36 ? `${r.path.slice(0, 34)}…` : r.path}`,
        p95: Math.round(r.p95Ms),
        p99: Math.round(r.p99Ms),
        avg: Math.round(r.avgMs),
        full: `${r.method} ${r.path}`,
      })),
    [rows],
  );

  const distributionData = useMemo(() => {
    const buckets = [
      { label: "<50ms", count: 0, fill: "#22c55e" },
      { label: "50-100ms", count: 0, fill: "#84cc16" },
      { label: "100-300ms", count: 0, fill: "#eab308" },
      { label: "300-500ms", count: 0, fill: "#f97316" },
      { label: "500ms-1s", count: 0, fill: "#ef4444" },
      { label: "1s-3s", count: 0, fill: "#b91c1c" },
      { label: ">3s", count: 0, fill: "#7f1d1d" },
    ];

    const classify = (ms: number) => {
      if (ms < 50) return 0;
      if (ms < 100) return 1;
      if (ms < 300) return 2;
      if (ms < 500) return 3;
      if (ms < 1000) return 4;
      if (ms < 3000) return 5;
      return 6;
    };

    for (const r of rows) {
      const c = r.count;
      if (c <= 0) continue;
      const c50 = Math.round(c * 0.5);
      const c90 = Math.round(c * 0.4);
      const c95 = Math.round(c * 0.05);
      const c99 = Math.round(c * 0.04);
      const cMax = Math.max(0, c - c50 - c90 - c95 - c99);

      buckets[classify(r.p50Ms)]!.count += c50;
      buckets[classify((r.p50Ms + r.p90Ms) / 2)]!.count += c90;
      buckets[classify((r.p90Ms + r.p95Ms) / 2)]!.count += c95;
      buckets[classify((r.p95Ms + r.p99Ms) / 2)]!.count += c99;
      buckets[classify(r.maxMs)]!.count += cMax;
    }
    return buckets;
  }, [rows]);

  const hasData = rows.length > 0 || hourlyStats.some((h) => h.count > 0);

  return (
    <section className="flex flex-col rounded border border-slate-200 bg-white shadow-xs dark:border-slate-800/80 dark:bg-slate-900/80 dark:shadow-md dark:shadow-black/20">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-800">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-700 dark:text-slate-300">
          API Visual Analytics
        </h2>
        <div className="flex items-center gap-1 rounded bg-slate-100 p-0.5 text-xs dark:bg-slate-950">
          <button
            type="button"
            onClick={() => setMode("timeOfDay")}
            className={`flex items-center gap-1.5 rounded px-2 py-1 font-medium transition-colors ${
              mode === "timeOfDay"
                ? "bg-white text-blue-600 shadow-xs dark:bg-blue-600 dark:text-white dark:shadow-md dark:shadow-blue-950/50"
                : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200"
            }`}
            title="Time of Day vs Latency Trend"
          >
            <Clock className="h-3.5 w-3.5" />
            <span>Time vs Latency</span>
          </button>
          <button
            type="button"
            onClick={() => setMode("throughput")}
            className={`flex items-center gap-1.5 rounded px-2 py-1 font-medium transition-colors ${
              mode === "throughput"
                ? "bg-white text-blue-600 shadow-xs dark:bg-blue-600 dark:text-white dark:shadow-md dark:shadow-blue-950/50"
                : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200"
            }`}
            title="Hourly Request Volume & Error Rate"
          >
            <BarChart3 className="h-3.5 w-3.5" />
            <span>Hourly Volume</span>
          </button>
          <button
            type="button"
            onClick={() => setMode("distribution")}
            className={`flex items-center gap-1.5 rounded px-2 py-1 font-medium transition-colors ${
              mode === "distribution"
                ? "bg-white text-blue-600 shadow-xs dark:bg-blue-600 dark:text-white dark:shadow-md dark:shadow-blue-950/50"
                : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200"
            }`}
            title="Latency Distribution Buckets"
          >
            <Activity className="h-3.5 w-3.5" />
            <span>Distribution</span>
          </button>
          <button
            type="button"
            onClick={() => setMode("topP95")}
            className={`flex items-center gap-1.5 rounded px-2 py-1 font-medium transition-colors ${
              mode === "topP95"
                ? "bg-white text-blue-600 shadow-xs dark:bg-blue-600 dark:text-white dark:shadow-md dark:shadow-blue-950/50"
                : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200"
            }`}
            title="Top p95 Slowest Endpoints"
          >
            <Flame className="h-3.5 w-3.5" />
            <span>Top Slowest</span>
          </button>
        </div>
      </div>

      {!hasData ? (
        <div className="px-3 py-12 text-center text-sm text-slate-400 dark:text-slate-500">
          No chart data available yet.
        </div>
      ) : (
        <div className="h-[340px] px-3 py-3">
          <ResponsiveContainer width="100%" height={320}>
            {mode === "timeOfDay" ? (
              <AreaChart data={hourlyStats} margin={{ top: 10, right: 16, left: 0, bottom: 4 }}>
                <defs>
                  <linearGradient id="p99Grad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#7c3aed" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#7c3aed" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="p95Grad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#2563eb" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="#2563eb" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="avgGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#0d9488" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#0d9488" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: tickColor }} interval={2} />
                <YAxis
                  tick={{ fontSize: 10, fill: tickColor }}
                  tickFormatter={(v) => formatMs(Number(v))}
                />
                <Tooltip
                  formatter={(val, name) => [formatMs(Number(val ?? 0)), String(name)]}
                  labelFormatter={(lbl) => `Time: ${String(lbl)}`}
                  contentStyle={tooltipStyle}
                />
                <Legend
                  iconType="circle"
                  wrapperStyle={{ fontSize: 11, paddingTop: 4, color: tickColor }}
                />
                <Area
                  type="monotone"
                  dataKey="p99Ms"
                  name="P99 Latency"
                  stroke="#7c3aed"
                  fillOpacity={1}
                  fill="url(#p99Grad)"
                  strokeWidth={2}
                />
                <Area
                  type="monotone"
                  dataKey="p95Ms"
                  name="P95 Latency"
                  stroke="#2563eb"
                  fillOpacity={1}
                  fill="url(#p95Grad)"
                  strokeWidth={2}
                />
                <Area
                  type="monotone"
                  dataKey="avgMs"
                  name="Avg Latency"
                  stroke="#0d9488"
                  fillOpacity={1}
                  fill="url(#avgGrad)"
                  strokeWidth={1.5}
                />
              </AreaChart>
            ) : mode === "throughput" ? (
              <ComposedChart data={hourlyStats} margin={{ top: 10, right: 16, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: tickColor }} interval={2} />
                <YAxis
                  yAxisId="left"
                  tick={{ fontSize: 10, fill: tickColor }}
                  tickFormatter={(v) => formatNum(Number(v))}
                />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  tick={{ fontSize: 10, fill: "#ef4444" }}
                  tickFormatter={(v) => formatNum(Number(v))}
                />
                <Tooltip
                  formatter={(val, name) => [formatNum(Number(val ?? 0)), String(name)]}
                  labelFormatter={(lbl) => `Hour: ${String(lbl)}`}
                  contentStyle={tooltipStyle}
                />
                <Legend
                  iconType="circle"
                  wrapperStyle={{ fontSize: 11, paddingTop: 4, color: tickColor }}
                />
                <Bar
                  yAxisId="left"
                  dataKey="count"
                  name="Total Requests"
                  fill="#3b82f6"
                  radius={[3, 3, 0, 0]}
                  maxBarSize={22}
                />
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="errorCount"
                  name="Errors (4xx/5xx)"
                  stroke="#ef4444"
                  strokeWidth={2}
                  dot={{ r: 3, fill: "#ef4444" }}
                />
              </ComposedChart>
            ) : mode === "distribution" ? (
              <BarChart data={distributionData} margin={{ top: 10, right: 16, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: tickColor }} />
                <YAxis
                  tick={{ fontSize: 10, fill: tickColor }}
                  tickFormatter={(v) => formatNum(Number(v))}
                />
                <Tooltip
                  formatter={(val) => [formatNum(Number(val ?? 0)), "Requests"]}
                  labelFormatter={(lbl) => `Latency Range: ${String(lbl)}`}
                  contentStyle={tooltipStyle}
                />
                <Bar dataKey="count" fill="#2563eb" radius={[4, 4, 0, 0]} maxBarSize={36} />
              </BarChart>
            ) : (
              <BarChart
                data={top20Data}
                layout="vertical"
                margin={{ top: 4, right: 16, left: 4, bottom: 4 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} horizontal={false} />
                <XAxis
                  type="number"
                  tick={{ fontSize: 10, fill: tickColor }}
                  tickFormatter={(v) => formatMs(Number(v))}
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  width={150}
                  tick={{
                    fontSize: 9,
                    fill: categoryTickColor,
                    fontFamily: "IBM Plex Mono, monospace",
                  }}
                />
                <Tooltip
                  formatter={(value) => [formatMs(Number(value ?? 0)), "P95 Latency"]}
                  labelFormatter={(_, payload) => {
                    const p = payload?.[0]?.payload as { full?: string } | undefined;
                    return p?.full ?? "";
                  }}
                  contentStyle={tooltipStyle}
                />
                <Bar dataKey="p95" fill="#2563eb" radius={[0, 3, 3, 0]} maxBarSize={18} />
              </BarChart>
            )}
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}
