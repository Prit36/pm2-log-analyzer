import type {
  AggregatedEndpoint,
  CronAggregated,
  DaySummary,
  HourlyBucket,
  LogSummary,
} from "../parser";
import {
  useAnalysisStore,
  type AnalysisFilters,
  type ApiSortKey,
  type CronSortKey,
  type SortDirection,
} from "../store/analysisStore";
import { generateAllChartImages } from "./chartRenderer";
import { formatBytes, formatDate, formatMs, formatNum } from "./format";
import type ExcelJS from "exceljs";

export function sortApiEndpoints(
  rows: AggregatedEndpoint[],
  sortKey: ApiSortKey,
  sortDir: SortDirection = "desc",
): AggregatedEndpoint[] {
  return [...rows].sort((a, b) => {
    let cmp = 0;
    if (sortKey === "path") {
      cmp = a.path.localeCompare(b.path);
    } else {
      cmp = (a[sortKey] ?? 0) - (b[sortKey] ?? 0);
    }
    return sortDir === "asc" ? cmp : -cmp;
  });
}

export function filterApiEndpoints(
  rows: AggregatedEndpoint[],
  methods: string[],
  query: string,
): AggregatedEndpoint[] {
  const methodSet = methods.length > 0 ? new Set(methods) : null;
  const q = query.trim().toLowerCase();
  let result = rows;
  if (methodSet) result = result.filter((r) => methodSet.has(r.method));
  if (q) {
    result = result.filter(
      (r) => r.path.toLowerCase().includes(q) || r.key.toLowerCase().includes(q),
    );
  }
  return result;
}

export function sortCronJobs(
  rows: CronAggregated[],
  sortKey: CronSortKey,
  sortDir: SortDirection = "desc",
): CronAggregated[] {
  return [...rows].sort((a, b) => {
    let cmp = 0;
    if (sortKey === "name") {
      cmp = a.name.localeCompare(b.name);
    } else {
      const valA = a[sortKey] ?? (sortDir === "asc" ? Infinity : -Infinity);
      const valB = b[sortKey] ?? (sortDir === "asc" ? Infinity : -Infinity);
      cmp = valA - valB;
    }
    return sortDir === "asc" ? cmp : -cmp;
  });
}

const MS_FMT = '#,##0.0" ms"';
const TABLE_HEADER_ROW = 4;

const API_SORT_LABEL = {
  p95Ms: "p95",
  p99Ms: "p99",
  avgMs: "avg",
  maxMs: "max",
  count: "count",
  errorCount: "errors",
  path: "endpoint",
} satisfies Record<ApiSortKey, string>;

const CRON_SORT_LABEL = {
  p95Ms: "p95",
  p99Ms: "p99",
  avgMs: "avg",
  maxMs: "max",
  runs: "runs",
  fails: "fails",
  starts: "starts",
  lastDurationMs: "last duration",
  name: "job",
} satisfies Record<CronSortKey, string>;

type MethodStyle = { argb: string; text: string };
type MethodFillMap = { readonly GET: MethodStyle; readonly POST: MethodStyle };

const METHOD_FILL = {
  GET: { argb: "FFDBEAFE", text: "FF1E40AF" },
  POST: { argb: "FFD1FAE5", text: "FF065F46" },
} satisfies MethodFillMap;

const METHOD_OTHER: MethodStyle = { argb: "FFFEF3C7", text: "FF92400E" };

function methodFill(method: string): MethodStyle {
  if (method === "GET") return METHOD_FILL.GET;
  if (method === "POST") return METHOD_FILL.POST;
  return METHOD_OTHER;
}

function styleTitleMeta(ws: ExcelJS.Worksheet, lastCol: number, title: string, meta: string) {
  ws.mergeCells(1, 1, 1, lastCol);
  const titleCell = ws.getCell(1, 1);
  titleCell.value = title;
  titleCell.font = { name: "Calibri", size: 16, bold: true, color: { argb: "FF0F172A" } };
  titleCell.alignment = { horizontal: "left", vertical: "middle" };
  ws.getRow(1).height = 28;

  ws.mergeCells(2, 1, 2, lastCol);
  const metaCell = ws.getCell(2, 1);
  metaCell.value = meta;
  metaCell.font = { name: "Calibri", size: 11, color: { argb: "FF475569" } };
  metaCell.alignment = { horizontal: "left", vertical: "middle" };
  ws.getRow(2).height = 18;
  ws.getRow(3).height = 8;
}

