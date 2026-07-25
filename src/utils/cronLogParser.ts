import { stripAnsi } from "./pm2LogParser";

export type CronEvent = {
  raw: string;
  ts?: string;
  event: "start" | "done" | "fail";
  name: string;
  durationMs?: number;
};

// Matches:
// 2026-07-24T09:15:38: [cron] start export-motor-policy-csv
// 2026-07-24T10:22:30: [cron] done broker ocr processing 14412ms
// 2026-07-24T09:15:38: [cron] fail some-job 500ms
// Also supports "YYYY-MM-DD HH:mm:ss:" timestamp variant, or no timestamp.
const CRON_REGEX =
  /^\s*(?:(?<ts>\d{4}-\d{2}-\d{2}(?:T|\s)\d{2}:\d{2}:\d{2}):\s*)?\[cron\]\s+(?<event>start|done|fail)\s+(?<rest>.+?)\s*$/i;

export function parseCronLine(line: string): CronEvent | null {
  const clean = stripAnsi(line).trimEnd();
  const m = clean.match(CRON_REGEX);
  if (!m?.groups) return null;

  const rest = m.groups.rest;
  const event = m.groups.event;
  if (rest === undefined || event === undefined) return null;

  let name = rest.trim();
  let durationMs: number | undefined;

  // Try to extract trailing "<number>ms" as duration
  const durMatch = rest.match(/^(?<name>.+?)\s+(?<duration>[0-9.]+)\s*ms\s*$/);
  const durName = durMatch?.groups?.name;
  const durValue = durMatch?.groups?.duration;
  if (durName !== undefined && durValue !== undefined) {
    name = durName.trim();
    durationMs = Number(durValue);
  }

  const result: CronEvent = {
    raw: line,
    event: event.toLowerCase() as "start" | "done" | "fail",
    name,
  };
  if (m.groups.ts !== undefined) result.ts = m.groups.ts;
  if (durationMs !== undefined) result.durationMs = durationMs;
  return result;
}

export function parseCronLogs(text: string) {
  const lines = text.split(/\r?\n/);
  const events: CronEvent[] = [];
  const unmatched: string[] = [];

  for (const raw of lines) {
    if (!raw.trim()) continue;
    const ev = parseCronLine(raw);
    if (ev) events.push(ev);
  }

  return { events, unmatched };
}

export type CronAggregated = {
  name: string;
  runs: number; // number of "done" or "fail" events (i.e., completed executions)
  starts: number;
  fails: number;
  avgMs: number;
  p50Ms: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  minMs: number;
  lastRunTs?: string;
  lastDurationMs?: number;
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

export function aggregateCron(
  events: CronEvent[],
  opts: { query?: string; minMs?: number; showFailedOnly?: boolean },
) {
  const q = (opts.query ?? "").trim().toLowerCase();
  const minMs = opts.minMs ?? 0;

  // Group by cron name
  const map = new Map<
    string,
    {
      name: string;
      starts: number;
      durations: number[]; // completed durations (done + fail with duration)
      fails: number;
      lastRunTs?: string;
      lastDurationMs?: number;
    }
  >();

  // First, try to pair start -> done for events that don't have inline duration
  // Since your format already includes "<duration>ms" on done lines, we simply
  // use those durations directly. For "start" only entries with no matching done,
  // we still count them as "starts".
  const startMap = new Map<string, string | undefined>(); // name -> last start timestamp

  for (const ev of events) {
    if (q && !ev.name.toLowerCase().includes(q)) continue;

    const bucket = map.get(ev.name) ?? { name: ev.name, starts: 0, durations: [], fails: 0 };

    if (ev.event === "start") {
      bucket.starts += 1;
      startMap.set(ev.name, ev.ts);
    } else if (ev.event === "done" || ev.event === "fail") {
      let dur = ev.durationMs;
      if (dur === undefined) {
        // Fallback: pair with previous start if both timestamps are known
        const startTs = startMap.get(ev.name);
        if (startTs && ev.ts) {
          const s = Date.parse(startTs.replace(" ", "T"));
          const e = Date.parse(ev.ts.replace(" ", "T"));
          if (!Number.isNaN(s) && !Number.isNaN(e) && e >= s) {
            dur = e - s;
          }
        }
        startMap.delete(ev.name);
      }

      if (dur !== undefined && dur >= minMs) {
        bucket.durations.push(dur);
        bucket.lastDurationMs = dur;
        if (ev.ts !== undefined) bucket.lastRunTs = ev.ts;
      }
      if (ev.event === "fail") bucket.fails += 1;
    }

    map.set(ev.name, bucket);
  }

  const out: CronAggregated[] = [];
  for (const b of map.values()) {
    const sorted = [...b.durations].sort((a, b) => a - b);
    const runs = sorted.length;
    const sum = sorted.reduce((a, x) => a + x, 0);

    if (opts.showFailedOnly && b.fails === 0) continue;

    const row: CronAggregated = {
      name: b.name,
      runs,
      starts: b.starts,
      fails: b.fails,
      avgMs: runs ? sum / runs : 0,
      p50Ms: percentile(sorted, 50),
      p90Ms: percentile(sorted, 90),
      p95Ms: percentile(sorted, 95),
      p99Ms: percentile(sorted, 99),
      minMs: sorted[0] ?? 0,
      maxMs: sorted[sorted.length - 1] ?? 0,
    };
    if (b.lastRunTs !== undefined) row.lastRunTs = b.lastRunTs;
    if (b.lastDurationMs !== undefined) row.lastDurationMs = b.lastDurationMs;
    out.push(row);
  }

  return out;
}
