import { normalizePath } from "./normalize";
import { percentile, sortAsc } from "./percentiles";
import { makeRelHist, RelHist, type RelHistWire } from "./relHist";
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

/** Serializable per-(method, normalized path) bucket from a column slice. */
export type NormBucketWire = {
  method: LogMethod;
  path: string;
  sketch: RelHistWire;
  count: number;
  sum: number;
  min: number;
  max: number;
  errorCount: number;
};

export type AggPartial = {
  buckets: NormBucketWire[];
  summary: {
    sum: number;
    max: number;
    errors: number;
    slow: number;
    sketch: RelHistWire;
  } | null;
};

function sketchQuantile(sketch: RelHist, q: number, n: number): number {
  if (n === 0) return 0;
  return sketch.quantile(q);
}

function methodOkMask(options: ParseOptions): Uint8Array {
  const methodOk = new Uint8Array(METHODS.length);
  if (options.methodFilter && options.methodFilter.length > 0) {
    for (const m of options.methodFilter) {
      const i = METHODS.indexOf(m as LogMethod);
      if (i >= 0) methodOk[i] = 1;
    }
  } else {
    methodOk.fill(1);
  }
  return methodOk;
}

/**
 * Aggregate [start, end). Scan keys by pathId<<3|method (no normalize in the hot loop),
 * then collapse unique raw keys → normalized endpoint buckets for a small wire payload.
 */
export function aggregateColumnSlice(
  methodCodes: Uint8Array,
  statuses: Uint16Array,
  durations: Float32Array,
  pathIds: Uint32Array,
  pathTable: string[],
  start: number,
  end: number,
  options: ParseOptions,
  needSummary: boolean,
): AggPartial {
  const methodOk = methodOkMask(options);
  const statusWant = options.statusFamily === "all" ? -1 : Number(options.statusFamily[0]);
  const minMs = options.minMs;
  const normalizeMode = options.normalizeMode;

  type RawEntry = {
    sketch: RelHist;
    count: number;
    sum: number;
    min: number;
    max: number;
    errorCount: number;
  };
  const byRaw = new Map<number, RawEntry>();

  let sumMax = 0;
  let sumSum = 0;
  let sumErrors = 0;
  let sumSlow = 0;
  const sumSketch = needSummary ? makeRelHist() : null;

  for (let i = start; i < end; i++) {
    const durationMs = durations[i]!;
    const status = statuses[i]!;

    if (sumSketch) {
      sumSum += durationMs;
      sumSketch.accept(durationMs);
      if (durationMs > sumMax) sumMax = durationMs;
      if (status >= 400) sumErrors++;
      if (durationMs >= 3000) sumSlow++;
    }

    if (durationMs < minMs) continue;

    const methodCode = methodCodes[i]!;
    if (!methodOk[methodCode]) continue;
    if (statusWant !== -1 && ((status / 100) | 0) !== statusWant) continue;

    const rawKey = (pathIds[i]! << 3) | methodCode;
    let entry = byRaw.get(rawKey);
    if (!entry) {
      entry = {
        sketch: makeRelHist(),
        count: 0,
        sum: 0,
        min: Infinity,
        max: -Infinity,
        errorCount: 0,
      };
      byRaw.set(rawKey, entry);
    }
    entry.sketch.accept(durationMs);
    entry.count++;
    entry.sum += durationMs;
    if (durationMs < entry.min) entry.min = durationMs;
    if (durationMs > entry.max) entry.max = durationMs;
    if (status >= 400) entry.errorCount++;
  }

  type NormEntry = {
    method: LogMethod;
    path: string;
    sketch: RelHist;
    count: number;
    sum: number;
    min: number;
    max: number;
    errorCount: number;
  };
  const byNorm = new Map<string, NormEntry>();
  for (const [rawKey, e] of byRaw) {
    const method = METHODS[rawKey & 7]!;
    const normPath = normalizePath(pathTable[rawKey >>> 3]!, normalizeMode);
    const key = `${method} ${normPath}`;
    let dest = byNorm.get(key);
    if (!dest) {
      dest = {
        method,
        path: normPath,
        sketch: e.sketch,
        count: e.count,
        sum: e.sum,
        min: e.min,
        max: e.max,
        errorCount: e.errorCount,
      };
      byNorm.set(key, dest);
    } else {
      dest.sketch.merge(e.sketch);
      dest.count += e.count;
      dest.sum += e.sum;
      if (e.min < dest.min) dest.min = e.min;
      if (e.max > dest.max) dest.max = e.max;
      dest.errorCount += e.errorCount;
    }
  }

  const buckets: NormBucketWire[] = [];
  for (const e of byNorm.values()) {
    buckets.push({
      method: e.method,
      path: e.path,
      sketch: e.sketch.toWire(),
      count: e.count,
      sum: e.sum,
      min: e.min,
      max: e.max,
      errorCount: e.errorCount,
    });
  }

  return {
    buckets,
    summary: sumSketch
      ? {
          sum: sumSum,
          max: sumMax,
          errors: sumErrors,
          slow: sumSlow,
          sketch: sumSketch.toWire(),
        }
      : null,
  };
}

