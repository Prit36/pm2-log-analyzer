import { ArrowDown, ArrowUp, ArrowUpDown, Check, Copy, ExternalLink, Flame, Lightbulb } from "lucide-react";
import { useMemo, useState } from "react";
import { List, type RowComponentProps } from "react-window";
import { useShallow } from "zustand/react/shallow";
import type { MongoQueryPattern, MongoSortField } from "../../mongo/types";
import { useMongoStore } from "../../store/mongoStore";
import { formatMs, formatNum } from "../../utils/format";
import { cn } from "../../utils/cn";

const { setActiveSlowQuery, setSort, showToast } = useMongoStore.getState();

function getOpBadge(op: string) {
  switch (op) {
    case "find":
      return "bg-sky-50 text-sky-700 ring-sky-300 dark:bg-sky-950/60 dark:text-sky-300 dark:ring-sky-700";
    case "aggregate":
      return "bg-purple-50 text-purple-700 ring-purple-300 dark:bg-purple-950/60 dark:text-purple-300 dark:ring-purple-700";
    case "distinct":
      return "bg-indigo-50 text-indigo-700 ring-indigo-300 dark:bg-indigo-950/60 dark:text-indigo-300 dark:ring-indigo-700";
    case "getMore":
      return "bg-teal-50 text-teal-700 ring-teal-300 dark:bg-teal-950/60 dark:text-teal-300 dark:ring-teal-700";
    case "update":
    case "findAndModify":
      return "bg-amber-50 text-amber-700 ring-amber-300 dark:bg-amber-950/60 dark:text-amber-300 dark:ring-amber-700";
    case "delete":
      return "bg-rose-50 text-rose-700 ring-rose-300 dark:bg-rose-950/60 dark:text-rose-300 dark:ring-rose-700";
    default:
      return "bg-slate-100 text-slate-700 ring-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700";
  }
}

type PatternRowProps = {
  patterns: MongoQueryPattern[];
  copiedIndex: string | null;
  setCopiedIndex: (id: string | null) => void;
};

