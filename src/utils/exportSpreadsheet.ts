import type { AggregatedEndpoint, CronAggregated, HourlyBucket, LogSummary } from "../parser";
import type { ApiSortKey, CronSortKey } from "../store/analysisStore";
import { formatMs, formatNum } from "./format";
import { generateAllChartImages } from "./chartRenderer";
import type ExcelJS from "exceljs";

const MS_FMT = '#,##0.0" ms"';
const TABLE_HEADER_ROW = 4;

const API_SORT_LABEL: Record<ApiSortKey, string> = {
  p95Ms: "p95",
  p99Ms: "p99",
  avgMs: "avg",
  maxMs: "max",
  count: "count",
  errorCount: "errors",
};

const CRON_SORT_LABEL: Record<CronSortKey, string> = {
  p95Ms: "p95",
  p99Ms: "p99",
  avgMs: "avg",
  maxMs: "max",
  runs: "runs",
  fails: "fails",
};

const METHOD_FILL: Record<string, { argb: string; text: string }> = {
  GET: { argb: "FFDBEAFE", text: "FF1E40AF" },
  POST: { argb: "FFD1FAE5", text: "FF065F46" },
};

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

function applyMsFmt(ws: ExcelJS.Worksheet, cols: number[], rowCount: number) {
  for (let i = 0; i < rowCount; i++) {
    const row = TABLE_HEADER_ROW + 1 + i;
    cols.forEach((col) => {
      ws.getCell(row, col).numFmt = MS_FMT;
    });
  }
}

function applyDataBars(
  ws: ExcelJS.Worksheet,
  colLetter: string,
  rowCount: number,
  colorArgb: string,
) {
  if (rowCount <= 0) return;
  const start = TABLE_HEADER_ROW + 1;
  const end = TABLE_HEADER_ROW + rowCount;
  ws.addConditionalFormatting({
    ref: `${colLetter}${start}:${colLetter}${end}`,
    rules: [
      {
        type: "dataBar",
        priority: 1,
        cfvo: [{ type: "min" }, { type: "max" }],
        color: { argb: colorArgb },
      } as unknown as ExcelJS.ConditionalFormattingRule,
    ],
  });
}

function highlightErrors(ws: ExcelJS.Worksheet, colLetter: string, rowCount: number) {
  if (rowCount === 0) return;
  ws.addConditionalFormatting({
    ref: `${colLetter}${TABLE_HEADER_ROW + 1}:${colLetter}${TABLE_HEADER_ROW + rowCount}`,
    rules: [
      {
        type: "cellIs",
        operator: "greaterThan",
        formulae: [0],
        priority: 1,
        style: { font: { bold: true, color: { argb: "FFDC2626" } } },
      },
    ],
  });
}

async function buildVisualAnalyticsSheet(
  wb: ExcelJS.Workbook,
  apiRows: AggregatedEndpoint[],
  hourlyStats: HourlyBucket[],
  summary?: LogSummary | null,
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

  const generated = new Date().toLocaleString();
  const totalCount = summary?.matched ?? apiRows.reduce((acc, r) => acc + r.count, 0);
  const totalErrors = summary?.errors ?? apiRows.reduce((acc, r) => acc + r.errorCount, 0);
  const errorRate = totalCount > 0 ? ((totalErrors / totalCount) * 100).toFixed(2) : "0.00";

  styleTitleMeta(
    ws,
    15,
    "PM2 Log Analyzer — Visual Analytics & Charts",
    `Generated: ${generated}  |  Total Requests: ${formatNum(totalCount)}  |  Endpoints: ${apiRows.length}`,
  );

  const kpis = [
    ["Total Requests", totalCount],
    ["Total Errors", totalErrors],
    ["Error Rate", `${errorRate}%`],
    ["Avg Latency", formatMs(summary?.avg ?? 0)],
    ["P95 Latency", formatMs(summary?.p95Ms ?? 0)],
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

  const chartImages = await generateAllChartImages(apiRows, hourlyStats);

  const addChart = (img?: string, col = 0, row = 7) => {
    if (!img) return;
    const imgId = wb.addImage({ base64: img, extension: "png" });
    ws.addImage(imgId, { tl: { col, row }, ext: { width: 600, height: 320 } });
  };

  addChart(chartImages.timeVsLatency, 0, 7);
  addChart(chartImages.hourlyVolume, 8, 7);
  addChart(chartImages.distribution, 0, 27);
}

function buildHourlyAndDistributionSheet(
  wb: ExcelJS.Workbook,
  hourlyStats: HourlyBucket[],
  apiRows: AggregatedEndpoint[],
) {
  if (!hourlyStats.length && !apiRows.length) return;
  const ws = wb.addWorksheet("Hourly & Distribution", {
    views: [{ state: "frozen", ySplit: TABLE_HEADER_ROW }],
  });
  ws.columns = Array(6)
    .fill({ width: 15 })
    .concat([{ width: 6 }, { width: 18 }, { width: 18 }]);

  styleTitleMeta(
    ws,
    9,
    "PM2 Log Analyzer — Hourly Trends & Distribution Data",
    `Generated: ${new Date().toLocaleString()}`,
  );

  if (hourlyStats.length > 0) {
    ws.addTable({
      name: "HourlyTrends",
      ref: `A${TABLE_HEADER_ROW}`,
      headerRow: true,
      totalsRow: true,
      style: { theme: "TableStyleMedium2", showRowStripes: true },
      columns: [
        { name: "Hour", totalsRowLabel: "Total" },
        { name: "Total Requests", totalsRowFunction: "sum" },
        { name: "Avg Latency" },
        { name: "P95 Latency" },
        { name: "P99 Latency" },
        { name: "Errors", totalsRowFunction: "sum" },
      ],
      rows: hourlyStats.map((h) => [h.label, h.count, h.avgMs, h.p95Ms, h.p99Ms, h.errorCount]),
    });
    applyMsFmt(ws, [3, 4, 5], hourlyStats.length);
    highlightErrors(ws, "F", hourlyStats.length);
    applyDataBars(ws, "B", hourlyStats.length, "FF3B82F6");
    applyDataBars(ws, "D", hourlyStats.length, "FF7C3AED");
    applyDataBars(ws, "F", hourlyStats.length, "FFEF4444");
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
      { name: "Latency Range", totalsRowLabel: "Total" },
      { name: "Request Count", totalsRowFunction: "sum" },
    ],
    rows: buckets.map((b) => [b.label, b.count]),
  });
  applyDataBars(ws, "I", buckets.length, "FF2563EB");
}

