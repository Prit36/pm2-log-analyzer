import type { AggregatedEndpoint, CronAggregated } from "../parser";
import { useAnalysisStore } from "../store/analysisStore";
import { formatMs, formatNum } from "./format";

export function buildApiTsv(rows: AggregatedEndpoint[]): string {
  const h = ["Method", "Endpoint", "Count", "Avg", "p95", "p99", "Max", "Min", "Errors"];
  return [
    h.join("\t"),
    ...rows.map((r) =>
      [
        r.method,
        r.path,
        formatNum(r.count),
        formatMs(r.avgMs),
        formatMs(r.p95Ms),
        formatMs(r.p99Ms),
        formatMs(r.maxMs),
        formatMs(r.minMs),
        formatNum(r.errorCount),
      ].join("\t"),
    ),
  ].join("\r\n");
}

export function buildCronTsv(rows: CronAggregated[]): string {
  const h = [
    "Cron Job",
    "Runs",
    "Starts",
    "Fails",
    "Avg",
    "p95",
    "p99",
    "Max",
    "Min",
    "Last Run",
    "Last Duration",
  ];
  return [
    h.join("\t"),
    ...rows.map((r) =>
      [
        r.name,
        formatNum(r.runs),
        formatNum(r.starts),
        formatNum(r.fails),
        formatMs(r.avgMs),
        formatMs(r.p95Ms),
        formatMs(r.p99Ms),
        formatMs(r.maxMs),
        formatMs(r.minMs),
        r.lastRunTs ?? "-",
        r.lastDurationMs !== undefined ? formatMs(r.lastDurationMs) : "-",
      ].join("\t"),
    ),
  ].join("\r\n");
}

export async function downloadExcel(
  apiRows: AggregatedEndpoint[],
  cronRows: CronAggregated[],
  sort: {
    api: import("../store/analysisStore").ApiSortKey;
    cron: import("../store/analysisStore").CronSortKey;
  },
  hourlyStats: import("../parser").HourlyBucket[] = [],
  summary?: import("../parser").LogSummary | null,
  dailyStats: import("../parser").DaySummary[] = [],
  dateFilter?: string | null,
  theme: import("../store/analysisStore").Theme = "light",
): Promise<void> {
  const { buildExcelBlob } = await import("./xlsxGenerator");
  const blob = await buildExcelBlob(
    apiRows,
    cronRows,
    sort,
    hourlyStats,
    summary,
    dailyStats,
    dateFilter,
    theme,
  );
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `pm2-analyzer-report-${ts}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function exportSpreadsheetData(
  explicitApiRows?: AggregatedEndpoint[],
  explicitCronRows?: CronAggregated[],
) {
  const state = useAnalysisStore.getState();
  const api = explicitApiRows ?? state.result?.api ?? [];
  const cron = explicitCronRows ?? state.result?.cron ?? [];
  if (api.length === 0 && cron.length === 0) {
    state.showToast("Nothing to export yet");
    return;
  }
  const { sortKey: apiSortKey, cronSortKey, dateFilter } = state.filters;
  const summary = state.result?.summary;
  const hourlyStats = state.result?.hourlyStats;
  const dailyStats = state.result?.dailyStats;
  const theme = state.theme ?? "light";
  try {
    await downloadExcel(
      api,
      cron,
      { api: apiSortKey, cron: cronSortKey },
      hourlyStats,
      summary,
      dailyStats,
      dateFilter,
      theme,
    );
    state.showToast(
      cron.length > 0
        ? "Excel downloaded — Visual Analytics + Data sheets"
        : "Excel downloaded — Visual Analytics + API sheets",
    );
  } catch {
    state.showToast("Excel export failed");
  }
}
