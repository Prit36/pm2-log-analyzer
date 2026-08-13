import { useMemo } from "react";
import { Copy } from "lucide-react";
import { List, type RowComponentProps } from "react-window";
import type { CronAggregated } from "../parser";
import { EMPTY_CRON, useAnalysisStore, type CronSortKey } from "../store/analysisStore";
import { formatMs, formatNum } from "../utils/format";
import { buildCronTsv } from "../utils/exportSpreadsheet";
import { cn } from "../utils/cn";

const fieldClass =
  "rounded border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-800 focus:border-blue-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:focus:border-blue-400";

type CronRowProps = { rows: CronAggregated[] };

function CronRow({ index, style, rows }: RowComponentProps<CronRowProps>) {
  const row = rows[index]!;
  const isEven = index % 2 === 0;
  return (
    <div
      style={style}
      className={cn(
        "grid grid-cols-[minmax(0,1.2fr)_56px_56px_56px_64px_64px_64px_64px_64px] items-center gap-1 border-b border-slate-100 px-3 text-xs transition-colors dark:border-slate-800/60 hover:dark:bg-blue-950/30",
        isEven ? "bg-white dark:bg-slate-900" : "bg-slate-50/80 dark:bg-[rgb(11,18,37)]",
      )}
    >
      <div
        className="truncate font-mono-data text-[11px] text-slate-800 dark:text-slate-200"
        title={row.name}
      >
        {row.name}
      </div>
      <div className="text-right tabular-nums text-slate-700 dark:text-slate-300">
        {formatNum(row.runs)}
      </div>
      <div className="text-right tabular-nums text-slate-400 dark:text-slate-500">
        {formatNum(row.starts)}
      </div>
      <div
        className={cn(
          "text-right tabular-nums",
          row.fails > 0
            ? "font-bold text-rose-600 dark:text-rose-500"
            : "text-slate-400 dark:text-slate-600",
        )}
      >
        {formatNum(row.fails)}
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
      <div className="text-right tabular-nums text-slate-400 dark:text-slate-500">
        {row.lastDurationMs !== undefined ? formatMs(row.lastDurationMs) : "-"}
      </div>
    </div>
  );
}

export function useFilteredCronRows(): CronAggregated[] {
  const cron = useAnalysisStore((s) => s.result?.cron ?? EMPTY_CRON);
  const sortKey = useAnalysisStore((s) => s.filters.cronSortKey);
  return useMemo(() => {
    return [...cron].sort((a, b) => (b[sortKey] as number) - (a[sortKey] as number));
  }, [cron, sortKey]);
}

export function CronTable({ rows }: { rows: CronAggregated[] }) {
  const filters = useAnalysisStore((s) => s.filters);
  const setFilters = useAnalysisStore((s) => s.setFilters);
  const showToast = useAnalysisStore((s) => s.showToast);

  const height = Math.min(360, Math.max(120, rows.length * 32 + 36));

  const copyTsv = async () => {
    if (rows.length === 0) return;
    await navigator.clipboard.writeText(buildCronTsv(rows));
    showToast("Cron table copied — paste into Excel");
  };

  return (
    <section className="overflow-hidden rounded border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-800">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">
          Cron jobs
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={filters.cronQuery}
            onChange={(e) => setFilters({ cronQuery: e.target.value })}
            placeholder="Filter jobs…"
            className={cn(fieldClass, "w-40")}
          />
          <input
            type="number"
            min={0}
            value={filters.cronMinMs}
            onChange={(e) => setFilters({ cronMinMs: Math.max(0, Number(e.target.value) || 0) })}
            title="Min duration ms"
            className={cn(fieldClass, "w-20")}
            placeholder="Min ms"
          />
          <label className="flex items-center gap-1.5 text-[11px] text-slate-600 dark:text-slate-400">
            <input
              type="checkbox"
              checked={filters.cronShowFailedOnly}
              onChange={(e) => setFilters({ cronShowFailedOnly: e.target.checked })}
            />
            Failures only
          </label>
          <select
            value={filters.cronSortKey}
            onChange={(e) => setFilters({ cronSortKey: e.target.value as CronSortKey })}
            className={fieldClass}
          >
            <option value="p95Ms">p95</option>
            <option value="p99Ms">p99</option>
            <option value="avgMs">avg</option>
            <option value="maxMs">max</option>
            <option value="runs">runs</option>
            <option value="fails">fails</option>
          </select>
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
      </div>
      {rows.length === 0 ? (
        <div className="px-3 py-8 text-center text-sm text-slate-400 dark:text-slate-500">
          No cron jobs match filters.
        </div>
      ) : (
        <div style={{ height }}>
          <div className="grid grid-cols-[minmax(0,1.2fr)_56px_56px_56px_64px_64px_64px_64px_64px] items-center gap-1 border-b border-slate-100 bg-slate-50 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-400">
            <div>Job</div>
            <div className="text-right">Runs</div>
            <div className="text-right">Starts</div>
            <div className="text-right">Fails</div>
            <div className="text-right">Avg</div>
            <div className="text-right">p95</div>
            <div className="text-right">p99</div>
            <div className="text-right">Max</div>
            <div className="text-right">Last</div>
          </div>
          <div style={{ height: height - 36 }}>
            <List
              rowComponent={CronRow}
              rowCount={rows.length}
              rowHeight={32}
              rowProps={{ rows }}
              overscanCount={8}
              style={{ height: "100%", width: "100%" }}
            />
          </div>
        </div>
      )}
    </section>
  );
}
