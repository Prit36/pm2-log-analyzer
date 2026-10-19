import { useState, type ReactNode } from "react";
import { ChevronDown, RotateCcw, Search, SlidersHorizontal, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useNginxStore } from "../../store/nginxStore";
import { reaggregateNginx } from "../../hooks/useNginxParserWorker";
import { DEFAULT_NGINX_FILTERS } from "../../nginx/types";
import type { NginxFilters, NginxStatusFamily, NginxView } from "../../nginx/types";
import type { NormalizeMode } from "../../parser";
import { formatNum } from "../../utils/format";
import { cn } from "../../utils/cn";
import { percent } from "./nginxUi";

const { setFilters, resetFilters, setActiveView } = useNginxStore.getState();
const fieldClass =
  "rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-800 focus:border-violet-500 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100";
const normalizeModes: NormalizeMode[] = ["collapseIds", "stripQuery", "exact"];
const statusFamilies: NginxStatusFamily[] = ["all", "errors", "2xx", "3xx", "4xx", "5xx"];
const normalizeLabels = {
  collapseIds: "Collapse IDs",
  stripQuery: "Strip query",
  exact: "Exact path",
} satisfies Record<NormalizeMode, string>;

export function updateNginxFilters(patch: Partial<NginxFilters>): void {
  setFilters(patch);
  void reaggregateNginx();
}

/** Exact status code filter; a family filter would contradict it, so it resets. */
export function filterNginxStatusCode(statusCode: number): void {
  updateNginxFilters({ statusCode, statusFamily: "all" });
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

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {label}
      </span>
      {children}
    </label>
  );
}

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  testId,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  testId?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      data-testid={testId}
      className="inline-flex rounded-md bg-slate-100 p-0.5 dark:bg-slate-800"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded px-2.5 py-1 text-xs font-medium text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100",
            value === option.value &&
              "bg-white text-violet-700 shadow-xs dark:bg-slate-950 dark:text-violet-300",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

type Chip = { key: string; label: string; clear: Partial<NginxFilters> };

function activeChips(filters: NginxFilters): Chip[] {
  const d = DEFAULT_NGINX_FILTERS;
  const chips: Chip[] = [];
  if (filters.query.trim())
    chips.push({ key: "query", label: `Search: ${filters.query.trim()}`, clear: { query: "" } });
  if (filters.statusCode !== 0)
    chips.push({ key: "code", label: `Status ${filters.statusCode}`, clear: { statusCode: 0 } });
  if (filters.statusFamily !== "all")
    chips.push({
      key: "family",
      label:
        filters.statusFamily === "errors" ? "Errors (4xx + 5xx)" : `Status ${filters.statusFamily}`,
      clear: { statusFamily: "all" },
    });
  if (filters.methods.length > 0)
    chips.push({ key: "methods", label: filters.methods.join(", "), clear: { methods: [] } });
  if (filters.dateFilter !== "all")
    chips.push({ key: "date", label: filters.dateFilter, clear: { dateFilter: "all" } });
  if (filters.minMs > 0)
    chips.push({ key: "minMs", label: `≥ ${formatNum(filters.minMs)} ms`, clear: { minMs: 0 } });
  if (filters.normalizeMode !== d.normalizeMode)
    chips.push({
      key: "normalize",
      label: normalizeLabels[filters.normalizeMode],
      clear: { normalizeMode: d.normalizeMode },
    });
  return chips;
}

function ActiveFilters({
  filters,
  matched,
  total,
}: {
  filters: NginxFilters;
  matched: number;
  total: number;
}) {
  const chips = activeChips(filters);
  if (chips.length === 0) return null;
  return (
    <div
      data-testid="nginx-active-filters"
      className="flex flex-wrap items-center gap-1.5 border-t border-slate-100 px-3 py-1.5 dark:border-slate-800"
    >
      <span className="text-[11px] text-slate-500 dark:text-slate-400">
        Showing{" "}
        <span className="font-semibold text-slate-700 dark:text-slate-200">
          {formatNum(matched)}
        </span>{" "}
        of {formatNum(total)} requests ({percent(matched, total)})
      </span>
      {chips.map((chip) => (
        <span
          key={chip.key}
          className="inline-flex max-w-72 items-center gap-1 rounded-full bg-violet-50 py-0.5 pr-1 pl-2 text-[11px] font-medium text-violet-700 ring-1 ring-violet-200 dark:bg-violet-950/50 dark:text-violet-300 dark:ring-violet-900"
        >
          <span className="truncate">{chip.label}</span>
          <button
            type="button"
            aria-label={`Remove filter ${chip.label}`}
            onClick={() => updateNginxFilters(chip.clear)}
            className="rounded-full p-0.5 hover:bg-violet-200 dark:hover:bg-violet-900"
          >
            <X className="size-3" aria-hidden />
          </button>
        </span>
      ))}
    </div>
  );
}