function PatternRow({
  index,
  style,
  patterns,
  copiedIndex,
  setCopiedIndex,
}: RowComponentProps<PatternRowProps>) {
  const p = patterns[index];
  if (!p) return null;

  const isCopied = copiedIndex === p.id;

  const copyIndex = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!p.indexSuggestion) return;
    void navigator.clipboard.writeText(p.indexSuggestion);
    setCopiedIndex(p.id);
    showToast(`Copied index: ${p.indexSuggestion}`);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  const handleInspect = () => {
    setActiveSlowQuery(p.exampleQuery);
  };

  return (
    <div
      style={style}
      onClick={handleInspect}
      className={cn(
        "grid cursor-pointer grid-cols-[minmax(0,2.2fr)_80px_90px_70px_75px_75px_85px_1.6fr_40px] items-center border-b border-slate-100 px-3 text-xs transition-colors hover:bg-slate-100/70 dark:border-slate-800 dark:hover:bg-slate-800/60",
        index % 2 === 0 ? "bg-white dark:bg-slate-900" : "bg-slate-50/40 dark:bg-slate-950/30",
      )}
    >
      {/* 1. Operation, Collection & Fingerprint */}
      <div className="flex min-w-0 flex-col gap-0.5 pr-2">
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              "inline-block shrink-0 rounded px-1.5 py-0.2 text-[10px] font-bold uppercase tracking-wider ring-1",
              getOpBadge(p.op),
            )}
          >
            {p.op}
          </span>
          <span className="truncate font-semibold text-slate-900 dark:text-slate-100" title={p.ns}>
            {p.collection}
          </span>
          {p.isCollscan && (
            <span className="inline-flex items-center gap-0.5 rounded bg-amber-100 px-1 py-0.2 text-[10px] font-bold text-amber-800 dark:bg-amber-950/80 dark:text-amber-300">
              <Flame className="size-2.5" />
              COLLSCAN
            </span>
          )}
        </div>
        <p className="truncate font-mono text-[11px] text-slate-500 dark:text-slate-400" title={p.fingerprint}>
          {p.fingerprint}
        </p>
      </div>

      {/* 2. Count */}
      <div className="text-right font-medium tabular-nums text-slate-700 dark:text-slate-300">
        {formatNum(p.count)}
      </div>

      {/* 3. Total Time */}
      <div className="text-right font-bold tabular-nums text-slate-900 dark:text-slate-100">
        {(p.totalDurationMs / 1000).toFixed(1)}s
      </div>

      {/* 4. Avg Duration */}
      <div className="text-right tabular-nums text-slate-600 dark:text-slate-400">
        {formatMs(p.avgDurationMs)}
      </div>

      {/* 5. P95 Duration */}
      <div className="text-right font-semibold tabular-nums text-blue-600 dark:text-blue-400">
        {formatMs(p.p95DurationMs)}
      </div>

      {/* 6. Max Duration */}
      <div className="text-right font-semibold tabular-nums text-rose-600 dark:text-rose-400">
        {formatMs(p.maxDurationMs)}
      </div>

      {/* 7. Scan Ratio */}
      <div
        className={cn(
          "text-right font-medium tabular-nums",
          p.scanRatio > 100 ? "text-rose-600 dark:text-rose-400" : "text-slate-600 dark:text-slate-400",
        )}
        title={`Examined avg ${formatNum(p.avgDocsExamined)} docs to return ${p.avgReturned}`}
      >
        {p.scanRatio > 0 ? `${p.scanRatio}x` : "0x"}
      </div>

      {/* 8. Index Suggestion with Copy */}
      <div className="min-w-0 px-2">
        {p.indexSuggestion ? (
          <button
            type="button"
            onClick={copyIndex}
            title={`Click to copy: ${p.indexSuggestion}`}
            className="group flex w-full items-center justify-between rounded border border-emerald-200 bg-emerald-50/70 px-2 py-1 text-left font-mono text-[10px] text-emerald-800 hover:border-emerald-400 dark:border-emerald-800/60 dark:bg-emerald-950/40 dark:text-emerald-300"
          >
            <span className="truncate flex-1">{p.indexSuggestion}</span>
            {isCopied ? (
              <Check className="size-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <Copy className="size-3 shrink-0 text-emerald-500 opacity-60 group-hover:opacity-100" />
            )}
          </button>
        ) : (
          <span className="text-[10px] text-slate-400 italic">Indexed / Covered</span>
        )}
      </div>

      {/* 9. Inspect icon */}
      <div className="flex justify-center text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400">
        <ExternalLink className="size-3.5" />
      </div>
    </div>
  );
}

