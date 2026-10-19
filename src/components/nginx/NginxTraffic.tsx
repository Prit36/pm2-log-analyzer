import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useShallow } from "zustand/react/shallow";
import { useAnalysisStore } from "../../store/analysisStore";
import { useNginxStore } from "../../store/nginxStore";
import type { NginxMetric, NginxResult, NginxTimeBucket } from "../../nginx/types";
import type { StatusFamily } from "../../parser";
import { formatBytes, formatNum } from "../../utils/format";
import { cn } from "../../utils/cn";
import { filterNginxStatusCode, updateNginxFilters } from "./NginxFilterBar";
import { NginxLatencyProfile } from "./NginxOverview";
import {
  bucketLabelFormatter,
  compactBytes,
  compactNum,
  latency,
  mutedClass,
  panelClass,
  panelTitleClass,
  percent,
  statusTone,
  toneColor,
  toneLabel,
  type StatusTone,
} from "./nginxUi";

type Granularity = "hourly" | "daily";
const statusText = new Map([
  [200, "OK"],
  [201, "Created"],
  [204, "No Content"],
  [206, "Partial Content"],
  [301, "Moved Permanently"],
  [302, "Found"],
  [304, "Not Modified"],
  [307, "Temporary Redirect"],
  [308, "Permanent Redirect"],
  [400, "Bad Request"],
  [401, "Unauthorized"],
  [403, "Forbidden"],
  [404, "Not Found"],
  [405, "Method Not Allowed"],
  [408, "Request Timeout"],
  [409, "Conflict"],
  [413, "Payload Too Large"],
  [414, "URI Too Long"],
  [415, "Unsupported Media Type"],
  [422, "Unprocessable Content"],
  [429, "Too Many Requests"],
  [444, "No Response (nginx)"],
  [494, "Header Too Large (nginx)"],
  [495, "SSL Cert Error (nginx)"],
  [496, "No SSL Cert (nginx)"],
  [497, "HTTP to HTTPS (nginx)"],
  [499, "Client Closed (nginx)"],
  [500, "Internal Server Error"],
  [501, "Not Implemented"],
  [502, "Bad Gateway"],
  [503, "Service Unavailable"],
  [504, "Gateway Timeout"],
]);
const toneOrder: StatusTone[] = ["ok", "redirect", "client", "server", "other"];
const familyOf = {
  ok: "2xx",
  redirect: "3xx",
  client: "4xx",
  server: "5xx",
  other: "all",
} satisfies Record<StatusTone, StatusFamily>;

function useChartTheme() {
  const isDark = useAnalysisStore((s) => s.theme === "dark");
  const grid = isDark ? "#1e293b" : "#e2e8f0";
  return {
    tick: { fontSize: 10, fill: isDark ? "#94a3b8" : "#64748b" },
    grid,
    tooltip: {
      fontSize: 12,
      backgroundColor: isDark ? "#0f172a" : "#fff",
      color: isDark ? "#e2e8f0" : "#334155",
      border: `1px solid ${grid}`,
      borderRadius: 6,
    },
  };
}

function bucketTime(bucket: NginxTimeBucket, metric: NginxMetric) {
  return metric === "request" ? bucket.requestTime : bucket.upstreamTime;
}

