import type ExcelJS from "exceljs";
import { useNginxStore } from "../store/nginxStore";
import { getNginxExportResult } from "../hooks/useNginxParserWorker";
import type { NginxBreakdown, NginxHotspot, NginxLatency, NginxTimeBucket } from "./types";
import { countryName, useIpInfoStore } from "./ipLookup";
import { agentKindLabel, parseUserAgent } from "./userAgent";

const { showToast } = useNginxStore.getState();
const HEADER_ROW = 4;
const COUNT_FMT = "#,##0";
const MS_FMT = '#,##0.00" ms"';
const BYTE_FMT = '#,##0" B"';
const PERCENT_FMT = "0.0%";
const timeHeaders = [
  "Measured",
  "Avg ms",
  "Min ms",
  "Max ms",
  "p50 ms",
  "p90 ms",
  "p95 ms",
  "p99 ms",
];
let exporting = false;

type ExportCell = string | number | null;

function ratio(part: number, total: number): number {
  return total > 0 ? part / total : 0;
}

function timeValues(time: NginxLatency): ExportCell[] {
  return [
    time.count,
    time.avgMs,
    time.minMs,
    time.maxMs,
    time.p50Ms,
    time.p90Ms,
    time.p95Ms,
    time.p99Ms,
  ];
}

function columnWidth(header: string): number {
  if (["Path", "Referrer", "User agent", "Log line"].includes(header)) return 64;
  if (["Metric", "Country", "Network", "Client IP"].includes(header)) return 30;
  if (header === "Value") return 100;
  if (header === "Log-local time") return 24;
  if (header === "Method" || header === "Type") return 12;
  return 20;
}

