import { useMemo, useState } from "react";
import { AlertTriangle, ArrowRight, House, Loader2, RotateCcw } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import type { NginxBreakdown, NginxResult } from "../../nginx/types";
import { countryName, retryIpLookup, useIpInfoStore, type IpInfo } from "../../nginx/ipLookup";
import { formatNum } from "../../utils/format";
import { percent } from "./nginxUi";
import {
  CopyButton,
  RankPanel,
  SelectionChip,
  coverageNote,
  metricColumns,
  showNginxClientEndpoints,
} from "./NginxBreakdowns";
import { NginxTable, type NginxColumn } from "./NginxTable";

// Windows does not render emoji flags, so bundle the flag-icons SVGs with this lazy view.
const flagUrls = import.meta.glob<string>("/node_modules/flag-icons/flags/4x3/*.svg", {
  query: "?url",
  import: "default",
  eager: true,
});
const flags = new Map(
  Object.entries(flagUrls).map(([path, url]) => [
    path.slice(path.lastIndexOf("/") + 1, -4).toUpperCase(),
    url,
  ]),
);

const PRIVATE = "private";
const UNKNOWN = "unknown";
const PENDING = "pending";

function Flag({ code }: { code: string }) {
  const url = flags.get(code);
  if (!url)
    return (
      <span className="inline-block h-3 w-4 shrink-0 rounded-[2px] bg-slate-200 dark:bg-slate-700" />
    );
  return (
    <img
      src={url}
      alt=""
      width={16}
      height={12}
      className="h-3 w-4 shrink-0 rounded-[2px] object-cover ring-1 ring-black/10 dark:ring-white/10"
    />
  );
}

function locationKey(info: IpInfo | undefined, loading: boolean): string {
  if (!info) return loading ? PENDING : UNKNOWN;
  if (info.kind === "private") return PRIVATE;
  if (info.kind === "invalid" || !info.country) return UNKNOWN;
  return info.country;
}

function LocationLabel({ code }: { code: string }) {
  if (code === PRIVATE)
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-slate-500 dark:text-slate-400">
        <House className="size-3 shrink-0" aria-hidden />
        <span className="truncate">Private network</span>
      </span>
    );
  if (code === PENDING)
    return (
      <span className="flex items-center gap-1.5 text-slate-400">
        <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden />
        Looking up…
      </span>
    );
  if (code === UNKNOWN) return <span className="text-slate-400">Unknown</span>;
  return (
    <span className="flex min-w-0 items-center gap-1.5" title={`${countryName(code)} (${code})`}>
      <Flag code={code} />
      <span className="truncate">{countryName(code)}</span>
    </span>
  );
}

type ClientRow = NginxBreakdown & {
  location: string;
  org: string | null;
  asn: number | null;
};

function LookupStatus({ rows }: { rows: ClientRow[] }) {
  const { loading, error } = useIpInfoStore(
    useShallow((s) => ({ loading: s.loading, error: s.error })),
  );
  const located = rows.filter((row) => row.location.length === 2).length;
  const privateCount = rows.filter((row) => row.location === PRIVATE).length;
  const publicCount = rows.length - privateCount;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400">
      {error ? (
        <span className="flex items-center gap-1.5 text-amber-700 dark:text-amber-400">
          <AlertTriangle className="size-3.5" aria-hidden />
          {error}
          <button
            type="button"
            onClick={retryIpLookup}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-violet-700 hover:bg-violet-50 dark:text-violet-300 dark:hover:bg-violet-950/50"
          >
            <RotateCcw className="size-3" aria-hidden />
            Retry
          </button>
        </span>
      ) : loading > 0 ? (
        <span className="flex items-center gap-1.5">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          Looking up {formatNum(loading)} public IPs…
        </span>
      ) : (
        <span>
          {formatNum(located)} of {formatNum(publicCount)} public IPs located
          {privateCount > 0 && ` · ${formatNum(privateCount)} private`}
        </span>
      )}
      <span className="text-slate-400 dark:text-slate-500">
        Locations via country.is (GeoLite2) · approximate network location
      </span>
    </div>
  );
}

type Selection = { panel: "country" | "network"; key: string } | null;

