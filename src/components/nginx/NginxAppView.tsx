import { useMemo, useState } from "react";
import { Copy, ArrowDown, ArrowUp } from "lucide-react";
import { List, type RowComponentProps } from "react-window";
import {
  Area,
  Bar,
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
import { useNginxStore } from "../../store/nginxStore";
import { useAnalysisStore } from "../../store/analysisStore";
import type {
  NginxBreakdown,
  NginxEndpoint,
  NginxMetric,
  NginxResult,
  NginxSortKey,
  NginxView,
} from "../../nginx/types";
import { formatBytes, formatMs, formatNum } from "../../utils/format";
import { NginxIngestPanel } from "./NginxIngestPanel";
import { NginxFilterBar, updateNginxFilters } from "./NginxFilterBar";

const { setActiveView, showToast } = useNginxStore.getState();
const views: { value: NginxView; label: string }[] = [
  { value: "endpoints", label: "Endpoints" },
  { value: "traffic", label: "Traffic" },
  { value: "clients", label: "Clients" },
  { value: "referrers", label: "Referrers" },
  { value: "userAgents", label: "User agents" },
];
const panelClass =
  "overflow-hidden rounded border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900";
const endpointGrid =
  "grid grid-cols-[minmax(260px,1fr)_85px_70px_80px_80px_80px_80px_80px_100px] items-center gap-2 px-3";

function latency(value: number | null): string {
  return value == null ? "—" : formatMs(value);
}

function errorRate(errors: number, count: number): string {
  return `${(count > 0 ? (errors * 100) / count : 0).toFixed(2)}%`;
}

export async function copyNginxPath(path: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(path);
    showToast("Endpoint copied");
  } catch {
    showToast("Clipboard access is unavailable");
  }
}

export function sortNginxEndpoints(sortKey: NginxSortKey): void {
  const filters = useNginxStore.getState().filters;
  updateNginxFilters({
    sortKey,
    sortDir: filters.sortKey === sortKey && filters.sortDir === "desc" ? "asc" : "desc",
  });
}

function NginxKpiRow({ result }: { result: NginxResult }) {
  const s = result.summary;
  const items = [
    { label: "Requests", value: formatNum(s.count) },
    {
      label: "Errors · 4xx / 5xx",
      value: formatNum(s.errorCount),
      detail: errorRate(s.errorCount, s.count),
    },
    { label: "Body bytes sent", value: formatBytes(s.bodyBytes) },
    { label: "Unique clients", value: formatNum(s.uniqueClients) },
    {
      label: "Request avg / p95",
      value: `${latency(s.requestTime.avgMs)} / ${latency(s.requestTime.p95Ms)}`,
      detail: `${formatNum(s.requestTime.count)} / ${formatNum(s.count)} measured`,
    },
    {
      label: "Upstream avg / p95",
      value: `${latency(s.upstreamTime.avgMs)} / ${latency(s.upstreamTime.p95Ms)}`,
      detail: `${formatNum(s.upstreamTime.count)} / ${formatNum(s.count)} measured · sum of recorded attempts`,
    },
  ];
  return (
    <section
      data-testid="nginx-kpi-row"
      className="grid grid-cols-2 gap-px overflow-hidden rounded border border-slate-200 bg-slate-200 md:grid-cols-3 dark:border-slate-800 dark:bg-slate-800"
    >
      {items.map((item) => (
        <div key={item.label} className="bg-white px-3 py-3 dark:bg-slate-900">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            {item.label}
          </div>
          <div className="mt-1 font-mono-data text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-100">
            {item.value}
          </div>
          {item.detail && (
            <div className="mt-1 text-[10px] text-slate-500 dark:text-slate-400">{item.detail}</div>
          )}
        </div>
      ))}
    </section>
  );
}

