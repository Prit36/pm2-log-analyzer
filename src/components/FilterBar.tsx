import { useEffect, useRef, type ReactNode } from "react";
import { EMPTY_METHODS, useAnalysisStore, type ApiSortKey } from "../store/analysisStore";
import type { NormalizeMode, StatusFamily } from "../parser";
import { cn } from "../utils/cn";

const fieldClass =
  "rounded border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-800 focus:border-blue-500";

export function FilterBar() {
  const searchRef = useRef<HTMLInputElement>(null);
  const filters = useAnalysisStore((s) => s.filters);
  const setFilters = useAnalysisStore((s) => s.setFilters);
  const toggleMethod = useAnalysisStore((s) => s.toggleMethod);
  const setMethodFilter = useAnalysisStore((s) => s.setMethodFilter);
  const methods = useAnalysisStore((s) => s.result?.methods ?? EMPTY_METHODS);
  const hasData = useAnalysisStore((s) => s.hasData);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!hasData) return null;

  const selected = new Set(filters.methods);
  const allSelected = filters.methods.length === 0;

  return (
    <section className="rounded border border-slate-200 bg-white px-3 py-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Normalize">
          <select
            value={filters.normalizeMode}
            onChange={(e) => setFilters({ normalizeMode: e.target.value as NormalizeMode })}
            className={fieldClass}
          >
            <option value="collapseIds">Collapse IDs</option>
            <option value="stripQuery">Strip query</option>
            <option value="exact">Exact path</option>
          </select>
        </Field>
        <Field label="Status">
          <select
            data-testid="filter-status"
            value={filters.statusFamily}
            onChange={(e) => setFilters({ statusFamily: e.target.value as StatusFamily })}
            className={fieldClass}
          >
            <option value="all">All</option>
            <option value="2xx">2xx</option>
            <option value="3xx">3xx</option>
            <option value="4xx">4xx</option>
            <option value="5xx">5xx</option>
          </select>
        </Field>
        <Field label="Min ms">
          <input
            data-testid="filter-min-ms"
            type="number"
            min={0}
            value={filters.minMs}
            onChange={(e) => setFilters({ minMs: Math.max(0, Number(e.target.value) || 0) })}
            className={cn(fieldClass, "w-20")}
          />
        </Field>
        <Field label="Sort">
          <select
            value={filters.sortKey}
            onChange={(e) => setFilters({ sortKey: e.target.value as ApiSortKey })}
            className={fieldClass}
          >
            <option value="p95Ms">p95</option>
            <option value="p99Ms">p99</option>
            <option value="avgMs">avg</option>
            <option value="maxMs">max</option>
            <option value="count">count</option>
            <option value="errorCount">errors</option>
          </select>
        </Field>
        <Field label="Top N">
          <input
            type="number"
            min={1}
            max={500}
            value={filters.topN}
            onChange={(e) =>
              setFilters({ topN: Math.min(500, Math.max(1, Number(e.target.value) || 1)) })
            }
            className={cn(fieldClass, "w-20")}
          />
        </Field>
        <Field label="Search" className="min-w-[12rem] flex-1">
          <input
            ref={searchRef}
            type="search"
            value={filters.query}
            onChange={(e) => setFilters({ query: e.target.value })}
            placeholder="Filter endpoints… (/)"
            className={cn(fieldClass, "w-full")}
          />
        </Field>
      </div>

      {methods.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Methods
          </span>
          <MethodChip
            label="All"
            active={allSelected}
            onClick={() => setMethodFilter([])}
          />
          {methods.map((m) => (
            <MethodChip
              key={m}
              label={m}
              active={allSelected || selected.has(m)}
              onClick={() => {
                if (allSelected) setMethodFilter([m]);
                else toggleMethod(m);
              }}
            />
          ))}
          {!allSelected && (
            <button
              type="button"
              onClick={() => setMethodFilter([])}
              className="text-[11px] text-slate-500 underline-offset-2 hover:underline"
            >
              Reset
            </button>
          )}
        </div>
      )}
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
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </span>
      {children}
    </label>
  );
}

function MethodChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1",
        active
          ? "bg-blue-50 text-blue-700 ring-blue-200"
          : "bg-slate-50 text-slate-400 ring-slate-200",
      )}
    >
      {label}
    </button>
  );
}
