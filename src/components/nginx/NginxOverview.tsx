import { useMemo } from "react";
import type { ReactNode } from "react";
import type { NginxHotspot, NginxLatency, NginxMetric, NginxResult } from "../../nginx/types";
import { formatBytes, formatNum } from "../../utils/format";
import { cn } from "../../utils/cn";
import { filterNginxEndpoint, getMethodClass } from "./NginxEndpointTable";
import { updateNginxFilters } from "./NginxFilterBar";
import { useNginxStore } from "../../store/nginxStore";
import { errorTone, latency, panelClass, panelTitleClass, percent } from "./nginxUi";

type Kpi = {
  label: string;
  value: string;
  detail: string;
  valueTone?: string;
  title?: string;
  onClick?: () => void;
  active?: boolean;
};

const { setActiveView } = useNginxStore.getState();

function timingKpi(label: string, time: NginxLatency, total: number, field: string): Kpi {
  if (time.count === 0) return { label, value: "—", detail: `${field} not logged` };
  const coverage = time.count < total ? ` · ${percent(time.count, total)} timed` : "";
  return {
    label,
    value: latency(time.p95Ms),
    detail: `avg ${latency(time.avgMs)} · p99 ${latency(time.p99Ms)}${coverage}`,
    title: `${formatNum(time.count)} of ${formatNum(total)} requests have ${field}`,
  };
}

export function NginxKpiRow({ result }: { result: NginxResult }) {
  const errorsOnly = useNginxStore((state) => state.filters.statusFamily === "errors");
  const s = result.summary;
  const hours = result.hourlyStats;
  const peak = hours.reduce((max, bucket) => Math.max(max, bucket.count), 0);
  const serverErrors = result.statusCounts
    .filter((row) => row.status >= 500)
    .reduce((sum, row) => sum + row.count, 0);
  const rate = s.count > 0 ? s.errorCount / s.count : 0;
  const rateTone =
    rate > 0.05
      ? "text-rose-600 dark:text-rose-400"
      : rate > 0.01
        ? "text-amber-600 dark:text-amber-400"
        : "text-emerald-600 dark:text-emerald-400";
  const topClient = result.clients[0];
  const items: Kpi[] = [
    {
      label: "Requests",
      value: formatNum(s.count),
      detail: peak > 0 ? `peak ${formatNum(peak)} / hour` : "",
    },
    {
      label: "Error rate",
      value: percent(s.errorCount, s.count),
      detail: `${formatNum(s.errorCount)} errors · ${formatNum(serverErrors)} are 5xx`,
      valueTone: rateTone,
      title: errorsOnly ? "Show all responses" : "Show only 4xx + 5xx responses",
      active: errorsOnly,
      onClick: () =>
        updateNginxFilters({ statusFamily: errorsOnly ? "all" : "errors", statusCode: 0 }),
    },
    ...(s.requestTime.count > 0
      ? [timingKpi("Request time p95", s.requestTime, s.count, "rt")]
      : []),
    ...(s.upstreamTime.count > 0
      ? [
          {
            ...timingKpi("Upstream time p95", s.upstreamTime, s.count, "urt"),
            title: "Total recorded upstream time (sum of attempts)",
          },
        ]
      : []),
    {
      label: "Bandwidth",
      value: formatBytes(s.bodyBytes),
      detail: s.count > 0 ? `avg ${formatBytes(Math.round(s.bodyBytes / s.count))} / request` : "",
      title: "body_bytes_sent (excludes headers)",
    },
    {
      label: "Unique clients",
      value: formatNum(s.uniqueClients),
      detail: topClient ? `top ${topClient.value} · ${percent(topClient.count, s.count)}` : "",
      title: "Open the Clients tab",
      onClick: () => setActiveView("clients"),
    },
  ];
  return (
    <section
      data-testid="nginx-kpi-row"
      className={cn(
        "grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 dark:border-slate-800 dark:bg-slate-800",
        items.length === 4
          ? "sm:grid-cols-4"
          : items.length === 5
            ? "sm:grid-cols-5"
            : "sm:grid-cols-3 xl:grid-cols-6",
      )}
    >
      {items.map((item) => {
        const Tag = item.onClick ? "button" : "div";
        return (
          <Tag
            key={item.label}
            title={item.title}
            {...(item.onClick
              ? { type: "button" as const, onClick: item.onClick, "aria-pressed": item.active }
              : {})}
            className={cn(
              "flex min-w-0 flex-col bg-white px-3 py-2.5 text-left dark:bg-slate-900",
              item.onClick && "hover:bg-slate-50 dark:hover:bg-slate-800/70",
              item.active && "bg-violet-50 dark:bg-violet-950/40",
            )}
          >
            <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              {item.label}
            </div>
            <div
              className={cn(
                "mt-1 font-mono-data text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-100",
                item.valueTone,
              )}
            >
              {item.value}
            </div>
            {item.detail && (
              <div className="mt-0.5 truncate text-[10px] text-slate-500 dark:text-slate-400">
                {item.detail}
              </div>
            )}
          </Tag>
        );
      })}
    </section>
  );
}

