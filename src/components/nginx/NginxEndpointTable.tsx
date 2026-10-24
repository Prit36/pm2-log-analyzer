import { ArrowDown, ArrowUp, Copy, Filter } from "lucide-react";
import { List, type RowComponentProps } from "react-window";
import { useShallow } from "zustand/react/shallow";
import { useNginxStore } from "../../store/nginxStore";
import type { NginxEndpoint, NginxMetric, NginxResult, NginxSortKey } from "../../nginx/types";
import { formatBytes, formatNum } from "../../utils/format";
import { cn } from "../../utils/cn";
import { updateNginxFilters } from "./NginxFilterBar";
import { errorTone, latency, panelClass, percent } from "./nginxUi";

const { showToast } = useNginxStore.getState();
export function getMethodClass(method: string): string {
  switch (method) {
    case "GET":
      return "bg-sky-50 text-sky-700 ring-sky-200 dark:border dark:border-sky-600/60 dark:bg-[#062238] dark:text-[#38bdf8]";
    case "POST":
      return "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:border dark:border-emerald-600/60 dark:bg-[#06261c] dark:text-[#34d399]";
    case "PUT":
    case "PATCH":
      return "bg-amber-50 text-amber-700 ring-amber-200 dark:border dark:border-amber-600/60 dark:bg-[#381a06] dark:text-[#fbbf24]";
    case "DELETE":
      return "bg-rose-50 text-rose-700 ring-rose-200 dark:border dark:border-rose-600/60 dark:bg-[#3d0818] dark:text-[#fb7185]";
    default:
      return "bg-slate-50 text-slate-600 ring-slate-200 dark:border dark:border-slate-700/60 dark:bg-slate-900 dark:text-slate-400";
  }
}

function endpointGrid(timed: boolean): string {
  return cn(
    "grid items-center gap-2 px-3",
    timed
      ? "grid-cols-[minmax(200px,1fr)_100px_80px_56px_56px_56px_56px_64px]"
      : "grid-cols-[minmax(280px,1fr)_110px_110px_100px]",
  );
}
const columns: { label: string; key: NginxSortKey | null; title?: string }[] = [
  { label: "Endpoint", key: "path" },
  { label: "Requests", key: "count" },
  { label: "Errors", key: "errorCount", title: "4xx + 5xx responses" },
  { label: "Avg", key: "avgMs" },
  { label: "p95", key: "p95Ms" },
  { label: "p99", key: "p99Ms" },
  { label: "Max", key: "maxMs" },
  { label: "Body", key: "bodyBytes", title: "body_bytes_sent" },
];
const presets: { label: string; key: NginxSortKey }[] = [
  { label: "Most requests", key: "count" },
  { label: "Slowest p95", key: "p95Ms" },
  { label: "Most errors", key: "errorCount" },
  { label: "Most bytes", key: "bodyBytes" },
];
const rowLimits = [25, 50, 100, 250, 500];

export async function copyNginxPath(path: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(path);
    showToast("Endpoint copied");
  } catch {
    showToast("Clipboard access is unavailable");
  }
}

/** Narrows every report to one endpoint, keeping any exact client (`ip:`) filter. */
export function filterNginxEndpoint(path: string): void {
  const clients = useNginxStore
    .getState()
    .filters.query.split(/\s+/)
    .filter((part) => part.toLowerCase().startsWith("ip:"));
  updateNginxFilters({ query: [...clients, path].join(" ") });
}

export function sortNginxEndpoints(sortKey: NginxSortKey): void {
  const filters = useNginxStore.getState().filters;
  updateNginxFilters({
    sortKey,
    sortDir: filters.sortKey === sortKey && filters.sortDir === "desc" ? "asc" : "desc",
  });
}

type EndpointRowProps = {
  rows: NginxEndpoint[];
  metric: NginxMetric;
  maxCount: number;
  timed: boolean;
};
function EndpointRow({
  index,
  style,
  rows,
  metric,
  maxCount,
  timed,
}: RowComponentProps<EndpointRowProps>) {
  const row = rows[index];
  if (!row) return null;
  const time = metric === "request" ? row.requestTime : row.upstreamTime;
  const timedTitle = `${formatNum(time.count)} / ${formatNum(row.count)} requests timed (${percent(time.count, row.count)})`;
  return (
    <div
      role="row"
      style={style}
      className={`${endpointGrid(timed)} group/row border-b border-slate-100 text-xs tabular-nums text-slate-700 hover:bg-violet-50/40 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-violet-950/20`}
    >
      <div role="cell" className="flex min-w-0 items-center gap-2">
        <span
          className={cn(
            "inline-block w-11 shrink-0 rounded py-0.5 text-center text-[10px] font-bold uppercase tracking-wide ring-1 dark:ring-0",
            getMethodClass(row.method),
          )}
        >
          {row.method}
        </span>
        <button
          type="button"
          title={`Filter the dashboard to ${row.path}`}
          onClick={() => filterNginxEndpoint(row.path)}
          className="min-w-0 truncate text-left font-mono-data text-[11px] text-slate-800 hover:text-violet-600 hover:underline dark:text-slate-200 dark:hover:text-violet-400"
        >
          {row.path}
        </button>
        <span className="flex shrink-0 items-center opacity-0 group-hover/row:opacity-100 focus-within:opacity-100">
          <button
            type="button"
            title="Filter to this endpoint"
            aria-label={`Filter to ${row.path}`}
            onClick={() => filterNginxEndpoint(row.path)}
            className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-violet-700 dark:hover:bg-slate-800 dark:hover:text-violet-300"
          >
            <Filter className="size-3" aria-hidden />
          </button>
          <button
            type="button"
            title="Copy path"
            aria-label={`Copy ${row.path}`}
            onClick={() => void copyNginxPath(row.path)}
            className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-violet-700 dark:hover:bg-slate-800 dark:hover:text-violet-300"
          >
            <Copy className="size-3" aria-hidden />
          </button>
        </span>
      </div>
      <div role="cell" className="flex items-center justify-end gap-2">
        <span className="h-1.5 w-10 shrink-0 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
          <span
            className="block h-full rounded-full bg-violet-400"
            style={{ width: `${maxCount > 0 ? Math.max(4, (row.count * 100) / maxCount) : 0}%` }}
          />
        </span>
        <span>{formatNum(row.count)}</span>
      </div>
      <div role="cell" className="text-right">
        {row.errorCount === 0 ? (
          <span className="text-slate-300 dark:text-slate-600">0</span>
        ) : (
          <>
            <span>{formatNum(row.errorCount)}</span>{" "}
            <span className={cn("text-[10px] font-semibold", errorTone(row.errorCount, row.count))}>
              {percent(row.errorCount, row.count)}
            </span>
          </>
        )}
      </div>
      {timed && (
        <>
          <div role="cell" className="text-right" title={timedTitle}>
            {latency(time.avgMs)}
          </div>
          <div
            role="cell"
            className="text-right font-semibold text-violet-700 dark:text-violet-300"
            title={timedTitle}
          >
            {latency(time.p95Ms)}
          </div>
          <div role="cell" className="text-right" title={timedTitle}>
            {latency(time.p99Ms)}
          </div>
          <div role="cell" className="text-right" title={timedTitle}>
            {latency(time.maxMs)}
          </div>
        </>
      )}
      <div role="cell" className="text-right text-slate-500 dark:text-slate-400">
        {formatBytes(row.bodyBytes)}
      </div>
    </div>
  );
}