function applyMethodBadges(ws: ExcelJS.Worksheet, rowCount: number, col = 1) {
  for (let i = 0; i < rowCount; i++) {
    const cell = ws.getCell(TABLE_HEADER_ROW + 1 + i, col);
    const method = String(cell.value ?? "");
    const fill = methodFill(method);
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill.argb } };
    cell.font = { name: "Calibri", size: 11, bold: true, color: { argb: fill.text } };
    cell.alignment = { horizontal: "center", vertical: "middle" };
  }
}

function applyMsFmt(ws: ExcelJS.Worksheet, cols: number[], rowCount: number) {
  for (let i = 0; i < rowCount; i++) {
    const row = TABLE_HEADER_ROW + 1 + i;
    for (const col of cols) {
      ws.getCell(row, col).numFmt = MS_FMT;
    }
  }
}

function highlightErrors(ws: ExcelJS.Worksheet, colLetter: string, rowCount: number) {
  if (rowCount === 0) return;
  const start = TABLE_HEADER_ROW + 1;
  const end = TABLE_HEADER_ROW + rowCount;
  ws.addConditionalFormatting({
    ref: `${colLetter}${start}:${colLetter}${end}`,
    rules: [
      {
        type: "cellIs",
        operator: "greaterThan",
        formulae: ["0"],
        priority: 1,
        style: { font: { bold: true, color: { argb: "FFDC2626" } } },
      },
    ],
  });
}

function buildApiFilterMeta(
  filters?: Partial<AnalysisFilters>,
  sortKey?: ApiSortKey,
  sortDir: SortDirection = "desc",
  endpointCount?: number,
  sourceLabel?: string | null,
): string {
  const parts: string[] = [`Generated: ${new Date().toLocaleString()}`];
  if (sourceLabel) parts.push(`Source: ${sourceLabel}`);
  if (endpointCount !== undefined) parts.push(`Endpoints: ${endpointCount}`);
  if (sortKey) parts.push(`Sorted by: ${API_SORT_LABEL[sortKey]} (${sortDir})`);
  if (filters?.dateFilter && filters.dateFilter !== "all") {
    parts.push(`Day: ${formatDate(filters.dateFilter)}`);
  }
  if (filters?.methods && filters.methods.length > 0) {
    parts.push(`Methods: ${filters.methods.join(", ")}`);
  }
  if (filters?.query?.trim()) {
    parts.push(`Search: "${filters.query.trim()}"`);
  }
  if (filters?.statusFamily && filters.statusFamily !== "all") {
    parts.push(`Status: ${filters.statusFamily}`);
  }
  if (filters?.minMs && filters.minMs > 0) {
    parts.push(`Min Latency: ≥${filters.minMs}ms`);
  }
  if (filters?.normalizeMode && filters.normalizeMode !== "collapseIds") {
    parts.push(
      `Normalize: ${filters.normalizeMode === "stripQuery" ? "Strip query" : "Exact path"}`,
    );
  }
  return parts.join("  |  ");
}

function buildCronFilterMeta(
  filters?: Partial<AnalysisFilters>,
  sortKey?: CronSortKey,
  sortDir: SortDirection = "desc",
  jobCount?: number,
  sourceLabel?: string | null,
): string {
  const parts: string[] = [`Generated: ${new Date().toLocaleString()}`];
  if (sourceLabel) parts.push(`Source: ${sourceLabel}`);
  if (jobCount !== undefined) parts.push(`Jobs: ${jobCount}`);
  if (sortKey) parts.push(`Sorted by: ${CRON_SORT_LABEL[sortKey]} (${sortDir})`);
  if (filters?.cronQuery?.trim()) {
    parts.push(`Search: "${filters.cronQuery.trim()}"`);
  }
  if (filters?.cronMinMs && filters.cronMinMs > 0) {
    parts.push(`Min Duration: ≥${filters.cronMinMs}ms`);
  }
  if (filters?.cronShowFailedOnly) {
    parts.push("Filter: Failures only");
  }
  if (filters?.dateFilter && filters.dateFilter !== "all") {
    parts.push(`Day: ${formatDate(filters.dateFilter)}`);
  }
  return parts.join("  |  ");
}

