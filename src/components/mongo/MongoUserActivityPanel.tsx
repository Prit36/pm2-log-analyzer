import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  ExternalLink,
  Flame,
  Globe,
  Search,
  ShieldAlert,
  Terminal,
  User,
  UserCheck,
  Users,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useMongoStore } from "../../store/mongoStore";
import { reaggregateMongo } from "../../hooks/useMongoParserWorker";
import type { MongoUserActivity } from "../../mongo/types";
import { cn } from "../../utils/cn";
import { formatMs, formatNum } from "../../utils/format";

const {
  setActiveUserDetail,
  setActiveView,
  setCollectionFilter,
  setUserFilter,
} = useMongoStore.getState();

export function MongoUserActivityPanel() {
  const {
    users,
    activeUserDetail,
    currentFilterUser,
    connections,
  } = useMongoStore(
    useShallow((s) => ({
      users: s.result?.users ?? [],
      activeUserDetail: s.activeUserDetail,
      currentFilterUser: s.filters.userFilter,
      connections: s.result?.connections,
    })),
  );

  const [search, setSearch] = useState("");

  const filteredUsers = useMemo(() => {
    if (!search.trim()) return users;
    const q = search.toLowerCase();
    return users.filter(
      (u) =>
        u.userName.toLowerCase().includes(q) ||
        u.appName.toLowerCase().includes(q) ||
        u.authDb.toLowerCase().includes(q) ||
        u.clientIps.some((ip) => ip.includes(q)),
    );
  }, [users, search]);

  const kpis = useMemo(() => {
    const totalUsers = users.length;
    const namedUsers = users.filter((u) => u.userName !== "system").length;
    const totalAuthSuccess = connections?.authSuccess ?? users.reduce((acc, u) => acc + u.authSuccessCount, 0);
    const totalAuthFail = connections?.authFailed ?? users.reduce((acc, u) => acc + u.authFailCount, 0);
    const totalUserQueries = users.reduce((acc, u) => acc + u.slowQueryCount, 0);
    const topUser = [...users]
      .filter((u) => u.userName !== "system")
      .sort((a, b) => b.slowQueryCount - a.slowQueryCount)[0];

    return {
      totalUsers,
      namedUsers,
      totalAuthSuccess,
      totalAuthFail,
      totalUserQueries,
      topUserName: topUser?.userName ?? "None",
      topUserQueries: topUser?.slowQueryCount ?? 0,
    };
  }, [users, connections]);

  const handleSelectUser = (user: MongoUserActivity) => {
    setActiveUserDetail(user);
  };

  const handleFilterToUser = (userName: string) => {
    const nextUser = currentFilterUser === userName ? "all" : userName;
    setUserFilter(nextUser);
    void reaggregateMongo();
  };

  const handleJumpToUserQueries = (userName: string) => {
    setUserFilter(userName);
    setActiveView("slow_queries");
    void reaggregateMongo();
  };

  const handleFilterToCollection = (collNs: string) => {
    setCollectionFilter(collNs);
    void reaggregateMongo();
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Top Stats Cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3.5 shadow-xs dark:border-slate-800 dark:bg-slate-900">
          <div className="rounded-lg bg-emerald-50 p-2.5 text-emerald-600 dark:bg-emerald-950/60 dark:text-emerald-400">
            <Users className="size-5" />
          </div>
          <div>
            <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Identified Users</div>
            <div className="text-xl font-bold text-slate-900 dark:text-slate-100">
              {kpis.namedUsers}{" "}
              <span className="text-xs font-normal text-slate-400">({kpis.totalUsers} total)</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3.5 shadow-xs dark:border-slate-800 dark:bg-slate-900">
          <div className="rounded-lg bg-blue-50 p-2.5 text-blue-600 dark:bg-blue-950/60 dark:text-blue-400">
            <UserCheck className="size-5" />
          </div>
          <div>
            <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Authenticated Sessions</div>
            <div className="text-xl font-bold text-slate-900 dark:text-slate-100">
              {formatNum(kpis.totalAuthSuccess)}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3.5 shadow-xs dark:border-slate-800 dark:bg-slate-900">
          <div
            className={cn(
              "rounded-lg p-2.5",
              kpis.totalAuthFail > 0
                ? "bg-rose-50 text-rose-600 dark:bg-rose-950/60 dark:text-rose-400"
                : "bg-slate-50 text-slate-400 dark:bg-slate-800 dark:text-slate-500",
            )}
          >
            <ShieldAlert className="size-5" />
          </div>
          <div>
            <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Auth / Security Fails</div>
            <div
              className={cn(
                "text-xl font-bold",
                kpis.totalAuthFail > 0 ? "text-rose-600 dark:text-rose-400" : "text-slate-900 dark:text-slate-100",
              )}
            >
              {formatNum(kpis.totalAuthFail)}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3.5 shadow-xs dark:border-slate-800 dark:bg-slate-900">
          <div className="rounded-lg bg-purple-50 p-2.5 text-purple-600 dark:bg-purple-950/60 dark:text-purple-400">
            <Flame className="size-5" />
          </div>
          <div className="min-w-0">
            <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Top Querying User</div>
            <div className="truncate text-base font-bold text-slate-900 dark:text-slate-100">
              {kpis.topUserName}
            </div>
            <div className="text-[11px] text-slate-400">{formatNum(kpis.topUserQueries)} queries</div>
          </div>
        </div>
      </div>

      {/* Main Master-Detail Split or Table View */}
      <div className="flex flex-col gap-4 lg:flex-row">
        {/* Users Table / List */}
        <div
          className={cn(
            "flex flex-col rounded-xl border border-slate-200 bg-white shadow-xs dark:border-slate-800 dark:bg-slate-900",
            activeUserDetail ? "lg:w-7/12" : "w-full",
          )}
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 p-3.5 dark:border-slate-800">
            <div className="flex items-center gap-2">
              <User className="size-4 text-emerald-600 dark:text-emerald-400" />
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                User Activity Tracking ({users.length})
              </h2>
            </div>

            <div className="relative min-w-[200px]">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter users, IPs, apps..."
                className="w-full rounded-lg border border-slate-200 bg-slate-50/50 py-1 pl-8 pr-7 text-xs text-slate-900 placeholder:text-slate-400 focus:border-emerald-500 focus:bg-white focus:outline-hidden dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-100 dark:placeholder:text-slate-500 dark:focus:bg-slate-900"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                >
                  <X className="size-3" />
                </button>
              )}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/60 font-semibold text-slate-600 dark:border-slate-800 dark:bg-slate-800/50 dark:text-slate-300">
                  <th className="py-2.5 pl-4 pr-3">User &amp; Client</th>
                  <th className="px-3 py-2.5 text-right">Queries</th>
                  <th className="px-3 py-2.5 text-right">COLLSCANs</th>
                  <th className="px-3 py-2.5 text-right">Total Time</th>
                  <th className="px-3 py-2.5 text-right">Avg (P95)</th>
                  <th className="px-3 py-2.5 text-right">Security</th>
                  <th className="py-2.5 pl-3 pr-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                {filteredUsers.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-slate-400">
                      No matching user activities found.
                    </td>
                  </tr>
                ) : (
                  filteredUsers.map((u) => {
                    const isSelected = activeUserDetail?.userName === u.userName;
                    const isFilterActive = currentFilterUser === u.userName;
                    const isSystem = u.userName === "system";

                    return (
                      <tr
                        key={u.userName}
                        onClick={() => handleSelectUser(u)}
                        className={cn(
                          "cursor-pointer transition-colors hover:bg-slate-50/80 dark:hover:bg-slate-800/50",
                          isSelected && "bg-emerald-50/40 dark:bg-emerald-950/20",
                          isFilterActive && "ring-1 ring-inset ring-emerald-500/50",
                        )}
                      >
                        <td className="py-2.5 pl-4 pr-3">
                          <div className="flex items-start gap-2">
                            <div
                              className={cn(
                                "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-bold",
                                isSystem
                                  ? "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
                                  : "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-300",
                              )}
                            >
                              {u.userName.charAt(0).toUpperCase()}
                            </div>
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="font-semibold text-slate-900 dark:text-slate-100">
                                  {u.userName}
                                </span>
                                {isFilterActive && (
                                  <span className="rounded bg-emerald-100 px-1 py-0.2 text-[9px] font-bold text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-300">
                                    FILTERED
                                  </span>
                                )}
                                {u.authDb && (
                                  <span className="rounded bg-slate-100 px-1 py-0.2 text-[9px] text-slate-600 dark:bg-slate-800 dark:text-slate-400">
                                    @{u.authDb}
                                  </span>
                                )}
                              </div>
                              <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-slate-400">
                                {u.appName && <span className="truncate max-w-[120px]">{u.appName}</span>}
                                {u.clientIps.length > 0 && (
                                  <span className="truncate max-w-[130px] font-mono text-[10px]">
                                    {u.clientIps.join(", ")}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                        </td>

                        <td className="px-3 py-2.5 text-right font-medium text-slate-900 dark:text-slate-100">
                          {formatNum(u.slowQueryCount)}
                        </td>

                        <td className="px-3 py-2.5 text-right">
                          {u.collscanCount > 0 ? (
                            <span className="inline-flex items-center gap-0.5 rounded bg-amber-50 px-1.5 py-0.5 font-semibold text-amber-700 dark:bg-amber-950/50 dark:text-amber-400">
                              <Flame className="size-2.5 text-amber-500" />
                              {formatNum(u.collscanCount)}
                            </span>
                          ) : (
                            <span className="text-slate-400">0</span>
                          )}
                        </td>

                        <td className="px-3 py-2.5 text-right font-mono text-slate-700 dark:text-slate-300">
                          {(u.totalDurationMs / 1000).toFixed(1)}s
                        </td>

                        <td className="px-3 py-2.5 text-right text-[11px] text-slate-600 dark:text-slate-400">
                          <span>{formatMs(u.avgDurationMs)}</span>{" "}
                          <span className="text-slate-400">({formatMs(u.p95DurationMs)})</span>
                        </td>

                        <td className="px-3 py-2.5 text-right">
                          {u.authFailCount > 0 ? (
                            <span className="inline-flex items-center gap-1 rounded bg-rose-50 px-1.5 py-0.5 text-[10px] font-bold text-rose-700 dark:bg-rose-950/50 dark:text-rose-400">
                              <AlertTriangle className="size-2.5" />
                              {u.authFailCount} fails
                            </span>
                          ) : u.authSuccessCount > 0 ? (
                            <span className="inline-flex items-center gap-1 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">
                              <CheckCircle2 className="size-2.5" />
                              {u.authSuccessCount} auth
                            </span>
                          ) : (
                            <span className="text-slate-400">-</span>
                          )}
                        </td>

                        <td className="py-2.5 pl-3 pr-4 text-right" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-end gap-1">
                            <button
                              type="button"
                              onClick={() => handleFilterToUser(u.userName)}
                              title={isFilterActive ? "Clear user filter" : `Filter entire view to ${u.userName}`}
                              className={cn(
                                "rounded px-2 py-1 text-[11px] font-medium transition-colors",
                                isFilterActive
                                  ? "bg-emerald-600 text-white dark:bg-emerald-500 dark:text-slate-950"
                                  : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700",
                              )}
                            >
                              {isFilterActive ? "Active" : "Filter"}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleSelectUser(u)}
                              title="Inspect details"
                              className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                            >
                              <ArrowRight className="size-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Selected User Detail Card */}
        {activeUserDetail ? (
          <div className="flex flex-col rounded-xl border border-slate-200 bg-white p-4 shadow-xs dark:border-slate-800 dark:bg-slate-900 lg:w-5/12">
            {/* Header with user details and close button */}
            <div className="flex items-start justify-between border-b border-slate-100 pb-3 dark:border-slate-800">
              <div className="flex items-center gap-2.5">
                <div className="flex size-9 items-center justify-center rounded-xl bg-emerald-600 text-sm font-bold text-white shadow-xs">
                  {activeUserDetail.userName.charAt(0).toUpperCase()}
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">
                    {activeUserDetail.userName}
                  </h3>
                  <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                    {activeUserDetail.authDb && (
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium dark:bg-slate-800">
                        DB: {activeUserDetail.authDb}
                      </span>
                    )}
                    {activeUserDetail.appName && (
                      <span className="flex items-center gap-1 text-[11px]">
                        <Terminal className="size-3" />
                        {activeUserDetail.appName}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => handleFilterToUser(activeUserDetail.userName)}
                  className={cn(
                    "flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-semibold transition-colors",
                    currentFilterUser === activeUserDetail.userName
                      ? "bg-emerald-600 text-white"
                      : "bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/60 dark:text-emerald-300",
                  )}
                >
                  {currentFilterUser === activeUserDetail.userName ? "Filtered" : "Filter View"}
                </button>
                <button
                  type="button"
                  onClick={() => setActiveUserDetail(null)}
                  className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"
                >
                  <X className="size-4" />
                </button>
              </div>
            </div>

            {/* Quick stats grid */}
            <div className="grid grid-cols-2 gap-2.5 py-3 text-xs sm:grid-cols-4">
              <div className="rounded-lg bg-slate-50 p-2.5 dark:bg-slate-800/50">
                <div className="text-[10px] text-slate-400">DB Time</div>
                <div className="text-sm font-bold text-slate-900 dark:text-slate-100">
                  {(activeUserDetail.totalDurationMs / 1000).toFixed(2)}s
                </div>
                <div className="text-[10px] text-slate-400">Avg {formatMs(activeUserDetail.avgDurationMs)}</div>
              </div>

              <div className="rounded-lg bg-slate-50 p-2.5 dark:bg-slate-800/50">
                <div className="text-[10px] text-slate-400">Queries</div>
                <div className="text-sm font-bold text-slate-900 dark:text-slate-100">
                  {formatNum(activeUserDetail.slowQueryCount)}
                </div>
                <div className="text-[10px] text-slate-400">P95 {formatMs(activeUserDetail.p95DurationMs)}</div>
              </div>

              <div className="rounded-lg bg-slate-50 p-2.5 dark:bg-slate-800/50">
                <div className="text-[10px] text-slate-400">COLLSCANs</div>
                <div className="text-sm font-bold text-amber-600 dark:text-amber-400">
                  {formatNum(activeUserDetail.collscanCount)}
                </div>
                <div className="text-[10px] text-slate-400">
                  {activeUserDetail.slowQueryCount > 0
                    ? `${Math.round((activeUserDetail.collscanCount / activeUserDetail.slowQueryCount) * 100)}% unindexed`
                    : "0%"}
                </div>
              </div>

              <div className="rounded-lg bg-slate-50 p-2.5 dark:bg-slate-800/50">
                <div className="text-[10px] text-slate-400">Scan Ratio</div>
                <div className="text-sm font-bold text-slate-900 dark:text-slate-100">
                  {activeUserDetail.scanRatio.toFixed(1)}x
                </div>
                <div className="text-[10px] text-slate-400">
                  {formatNum(activeUserDetail.totalDocsExamined)} docs
                </div>
              </div>
            </div>

            {/* Network & Timestamps Info */}
            <div className="space-y-1.5 rounded-lg border border-slate-100 bg-slate-50/50 p-3 text-xs dark:border-slate-800 dark:bg-slate-800/30">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1 text-slate-500 dark:text-slate-400">
                  <Globe className="size-3" /> Client IP Addresses:
                </span>
                <span className="font-mono text-slate-800 dark:text-slate-200">
                  {activeUserDetail.clientIps.join(", ") || "Unknown"}
                </span>
              </div>

              {activeUserDetail.firstActive && (
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1 text-slate-500 dark:text-slate-400">
                    <Clock className="size-3" /> First Activity:
                  </span>
                  <span className="font-mono text-slate-800 dark:text-slate-200">
                    {activeUserDetail.firstActive}
                  </span>
                </div>
              )}

              {activeUserDetail.lastActive && (
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1 text-slate-500 dark:text-slate-400">
                    <Clock className="size-3" /> Last Activity:
                  </span>
                  <span className="font-mono text-slate-800 dark:text-slate-200">
                    {activeUserDetail.lastActive}
                  </span>
                </div>
              )}

              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1 text-slate-500 dark:text-slate-400">
                  <ShieldAlert className="size-3" /> Auth Audit:
                </span>
                <span className="text-slate-800 dark:text-slate-200">
                  <span className="text-emerald-600 font-semibold">{activeUserDetail.authSuccessCount} succeeded</span>
                  {activeUserDetail.authFailCount > 0 && (
                    <span className="text-rose-600 font-bold ml-2">
                      ({activeUserDetail.authFailCount} authorization failures)
                    </span>
                  )}
                </span>
              </div>
            </div>

            {/* Operations Breakdown */}
            <div className="mt-3">
              <h4 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-400">
                Executed Operations
              </h4>
              <div className="grid grid-cols-2 gap-2 text-xs">
                {Object.entries(activeUserDetail.operations).map(([opName, count]) => {
                  const pct =
                    activeUserDetail.slowQueryCount > 0
                      ? Math.round((count / activeUserDetail.slowQueryCount) * 100)
                      : 0;
                  return (
                    <div
                      key={opName}
                      className="flex items-center justify-between rounded-lg border border-slate-100 bg-white p-2 dark:border-slate-800 dark:bg-slate-800/40"
                    >
                      <span className="font-semibold text-slate-800 dark:text-slate-200">{opName}</span>
                      <span className="text-slate-500 dark:text-slate-400">
                        {formatNum(count)} <span className="text-[10px]">({pct}%)</span>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Top Collections Touched */}
            <div className="mt-3 flex-1 overflow-hidden">
              <div className="mb-2 flex items-center justify-between">
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">
                  Collections Touched ({activeUserDetail.topCollections.length})
                </h4>
              </div>

              <div className="max-h-[220px] overflow-y-auto rounded-lg border border-slate-100 dark:border-slate-800">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50/70 text-[10px] font-semibold text-slate-500 dark:bg-slate-800/60">
                    <tr>
                      <th className="py-1.5 pl-2.5 pr-2">Collection</th>
                      <th className="px-2 py-1.5 text-right">Queries</th>
                      <th className="px-2 py-1.5 text-right">Time</th>
                      <th className="px-2 py-1.5 text-right">COLLSCAN</th>
                      <th className="py-1.5 pl-2 pr-2.5 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800/40">
                    {activeUserDetail.topCollections.map((c) => (
                      <tr key={c.ns} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40">
                        <td className="py-1.5 pl-2.5 pr-2 font-mono text-[11px] text-slate-800 dark:text-slate-200">
                          {c.ns}
                        </td>
                        <td className="px-2 py-1.5 text-right font-medium text-slate-900 dark:text-slate-100">
                          {c.count}
                        </td>
                        <td className="px-2 py-1.5 text-right text-slate-600 dark:text-slate-400">
                          {(c.totalDurationMs / 1000).toFixed(1)}s
                        </td>
                        <td className="px-2 py-1.5 text-right">
                          {c.collscanCount > 0 ? (
                            <span className="font-semibold text-amber-600 dark:text-amber-400">
                              {c.collscanCount}
                            </span>
                          ) : (
                            <span className="text-slate-400">0</span>
                          )}
                        </td>
                        <td className="py-1.5 pl-2 pr-2.5 text-right">
                          <button
                            type="button"
                            onClick={() => handleFilterToCollection(c.ns)}
                            className="text-[10px] text-emerald-600 hover:underline dark:text-emerald-400"
                          >
                            Filter
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Bottom Actions */}
            <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3 dark:border-slate-800">
              <button
                type="button"
                onClick={() => handleJumpToUserQueries(activeUserDetail.userName)}
                className="flex items-center gap-1.5 text-xs font-semibold text-emerald-600 hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-300"
              >
                <span>View {activeUserDetail.slowQueryCount} queries in Slow Query Log</span>
                <ExternalLink className="size-3.5" />
              </button>
            </div>
          </div>
        ) : (
          <div className="hidden flex-col items-center justify-center rounded-xl border border-dashed border-slate-200 p-8 text-center text-slate-400 dark:border-slate-800 lg:flex lg:w-5/12">
            <User className="size-10 text-slate-300 dark:text-slate-700 mb-2" />
            <div className="font-medium text-slate-600 dark:text-slate-300">Select a User to Inspect</div>
            <p className="mt-1 max-w-xs text-xs">
              Click on any user in the table to review their executed queries, affected collections, client applications, and security authorization logs.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