export function MongoPatternTable() {
  const [copiedIndex, setCopiedIndex] = useState<string | null>(null);

  const { patterns, sortField, sortDirection } = useMongoStore(
    useShallow((s) => ({
      patterns: s.result?.patterns ?? [],
      sortField: s.filters.sortField,
      sortDirection: s.filters.sortDirection,
    })),
  );

  const sortedPatterns = useMemo(() => {
    if (!patterns.length) return [];
    return [...patterns].sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case "count":
          cmp = a.count - b.count;
          break;
        case "avgDurationMs":
          cmp = a.avgDurationMs - b.avgDurationMs;
          break;
        case "p95DurationMs":
          cmp = a.p95DurationMs - b.p95DurationMs;
          break;
        case "maxDurationMs":
          cmp = a.maxDurationMs - b.maxDurationMs;
          break;
        case "scanRatio":
          cmp = a.scanRatio - b.scanRatio;
          break;
        case "collection":
          cmp = a.collection.localeCompare(b.collection);
          break;
        case "totalDurationMs":
        default:
          cmp = a.totalDurationMs - b.totalDurationMs;
          break;
      }
      return sortDirection === "asc" ? cmp : -cmp;
    });
  }, [patterns, sortField, sortDirection]);

  const handleHeaderSort = (field: MongoSortField) => {
    setSort(field);
  };

  const renderSortIcon = (field: MongoSortField) => {
    if (sortField !== field) return <ArrowUpDown className="size-3 text-slate-400 opacity-60" />;
    return sortDirection === "asc" ? (
      <ArrowUp className="size-3 text-emerald-600 dark:text-emerald-400" />
    ) : (
      <ArrowDown className="size-3 text-emerald-600 dark:text-emerald-400" />
    );
  };

  if (sortedPatterns.length === 0) {
    return (
      <div className="flex h-64 flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center dark:border-slate-700 dark:bg-slate-900">
        <Lightbulb className="size-8 text-slate-400" />
        <p className="mt-2 text-sm font-semibold text-slate-700 dark:text-slate-300">
          No query patterns found
        </p>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Try adjusting the search query, duration, or plan filters.
        </p>
      </div>
    );
  }

  const ROW_HEIGHT = 58;
  const TABLE_HEIGHT = Math.min(620, Math.max(280, patterns.length * ROW_HEIGHT));

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xs dark:border-slate-800 dark:bg-slate-900">
      {/* Table Header */}
      <div className="grid grid-cols-[minmax(0,2.2fr)_80px_90px_70px_75px_75px_85px_1.6fr_40px] items-center border-b border-slate-200 bg-slate-50 px-3 py-2.5 text-[11px] font-semibold text-slate-600 dark:border-slate-800 dark:bg-slate-950/60 dark:text-slate-400">
        <button
          type="button"
          onClick={() => handleHeaderSort("collection")}
          className="flex items-center gap-1 text-left hover:text-slate-900 dark:hover:text-slate-200"
        >
          <span>Query Pattern / Collection</span>
          {renderSortIcon("collection")}
        </button>

        <button
          type="button"
          onClick={() => handleHeaderSort("count")}
          className="flex items-center justify-end gap-1 text-right hover:text-slate-900 dark:hover:text-slate-200"
        >
          <span>Count</span>
          {renderSortIcon("count")}
        </button>

        <button
          type="button"
          onClick={() => handleHeaderSort("totalDurationMs")}
          className="flex items-center justify-end gap-1 text-right hover:text-slate-900 dark:hover:text-slate-200"
        >
          <span>Total Time</span>
          {renderSortIcon("totalDurationMs")}
        </button>

        <button
          type="button"
          onClick={() => handleHeaderSort("avgDurationMs")}
          className="flex items-center justify-end gap-1 text-right hover:text-slate-900 dark:hover:text-slate-200"
        >
          <span>Avg</span>
          {renderSortIcon("avgDurationMs")}
        </button>

        <button
          type="button"
          onClick={() => handleHeaderSort("p95DurationMs")}
          className="flex items-center justify-end gap-1 text-right hover:text-slate-900 dark:hover:text-slate-200"
        >
          <span>P95</span>
          {renderSortIcon("p95DurationMs")}
        </button>

        <button
          type="button"
          onClick={() => handleHeaderSort("maxDurationMs")}
          className="flex items-center justify-end gap-1 text-right hover:text-slate-900 dark:hover:text-slate-200"
        >
          <span>Max</span>
          {renderSortIcon("maxDurationMs")}
        </button>

        <button
          type="button"
          onClick={() => handleHeaderSort("scanRatio")}
          className="flex items-center justify-end gap-1 text-right hover:text-slate-900 dark:hover:text-slate-200"
        >
          <span>Scan Ratio</span>
          {renderSortIcon("scanRatio")}
        </button>

        <div className="px-2">Suggested Index (1-Click Copy)</div>
        <div className="text-center">View</div>
      </div>

      {/* Virtualized Pattern Rows */}
      <List
        rowCount={sortedPatterns.length}
        rowHeight={ROW_HEIGHT}
        style={{ height: TABLE_HEIGHT }}
        rowComponent={PatternRow}
        rowProps={{ patterns: sortedPatterns, copiedIndex, setCopiedIndex }}
      />
    </div>
  );
}