function buildApiSheet(
  wb: ExcelJS.Workbook,
  rows: AggregatedEndpoint[],
  sortKey: ApiSortKey,
  sortDir: SortDirection = "desc",
  filters?: Partial<AnalysisFilters>,
  sourceLabel?: string | null,
) {
  const sortedRows = sortApiEndpoints(rows, sortKey, sortDir);
  const ws = wb.addWorksheet("API Endpoints", {
    views: [{ state: "frozen", ySplit: TABLE_HEADER_ROW }],
  });
  ws.columns = [
    { width: 10 },
    { width: 48 },
    { width: 10 },
    { width: 12 },
    { width: 12 },
    { width: 12 },
    { width: 12 },
    { width: 12 },
    { width: 10 },
  ];

  styleTitleMeta(
    ws,
    9,
    "PM2 Log Analyzer — API Endpoints",
    buildApiFilterMeta(filters, sortKey, sortDir, sortedRows.length, sourceLabel),
  );

  const tableRows = sortedRows.map((r) => [
    r.method,
    r.path,
    r.count,
    r.avgMs,
    r.p95Ms,
    r.p99Ms,
    r.maxMs,
    r.minMs,
    r.errorCount,
  ]);

  ws.addTable({
    name: "ApiEndpoints",
    ref: `A${TABLE_HEADER_ROW}`,
    headerRow: true,
    totalsRow: true,
    style: { theme: "TableStyleMedium2", showRowStripes: true },
    columns: [
      { name: "Method", filterButton: true, totalsRowLabel: "Total" },
      { name: "Endpoint", filterButton: true },
      { name: "Count", filterButton: true, totalsRowFunction: "sum" },
      { name: "Avg", filterButton: true },
      { name: "p95", filterButton: true },
      { name: "p99", filterButton: true },
      { name: "Max", filterButton: true },
      { name: "Min", filterButton: true },
      { name: "Errors", filterButton: true, totalsRowFunction: "sum" },
    ],
    rows: tableRows,
  });

  applyMethodBadges(ws, sortedRows.length);
  applyMsFmt(ws, [4, 5, 6, 7, 8], sortedRows.length);
  highlightErrors(ws, "I", sortedRows.length);
}

function buildDailySummarySheet(
  wb: ExcelJS.Workbook,
  dailyStats: DaySummary[],
  sourceLabel?: string | null,
) {
  if (!dailyStats.length) return;
  const ws = wb.addWorksheet("Daily Summary", {
    views: [{ state: "frozen", ySplit: TABLE_HEADER_ROW }],
  });
  ws.columns = [
    { width: 16 },
    { width: 14 },
    { width: 14 },
    { width: 14 },
    { width: 14 },
    { width: 14 },
    { width: 12 },
    { width: 14 },
  ];

  const metaParts = [`Generated: ${new Date().toLocaleString()}`];
  if (sourceLabel) metaParts.push(`Source: ${sourceLabel}`);
  metaParts.push(`Days: ${dailyStats.length}`);

  styleTitleMeta(ws, 8, "PM2 Log Analyzer — Daily Summary", metaParts.join("  |  "));

  const tableRows = dailyStats.map((d) => [
    formatDate(d.date),
    d.count,
    d.avgMs,
    d.p95Ms,
    d.p99Ms,
    d.maxMs,
    d.errorCount,
    d.slowCount,
  ]);

  ws.addTable({
    name: "DailySummary",
    ref: `A${TABLE_HEADER_ROW}`,
    headerRow: true,
    totalsRow: true,
    style: { theme: "TableStyleMedium2", showRowStripes: true },
    columns: [
      { name: "Date", filterButton: true, totalsRowLabel: "Total" },
      { name: "Requests", filterButton: true, totalsRowFunction: "sum" },
      { name: "Avg", filterButton: true },
      { name: "P95", filterButton: true },
      { name: "P99", filterButton: true },
      { name: "Max", filterButton: true },
      { name: "Errors", filterButton: true, totalsRowFunction: "sum" },
      { name: "Slow (≥3s)", filterButton: true, totalsRowFunction: "sum" },
    ],
    rows: tableRows,
  });

  applyMsFmt(ws, [3, 4, 5, 6], dailyStats.length);
  highlightErrors(ws, "G", dailyStats.length);
}