type EndpointRowProps = { rows: NginxEndpoint[]; metric: NginxMetric };
function EndpointRow({ index, style, rows, metric }: RowComponentProps<EndpointRowProps>) {
  const row = rows[index];
  if (!row) return null;
  const time = metric === "request" ? row.requestTime : row.upstreamTime;
  return (
    <div
      role="row"
      style={style}
      className={`${endpointGrid} border-b border-slate-100 text-xs tabular-nums ${index % 2 === 0 ? "bg-white dark:bg-slate-900" : "bg-slate-50/50 dark:bg-slate-950/40"} dark:border-slate-800`}
    >
      <div role="cell" className="flex min-w-0 items-center gap-2">
        <span className="rounded bg-violet-50 px-1.5 py-0.5 text-[10px] font-bold text-violet-700 dark:bg-violet-950/60 dark:text-violet-300">
          {row.method}
        </span>
        <button
          type="button"
          title={`Copy: ${row.path}`}
          onClick={() => void copyNginxPath(row.path)}
          className="group flex min-w-0 items-center gap-1.5 text-left font-mono-data text-[11px] text-slate-800 hover:text-violet-600 dark:text-slate-200"
        >
          <span className="truncate">{row.path}</span>
          <Copy className="size-3 shrink-0 opacity-0 group-hover:opacity-100" aria-hidden />
        </button>
      </div>
      <div role="cell" className="text-right">
        {formatNum(row.count)}
      </div>
      <div
        role="cell"
        className={`text-right ${row.errorCount > 0 ? "text-rose-600 dark:text-rose-400" : "text-slate-400"}`}
        title={errorRate(row.errorCount, row.count)}
      >
        {formatNum(row.errorCount)}
      </div>
      <div role="cell" className="text-right">
        {formatBytes(row.bodyBytes)}
      </div>
      <div role="cell" className="text-right">
        {latency(time.avgMs)}
      </div>
      <div role="cell" className="text-right font-semibold text-violet-600 dark:text-violet-400">
        {latency(time.p95Ms)}
      </div>
      <div role="cell" className="text-right">
        {latency(time.p99Ms)}
      </div>
      <div role="cell" className="text-right">
        {latency(time.maxMs)}
      </div>
      <div role="cell" className="text-right text-slate-500 dark:text-slate-400">
        {formatNum(time.count)} / {formatNum(row.count)}
      </div>
    </div>
  );
}