export function NginxEndpointTable({
  result,
  metric,
}: {
  result: NginxResult;
  metric: NginxMetric;
}) {
  const { sortKey, sortDir, topN, isParsing } = useNginxStore(
    useShallow((s) => ({
      sortKey: s.filters.sortKey,
      sortDir: s.filters.sortDir,
      topN: s.filters.topN,
      isParsing: s.isParsing,
    })),
  );
  const timed =
    (metric === "request" ? result.summary.requestTime : result.summary.upstreamTime).count > 0;
  const visibleColumns = timed
    ? columns
    : columns.filter(
        (column) =>
          column.key === "path" ||
          column.key === "count" ||
          column.key === "errorCount" ||
          column.key === "bodyBytes",
      );
  return (
    <section className={panelClass}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-800">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">
          Endpoints{" "}
          <span className="font-normal text-slate-400">
            ({formatNum(result.endpoints.length)}
            {result.endpointCount > result.endpoints.length
              ? ` / ${formatNum(result.endpointCount)}`
              : ""}
            )
          </span>
        </h2>
        <fieldset
          disabled={isParsing}
          className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500 disabled:opacity-50 dark:text-slate-400"
        >
          <div role="group" aria-label="Sort endpoints" className="flex flex-wrap gap-1">
            {presets
              .filter((preset) => timed || preset.key !== "p95Ms")
              .map((preset) => (
                <button
                  key={preset.key}
                  type="button"
                  aria-pressed={sortKey === preset.key}
                  onClick={() => updateNginxFilters({ sortKey: preset.key, sortDir: "desc" })}
                  className={cn(
                    "rounded px-2 py-0.5 text-[10px] font-medium transition-colors",
                    sortKey === preset.key
                      ? "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300"
                      : "text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800",
                  )}
                >
                  {preset.label}
                </button>
              ))}
          </div>
          <label className="flex items-center gap-1">
            Show
            <select
              aria-label="Endpoint row limit"
              className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200"
              value={topN}
              onChange={(event) => updateNginxFilters({ topN: Number(event.target.value) })}
            >
              {(rowLimits.includes(topN) ? rowLimits : [topN, ...rowLimits]).map((limit) => (
                <option key={limit} value={limit}>
                  {limit}
                </option>
              ))}
            </select>
          </label>
        </fieldset>
      </div>
      <div className="overflow-x-auto" role="table" aria-label="Nginx endpoints">
        <div className={timed ? "min-w-[750px]" : "min-w-[640px]"}>
          <div
            role="row"
            className={`${endpointGrid(timed)} h-8 border-b border-slate-200 bg-slate-50 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-950/50 dark:text-slate-400`}
          >
            {visibleColumns.map((column, index) =>
              column.key ? (
                <button
                  role="columnheader"
                  type="button"
                  key={column.label}
                  title={column.title}
                  onClick={() => column.key && sortNginxEndpoints(column.key)}
                  className={cn(
                    "flex items-center gap-1 uppercase hover:text-slate-800 dark:hover:text-slate-200",
                    index > 0 && "justify-end",
                    sortKey === column.key && "text-violet-700 dark:text-violet-300",
                  )}
                >
                  {column.label}
                  {sortKey === column.key &&
                    (sortDir === "desc" ? (
                      <ArrowDown className="size-3" />
                    ) : (
                      <ArrowUp className="size-3" />
                    ))}
                </button>
              ) : (
                <span
                  role="columnheader"
                  key={column.label}
                  title={column.title}
                  className="text-right"
                >
                  {column.label}
                </span>
              ),
            )}
          </div>
          {result.endpoints.length > 0 && (
            <List
              rowComponent={EndpointRow}
              rowProps={{
                rows: result.endpoints,
                metric,
                timed,
                maxCount: result.endpoints.reduce((max, row) => Math.max(max, row.count), 0),
              }}
              rowCount={result.endpoints.length}
              rowHeight={32}
              overscanCount={8}
              style={{ height: Math.min(512, result.endpoints.length * 32) }}
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