function buildCronSheet(
  wb: ExcelJS.Workbook,
  rows: CronAggregated[],
  sortKey: CronSortKey,
  sortDir: SortDirection = "desc",
  filters?: Partial<AnalysisFilters>,
  sourceLabel?: string | null,
) {
  const sortedRows = sortCronJobs(rows, sortKey, sortDir);
  const ws = wb.addWorksheet("Cron Jobs", {
    views: [{ state: "frozen", ySplit: TABLE_HEADER_ROW }],
  });
  ws.columns = [
    { width: 40 },
    { width: 10 },
    { width: 10 },
    { width: 10 },
    { width: 12 },
    { width: 12 },
    { width: 12 },
    { width: 12 },
    { width: 12 },
    { width: 22 },
    { width: 14 },
  ];

  styleTitleMeta(
    ws,
    11,
    "PM2 Log Analyzer — Cron Jobs",
    buildCronFilterMeta(filters, sortKey, sortDir, sortedRows.length, sourceLabel),
  );

  const tableRows = sortedRows.map((r) => [
    r.name,
    r.runs,
    r.starts,
    r.fails,
    r.avgMs,
    r.p95Ms,
    r.p99Ms,
    r.maxMs,
    r.minMs,
    r.lastRunTs ?? "-",
    r.lastDurationMs ?? null,
  ]);

  ws.addTable({
    name: "CronJobs",
    ref: `A${TABLE_HEADER_ROW}`,
    headerRow: true,
    totalsRow: true,
    style: { theme: "TableStyleMedium2", showRowStripes: true },
    columns: [
      { name: "Cron Job", filterButton: true, totalsRowLabel: "Total" },
      { name: "Runs", filterButton: true, totalsRowFunction: "sum" },
      { name: "Starts", filterButton: true, totalsRowFunction: "sum" },
      { name: "Fails", filterButton: true, totalsRowFunction: "sum" },
      { name: "Avg", filterButton: true },
      { name: "p95", filterButton: true },
      { name: "p99", filterButton: true },
      { name: "Max", filterButton: true },
      { name: "Min", filterButton: true },
      { name: "Last Run", filterButton: true },
      { name: "Last Duration", filterButton: true },
    ],
    rows: tableRows,
  });

  applyMsFmt(ws, [5, 6, 7, 8, 9, 11], sortedRows.length);
  highlightErrors(ws, "D", sortedRows.length);
}

function buildHourlyAndDistributionSheet(
  wb: ExcelJS.Workbook,
  hourlyStats: HourlyBucket[],
  apiRows: AggregatedEndpoint[],
  filters?: Partial<AnalysisFilters>,
  sourceLabel?: string | null,
) {
  if (!hourlyStats.length && !apiRows.length) return;
  const ws = wb.addWorksheet("Hourly & Distribution", {
    views: [{ state: "frozen", ySplit: TABLE_HEADER_ROW }],
  });
  ws.columns = Array(6)
    .fill({ width: 15 })
    .concat([{ width: 6 }, { width: 18 }, { width: 18 }]);

  const metaParts = [`Generated: ${new Date().toLocaleString()}`];
  if (sourceLabel) metaParts.push(`Source: ${sourceLabel}`);
  if (filters?.dateFilter && filters.dateFilter !== "all") {
    metaParts.push(`Day: ${formatDate(filters.dateFilter)}`);
  }

  styleTitleMeta(
    ws,
    9,
    "PM2 Log Analyzer — Hourly Trends & Distribution Data",
    metaParts.join("  |  "),
  );

  if (hourlyStats.length > 0) {
    ws.addTable({
      name: "HourlyTrends",
      ref: `A${TABLE_HEADER_ROW}`,
      headerRow: true,
      totalsRow: true,
      style: { theme: "TableStyleMedium2", showRowStripes: true },
      columns: [
        { name: "Hour", filterButton: true, totalsRowLabel: "Total" },
        { name: "Total Requests", filterButton: true, totalsRowFunction: "sum" },
        { name: "Avg Latency", filterButton: true },
        { name: "P95 Latency", filterButton: true },
        { name: "P99 Latency", filterButton: true },
        { name: "Errors", filterButton: true, totalsRowFunction: "sum" },
      ],
      rows: hourlyStats.map((h) => [h.label, h.count, h.avgMs, h.p95Ms, h.p99Ms, h.errorCount]),
    });
    applyMsFmt(ws, [3, 4, 5], hourlyStats.length);
    highlightErrors(ws, "F", hourlyStats.length);
  }

  const buckets = [
    { label: "<50ms", count: 0 },
    { label: "50-100ms", count: 0 },
    { label: "100-300ms", count: 0 },
    { label: "300-500ms", count: 0 },
    { label: "500ms-1s", count: 0 },
    { label: "1s-3s", count: 0 },
    { label: ">3s", count: 0 },
  ];
  const classify = (ms: number) =>
    ms < 50 ? 0 : ms < 100 ? 1 : ms < 300 ? 2 : ms < 500 ? 3 : ms < 1000 ? 4 : ms < 3000 ? 5 : 6;

  for (const r of apiRows) {
    if (r.count <= 0) continue;
    const c50 = Math.round(r.count * 0.5);
    const c90 = Math.round(r.count * 0.4);
    const c95 = Math.round(r.count * 0.05);
    const c99 = Math.round(r.count * 0.04);
    const cMax = Math.max(0, r.count - c50 - c90 - c95 - c99);
    buckets[classify(r.p50Ms)]!.count += c50;
    buckets[classify((r.p50Ms + r.p90Ms) / 2)]!.count += c90;
    buckets[classify((r.p90Ms + r.p95Ms) / 2)]!.count += c95;
    buckets[classify((r.p95Ms + r.p99Ms) / 2)]!.count += c99;
    buckets[classify(r.maxMs)]!.count += cMax;
  }

  ws.addTable({
    name: "LatencyDistribution",
    ref: `H${TABLE_HEADER_ROW}`,
    headerRow: true,
    totalsRow: true,
    style: { theme: "TableStyleMedium2", showRowStripes: true },
    columns: [
      { name: "Latency Range", filterButton: true, totalsRowLabel: "Total" },
      { name: "Request Count", filterButton: true, totalsRowFunction: "sum" },
    ],
    rows: buckets.map((b) => [b.label, b.count]),
  });
}

