import type { AggregatedEndpoint, CronAggregated } from "../parser";
import type { ApiSortKey, CronSortKey } from "../store/analysisStore";
import { formatMs, formatNum } from "./format";
import type ExcelJS from "exceljs";

const MS_FMT = '#,##0.0" ms"';
const TABLE_HEADER_ROW = 4; // title, meta, spacer, then header

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

const METHOD_OTHER = { argb: "FFFEF3C7", text: "FF92400E" };

function methodFill(method: string) {
  return METHOD_FILL[method] ?? METHOD_OTHER;
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
        formulae: [0],
        priority: 1,
        style: {
          font: { bold: true, color: { argb: "FFDC2626" } },
        },
      },
    ],
  });
}

function applyMsFmt(ws: ExcelJS.Worksheet, cols: number[], rowCount: number) {
  for (let i = 0; i < rowCount; i++) {
    const row = TABLE_HEADER_ROW + 1 + i;
    for (const col of cols) {
      ws.getCell(row, col).numFmt = MS_FMT;
    }
  }
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

  const generated = new Date().toLocaleString();
  styleTitleMeta(
    ws,
    9,
    "PM2 Log Analyzer — API Endpoints",
    `Generated: ${generated}  |  Endpoints: ${rows.length}  |  Sorted by: ${API_SORT_LABEL[sortKey]} (desc)`,
  );

  const tableRows = rows.map((r) => [
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

  applyMethodBadges(ws, rows.length);
  applyMsFmt(ws, [4, 5, 6, 7, 8], rows.length);
  highlightErrors(ws, "I", rows.length);
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

  const generated = new Date().toLocaleString();
  styleTitleMeta(
    ws,
    11,
    "PM2 Log Analyzer — Cron Jobs",
    `Generated: ${generated}  |  Jobs: ${rows.length}  |  Sorted by: ${CRON_SORT_LABEL[sortKey]} (desc)`,
  );

  const tableRows = rows.map((r) => [
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

  applyMsFmt(ws, [5, 6, 7, 8, 9, 11], rows.length);
  highlightErrors(ws, "D", rows.length);
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
): Promise<void> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = "PM2 Log Analyzer";
  wb.created = new Date();
  wb.title = "PM2 Log Analyzer Report";

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
