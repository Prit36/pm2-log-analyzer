import type { AggregatedEndpoint, DaySummary, HourlyBucket } from "../parser";
import { formatDate, formatMs, formatNum } from "./format";

export type ChartImageResults = {
  timeVsLatency?: string | undefined;
  hourlyVolume?: string | undefined;
  distribution?: string | undefined;
  dailyTrend?: string | undefined;
};

export type ChartTheme = "light" | "dark";

/** Setup High-DPI canvas with gridlines, title, and coordinate mappers */
function initChart(
  width: number,
  height: number,
  title: string,
  padding: { top: number; right: number; bottom: number; left: number },
  maxY: number,
  formatY: (val: number) => string,
  xLabels: string[],
  formatYRight?: (val: number) => string,
  maxYRight?: number,
  isCategorical = false,
  theme: ChartTheme = "light",
) {
  const doc = globalThis.document;
  if (!doc) return null;
  const canvas = doc.createElement("canvas");
  if (!canvas || !("getContext" in canvas)) return null;

  const dpr = 2;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const isDark = theme === "dark";

  ctx.scale(dpr, dpr);
  ctx.imageSmoothingEnabled = true;

  // Background & Header
  ctx.fillStyle = isDark ? "#0f172a" : "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = isDark ? "#f8fafc" : "#0f172a";
  ctx.font =
    '600 15px "IBM Plex Sans", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textBaseline = "middle";
  ctx.fillText(title, 18, 24);

  const graphWidth = width - padding.left - padding.right;
  const graphHeight = height - padding.top - padding.bottom;

  const getX = (index: number, count: number) =>
    isCategorical
      ? padding.left + (index + 0.5) * (graphWidth / Math.max(1, count))
      : padding.left + (index / Math.max(1, count - 1)) * graphWidth;

  const getY = (val: number) => padding.top + graphHeight - (val / Math.max(1, maxY)) * graphHeight;

  // Gridlines & Y-Axis Ticks
  const ySteps = 4;
  ctx.font =
    '500 11px "IBM Plex Sans", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.lineWidth = 1;

  for (let i = 0; i <= ySteps; i++) {
    const y = padding.top + graphHeight - (i / ySteps) * graphHeight;
    ctx.strokeStyle = isDark ? "#334155" : "#f1f5f9";
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();

    ctx.fillStyle = isDark ? "#94a3b8" : "#475569";
    ctx.textAlign = "right";
    ctx.fillText(formatY((maxY / ySteps) * i), padding.left - 8, y + 1);

    if (formatYRight && maxYRight) {
      ctx.fillStyle = isDark ? "#f87171" : "#dc2626";
      ctx.textAlign = "left";
      ctx.fillText(formatYRight((maxYRight / ySteps) * i), width - padding.right + 8, y + 1);
    }
  }

  // X-Axis Ticks
  ctx.textAlign = "center";
  ctx.fillStyle = isDark ? "#94a3b8" : "#475569";
  const interval = Math.max(1, Math.floor(xLabels.length / 10));
  for (let i = 0; i < xLabels.length; i += interval) {
    const x = getX(i, xLabels.length);
    ctx.fillText(xLabels[i] ?? "", x, height - padding.bottom + 18);
  }

  return { canvas, ctx, graphWidth, graphHeight, getX, getY, isDark };
}

/** Helper to draw a filled line series */
function drawSeries(
  ctx: CanvasRenderingContext2D,
  pts: { x: number; y: number }[],
  topY: number,
  bottomY: number,
  strokeColor: string,
  fillColorStart: string,
  lineWidth = 2,
) {
  if (pts.length === 0) return;

  const grad = ctx.createLinearGradient(0, topY, 0, bottomY);
  grad.addColorStop(0, fillColorStart);
  grad.addColorStop(1, "rgba(255, 255, 255, 0)");

  ctx.beginPath();
  ctx.moveTo(pts[0]!.x, bottomY);
  pts.forEach((p) => ctx.lineTo(p.x, p.y));
  ctx.lineTo(pts[pts.length - 1]!.x, bottomY);
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = lineWidth;
  ctx.stroke();
}

