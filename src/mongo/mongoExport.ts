import type ExcelJS from "exceljs";
import type { MongoAggregationResult } from "./types";
import { formatMs, formatNum } from "../utils/format";

export async function exportMongoSpreadsheet(
  result: MongoAggregationResult,
  fileName: string = "mongo-analysis.xlsx",
): Promise<void> {
  const ExcelJSModule = await import("exceljs");
  const Excel = ExcelJSModule.default;
  const wb = new Excel.Workbook();
  wb.creator = "MongoDB Log Analyzer";
  wb.created = new Date();

  const headerFill: ExcelJS.Fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF064E3B" }, // Emerald 900
  };
  const headerFont: Partial<ExcelJS.Font> = {
    bold: true,
    color: { argb: "FFFFFFFF" },
    size: 11,
  };

  // Sheet 1: Query Patterns
  const wsPatterns = wb.addWorksheet("Query Patterns", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  wsPatterns.columns = [
    { header: "Namespace", key: "ns", width: 32 },
    { header: "Operation", key: "op", width: 14 },
    { header: "Plan Summary", key: "planSummary", width: 22 },
    { header: "Query Fingerprint", key: "fingerprint", width: 55 },
    { header: "Count", key: "count", width: 12 },
    { header: "Total Time (s)", key: "totalTimeSec", width: 16 },
    { header: "Avg (ms)", key: "avgMs", width: 14 },
    { header: "P95 (ms)", key: "p95Ms", width: 14 },
    { header: "Max (ms)", key: "maxMs", width: 14 },
    { header: "COLLSCANs", key: "collscans", width: 14 },
    { header: "Scan Ratio", key: "scanRatio", width: 14 },
    { header: "Avg Docs Examined", key: "avgDocs", width: 18 },
    { header: "Suggested Index", key: "indexSuggestion", width: 45 },
  ];

  const pHeaderRow = wsPatterns.getRow(1);
  pHeaderRow.eachCell((cell) => {
    cell.fill = headerFill;
    cell.font = headerFont;
  });

  for (const p of result.patterns) {
    wsPatterns.addRow({
      ns: p.ns,
      op: p.op,
      planSummary: p.planSummary,
      fingerprint: p.fingerprint,
      count: p.count,
      totalTimeSec: Math.round((p.totalDurationMs / 1000) * 100) / 100,
      avgMs: p.avgDurationMs,
      p95Ms: p.p95DurationMs,
      maxMs: p.maxDurationMs,
      collscans: p.collscanCount,
      scanRatio: p.scanRatio,
      avgDocs: p.avgDocsExamined,
      indexSuggestion: p.indexSuggestion || "N/A",
    });
  }

  // Sheet 2: Slow Queries (top 2000 to keep excel responsive)
  const wsQueries = wb.addWorksheet("Slow Queries", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  wsQueries.columns = [
    { header: "Timestamp", key: "timestamp", width: 26 },
    { header: "Duration (ms)", key: "durationMs", width: 15 },
    { header: "Operation", key: "op", width: 14 },
    { header: "Namespace", key: "ns", width: 32 },
    { header: "Plan", key: "planSummary", width: 22 },
    { header: "Docs Examined", key: "docsExamined", width: 16 },
    { header: "Keys Examined", key: "keysExamined", width: 16 },
    { header: "Returned", key: "nreturned", width: 14 },
    { header: "Scan Ratio", key: "scanRatio", width: 14 },
    { header: "Yields", key: "numYields", width: 12 },
    { header: "ResLen (B)", key: "reslen", width: 14 },
    { header: "Remote IP", key: "remote", width: 24 },
  ];

  const qHeaderRow = wsQueries.getRow(1);
  qHeaderRow.eachCell((cell) => {
    cell.fill = headerFill;
    cell.font = headerFont;
  });

  const topQueries = result.slowQueries.slice(0, 2500);
  for (const q of topQueries) {
    wsQueries.addRow({
      timestamp: q.timestamp,
      durationMs: q.durationMs,
      op: q.op,
      ns: q.ns,
      planSummary: q.planSummary,
      docsExamined: q.docsExamined,
      keysExamined: q.keysExamined,
      nreturned: q.nreturned,
      scanRatio: Math.round(q.scanRatio * 10) / 10,
      numYields: q.numYields,
      reslen: q.reslen,
      remote: q.remote || "unknown",
    });
  }

  // Sheet 3: Collections
  const wsCollections = wb.addWorksheet("Collections", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  wsCollections.columns = [
    { header: "Namespace", key: "ns", width: 32 },
    { header: "Query Count", key: "count", width: 15 },
    { header: "Total Time (s)", key: "totalTimeSec", width: 16 },
    { header: "Avg Duration (ms)", key: "avgMs", width: 18 },
    { header: "P95 Duration (ms)", key: "p95Ms", width: 18 },
    { header: "Max Duration (ms)", key: "maxMs", width: 18 },
    { header: "COLLSCANs", key: "collscans", width: 15 },
    { header: "Total Docs Examined", key: "totalDocs", width: 22 },
    { header: "Scan Ratio", key: "scanRatio", width: 15 },
  ];
  const cHeaderRow = wsCollections.getRow(1);
  cHeaderRow.eachCell((cell) => {
    cell.fill = headerFill;
    cell.font = headerFont;
  });
  for (const c of result.collections) {
    wsCollections.addRow({
      ns: c.ns,
      count: c.queryCount,
      totalTimeSec: Math.round((c.totalDurationMs / 1000) * 100) / 100,
      avgMs: c.avgDurationMs,
      p95Ms: c.p95DurationMs,
      maxMs: c.maxDurationMs,
      collscans: c.collscanCount,
      totalDocs: c.totalDocsExamined,
      scanRatio: c.scanRatio,
    });
  }

  // Sheet 4: Errors & Diagnostics
  if (result.errors.length > 0) {
    const wsErrors = wb.addWorksheet("Errors & Warnings", {
      views: [{ state: "frozen", ySplit: 1 }],
    });
    wsErrors.columns = [
      { header: "Timestamp", key: "timestamp", width: 26 },
      { header: "Severity", key: "severity", width: 12 },
      { header: "Component", key: "component", width: 16 },
      { header: "ID", key: "id", width: 14 },
      { header: "Occurrences", key: "count", width: 14 },
      { header: "Message", key: "msg", width: 60 },
    ];
    const eHeaderRow = wsErrors.getRow(1);
    eHeaderRow.eachCell((cell) => {
      cell.fill = headerFill;
      cell.font = headerFont;
    });
    for (const e of result.errors) {
      wsErrors.addRow({
        timestamp: e.timestamp,
        severity: e.severity,
        component: e.component,
        id: e.id || "N/A",
        count: e.count,
        msg: e.msg,
      });
    }
  }

  // Generate buffer and trigger browser download
  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName.endsWith(".xlsx") ? fileName : `${fileName}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function buildMongoPatternsTsv(patterns: MongoAggregationResult["patterns"]): string {
  const headers = [
    "Namespace",
    "Operation",
    "Plan",
    "Count",
    "Total (s)",
    "Avg (ms)",
    "P95 (ms)",
    "Max (ms)",
    "COLLSCANs",
    "Scan Ratio",
    "Fingerprint",
    "Suggested Index",
  ];
  const lines = [headers.join("\t")];
  for (const p of patterns) {
    lines.push(
      [
        p.ns,
        p.op,
        p.planSummary,
        formatNum(p.count),
        (p.totalDurationMs / 1000).toFixed(2),
        formatMs(p.avgDurationMs),
        formatMs(p.p95DurationMs),
        formatMs(p.maxDurationMs),
        p.collscanCount,
        p.scanRatio,
        p.fingerprint,
        p.indexSuggestion || "N/A",
      ].join("\t"),
    );
  }
  return lines.join("\n");
}
