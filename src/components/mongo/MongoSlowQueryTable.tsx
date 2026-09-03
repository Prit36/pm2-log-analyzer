import { ArrowDown, ArrowUp, ArrowUpDown, ExternalLink, Flame, Info } from "lucide-react";
import { useMemo } from "react";
import { List, type RowComponentProps } from "react-window";
import { useShallow } from "zustand/react/shallow";
import type { MongoSlowQuery, MongoSlowQuerySortField } from "../../mongo/types";
import { useMongoStore } from "../../store/mongoStore";
import { formatMs, formatNum } from "../../utils/format";
import { cn } from "../../utils/cn";

const { setActiveSlowQuery, setSlowSort } = useMongoStore.getState();

function getDurationClass(ms: number) {
  if (ms >= 5000) return "bg-purple-100 text-purple-800 border-purple-300 dark:bg-purple-950/60 dark:text-purple-300 dark:border-purple-800";
  if (ms >= 1000) return "bg-rose-100 text-rose-800 border-rose-300 dark:bg-rose-950/60 dark:text-rose-300 dark:border-rose-800";
  if (ms >= 500) return "bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-800";
  return "bg-slate-100 text-slate-800 border-slate-300 dark:bg-slate-800 dark:text-slate-200 dark:border-slate-700";
}

type SlowQueryRowProps = {
  queries: MongoSlowQuery[];
};

