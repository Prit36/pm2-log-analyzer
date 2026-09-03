import { AlertTriangle, Clock, Database, Flame, Network, ShieldAlert } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useMongoStore } from "../../store/mongoStore";
import { formatMs, formatNum } from "../../utils/format";
import { cn } from "../../utils/cn";

export function MongoKpiRow() {
  const { summary, connections, errorTypesCount, totalErrorEvents } = useMongoStore(
    useShallow((s) => ({
      summary: s.result?.summary,
      connections: s.result?.connections,
      errorTypesCount: s.result?.errors.length ?? 0,
      totalErrorEvents: s.result?.errors.reduce((sum, e) => sum + e.count, 0) ?? 0,
    })),
  );

  if (!summary) return null;

  const isHighCollscan = summary.collscanCount > 0;
  const collscanPercent =
    summary.slowQueryCount > 0
      ? Math.round((summary.collscanCount / summary.slowQueryCount) * 100)
      : 0;

  return (
    <section
      data-testid="mongo-kpi-row"
      aria-label="MongoDB Key Performance Indicators"
      className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6"
    >
      {/* 1. Total Slow Queries */}
      <div className="flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-3.5 shadow-xs dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">Slow Queries</span>
          <Database className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
        </div>
        <div className="mt-2">
          <div className="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
            {formatNum(summary.slowQueryCount)}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-slate-500 dark:text-slate-400">
            {summary.uniquePatterns} patterns · {summary.uniqueCollections} colls
          </div>
        </div>
      </div>

      {/* 2. COLLSCAN Alerts */}
      <div
        className={cn(
          "flex flex-col justify-between rounded-xl border p-3.5 shadow-xs",
          isHighCollscan
            ? "border-amber-300/80 bg-amber-50/50 dark:border-amber-500/30 dark:bg-amber-950/20"
            : "border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900",
        )}
      >
        <div className="flex items-center justify-between">
          <span
            className={cn(
              "text-xs font-semibold",
              isHighCollscan ? "text-amber-700 dark:text-amber-400" : "text-slate-500 dark:text-slate-400",
            )}
          >
            COLLSCANs
          </span>
          {isHighCollscan ? (
            <Flame className="size-4 animate-pulse text-amber-600 dark:text-amber-400" aria-hidden />
          ) : (
            <AlertTriangle className="size-4 text-slate-400" aria-hidden />
          )}
        </div>
        <div className="mt-2">
          <div
            className={cn(
              "text-xl font-bold tracking-tight",
              isHighCollscan ? "text-amber-700 dark:text-amber-400" : "text-slate-900 dark:text-slate-100",
            )}
          >
            {formatNum(summary.collscanCount)}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-amber-600/90 dark:text-amber-400/90">
            {isHighCollscan ? `${collscanPercent}% unindexed scans` : "Zero table scans"}
          </div>
        </div>
      </div>

      {/* 3. Latency: P95 */}
      <div className="flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-3.5 shadow-xs dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">P95 Latency</span>
          <Clock className="size-4 text-blue-600 dark:text-blue-400" aria-hidden />
        </div>
        <div className="mt-2">
          <div className="text-xl font-bold tracking-tight text-blue-600 dark:text-blue-400">
            {formatMs(summary.p95DurationMs)}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-slate-500 dark:text-slate-400">
            Avg: {formatMs(summary.avgDurationMs)} · P99: {formatMs(summary.p99DurationMs)}
          </div>
        </div>
      </div>

      {/* 4. Max Duration */}
      <div className="flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-3.5 shadow-xs dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">Max Duration</span>
          <Flame className="size-4 text-rose-600 dark:text-rose-400" aria-hidden />
        </div>
        <div className="mt-2">
          <div className="text-xl font-bold tracking-tight text-rose-600 dark:text-rose-400">
            {formatMs(summary.maxDurationMs)}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-slate-500 dark:text-slate-400">
            P50: {formatMs(summary.p50DurationMs)}
          </div>
        </div>
      </div>

      {/* 5. Total Docs Scanned */}
      <div className="flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-3.5 shadow-xs dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">Docs Examined</span>
          <Network className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
        </div>
        <div className="mt-2">
          <div className="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
            {formatNum(summary.totalDocsExamined)}
          </div>
          <div
            className={cn(
              "mt-0.5 truncate text-[11px] font-medium",
              summary.overallScanRatio > 100
                ? "text-rose-600 dark:text-rose-400"
                : "text-slate-500 dark:text-slate-400",
            )}
            title={`Scan:Return ratio = ${summary.overallScanRatio}:1`}
          >
            {summary.overallScanRatio > 1 ? `${summary.overallScanRatio}x scan ratio` : "Direct index hits"}
          </div>
        </div>
      </div>

      {/* 6. Peak Connections & Errors */}
      <div className="flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-3.5 shadow-xs dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">Diagnostics</span>
          <ShieldAlert className="size-4 text-amber-500 dark:text-amber-400" aria-hidden />
        </div>
        <div className="mt-2">
          <div className="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
            {connections?.peakConcurrent ? `${connections.peakConcurrent} peak` : "Normal"}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-slate-500 dark:text-slate-400">
            {totalErrorEvents > 0
              ? `${formatNum(totalErrorEvents)} events (${errorTypesCount} types)`
              : "No engine errors"}
          </div>
        </div>
      </div>
    </section>
  );
}
