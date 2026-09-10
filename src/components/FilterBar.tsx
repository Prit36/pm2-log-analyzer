import type { ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import {
  countActiveAnalysisFilters,
  EMPTY_DATES,
  EMPTY_METHODS,
  useAnalysisStore,
  type ApiSortKey,
} from "../store/analysisStore";
import { reaggregate, resetPm2Filters } from "../hooks/useParserWorker";
import type { NormalizeMode, StatusFamily } from "../parser";
import { formatDate } from "../utils/format";
import { cn } from "../utils/cn";

const fieldClass =
  "rounded border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-800 focus:border-blue-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:focus:border-blue-400";

function isNormalizeMode(value: string): value is NormalizeMode {
  return value === "collapseIds" || value === "stripQuery" || value === "exact";
}

function isStatusFamily(value: string): value is StatusFamily {
  return (
    value === "all" || value === "2xx" || value === "3xx" || value === "4xx" || value === "5xx"
  );
}

function isApiSortKey(value: string): value is ApiSortKey {
  return (
    value === "p95Ms" ||
    value === "p99Ms" ||
    value === "avgMs" ||
    value === "maxMs" ||
    value === "count" ||
    value === "errorCount" ||
    value === "path"
  );
}

const { setFilters, setMethodFilter, toggleMethod } = useAnalysisStore.getState();

window.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (
    t instanceof HTMLElement &&
    (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)
  )
    return;
  const input = document.querySelector<HTMLInputElement>("input[data-filter-search]");
  if (input) {
    e.preventDefault();
    input.focus();
  }
});

function SearchField({ value }: { value: string }) {
  return (
    <Field label="Search" className="min-w-[14rem] flex-1">
      <input
        data-filter-search
        type="search"
        value={value}
        onChange={(e) => setFilters({ query: e.target.value })}
        placeholder="Filter endpoints… (/)"
        className={cn(fieldClass, "w-full")}
      />
    </Field>
  );
}

function NormalizeSelect({ value }: { value: NormalizeMode }) {
  return (
    <Field label="Normalize">
      <select
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          if (isNormalizeMode(v)) {
            setFilters({ normalizeMode: v });
            void reaggregate();
          }
        }}
        className={fieldClass}
      >
        <option value="collapseIds">Collapse IDs</option>
        <option value="stripQuery">Strip query</option>
        <option value="exact">Exact path</option>
      </select>
    </Field>
  );
}

function StatusSelect({ value }: { value: StatusFamily }) {
  return (
    <Field label="Status">
      <select
        data-testid="filter-status"
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          if (isStatusFamily(v)) {
            setFilters({ statusFamily: v });
            void reaggregate();
          }
        }}
        className={fieldClass}
      >
        <option value="all">All</option>
        <option value="2xx">2xx</option>
        <option value="3xx">3xx</option>
        <option value="4xx">4xx</option>
        <option value="5xx">5xx</option>
      </select>
    </Field>
  );
}

function MinMsField({ value }: { value: number }) {
  return (
    <Field label="Min ms">
      <input
        data-testid="filter-min-ms"
        type="number"
        min={0}
        value={value}
        onChange={(e) => {
          setFilters({ minMs: Math.max(0, Number(e.target.value) || 0) });
          void reaggregate();
        }}
        className={cn(fieldClass, "w-20")}
      />
    </Field>
  );
}

function SortSelect({ value }: { value: ApiSortKey }) {
  return (
    <Field label="Sort">
      <select
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          if (isApiSortKey(v)) setFilters({ sortKey: v });
        }}
        className={fieldClass}
      >
        <option value="p95Ms">p95</option>
        <option value="p99Ms">p99</option>
        <option value="avgMs">avg</option>
        <option value="maxMs">max</option>
        <option value="count">count</option>
        <option value="errorCount">errors</option>
        <option value="path">endpoint</option>
      </select>
    </Field>
  );
}

function TopNField({ value }: { value: number }) {
  return (
    <Field label="Top N">
      <input
        type="number"
        min={1}
        max={500}
        value={value}
        onChange={(e) =>
          setFilters({ topN: Math.min(500, Math.max(1, Number(e.target.value) || 1)) })
        }
        className={cn(fieldClass, "w-20")}
      />
    </Field>
  );
}

function TopFilterRow(props: {
  query: string;
  normalizeMode: NormalizeMode;
  statusFamily: StatusFamily;
  minMs: number;
  sortKey: ApiSortKey;
  topN: number;
  activeFilterCount: number;
}) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <SearchField value={props.query} />
      <NormalizeSelect value={props.normalizeMode} />
      <StatusSelect value={props.statusFamily} />
      <MinMsField value={props.minMs} />
      <SortSelect value={props.sortKey} />
      <TopNField value={props.topN} />
      <div className="ml-auto flex items-center">
        <button
          type="button"
          data-testid="pm2-reset-filters"
          disabled={props.activeFilterCount === 0}
          onClick={() => void resetPm2Filters()}
          className={cn(
            "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold transition-all",
            props.activeFilterCount > 0
              ? "border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100 hover:text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300 dark:hover:bg-rose-900/60"
              : "border border-transparent text-slate-400 opacity-40 cursor-not-allowed dark:text-slate-500",
          )}
          title={props.activeFilterCount > 0 ? "Reset all filters to defaults" : "No active filters to reset"}
        >
          <RotateCcw className="size-3" />
          <span>Reset all filters</span>
          {props.activeFilterCount > 0 && (
            <span className="rounded-full bg-rose-200/80 px-1.5 py-0.2 text-[10px] font-bold text-rose-800 dark:bg-rose-900 dark:text-rose-200">
              {props.activeFilterCount}
            </span>
          )}
        </button>
      </div>
    </div>
  );
}

