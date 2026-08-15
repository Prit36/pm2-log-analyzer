import { useMemo } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Copy } from "lucide-react";
import { List, type RowComponentProps } from "react-window";
import { useShallow } from "zustand/react/shallow";
import type { CronAggregated } from "../parser";
import { EMPTY_CRON, useAnalysisStore, type CronSortKey } from "../store/analysisStore";
import { reaggregate } from "../hooks/useParserWorker";
import { formatMs, formatNum } from "../utils/format";
import { buildCronTsv } from "../utils/exportSpreadsheet";
import { cn } from "../utils/cn";

const fieldClass =
  "rounded border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-800 focus:border-blue-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:focus:border-blue-400";

type CronRowProps = { rows: CronAggregated[] };

function CronRow({ index, style, rows }: RowComponentProps<CronRowProps>) {
  const row = rows[index];
  if (!row) return null;

  return (
    <div
      style={style}
      className={cn(
        "grid grid-cols-[minmax(0,1.2fr)_56px_56px_56px_64px_64px_64px_64px_64px] items-center gap-1 border-b border-slate-100 px-3 text-xs dark:border-slate-800",
        index % 2 === 0 ? "bg-white dark:bg-slate-900" : "bg-slate-50/50 dark:bg-slate-950/40",
      )}
    >
      <div className="truncate font-mono-data text-[11px] text-slate-800 dark:text-slate-200">
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
            ? "font-semibold text-rose-600 dark:text-rose-400"
            : "text-slate-400 dark:text-slate-600",
        )}
      >
        {formatNum(row.fails)}
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
      <div className="text-right tabular-nums text-slate-700 dark:text-slate-300">
        {formatMs(row.maxMs)}
      </div>
      <div className="text-right tabular-nums text-slate-400 dark:text-slate-500">
        {row.lastDurationMs !== undefined ? formatMs(row.lastDurationMs) : "-"}
      </div>
    </div>
  );
}

function isCronSortKey(value: string): value is CronSortKey {
  return (
    value === "p95Ms" ||
    value === "p99Ms" ||
    value === "avgMs" ||
    value === "maxMs" ||
    value === "runs" ||
    value === "fails" ||
    value === "starts" ||
    value === "lastDurationMs" ||
    value === "name"
  );
}

