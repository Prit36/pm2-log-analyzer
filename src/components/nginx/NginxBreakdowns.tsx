import { useMemo, useState, type ReactNode } from "react";
import { Bot, Copy, Globe, Link2, Monitor, Terminal, X } from "lucide-react";
import { useNginxStore } from "../../store/nginxStore";
import type { NginxBreakdown, NginxResult } from "../../nginx/types";
import { agentKindLabel, parseUserAgent, type AgentKind } from "../../nginx/userAgent";
import { formatBytes, formatNum } from "../../utils/format";
import { cn } from "../../utils/cn";
import { errorTone, panelClass, panelTitleClass, percent } from "./nginxUi";
import { updateNginxFilters } from "./NginxFilterBar";
import { NginxTable, type NginxColumn } from "./NginxTable";

const { setActiveView, showToast } = useNginxStore.getState();

export function showNginxClientEndpoints(client: string): void {
  const query = useNginxStore.getState().filters.query;
  const pathQuery = query
    .split(/\s+/)
    .filter((part) => !part.toLowerCase().startsWith("ip:") && part !== client)
    .join(" ")
    .trim();
  setActiveView("endpoints");
  updateNginxFilters({ query: `ip:${client}${pathQuery ? ` ${pathQuery}` : ""}` });
}

export async function copyNginxValue(value: string, label = "Copied"): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    showToast(label);
  } catch {
    showToast("Clipboard access is unavailable");
  }
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  return (
    <button
      type="button"
      title={`Copy ${value}`}
      aria-label={`Copy ${value}`}
      onClick={() => void copyNginxValue(value, label)}
      className="shrink-0 rounded p-0.5 text-slate-400 opacity-0 group-hover/row:opacity-100 hover:bg-slate-100 hover:text-slate-700 focus:opacity-100 dark:hover:bg-slate-800 dark:hover:text-slate-200"
    >
      <Copy className="size-3" aria-hidden />
    </button>
  );
}

/** Bar scaled to the largest row with the share of all requests beside it. */
export function ShareCell({ count, max, total }: { count: number; max: number; total: number }) {
  return (
    <span className="flex items-center gap-2">
      <span className="block h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
        <span
          className="block h-full rounded-full bg-violet-500"
          style={{ width: `${max > 0 ? Math.max(2, (count * 100) / max) : 0}%` }}
        />
      </span>
      <span className="w-10 shrink-0 text-right text-[10px] text-slate-500 dark:text-slate-400">
        {percent(count, total)}
      </span>
    </span>
  );
}

export function ErrorsCell({ errors, count }: { errors: number; count: number }) {
  if (errors === 0) return <span className="text-slate-300 dark:text-slate-600">0</span>;
  return (
    <>
      {formatNum(errors)}{" "}
      <span className={cn("text-[10px] font-semibold", errorTone(errors, count))}>
        {percent(errors, count)}
      </span>
    </>
  );
}

/** Common trailing metric columns for breakdown tables. */
export function metricColumns<T extends NginxBreakdown>(
  rows: T[],
  total: number,
): NginxColumn<T>[] {
  const max = rows.reduce((value, row) => Math.max(value, row.count), 0);
  return [
    {
      id: "share",
      label: "Share",
      width: "minmax(110px,180px)",
      title: "Share of all matching requests",
      render: (row) => <ShareCell count={row.count} max={max} total={total} />,
    },
    {
      id: "count",
      label: "Requests",
      width: "84px",
      align: "right",
      sort: (row) => row.count,
      render: (row) => formatNum(row.count),
    },
    {
      id: "errors",
      label: "Errors",
      width: "96px",
      align: "right",
      title: "4xx + 5xx responses",
      sort: (row) => row.errorCount,
      render: (row) => <ErrorsCell errors={row.errorCount} count={row.count} />,
    },
    {
      id: "errorRate",
      label: "Error %",
      width: "64px",
      align: "right",
      sort: (row) => (row.count > 0 ? row.errorCount / row.count : 0),
      render: (row) => (
        <span className={errorTone(row.errorCount, row.count)}>
          {percent(row.errorCount, row.count)}
        </span>
      ),
    },
    {
      id: "bytes",
      label: "Body",
      width: "80px",
      align: "right",
      title: "body_bytes_sent",
      sort: (row) => row.bodyBytes,
      render: (row) => (
        <span className="text-slate-500 dark:text-slate-400">{formatBytes(row.bodyBytes)}</span>
      ),
    },
  ];
}