function DateFilterChips({ dates, active }: { dates: string[]; active: string }) {
  return (
    <div data-testid="filter-date" className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        Day
      </span>
      <button
        type="button"
        onClick={() => {
          setFilters({ dateFilter: "all" });
          void reaggregate();
        }}
        className={cn(
          "rounded px-2 py-0.5 text-[10px] font-medium tracking-wide ring-1 transition-colors",
          active === "all"
            ? "bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-950/60 dark:text-blue-300 dark:ring-blue-800"
            : "bg-slate-50 text-slate-500 ring-slate-200 hover:bg-slate-100 dark:bg-slate-800/60 dark:text-slate-400 dark:ring-slate-700 dark:hover:bg-slate-800",
        )}
      >
        All Days ({dates.length})
      </button>
      {dates.map((d) => (
        <button
          key={d}
          type="button"
          onClick={() => {
            setFilters({ dateFilter: d });
            void reaggregate();
          }}
          className={cn(
            "rounded px-2 py-0.5 font-mono-data text-[10px] tracking-wide ring-1 transition-colors",
            active === d
              ? "bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-950/60 dark:text-blue-300 dark:ring-blue-800"
              : "bg-slate-50 text-slate-500 ring-slate-200 hover:bg-slate-100 dark:bg-slate-800/60 dark:text-slate-400 dark:ring-slate-700 dark:hover:bg-slate-800",
          )}
        >
          {formatDate(d)}
        </button>
      ))}
    </div>
  );
}

function MethodFilterChips({ methods, allSelected }: { methods: string[]; allSelected: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        Methods
      </span>
      <MethodChip label="All" allSelected={allSelected} />
      {methods.map((m) => (
        <MethodChip key={m} method={m} label={m} allSelected={allSelected} />
      ))}
      {!allSelected && (
        <button
          type="button"
          onClick={() => setMethodFilter([])}
          className="text-[11px] text-slate-500 underline-offset-2 hover:underline dark:text-slate-400"
        >
          Reset
        </button>
      )}
    </div>
  );
}

function SecondaryFilterRow(props: {
  dates: string[];
  dateFilter: string;
  methods: string[];
  allSelected: boolean;
}) {
  if (props.dates.length <= 1 && props.methods.length === 0) return null;
  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-3">
      {props.dates.length > 1 && <DateFilterChips dates={props.dates} active={props.dateFilter} />}
      {props.dates.length > 1 && props.methods.length > 0 && (
        <div className="hidden h-4 w-px bg-slate-200 sm:block dark:bg-slate-700" />
      )}
      {props.methods.length > 0 && (
        <MethodFilterChips methods={props.methods} allSelected={props.allSelected} />
      )}
    </div>
  );
}

export function FilterBar() {
  const {
    filters,
    allSelected,
    methods,
    dates,
    hasData,
  } = useAnalysisStore(
    useShallow((s) => ({
      filters: s.filters,
      allSelected: s.filters.methods.length === 0,
      methods: s.result?.methods ?? EMPTY_METHODS,
      dates: s.result?.dates ?? EMPTY_DATES,
      hasData: s.hasData,
    })),
  );

  const activeFilterCount = countActiveAnalysisFilters(filters);

  if (!hasData) return null;

  return (
    <section className="rounded border border-slate-200 bg-white px-3 py-3 dark:border-slate-800 dark:bg-slate-900">
      <TopFilterRow
        query={filters.query}
        normalizeMode={filters.normalizeMode}
        statusFamily={filters.statusFamily}
        minMs={filters.minMs}
        sortKey={filters.sortKey}
        topN={filters.topN}
        activeFilterCount={activeFilterCount}
      />
      <SecondaryFilterRow
        dates={dates}
        dateFilter={filters.dateFilter}
        methods={methods}
        allSelected={allSelected}
      />
    </section>
  );
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {label}
      </span>
      {children}
    </label>
  );
}

function MethodChip({
  method,
  label,
  allSelected,
}: {
  method?: string;
  label: string;
  allSelected: boolean;
}) {
  const isSelected = useAnalysisStore((s) => (method ? s.filters.methods.includes(method) : false));
  const active = allSelected || isSelected;
  const handleClick = () => {
    if (!method) setMethodFilter([]);
    else if (allSelected) setMethodFilter([method]);
    else toggleMethod(method);
  };
  return (
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        "rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 transition-colors",
        active
          ? "bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-950/60 dark:text-blue-300 dark:ring-blue-800"
          : "bg-slate-50 text-slate-400 ring-slate-200 dark:bg-slate-800/60 dark:text-slate-400 dark:ring-slate-700",
      )}
    >
      {label}
    </button>
  );
}