function GranularityToggle({
  value,
  onChange,
}: {
  value: Granularity;
  onChange: (value: Granularity) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Traffic interval"
      className="inline-flex rounded-md bg-slate-100 p-0.5 dark:bg-slate-800"
    >
      {(["hourly", "daily"] as const).map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          onClick={() => onChange(option)}
          className={cn(
            "rounded px-2 py-0.5 text-[11px] font-medium capitalize text-slate-600 dark:text-slate-400",
            value === option &&
              "bg-white text-violet-700 shadow-xs dark:bg-slate-950 dark:text-violet-300",
          )}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

function useBuckets(result: NginxResult) {
  const [granularity, setGranularity] = useState<Granularity>("hourly");
  const canDaily = result.dailyStats.length > 1;
  const buckets = granularity === "daily" && canDaily ? result.dailyStats : result.hourlyStats;
  const formatLabel = useMemo(
    () => bucketLabelFormatter(buckets.map((bucket) => bucket.label)),
    [buckets],
  );
  const toggle = canDaily ? (
    <GranularityToggle value={granularity} onChange={setGranularity} />
  ) : null;
  return { buckets, formatLabel, toggle };
}

/** Requests split into successful vs 4xx/5xx bars, with p95 latency on a second axis. */
export function NginxTimelineChart({
  result,
  metric,
  height = 220,
  shared,
}: {
  result: NginxResult;
  metric: NginxMetric;
  height?: number;
  shared?: ReturnType<typeof useBuckets>;
}) {
  const theme = useChartTheme();
  const own = useBuckets(result);
  const { buckets, formatLabel, toggle } = shared ?? own;
  const measured =
    metric === "request" ? result.summary.requestTime.count : result.summary.upstreamTime.count;
  const data = useMemo(
    () =>
      buckets.map((bucket) => ({
        label: bucket.label,
        OK: bucket.count - bucket.errorCount,
        Errors: bucket.errorCount,
        p95: bucketTime(bucket, metric).p95Ms,
      })),
    [buckets, metric],
  );
  return (
    <section className={panelClass}>
      <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2 dark:border-slate-800">
        <h2 className={panelTitleClass}>Requests over time</h2>
        {toggle}
      </div>
      <div className="p-3" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={theme.grid} strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="label"
              tick={theme.tick}
              tickFormatter={formatLabel}
              minTickGap={24}
              tickLine={false}
            />
            <YAxis
              yAxisId="count"
              width={44}
              tick={theme.tick}
              tickFormatter={compactNum}
              axisLine={false}
              tickLine={false}
            />
            {measured > 0 && (
              <YAxis
                yAxisId="ms"
                orientation="right"
                width={52}
                tick={theme.tick}
                tickFormatter={(value: number) => latency(value)}
                axisLine={false}
                tickLine={false}
              />
            )}
            <Tooltip
              contentStyle={theme.tooltip}
              labelFormatter={(label) => String(label)}
              formatter={(value, name) =>
                name === "p95" ? latency(Number(value)) : formatNum(Number(value))
              }
            />
            <Legend wrapperStyle={{ fontSize: 11 }} iconSize={10} />
            <Bar
              yAxisId="count"
              dataKey="OK"
              stackId="requests"
              fill="#8b5cf6"
              isAnimationActive={false}
            />
            <Bar
              yAxisId="count"
              dataKey="Errors"
              stackId="requests"
              fill="#f43f5e"
              isAnimationActive={false}
            />
            {measured > 0 && (
              <Line
                yAxisId="ms"
                dataKey="p95"
                stroke="#f59e0b"
                strokeWidth={2}
                dot={false}
                connectNulls
                isAnimationActive={false}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

/** HTTP status mix; clicking a family applies it as the status filter. */
export function NginxStatusCard({ result }: { result: NginxResult }) {
  const { statusFamily, statusCode, isParsing } = useNginxStore(
    useShallow((s) => ({
      statusFamily: s.filters.statusFamily,
      statusCode: s.filters.statusCode,
      isParsing: s.isParsing,
    })),
  );
  const [showAll, setShowAll] = useState(false);
  const total = result.summary.count;
  const families = useMemo(() => {
    const sums = new Map<StatusTone, number>();
    for (const row of result.statusCounts) {
      const tone = statusTone(row.status);
      sums.set(tone, (sums.get(tone) ?? 0) + row.count);
    }
    return toneOrder.flatMap((tone) => {
      const count = sums.get(tone);
      return count ? [[tone, count] as const] : [];
    });
  }, [result.statusCounts]);
  const codes = useMemo(
    () => [...result.statusCounts].sort((a, b) => b.count - a.count),
    [result.statusCounts],
  );
  return (
    <section className={cn(panelClass, "flex flex-col")}>
      <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2 dark:border-slate-800">
        <h2 className={panelTitleClass}>Status codes</h2>
      </div>
      <div className="p-3">
        <div className="flex h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
          {families.map(([tone, count]) => (
            <span
              key={tone}
              title={`${toneLabel[tone]}: ${formatNum(count)}`}
              style={{
                width: `${(count * 100) / Math.max(1, total)}%`,
                background: toneColor[tone],
              }}
            />
          ))}
        </div>
        <div className="mt-2.5 grid grid-cols-2 gap-1.5">
          {families.map(([tone, count]) => {
            const family = familyOf[tone];
            const active = statusFamily === family && family !== "all";
            return (
              <button
                key={tone}
                type="button"
                disabled={isParsing || family === "all"}
                aria-pressed={active}
                onClick={() =>
                  updateNginxFilters({ statusFamily: active ? "all" : family, statusCode: 0 })
                }
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1 text-left text-[11px] ring-1 ring-transparent hover:bg-slate-50 dark:hover:bg-slate-800",
                  active &&
                    "bg-violet-50 ring-violet-200 dark:bg-violet-950/40 dark:ring-violet-800",
                )}
              >
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: toneColor[tone] }}
                />
                <span className="min-w-0 flex-1 truncate text-slate-600 dark:text-slate-300">
                  {toneLabel[tone]}
                </span>
                <span className="font-semibold tabular-nums text-slate-800 dark:text-slate-100">
                  {percent(count, total)}
                </span>
              </button>
            );
          })}
        </div>
        <ul className="mt-2.5 flex flex-col divide-y divide-slate-100 border-t border-slate-100 text-xs dark:divide-slate-800 dark:border-slate-800">
          {(showAll ? codes : codes.slice(0, 8)).map((row) => {
            const active = statusCode === row.status;
            return (
              <li key={row.status}>
                <button
                  type="button"
                  disabled={isParsing}
                  aria-pressed={active}
                  title={active ? "Clear status filter" : `Show only ${row.status} responses`}
                  onClick={() => filterNginxStatusCode(active ? 0 : row.status)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded px-1 py-1 tabular-nums hover:bg-slate-50 dark:hover:bg-slate-800",
                    active && "bg-violet-50 dark:bg-violet-950/40",
                  )}
                >
                  <span
                    className="w-9 rounded py-0.5 text-center text-[10px] font-semibold text-white"
                    style={{ background: toneColor[statusTone(row.status)] }}
                  >
                    {row.status}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-left text-[11px] text-slate-500 dark:text-slate-400">
                    {statusText.get(row.status) ?? ""}
                  </span>
                  <span className="text-right text-slate-700 dark:text-slate-200">
                    {formatNum(row.count)}
                  </span>
                  <span className="w-12 text-right text-[11px] text-slate-500">
                    {percent(row.count, total)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {codes.length > 8 && (
          <button
            type="button"
            onClick={() => setShowAll(!showAll)}
            className={cn(mutedClass, "mt-1 font-medium text-violet-700 dark:text-violet-300")}
          >
            {showAll ? "Show fewer codes" : `Show all ${codes.length} codes`}
          </button>
        )}
      </div>
    </section>
  );
}

function Highlight({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="min-w-0 bg-white px-3 py-2 dark:bg-slate-900">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {label}
      </div>
      <div className="mt-0.5 flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 font-mono-data text-sm font-semibold text-slate-900 dark:text-slate-100">
          {value}
        </span>
        <span className="truncate text-[10px] text-slate-500 dark:text-slate-400">{detail}</span>
      </div>
    </div>
  );
}

export function NginxTrafficView({ result, metric }: { result: NginxResult; metric: NginxMetric }) {
  const theme = useChartTheme();
  const shared = useBuckets(result);
  const { buckets, formatLabel } = shared;
  const measured =
    metric === "request" ? result.summary.requestTime.count : result.summary.upstreamTime.count;
  const data = useMemo(
    () =>
      buckets.map((bucket) => {
        const time = bucketTime(bucket, metric);
        return {
          label: bucket.label,
          avg: time.avgMs,
          p50: time.p50Ms,
          p95: time.p95Ms,
          p99: time.p99Ms,
          bytes: bucket.bodyBytes,
        };
      }),
    [buckets, metric],
  );
  const highlights = useMemo(() => {
    let busiest: NginxTimeBucket | null = null;
    let slowest: NginxTimeBucket | null = null;
    let worstErrors: NginxTimeBucket | null = null;
    for (const bucket of buckets) {
      if (!busiest || bucket.count > busiest.count) busiest = bucket;
      const p95 = bucketTime(bucket, metric).p95Ms;
      if (p95 != null && (!slowest || p95 > (bucketTime(slowest, metric).p95Ms ?? -1)))
        slowest = bucket;
      if (
        bucket.count > 0 &&
        (!worstErrors ||
          bucket.errorCount / bucket.count > worstErrors.errorCount / worstErrors.count)
      )
        worstErrors = bucket;
    }
    return { busiest, slowest, worstErrors };
  }, [buckets, metric]);
  if (result.summary.count === 0) {
    return (
      <section className={panelClass}>
        <p className="p-8 text-center text-xs text-slate-500">No requests match these filters.</p>
      </section>
    );
  }
  const { busiest, slowest, worstErrors } = highlights;
  const profiled = result.summary.requestTime.count > 0 || result.summary.upstreamTime.count > 0;
  return (
    <div className="flex flex-col gap-3">
      <div
        className={cn(
          "grid gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 dark:border-slate-800 dark:bg-slate-800",
          slowest ? "sm:grid-cols-3" : "sm:grid-cols-2",
        )}
      >
        {busiest && (
          <Highlight
            label="Busiest period"
            value={busiest.label}
            detail={`${formatNum(busiest.count)} requests · ${formatBytes(busiest.bodyBytes)}`}
          />
        )}
        {slowest && (
          <Highlight
            label="Slowest period (p95)"
            value={slowest.label}
            detail={`p95 ${latency(bucketTime(slowest, metric).p95Ms)} · avg ${latency(bucketTime(slowest, metric).avgMs)}`}
          />
        )}
        {worstErrors && (
          <Highlight
            label="Highest error rate"
            value={worstErrors.label}
            detail={`${percent(worstErrors.errorCount, worstErrors.count)} · ${formatNum(worstErrors.errorCount)} of ${formatNum(worstErrors.count)}`}
          />
        )}
      </div>
      <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <NginxTimelineChart result={result} metric={metric} height={262} shared={shared} />
        <NginxStatusCard result={result} />
      </div>
      <div
        className={cn(
          "grid items-start gap-3",
          measured > 0 && profiled
            ? "lg:grid-cols-3"
            : measured > 0 || profiled
              ? "lg:grid-cols-2"
              : "",
        )}
      >
        {measured > 0 && (
          <section className={cn(panelClass, "flex flex-col")}>
            <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2 dark:border-slate-800">
              <h2 className={panelTitleClass}>Latency percentiles</h2>
              <span className="text-[11px] text-slate-400 dark:text-slate-500">
                {metric === "request" ? "Request time" : "Upstream time"}
              </span>
            </div>
            <div className="p-3">
              <div className="h-44">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke={theme.grid} strokeDasharray="3 3" vertical={false} />
                    <XAxis
                      dataKey="label"
                      tick={theme.tick}
                      tickFormatter={formatLabel}
                      minTickGap={24}
                      tickLine={false}
                    />
                    <YAxis
                      width={52}
                      tick={theme.tick}
                      tickFormatter={(value: number) => latency(value)}
                      axisLine={false}
                      tickLine={false}
                    />
                    <Tooltip
                      contentStyle={theme.tooltip}
                      formatter={(value) => latency(value == null ? null : Number(value))}
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} iconSize={10} />
                    <Line
                      dataKey="p50"
                      stroke="#a78bfa"
                      dot={false}
                      connectNulls
                      isAnimationActive={false}
                    />
                    <Line
                      dataKey="avg"
                      stroke="#64748b"
                      strokeDasharray="4 3"
                      dot={false}
                      connectNulls
                      isAnimationActive={false}
                    />
                    <Line
                      dataKey="p95"
                      stroke="#f59e0b"
                      strokeWidth={2}
                      dot={false}
                      connectNulls
                      isAnimationActive={false}
                    />
                    <Line
                      dataKey="p99"
                      stroke="#f43f5e"
                      dot={false}
                      connectNulls
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </section>
        )}
        <section className={cn(panelClass, "flex flex-col")}>
          <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2 dark:border-slate-800">
            <h2 className={panelTitleClass}>Bandwidth</h2>
          </div>
          <div className="p-3">
            <div className="h-44">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke={theme.grid} strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={theme.tick}
                    tickFormatter={formatLabel}
                    minTickGap={24}
                    tickLine={false}
                  />
                  <YAxis
                    width={52}
                    tick={theme.tick}
                    tickFormatter={compactBytes}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    contentStyle={theme.tooltip}
                    formatter={(value) => formatBytes(Number(value))}
                  />
                  <Area
                    dataKey="bytes"
                    name="Body bytes"
                    fill="#8b5cf6"
                    fillOpacity={0.15}
                    stroke="#8b5cf6"
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        </section>
        {profiled && <NginxLatencyProfile result={result} />}
      </div>
    </div>
  );
}