function SlowQueryRow({ index, style, queries }: RowComponentProps<SlowQueryRowProps>) {
  const q = queries[index];
  if (!q) return null;

  const handleInspect = () => {
    setActiveSlowQuery(q);
  };

  return (
    <div
      style={style}
      onClick={handleInspect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleInspect();
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={`Inspect slow query on ${q.ns}, duration ${q.durationMs}ms`}
      className={cn(
        "grid cursor-pointer grid-cols-[110px_90px_1fr_90px_90px_90px_80px_130px_48px] items-center border-b border-slate-100 px-4 text-xs hover:bg-emerald-50/40 dark:border-slate-800/80 dark:hover:bg-emerald-950/20",
        index % 2 === 0 ? "bg-white dark:bg-slate-900" : "bg-slate-50/40 dark:bg-slate-950/30",
      )}
    >
      {/* 1. Time */}
      <div className="truncate font-mono text-[11px] text-slate-500 dark:text-slate-400" title={q.timestamp}>
        {q.timestamp.length >= 19 ? q.timestamp.slice(11, 19) : q.timestamp}
      </div>

      {/* 2. Duration badge */}
      <div>
        <span
          className={cn(
            "inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[11px] font-semibold",
            getDurationClass(q.durationMs),
          )}
        >
          {formatMs(q.durationMs)}
        </span>
      </div>

      {/* 3. Namespace & Plan */}
      <div className="flex items-center gap-1.5 min-w-0 pr-3">
        <span className="truncate font-semibold text-slate-900 dark:text-slate-100" title={q.ns}>
          {q.collection}
        </span>
        <span className="shrink-0 rounded bg-slate-100 px-1 py-0.5 text-[10px] font-bold uppercase text-slate-600 dark:bg-slate-800 dark:text-slate-400">
          {q.op}
        </span>
        {q.isCollscan ? (
          <span className="flex shrink-0 items-center gap-0.5 rounded bg-amber-100 px-1 py-0.5 text-[10px] font-bold text-amber-800 dark:bg-amber-950/80 dark:text-amber-300">
            <Flame className="size-3" />
            COLLSCAN
          </span>
        ) : (
          <span className="shrink-0 rounded bg-emerald-100 px-1 py-0.5 text-[10px] font-semibold text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300 truncate max-w-[120px]" title={q.planSummary}>
            {q.planSummary}
          </span>
        )}
      </div>

      {/* 4. Docs Examined */}
      <div className="text-right font-mono text-slate-700 dark:text-slate-300">
        {formatNum(q.docsExamined)}
      </div>

      {/* 5. Keys Examined */}
      <div className="text-right font-mono text-slate-600 dark:text-slate-400">
        {formatNum(q.keysExamined)}
      </div>

      {/* 6. Returned */}
      <div className="text-right font-mono text-slate-600 dark:text-slate-400">
        {formatNum(q.nreturned)}
      </div>

      {/* 7. Scan Ratio */}
      <div className="text-right font-mono">
        <span
          className={cn(
            q.scanRatio >= 1000
              ? "font-bold text-rose-600 dark:text-rose-400"
              : q.scanRatio >= 100
                ? "font-semibold text-amber-600 dark:text-amber-400"
                : "text-slate-600 dark:text-slate-400",
          )}
        >
          {Math.round(q.scanRatio * 10) / 10}x
        </span>
      </div>

      {/* 8. Remote IP */}
      <div className="truncate font-mono text-[11px] text-slate-500 dark:text-slate-400 pl-2" title={q.remote}>
        {q.remote || "unknown"}
      </div>

      {/* 9. Inspect */}
      <div className="flex justify-center text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400">
        <ExternalLink className="size-3.5" />
      </div>
    </div>
  );
}

export function MongoSlowQueryTable() {
  const { queries, slowSortField, slowSortDirection } = useMongoStore(
    useShallow((s) => ({
      queries: s.result?.slowQueries ?? [],
      slowSortField: s.filters.slowSortField,
      slowSortDirection: s.filters.slowSortDirection,
    })),
  );

  const sortedQueries = useMemo(() => {
    if (!queries.length) return [];
    return [...queries].sort((a, b) => {
      let cmp = 0;
      switch (slowSortField) {
        case "timestamp":
          cmp = a.epochMs - b.epochMs;
          break;
        case "docsExamined":
          cmp = a.docsExamined - b.docsExamined;
          break;
        case "keysExamined":
          cmp = a.keysExamined - b.keysExamined;
          break;
        case "nreturned":
          cmp = a.nreturned - b.nreturned;
          break;
        case "scanRatio":
          cmp = a.scanRatio - b.scanRatio;
          break;
        case "collection":
          cmp = a.collection.localeCompare(b.collection);
          break;
        case "durationMs":
        default:
          cmp = a.durationMs - b.durationMs;
          break;
      }
      return slowSortDirection === "asc" ? cmp : -cmp;
    });
  }, [queries, slowSortField, slowSortDirection]);

  const handleHeaderSort = (field: MongoSlowQuerySortField) => {
    setSlowSort(field);
  };

  const renderSortIcon = (field: MongoSlowQuerySortField) => {
    if (slowSortField !== field) return <ArrowUpDown className="size-3 text-slate-400 opacity-60" />;
    return slowSortDirection === "asc" ? (
      <ArrowUp className="size-3 text-emerald-600 dark:text-emerald-400" />
    ) : (
      <ArrowDown className="size-3 text-emerald-600 dark:text-emerald-400" />
    );
  };

  if (sortedQueries.length === 0) {
    return (
      <div className="flex h-64 flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center dark:border-slate-700 dark:bg-slate-900">
        <Info className="size-8 text-slate-400" />
        <p className="mt-2 text-sm font-semibold text-slate-700 dark:text-slate-300">
          No slow query occurrences match filters
        </p>
      </div>
    );
  }

  const ROW_HEIGHT = 44;
  const TABLE_HEIGHT = Math.min(620, Math.max(280, sortedQueries.length * ROW_HEIGHT));

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xs dark:border-slate-800 dark:bg-slate-900">
      {/* Table Header */}
      <div className="grid grid-cols-[110px_90px_1fr_90px_90px_90px_80px_130px_48px] items-center border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-[11px] font-semibold text-slate-600 dark:border-slate-800 dark:bg-slate-950/60 dark:text-slate-400">
        <button
          type="button"
          onClick={() => handleHeaderSort("timestamp")}
          className="flex items-center gap-1 hover:text-slate-900 dark:hover:text-slate-200"
        >
          <span>Time</span>
          {renderSortIcon("timestamp")}
        </button>

        <button
          type="button"
          onClick={() => handleHeaderSort("durationMs")}
          className="flex items-center gap-1 hover:text-slate-900 dark:hover:text-slate-200"
        >
          <span>Duration</span>
          {renderSortIcon("durationMs")}
        </button>

        <button
          type="button"
          onClick={() => handleHeaderSort("collection")}
          className="flex items-center gap-1 hover:text-slate-900 dark:hover:text-slate-200"
        >
          <span>Collection &amp; Plan</span>
          {renderSortIcon("collection")}
        </button>

        <button
          type="button"
          onClick={() => handleHeaderSort("docsExamined")}
          className="flex items-center justify-end gap-1 hover:text-slate-900 dark:hover:text-slate-200"
        >
          <span>Docs Scanned</span>
          {renderSortIcon("docsExamined")}
        </button>

        <button
          type="button"
          onClick={() => handleHeaderSort("keysExamined")}
          className="flex items-center justify-end gap-1 hover:text-slate-900 dark:hover:text-slate-200"
        >
          <span>Keys Scanned</span>
          {renderSortIcon("keysExamined")}
        </button>

        <button
          type="button"
          onClick={() => handleHeaderSort("nreturned")}
          className="flex items-center justify-end gap-1 hover:text-slate-900 dark:hover:text-slate-200"
        >
          <span>Returned</span>
          {renderSortIcon("nreturned")}
        </button>

        <button
          type="button"
          onClick={() => handleHeaderSort("scanRatio")}
          className="flex items-center justify-end gap-1 hover:text-slate-900 dark:hover:text-slate-200"
        >
          <span>Scan Ratio</span>
          {renderSortIcon("scanRatio")}
        </button>

        <div className="pl-2">Client IP</div>
        <div className="text-center">View</div>
      </div>

      {/* Virtualized Query Rows */}
      <List
        rowCount={sortedQueries.length}
        rowHeight={ROW_HEIGHT}
        style={{ height: TABLE_HEIGHT }}
        rowComponent={SlowQueryRow}
        rowProps={{ queries: sortedQueries }}
      />
    </div>
  );
}