/** Render Time vs Latency (P99, P95, Avg) */
export function renderTimeVsLatencyChart(
  hourlyStats: HourlyBucket[],
  theme: ChartTheme = "light",
): string {
  if (!hourlyStats.length) return "";
  const maxMs =
    Math.ceil(Math.max(...hourlyStats.map((h) => Math.max(h.p99Ms, h.p95Ms, h.avgMs))) * 1.1) ||
    100;
  const chart = initChart(
    600,
    320,
    "Time vs Latency Trend",
    { top: 52, right: 24, bottom: 48, left: 68 },
    maxMs,
    formatMs,
    hourlyStats.map((h) => h.label),
    undefined,
    undefined,
    false,
    theme,
  );
  if (!chart) return "";

  const { canvas, ctx, graphHeight, getX, getY, isDark } = chart;
  const count = hourlyStats.length;
  const topY = 52;
  const bottomY = 52 + graphHeight;

  const getPts = (key: "p99Ms" | "p95Ms" | "avgMs") =>
    hourlyStats.map((h, i) => ({ x: getX(i, count), y: getY(h[key]) }));

  drawSeries(
    ctx,
    getPts("p99Ms"),
    topY,
    bottomY,
    isDark ? "#a78bfa" : "#7c3aed",
    isDark ? "rgba(167, 139, 250, 0.3)" : "rgba(124, 58, 237, 0.25)",
  );
  drawSeries(
    ctx,
    getPts("p95Ms"),
    topY,
    bottomY,
    isDark ? "#60a5fa" : "#2563eb",
    isDark ? "rgba(96, 165, 250, 0.35)" : "rgba(37, 99, 235, 0.35)",
  );
  drawSeries(
    ctx,
    getPts("avgMs"),
    topY,
    bottomY,
    isDark ? "#2dd4bf" : "#0d9488",
    isDark ? "rgba(45, 212, 191, 0.3)" : "rgba(13, 148, 136, 0.3)",
  );

  // Legend
  const legend = [
    { label: "P99 Latency", color: isDark ? "#a78bfa" : "#7c3aed" },
    { label: "P95 Latency", color: isDark ? "#60a5fa" : "#2563eb" },
    { label: "Avg Latency", color: isDark ? "#2dd4bf" : "#0d9488" },
  ];
  legend.forEach((item, i) => {
    const x = 340 + i * 90;
    ctx.fillStyle = item.color;
    ctx.beginPath();
    ctx.arc(x, 24, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = isDark ? "#cbd5e1" : "#334155";
    ctx.font =
      '500 11px "IBM Plex Sans", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = "left";
    ctx.fillText(item.label, x + 8, 25);
  });

  return canvas.toDataURL("image/png");
}

/** Render Hourly Request Volume & Errors */
export function renderHourlyVolumeChart(
  hourlyStats: HourlyBucket[],
  theme: ChartTheme = "light",
): string {
  if (!hourlyStats.length) return "";
  const maxCount = Math.ceil(Math.max(...hourlyStats.map((h) => h.count)) * 1.15) || 10;
  const maxError = Math.ceil(Math.max(...hourlyStats.map((h) => h.errorCount)) * 1.2) || 5;

  const chart = initChart(
    600,
    320,
    "Hourly Request Volume & Errors",
    { top: 52, right: 65, bottom: 48, left: 65 },
    maxCount,
    formatNum,
    hourlyStats.map((h) => h.label),
    formatNum,
    maxError,
    true,
    theme,
  );
  if (!chart) return "";

  const { canvas, ctx, graphHeight, getX, isDark } = chart;
  const count = hourlyStats.length;
  const barW = Math.min(22, Math.max(4, (470 / count) * 0.6));

  // Request Bars
  hourlyStats.forEach((h, i) => {
    const xCenter = getX(i, count);
    const barH = (h.count / maxCount) * graphHeight;
    const barY = 52 + graphHeight - barH;
    ctx.fillStyle = isDark ? "#60a5fa" : "#3b82f6";
    ctx.beginPath();
    if ("roundRect" in CanvasRenderingContext2D.prototype) {
      ctx.roundRect(xCenter - barW / 2, barY, barW, barH, [3, 3, 0, 0]);
    } else {
      ctx.fillRect(xCenter - barW / 2, barY, barW, barH);
    }
    ctx.fill();
  });

  // Error Line
  const errPts = hourlyStats.map((h, i) => ({
    x: getX(i, count),
    y: 52 + graphHeight - (h.errorCount / maxError) * graphHeight,
  }));
  ctx.beginPath();
  errPts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.strokeStyle = isDark ? "#f87171" : "#ef4444";
  ctx.lineWidth = 2;
  ctx.stroke();
  errPts.forEach((p) => {
    ctx.fillStyle = isDark ? "#f87171" : "#ef4444";
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
    ctx.fill();
  });

  // Legend
  ctx.fillStyle = isDark ? "#60a5fa" : "#3b82f6";
  ctx.fillRect(390, 18, 12, 10);
  ctx.fillStyle = isDark ? "#cbd5e1" : "#334155";
  ctx.font =
    '500 11px "IBM Plex Sans", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textAlign = "left";
  ctx.fillText("Total Requests", 406, 25);

  ctx.fillStyle = isDark ? "#f87171" : "#ef4444";
  ctx.beginPath();
  ctx.arc(505, 24, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillText("Errors (4xx/5xx)", 515, 25);

  return canvas.toDataURL("image/png");
}

/** Render Daily Trend (Requests, Errors, P95 Latency) */
export function renderDailyTrendChart(
  dailyStats: DaySummary[],
  theme: ChartTheme = "light",
): string {
  if (!dailyStats.length) return "";
  const maxCount = Math.ceil(Math.max(...dailyStats.map((d) => d.count)) * 1.15) || 10;
  const maxP95 = Math.ceil(Math.max(...dailyStats.map((d) => d.p95Ms)) * 1.2) || 100;

  const chart = initChart(
    600,
    320,
    "Daily Trend: Requests & Latency",
    { top: 52, right: 65, bottom: 48, left: 65 },
    maxCount,
    formatNum,
    dailyStats.map((d) => formatDate(d.date)),
    formatMs,
    maxP95,
    true,
    theme,
  );
  if (!chart) return "";

  const { canvas, ctx, graphHeight, getX, isDark } = chart;
  const count = dailyStats.length;
  const barW = Math.min(32, Math.max(6, (470 / count) * 0.6));

  // Request Bars
  dailyStats.forEach((d, i) => {
    const xCenter = getX(i, count);
    const barH = (d.count / maxCount) * graphHeight;
    const barY = 52 + graphHeight - barH;
    ctx.fillStyle = isDark ? "#60a5fa" : "#3b82f6";
    ctx.beginPath();
    if ("roundRect" in CanvasRenderingContext2D.prototype) {
      ctx.roundRect(xCenter - barW / 2, barY, barW, barH, [3, 3, 0, 0]);
    } else {
      ctx.fillRect(xCenter - barW / 2, barY, barW, barH);
    }
    ctx.fill();
  });

  // P95 Latency Line (Right Y-axis)
  const p95Pts = dailyStats.map((d, i) => ({
    x: getX(i, count),
    y: 52 + graphHeight - (d.p95Ms / maxP95) * graphHeight,
  }));
  ctx.beginPath();
  p95Pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.strokeStyle = isDark ? "#a78bfa" : "#7c3aed";
  ctx.lineWidth = 2;
  ctx.stroke();
  p95Pts.forEach((p) => {
    ctx.fillStyle = isDark ? "#a78bfa" : "#7c3aed";
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
    ctx.fill();
  });

  // Legend
  ctx.fillStyle = isDark ? "#60a5fa" : "#3b82f6";
  ctx.fillRect(360, 18, 12, 10);
  ctx.fillStyle = isDark ? "#cbd5e1" : "#334155";
  ctx.font =
    '500 11px "IBM Plex Sans", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textAlign = "left";
  ctx.fillText("Total Requests", 376, 25);

  ctx.fillStyle = isDark ? "#a78bfa" : "#7c3aed";
  ctx.beginPath();
  ctx.arc(475, 24, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillText("P95 Latency", 485, 25);

  return canvas.toDataURL("image/png");
}

/** Render Latency Distribution Breakdown */
export function renderDistributionChart(
  rows: AggregatedEndpoint[],
  theme: ChartTheme = "light",
): string {
  const buckets = [
    { label: "<50ms", count: 0, fill: "#22c55e" },
    { label: "50-100ms", count: 0, fill: "#84cc16" },
    { label: "100-300ms", count: 0, fill: "#eab308" },
    { label: "300-500ms", count: 0, fill: "#f97316" },
    { label: "500ms-1s", count: 0, fill: "#ef4444" },
    { label: "1s-3s", count: 0, fill: "#b91c1c" },
    { label: ">3s", count: 0, fill: "#7f1d1d" },
  ];

  const classify = (ms: number) =>
    ms < 50 ? 0 : ms < 100 ? 1 : ms < 300 ? 2 : ms < 500 ? 3 : ms < 1000 ? 4 : ms < 3000 ? 5 : 6;

  for (const r of rows) {
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

  const maxCount = Math.ceil(Math.max(...buckets.map((b) => b.count)) * 1.15) || 10;
  const chart = initChart(
    600,
    320,
    "Latency Distribution Breakdown",
    { top: 52, right: 24, bottom: 48, left: 68 },
    maxCount,
    formatNum,
    buckets.map((b) => b.label),
    undefined,
    undefined,
    true,
    theme,
  );
  if (!chart) return "";

  const { canvas, ctx, graphHeight, getX, isDark } = chart;
  const count = buckets.length;
  const barW = Math.min(42, (508 / count) * 0.65);

  buckets.forEach((b, i) => {
    const xCenter = getX(i, count);
    const barH = (b.count / maxCount) * graphHeight;
    const barY = 52 + graphHeight - barH;

    ctx.fillStyle = b.fill;
    ctx.beginPath();
    if ("roundRect" in CanvasRenderingContext2D.prototype) {
      ctx.roundRect(xCenter - barW / 2, barY, barW, barH, [4, 4, 0, 0]);
    } else {
      ctx.fillRect(xCenter - barW / 2, barY, barW, barH);
    }
    ctx.fill();

    if (b.count > 0) {
      ctx.fillStyle = isDark ? "#f8fafc" : "#0f172a";
      ctx.font =
        '600 11px "IBM Plex Sans", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      ctx.textAlign = "center";
      ctx.fillText(formatNum(b.count), xCenter, barY - 5);
    }
  });

  return canvas.toDataURL("image/png");
}

export async function generateAllChartImages(
  rows: AggregatedEndpoint[],
  hourlyStats: HourlyBucket[] = [],
  dailyStats: DaySummary[] = [],
  theme: ChartTheme = "light",
): Promise<ChartImageResults> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  return {
    timeVsLatency: renderTimeVsLatencyChart(hourlyStats, theme),
    hourlyVolume: renderHourlyVolumeChart(hourlyStats, theme),
    distribution: renderDistributionChart(rows, theme),
    dailyTrend: dailyStats.length > 1 ? renderDailyTrendChart(dailyStats, theme) : undefined,
  };
}
