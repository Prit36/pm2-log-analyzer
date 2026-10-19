import { useState, type ReactNode } from "react";
import { ChevronDown, RotateCcw, SlidersHorizontal } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useNginxStore } from "../../store/nginxStore";
import { reaggregateNginx } from "../../hooks/useNginxParserWorker";
import type { NginxFilters } from "../../nginx/types";
import type { NormalizeMode, StatusFamily } from "../../parser";

const { setFilters, resetFilters } = useNginxStore.getState();
const fieldClass =
  "rounded border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-800 focus:border-violet-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100";
const normalizeModes: NormalizeMode[] = ["collapseIds", "stripQuery", "exact"];
const statusFamilies: StatusFamily[] = ["all", "2xx", "3xx", "4xx", "5xx"];

export function updateNginxFilters(patch: Partial<NginxFilters>): void {
  setFilters(patch);
  void reaggregateNginx();
}

export function resetNginxFilters(): void {
  resetFilters();
  void reaggregateNginx();
}

function countMoreFilters(filters: NginxFilters): number {
  return (
    Number(filters.normalizeMode !== "collapseIds") +
    Number(filters.minMs > 0) +
    Number(filters.methods.length > 0) +
    Number(filters.dateFilter !== "all")
  );
}

function Field({
  label,
  children,
  grow = false,
}: {
  label: string;
  children: ReactNode;
  grow?: boolean;
}) {
  return (
    <label className={"flex flex-col gap-1" + (grow ? " min-w-[12rem] flex-1" : "")}>
      <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {label}
      </span>
      {children}
    </label>
  );
}

export function NginxFilterBar() {
  const { filters, dates, methods, isParsing } = useNginxStore(
    useShallow((s) => ({
      filters: s.filters,
      dates: s.result?.dates,
      methods: s.result?.methods,
      isParsing: s.isParsing,
    })),
  );
  const extraCount = countMoreFilters(filters);
  const [expanded, setExpanded] = useState(extraCount > 0);
  const changed =
    extraCount > 0 ||
    filters.query !== "" ||
    filters.statusFamily !== "all" ||
    filters.metric !== "request" ||
    filters.sortKey !== "count" ||
    filters.sortDir !== "desc" ||
    filters.topN !== 50;
  return (
    <section
      aria-label="Nginx filters"
      className="rounded border border-slate-200 bg-white px-3 py-3 dark:border-slate-800 dark:bg-slate-900"
    >
      <fieldset disabled={isParsing} className="flex flex-wrap items-end gap-3 disabled:opacity-50">
        <Field label="Path search" grow>
          <input
            type="search"
            data-testid="nginx-filter-search"
            className={fieldClass}
            placeholder="Filter endpoints…"
            value={filters.query}
            onChange={(event) => updateNginxFilters({ query: event.target.value })}
          />
        </Field>
        <Field label="Status">
          <select
            data-testid="nginx-filter-status"
            className={fieldClass}
            value={filters.statusFamily}
            onChange={(event) => {
              const status = statusFamilies.find((value) => value === event.target.value);
              if (status) updateNginxFilters({ statusFamily: status });
            }}
          >
            {statusFamilies.map((value) => (
              <option key={value} value={value}>
                {value === "all" ? "All" : value}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Timing">
          <select
            data-testid="nginx-filter-metric"
            className={fieldClass}
            value={filters.metric}
            onChange={(event) => {
              const value = event.target.value;
              if (value === "request" || value === "upstream")
                updateNginxFilters({ metric: value });
            }}
          >
            <option value="request">Request time (rt)</option>
            <option value="upstream">Upstream time (urt)</option>
          </select>
        </Field>
        <button
          type="button"
          data-testid="nginx-more-filters"
          aria-expanded={expanded}
          aria-controls="nginx-extra-filters"
          onClick={() => setExpanded(!expanded)}
          className="inline-flex items-center gap-1.5 rounded px-2 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          <SlidersHorizontal className="size-3.5" aria-hidden />
          More filters
          {extraCount > 0 && (
            <span className="rounded bg-violet-100 px-1.5 text-[10px] text-violet-700 dark:bg-violet-950 dark:text-violet-300">
              {extraCount}
            </span>
          )}
          <ChevronDown
            className={"size-3 transition-transform" + (expanded ? " rotate-180" : "")}
            aria-hidden
          />
        </button>
        {changed && (
          <button
            type="button"
            data-testid="nginx-reset-filters"
            onClick={resetNginxFilters}
            className="flex items-center gap-1.5 rounded px-2 py-1.5 text-xs text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
          >
            <RotateCcw className="size-3.5" aria-hidden />
            Reset
          </button>
        )}
      </fieldset>
      {expanded && (
        <fieldset
          id="nginx-extra-filters"
          disabled={isParsing}
          className="mt-3 flex flex-wrap items-end gap-3 border-t border-slate-100 pt-3 disabled:opacity-50 dark:border-slate-800"
        >
          <Field label="Normalize">
            <select
              className={fieldClass}
              value={filters.normalizeMode}
              onChange={(event) => {
                const mode = normalizeModes.find((value) => value === event.target.value);
                if (mode) updateNginxFilters({ normalizeMode: mode });
              }}
            >
              <option value="collapseIds">Collapse IDs</option>
              <option value="stripQuery">Strip query</option>
              <option value="exact">Exact path</option>
            </select>
          </Field>
          <Field label="Min ms">
            <input
              data-testid="nginx-filter-min-ms"
              className={fieldClass + " w-20"}
              type="number"
              min={0}
              value={filters.minMs}
              onChange={(event) =>
                updateNginxFilters({ minMs: Math.max(0, Number(event.target.value) || 0) })
              }
            />
          </Field>
          {dates && (dates.length > 1 || filters.dateFilter !== "all") && (
            <Field label="Day · log-local time">
              <select
                data-testid="nginx-filter-date"
                className={fieldClass}
                value={filters.dateFilter}
                onChange={(event) => updateNginxFilters({ dateFilter: event.target.value })}
              >
                <option value="all">All days ({dates.length})</option>
                {dates.map((date) => (
                  <option key={date} value={date}>
                    {date}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {methods && (methods.length > 1 || filters.methods.length > 0) && (
            <div className="flex flex-wrap items-center gap-1.5 pb-1">
              <span className="mr-1 text-[10px] font-semibold uppercase text-slate-500">
                Methods
              </span>
              {["All", ...methods].map((method) => {
                const active =
                  method === "All"
                    ? filters.methods.length === 0
                    : filters.methods.length === 0 || filters.methods.includes(method);
                return (
                  <button
                    type="button"
                    key={method}
                    aria-pressed={active}
                    onClick={() =>
                      updateNginxFilters({
                        methods:
                          method === "All"
                            ? []
                            : filters.methods.length === 0
                              ? [method]
                              : filters.methods.includes(method)
                                ? filters.methods.filter((value) => value !== method)
                                : [...filters.methods, method],
                      })
                    }
                    className={
                      "rounded px-2 py-1 text-[10px] font-semibold ring-1 " +
                      (active
                        ? "bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-950/60 dark:text-violet-300 dark:ring-violet-800"
                        : "text-slate-500 ring-slate-200 dark:text-slate-400 dark:ring-slate-700")
                    }
                  >
                    {method}
                  </button>
                );
              })}
            </div>
          )}
        </fieldset>
      )}
    </section>
  );
}