function addSheet(
  workbook: ExcelJS.Workbook,
  name: string,
  note: string,
  headers: string[],
  rows: ExportCell[][],
): ExcelJS.Worksheet {
  const sheet = workbook.addWorksheet(name, {
    views: [
      {
        state: "frozen",
        ySplit: HEADER_ROW,
        xSplit: name === "Endpoints" ? 2 : 1,
        showGridLines: false,
      },
    ],
  });
  sheet.columns = headers.map((header) => ({ width: columnWidth(header) }));
  sheet.mergeCells(1, 1, 1, headers.length);
  sheet.getCell("A1").value = `Nginx Log Analyzer — ${name}`;
  sheet.getCell("A1").font = { name: "Calibri", size: 16, bold: true, color: { argb: "FF0F172A" } };
  sheet.getRow(1).height = 30;
  sheet.mergeCells(2, 1, 2, headers.length);
  sheet.getCell("A2").value = note;
  sheet.getCell("A2").font = { name: "Calibri", size: 11, color: { argb: "FF475569" } };
  sheet.getCell("A2").alignment = { wrapText: true, vertical: "middle" };
  sheet.getRow(2).height = 44;
  sheet.getRow(3).height = 8;
  sheet.addTable({
    name: `Nginx${name.replaceAll(" ", "")}`,
    ref: `A${HEADER_ROW}`,
    headerRow: true,
    style: { theme: "TableStyleMedium2", showRowStripes: true },
    columns: headers.map((header) => ({ name: header, filterButton: true })),
    rows,
  });
  sheet.getRow(HEADER_ROW).height = 32;
  sheet.getRow(HEADER_ROW).alignment = { wrapText: true, vertical: "middle" };
  for (let index = 0; index < headers.length; index++) {
    const header = headers[index]!;
    const column = sheet.getColumn(index + 1);
    column.numFmt = header.endsWith(" ms")
      ? MS_FMT
      : header.endsWith(" %")
        ? PERCENT_FMT
        : header === "Body bytes"
          ? BYTE_FMT
          : header === "ASN" || header === "HTTP status"
            ? "0"
            : COUNT_FMT;
    if (header === "Errors" || header === "Error %") {
      if (rows.length)
        sheet.addConditionalFormatting({
          ref: `${column.letter}${HEADER_ROW + 1}:${column.letter}${HEADER_ROW + rows.length}`,
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
  }
  for (let index = 0; index < rows.length; index++) {
    const row = sheet.getRow(HEADER_ROW + 1 + index);
    const lines = Math.max(
      1,
      ...rows[index]!.map((value, column) =>
        String(value ?? "")
          .split("\n")
          .reduce(
            (sum, line) =>
              sum + Math.max(1, Math.ceil(line.length / (columnWidth(headers[column]!) - 4))),
            0,
          ),
      ),
    );
    row.height = Math.min(409, Math.max(32, lines * 15 + 8));
    row.alignment = { vertical: "middle", wrapText: true };
    row.font = { name: "Calibri", size: 11 };
  }
  sheet.pageSetup = {
    orientation: "landscape",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    printTitlesRow: "1:4",
  };
  sheet.headerFooter.oddFooter = "&L Nginx Log Analyzer &R Page &P of &N";
  return sheet;
}

function breakdownRows(rows: NginxBreakdown[], total: number): ExportCell[][] {
  return rows.map((row) => [
    row.value,
    row.count,
    ratio(row.count, total),
    row.errorCount,
    ratio(row.errorCount, row.count),
    row.bodyBytes,
  ]);
}

function bucketRows(
  rows: NginxTimeBucket[],
  total: number,
  request: boolean,
  upstream: boolean,
): ExportCell[][] {
  return rows.map((row) => [
    row.label,
    row.count,
    ratio(row.count, total),
    row.errorCount,
    ratio(row.errorCount, row.count),
    row.bodyBytes,
    ...(request ? timeValues(row.requestTime) : []),
    ...(upstream ? timeValues(row.upstreamTime) : []),
  ]);
}

function hotspotRows(rows: NginxHotspot[], measured: boolean): ExportCell[][] {
  return rows.map((row) => [
    row.method,
    row.path,
    row.count,
    row.errorCount,
    ratio(row.errorCount, row.count),
    ...(measured ? [row.timedCount, row.avgMs, row.p95Ms] : []),
  ]);
}

export async function exportNginxSpreadsheet(): Promise<void> {
  const snapshot = useNginxStore.getState();
  if (!snapshot.result || snapshot.isParsing || exporting) return;
  exporting = true;
  showToast("Preparing Nginx spreadsheet…");
  try {
    const { filters, fileNames, sourceKind } = snapshot;
    const result = await getNginxExportResult(filters);
    if (!result) throw new Error("Analysis changed during export. Please export again.");
    const Excel = await import("exceljs");
    const workbook = new Excel.default.Workbook();
    const generated = new Date();
    workbook.creator = "Nginx Log Analyzer";
    workbook.created = generated;
    const s = result.summary;
    const request = s.requestTime.count > 0;
    const upstream = s.upstreamTime.count > 0;
    const selectedTiming = filters.metric === "request" ? request : upstream;
    const timingLabel = filters.metric === "request" ? "Request" : "Upstream";
    const meta = `Generated ${generated.toLocaleString()} · ${s.count.toLocaleString()} matching requests · Active filters listed in Summary`;
    const metricHeaders = ["Requests", "Request share %", "Errors", "Error %", "Body bytes"];
    const timingHeaders = [
      ...(request ? timeHeaders.map((header) => `Request ${header}`) : []),
      ...(upstream ? timeHeaders.map((header) => `Upstream ${header}`) : []),
    ];
    const diagnostics = result.diagnostics;
    const summaryRows: ExportCell[][] = [
      ["Matching requests", s.count],
      ["4xx / 5xx errors", s.errorCount],
      ["Error rate", ratio(s.errorCount, s.count)],
      ["Body bytes sent", s.bodyBytes],
      ["Unique clients", s.uniqueClients],
      ["Matching endpoint groups", result.endpointCount],
      ["Exported endpoint groups", result.endpoints.length],
    ];
    for (const [label, time] of [
      ["Request", s.requestTime],
      ["Upstream", s.upstreamTime],
    ] as const) {
      summaryRows.push([`${label} timing coverage`, ratio(time.count, s.count)]);
      if (time.count > 0)
        timeValues(time).forEach((value, index) =>
          summaryRows.push([`${label} ${timeHeaders[index]}`, value]),
        );
    }
    summaryRows.push(
      [
        "Endpoint scope",
        "All matching endpoint groups; the screen's Top N display limit is ignored.",
      ],
      ["Source", sourceKind === "paste" ? "Pasted text" : fileNames.join("; ")],
      ["Date filter (log-local)", filters.dateFilter === "all" ? "All dates" : filters.dateFilter],
      ["Methods", filters.methods.length ? filters.methods.join(", ") : "All methods"],
      ["Path / client search", filters.query || "None"],
      ["Status family", filters.statusFamily],
      ["Exact HTTP status", filters.statusCode || "All statuses"],
      ["Minimum latency (ms)", filters.minMs],
      ["Latency metric", timingLabel],
      [
        "Path grouping",
        filters.normalizeMode === "collapseIds"
          ? "Collapse IDs and strip query"
          : filters.normalizeMode === "stripQuery"
            ? "Strip query"
            : "Exact path",
      ],
      ["Endpoint sort", `${filters.sortKey} (${filters.sortDir})`],
      [
        "Time grouping",
        "Log-local time; no timezone conversion. Date filters apply to all report tables.",
      ],
      [
        "Timing values",
        "Milliseconds. Blank = unavailable; zero is measured. Upstream sums recorded attempts. Percentiles are approximate.",
      ],
      [
        "Breakdown scope",
        "Clients, referrers and user agents: top 100 by requests, exact counts. Shares use all matching requests; these tables may not sum to 100%.",
      ],
      [
        "Client locations",
        "Only cached lookups from the Clients tab; blank means not resolved. Export performs no network lookups.",
      ],
      [
        "Diagnostics scope",
        "All input lines, before request filters. Unmatched samples are a limited sample, not all rejected lines.",
      ],
    );
    const summary = addSheet(workbook, "Summary", meta, ["Metric", "Value"], summaryRows);
    summaryRows.forEach(([label], index) => {
      const cell = summary.getCell(HEADER_ROW + 1 + index, 2);
      const name = String(label);
      cell.numFmt =
        name === "Error rate" || name.endsWith("coverage")
          ? PERCENT_FMT
          : name.endsWith(" ms") || name === "Minimum latency (ms)"
            ? MS_FMT
            : name === "Body bytes sent"
              ? BYTE_FMT
              : COUNT_FMT;
    });
    addSheet(
      workbook,
      "Endpoints",
      `${meta} · All ${result.endpointCount.toLocaleString()} groups; sorted by ${filters.sortKey} ${filters.sortDir}`,
      ["Method", "Path", ...metricHeaders, ...timingHeaders],
      result.endpoints.map((row) => [
        row.method,
        row.path,
        row.count,
        ratio(row.count, s.count),
        row.errorCount,
        ratio(row.errorCount, row.count),
        row.bodyBytes,
        ...(request ? timeValues(row.requestTime) : []),
        ...(upstream ? timeValues(row.upstreamTime) : []),
      ]),
    );
    const hotspotHeaders = [
      "Method",
      "Path",
      "Requests",
      "Errors",
      "Error %",
      ...(selectedTiming
        ? [`${timingLabel} Measured`, `${timingLabel} Avg ms`, `${timingLabel} p95 ms`]
        : []),
    ];
    if (result.slowestEndpoints.length)
      addSheet(
        workbook,
        "Slowest endpoints",
        `Highest average ${timingLabel.toLowerCase()} latency across all matching groups, independent of the endpoint table sort.`,
        hotspotHeaders,
        hotspotRows(result.slowestEndpoints, selectedTiming),
      );
    if (result.failingEndpoints.length)
      addSheet(
        workbook,
        "Most errors",
        "Most 4xx / 5xx errors across all matching groups, independent of the endpoint table sort.",
        hotspotHeaders,
        hotspotRows(result.failingEndpoints, selectedTiming),
      );
    const bucketHeaders = ["Log-local time", ...metricHeaders, ...timingHeaders];
    addSheet(
      workbook,
      "Hourly",
      `${meta} · Log-local hours`,
      bucketHeaders,
      bucketRows(result.hourlyStats, s.count, request, upstream),
    );
    addSheet(
      workbook,
      "Daily",
      `${meta} · Log-local dates`,
      bucketHeaders,
      bucketRows(result.dailyStats, s.count, request, upstream),
    );
    const coverage = (rows: NginxBreakdown[], distinct: number) =>
      `${rows.length} of ${distinct} values · ${rows.reduce((sum, row) => sum + row.count, 0).toLocaleString()} of ${s.count.toLocaleString()} matching requests · Top 100 by requests`;
    // Locations already resolved on the Clients tab; export never starts new lookups.
    const { infos } = useIpInfoStore.getState();
    addSheet(
      workbook,
      "Clients",
      coverage(result.clients, result.clientCount),
      ["Client IP", "Country", "Network", "ASN", ...metricHeaders],
      result.clients.map((row) => {
        const info = infos[row.value];
        const network = info?.kind === "public" ? info : null;
        return [
          row.value,
          info?.kind === "private"
            ? "Private network"
            : network?.country
              ? countryName(network.country)
              : "",
          network?.org ?? "",
          network?.asn ?? null,
          row.count,
          ratio(row.count, s.count),
          row.errorCount,
          ratio(row.errorCount, row.count),
          row.bodyBytes,
        ];
      }),
    );
    addSheet(
      workbook,
      "Referrers",
      coverage(result.referrers, result.referrerCount),
      ["Referrer", ...metricHeaders],
      breakdownRows(result.referrers, s.count),
    );
    addSheet(
      workbook,
      "User agents",
      coverage(result.userAgents, result.userAgentCount),
      ["User agent", "Type", "Client", "OS", ...metricHeaders],
      result.userAgents.map((row) => {
        const agent = parseUserAgent(row.value);
        return [
          row.value,
          agentKindLabel[agent.kind],
          agent.name,
          agent.os ?? "",
          row.count,
          ratio(row.count, s.count),
          row.errorCount,
          ratio(row.errorCount, row.count),
          row.bodyBytes,
        ];
      }),
    );
    addSheet(
      workbook,
      "Status codes",
      meta,
      ["HTTP status", "Status family", "Requests", "Request share %"],
      result.statusCounts.map((row) => [
        row.status,
        `${Math.floor(row.status / 100)}xx`,
        row.count,
        ratio(row.count, s.count),
      ]),
    );
    addSheet(
      workbook,
      "Diagnostics",
      "All input lines, before request filters. Invalid timing fields do not imply that the request was rejected.",
      ["Metric", "Value"],
      [
        ["Total input lines", diagnostics.totalLines],
        ["Matched lines", diagnostics.matchedLines],
        ["Unmatched lines", diagnostics.unmatchedCount],
        ["Invalid timing fields", diagnostics.invalidTimingCount],
        ["Unmatched samples included", diagnostics.unmatchedSample.length],
      ],
    );
    if (diagnostics.unmatchedSample.length)
      addSheet(
        workbook,
        "Unmatched samples",
        "Limited sample of input lines the parser could not recognize; unaffected by request filters.",
        ["Sample", "Log line"],
        diagnostics.unmatchedSample.map((line, index) => [index + 1, line]),
      );
    const bytes = await workbook.xlsx.writeBuffer();
    // SAFETY: ExcelJS writeBuffer returns an ArrayBuffer-compatible binary buffer in the browser.
    const url = URL.createObjectURL(
      new Blob([bytes as BlobPart], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `nginx-analysis-${generated.toISOString().slice(0, 10)}.xlsx`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(`Exported ${result.endpoints.length.toLocaleString()} Nginx endpoints`);
  } catch (error) {
    showToast(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    exporting = false;
  }
}
