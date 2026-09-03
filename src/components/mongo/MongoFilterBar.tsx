import { BarChart3, Database, FileText, Filter, Flame, Search, ShieldAlert, User, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useMongoStore, type MongoActiveView } from "../../store/mongoStore";
import { reaggregateMongo } from "../../hooks/useMongoParserWorker";
import type { MongoPlanFilter } from "../../mongo/types";
import { cn } from "../../utils/cn";
import { formatNum } from "../../utils/format";

const {
  setActiveView,
  setCollectionFilter,
  setMinDurationMs,
  setOperationFilter,
  setPlanFilter,
  setSearchQuery,
  setUserFilter,
  toggleHighScanRatio,
} = useMongoStore.getState();

const VIEW_TABS: { id: MongoActiveView; label: string; icon: typeof FileText }[] = [
  { id: "patterns", label: "Query Patterns", icon: Database },
  { id: "slow_queries", label: "Slow Query Log", icon: FileText },
  { id: "users", label: "User Activity", icon: User },
  { id: "charts", label: "Latency Charts", icon: BarChart3 },
  { id: "diagnostics", label: "Diagnostics", icon: ShieldAlert },
];

const DURATION_PRESETS = [
  { label: "All", ms: 0 },
  { label: ">100ms", ms: 100 },
  { label: ">500ms", ms: 500 },
  { label: ">1s", ms: 1000 },
  { label: ">5s", ms: 5000 },
];