function HotspotRow({
  rank,
  row,
  value,
  valueTone,
  detail,
  share,
  barTone,
}: {
  rank: number;
  row: NginxHotspot;
  value: string;
  valueTone?: string;
  detail: string;
  share: number;
  barTone: string;
}) {
  return (
    <li className="px-3 py-1.5">
      <div className="flex items-center gap-2">
        <span className="w-3 shrink-0 text-right text-[10px] tabular-nums text-slate-400">
          {rank}
        </span>
        <span
          className={cn(
            "w-11 shrink-0 rounded py-0.5 text-center text-[10px] font-bold uppercase tracking-wide ring-1 dark:ring-0",
            getMethodClass(row.method),
          )}
        >
          {row.method}
        </span>
        <button
          type="button"
          title={`Filter the dashboard to ${row.path}`}
          onClick={() => filterNginxEndpoint(row.path)}
          className="min-w-0 flex-1 truncate text-left font-mono-data text-[11px] text-slate-800 hover:text-violet-600 dark:text-slate-200 dark:hover:text-violet-400"
        >
          {row.path}
        </button>
        <span
          className={cn(
            "shrink-0 font-mono-data text-xs font-semibold tabular-nums text-slate-900 dark:text-slate-100",
            valueTone,
          )}
        >
          {value}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2 pl-6">
        <span className="h-1 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
          <span
            className={cn("block h-full rounded-full", barTone)}
            style={{ width: `${Math.max(2, share * 100)}%` }}
          />
        </span>
        <span className="shrink-0 text-[10px] tabular-nums text-slate-500 dark:text-slate-400">
          {detail}
        </span>
      </div>
    </li>
  );
}

function PanelHeader({ title, subtitle }: { title: ReactNode; subtitle?: string }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-800">
      {String(title) === title ? <h2 className={panelTitleClass}>{title}</h2> : title}
      {subtitle && (
        <span className="text-[11px] text-slate-400 dark:text-slate-500">{subtitle}</span>
      )}
    </div>
  );
}

function Empty({ children }: { children: string }) {
  return <p className="px-3 py-6 text-center text-xs text-slate-500">{children}</p>;
}

export function NginxSlowestPanel({
  result,
  metric,
  title = "Slowest endpoints",
}: {
  result: NginxResult;
  metric: NginxMetric;
  title?: ReactNode;
}) {
  const rows = result.slowestEndpoints;
  const max = rows[0]?.p95Ms ?? 0;
  return (
    <section className={panelClass}>
      <PanelHeader
        title={title}
        subtitle={`p95 ${metric === "request" ? "request" : "upstream"}`}
      />
      {rows.length === 0 ? (
        <Empty>No timed requests recorded.</Empty>
      ) : (
        <ol className="divide-y divide-slate-100 dark:divide-slate-800">
          {rows.map((row, index) => (
            <HotspotRow
              key={`${row.method} ${row.path}`}
              rank={index + 1}
              row={row}
              value={latency(row.p95Ms)}
              detail={`${formatNum(row.timedCount)} timed · avg ${latency(row.avgMs)}`}
              share={max > 0 ? (row.p95Ms ?? 0) / max : 0}
              barTone="bg-amber-500"
            />
          ))}
        </ol>
      )}
    </section>
  );
}

