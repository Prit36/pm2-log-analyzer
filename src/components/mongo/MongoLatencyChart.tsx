import { useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useShallow } from "zustand/react/shallow";
import { useMongoStore } from "../../store/mongoStore";
import { formatMs, formatNum } from "../../utils/format";
import { cn } from "../../utils/cn";

type ChartMode = "throughput_latency" | "plans" | "top_collections";

export function MongoLatencyChart() {
  const [chartMode, setChartMode] = useState<ChartMode>("throughput_latency");

  const { timeBuckets, collections } = useMongoStore(
    useShallow((s) => ({
      timeBuckets: s.result?.timeBuckets ?? [],
      collections: s.result?.collections.slice(0, 10) ?? [],
    })),
  );

  if (timeBuckets.length === 0 && collections.length === 0) return null;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-xs dark:border-slate-800 dark:bg-slate-900">
      {/* Header & Chart Mode Toggle */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3 dark:border-slate-800">
        <div>
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Database Performance Over Time
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Latency percentiles, collection scans, and top resource consumers
          </p>
        </div>

        <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
          <button
            type="button"
            onClick={() => setChartMode("throughput_latency")}
            className={cn(
              "rounded px-2.5 py-1 text-xs font-medium transition-all",
              chartMode === "throughput_latency"
                ? "bg-white text-emerald-700 shadow-xs dark:bg-slate-900 dark:text-emerald-400"
                : "text-slate-600 hover:text-slate-900 dark:text-slate-400",
            )}
          >
            Queries &amp; P95
          </button>
          <button
            type="button"
            onClick={() => setChartMode("plans")}
            className={cn(
              "rounded px-2.5 py-1 text-xs font-medium transition-all",
              chartMode === "plans"
                ? "bg-white text-amber-700 shadow-xs dark:bg-slate-900 dark:text-amber-400"
                : "text-slate-600 hover:text-slate-900 dark:text-slate-400",
            )}
          >
            COLLSCANs vs IXSCAN
          </button>
          <button
            type="button"
            onClick={() => setChartMode("top_collections")}
            className={cn(
              "rounded px-2.5 py-1 text-xs font-medium transition-all",
              chartMode === "top_collections"
                ? "bg-white text-purple-700 shadow-xs dark:bg-slate-900 dark:text-purple-400"
                : "text-slate-600 hover:text-slate-900 dark:text-slate-400",
            )}
          >
            Top Slow Collections
          </button>
        </div>
      </div>

      {/* Chart Canvas */}
      <div className="h-72 w-full pt-2">
        {chartMode === "throughput_latency" && (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={timeBuckets} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
              <XAxis dataKey="hourLabel" tick={{ fontSize: 11 }} />
              <YAxis yAxisId="left" tick={{ fontSize: 11 }} allowDecimals={false} />
              <YAxis
                yAxisId="right"
                orientation="right"
                tick={{ fontSize: 11 }}
                tickFormatter={(v: number) => `${v}ms`}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "rgba(15, 23, 42, 0.95)",
                  border: "1px solid rgba(51, 65, 85, 0.8)",
                  borderRadius: "8px",
                  fontSize: "12px",
                  color: "#f8fafc",
                }}
                formatter={(val, name) => {
                  const num = Number(val ?? 0);
                  const label = String(name ?? "");
                  if (label.includes("P95") || label.includes("Avg")) return [formatMs(num), label];
                  return [formatNum(num), label];
                }}
              />
              <Legend wrapperStyle={{ fontSize: "11px", paddingTop: "8px" }} />
              <Bar yAxisId="left" dataKey="queryCount" name="Slow Queries" fill="#10b981" opacity={0.65} />
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="p95DurationMs"
                name="P95 Latency (ms)"
                stroke="#3b82f6"
                strokeWidth={2}
                dot={false}
              />
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="avgDurationMs"
                name="Avg Latency (ms)"
                stroke="#f59e0b"
                strokeWidth={1.5}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}

        {chartMode === "plans" && (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={timeBuckets} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
              <XAxis dataKey="hourLabel" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
              <Tooltip
                contentStyle={{
                  backgroundColor: "rgba(15, 23, 42, 0.95)",
                  border: "1px solid rgba(51, 65, 85, 0.8)",
                  borderRadius: "8px",
                  fontSize: "12px",
                  color: "#f8fafc",
                }}
              />
              <Legend wrapperStyle={{ fontSize: "11px", paddingTop: "8px" }} />
              <Bar dataKey="collscanCount" name="COLLSCAN (Table Scan)" fill="#f59e0b" stackId="a" />
              <Bar
                dataKey={(b) => b.queryCount - b.collscanCount}
                name="IXSCAN (Indexed)"
                fill="#10b981"
                stackId="a"
              />
            </BarChart>
          </ResponsiveContainer>
        )}

        {chartMode === "top_collections" && (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              layout="vertical"
              data={collections.map((c) => ({
                name: c.collection,
                totalSec: Math.round((c.totalDurationMs / 1000) * 10) / 10,
                collscans: c.collscanCount,
                queries: c.queryCount,
              }))}
              margin={{ top: 10, right: 20, left: 60, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
              <XAxis type="number" tick={{ fontSize: 11 }} unit="s" />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={120} />
              <Tooltip
                contentStyle={{
                  backgroundColor: "rgba(15, 23, 42, 0.95)",
                  border: "1px solid rgba(51, 65, 85, 0.8)",
                  borderRadius: "8px",
                  fontSize: "12px",
                  color: "#f8fafc",
                }}
                formatter={(val) => [`${Number(val ?? 0)} seconds`, "Total Database Time"]}
              />
              <Bar dataKey="totalSec" name="Total DB Time (Seconds)" fill="#8b5cf6" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