export default function NginxClientsView({ result }: { result: NginxResult }) {
  const total = result.summary.count;
  const { infos, loading } = useIpInfoStore(
    useShallow((s) => ({ infos: s.infos, loading: s.loading > 0 })),
  );
  const [selection, setSelection] = useState<Selection>(null);
  const rows = useMemo<ClientRow[]>(
    () =>
      result.clients.map((row) => {
        const info = infos[row.value];
        const network = info?.kind === "public" ? info : null;
        return {
          ...row,
          location: locationKey(info, loading),
          org: network?.org ?? null,
          asn: network?.asn ?? null,
        };
      }),
    [result.clients, infos, loading],
  );
  const countries = useMemo(() => {
    const map = new Map<string, { count: number; errors: number; clients: number }>();
    for (const row of rows) {
      const entry = map.get(row.location) ?? { count: 0, errors: 0, clients: 0 };
      entry.count += row.count;
      entry.errors += row.errorCount;
      entry.clients += 1;
      map.set(row.location, entry);
    }
    return [...map.entries()].sort((a, b) => b[1].count - a[1].count);
  }, [rows]);
  const networks = useMemo(() => {
    const map = new Map<string, { count: number; clients: number; asn: number | null }>();
    for (const row of rows) {
      if (!row.org) continue;
      const entry = map.get(row.org) ?? { count: 0, clients: 0, asn: row.asn };
      entry.count += row.count;
      entry.clients += 1;
      map.set(row.org, entry);
    }
    return [...map.entries()].sort((a, b) => b[1].count - a[1].count);
  }, [rows]);
  const filtered = useMemo(() => {
    if (!selection) return rows;
    return rows.filter((row) =>
      selection.panel === "country" ? row.location === selection.key : row.org === selection.key,
    );
  }, [rows, selection]);
  const columns = useMemo<NginxColumn<ClientRow>[]>(
    () => [
      {
        id: "ip",
        label: "Client IP",
        width: "minmax(150px,1.1fr)",
        sort: (row) => row.value,
        render: (row) => (
          <span className="group/row flex min-w-0 items-center gap-1">
            <button
              type="button"
              onClick={() => showNginxClientEndpoints(row.value)}
              title={`Show endpoints requested by ${row.value}`}
              className="truncate font-mono-data text-[11px] text-violet-700 hover:underline dark:text-violet-300"
            >
              {row.value === "-" ? "— (not logged)" : row.value}
            </button>
            <CopyButton value={row.value} label="IP copied" />
          </span>
        ),
      },
      {
        id: "country",
        label: "Country",
        width: "minmax(130px,0.9fr)",
        sort: (row) => (row.location.length === 2 ? countryName(row.location) : `~${row.location}`),
        render: (row) => <LocationLabel code={row.location} />,
      },
      {
        id: "network",
        label: "Network",
        width: "minmax(140px,1fr)",
        title: "Autonomous system (ISP, hosting, or cloud provider)",
        sort: (row) => row.org ?? "~",
        render: (row) =>
          row.org ? (
            <span className="block truncate text-slate-600 dark:text-slate-300" title={row.org}>
              {row.org}
              {row.asn != null && (
                <span className="ml-1 text-[10px] text-slate-400">AS{row.asn}</span>
              )}
            </span>
          ) : (
            <span className="text-slate-300 dark:text-slate-600">—</span>
          ),
      },
      ...metricColumns(filtered, total),
      {
        id: "open",
        label: "",
        width: "28px",
        render: (row) => (
          <button
            type="button"
            aria-label={`Show endpoints requested by ${row.value}`}
            title="Show this client's endpoints"
            onClick={() => showNginxClientEndpoints(row.value)}
            className="rounded p-1 text-slate-400 hover:bg-violet-50 hover:text-violet-700 dark:hover:bg-violet-950/50 dark:hover:text-violet-300"
          >
            <ArrowRight className="size-3.5" aria-hidden />
          </button>
        ),
      },
    ],
    [filtered, total],
  );
  const subtitle = coverageNote(result.clients, result.clientCount, total);
  return (
    <div className="flex flex-col gap-3">
      <LookupStatus rows={rows} />
      <div className="grid items-start gap-3 md:grid-cols-2">
        <RankPanel
          title="Countries"
          subtitle={subtitle}
          total={total}
          active={selection?.panel === "country" ? selection.key : null}
          onSelect={(key) => setSelection(key ? { panel: "country", key } : null)}
          items={countries.map(([code, entry]) => ({
            key: code,
            count: entry.count,
            detail: `${formatNum(entry.clients)} clients · ${percent(entry.errors, entry.count)} errors`,
            label: (
              <>
                <LocationLabel code={code} />
                <span className="shrink-0 text-[10px] text-slate-400">
                  {formatNum(entry.clients)} IPs
                </span>
              </>
            ),
          }))}
        />
        <RankPanel
          title="Networks"
          subtitle="ISP / hosting provider"
          total={total}
          active={selection?.panel === "network" ? selection.key : null}
          onSelect={(key) => setSelection(key ? { panel: "network", key } : null)}
          items={networks.map(([org, entry]) => ({
            key: org,
            count: entry.count,
            detail: `${entry.asn != null ? `AS${entry.asn} · ` : ""}${formatNum(entry.clients)} clients`,
            label: (
              <>
                <span className="truncate">{org}</span>
                <span className="shrink-0 text-[10px] text-slate-400">
                  {formatNum(entry.clients)} IPs
                </span>
              </>
            ),
          }))}
        />
      </div>
      <NginxTable
        title="Clients"
        testId="nginx-clients-table"
        total={result.clientCount}
        rows={filtered}
        columns={columns}
        minWidth={980}
        defaultSort={{ id: "count", dir: "desc" }}
        searchText={(row) =>
          `${row.value} ${row.location.length === 2 ? countryName(row.location) : ""} ${row.org ?? ""} ${row.asn ?? ""}`
        }
        searchPlaceholder="Filter IP, country, network…"
        toolbar={
          selection && (
            <SelectionChip
              label={
                selection.panel === "country" ? (
                  <LocationLabel code={selection.key} />
                ) : (
                  selection.key
                )
              }
              onClear={() => setSelection(null)}
            />
          )
        }
      />
    </div>
  );
}