function ViewTabs() {
  const { activeView, endpointCount, clientCount, referrerCount, userAgentCount } = useNginxStore(
    useShallow((s) => ({
      activeView: s.activeView,
      endpointCount: s.result?.endpointCount ?? 0,
      clientCount: s.result?.clientCount ?? 0,
      referrerCount: s.result?.referrerCount ?? 0,
      userAgentCount: s.result?.userAgentCount ?? 0,
    })),
  );
  const views: { value: NginxView; label: string; count?: number }[] = [
    { value: "endpoints", label: "Endpoints", count: endpointCount },
    { value: "traffic", label: "Traffic" },
    { value: "clients", label: "Clients", count: clientCount },
    { value: "referrers", label: "Referrers", count: referrerCount },
    { value: "userAgents", label: "User agents", count: userAgentCount },
  ];
  return (
    <nav
      aria-label="Nginx analysis views"
      className="flex gap-1 overflow-x-auto border-b border-slate-200 px-2 [scrollbar-width:none] dark:border-slate-800"
    >
      {views.map((view) => {
        const active = activeView === view.value;
        return (
          <button
            key={view.value}
            type="button"
            data-testid={`nginx-view-${view.value}`}
            aria-current={active ? "page" : undefined}
            onClick={() => setActiveView(view.value)}
            className={cn(
              "flex shrink-0 items-center gap-1.5 px-3 py-2 text-xs font-semibold",
              active
                ? "text-violet-700 shadow-[inset_0_-2px_0_var(--color-violet-600)] dark:text-violet-300 dark:shadow-[inset_0_-2px_0_var(--color-violet-400)]"
                : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200",
            )}
          >
            {view.label}
            {view.count != null && (
              <span
                className={cn(
                  "rounded-full px-1.5 text-[10px] font-medium tabular-nums",
                  active
                    ? "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300"
                    : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
                )}
              >
                {formatNum(view.count)}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

export function NginxFilterBar() {
  const { filters, dates, methods, isParsing, requestTimed, upstreamTimed, matched, total } =
    useNginxStore(
      useShallow((s) => ({
        matched: s.result?.summary.count ?? 0,
        total: s.result?.diagnostics.matchedLines ?? 0,
        filters: s.filters,
        dates: s.result?.dates,
        methods: s.result?.methods,
        isParsing: s.isParsing,
        requestTimed: s.result?.summary.requestTime.count ?? 0,
        upstreamTimed: s.result?.summary.upstreamTime.count ?? 0,
      })),
    );
  const extraCount = countMoreFilters(filters);
  const [expanded, setExpanded] = useState(extraCount > 0);
  const hasTiming =
    requestTimed > 0 || upstreamTimed > 0 || filters.minMs > 0 || filters.metric !== "request";
  const changed =
    extraCount > 0 ||
    filters.query !== "" ||
    filters.statusFamily !== "all" ||
    filters.statusCode !== 0 ||
    filters.metric !== "request" ||
    filters.sortKey !== "count" ||
    filters.sortDir !== "desc" ||
    filters.topN !== 50;
  return (
    <section
      aria-label="Nginx filters"
      className="rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
    >
      <ViewTabs />
      <fieldset
        disabled={isParsing}
        className="flex flex-wrap items-center gap-2 px-3 py-2 disabled:opacity-50"
      >
        <label className="relative min-w-[14rem] flex-1">
          <span className="sr-only">Search paths or client IPs</span>
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-slate-400"
            aria-hidden
          />
          <input
            type="search"
            data-testid="nginx-filter-search"
            className={cn(fieldClass, "w-full pl-8")}
            placeholder="Search paths or client IPs…"
            title="Search a path or IP. Use ip:ADDRESS /path to combine an exact client with a path."
            value={filters.query}
            onChange={(event) => updateNginxFilters({ query: event.target.value })}
          />
        </label>
        <Segmented
          label="Status"
          testId="nginx-filter-status"
          value={filters.statusFamily}
          options={statusFamilies.map((value) => ({
            value,
            label: value === "all" ? "All status" : value === "errors" ? "Errors" : value,
          }))}
          onChange={(statusFamily) => updateNginxFilters({ statusFamily, statusCode: 0 })}
        />
        {hasTiming && (
          <Segmented
            label="Timing metric"
            testId="nginx-filter-metric"
            value={filters.metric}
            options={[
              { value: "request", label: "Request time" },
              { value: "upstream", label: "Upstream time" },
            ]}
            onChange={(metric) => updateNginxFilters({ metric })}
          />
        )}
        <button
          type="button"
          data-testid="nginx-more-filters"
          aria-expanded={expanded}
          aria-controls="nginx-extra-filters"
          onClick={() => setExpanded(!expanded)}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          <SlidersHorizontal className="size-3.5" aria-hidden />
          More
          {extraCount > 0 && (
            <span className="rounded-full bg-violet-100 px-1.5 text-[10px] text-violet-700 dark:bg-violet-950 dark:text-violet-300">
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
            className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
          >
            <RotateCcw className="size-3.5" aria-hidden />
            Reset
          </button>
        )}
      </fieldset>
      <ActiveFilters filters={filters} matched={matched} total={total} />
      {expanded && (
        <fieldset
          id="nginx-extra-filters"
          disabled={isParsing}
          className="flex flex-wrap items-end gap-4 border-t border-slate-100 px-3 py-2.5 disabled:opacity-50 dark:border-slate-800"
        >
          <Field label="Group paths">
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
          {hasTiming && (
            <Field label="Slower than (ms)">
              <input
                data-testid="nginx-filter-min-ms"
                className={fieldClass + " w-24"}
                type="number"
                min={0}
                value={filters.minMs}
                onChange={(event) =>
                  updateNginxFilters({ minMs: Math.max(0, Number(event.target.value) || 0) })
                }
              />
            </Field>
          )}
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
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Methods
              </span>
              <div className="flex flex-wrap items-center gap-1.5">
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
            </div>
          )}
        </fieldset>
      )}
    </section>
  );
}
