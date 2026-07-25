import { normalizePath } from "./normalize";
import { percentile, sortAsc, sortedDurations } from "./percentiles";
import type {
  AggregatedEndpoint,
  AggregatedResult,
  CronAggregated,
  CronEventCompact,
  CronSummary,
  LogMethod,
  LogSummary,
  ParseOptions,
} from "./types";
import { METHODS } from "./types";

export type ColumnarStore = {
  methodCodes: Uint8Array;
  statuses: Uint16Array;
  durations: Float32Array;
  pathIds: Uint32Array;
  pathTable: string[];
  count: number;
  unmatchedCount: number;
  unmatchedSample: string[];
  cronEvents: CronEventCompact[];
  methodSeen: Set<string>;
};

export function aggregateApi(store: ColumnarStore, options: ParseOptions): AggregatedEndpoint[] {
  const methodFilter = options.methodFilter ? new Set(options.methodFilter) : null;
  const bucket = new Map<
    string,
    { method: LogMethod; path: string; durations: number[]; errorCount: number }
  >();

  for (let i = 0; i < store.count; i++) {
    const durationMs = store.durations[i]!;
    if (durationMs < options.minMs) continue;

    const method = METHODS[store.methodCodes[i]!]!;
    if (methodFilter && !methodFilter.has(method)) continue;

    const status = store.statuses[i]!;
    if (options.statusFamily !== "all") {
      const want = Number(options.statusFamily[0]);
      if (Math.floor(status / 100) !== want) continue;
    }

    const rawPath = store.pathTable[store.pathIds[i]!]!;
    const normPath = normalizePath(rawPath, options.normalizeMode);
    const key = `${method} ${normPath}`;
    let entry = bucket.get(key);
    if (!entry) {
      entry = { method, path: normPath, durations: [], errorCount: 0 };
      bucket.set(key, entry);
    }
    entry.durations.push(durationMs);
    if (status >= 400) entry.errorCount++;
  }

  const out: AggregatedEndpoint[] = [];
  for (const [key, v] of bucket) {
    const sorted = sortAsc(v.durations);
    const n = sorted.length;
    const sum = sorted.reduce((a, b) => a + b, 0);
    out.push({
      key,
      method: v.method,
      path: v.path,
      count: n,
      avgMs: n ? sum / n : 0,
      p50Ms: percentile(sorted, 50),
      p90Ms: percentile(sorted, 90),
      p95Ms: percentile(sorted, 95),
      p99Ms: percentile(sorted, 99),
      minMs: sorted[0] ?? 0,
      maxMs: sorted[n - 1] ?? 0,
      errorCount: v.errorCount,
    });
  }
  return out;
}

export function aggregateCron(events: CronEventCompact[], options: ParseOptions): CronAggregated[] {
  const q = options.cronQuery.trim().toLowerCase();
  const minMs = options.cronMinMs;
  const map = new Map<
    string,
    {
      name: string;
      starts: number;
      durations: number[];
      fails: number;
      lastRunTs?: string;
      lastDurationMs?: number;
    }
  >();
  const startMap = new Map<string, string | undefined>();

  for (const ev of events) {
    if (q && !ev.name.toLowerCase().includes(q)) continue;
    const bucket = map.get(ev.name) ?? { name: ev.name, starts: 0, durations: [], fails: 0 };

    if (ev.event === "start") {
      bucket.starts++;
      startMap.set(ev.name, ev.ts);
    } else if (ev.event === "done" || ev.event === "fail") {
      let dur = ev.durationMs;
      if (dur === undefined) {
        const startTs = startMap.get(ev.name);
        if (startTs && ev.ts) {
          const s = Date.parse(startTs.replace(" ", "T"));
          const e = Date.parse(ev.ts.replace(" ", "T"));
          if (!Number.isNaN(s) && !Number.isNaN(e) && e >= s) dur = e - s;
        }
        startMap.delete(ev.name);
      }
      if (dur !== undefined && dur >= minMs) {
        bucket.durations.push(dur);
        bucket.lastDurationMs = dur;
        if (ev.ts) bucket.lastRunTs = ev.ts;
      }
      if (ev.event === "fail") bucket.fails++;
    }
    map.set(ev.name, bucket);
  }

  const out: CronAggregated[] = [];
  for (const b of map.values()) {
    if (options.cronShowFailedOnly && b.fails === 0) continue;
    const sorted = sortAsc(b.durations);
    const runs = sorted.length;
    const sum = sorted.reduce((a, x) => a + x, 0);
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
      maxMs: sorted[runs - 1] ?? 0,
    };
    if (b.lastRunTs !== undefined) row.lastRunTs = b.lastRunTs;
    if (b.lastDurationMs !== undefined) row.lastDurationMs = b.lastDurationMs;
    out.push(row);
  }
  return out;
}

function buildSummary(store: ColumnarStore): LogSummary {
  let max = 0;
  let sum = 0;
  let errors = 0;
  let slow = 0;
  for (let i = 0; i < store.count; i++) {
    const d = store.durations[i]!;
    sum += d;
    if (d > max) max = d;
    if (store.statuses[i]! >= 400) errors++;
    if (d >= 3000) slow++;
  }
  const sorted = sortedDurations(store.durations, store.count);
  return {
    matched: store.count,
    unmatched: store.unmatchedCount,
    max,
    avg: store.count ? sum / store.count : 0,
    p95Ms: percentile(sorted, 95),
    errors,
    slow,
  };
}

function buildCronSummary(events: CronEventCompact[], cron: CronAggregated[]): CronSummary {
  let starts = 0;
  let dones = 0;
  let fails = 0;
  for (const e of events) {
    if (e.event === "start") starts++;
    else if (e.event === "done") dones++;
    else fails++;
  }
  return {
    starts,
    dones,
    fails,
    jobs: cron.length,
    slowestRun: cron.reduce((m, r) => Math.max(m, r.maxMs), 0),
  };
}

/** Summary/methods/unmatched are store-wide (ignore filters). Cron summary jobs count uses filtered cron rows. */
export function buildResult(store: ColumnarStore, options: ParseOptions): AggregatedResult {
  const api = aggregateApi(store, options);
  const cron = aggregateCron(store.cronEvents, options);
  return {
    api,
    cron,
    summary: buildSummary(store),
    cronSummary: buildCronSummary(store.cronEvents, cron),
    methods: Array.from(store.methodSeen).sort(),
    unmatchedSample: store.unmatchedSample,
    unmatchedCount: store.unmatchedCount,
  };
}

/** Avoid re-sorting all durations on every REAGGREGATE — summary is filter-independent. */
export function buildResultCached(
  store: ColumnarStore,
  options: ParseOptions,
  cached: { summary: LogSummary; methods: string[] } | null,
): AggregatedResult {
  const api = aggregateApi(store, options);
  const cron = aggregateCron(store.cronEvents, options);
  const summary = cached?.summary ?? buildSummary(store);
  const methods = cached?.methods ?? Array.from(store.methodSeen).sort();
  return {
    api,
    cron,
    summary,
    cronSummary: buildCronSummary(store.cronEvents, cron),
    methods,
    unmatchedSample: store.unmatchedSample,
    unmatchedCount: store.unmatchedCount,
  };
}
