import { ChevronRight } from "lucide-react";
import { List, type RowComponentProps } from "react-window";
import { useNginxStore } from "../../store/nginxStore";
import type { NginxBreakdown, NginxView } from "../../nginx/types";
import { formatBytes, formatNum } from "../../utils/format";
import { cn } from "../../utils/cn";
import { errorTone, mutedClass, panelClass, panelTitleClass, percent } from "./nginxUi";

const { setActiveView } = useNginxStore.getState();
const breakdownGrid =
  "grid grid-cols-[minmax(220px,1fr)_minmax(120px,200px)_90px_110px_90px] items-center gap-3 px-4";

function displayValue(value: string): string {
  return value === "-" ? "— (not logged)" : value;
}

/** Bar scaled to the largest row so small shares stay visible. */
function ShareBar({ count, max }: { count: number; max: number }) {
  return (
    <span className="block h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
      <span
        className="block h-full rounded-full bg-violet-500"
        style={{ width: `${max > 0 ? Math.max(2, (count * 100) / max) : 0}%` }}
      />
    </span>
  );
}

type BreakdownRowProps = { rows: NginxBreakdown[]; total: number };
function BreakdownRow({ index, style, rows, total }: RowComponentProps<BreakdownRowProps>) {
  const row = rows[index];
  if (!row) return null;
  return (
    <div
      style={style}
      className={`${breakdownGrid} border-b border-slate-100 text-xs tabular-nums text-slate-700 dark:border-slate-800 dark:text-slate-200`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="w-6 shrink-0 text-right text-[10px] text-slate-400">{index + 1}</span>
        <span className="truncate font-mono-data text-[11px]" title={row.value}>
          {displayValue(row.value)}
        </span>
      </span>
      <span className="flex items-center gap-2">
        <ShareBar count={row.count} max={rows[0]?.count ?? 0} />
        <span className="w-10 shrink-0 text-right text-[10px] text-slate-500">
          {percent(row.count, total)}
        </span>
      </span>
      <span className="text-right">{formatNum(row.count)}</span>
      <span className="text-right">
        {row.errorCount === 0 ? (
          <span className="text-slate-300 dark:text-slate-600">0</span>
        ) : (
          <>
            {formatNum(row.errorCount)}{" "}
            <span className={cn("text-[10px] font-semibold", errorTone(row.errorCount, row.count))}>
              {percent(row.errorCount, row.count)}
            </span>
          </>
        )}
      </span>
      <span className="text-right text-slate-500 dark:text-slate-400">
        {formatBytes(row.bodyBytes)}
      </span>
    </div>
  );
}

export function NginxBreakdownTable({
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
      <div className="px-4 py-3">
        <h2 className={panelTitleClass}>
          {title}{" "}
          <span className="ml-1 text-xs font-normal text-slate-500">
            top {formatNum(rows.length)} of {formatNum(distinct)}
          </span>
        </h2>
        <p className={cn(mutedClass, "mt-0.5")}>Ranked by requests · exact counts</p>
      </div>
      <div className="overflow-x-auto">
        <div className="min-w-[700px]">
          <div
            className={`${breakdownGrid} h-9 border-y border-slate-200 bg-slate-50 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-950/50 dark:text-slate-400`}
          >
            <span className="pl-8">{title}</span>
            <span>Share</span>
            <span className="text-right">Requests</span>
            <span className="text-right">Errors</span>
            <span className="text-right">Body</span>
          </div>
          {rows.length > 0 && (
            <List
              rowComponent={BreakdownRow}
              rowProps={{ rows, total }}
              rowCount={rows.length}
              rowHeight={36}
              overscanCount={8}
              style={{ height: Math.min(640, rows.length * 36) }}
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

/** Compact top-5 card for the overview; links to the full breakdown view. */
export function NginxTopList({
  title,
  rows,
  distinct,
  total,
  view,
}: {
  title: string;
  rows: NginxBreakdown[];
  distinct: number;
  total: number;
  view: NginxView;
}) {
  return (
    <section className={cn(panelClass, "flex flex-col")}>
      <div className="flex items-center justify-between gap-2 px-4 pt-3 pb-2">
        <h2 className={panelTitleClass}>
          {title}{" "}
          <span className="ml-1 text-xs font-normal text-slate-500">{formatNum(distinct)}</span>
        </h2>
        <button
          type="button"
          onClick={() => setActiveView(view)}
          className="inline-flex items-center gap-0.5 text-[11px] font-medium text-violet-600 hover:text-violet-800 dark:text-violet-400 dark:hover:text-violet-300"
        >
          View all
          <ChevronRight className="size-3" aria-hidden />
        </button>
      </div>
      <ol className="flex flex-1 flex-col gap-2.5 px-4 pb-4">
        {rows.slice(0, 5).map((row) => (
          <li key={row.value} className="min-w-0">
            <div className="flex items-baseline justify-between gap-3 text-xs">
              <span
                className="truncate font-mono-data text-[11px] text-slate-700 dark:text-slate-200"
                title={row.value}
              >
                {displayValue(row.value)}
              </span>
              <span className="shrink-0 tabular-nums text-slate-500 dark:text-slate-400">
                {formatNum(row.count)}{" "}
                <span className="text-[10px]">· {percent(row.count, total)}</span>
              </span>
            </div>
            <div className="mt-1">
              <ShareBar count={row.count} max={rows[0]?.count ?? 0} />
            </div>
          </li>
        ))}
        {rows.length === 0 && <li className={mutedClass}>No matching requests.</li>}
      </ol>
    </section>
  );
}