/** Merge normalized-path partials into API rows (+ optional summary). */
export function finishApiFromPartials(
  partials: AggPartial[],
  options: ParseOptions,
  storeMeta: { count: number; unmatchedCount: number },
): { api: AggregatedEndpoint[]; summary: LogSummary | null } {
  type Merged = {
    method: LogMethod;
    path: string;
    sketch: RelHist;
    count: number;
    sum: number;
    min: number;
    max: number;
    errorCount: number;
  };
  const byNorm = new Map<string, Merged>();

  let sumMax = 0;
  let sumSum = 0;
  let sumErrors = 0;
  let sumSlow = 0;
  let sumSketch: RelHist | null = null;

  for (const p of partials) {
    if (p.summary) {
      if (!sumSketch) sumSketch = makeRelHist();
      sumSketch.mergeWire(p.summary.sketch);
      sumSum += p.summary.sum;
      if (p.summary.max > sumMax) sumMax = p.summary.max;
      sumErrors += p.summary.errors;
      sumSlow += p.summary.slow;
    }
    for (const b of p.buckets) {
      const key = `${b.method} ${b.path}`;
      let m = byNorm.get(key);
      if (!m) {
        m = {
          method: b.method,
          path: b.path,
          sketch: RelHist.fromWire(b.sketch),
          count: b.count,
          sum: b.sum,
          min: b.min,
          max: b.max,
          errorCount: b.errorCount,
        };
        byNorm.set(key, m);
      } else {
        m.sketch.mergeWire(b.sketch);
        m.count += b.count;
        m.sum += b.sum;
        if (b.min < m.min) m.min = b.min;
        if (b.max > m.max) m.max = b.max;
        m.errorCount += b.errorCount;
      }
    }
  }

  // filters already applied in slices
  void options;

  const api: AggregatedEndpoint[] = [];
  for (const [key, v] of byNorm) {
    const c = v.count;
    api.push({
      key,
      method: v.method,
      path: v.path,
      count: c,
      avgMs: c ? v.sum / c : 0,
      p50Ms: sketchQuantile(v.sketch, 0.5, c),
      p90Ms: sketchQuantile(v.sketch, 0.9, c),
      p95Ms: sketchQuantile(v.sketch, 0.95, c),
      p99Ms: sketchQuantile(v.sketch, 0.99, c),
      minMs: c ? v.min : 0,
      maxMs: c ? v.max : 0,
      errorCount: v.errorCount,
    });
  }

  const summary =
    sumSketch != null
      ? {
          matched: storeMeta.count,
          unmatched: storeMeta.unmatchedCount,
          max: sumMax,
          avg: storeMeta.count ? sumSum / storeMeta.count : 0,
          p95Ms: sketchQuantile(sumSketch, 0.95, storeMeta.count),
          errors: sumErrors,
          slow: sumSlow,
        }
      : null;

  return { api, summary };
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
  const partial = aggregateColumnSlice(
    store.methodCodes,
    store.statuses,
    store.durations,
    store.pathIds,
    store.pathTable,
    0,
    store.count,
    options,
    needSummary,
  );
  return finishApiFromPartials([partial], options, {
    count: store.count,
    unmatchedCount: store.unmatchedCount,
  });
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

/** Build result from parallel AggPartial slices (coordinator merge). */
export function buildResultFromPartials(
  store: ColumnarStore,
  options: ParseOptions,
  partials: AggPartial[],
  cached: { summary: LogSummary; methods: string[] } | null,
): AggregatedResult {
  const needSummary = !cached?.summary;
  const { api, summary: built } = finishApiFromPartials(
    needSummary ? partials : partials.map((p) => ({ buckets: p.buckets, summary: null })),
    options,
    { count: store.count, unmatchedCount: store.unmatchedCount },
  );
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
