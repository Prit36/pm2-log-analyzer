import type ExcelJS from "exceljs";
import { useNginxStore } from "../store/nginxStore";
import type { NginxBreakdown, NginxLatency, NginxTimeBucket } from "./types";
import { countryName, useIpInfoStore } from "./ipLookup";
import { agentKindLabel, parseUserAgent } from "./userAgent";

const { showToast } = useNginxStore.getState();
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

function timeValues(time: NginxLatency): (number | null)[] {
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

function addSheet(
  workbook: ExcelJS.Workbook,
  name: string,
  headers: string[],
  rows: (string | number | null)[][],
) {
  const sheet = workbook.addWorksheet(name);
  sheet.addRow(headers);
  sheet.addRows(rows);
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(1, rows.length + 1), column: headers.length },
  };
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF7C3AED" } };
  sheet.columns.forEach((column, index) => {
    column.width = index === 0 ? 48 : 18;
  });
}

function breakdownRows(rows: NginxBreakdown[]): (string | number)[][] {
  return rows.map((row) => [row.value, row.count, row.errorCount, row.bodyBytes]);
}

function bucketRows(rows: NginxTimeBucket[]): (string | number | null)[][] {
  return rows.map((row) => [
    row.label,
    row.count,
    row.errorCount,
    row.bodyBytes,
    ...timeValues(row.requestTime),
    ...timeValues(row.upstreamTime),
  ]);
}

export async function exportNginxSpreadsheet(): Promise<void> {
  const { result, filters, fileNames, sourceKind } = useNginxStore.getState();
  if (!result) return;
  try {
    const Excel = await import("exceljs");
    const workbook = new Excel.default.Workbook();
    workbook.creator = "Nginx Log Analyzer";
    const s = result.summary;
    addSheet(
      workbook,
      "Summary",
      ["Metric", "Value"],
      [
        ["Requests", s.count],
        ["4xx / 5xx errors", s.errorCount],
        ["Body bytes sent", s.bodyBytes],
        ["Unique clients", s.uniqueClients],
        ["Request timings measured", s.requestTime.count],
        ["Request avg ms", s.requestTime.avgMs],
        ["Request p95 ms", s.requestTime.p95Ms],
        ["Upstream timings measured", s.upstreamTime.count],
        ["Upstream avg ms", s.upstreamTime.avgMs],
        ["Upstream p95 ms", s.upstreamTime.p95Ms],
        ["Source", sourceKind === "paste" ? "Pasted text" : fileNames.join("; ")],
        ["Time grouping", "Log-local time; no timezone conversion"],
        [
          "Timings",
          "Milliseconds; blanks are unavailable; upstream is the sum of recorded attempts",
        ],
        ["Filters", JSON.stringify(filters)],
        ["Endpoint groups", result.endpointCount],
        ["Exported endpoint groups", result.endpoints.length],
        ["Breakdowns", "Top 100 by requests with exact counts; unavailable values are logged as -"],
        ["Client values", result.clientCount],
        ["Referrer values", result.referrerCount],
        ["User agent values", result.userAgentCount],
        ["Matched lines", result.diagnostics.matchedLines],
        ["Unmatched lines", result.diagnostics.unmatchedCount],
        ["Invalid timing fields", result.diagnostics.invalidTimingCount],
      ],
    );
    const requestHeaders = timeHeaders.map((header) => `Request ${header}`);
    const upstreamHeaders = timeHeaders.map((header) => `Upstream ${header}`);
    addSheet(
      workbook,
      "Endpoints",
      ["Method", "Path", "Requests", "Errors", "Body bytes", ...requestHeaders, ...upstreamHeaders],
      result.endpoints.map((row) => [
        row.method,
        row.path,
        row.count,
        row.errorCount,
        row.bodyBytes,
        ...timeValues(row.requestTime),
        ...timeValues(row.upstreamTime),
      ]),
    );
    const bucketHeaders = [
      "Log-local time",
      "Requests",
      "Errors",
      "Body bytes",
      ...requestHeaders,
      ...upstreamHeaders,
    ];
    addSheet(workbook, "Hourly", bucketHeaders, bucketRows(result.hourlyStats));
    addSheet(workbook, "Daily", bucketHeaders, bucketRows(result.dailyStats));
    const headers = ["Value", "Requests", "Errors", "Body bytes"];
    // Locations already resolved on the Clients tab; export never starts new lookups.
    const { infos } = useIpInfoStore.getState();
    addSheet(
      workbook,
      "Clients",
      ["Client IP", "Country", "Network", "ASN", "Requests", "Errors", "Body bytes"],
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
          row.errorCount,
          row.bodyBytes,
        ];
      }),
    );
    addSheet(workbook, "Referrers", headers, breakdownRows(result.referrers));
    addSheet(
      workbook,
      "User agents",
      ["User agent", "Type", "Client", "OS", "Requests", "Errors", "Body bytes"],
      result.userAgents.map((row) => {
        const agent = parseUserAgent(row.value);
        return [
          row.value,
          agentKindLabel[agent.kind],
          agent.name,
          agent.os ?? "",
          row.count,
          row.errorCount,
          row.bodyBytes,
        ];
      }),
    );
    addSheet(
      workbook,
      "Status codes",
      ["HTTP status", "Requests"],
      result.statusCounts.map((row) => [row.status, row.count]),
    );
    addSheet(
      workbook,
      "Unmatched samples",
      ["Log line"],
      result.diagnostics.unmatchedSample.map((line) => [line]),
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
    link.download = "nginx-analysis.xlsx";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("Nginx spreadsheet exported");
  } catch (error) {
    showToast(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