function buildApiSheet(wb: ExcelJS.Workbook, rows: AggregatedEndpoint[], sortKey: ApiSortKey) {
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
    `Generated: ${new Date().toLocaleString()}  |  Sorted by: ${API_SORT_LABEL[sortKey]} (desc)`,
  );

  ws.addTable({
    name: "ApiEndpoints",
    ref: `A${TABLE_HEADER_ROW}`,
    headerRow: true,
    totalsRow: true,
    style: { theme: "TableStyleMedium2", showRowStripes: true },
    columns: [
      { name: "Method", totalsRowLabel: "Total" },
      { name: "Endpoint" },
      { name: "Count", totalsRowFunction: "sum" },
      { name: "Avg" },
      { name: "p95" },
      { name: "p99" },
      { name: "Max" },
      { name: "Min" },
      { name: "Errors", totalsRowFunction: "sum" },
    ],
    rows: rows.map((r) => [
      r.method,
      r.path,
      r.count,
      r.avgMs,
      r.p95Ms,
      r.p99Ms,
      r.maxMs,
      r.minMs,
      r.errorCount,
    ]),
  });

  for (let i = 0; i < rows.length; i++) {
    const cell = ws.getCell(TABLE_HEADER_ROW + 1 + i, 1);
    const fill = METHOD_FILL[String(cell.value ?? "")] ?? { argb: "FFFEF3C7", text: "FF92400E" };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill.argb } };
    cell.font = { name: "Calibri", size: 11, bold: true, color: { argb: fill.text } };
    cell.alignment = { horizontal: "center", vertical: "middle" };
  }

  applyMsFmt(ws, [4, 5, 6, 7, 8], rows.length);
  highlightErrors(ws, "I", rows.length);
  applyDataBars(ws, "C", rows.length, "FF3B82F6");
  applyDataBars(ws, "E", rows.length, "FF7C3AED");
  applyDataBars(ws, "I", rows.length, "FFEF4444");
}

function buildCronSheet(wb: ExcelJS.Workbook, rows: CronAggregated[], sortKey: CronSortKey) {
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
    `Generated: ${new Date().toLocaleString()}  |  Sorted by: ${CRON_SORT_LABEL[sortKey]} (desc)`,
  );

  ws.addTable({
    name: "CronJobs",
    ref: `A${TABLE_HEADER_ROW}`,
    headerRow: true,
    totalsRow: true,
    style: { theme: "TableStyleMedium2", showRowStripes: true },
    columns: [
      { name: "Cron Job", totalsRowLabel: "Total" },
      { name: "Runs", totalsRowFunction: "sum" },
      { name: "Starts", totalsRowFunction: "sum" },
      { name: "Fails", totalsRowFunction: "sum" },
      { name: "Avg" },
      { name: "p95" },
      { name: "p99" },
      { name: "Max" },
      { name: "Min" },
      { name: "Last Run" },
      { name: "Last Duration" },
    ],
    rows: rows.map((r) => [
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
    ]),
  });

  applyMsFmt(ws, [5, 6, 7, 8, 9, 11], rows.length);
  highlightErrors(ws, "D", rows.length);
  applyDataBars(ws, "B", rows.length, "FF3B82F6");
  applyDataBars(ws, "D", rows.length, "FFEF4444");
  applyDataBars(ws, "F", rows.length, "FF7C3AED");
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
  sort: { api: ApiSortKey; cron: CronSortKey },
  hourlyStats: HourlyBucket[] = [],
  summary?: LogSummary | null,
): Promise<void> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = "PM2 Log Analyzer";
  wb.created = new Date();
  wb.title = "PM2 Log Analyzer Report";

  await buildVisualAnalyticsSheet(wb, apiRows, hourlyStats, summary);
  buildHourlyAndDistributionSheet(wb, hourlyStats, apiRows);
  buildApiSheet(wb, apiRows, sort.api);
  if (cronRows.length > 0) buildCronSheet(wb, cronRows, sort.cron);

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
