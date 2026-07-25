export type LogMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

export type ParsedLogLine = {
  raw: string;
  ts?: string;
  method?: LogMethod;
  path?: string;
  status?: number;
  durationMs?: number;
  bytes?: number | null;
};

// oxlint-disable-next-line no-control-regex -- intentional ESC (0x1b) for ANSI strip
const ANSI_REGEX = /\u001b\[[0-9;]*m/g;

export function stripAnsi(input: string) {
  return input.replace(ANSI_REGEX, "");
}

// Example formats supported:
// A) PM2/Express-like (timestamp + method + path + status + duration)
// - 2026-03-04T00:06:14: POST /api/admin/... 200 3357.603 ms - 85
// - 2026-03-05 09:04:14: POST /api/admin/... 200 22.737 ms - -
// - (with ANSI colors) 2026-03-04T00:06:14: \u001b[0mPOST ...
//
// B) Duration-first (often produced by custom loggers)
// - 68064.174ms\tPOST /api/admin/user/getuserbyrole
// - 65445.249ms\tGET /api/.../getQuotationDetailsById?quotationId=...
const LINE_REGEX =
  /^\s*(?:(?<ts>\d{4}-\d{2}-\d{2}(?:T|\s)\d{2}:\d{2}:\d{2}):\s*)?(?:(?<method>GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+(?<path>\S+)\s+(?<status>\d{3})\s+(?<duration>[0-9.]+)\s*ms\s*-\s*(?<bytes>-|\d+)\s*|(?<duration2>[0-9.]+)\s*ms\s*[\t ]+\s*(?<method2>GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+(?<path2>\S+))\s*$/;

export function parsePm2LogLine(line: string): ParsedLogLine {
  const raw = line;
  const clean = stripAnsi(line).trim();
  const m = clean.match(LINE_REGEX);
  if (!m || !m.groups) return { raw };

  // Pattern A (timestamp + status)
  if (m.groups.method && m.groups.path && m.groups.duration) {
    const bytesRaw = m.groups.bytes;
    const parsed: ParsedLogLine = {
      raw,
      method: m.groups.method as LogMethod,
      path: m.groups.path,
      status: Number(m.groups.status),
      durationMs: Number(m.groups.duration),
      bytes: bytesRaw === "-" ? null : Number(bytesRaw),
    };
    if (m.groups.ts !== undefined) parsed.ts = m.groups.ts;
    return parsed;
  }

  // Pattern B (duration-first)
  if (m.groups.method2 && m.groups.path2 && m.groups.duration2) {
    return {
      raw,
      method: m.groups.method2 as LogMethod,
      path: m.groups.path2,
      durationMs: Number(m.groups.duration2),
      // status/bytes/ts are not present in this format
    };
  }

  return { raw };
}

export function parsePm2Logs(text: string) {
  const lines = text.split(/\r?\n/);
  const parsed = lines
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
    .map(parsePm2LogLine);

  const matched = parsed.filter((p) => p.method && p.path && typeof p.durationMs === "number");
  const unmatched = parsed.filter((p) => !p.method || !p.path || typeof p.durationMs !== "number");

  return { matched, unmatched };
}

export type NormalizeMode = "exact" | "stripQuery" | "collapseIds";

export function normalizePath(path: string, mode: NormalizeMode) {
  if (mode === "exact") return path;

  let p = path;
  if (mode === "stripQuery" || mode === "collapseIds") {
    p = p.split("?")[0] ?? p;
  }
  if (mode === "collapseIds") {
    // Replace common id-like segments with :id
    // - Mongo ObjectId (24 hex)
    // - UUID
    // - Long numbers
    // - policy/proposal codes like PR-MOT-20260469900 (keep as :id)
    const segs = p.split("/").map((seg) => {
      if (!seg) return seg;
      if (/^[a-f0-9]{24}$/i.test(seg)) return ":id";
      if (/^[0-9]{6,}$/.test(seg)) return ":id";
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ":id";
      if (/^PR-[A-Z]{3,}-\d{8,}$/i.test(seg)) return ":id";
      if (/^[A-Z]{2,}-[A-Z]{2,}-\d{6,}$/i.test(seg)) return ":id";
      return seg;
    });
    p = segs.join("/");
  }
  return p;
}

export type AggregatedEndpoint = {
  key: string;
  method: LogMethod;
  path: string;
  count: number;
  avgMs: number;
  p50Ms: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  minMs: number;
  errorCount: number;
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

export function aggregateByEndpoint(
  lines: ParsedLogLine[],
  normalizeMode: NormalizeMode,
  methodFilter: Set<string> | null,
  statusFamily: "all" | "2xx" | "3xx" | "4xx" | "5xx",
  minMs: number,
) {
  const bucket = new Map<
    string,
    { method: LogMethod; path: string; durations: number[]; statuses: number[] }
  >();

  for (const l of lines) {
    if (!l.method || !l.path || typeof l.durationMs !== "number" || Number.isNaN(l.durationMs))
      continue;
    if (l.durationMs < minMs) continue;
    if (methodFilter && !methodFilter.has(l.method)) continue;

    const status = l.status ?? 0;
    const fam = Math.floor(status / 100);
    if (statusFamily !== "all") {
      const want = Number(statusFamily[0]);
      if (fam !== want) continue;
    }

    const normPath = normalizePath(l.path, normalizeMode);
    const key = `${l.method} ${normPath}`;
    const existing = bucket.get(key);

    if (existing) {
      existing.durations.push(l.durationMs);
      existing.statuses.push(status);
    } else {
      bucket.set(key, {
        method: l.method,
        path: normPath,
        durations: [l.durationMs],
        statuses: [status],
      });
    }
  }

  const out: AggregatedEndpoint[] = [];

  for (const [key, v] of bucket.entries()) {
    const durations = [...v.durations].sort((a, b) => a - b);
    const sum = durations.reduce((a, b) => a + b, 0);
    const count = durations.length;
    const errorCount = v.statuses.filter((s) => s >= 400).length;

    out.push({
      key,
      method: v.method,
      path: v.path,
      count,
      avgMs: count ? sum / count : 0,
      p50Ms: percentile(durations, 50),
      p90Ms: percentile(durations, 90),
      p95Ms: percentile(durations, 95),
      p99Ms: percentile(durations, 99),
      minMs: durations[0] ?? 0,
      maxMs: durations[durations.length - 1] ?? 0,
      errorCount,
    });
  }

  return out;
}
