import { useMemo } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Copy } from "lucide-react";
import { List, type RowComponentProps } from "react-window";
import type { AggregatedEndpoint } from "../parser";
import { EMPTY_API, useAnalysisStore, type ApiSortKey } from "../store/analysisStore";
import { useDebouncedValue } from "../hooks/useParserWorker";
import { formatMs, formatNum } from "../utils/format";
import { buildApiTsv } from "../utils/exportSpreadsheet";
import { cn } from "../utils/cn";

function methodBadgeStyle(method: string): string {
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
    case "HEAD":
      return "bg-slate-50 text-slate-600 ring-slate-200 dark:border dark:border-slate-700/60 dark:bg-slate-900 dark:text-slate-400";
    default:
      return "bg-sky-50 text-sky-700 ring-sky-200 dark:border dark:border-sky-600/60 dark:bg-[#062238] dark:text-[#38bdf8]";
  }
}

function MethodBadge({ method }: { method: string }) {
  return (
    <span
      className={cn(
        "inline-block shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ring-1 dark:ring-0",
        methodBadgeStyle(method),
      )}
    >
      {method}
    </span>
  );
}

type ApiRowProps = {
  rows: AggregatedEndpoint[];
  onCopyPath: (path: string) => void;
};

function ApiRow({ index, style, rows, onCopyPath }: RowComponentProps<ApiRowProps>) {
  const row = rows[index]!;
  const isEven = index % 2 === 0;
  return (
    <div
      style={style}
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_64px_64px_64px_64px_64px_56px] items-center gap-1 border-b border-slate-100 px-3 text-xs transition-colors dark:border-slate-800/60 hover:dark:bg-blue-950/30",
        isEven ? "bg-white dark:bg-slate-900" : "bg-slate-50/80 dark:bg-[rgb(11,18,37)]",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <MethodBadge method={row.method} />
        <button
          type="button"
          title="Copy path"
          onClick={() => onCopyPath(row.path)}
          className="truncate text-left font-mono-data text-[11px] text-slate-800 hover:text-blue-700 dark:text-slate-200 dark:hover:text-blue-400"
        >
          {row.path}
        </button>
      </div>
      <div className="text-right tabular-nums text-slate-700 dark:text-slate-300">
        {formatNum(row.count)}
      </div>
      <div className="text-right tabular-nums text-slate-700 dark:text-slate-300">
        {formatMs(row.avgMs)}
      </div>
      <div className="text-right font-bold tabular-nums text-blue-600 dark:text-blue-400">
        {formatMs(row.p95Ms)}
      </div>
      <div className="text-right tabular-nums text-slate-700 dark:text-slate-300">
        {formatMs(row.p99Ms)}
      </div>
      <div className="text-right font-bold tabular-nums text-amber-700 dark:text-amber-400">
        {formatMs(row.maxMs)}
      </div>
      <div
        className={cn(
          "text-right tabular-nums",
          row.errorCount > 0
            ? "font-bold text-rose-600 dark:text-rose-500"
            : "text-slate-400 dark:text-slate-600",
        )}
      >
        {formatNum(row.errorCount)}
      </div>
    </div>
  );
}

export function useFilteredApiRows(): AggregatedEndpoint[] {
  const api = useAnalysisStore((s) => s.result?.api ?? EMPTY_API);
  const methods = useAnalysisStore((s) => s.filters.methods);
  const query = useAnalysisStore((s) => s.filters.query);
  const sortKey = useAnalysisStore((s) => s.filters.sortKey);
  const sortDir = useAnalysisStore((s) => s.filters.sortDir);
  const topN = useAnalysisStore((s) => s.filters.topN);
  const debouncedQuery = useDebouncedValue(query, 200);

  return useMemo(() => {
    const methodSet = methods.length > 0 ? new Set(methods) : null;
    const q = debouncedQuery.trim().toLowerCase();
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
  }, [api, methods, debouncedQuery, sortKey, sortDir, topN]);
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

export function ApiTable({ rows }: { rows: AggregatedEndpoint[] }) {
  const filters = useAnalysisStore((s) => s.filters);
  const setFilters = useAnalysisStore((s) => s.setFilters);
  const showToast = useAnalysisStore((s) => s.showToast);
  const height = Math.min(420, Math.max(120, rows.length * 32 + 36));

  const handleSort = (key: ApiSortKey) => {
    if (filters.sortKey === key) {
      setFilters({ sortDir: filters.sortDir === "asc" ? "desc" : "asc" });
    } else {
      setFilters({
        sortKey: key,
        sortDir: key === "path" ? "asc" : "desc",
      });
    }
  };

  const onCopyPath = async (path: string) => {
    await navigator.clipboard.writeText(path);
    showToast("Path copied");
  };

  const copyTsv = async () => {
    if (rows.length === 0) return;
    await navigator.clipboard.writeText(buildApiTsv(rows));
    showToast("API table copied — paste into Excel");
  };

  return (
    <section className="overflow-hidden rounded border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2 dark:border-slate-800">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">
          Slow API endpoints
        </h2>
        <button
          type="button"
          onClick={() => void copyTsv()}
          disabled={rows.length === 0}
          className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-500 hover:text-slate-800 disabled:opacity-40 dark:text-slate-400 dark:hover:text-slate-200"
        >
          <Copy className="size-3" aria-hidden />
          Copy TSV
        </button>
      </div>
      {rows.length === 0 ? (
        <div className="px-3 py-10 text-center text-sm text-slate-400 dark:text-slate-500">
          Upload or paste logs to see endpoints here.
        </div>
      ) : (
        <div style={{ height }}>
          <div className="grid grid-cols-[minmax(0,1fr)_64px_64px_64px_64px_64px_56px] items-center gap-1 border-b border-slate-100 bg-slate-50 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-400">
            <ApiSortHeader
              label="Endpoint"
              colKey="path"
              currentKey={filters.sortKey}
              currentDir={filters.sortDir}
              onSort={handleSort}
              align="left"
            />
            <ApiSortHeader
              label="Count"
              colKey="count"
              currentKey={filters.sortKey}
              currentDir={filters.sortDir}
              onSort={handleSort}
            />
            <ApiSortHeader
              label="Avg"
              colKey="avgMs"
              currentKey={filters.sortKey}
              currentDir={filters.sortDir}
              onSort={handleSort}
            />
            <ApiSortHeader
              label="p95"
              colKey="p95Ms"
              currentKey={filters.sortKey}
              currentDir={filters.sortDir}
              onSort={handleSort}
            />
            <ApiSortHeader
              label="p99"
              colKey="p99Ms"
              currentKey={filters.sortKey}
              currentDir={filters.sortDir}
              onSort={handleSort}
            />
            <ApiSortHeader
              label="Max"
              colKey="maxMs"
              currentKey={filters.sortKey}
              currentDir={filters.sortDir}
              onSort={handleSort}
            />
            <ApiSortHeader
              label="Err"
              colKey="errorCount"
              currentKey={filters.sortKey}
              currentDir={filters.sortDir}
              onSort={handleSort}
            />
          </div>
          <div style={{ height: height - 36 }}>
            <List
              rowComponent={ApiRow}
              rowCount={rows.length}
              rowHeight={32}
              rowProps={{ rows, onCopyPath }}
              overscanCount={8}
              style={{ height: "100%", width: "100%" }}
            />
          </div>
        </div>
      )}
    </section>
  );
}
