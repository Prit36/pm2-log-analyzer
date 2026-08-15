import { useMemo } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Copy } from "lucide-react";
import { List, type RowComponentProps } from "react-window";
import { useShallow } from "zustand/react/shallow";
import type { AggregatedEndpoint } from "../parser";
import { EMPTY_API, useAnalysisStore, type ApiSortKey } from "../store/analysisStore";
import { formatMs, formatNum } from "../utils/format";
import { buildApiTsv } from "../utils/exportSpreadsheet";
import { cn } from "../utils/cn";

type RowProps = {
  rows: AggregatedEndpoint[];
};

function getMethodClass(method: string): string {
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

function MethodBadge({ method }: { method: string }) {
  return (
    <span
      className={cn(
        "inline-block shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 dark:ring-0",
        getMethodClass(method),
      )}
    >
      {method}
    </span>
  );
}

function ApiRow({ index, style, rows }: RowComponentProps<RowProps>) {
  const row = rows[index];
  if (!row) return null;

  return (
    <div
      style={style}
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_56px_58px_58px_58px_58px_56px] items-center border-b border-slate-100 px-3 text-xs dark:border-slate-800",
        index % 2 === 0 ? "bg-white dark:bg-slate-900" : "bg-slate-50/50 dark:bg-slate-950/40",
      )}
    >
      <div className="flex min-w-0 items-center gap-2 pr-2">
        <MethodBadge method={row.method} />
        <button
          type="button"
          onClick={() => void copyApiPath(row.path)}
          className="group flex min-w-0 flex-1 items-center gap-1.5 text-left font-mono-data text-[11px] text-slate-800 hover:text-blue-600 dark:text-slate-200 dark:hover:text-blue-400"
          title={`Click to copy: ${row.path}`}
        >
          <span className="truncate">{row.path}</span>
          <Copy
            className="size-3 shrink-0 opacity-0 group-hover:opacity-100 text-slate-400 transition-opacity"
            aria-hidden
          />
        </button>
      </div>
      <div className="text-right tabular-nums text-slate-700 dark:text-slate-300">
        {formatNum(row.count)}
      </div>
      <div className="text-right tabular-nums text-slate-700 dark:text-slate-300">
        {formatMs(row.avgMs)}
      </div>
      <div className="text-right tabular-nums font-semibold text-blue-600 dark:text-blue-400">
        {formatMs(row.p95Ms)}
      </div>
      <div className="text-right tabular-nums text-slate-700 dark:text-slate-300">
        {formatMs(row.p99Ms)}
      </div>
      <div className="text-right tabular-nums font-semibold text-amber-700 dark:text-amber-400">
        {formatMs(row.maxMs)}
      </div>
      <div
        className={cn(
          "text-right tabular-nums",
          row.errorCount > 0
            ? "font-semibold text-rose-600 dark:text-rose-500"
            : "text-slate-400 dark:text-slate-600",
        )}
      >
        {formatNum(row.errorCount)}
      </div>
    </div>
  );
}

