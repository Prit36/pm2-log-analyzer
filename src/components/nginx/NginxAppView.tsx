import { AlertTriangle, Info } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useNginxStore } from "../../store/nginxStore";
import type { NginxResult } from "../../nginx/types";
import { formatNum } from "../../utils/format";
import { cn } from "../../utils/cn";
import { NginxIngestPanel } from "./NginxIngestPanel";
import { NginxEmptyState } from "./NginxEmptyState";
import { NginxFilterBar } from "./NginxFilterBar";
import { NginxEndpointTable } from "./NginxEndpointTable";
import { NginxReferrersView, NginxUserAgentsView } from "./NginxBreakdowns";
import { NginxTimelineChart, NginxTrafficView } from "./NginxTraffic";
import { percent } from "./nginxUi";
import { NginxFailingPanel, NginxKpiRow, NginxSlowestPanel } from "./NginxOverview";

const NginxClientsView = lazy(() => import("./NginxClientsView"));

function Diagnostics({ result }: { result: NginxResult }) {
  const d = result.diagnostics;
  const warn = d.unmatchedCount > 0 || d.invalidTimingCount > 0;
  return (
    <details
      className={cn(
        "rounded-lg border px-3 py-2 text-xs",
        warn
          ? "border-amber-200 bg-amber-50/60 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-300"
          : "border-slate-200 text-slate-500 dark:border-slate-800 dark:text-slate-400",
      )}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
        {warn ? (
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
        ) : (
          <Info className="size-3.5 shrink-0" aria-hidden />
        )}
        <span>
          Parsed {formatNum(d.matchedLines)} of {formatNum(d.totalLines)} lines (
          {percent(d.matchedLines, d.totalLines)})
          {d.unmatchedCount > 0 && ` · ${formatNum(d.unmatchedCount)} unrecognized`}
          {d.invalidTimingCount > 0 && ` · ${formatNum(d.invalidTimingCount)} invalid timings`}
        </span>
      </summary>
      <p className="mt-2">
        Expects the combined log format with optional rt= / urt= fields. Missing timings are
        unavailable; zero is a valid measurement. Referrers and user agents keep the logged values.
      </p>
      {d.unmatchedSample.length > 0 && (
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded bg-white/70 p-2 font-mono-data text-[11px] dark:bg-slate-950/50">
          {d.unmatchedSample.join("\n")}
        </pre>
      )}
    </details>
  );
}

type SideTab = "time" | "errors" | "slowest";

function SidePanel({ result, metric }: { result: NginxResult; metric: "request" | "upstream" }) {
  const [selected, setSelected] = useState<SideTab>("time");
  const tabs: { key: SideTab; label: string }[] = [
    { key: "time", label: "Over time" },
    ...(result.failingEndpoints.length > 0
      ? [{ key: "errors" as const, label: "Most errors" }]
      : []),
    ...(result.slowestEndpoints.length > 0 ? [{ key: "slowest" as const, label: "Slowest" }] : []),
  ];
  const tab = tabs.some((item) => item.key === selected) ? selected : "time";
  const strip = (
    <div
      role="tablist"
      aria-label="Overview panels"
      className="flex items-center gap-1 rounded bg-slate-100 p-0.5 text-xs dark:bg-slate-950"
    >
      {tabs.map((item) => (
        <button
          key={item.key}
          type="button"
          role="tab"
          aria-selected={tab === item.key}
          onClick={() => setSelected(item.key)}
          className={cn(
            "whitespace-nowrap rounded px-2 py-1 font-medium transition-colors",
            tab === item.key
              ? "bg-white text-violet-700 shadow-xs dark:bg-violet-600 dark:text-white"
              : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200",
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
  if (tab === "errors") return <NginxFailingPanel result={result} title={strip} />;
  if (tab === "slowest") return <NginxSlowestPanel result={result} metric={metric} title={strip} />;
  return <NginxTimelineChart result={result} metric={metric} height={300} title={strip} />;
}

function Overview({ result, metric }: { result: NginxResult; metric: "request" | "upstream" }) {
  if (result.summary.count === 0) return <NginxEndpointTable result={result} metric={metric} />;
  return (
    <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="min-w-0">
        <NginxEndpointTable result={result} metric={metric} />
      </div>
      <div className="min-w-0">
        <SidePanel result={result} metric={metric} />
      </div>
    </div>
  );
}

export function NginxAppView() {
  const { result, activeView, metric, isParsing } = useNginxStore(
    useShallow((s) => ({
      result: s.result,
      activeView: s.activeView,
      metric: s.filters.metric,
      isParsing: s.isParsing,
    })),
  );
  return (
    <div className="flex flex-col gap-3">
      <NginxIngestPanel />
      {!result && !isParsing && <NginxEmptyState />}
      {result && (
        <>
          <NginxKpiRow result={result} />
          <NginxFilterBar />
          {activeView === "endpoints" && <Overview result={result} metric={metric} />}
          {activeView === "traffic" && <NginxTrafficView result={result} metric={metric} />}
          {activeView === "clients" && (
            <Suspense fallback={<p className="p-4 text-xs text-slate-500">Loading clients…</p>}>
              <NginxClientsView result={result} />
            </Suspense>
          )}
          {activeView === "referrers" && <NginxReferrersView result={result} />}
          {activeView === "userAgents" && <NginxUserAgentsView result={result} />}
          <Diagnostics result={result} />
        </>
      )}
      <footer className="pb-6 pt-2 text-center text-[11px] text-slate-400">
        Nginx combined access logs · Parsed locally · The Clients tab sends public client IPs to
        country.is for location lookups
      </footer>
    </div>
  );
}
