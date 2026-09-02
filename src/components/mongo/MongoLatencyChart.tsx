import { useMemo, useState } from "react";
import {
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
import { useShallow } from "zustand/react/shallow";
import { useMongoStore } from "../../store/mongoStore";
import { useAnalysisStore } from "../../store/analysisStore";
import { formatMs, formatNum } from "../../utils/format";
import { PALETTE } from "../../utils/palette";
import { cn } from "../../utils/cn";

type ChartMode = "throughput_latency" | "plans" | "top_collections";

export function MongoLatencyChart() {
  const [chartMode, setChartMode] = useState<ChartMode>("throughput_latency");

  const isDark = useAnalysisStore((s) => s.theme === "dark");

  const { timeBuckets, rawCollections } = useMongoStore(
    useShallow((s) => ({
      timeBuckets: s.result?.timeBuckets ?? [],
      rawCollections: s.result?.collections ?? [],
    })),
  );

  const chartData = useMemo(
    () =>
      timeBuckets.map((b) => ({
        hourLabel: b.hourLabel || b.timeKey || "00:00",
        queryCount: b.queryCount,
        collscanCount: b.collscanCount,
        ixscanCount: Math.max(0, b.queryCount - b.collscanCount),
        p95DurationMs: b.p95DurationMs,
        avgDurationMs: b.avgDurationMs,
      })),
    [timeBuckets],
  );

  const collectionsData = useMemo(
    () =>
      rawCollections.slice(0, 10).map((c) => ({
        name: c.collection,
        totalSec: Math.round((c.totalDurationMs / 1000) * 10) / 10,
        collscans: c.collscanCount,
        queries: c.queryCount,
      })),
    [rawCollections],
  );

  const gridStroke = isDark ? PALETTE.grid.dark : PALETTE.grid.light;
  const tickColor = isDark ? PALETTE.tick.dark : PALETTE.tick.light;
  const tooltipStyle = isDark
    ? {
        fontSize: 12,
        borderRadius: 8,
        backgroundColor: PALETTE.tooltip.dark.bg,
        border: `1px solid ${PALETTE.tooltip.dark.border}`,
        color: PALETTE.tooltip.dark.text,
        boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.5)",
      }
    : {
        fontSize: 12,
        borderRadius: 6,
        border: `1px solid ${PALETTE.tooltip.light.border}`,
        backgroundColor: "#ffffff",
        color: "#0f172a",
      };

  if (chartData.length === 0 && collectionsData.length === 0) {
    return (
      <div
        data-testid="mongo-latency-chart"
        className="rounded-xl border border-slate-200 bg-white p-8 text-center dark:border-slate-800 dark:bg-slate-900"
      >
        <p className="text-sm text-slate-500 dark:text-slate-400">
          No chart data available for the current filters.
        </p>
      </div>
    );
  }

  return (
    <div
      data-testid="mongo-latency-chart"
      className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-xs dark:border-slate-800 dark:bg-slate-900"
    >
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
            data-testid="mongo-chart-mode-latency"
            onClick={() => setChartMode("throughput_latency")}
            className={cn(
              "rounded px-2.5 py-1 text-xs font-medium transition-all cursor-pointer",
              chartMode === "throughput_latency"
                ? "bg-white text-emerald-700 shadow-xs dark:bg-slate-900 dark:text-emerald-400"
                : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200",
            )}
          >
            Queries &amp; P95
          </button>
          <button
            type="button"
            data-testid="mongo-chart-mode-plans"
            onClick={() => setChartMode("plans")}
            className={cn(
              "rounded px-2.5 py-1 text-xs font-medium transition-all cursor-pointer",
              chartMode === "plans"
                ? "bg-white text-amber-700 shadow-xs dark:bg-slate-900 dark:text-amber-400"
                : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200",
            )}
          >
            COLLSCANs vs IXSCAN
          </button>
          <button
            type="button"
            data-testid="mongo-chart-mode-collections"
            onClick={() => setChartMode("top_collections")}
            className={cn(
              "rounded px-2.5 py-1 text-xs font-medium transition-all cursor-pointer",
              chartMode === "top_collections"
                ? "bg-white text-purple-700 shadow-xs dark:bg-slate-900 dark:text-purple-400"
                : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200",
            )}
          >
            Top Slow Collections
          </button>
        </div>
      </div>

      {/* Chart Canvas */}
      <div style={{ height: 320 }} className="w-full pt-2">
        <ResponsiveContainer width="100%" height="100%">
          {chartMode === "throughput_latency" ? (
            <ComposedChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
              <XAxis dataKey="hourLabel" tick={{ fontSize: 11, fill: tickColor }} />
              <YAxis yAxisId="left" tick={{ fontSize: 11, fill: tickColor }} allowDecimals={false} />
              <YAxis
                yAxisId="right"
                orientation="right"
                tick={{ fontSize: 11, fill: PALETTE.latency.p95 }}
                tickFormatter={(v: number) => `${v}ms`}
              />
              <Tooltip
                contentStyle={tooltipStyle}
                formatter={(val, name) => {
                  const num = Number(val ?? 0);
                  const label = String(name ?? "");
                  if (label.includes("P95") || label.includes("Avg")) return [formatMs(num), label];
                  return [formatNum(num), label];
                }}
              />
              <Legend wrapperStyle={{ fontSize: "11px", paddingTop: "8px", color: tickColor }} />
              <Bar yAxisId="left" dataKey="queryCount" name="Slow Queries" fill="#10b981" opacity={0.65} maxBarSize={40} radius={[3, 3, 0, 0]} />
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="p95DurationMs"
                name="P95 Latency"
                stroke="#3b82f6"
                strokeWidth={2}
                dot={false}
              />
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="avgDurationMs"
                name="Avg Latency"
                stroke="#f59e0b"
                strokeWidth={1.5}
                dot={false}
              />
            </ComposedChart>
          ) : chartMode === "plans" ? (
            <BarChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
              <XAxis dataKey="hourLabel" tick={{ fontSize: 11, fill: tickColor }} />
              <YAxis tick={{ fontSize: 11, fill: tickColor }} allowDecimals={false} />
              <Tooltip contentStyle={tooltipStyle} />
              <Legend wrapperStyle={{ fontSize: "11px", paddingTop: "8px", color: tickColor }} />
              <Bar dataKey="collscanCount" name="COLLSCAN (Table Scan)" fill="#f59e0b" stackId="a" maxBarSize={40} />
              <Bar dataKey="ixscanCount" name="IXSCAN (Indexed)" fill="#10b981" stackId="a" maxBarSize={40} radius={[3, 3, 0, 0]} />
            </BarChart>
          ) : (
            <BarChart
              layout="vertical"
              data={collectionsData}
              margin={{ top: 10, right: 20, left: 60, bottom: 4 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 11, fill: tickColor }} unit="s" />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: tickColor }} width={120} />
              <Tooltip
                contentStyle={tooltipStyle}
                formatter={(val) => [`${Number(val ?? 0)} seconds`, "Total Database Time"]}
              />
              <Bar dataKey="totalSec" name="Total DB Time (Seconds)" fill="#8b5cf6" radius={[0, 4, 4, 0]} />
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  );
}
