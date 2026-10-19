import { useMemo, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Search, X } from "lucide-react";
import { List, type RowComponentProps } from "react-window";
import { formatNum } from "../../utils/format";
import { cn } from "../../utils/cn";
import { panelClass, panelTitleClass } from "./nginxUi";

export type NginxColumn<T> = {
  id: string;
  label: string;
  /** CSS grid track, e.g. "minmax(200px,1fr)" or "90px". */
  width: string;
  align?: "right";
  title?: string;
  /** Sortable when present. Strings sort ascending first, numbers descending. */
  sort?: (row: T) => number | string;
  render: (row: T, index: number) => ReactNode;
};

type SortState = { id: string; dir: "asc" | "desc" };

type RowProps<T> = {
  rows: T[];
  columns: NginxColumn<T>[];
  grid: string;
};

function TableRow<T>({ index, style, rows, columns, grid }: RowComponentProps<RowProps<T>>) {
  const row = rows[index];
  if (row === undefined) return null;
  return (
    <div
      role="row"
      style={{ ...style, gridTemplateColumns: grid }}
      className="grid items-center gap-3 border-b border-slate-100 px-3 text-xs tabular-nums text-slate-700 hover:bg-violet-50/40 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-violet-950/20"
    >
      {columns.map((column) => (
        <div
          key={column.id}
          role="cell"
          className={cn("min-w-0", column.align === "right" && "text-right")}
        >
          {column.render(row, index)}
        </div>
      ))}
    </div>
  );
}

function compareValues(a: number | string, b: number | string): number {
  if (String(a) === a || String(b) === b) return String(a).localeCompare(String(b));
  return Number(a) - Number(b);
}

/** Client-side sortable, searchable, virtualized table for the capped breakdown lists. */
export function NginxTable<T>({
  title,
  total,
  rows,
  columns,
  defaultSort,
  searchText,
  searchPlaceholder = "Filter rows…",
  toolbar,
  minWidth,
  emptyText = "No matching rows.",
  maxHeight = 576,
  testId,
}: {
  title: string;
  /** Distinct values before the core's top-N cap. */
  total: number;
  rows: T[];
  columns: NginxColumn<T>[];
  defaultSort: SortState;
  searchText?: (row: T) => string;
  searchPlaceholder?: string;
  toolbar?: ReactNode;
  minWidth: number;
  emptyText?: string;
  maxHeight?: number;
  testId?: string;
}) {
  const [sort, setSort] = useState<SortState>(defaultSort);
  const [query, setQuery] = useState("");
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered =
      needle && searchText
        ? rows.filter((row) => searchText(row).toLowerCase().includes(needle))
        : rows;
    const column = columns.find((entry) => entry.id === sort.id);
    if (!column?.sort) return filtered;
    const key = column.sort;
    const sign = sort.dir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => sign * compareValues(key(a), key(b)));
  }, [rows, columns, sort, query, searchText]);
  const grid = columns.map((column) => column.width).join(" ");
  const toggleSort = (column: NginxColumn<T>) => {
    if (!column.sort) return;
    if (sort.id === column.id) {
      setSort({ id: column.id, dir: sort.dir === "desc" ? "asc" : "desc" });
      return;
    }
    const sample = rows[0];
    const textual = sample !== undefined && String(column.sort(sample)) === column.sort(sample);
    setSort({ id: column.id, dir: textual ? "asc" : "desc" });
  };
  return (
    <section className={panelClass} data-testid={testId}>
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-800">
        <h2 className={cn(panelTitleClass, "mr-auto")}>
          {title}{" "}
          <span className="font-normal normal-case tracking-normal text-slate-400">
            {visible.length !== rows.length
              ? `${formatNum(visible.length)} of ${formatNum(rows.length)}`
              : formatNum(rows.length)}
            {total > rows.length ? ` · top ${formatNum(rows.length)} of ${formatNum(total)}` : ""}
          </span>
        </h2>
        {toolbar}
        {searchText && (
          <label className="relative w-full sm:w-56">
            <span className="sr-only">{searchPlaceholder}</span>
            <Search
              className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-slate-400"
              aria-hidden
            />
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={searchPlaceholder}
              className="w-full rounded-md border border-slate-200 bg-white py-1 pr-7 pl-7 text-xs text-slate-800 focus:border-violet-500 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
            {query && (
              <button
                type="button"
                aria-label="Clear row filter"
                onClick={() => setQuery("")}
                className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
              >
                <X className="size-3" aria-hidden />
              </button>
            )}
          </label>
        )}
      </div>
      <div className="overflow-x-auto" role="table" aria-label={title}>
        <div style={{ minWidth }}>
          <div
            role="row"
            style={{ gridTemplateColumns: grid }}
            className="grid h-8 items-center gap-3 border-b border-slate-200 bg-slate-50 px-3 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-950/50 dark:text-slate-400"
          >
            {columns.map((column) => {
              const active = sort.id === column.id;
              const Icon = !active ? ArrowUpDown : sort.dir === "desc" ? ArrowDown : ArrowUp;
              return column.sort ? (
                <button
                  key={column.id}
                  type="button"
                  role="columnheader"
                  title={column.title}
                  aria-sort={active ? (sort.dir === "desc" ? "descending" : "ascending") : "none"}
                  onClick={() => toggleSort(column)}
                  className={cn(
                    "group flex min-w-0 items-center gap-1 uppercase hover:text-slate-800 dark:hover:text-slate-200",
                    column.align === "right" && "justify-end",
                    active && "text-violet-700 dark:text-violet-300",
                  )}
                >
                  <span className="truncate">{column.label}</span>
                  <Icon
                    className={cn("size-3 shrink-0", !active && "opacity-0 group-hover:opacity-60")}
                    aria-hidden
                  />
                </button>
              ) : (
                <span
                  key={column.id}
                  role="columnheader"
                  title={column.title}
                  className={cn("truncate", column.align === "right" && "text-right")}
                >
                  {column.label}
                </span>
              );
            })}
          </div>
          {visible.length > 0 && (
            <List
              rowComponent={TableRow<T>}
              rowProps={{ rows: visible, columns, grid }}
              rowCount={visible.length}
              rowHeight={34}
              overscanCount={8}
              style={{ height: Math.min(maxHeight, visible.length * 34) }}
            />
          )}
        </div>
      </div>
      {visible.length === 0 && (
        <p className="px-3 py-8 text-center text-xs text-slate-500 dark:text-slate-400">
          {rows.length === 0 ? "No requests match these filters." : emptyText}
        </p>
      )}
    </section>
  );
}