function EndpointTable({ result, metric }: { result: NginxResult; metric: NginxMetric }) {
  const { sortKey, sortDir, topN, isParsing } = useNginxStore(
    useShallow((s) => ({
      sortKey: s.filters.sortKey,
      sortDir: s.filters.sortDir,
      topN: s.filters.topN,
      isParsing: s.isParsing,
    })),
  );
  const columns: { label: string; key: NginxSortKey }[] = [
    { label: "Endpoint", key: "path" },
    { label: "Requests", key: "count" },
    { label: "Errors", key: "errorCount" },
    { label: "Body bytes", key: "bodyBytes" },
    { label: "Avg", key: "avgMs" },
    { label: "p95", key: "p95Ms" },
    { label: "p99", key: "p99Ms" },
    { label: "Max", key: "maxMs" },
  ];
  return (
    <section className={panelClass}>
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
            Endpoints{" "}
            <span className="ml-1 text-xs font-normal text-slate-500">
              {formatNum(result.endpoints.length)} of {formatNum(result.endpointCount)}
            </span>
          </h2>
          <p className="mt-1 text-[11px] text-slate-500">
            {metric === "request" ? "Request time" : "Total recorded upstream time"} · ms
          </p>
        </div>
        <fieldset
          disabled={isParsing}
          className="flex items-center gap-2 text-[11px] text-slate-500 disabled:opacity-50 dark:text-slate-400"
        >
          <label className="flex items-center gap-1.5">
            Sort
            <select
              aria-label="Sort endpoints"
              className="rounded border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200"
              value={sortKey}
              onChange={(event) => {
                const column = columns.find((item) => item.key === event.target.value);
                if (column) updateNginxFilters({ sortKey: column.key });
              }}
            >
              {columns.map((column) => (
                <option key={column.key} value={column.key}>
                  {column.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => sortNginxEndpoints(sortKey)}
            aria-label={sortDir === "desc" ? "Sort ascending" : "Sort descending"}
            className="rounded p-1.5 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            {sortDir === "desc" ? (
              <ArrowDown className="size-3.5" />
            ) : (
              <ArrowUp className="size-3.5" />
            )}
          </button>
          <label className="flex items-center gap-1.5">
            Rows
            <input
              aria-label="Endpoint row limit"
              className="w-16 rounded border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200"
              type="number"
              min={1}
              max={500}
              value={topN}
              onChange={(event) =>
                updateNginxFilters({
                  topN: Math.min(500, Math.max(1, Number(event.target.value) || 1)),
                })
              }
            />
          </label>
        </fieldset>
      </div>
      <div className="overflow-x-auto" role="table" aria-label="Nginx endpoints">
        <div className="min-w-[1000px]">
          <div
            role="row"
            className={`${endpointGrid} h-9 border-y border-slate-200 bg-slate-50 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-950/50 dark:text-slate-400`}
          >
            {columns.map((column, index) => (
              <button
                role="columnheader"
                type="button"
                key={column.key}
                onClick={() => sortNginxEndpoints(column.key)}
                className={`flex items-center gap-1 ${index > 0 ? "justify-end" : ""}`}
              >
                {column.label}
                {sortKey === column.key &&
                  (sortDir === "desc" ? (
                    <ArrowDown className="size-3" />
                  ) : (
                    <ArrowUp className="size-3" />
                  ))}
              </button>
            ))}
            <span role="columnheader" className="text-right">
              Measured
            </span>
          </div>
          {result.endpoints.length > 0 && (
            <List
              rowComponent={EndpointRow}
              rowProps={{ rows: result.endpoints, metric }}
              rowCount={result.endpoints.length}
              rowHeight={36}
              overscanCount={8}
              style={{ height: Math.min(520, result.endpoints.length * 36) }}
            />
          )}
        </div>
      </div>
      {result.endpoints.length === 0 && (
        <p className="px-3 py-8 text-center text-xs text-slate-500">
          No endpoints match these filters.
        </p>
      )}
    </section>
  );
}

type BreakdownRowProps = { rows: NginxBreakdown[]; total: number };
function BreakdownRow({ index, style, rows, total }: RowComponentProps<BreakdownRowProps>) {
  const row = rows[index];
  if (!row) return null;
  return (
    <div
      style={style}
      className="grid grid-cols-[minmax(200px,1fr)_90px_80px_80px_100px] items-center gap-3 border-b border-slate-100 px-3 text-xs tabular-nums text-slate-700 dark:border-slate-800 dark:text-slate-200"
    >
      <span className="truncate font-mono-data text-[11px]" title={row.value}>
        {row.value === "-" ? "— (unavailable)" : row.value}
      </span>
      <span className="text-right">{formatNum(row.count)}</span>
      <span className="text-right">{errorRate(row.count, total)}</span>
      <span className="text-right">{formatNum(row.errorCount)}</span>
      <span className="text-right">{formatBytes(row.bodyBytes)}</span>
    </div>
  );
}

function BreakdownTable({
  title,
  rows,
  distinct,
  total,
}: {
  title: string;
  rows: NginxBreakdown[];
  distinct: number;
  total: number;
}) {
  return (
    <section className={panelClass}>
      <div className="px-3 py-3">
        <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{title}</h2>
        <p className="mt-1 text-[11px] text-slate-500">
          Top {rows.length} by requests · {formatNum(distinct)} distinct values · exact counts
        </p>
      </div>
      <div className="overflow-x-auto">
        <div className="min-w-[640px]">
          <div className="grid h-9 grid-cols-[minmax(200px,1fr)_90px_80px_80px_100px] items-center gap-3 border-y border-slate-200 bg-slate-50 px-3 text-[10px] font-semibold uppercase text-slate-500 dark:border-slate-800 dark:bg-slate-950/50">
            <span>{title}</span>
            <span className="text-right">Requests</span>
            <span className="text-right">Share</span>
            <span className="text-right">Errors</span>
            <span className="text-right">Body bytes</span>
          </div>
          {rows.length > 0 && (
            <List
              rowComponent={BreakdownRow}
              rowProps={{ rows, total }}
              rowCount={rows.length}
              rowHeight={36}
              overscanCount={8}
              style={{ height: Math.min(520, rows.length * 36) }}
            />
          )}
        </div>
      </div>
      {rows.length === 0 && (
        <p className="p-8 text-center text-xs text-slate-500">No matching requests.</p>
      )}
    </section>
  );
}

function TrafficCharts({ result, metric }: { result: NginxResult; metric: NginxMetric }) {
  const [granularity, setGranularity] = useState<"hourly" | "daily">("hourly");
  const isDark = useAnalysisStore((s) => s.theme === "dark");
  const buckets = granularity === "hourly" ? result.hourlyStats : result.dailyStats;
  const data = useMemo(
    () =>
      buckets.map((bucket) => {
        const time = metric === "request" ? bucket.requestTime : bucket.upstreamTime;
        return {
          label: bucket.label,
          Requests: bucket.count,
          Errors: bucket.errorCount,
          "Body bytes": bucket.bodyBytes,
          "Average ms": time.avgMs,
          "p95 ms": time.p95Ms,
        };
      }),
    [buckets, metric],
  );
  const tickColor = isDark ? "#94a3b8" : "#64748b";
  const gridColor = isDark ? "#1e293b" : "#e2e8f0";
  const tooltipStyle = {
    fontSize: 12,
    backgroundColor: isDark ? "#0f172a" : "#fff",
    color: isDark ? "#e2e8f0" : "#334155",
    border: `1px solid ${gridColor}`,
    borderRadius: 6,
  };
  const measured =
    metric === "request" ? result.summary.requestTime.count : result.summary.upstreamTime.count;
  const chartTitles =
    measured > 0
      ? ["Requests & errors", "Latency", "Body bytes sent"]
      : ["Requests & errors", "Body bytes sent"];
  if (result.summary.count === 0) {
    return (
      <section className={panelClass}>
        <p className="p-8 text-center text-xs text-slate-500">No requests match these filters.</p>
      </section>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-slate-500">
          Log-local time ·{" "}
          {measured === 0
            ? "No timings logged"
            : metric === "request"
              ? "request latency"
              : "total recorded upstream latency"}
        </p>
        <select
          aria-label="Traffic interval"
          value={granularity}
          onChange={(event) => {
            if (event.target.value === "hourly" || event.target.value === "daily")
              setGranularity(event.target.value);
          }}
          className="rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
        >
          <option value="hourly">Hourly</option>
          <option value="daily">Daily</option>
        </select>
      </div>
      {chartTitles.map((title) => (
        <section key={title} className={`${panelClass} px-3 py-3`}>
          <h2 className="mb-3 text-xs font-semibold text-slate-700 dark:text-slate-200">{title}</h2>
          <div className="h-60">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={data} margin={{ top: 8, right: 15, bottom: 8, left: 5 }}>
                <CartesianGrid stroke={gridColor} strokeDasharray="3 3" />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: tickColor }} minTickGap={40} />
                <YAxis width={65} tick={{ fontSize: 10, fill: tickColor }} />
                <Tooltip contentStyle={tooltipStyle} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {title === "Requests & errors" ? (
                  <>
                    <Bar dataKey="Requests" fill="#8b5cf6" isAnimationActive={false} />
                    <Bar dataKey="Errors" fill="#f43f5e" isAnimationActive={false} />
                  </>
                ) : title === "Latency" ? (
                  <>
                    <Line
                      dataKey="Average ms"
                      stroke="#8b5cf6"
                      dot={false}
                      isAnimationActive={false}
                    />
                    <Line dataKey="p95 ms" stroke="#f59e0b" dot={false} isAnimationActive={false} />
                  </>
                ) : (
                  <Area
                    dataKey="Body bytes"
                    fill="#8b5cf6"
                    fillOpacity={0.15}
                    stroke="#8b5cf6"
                    isAnimationActive={false}
                  />
                )}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </section>
      ))}
      <section className={`${panelClass} px-3 py-3`}>
        <h2 className="mb-3 text-xs font-semibold text-slate-700 dark:text-slate-200">
          HTTP status codes
        </h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {result.statusCounts.map((status) => (
            <div key={status.status} className="rounded bg-slate-50 px-3 py-2 dark:bg-slate-950/50">
              <div className="flex justify-between font-mono-data text-xs text-slate-700 dark:text-slate-200">
                <span>{status.status}</span>
                <span>{formatNum(status.count)}</span>
              </div>
              <p className="mt-1 text-[10px] text-slate-500">
                {errorRate(status.count, result.summary.count)} of requests
              </p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

export function NginxAppView() {
  const { result, activeView, metric } = useNginxStore(
    useShallow((s) => ({ result: s.result, activeView: s.activeView, metric: s.filters.metric })),
  );
  return (
    <div className="flex flex-col gap-4">
      <NginxIngestPanel />
      {result && (
        <>
          <NginxKpiRow result={result} />
          <NginxFilterBar />
          <nav
            aria-label="Nginx analysis views"
            className="flex flex-wrap gap-1 rounded border border-slate-200 bg-white p-1 dark:border-slate-800 dark:bg-slate-900"
          >
            {views.map((view) => (
              <button
                key={view.value}
                type="button"
                data-testid={`nginx-view-${view.value}`}
                aria-current={activeView === view.value ? "page" : undefined}
                onClick={() => setActiveView(view.value)}
                className={`rounded px-3 py-2 text-xs font-semibold ${activeView === view.value ? "bg-violet-50 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300" : "text-slate-500 hover:bg-slate-50 dark:text-slate-400 dark:hover:bg-slate-800"}`}
              >
                {view.label}
              </button>
            ))}
          </nav>
          {activeView === "endpoints" && <EndpointTable result={result} metric={metric} />}
          {activeView === "traffic" && <TrafficCharts result={result} metric={metric} />}
          {activeView === "clients" && (
            <BreakdownTable
              title="Clients"
              rows={result.clients}
              distinct={result.clientCount}
              total={result.summary.count}
            />
          )}
          {activeView === "referrers" && (
            <BreakdownTable
              title="Referrers"
              rows={result.referrers}
              distinct={result.referrerCount}
              total={result.summary.count}
            />
          )}
          {activeView === "userAgents" && (
            <BreakdownTable
              title="User agents"
              rows={result.userAgents}
              distinct={result.userAgentCount}
              total={result.summary.count}
            />
          )}
          <details className="rounded border border-slate-200 px-3 py-2 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
            <summary className="cursor-pointer">
              Parse diagnostics · {formatNum(result.diagnostics.unmatchedCount)} unmatched lines ·{" "}
              {formatNum(result.diagnostics.invalidTimingCount)} invalid timing fields
            </summary>
            <p className="mt-2">
              {formatNum(result.diagnostics.matchedLines)} matched access lines of{" "}
              {formatNum(result.diagnostics.totalLines)} non-empty lines. Missing timings are
              unavailable; zero is a valid measurement. Referrers and user agents retain the logged
              values.
            </p>
            {result.diagnostics.unmatchedSample.length > 0 && (
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all font-mono-data text-[11px]">
                {result.diagnostics.unmatchedSample.join("\n")}
              </pre>
            )}
          </details>
        </>
      )}
      <footer className="pb-6 pt-2 text-center text-[11px] text-slate-400">
        Nginx combined access logs · Parses locally · Logs never leave this machine
      </footer>
    </div>
  );
}
