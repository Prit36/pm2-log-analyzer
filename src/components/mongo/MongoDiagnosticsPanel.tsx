import { Database, Network, ShieldAlert, Timer } from "lucide-react";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useMongoStore } from "../../store/mongoStore";
import { formatMs, formatNum } from "../../utils/format";
import { cn } from "../../utils/cn";

type DiagTab = "errors" | "connections" | "collections" | "checkpoints";

export function MongoDiagnosticsPanel() {
  const [activeTab, setActiveTab] = useState<DiagTab>("errors");

  const { errors, connections, collections, checkpoints } = useMongoStore(
    useShallow((s) => ({
      errors: s.result?.errors ?? [],
      connections: s.result?.connections,
      collections: s.result?.collections ?? [],
      checkpoints: s.result?.checkpoints ?? [],
    })),
  );

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-xs dark:border-slate-800 dark:bg-slate-900">
      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b border-slate-100 pb-3 dark:border-slate-800">
        <button
          type="button"
          onClick={() => setActiveTab("errors")}
          className={cn(
            "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
            activeTab === "errors"
              ? "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300"
              : "text-slate-600 hover:text-slate-900 dark:text-slate-400",
          )}
        >
          <ShieldAlert className="size-3.5" />
          <span>Errors &amp; Warnings ({errors.length})</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("connections")}
          className={cn(
            "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
            activeTab === "connections"
              ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300"
              : "text-slate-600 hover:text-slate-900 dark:text-slate-400",
          )}
        >
          <Network className="size-3.5" />
          <span>Connection Pool &amp; Drivers</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("collections")}
          className={cn(
            "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
            activeTab === "collections"
              ? "bg-purple-100 text-purple-800 dark:bg-purple-950/60 dark:text-purple-300"
              : "text-slate-600 hover:text-slate-900 dark:text-slate-400",
          )}
        >
          <Database className="size-3.5" />
          <span>Collections Summary ({collections.length})</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("checkpoints")}
          className={cn(
            "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
            activeTab === "checkpoints"
              ? "bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300"
              : "text-slate-600 hover:text-slate-900 dark:text-slate-400",
          )}
        >
          <Timer className="size-3.5" />
          <span>Checkpoints ({checkpoints.length})</span>
        </button>
      </div>

      {/* Tab Content */}
      <div className="pt-1 text-xs">
        {activeTab === "errors" && (
          <div className="space-y-2">
            {errors.length === 0 ? (
              <p className="py-6 text-center text-slate-500">No engine warnings or errors recorded.</p>
            ) : (
              errors.map((e, idx) => (
                <div
                  key={`${e.severity}-${e.id}-${idx}`}
                  className="flex items-start justify-between gap-3 rounded-lg border border-slate-100 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-slate-800/40"
                >
                  <div className="flex items-start gap-2.5">
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5 text-[10px] font-bold uppercase",
                        e.severity === "E" || e.severity === "F"
                          ? "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300"
                          : "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
                      )}
                    >
                      {e.severity}
                    </span>
                    <div>
                      <p className="font-semibold text-slate-800 dark:text-slate-200">{e.msg}</p>
                      <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-500">
                        <span>Component: {e.component}</span>
                        {e.id && <span>· ID: {e.id}</span>}
                        <span>· {e.timestamp}</span>
                      </div>
                    </div>
                  </div>
                  <span className="shrink-0 rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-bold text-slate-700 dark:bg-slate-700 dark:text-slate-300">
                    {e.count}x
                  </span>
                </div>
              ))
            )}
          </div>
        )}

        {activeTab === "connections" && connections && (
          <div className="space-y-4">
            {/* Connection stats cards */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-lg border border-slate-100 bg-slate-50/60 p-3 dark:border-slate-800 dark:bg-slate-800/40">
                <span className="text-slate-500">Accepted Connections</span>
                <p className="mt-1 text-lg font-bold text-slate-900 dark:text-slate-100">
                  {formatNum(connections.accepted)}
                </p>
              </div>
              <div className="rounded-lg border border-slate-100 bg-slate-50/60 p-3 dark:border-slate-800 dark:bg-slate-800/40">
                <span className="text-slate-500">Closed Connections</span>
                <p className="mt-1 text-lg font-bold text-slate-900 dark:text-slate-100">
                  {formatNum(connections.ended)}
                </p>
              </div>
              <div className="rounded-lg border border-slate-100 bg-slate-50/60 p-3 dark:border-slate-800 dark:bg-slate-800/40">
                <span className="text-slate-500">Peak Concurrent</span>
                <p className="mt-1 text-lg font-bold text-emerald-600 dark:text-emerald-400">
                  {formatNum(connections.peakConcurrent)}
                </p>
              </div>
              <div className="rounded-lg border border-slate-100 bg-slate-50/60 p-3 dark:border-slate-800 dark:bg-slate-800/40">
                <span className="text-slate-500">Auth Success / Fail</span>
                <p className="mt-1 text-lg font-bold text-slate-900 dark:text-slate-100">
                  {formatNum(connections.authSuccess)} / {formatNum(connections.authFailed)}
                </p>
              </div>
            </div>

            {/* Client Drivers Detected */}
            {connections.drivers.length > 0 && (
              <div>
                <h4 className="mb-2 font-semibold text-slate-800 dark:text-slate-200">
                  Detected Client Drivers &amp; Frameworks
                </h4>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {connections.drivers.map((d, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50/70 p-2.5 dark:border-slate-800 dark:bg-slate-800/40"
                    >
                      <div>
                        <span className="font-semibold text-slate-900 dark:text-slate-100">
                          {d.driverName} ({d.driverVersion})
                        </span>
                        <p className="text-[11px] text-slate-500">
                          {d.platform} · {d.osName} {d.osVersion}
                        </p>
                      </div>
                      <span className="rounded bg-slate-200 px-2 py-0.5 text-[10px] font-bold text-slate-700 dark:bg-slate-700 dark:text-slate-300">
                        {d.count} conns
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Top Remote IPs */}
            {connections.clientIps.length > 0 && (
              <div>
                <h4 className="mb-2 font-semibold text-slate-800 dark:text-slate-200">
                  Active Client IP Addresses
                </h4>
                <div className="flex flex-wrap gap-2">
                  {connections.clientIps.slice(0, 12).map((c, i) => (
                    <span
                      key={i}
                      className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1 font-mono text-[11px] text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
                    >
                      <span>{c.ip}</span>
                      <span className="rounded bg-slate-100 px-1 text-[10px] font-bold text-slate-500 dark:bg-slate-700">
                        {c.count}
                      </span>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === "collections" && (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-slate-200 text-[11px] font-semibold text-slate-500 dark:border-slate-800">
                  <th className="py-2">Collection</th>
                  <th className="py-2 text-right">Queries</th>
                  <th className="py-2 text-right">Total Time</th>
                  <th className="py-2 text-right">Avg</th>
                  <th className="py-2 text-right">P95</th>
                  <th className="py-2 text-right">Max</th>
                  <th className="py-2 text-right">COLLSCANs</th>
                  <th className="py-2 text-right">Docs Examined</th>
                  <th className="py-2 text-right">Scan Ratio</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {collections.map((c) => (
                  <tr key={c.ns} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/40">
                    <td className="py-2 font-semibold text-slate-900 dark:text-slate-100" title={c.ns}>
                      {c.collection}
                    </td>
                    <td className="py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">
                      {formatNum(c.queryCount)}
                    </td>
                    <td className="py-2 text-right font-bold tabular-nums text-slate-900 dark:text-slate-100">
                      {(c.totalDurationMs / 1000).toFixed(1)}s
                    </td>
                    <td className="py-2 text-right tabular-nums text-slate-600 dark:text-slate-400">
                      {formatMs(c.avgDurationMs)}
                    </td>
                    <td className="py-2 text-right font-semibold tabular-nums text-blue-600 dark:text-blue-400">
                      {formatMs(c.p95DurationMs)}
                    </td>
                    <td className="py-2 text-right font-semibold tabular-nums text-rose-600 dark:text-rose-400">
                      {formatMs(c.maxDurationMs)}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {c.collscanCount > 0 ? (
                        <span className="font-semibold text-amber-600 dark:text-amber-400">
                          {c.collscanCount}
                        </span>
                      ) : (
                        <span className="text-slate-400">0</span>
                      )}
                    </td>
                    <td className="py-2 text-right tabular-nums text-slate-600 dark:text-slate-400">
                      {formatNum(c.totalDocsExamined)}
                    </td>
                    <td className="py-2 text-right tabular-nums font-medium text-slate-600 dark:text-slate-400">
                      {c.scanRatio}x
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {activeTab === "checkpoints" && (
          <div className="space-y-2">
            {checkpoints.length === 0 ? (
              <p className="py-6 text-center text-slate-500">No checkpoint events recorded.</p>
            ) : (
              checkpoints.map((cp, idx) => (
                <div
                  key={idx}
                  className="rounded-lg border border-slate-100 bg-slate-50/60 p-2.5 font-mono text-[11px] dark:border-slate-800 dark:bg-slate-800/40"
                >
                  <span className="text-slate-400">{cp.timestamp}</span>
                  <span className="ml-2 text-slate-700 dark:text-slate-300">{cp.msg}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