export function useFilteredApiRows(): AggregatedEndpoint[] {
  const { api, methods, query, sortKey, sortDir, topN } = useAnalysisStore(
    useShallow((s) => ({
      api: s.result?.api ?? EMPTY_API,
      methods: s.filters.methods,
      query: s.filters.query,
      sortKey: s.filters.sortKey,
      sortDir: s.filters.sortDir,
      topN: s.filters.topN,
    })),
  );

  return useMemo(() => {
    const methodSet = methods.length > 0 ? new Set(methods) : null;
    const q = query.trim().toLowerCase();
    let rows = api;
    if (methodSet) rows = rows.filter((r) => methodSet.has(r.method));
    if (q)
      rows = rows.filter(
        (r) => r.path.toLowerCase().includes(q) || r.key.toLowerCase().includes(q),
      );
    rows = [...rows].sort((a, b) => {
      let cmp = 0;
      if (sortKey === "path") {
        cmp = a.path.localeCompare(b.path);
      } else {
        cmp = (a[sortKey] ?? 0) - (b[sortKey] ?? 0);
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return rows.slice(0, topN);
  }, [api, methods, query, sortKey, sortDir, topN]);
}

function ApiSortHeader({
  label,
  colKey,
  currentKey,
  currentDir,
  onSort,
  align = "right",
}: {
  label: string;
  colKey: ApiSortKey;
  currentKey: ApiSortKey;
  currentDir: "asc" | "desc";
  onSort: (key: ApiSortKey) => void;
  align?: "left" | "right";
}) {
  const isActive = currentKey === colKey;
  return (
    <button
      type="button"
      onClick={() => onSort(colKey)}
      className={cn(
        "group flex w-full items-center gap-1 cursor-pointer select-none transition-colors",
        align === "right" ? "justify-end text-right" : "justify-start text-left",
        isActive
          ? "font-bold text-blue-600 dark:text-blue-400"
          : "text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200",
      )}
      title={`Sort by ${label} (${isActive && currentDir === "desc" ? "descending" : "ascending"})`}
    >
      <span>{label}</span>
      {isActive ? (
        currentDir === "asc" ? (
          <ArrowUp className="size-3 shrink-0" aria-hidden />
        ) : (
          <ArrowDown className="size-3 shrink-0" aria-hidden />
        )
      ) : (
        <ArrowUpDown
          className="size-2.5 shrink-0 opacity-0 group-hover:opacity-60 transition-opacity"
          aria-hidden
        />
      )}
    </button>
  );
}

const { setFilters, showToast } = useAnalysisStore.getState();

function handleApiSort(key: ApiSortKey) {
  const { sortKey: currentKey, sortDir: currentDir } = useAnalysisStore.getState().filters;
  if (currentKey === key) {
    setFilters({ sortDir: currentDir === "asc" ? "desc" : "asc" });
  } else {
    setFilters({
      sortKey: key,
      sortDir: "desc",
    });
  }
}

async function copyApiPath(path: string) {
  await navigator.clipboard.writeText(path);
  showToast("Path copied");
}

async function copyApiTsv(rows: AggregatedEndpoint[]) {
  if (rows.length === 0) return;
  await navigator.clipboard.writeText(buildApiTsv(rows));
  showToast("API table copied — paste into Excel");
}

export function ApiTable({ rows }: { rows: AggregatedEndpoint[] }) {
  const { sortKey, sortDir } = useAnalysisStore(
    useShallow((s) => ({
      sortKey: s.filters.sortKey,
      sortDir: s.filters.sortDir,
    })),
  );
  const height = Math.min(420, Math.max(120, rows.length * 32 + 36));

  return (
    <section className="overflow-hidden rounded border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2 dark:border-slate-800">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">
          Slow API endpoints
        </h2>
        <button
          type="button"
          onClick={() => void copyApiTsv(rows)}
          disabled={rows.length === 0}
          className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-500 hover:text-slate-800 disabled:opacity-40 dark:text-slate-400 dark:hover:text-slate-200"
        >
          <Copy className="size-3" aria-hidden />
          Copy TSV
        </button>
      </div>
      {rows.length === 0 ? (
        <div className="px-3 py-10 text-center text-sm text-slate-400 dark:text-slate-500">
          No matching endpoints
        </div>
      ) : (
        <div className="overflow-x-auto">
          <div className="min-w-[680px]">
            <div className="grid grid-cols-[minmax(0,1fr)_56px_58px_58px_58px_58px_56px] border-b border-slate-200 bg-slate-50 px-3 py-2 text-[11px] font-semibold text-slate-500 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-400">
              <div>Endpoint</div>
              <ApiSortHeader
                label="Count"
                colKey="count"
                currentKey={sortKey}
                currentDir={sortDir}
                onSort={handleApiSort}
              />
              <ApiSortHeader
                label="Avg"
                colKey="avgMs"
                currentKey={sortKey}
                currentDir={sortDir}
                onSort={handleApiSort}
              />
              <ApiSortHeader
                label="p95"
                colKey="p95Ms"
                currentKey={sortKey}
                currentDir={sortDir}
                onSort={handleApiSort}
              />
              <ApiSortHeader
                label="p99"
                colKey="p99Ms"
                currentKey={sortKey}
                currentDir={sortDir}
                onSort={handleApiSort}
              />
              <ApiSortHeader
                label="Max"
                colKey="maxMs"
                currentKey={sortKey}
                currentDir={sortDir}
                onSort={handleApiSort}
              />
              <ApiSortHeader
                label="Errors"
                colKey="errorCount"
                currentKey={sortKey}
                currentDir={sortDir}
                onSort={handleApiSort}
              />
            </div>
            <List
              rowCount={rows.length}
              rowHeight={32}
              style={{ height }}
              rowComponent={ApiRow}
              rowProps={{ rows }}
            />
          </div>
        </div>
      )}
    </section>
  );
}
