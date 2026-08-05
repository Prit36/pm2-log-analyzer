import { useMemo } from "react";
import { Copy } from "lucide-react";
import { List, type RowComponentProps } from "react-window";
import type { AggregatedEndpoint } from "../parser";
import { EMPTY_API, useAnalysisStore } from "../store/analysisStore";
import { useDebouncedValue } from "../hooks/useParserWorker";
import { formatMs, formatNum } from "../utils/format";
import { buildApiTsv } from "../utils/exportSpreadsheet";
import { cn } from "../utils/cn";

function MethodBadge({ method }: { method: string }) {
  const styles: Record<string, string> = {
    GET: "bg-sky-50 text-sky-700 ring-sky-200 dark:border dark:border-sky-600/60 dark:bg-[#062238] dark:text-[#38bdf8]",
    POST: "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:border dark:border-emerald-600/60 dark:bg-[#06261c] dark:text-[#34d399]",
    PUT: "bg-amber-50 text-amber-700 ring-amber-200 dark:border dark:border-amber-600/60 dark:bg-[#381a06] dark:text-[#fbbf24]",
    PATCH: "bg-amber-50 text-amber-700 ring-amber-200 dark:border dark:border-amber-600/60 dark:bg-[#381a06] dark:text-[#fbbf24]",
    DELETE: "bg-rose-50 text-rose-700 ring-rose-200 dark:border dark:border-rose-600/60 dark:bg-[#3d0818] dark:text-[#fb7185]",
    OPTIONS: "bg-slate-50 text-slate-600 ring-slate-200 dark:border dark:border-slate-700/60 dark:bg-slate-900 dark:text-slate-400",
    HEAD: "bg-slate-50 text-slate-600 ring-slate-200 dark:border dark:border-slate-700/60 dark:bg-slate-900 dark:text-slate-400",
  };
  return (
    <span
      className={cn(
        "inline-block shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ring-1 dark:ring-0",
        styles[method] ?? styles.GET,
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
      <div className="text-right tabular-nums text-slate-700 dark:text-slate-300">{formatNum(row.count)}</div>
      <div className="text-right tabular-nums text-slate-700 dark:text-slate-300">{formatMs(row.avgMs)}</div>
      <div className="text-right font-bold tabular-nums text-blue-600 dark:text-blue-400">{formatMs(row.p95Ms)}</div>
      <div className="text-right tabular-nums text-slate-700 dark:text-slate-300">{formatMs(row.p99Ms)}</div>
      <div className="text-right font-bold tabular-nums text-amber-700 dark:text-amber-400">{formatMs(row.maxMs)}</div>
      <div
        className={cn(
          "text-right tabular-nums",
          row.errorCount > 0 ? "font-bold text-rose-600 dark:text-rose-500" : "text-slate-400 dark:text-slate-600",
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
  const topN = useAnalysisStore((s) => s.filters.topN);
  const debouncedQuery = useDebouncedValue(query, 200);

  return useMemo(() => {
    const methodSet = methods.length > 0 ? new Set(methods) : null;
    const q = debouncedQuery.trim().toLowerCase();
    let rows = api;
    if (methodSet) rows = rows.filter((r) => methodSet.has(r.method));
    if (q) rows = rows.filter((r) => r.path.toLowerCase().includes(q) || r.key.toLowerCase().includes(q));
    rows = [...rows].sort((a, b) => (b[sortKey] as number) - (a[sortKey] as number));
    return rows.slice(0, topN);
  }, [api, methods, debouncedQuery, sortKey, topN]);
}

export function ApiTable({ rows }: { rows: AggregatedEndpoint[] }) {
  const showToast = useAnalysisStore((s) => s.showToast);
  const height = Math.min(420, Math.max(120, rows.length * 32 + 36));

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
            <div>Endpoint</div>
            <div className="text-right">Count</div>
            <div className="text-right">Avg</div>
            <div className="text-right">p95</div>
            <div className="text-right">p99</div>
            <div className="text-right">Max</div>
            <div className="text-right">Err</div>
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