export function NginxFailingPanel({
  result,
  title = "Most errors",
}: {
  result: NginxResult;
  title?: ReactNode;
}) {
  const rows = result.failingEndpoints;
  const max = rows[0]?.errorCount ?? 0;
  return (
    <section className={panelClass}>
      <PanelHeader title={title} subtitle="4xx + 5xx" />
      {rows.length === 0 ? (
        <Empty>No error responses in this selection.</Empty>
      ) : (
        <ol className="divide-y divide-slate-100 dark:divide-slate-800">
          {rows.map((row, index) => (
            <HotspotRow
              key={`${row.method} ${row.path}`}
              rank={index + 1}
              row={row}
              value={formatNum(row.errorCount)}
              valueTone={errorTone(row.errorCount, row.count)}
              detail={`${percent(row.errorCount, row.count)} of ${formatNum(row.count)}`}
              share={max > 0 ? row.errorCount / max : 0}
              barTone="bg-rose-500"
            />
          ))}
        </ol>
      )}
    </section>
  );
}

export function NginxLatencyProfile({ result }: { result: NginxResult }) {
  const { requestTime: rt, upstreamTime: urt, count } = result.summary;
  const rows = useMemo(
    () =>
      [
        ["p50", rt.p50Ms, urt.p50Ms],
        ["p90", rt.p90Ms, urt.p90Ms],
        ["p95", rt.p95Ms, urt.p95Ms],
        ["p99", rt.p99Ms, urt.p99Ms],
        ["Max", rt.maxMs, urt.maxMs],
        ["Average", rt.avgMs, urt.avgMs],
      ] as const,
    [rt, urt],
  );
  const scale = Math.max(rt.p99Ms ?? 0, urt.p99Ms ?? 0);
  const bar = (value: number | null, tone: string) => (
    <span className="h-1 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
      <span
        className={cn("block h-full rounded-full", tone)}
        style={{
          width: `${value == null || scale <= 0 ? 0 : Math.min(100, (value * 100) / scale)}%`,
        }}
      />
    </span>
  );
  return (
    <section className={panelClass}>
      <PanelHeader title="Latency profile" subtitle="rt vs urt" />
      {rt.count === 0 && urt.count === 0 ? (
        <Empty>No rt= or urt= timings in these logs.</Empty>
      ) : (
        <div className="px-3 py-2">
          <div className="grid grid-cols-[56px_1fr_1fr] gap-x-4 pb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            <span />
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-violet-500" /> Request
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-sky-500" /> Upstream
            </span>
          </div>
          {rows.map(([label, request, upstream]) => (
            <div
              key={label}
              className="grid grid-cols-[56px_1fr_1fr] items-center gap-x-4 border-t border-slate-100 py-[3px] text-xs dark:border-slate-800"
            >
              <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                {label}
              </span>
              <span className="flex flex-col gap-0.5">
                <span className="font-mono-data tabular-nums text-slate-800 dark:text-slate-100">
                  {latency(request)}
                </span>
                {label !== "Max" && bar(request, "bg-violet-500")}
              </span>
              <span className="flex flex-col gap-0.5">
                <span className="font-mono-data tabular-nums text-slate-800 dark:text-slate-100">
                  {latency(upstream)}
                </span>
                {label !== "Max" && bar(upstream, "bg-sky-500")}
              </span>
            </div>
          ))}
          <div className="grid grid-cols-[56px_1fr_1fr] gap-x-4 border-t border-slate-100 py-1 text-[11px] text-slate-500 dark:border-slate-800 dark:text-slate-400">
            <span className="font-medium">Timed</span>
            <span className="tabular-nums">{percent(rt.count, count)}</span>
            <span className="tabular-nums">{percent(urt.count, count)}</span>
          </div>
        </div>
      )}
    </section>
  );
}
