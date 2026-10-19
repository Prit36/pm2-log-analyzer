import { List, type RowComponentProps } from "react-window";
import { useNginxStore } from "../../store/nginxStore";
import type { NginxBreakdown } from "../../nginx/types";
import { formatBytes, formatNum } from "../../utils/format";
import { cn } from "../../utils/cn";
import { errorTone, panelClass, percent } from "./nginxUi";
import { updateNginxFilters } from "./NginxFilterBar";

const { setActiveView } = useNginxStore.getState();

export function showNginxClientEndpoints(client: string): void {
  const query = useNginxStore.getState().filters.query;
  const pathQuery = query
    .split(/\s+/)
    .filter((part) => !part.toLowerCase().startsWith("ip:") && part !== client)
    .join(" ")
    .trim();
  setActiveView("endpoints");
  updateNginxFilters({ query: `ip:${client}${pathQuery ? ` ${pathQuery}` : ""}` });
}
function breakdownGrid(clients: boolean): string {
  return cn(
    "grid items-center gap-2 px-3",
    clients
      ? "grid-cols-[minmax(180px,1fr)_160px_minmax(80px,160px)_84px_96px_84px]"
      : "grid-cols-[minmax(220px,1fr)_minmax(120px,200px)_84px_96px_84px]",
  );
}

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

type BreakdownRowProps = {
  rows: NginxBreakdown[];
  total: number;
  clients: boolean;
  countries: Map<string, string> | undefined;
};
function BreakdownRow({
  index,
  style,
  rows,
  total,
  clients,
  countries,
}: RowComponentProps<BreakdownRowProps>) {
  const row = rows[index];
  if (!row) return null;
  return (
    <div
      style={style}
      className={`${breakdownGrid(clients)} border-b border-slate-100 text-xs tabular-nums text-slate-700 dark:border-slate-800 dark:text-slate-200`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="w-6 shrink-0 text-right text-[10px] text-slate-400">{index + 1}</span>
        {clients ? (
          <button
            type="button"
            onClick={() => showNginxClientEndpoints(row.value)}
            className="truncate font-mono-data text-[11px] text-violet-700 hover:underline dark:text-violet-300"
            title={`Show endpoints requested by ${row.value}`}
          >
            {displayValue(row.value)}
          </button>
        ) : (
          <span className="truncate font-mono-data text-[11px]" title={row.value}>
            {displayValue(row.value)}
          </span>
        )}
      </span>
      {clients && (
        <span
          className="truncate text-slate-600 dark:text-slate-300"
          title={countries?.get(row.value)}
        >
          {countries?.get(row.value) ?? "Unavailable"}
        </span>
      )}
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
  countries,
}: {
  title: string;
  rows: NginxBreakdown[];
  distinct: number;
  total: number;
  countries?: Map<string, string>;
}) {
  const clients = title === "Clients";
  return (
    <section className={panelClass}>
      <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2 dark:border-slate-800">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">
          {title}{" "}
          <span className="font-normal text-slate-400">
            ({formatNum(rows.length)}
            {distinct > rows.length ? ` / ${formatNum(distinct)}` : ""})
          </span>
        </h2>
      </div>
      <div className="overflow-x-auto">
        <div className={clients ? "min-w-[800px]" : "min-w-[680px]"}>
          <div
            className={`${breakdownGrid(clients)} h-8 border-b border-slate-200 bg-slate-50 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-950/50 dark:text-slate-400`}
          >
            <span className="pl-8">{title}</span>
            {clients && <span>Country</span>}
            <span>Share</span>
            <span className="text-right">Requests</span>
            <span className="text-right">Errors</span>
            <span className="text-right">Body</span>
          </div>
          {rows.length > 0 && (
            <List
              rowComponent={BreakdownRow}
              rowProps={{ rows, total, clients, countries }}
              rowCount={rows.length}
              rowHeight={32}
              overscanCount={8}
              style={{ height: Math.min(576, rows.length * 32) }}
            />
          )}
        </div>
      </div>
      {rows.length === 0 && (
        <p className="p-6 text-center text-xs text-slate-400 dark:text-slate-500">
          No matching requests.
        </p>
      )}
    </section>
  );
}