async function buildVisualAnalyticsSheet(
  wb: ExcelJS.Workbook,
  apiRows: AggregatedEndpoint[],
  hourlyStats: HourlyBucket[],
  summary?: LogSummary | null,
  dailyStats: DaySummary[] = [],
  filters?: Partial<AnalysisFilters>,
  sourceLabel?: string | null,
) {
  const ws = wb.addWorksheet("Visual Analytics");
  ws.columns = [
    { width: 13 },
    { width: 13 },
    { width: 13 },
    { width: 13 },
    { width: 13 },
    { width: 13 },
    { width: 13 },
    { width: 4 }, // Col H Spacer
    { width: 13 },
    { width: 13 },
    { width: 13 },
    { width: 13 },
    { width: 13 },
    { width: 13 },
    { width: 13 },
  ];

  const metaParts = [`Generated: ${new Date().toLocaleString()}`];
  if (sourceLabel) metaParts.push(`Source: ${sourceLabel}`);
  if (filters?.dateFilter && filters.dateFilter !== "all") {
    metaParts.push(`Day: ${formatDate(filters.dateFilter)}`);
  }
  if (filters?.methods && filters.methods.length > 0) {
    metaParts.push(`Methods: ${filters.methods.join(", ")}`);
  }
  if (filters?.query?.trim()) {
    metaParts.push(`Search: "${filters.query.trim()}"`);
  }

  const isFiltered =
    Boolean(filters?.methods && filters.methods.length > 0) || Boolean(filters?.query?.trim());
  const totalCount = isFiltered
    ? apiRows.reduce((acc, r) => acc + r.count, 0)
    : (summary?.matched ?? apiRows.reduce((acc, r) => acc + r.count, 0));
  const totalErrors = isFiltered
    ? apiRows.reduce((acc, r) => acc + r.errorCount, 0)
    : (summary?.errors ?? apiRows.reduce((acc, r) => acc + r.errorCount, 0));
  const errorRate = totalCount > 0 ? ((totalErrors / totalCount) * 100).toFixed(2) : "0.00";
  const avgMs = isFiltered
    ? totalCount > 0
      ? apiRows.reduce((acc, r) => acc + r.avgMs * r.count, 0) / totalCount
      : 0
    : (summary?.avg ?? 0);
  const p95Ms = isFiltered
    ? apiRows.length > 0
      ? Math.max(...apiRows.map((r) => r.p95Ms))
      : 0
    : (summary?.p95Ms ?? 0);

  metaParts.push(`Total Requests: ${formatNum(totalCount)}`);
  metaParts.push(`Endpoints: ${apiRows.length}`);

  styleTitleMeta(ws, 15, "PM2 Log Analyzer — Visual Analytics & Charts", metaParts.join("  |  "));

  const kpis = [
    ["Total Requests", totalCount],
    ["Total Errors", totalErrors],
    ["Error Rate", `${errorRate}%`],
    ["Avg Latency", formatMs(avgMs)],
    ["P95 Latency", formatMs(p95Ms)],
    ["Unique Endpoints", apiRows.length],
  ];

  ws.getRow(4).height = 20;
  ws.getRow(5).height = 24;
  kpis.forEach(([title, val], c) => {
    const hCell = ws.getCell(4, c + 1);
    hCell.value = title;
    hCell.font = { name: "Calibri", size: 10, bold: true, color: { argb: "FF475569" } };
    hCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F5F9" } };
    hCell.alignment = { horizontal: "center", vertical: "middle" };

    const vCell = ws.getCell(5, c + 1);
    vCell.value = val;
    vCell.font = { name: "Calibri", size: 12, bold: true, color: { argb: "FF0F172A" } };
    vCell.alignment = { horizontal: "center", vertical: "middle" };
  });

  const chartImages = await generateAllChartImages(apiRows, hourlyStats, dailyStats);

  const addChart = (img?: string, range = "A8:G24") => {
    if (!img) return;
    const cleanBase64 = img.replace(/^data:image\/\w+;base64,/, "");
    const imgId = wb.addImage({ base64: cleanBase64, extension: "png" });
    ws.addImage(imgId, range);
  };

  addChart(chartImages.timeVsLatency, "A8:G24");
  addChart(chartImages.hourlyVolume, "I8:P24");
  addChart(chartImages.distribution, "A27:G43");
  if (chartImages.dailyTrend) {
    addChart(chartImages.dailyTrend, "I27:P43");
  }
}

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
    api: ApiSortKey;
    cron: CronSortKey;
    apiDir?: SortDirection;
    cronDir?: SortDirection;
  },
  hourlyStats: HourlyBucket[] = [],
  summary?: LogSummary | null,
  dailyStats: DaySummary[] = [],
  filters?: Partial<AnalysisFilters>,
  sourceLabel?: string | null,
): Promise<void> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = "PM2 Log Analyzer";
  wb.created = new Date();
  wb.title = "PM2 Log Analyzer Report";
  if (sourceLabel) {
    wb.subject = sourceLabel;
    wb.description = `Source: ${sourceLabel}`;
  }

  // API Endpoints is the default / first tab
  buildApiSheet(wb, apiRows, sort.api, sort.apiDir ?? "desc", filters, sourceLabel);
  if (dailyStats.length > 1) buildDailySummarySheet(wb, dailyStats, sourceLabel);
  if (cronRows.length > 0)
    buildCronSheet(wb, cronRows, sort.cron, sort.cronDir ?? "desc", filters, sourceLabel);
  buildHourlyAndDistributionSheet(wb, hourlyStats, apiRows, filters, sourceLabel);
  // Analytics is the last tab
  await buildVisualAnalyticsSheet(
    wb,
    apiRows,
    hourlyStats,
    summary,
    dailyStats,
    filters,
    sourceLabel,
  );

  wb.views = [
    {
      x: 0,
      y: 0,
      width: 10000,
      height: 20000,
      firstSheet: 0,
      activeTab: 0,
      visibility: "visible",
    },
  ];

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
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
  const rawApi = state.result?.api ?? [];
  const filters = state.filters;
  const {
    sortKey: apiSortKey,
    sortDir: apiSortDir,
    cronSortKey,
    cronSortDir,
    methods,
    query,
  } = filters;
  const api = explicitApiRows ?? filterApiEndpoints(rawApi, methods, query);
  const cron = explicitCronRows ?? state.result?.cron ?? [];
  if (api.length === 0 && cron.length === 0) {
    state.showToast("Nothing to export yet");
    return;
  }
  const summary = state.result?.summary;
  const hourlyStats = state.result?.hourlyStats;
  const dailyStats = state.result?.dailyStats;
  const sourceLabel =
    state.sourceKind === "file" && state.fileName
      ? `${state.fileName}${state.fileSize != null ? ` (${formatBytes(state.fileSize)})` : ""}`
      : state.sourceKind === "paste"
        ? "Pasted text"
        : null;

  try {
    await downloadExcel(
      api,
      cron,
      {
        api: apiSortKey,
        cron: cronSortKey,
        apiDir: apiSortDir,
        cronDir: cronSortDir,
      },
      hourlyStats,
      summary,
      dailyStats,
      filters,
      sourceLabel,
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