export type RankItem = {
  key: string;
  label: ReactNode;
  count: number;
  errors?: number;
  detail?: string;
};

/** Ranked share list; selecting an item narrows the table below it. */
export function RankPanel({
  title,
  subtitle,
  items,
  total,
  active,
  onSelect,
  limit = 8,
}: {
  title: string;
  subtitle?: string;
  items: RankItem[];
  total: number;
  active?: string | null;
  onSelect?: (key: string | null) => void;
  limit?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? items : items.slice(0, limit);
  const max = items[0]?.count ?? 0;
  return (
    <section className={cn(panelClass, "flex flex-col")}>
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-800">
        <h2 className={panelTitleClass}>{title}</h2>
        {subtitle && (
          <span className="truncate text-[11px] text-slate-400 dark:text-slate-500">
            {subtitle}
          </span>
        )}
      </div>
      {items.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs text-slate-500">No data.</p>
      ) : (
        <ul className="flex flex-col py-1">
          {shown.map((item) => {
            const selected = active === item.key;
            const body = (
              <>
                <span className="flex min-w-0 flex-1 items-center gap-2 text-slate-700 dark:text-slate-200">
                  {item.label}
                </span>
                <span className="shrink-0 font-mono-data text-[11px] font-semibold tabular-nums text-slate-800 dark:text-slate-100">
                  {formatNum(item.count)}
                </span>
                <span className="w-10 shrink-0 text-right text-[10px] tabular-nums text-slate-500">
                  {percent(item.count, total)}
                </span>
                <span
                  aria-hidden
                  className="absolute bottom-0 left-3 h-0.5 rounded-full bg-violet-500/70"
                  style={{
                    width: `calc((100% - 1.5rem) * ${max > 0 ? Math.max(0.01, item.count / max) : 0})`,
                  }}
                />
              </>
            );
            const rowClass = cn(
              "relative flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs",
              selected && "bg-violet-50 dark:bg-violet-950/40",
            );
            return (
              <li key={item.key} title={item.detail}>
                {onSelect ? (
                  <button
                    type="button"
                    aria-pressed={selected}
                    onClick={() => onSelect(selected ? null : item.key)}
                    className={cn(rowClass, "hover:bg-slate-50 dark:hover:bg-slate-800/60")}
                  >
                    {body}
                  </button>
                ) : (
                  <div className={rowClass}>{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {items.length > limit && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="mt-auto border-t border-slate-100 px-3 py-1.5 text-left text-[11px] font-medium text-violet-700 hover:bg-slate-50 dark:border-slate-800 dark:text-violet-300 dark:hover:bg-slate-800/60"
        >
          {expanded ? "Show less" : `Show all ${formatNum(items.length)}`}
        </button>
      )}
    </section>
  );
}

/** Chip shown in a table toolbar while a summary panel narrows the rows. */
export function SelectionChip({ label, onClear }: { label: ReactNode; onClear: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-violet-100 py-0.5 pr-1 pl-2 text-[11px] font-medium text-violet-700 dark:bg-violet-950 dark:text-violet-300">
      {label}
      <button
        type="button"
        aria-label="Clear selection"
        onClick={onClear}
        className="rounded-full p-0.5 hover:bg-violet-200 dark:hover:bg-violet-900"
      >
        <X className="size-3" aria-hidden />
      </button>
    </span>
  );
}

/** Coverage note: summary panels aggregate only the core's top-N rows. */
export function coverageNote(rows: NginxBreakdown[], distinct: number, total: number): string {
  if (distinct <= rows.length) return "all values";
  const covered = rows.reduce((sum, row) => sum + row.count, 0);
  return `top ${formatNum(rows.length)} · ${percent(covered, total)} of requests`;
}

function aggregate<T extends NginxBreakdown>(
  rows: T[],
  keyOf: (row: T) => string,
): { key: string; count: number; errors: number; values: number }[] {
  const map = new Map<string, { key: string; count: number; errors: number; values: number }>();
  for (const row of rows) {
    const key = keyOf(row);
    const entry = map.get(key) ?? { key, count: 0, errors: 0, values: 0 };
    entry.count += row.count;
    entry.errors += row.errorCount;
    entry.values += 1;
    map.set(key, entry);
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

// ---- Referrers --------------------------------------------------------------

type ReferrerParts = { host: string; rest: string };
type ReferrerRow = NginxBreakdown & ReferrerParts;

function splitReferrer(value: string): ReferrerParts {
  if (value === "-" || value === "") return { host: "Direct / none", rest: "" };
  try {
    const url = new URL(value);
    return { host: url.host || url.protocol, rest: `${url.pathname}${url.search}` };
  } catch {
    return { host: value, rest: "" };
  }
}

export function NginxReferrersView({ result }: { result: NginxResult }) {
  const total = result.summary.count;
  const [host, setHost] = useState<string | null>(null);
  const rows = useMemo<ReferrerRow[]>(
    () => result.referrers.map((row) => ({ ...row, ...splitReferrer(row.value) })),
    [result.referrers],
  );
  const hosts = useMemo(() => aggregate(rows, (row) => row.host), [rows]);
  const filtered = useMemo(
    () => (host ? rows.filter((row) => row.host === host) : rows),
    [rows, host],
  );
  const columns = useMemo<NginxColumn<ReferrerRow>[]>(
    () => [
      {
        id: "value",
        label: "Referrer",
        width: "minmax(260px,1fr)",
        sort: (row) => row.value,
        render: (row) => (
          <span className="group/row flex min-w-0 items-center gap-1.5" title={row.value}>
            {row.value === "-" ? (
              <Link2 className="size-3.5 shrink-0 text-slate-400" aria-hidden />
            ) : (
              <Globe className="size-3.5 shrink-0 text-slate-400" aria-hidden />
            )}
            <span className="shrink-0 font-medium text-slate-800 dark:text-slate-100">
              {row.host}
            </span>
            <span className="truncate font-mono-data text-[11px] text-slate-500 dark:text-slate-400">
              {row.rest}
            </span>
            {row.value !== "-" && <CopyButton value={row.value} label="Referrer copied" />}
          </span>
        ),
      },
      ...metricColumns(filtered, total),
    ],
    [filtered, total],
  );
  return (
    <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,2.4fr)]">
      <RankPanel
        title="Referring sites"
        subtitle={coverageNote(result.referrers, result.referrerCount, total)}
        total={total}
        active={host}
        onSelect={setHost}
        items={hosts.map((entry) => ({
          key: entry.key,
          count: entry.count,
          detail: `${formatNum(entry.values)} referrer URLs · ${percent(entry.errors, entry.count)} errors`,
          label: <span className="truncate">{entry.key}</span>,
        }))}
      />
      <NginxTable
        title="Referrers"
        testId="nginx-referrers-table"
        total={result.referrerCount}
        rows={filtered}
        columns={columns}
        minWidth={760}
        defaultSort={{ id: "count", dir: "desc" }}
        searchText={(row) => row.value}
        searchPlaceholder="Filter referrers…"
        toolbar={host && <SelectionChip label={host} onClear={() => setHost(null)} />}
      />
    </div>
  );
}

// ---- User agents ------------------------------------------------------------

type AgentRow = NginxBreakdown & ReturnType<typeof parseUserAgent>;

const kindIcon = {
  browser: Monitor,
  bot: Bot,
  tool: Terminal,
  unknown: Globe,
} satisfies Record<AgentKind, typeof Monitor>;

const kindClass = {
  browser: "bg-sky-50 text-sky-700 dark:bg-sky-950/50 dark:text-sky-300",
  bot: "bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300",
  tool: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300",
  unknown: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
} satisfies Record<AgentKind, string>;

function KindBadge({ kind }: { kind: AgentKind }) {
  const Icon = kindIcon[kind];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold",
        kindClass[kind],
      )}
    >
      <Icon className="size-3" aria-hidden />
      {agentKindLabel[kind]}
    </span>
  );
}

type Selection = { panel: "kind" | "name" | "os"; key: string } | null;

export function NginxUserAgentsView({ result }: { result: NginxResult }) {
  const total = result.summary.count;
  const [selection, setSelection] = useState<Selection>(null);
  const rows = useMemo<AgentRow[]>(
    () => result.userAgents.map((row) => ({ ...row, ...parseUserAgent(row.value) })),
    [result.userAgents],
  );
  const kinds = useMemo(() => aggregate(rows, (row) => row.kind), [rows]);
  const names = useMemo(() => aggregate(rows, (row) => row.name.replace(/ \d+$/, "")), [rows]);
  const systems = useMemo(
    () =>
      aggregate(
        rows.filter((row) => row.os),
        (row) => row.os ?? "",
      ),
    [rows],
  );
  const filtered = useMemo(() => {
    if (!selection) return rows;
    return rows.filter((row) =>
      selection.panel === "kind"
        ? row.kind === selection.key
        : selection.panel === "os"
          ? row.os === selection.key
          : row.name.replace(/ \d+$/, "") === selection.key,
    );
  }, [rows, selection]);
  const columns = useMemo<NginxColumn<AgentRow>[]>(
    () => [
      {
        id: "name",
        label: "Client",
        width: "minmax(300px,1fr)",
        sort: (row) => row.name,
        render: (row) => (
          <span className="group/row flex min-w-0 items-center gap-2" title={row.value}>
            <KindBadge kind={row.kind} />
            <span className="shrink-0 font-medium text-slate-800 dark:text-slate-100">
              {row.name}
              {row.os && (
                <span className="font-normal text-slate-500 dark:text-slate-400">
                  {" "}
                  · {row.os}
                  {row.mobile ? " mobile" : ""}
                </span>
              )}
            </span>
            <span className="truncate font-mono-data text-[10px] text-slate-400 dark:text-slate-500">
              {row.value === "-" ? "" : row.value}
            </span>
            {row.value !== "-" && <CopyButton value={row.value} label="User agent copied" />}
          </span>
        ),
      },
      ...metricColumns(filtered, total),
    ],
    [filtered, total],
  );
  const subtitle = coverageNote(result.userAgents, result.userAgentCount, total);
  const select = (panel: "kind" | "name" | "os") => (key: string | null) =>
    setSelection(key ? { panel, key } : null);
  const activeFor = (panel: "kind" | "name" | "os") =>
    selection?.panel === panel ? selection.key : null;
  const items = (entries: ReturnType<typeof aggregate>) =>
    entries.map((entry) => ({
      key: entry.key,
      count: entry.count,
      detail: `${formatNum(entry.values)} user agents · ${percent(entry.errors, entry.count)} errors`,
      label: <span className="truncate">{entry.key}</span>,
    }));
  return (
    <div className="flex flex-col gap-3">
      <div className="grid items-start gap-3 md:grid-cols-3">
        <RankPanel
          title="Client type"
          subtitle={subtitle}
          total={total}
          active={activeFor("kind")}
          onSelect={select("kind")}
          items={kinds.map((entry) => ({
            key: entry.key,
            count: entry.count,
            detail: `${percent(entry.errors, entry.count)} errors`,
            // SAFETY: kinds are aggregated from AgentKind values.
            label: <KindBadge kind={entry.key as AgentKind} />,
          }))}
        />
        <RankPanel
          title="Browsers & clients"
          total={total}
          active={activeFor("name")}
          onSelect={select("name")}
          items={items(names)}
        />
        <RankPanel
          title="Operating systems"
          total={total}
          active={activeFor("os")}
          onSelect={select("os")}
          items={items(systems)}
        />
      </div>
      <NginxTable
        title="User agents"
        testId="nginx-agents-table"
        total={result.userAgentCount}
        rows={filtered}
        columns={columns}
        minWidth={820}
        defaultSort={{ id: "count", dir: "desc" }}
        searchText={(row) => `${row.name} ${row.os ?? ""} ${row.value}`}
        searchPlaceholder="Filter user agents…"
        toolbar={
          selection && (
            <SelectionChip
              label={
                selection.panel === "kind"
                  ? // SAFETY: kind selections come from AgentKind values.
                    agentKindLabel[selection.key as AgentKind]
                  : selection.key
              }
              onClear={() => setSelection(null)}
            />
          )
        }
      />
    </div>
  );
}