export function MongoFilterBar() {
  const {
    activeView,
    filters,
    operations,
    collections,
    userNames,
    userCount,
    patternCount,
    slowQueryCount,
    collscanCount,
    totalErrors,
  } = useMongoStore(
    useShallow((s) => ({
      activeView: s.activeView,
      filters: s.filters,
      operations: s.result?.operations ?? [],
      collections: s.result?.collections ?? [],
      userNames: s.result?.userNames ?? [],
      userCount: s.result?.users.length ?? 0,
      patternCount: s.result?.patterns.length ?? 0,
      slowQueryCount: s.result?.summary.slowQueryCount ?? 0,
      collscanCount: s.result?.summary.collscanCount ?? 0,
      totalErrors: s.result?.errors.reduce((sum, e) => sum + e.count, 0) ?? 0,
    })),
  );

  const handleOpChange = (op: string) => {
    setOperationFilter(op);
    void reaggregateMongo();
  };

  const handleUserChange = (user: string) => {
    setUserFilter(user);
    void reaggregateMongo();
  };

  const handlePlanChange = (plan: MongoPlanFilter) => {
    setPlanFilter(plan);
    void reaggregateMongo();
  };

  const handleMinDuration = (ms: number) => {
    setMinDurationMs(ms);
    void reaggregateMongo();
  };

  const handleCollectionChange = (coll: string) => {
    setCollectionFilter(coll);
    void reaggregateMongo();
  };

  const handleSearchChange = (val: string) => {
    setSearchQuery(val);
    void reaggregateMongo();
  };

  const handleScanRatioToggle = () => {
    toggleHighScanRatio();
    void reaggregateMongo();
  };

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-3.5 shadow-xs dark:border-slate-800 dark:bg-slate-900">
      {/* Top row: View tabs & Search */}
      <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-slate-100 pb-3 dark:border-slate-800">
        {/* View Switcher Tabs */}
        <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800/80">
          {VIEW_TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeView === tab.id;
            let badgeText: string | null = null;
            if (tab.id === "patterns") badgeText = formatNum(patternCount);
            if (tab.id === "slow_queries") badgeText = formatNum(slowQueryCount);
            if (tab.id === "users" && userCount > 0) badgeText = formatNum(userCount);
            if (tab.id === "diagnostics" && totalErrors > 0) badgeText = formatNum(totalErrors);

            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveView(tab.id)}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-all",
                  isActive
                    ? "bg-white text-emerald-700 shadow-xs dark:bg-slate-900 dark:text-emerald-400"
                    : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200",
                )}
              >
                <Icon className={cn("size-3.5", isActive ? "text-emerald-600 dark:text-emerald-400" : "text-slate-400")} />
                <span>{tab.label}</span>
                {badgeText && (
                  <span
                    className={cn(
                      "rounded-full px-1.5 py-0.2 text-[10px] font-bold",
                      isActive
                        ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/80 dark:text-emerald-300"
                        : "bg-slate-200/80 text-slate-700 dark:bg-slate-700 dark:text-slate-300",
                    )}
                  >
                    {badgeText}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Search Input */}
        <div className="relative min-w-[240px] flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={filters.searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="Search collection, plan, IP..."
            className="w-full rounded-lg border border-slate-200 bg-slate-50/50 py-1.5 pl-8 pr-7 text-xs text-slate-900 placeholder:text-slate-400 focus:border-emerald-500 focus:bg-white focus:outline-hidden dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-100 dark:placeholder:text-slate-500 dark:focus:bg-slate-900"
          />
          {filters.searchQuery && (
            <button
              type="button"
              onClick={() => handleSearchChange("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              aria-label="Clear search"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Filter Options Row */}
      <div className="flex flex-wrap items-center gap-3 text-xs">
        {/* Plan Filter: COLLSCAN vs IXSCAN */}
        <div className="flex items-center gap-1">
          <span className="text-[11px] font-medium text-slate-400">Plan:</span>
          <button
            type="button"
            data-testid="mongo-filter-plan-all"
            onClick={() => handlePlanChange("all")}
            className={cn(
              "rounded px-2 py-0.5 text-xs font-medium transition-colors",
              filters.planFilter === "all"
                ? "bg-slate-800 text-white dark:bg-slate-200 dark:text-slate-900"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400",
            )}
          >
            All Plans
          </button>
          <button
            type="button"
            data-testid="mongo-filter-plan-collscan"
            onClick={() => handlePlanChange(filters.planFilter === "collscan_only" ? "all" : "collscan_only")}
            className={cn(
              "flex items-center gap-1 rounded px-2 py-0.5 text-xs font-semibold transition-colors",
              filters.planFilter === "collscan_only"
                ? "bg-amber-600 text-white dark:bg-amber-500 dark:text-slate-950"
                : "bg-amber-50 text-amber-700 ring-1 ring-amber-300 hover:bg-amber-100 dark:bg-amber-950/40 dark:text-amber-400 dark:ring-amber-500/30",
            )}
          >
            <Flame className="size-3 text-amber-500" />
            COLLSCAN Only ({collscanCount})
          </button>
          <button
            type="button"
            data-testid="mongo-filter-plan-ixscan"
            onClick={() => handlePlanChange(filters.planFilter === "ixscan_only" ? "all" : "ixscan_only")}
            className={cn(
              "rounded px-2 py-0.5 text-xs font-medium transition-colors",
              filters.planFilter === "ixscan_only"
                ? "bg-emerald-600 text-white dark:bg-emerald-500 dark:text-slate-950"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400",
            )}
          >
            IXSCAN
          </button>
        </div>

        <div className="h-4 w-px bg-slate-200 dark:bg-slate-800" />

        {/* Operation Filter */}
        <div className="flex items-center gap-1">
          <span className="text-[11px] font-medium text-slate-400">Op:</span>
          <select
            value={filters.operation}
            onChange={(e) => handleOpChange(e.target.value)}
            className="rounded border border-slate-200 bg-white px-2 py-0.5 text-xs text-slate-800 focus:border-emerald-500 focus:outline-hidden dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
          >
            <option value="all">All Operations</option>
            {operations.map((op) => (
              <option key={op} value={op}>
                {op}
              </option>
            ))}
          </select>
        </div>

        {/* Collection Filter */}
        {collections.length > 0 && (
          <div className="flex items-center gap-1">
            <span className="text-[11px] font-medium text-slate-400">Collection:</span>
            <select
              value={filters.collection}
              onChange={(e) => handleCollectionChange(e.target.value)}
              className="max-w-[180px] truncate rounded border border-slate-200 bg-white px-2 py-0.5 text-xs text-slate-800 focus:border-emerald-500 focus:outline-hidden dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
            >
              <option value="all">All Collections ({collections.length})</option>
              {collections.map((c) => (
                <option key={c.ns} value={c.ns}>
                  {c.collection} ({c.queryCount})
                </option>
              ))}
            </select>
          </div>
        )}

        {/* User Filter */}
        {userNames.length > 0 && (
          <div className="flex items-center gap-1">
            <span className="text-[11px] font-medium text-slate-400">User:</span>
            <select
              value={filters.userFilter}
              onChange={(e) => handleUserChange(e.target.value)}
              className={cn(
                "max-w-[170px] truncate rounded border px-2 py-0.5 text-xs focus:outline-hidden",
                filters.userFilter !== "all"
                  ? "border-emerald-500 bg-emerald-50 font-semibold text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300"
                  : "border-slate-200 bg-white text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200",
              )}
            >
              <option value="all">All Users ({userNames.length})</option>
              {userNames.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="h-4 w-px bg-slate-200 dark:bg-slate-800" />

        {/* Min Duration Presets */}
        <div className="flex items-center gap-1">
          <span className="text-[11px] font-medium text-slate-400">Duration:</span>
          {DURATION_PRESETS.map((preset) => (
            <button
              key={preset.ms}
              type="button"
              data-testid={`mongo-filter-duration-${preset.ms}`}
              onClick={() => handleMinDuration(preset.ms)}
              className={cn(
                "rounded px-2 py-0.5 text-xs font-medium transition-colors",
                filters.minDurationMs === preset.ms
                  ? "bg-slate-800 text-white dark:bg-slate-200 dark:text-slate-900"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400",
              )}
            >
              {preset.label}
            </button>
          ))}
        </div>

        {/* Scan Ratio Filter */}
        <button
          type="button"
          onClick={handleScanRatioToggle}
          className={cn(
            "flex items-center gap-1 rounded border px-2 py-0.5 text-xs font-medium transition-colors",
            filters.highScanRatioOnly
              ? "border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-600 dark:bg-rose-950/40 dark:text-rose-300"
              : "border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800",
          )}
        >
          <Filter className="size-3" />
          Scan Ratio &gt;100x
        </button>
      </div>
    </div>
  );
}
