import { ArrowDown, ArrowUp, Copy } from "lucide-react";
import { List, type RowComponentProps } from "react-window";
import { useShallow } from "zustand/react/shallow";
import { useNginxStore } from "../../store/nginxStore";
import type { NginxEndpoint, NginxMetric, NginxResult, NginxSortKey } from "../../nginx/types";
import { formatBytes, formatNum } from "../../utils/format";
import { cn } from "../../utils/cn";
import { updateNginxFilters } from "./NginxFilterBar";
import { errorTone, latency, mutedClass, panelClass, panelTitleClass, percent } from "./nginxUi";

const { showToast } = useNginxStore.getState();
const endpointGrid =
  "grid grid-cols-[minmax(280px,1fr)_110px_110px_72px_72px_72px_72px_84px_64px] items-center gap-2 px-3";
const columns: { label: string; key: NginxSortKey | null; title?: string }[] = [
  { label: "Endpoint", key: "path" },
  { label: "Requests", key: "count" },
  { label: "Errors", key: "errorCount", title: "4xx + 5xx responses" },
  { label: "Avg", key: "avgMs" },
  { label: "p95", key: "p95Ms" },
  { label: "p99", key: "p99Ms" },
  { label: "Max", key: "maxMs" },
  { label: "Body", key: "bodyBytes", title: "body_bytes_sent" },
  { label: "Timed", key: null, title: "Share of requests with the selected timing logged" },
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

export function sortNginxEndpoints(sortKey: NginxSortKey): void {
  const filters = useNginxStore.getState().filters;
  updateNginxFilters({
    sortKey,
    sortDir: filters.sortKey === sortKey && filters.sortDir === "desc" ? "asc" : "desc",
  });
}

type EndpointRowProps = { rows: NginxEndpoint[]; metric: NginxMetric; maxCount: number };
function EndpointRow({
  index,
  style,
  rows,
  metric,
  maxCount,
}: RowComponentProps<EndpointRowProps>) {
  const row = rows[index];
  if (!row) return null;
  const time = metric === "request" ? row.requestTime : row.upstreamTime;
  return (
    <div
      role="row"
      style={style}
      className={`${endpointGrid} border-b border-slate-100 text-xs tabular-nums text-slate-700 hover:bg-violet-50/40 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-violet-950/20`}
    >
      <div role="cell" className="flex min-w-0 items-center gap-2">
        <span className="w-12 shrink-0 rounded bg-slate-100 py-0.5 text-center text-[10px] font-bold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
          {row.method}
        </span>
        <button
          type="button"
          title={`Copy: ${row.path}`}
          onClick={() => void copyNginxPath(row.path)}
          className="group flex min-w-0 items-center gap-1.5 text-left font-mono-data text-[11px] text-slate-800 hover:text-violet-600 dark:text-slate-200 dark:hover:text-violet-400"
        >
          <span className="truncate">{row.path}</span>
          <Copy className="size-3 shrink-0 opacity-0 group-hover:opacity-100" aria-hidden />
        </button>
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
      <div role="cell" className="text-right">
        {latency(time.avgMs)}
      </div>
      <div role="cell" className="text-right font-semibold text-violet-700 dark:text-violet-300">
        {latency(time.p95Ms)}
      </div>
      <div role="cell" className="text-right">
        {latency(time.p99Ms)}
      </div>
      <div role="cell" className="text-right">
        {latency(time.maxMs)}
      </div>
      <div role="cell" className="text-right text-slate-500 dark:text-slate-400">
        {formatBytes(row.bodyBytes)}
      </div>
      <div
        role="cell"
        className="text-right text-slate-400 dark:text-slate-500"
        title={`${formatNum(time.count)} / ${formatNum(row.count)} timed`}
      >
        {time.count === row.count ? "100%" : percent(time.count, row.count)}
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
  return (
    <section className={panelClass}>
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div>
          <h2 className={panelTitleClass}>
            Endpoints{" "}
            <span className="ml-1 text-xs font-normal text-slate-500">
              top {formatNum(result.endpoints.length)} of {formatNum(result.endpointCount)}
            </span>
          </h2>
          <p className={cn(mutedClass, "mt-0.5")}>
            Latency = {metric === "request" ? "request time (rt)" : "total upstream time (urt)"} ·
            click a path to copy
          </p>
        </div>
        <fieldset
          disabled={isParsing}
          className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500 disabled:opacity-50 dark:text-slate-400"
        >
          <div role="group" aria-label="Sort endpoints" className="flex flex-wrap gap-1">
            {presets.map((preset) => (
              <button
                key={preset.key}
                type="button"
                aria-pressed={sortKey === preset.key}
                onClick={() => updateNginxFilters({ sortKey: preset.key, sortDir: "desc" })}
                className={cn(
                  "rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ring-slate-200 hover:bg-slate-50 dark:ring-slate-700 dark:hover:bg-slate-800",
                  sortKey === preset.key &&
                    "bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-950/60 dark:text-violet-300 dark:ring-violet-800",
                )}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1.5">
            Show
            <select
              aria-label="Endpoint row limit"
              className="rounded-md border border-slate-200 bg-white px-1.5 py-1 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200"
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
        <div className="min-w-[1000px]">
          <div
            role="row"
            className={`${endpointGrid} h-9 border-y border-slate-200 bg-slate-50 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-950/50 dark:text-slate-400`}
          >
            {columns.map((column, index) =>
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
                maxCount: result.endpoints.reduce((max, row) => Math.max(max, row.count), 0),
              }}
              rowCount={result.endpoints.length}
              rowHeight={40}
              overscanCount={8}
              style={{ height: Math.min(560, result.endpoints.length * 40) }}
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
