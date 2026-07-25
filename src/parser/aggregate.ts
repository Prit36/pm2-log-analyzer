import { DDSketch } from "@datadog/sketches-js";
import { normalizePath } from "./normalize";
import { percentile, sortAsc } from "./percentiles";
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

const SKETCH_OPTS = { relativeAccuracy: 0.01 } as const;

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

function makeSketch(): DDSketch {
  return new DDSketch(SKETCH_OPTS);
}

function sketchQuantile(sketch: DDSketch, q: number, count: number): number {
  if (count === 0) return 0;
  return sketch.getValueAtQuantile(q);
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

/** One store pass: filtered API buckets + optional unfiltered summary. */
export function aggregateApiWithSummary(
  store: ColumnarStore,
  options: ParseOptions,
  needSummary: boolean,
): { api: AggregatedEndpoint[]; summary: LogSummary | null } {
  const methodFilter = options.methodFilter ? new Set(options.methodFilter) : null;
  const normCache = new Map<number, string>();
  type Entry = {
    method: LogMethod;
    path: string;
    sketch: DDSketch;
    count: number;
    sum: number;
    min: number;
    max: number;
    errorCount: number;
  };
  const byMethod = new Map<LogMethod, Map<string, Entry>>();

  let sumMax = 0;
  let sumSum = 0;
  let sumErrors = 0;
  let sumSlow = 0;
  const sumSketch = needSummary ? makeSketch() : null;

  for (let i = 0; i < store.count; i++) {
    const durationMs = store.durations[i]!;
    const status = store.statuses[i]!;

    if (sumSketch) {
      sumSum += durationMs;
      sumSketch.accept(durationMs);
      if (durationMs > sumMax) sumMax = durationMs;
      if (status >= 400) sumErrors++;
      if (durationMs >= 3000) sumSlow++;
    }

    if (durationMs < options.minMs) continue;

    const method = METHODS[store.methodCodes[i]!]!;
    if (methodFilter && !methodFilter.has(method)) continue;

    if (options.statusFamily !== "all") {
      const want = Number(options.statusFamily[0]);
      if (Math.floor(status / 100) !== want) continue;
    }

    const pathId = store.pathIds[i]!;
    let normPath = normCache.get(pathId);
    if (normPath === undefined) {
      normPath = normalizePath(store.pathTable[pathId]!, options.normalizeMode);
      normCache.set(pathId, normPath);
    }

    let pathMap = byMethod.get(method);
    if (!pathMap) {
      pathMap = new Map();
      byMethod.set(method, pathMap);
    }
    let entry = pathMap.get(normPath);
    if (!entry) {
      entry = {
        method,
        path: normPath,
        sketch: makeSketch(),
        count: 0,
        sum: 0,
        min: Infinity,
        max: -Infinity,
        errorCount: 0,
      };
      pathMap.set(normPath, entry);
    }
    entry.sketch.accept(durationMs);
    entry.count++;
    entry.sum += durationMs;
    if (durationMs < entry.min) entry.min = durationMs;
    if (durationMs > entry.max) entry.max = durationMs;
    if (status >= 400) entry.errorCount++;
  }

  const api: AggregatedEndpoint[] = [];
  for (const pathMap of byMethod.values()) {
    for (const v of pathMap.values()) {
      const n = v.count;
      api.push({
        key: `${v.method} ${v.path}`,
        method: v.method,
        path: v.path,
        count: n,
        avgMs: n ? v.sum / n : 0,
        p50Ms: sketchQuantile(v.sketch, 0.5, n),
        p90Ms: sketchQuantile(v.sketch, 0.9, n),
        p95Ms: sketchQuantile(v.sketch, 0.95, n),
        p99Ms: sketchQuantile(v.sketch, 0.99, n),
        minMs: n ? v.min : 0,
        maxMs: n ? v.max : 0,
        errorCount: v.errorCount,
      });
    }
  }

  const summary = sumSketch
    ? {
        matched: store.count,
        unmatched: store.unmatchedCount,
        max: sumMax,
        avg: store.count ? sumSum / store.count : 0,
        p95Ms: sketchQuantile(sumSketch, 0.95, store.count),
        errors: sumErrors,
        slow: sumSlow,
      }
    : null;

  return { api, summary };
}

export function aggregateApi(store: ColumnarStore, options: ParseOptions): AggregatedEndpoint[] {
  return aggregateApiWithSummary(store, options, false).api;
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
  const { api, summary } = aggregateApiWithSummary(store, options, true);
  const cron = aggregateCron(store.cronEvents, options);
  return {
    api,
    cron,
    summary: summary!,
    cronSummary: buildCronSummary(store.cronEvents, cron),
    methods: Array.from(store.methodSeen).sort(),
    unmatchedSample: store.unmatchedSample,
    unmatchedCount: store.unmatchedCount,
  };
}

/** Avoid rebuilding summary on every REAGGREGATE — summary is filter-independent. */
export function buildResultCached(
  store: ColumnarStore,
  options: ParseOptions,
  cached: { summary: LogSummary; methods: string[] } | null,
): AggregatedResult {
  const needSummary = !cached?.summary;
  const { api, summary: built } = aggregateApiWithSummary(store, options, needSummary);
  const cron = aggregateCron(store.cronEvents, options);
  const summary = cached?.summary ?? built!;
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
