import { AlertTriangle, Info } from "lucide-react";
import { lazy, Suspense } from "react";
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

function Overview({ result, metric }: { result: NginxResult; metric: "request" | "upstream" }) {
  if (result.summary.count === 0) return <NginxEndpointTable result={result} metric={metric} />;
  const hasSlowest = result.slowestEndpoints.length > 0;
  const hasErrors = result.failingEndpoints.length > 0;
  const timed =
    (metric === "request" ? result.summary.requestTime : result.summary.upstreamTime).count > 0;
  return (
    <div
      className={cn(
        "grid items-start gap-3",
        !timed && "lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]",
      )}
    >
      <div className="min-w-0">
        <NginxEndpointTable result={result} metric={metric} />
      </div>
      <div className={cn("grid min-w-0 items-start gap-3", timed && "lg:grid-cols-2")}>
        <NginxTimelineChart result={result} metric={metric} height={200} />
        {hasErrors && <NginxFailingPanel result={result} />}
        {hasSlowest && <NginxSlowestPanel result={result} metric={metric} />}
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
