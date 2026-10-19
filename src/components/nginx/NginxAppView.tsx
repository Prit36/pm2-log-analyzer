import { AlertTriangle, Info } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useNginxStore } from "../../store/nginxStore";
import type { NginxResult } from "../../nginx/types";
import { formatNum } from "../../utils/format";
import { cn } from "../../utils/cn";
import { NginxIngestPanel } from "./NginxIngestPanel";
import { NginxFilterBar } from "./NginxFilterBar";
import { NginxEndpointTable } from "./NginxEndpointTable";
import { NginxBreakdownTable, NginxTopList } from "./NginxBreakdowns";
import { NginxStatusCard, NginxTimelineChart, NginxTrafficView } from "./NginxTraffic";
import { percent } from "./nginxUi";
import {
  NginxFailingPanel,
  NginxKpiRow,
  NginxLatencyProfile,
  NginxSlowestPanel,
} from "./NginxOverview";

function Diagnostics({ result }: { result: NginxResult }) {
  const d = result.diagnostics;
  const warn = d.unmatchedCount > 0 || d.invalidTimingCount > 0;
  return (
    <details
      className={cn(
        "rounded-lg border px-4 py-2.5 text-xs",
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
  const total = result.summary.count;
  return (
    <>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <NginxTimelineChart result={result} metric={metric} />
        </div>
        <NginxStatusCard result={result} />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <NginxSlowestPanel result={result} metric={metric} />
        <NginxFailingPanel result={result} />
        <NginxLatencyProfile result={result} />
      </div>
      <NginxEndpointTable result={result} metric={metric} />
      <div className="grid gap-4 md:grid-cols-3">
        <NginxTopList
          title="Top clients"
          rows={result.clients}
          distinct={result.clientCount}
          total={total}
          view="clients"
        />
        <NginxTopList
          title="Top user agents"
          rows={result.userAgents}
          distinct={result.userAgentCount}
          total={total}
          view="userAgents"
        />
        <NginxTopList
          title="Top referrers"
          rows={result.referrers}
          distinct={result.referrerCount}
          total={total}
          view="referrers"
        />
      </div>
    </>
  );
}

export function NginxAppView() {
  const { result, activeView, metric } = useNginxStore(
    useShallow((s) => ({ result: s.result, activeView: s.activeView, metric: s.filters.metric })),
  );
  return (
    <div className="flex flex-col gap-4">
      <NginxIngestPanel />
      {result && (
        <>
          <NginxKpiRow result={result} />
          <NginxFilterBar />
          {activeView === "endpoints" && <Overview result={result} metric={metric} />}
          {activeView === "traffic" && <NginxTrafficView result={result} metric={metric} />}
          {activeView === "clients" && (
            <NginxBreakdownTable
              title="Clients"
              rows={result.clients}
              distinct={result.clientCount}
              total={result.summary.count}
            />
          )}
          {activeView === "referrers" && (
            <NginxBreakdownTable
              title="Referrers"
              rows={result.referrers}
              distinct={result.referrerCount}
              total={result.summary.count}
            />
          )}
          {activeView === "userAgents" && (
            <NginxBreakdownTable
              title="User agents"
              rows={result.userAgents}
              distinct={result.userAgentCount}
              total={result.summary.count}
            />
          )}
          <Diagnostics result={result} />
        </>
      )}
      <footer className="pb-6 pt-2 text-center text-[11px] text-slate-400">
        Nginx combined access logs · Parses locally · Logs never leave this machine
      </footer>
    </div>
  );
}