export function useFilteredCronRows(): CronAggregated[] {
  const { cron, sortKey, sortDir } = useAnalysisStore(
    useShallow((s) => ({
      cron: s.result?.cron ?? EMPTY_CRON,
      sortKey: s.filters.cronSortKey,
      sortDir: s.filters.cronSortDir,
    })),
  );
  return useMemo(() => {
    return [...cron].sort((a, b) => {
      let cmp = 0;
      if (sortKey === "name") {
        cmp = a.name.localeCompare(b.name);
      } else {
        const valA = a[sortKey] ?? (sortDir === "asc" ? Infinity : -Infinity);
        const valB = b[sortKey] ?? (sortDir === "asc" ? Infinity : -Infinity);
        cmp = valA - valB;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [cron, sortKey, sortDir]);
}

function CronSortHeader({
  label,
  colKey,
  currentKey,
  currentDir,
  onSort,
  align = "right",
}: {
  label: string;
  colKey: CronSortKey;
  currentKey: CronSortKey;
  currentDir: "asc" | "desc";
  onSort: (key: CronSortKey) => void;
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

function handleCronSort(key: CronSortKey) {
  const { cronSortKey: currentKey, cronSortDir: currentDir } = useAnalysisStore.getState().filters;
  if (currentKey === key) {
    setFilters({ cronSortDir: currentDir === "asc" ? "desc" : "asc" });
  } else {
    setFilters({
      cronSortKey: key,
      cronSortDir: key === "name" ? "asc" : "desc",
    });
  }
}

async function copyCronTsv(rows: CronAggregated[]) {
  if (rows.length === 0) return;
  await navigator.clipboard.writeText(buildCronTsv(rows));
  showToast("Cron table copied — paste into Excel");
}

export function CronTable({ rows }: { rows: CronAggregated[] }) {
  const { cronQuery, cronMinMs, cronShowFailedOnly, cronSortKey, cronSortDir } = useAnalysisStore(
    useShallow((s) => ({
      cronQuery: s.filters.cronQuery,
      cronMinMs: s.filters.cronMinMs,
      cronShowFailedOnly: s.filters.cronShowFailedOnly,
      cronSortKey: s.filters.cronSortKey,
      cronSortDir: s.filters.cronSortDir,
    })),
  );

  const height = Math.min(360, Math.max(120, rows.length * 32 + 36));

  return (
    <section className="overflow-hidden rounded border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-800">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">
          Cron jobs
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={cronQuery}
            onChange={(e) => {
              setFilters({ cronQuery: e.target.value });
              void reaggregate();
            }}
            placeholder="Filter jobs…"
            className={cn(fieldClass, "w-40")}
          />
          <input
            type="number"
            min={0}
            value={cronMinMs}
            onChange={(e) => {
              setFilters({ cronMinMs: Math.max(0, Number(e.target.value) || 0) });
              void reaggregate();
            }}
            title="Min duration ms"
            className={cn(fieldClass, "w-20")}
            placeholder="Min ms"
          />
          <label className="flex items-center gap-1.5 text-[11px] text-slate-600 dark:text-slate-400">
            <input
              type="checkbox"
              checked={cronShowFailedOnly}
              onChange={(e) => {
                setFilters({ cronShowFailedOnly: e.target.checked });
                void reaggregate();
              }}
            />
            Failures only
          </label>
          <select
            value={cronSortKey}
            onChange={(e) => {
              const value = e.target.value;
              if (isCronSortKey(value)) setFilters({ cronSortKey: value });
            }}
            className={fieldClass}
          >
            <option value="p95Ms">p95</option>
            <option value="p99Ms">p99</option>
            <option value="avgMs">avg</option>
            <option value="maxMs">max</option>
            <option value="runs">runs</option>
            <option value="starts">starts</option>
            <option value="fails">fails</option>
            <option value="lastDurationMs">last</option>
            <option value="name">job</option>
          </select>
          <button
            type="button"
            onClick={() => void copyCronTsv(rows)}
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
            <CronSortHeader
              label="Job"
              colKey="name"
              currentKey={cronSortKey}
              currentDir={cronSortDir}
              onSort={handleCronSort}
              align="left"
            />
            <CronSortHeader
              label="Runs"
              colKey="runs"
              currentKey={cronSortKey}
              currentDir={cronSortDir}
              onSort={handleCronSort}
            />
            <CronSortHeader
              label="Starts"
              colKey="starts"
              currentKey={cronSortKey}
              currentDir={cronSortDir}
              onSort={handleCronSort}
            />
            <CronSortHeader
              label="Fails"
              colKey="fails"
              currentKey={cronSortKey}
              currentDir={cronSortDir}
              onSort={handleCronSort}
            />
            <CronSortHeader
              label="Avg"
              colKey="avgMs"
              currentKey={cronSortKey}
              currentDir={cronSortDir}
              onSort={handleCronSort}
            />
            <CronSortHeader
              label="p95"
              colKey="p95Ms"
              currentKey={cronSortKey}
              currentDir={cronSortDir}
              onSort={handleCronSort}
            />
            <CronSortHeader
              label="p99"
              colKey="p99Ms"
              currentKey={cronSortKey}
              currentDir={cronSortDir}
              onSort={handleCronSort}
            />
            <CronSortHeader
              label="Max"
              colKey="maxMs"
              currentKey={cronSortKey}
              currentDir={cronSortDir}
              onSort={handleCronSort}
            />
            <CronSortHeader
              label="Last"
              colKey="lastDurationMs"
              currentKey={cronSortKey}
              currentDir={cronSortDir}
              onSort={handleCronSort}
            />
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
