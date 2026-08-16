import { normalizePath } from "./normalize";
import { percentile, sortAsc } from "./percentiles";
import { makeRelHist, RelHist, type RelHistWire } from "./relHist";
import type {
  AggregatedEndpoint,
  AggregatedResult,
  CronAggregated,
  CronEventCompact,
  CronSummary,
  DaySummary,
  HourlyBucket,
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
  hours?: Uint8Array | undefined;
  dates?: string[] | undefined;
  dateIds?: Uint16Array | undefined;
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

export type HourlyBucketPartial = {
  count: number;
  errorCount: number;
  sum: number;
  max: number;
  sketch: RelHistWire;
};

export type HourlyPartial = {
  buckets: HourlyBucketPartial[];
};

function sketchQuantile(sketch: RelHist, q: number, n: number): number {
  if (n === 0) return 0;
  return sketch.quantile(q);
}

function isLogMethod(m: string): m is LogMethod {
  switch (m) {
    case "GET":
    case "POST":
    case "PUT":
    case "PATCH":
    case "DELETE":
    case "HEAD":
      return true;
    default:
      return false;
  }
}

function methodOkMask(options: ParseOptions): Uint8Array {
  const methodOk = new Uint8Array(METHODS.length);
  if (options.methodFilter && options.methodFilter.length > 0) {
    for (const m of options.methodFilter) {
      if (isLogMethod(m)) {
        const i = METHODS.indexOf(m);
        if (i >= 0) methodOk[i] = 1;
      }
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

export type ApiReaggregateResult = {
  api: AggregatedEndpoint[];
  summary: LogSummary | null;
};

/** Merge normalized-path partials into API rows (+ optional summary). */
export function finishApiFromPartials(
  partials: AggPartial[],
  options: ParseOptions,
  storeMeta: { count: number; unmatchedCount: number },
): ApiReaggregateResult {
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

  for (let pi = 0; pi < partials.length; pi++) {
    const p = partials[pi]!;
    if (p.summary) {
      if (!sumSketch) sumSketch = makeRelHist();
      sumSketch.mergeWire(p.summary.sketch);
      sumSum += p.summary.sum;
      if (p.summary.max > sumMax) sumMax = p.summary.max;
      sumErrors += p.summary.errors;
      sumSlow += p.summary.slow;
    }
    const buckets = p.buckets;
    const bucketLen = buckets.length;
    if (pi === 0) {
      for (let bi = 0; bi < bucketLen; bi++) {
        const b = buckets[bi]!;
        const key = b.method + " " + b.path;
        byNorm.set(key, {
          method: b.method,
          path: b.path,
          sketch: RelHist.fromWire(b.sketch),
          count: b.count,
          sum: b.sum,
          min: b.min,
          max: b.max,
          errorCount: b.errorCount,
        });
      }
    } else {
      for (let bi = 0; bi < bucketLen; bi++) {
        const b = buckets[bi]!;
        const key = b.method + " " + b.path;
        const m = byNorm.get(key);
        if (!m) {
          byNorm.set(key, {
            method: b.method,
            path: b.path,
            sketch: RelHist.fromWire(b.sketch),
            count: b.count,
            sum: b.sum,
            min: b.min,
            max: b.max,
            errorCount: b.errorCount,
          });
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
  }

  // filters already applied in slices
  void options;

  const api: AggregatedEndpoint[] = [];
  for (const [key, v] of byNorm) {
    const c = v.count;
    const [p50Ms, p90Ms, p95Ms, p99Ms] = v.sketch.quantiles4();
    api.push({
      key,
      method: v.method,
      path: v.path,
      count: c,
      avgMs: c ? v.sum / c : 0,
      p50Ms,
      p90Ms,
      p95Ms,
      p99Ms,
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
  const dateFilter = options.dateFilter && options.dateFilter !== "all" ? options.dateFilter : null;
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
    if (dateFilter && ev.ts && !ev.ts.startsWith(dateFilter)) continue;
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

export function mergeHourlyPartials(partials: HourlyPartial[]): HourlyPartial {
  const buckets = Array.from({ length: 24 }, () => ({
    count: 0,
    errorCount: 0,
    sum: 0,
    max: 0,
    sketch: makeRelHist(),
  }));
  for (const partial of partials) {
    for (let hour = 0; hour < 24; hour++) {
      const source = partial.buckets[hour];
      if (!source) continue;
      const target = buckets[hour]!;
      target.count += source.count;
      target.errorCount += source.errorCount;
      target.sum += source.sum;
      if (source.max > target.max) target.max = source.max;
      target.sketch.mergeWire(source.sketch);
    }
  }
  return {
    buckets: buckets.map((bucket) => ({
      count: bucket.count,
      errorCount: bucket.errorCount,
      sum: bucket.sum,
      max: bucket.max,
      sketch: bucket.sketch.toWire(),
    })),
  };
}

export type DayMerged = {
  date: string;
  count: number;
  errorCount: number;
  slowCount: number;
  sum: number;
  max: number;
  sketch: RelHistWire;
  hourly: HourlyBucketPartial[];
};

export type DailyPartial = {
  days: DayMerged[];
};

export type MergedDailyResult = DailyPartial;

export function mergeDailyPartials(partials: DailyPartial[]): MergedDailyResult {
  const map = new Map<
    string,
    {
      date: string;
      count: number;
      errorCount: number;
      slowCount: number;
      sum: number;
      max: number;
      sketch: RelHist;
      hourly: {
        count: number;
        errorCount: number;
        sum: number;
        max: number;
        sketch: RelHist;
      }[];
    }
  >();

  for (const partial of partials) {
    for (const d of partial.days) {
      let target = map.get(d.date);
      if (!target) {
        target = {
          date: d.date,
          count: 0,
          errorCount: 0,
          slowCount: 0,
          sum: 0,
          max: 0,
          sketch: makeRelHist(),
          hourly: Array.from({ length: 24 }, () => ({
            count: 0,
            errorCount: 0,
            sum: 0,
            max: 0,
            sketch: makeRelHist(),
          })),
        };
        map.set(d.date, target);
      }
      target.count += d.count;
      target.errorCount += d.errorCount;
      target.slowCount += d.slowCount;
      target.sum += d.sum;
      if (d.max > target.max) target.max = d.max;
      target.sketch.mergeWire(d.sketch);

      for (let h = 0; h < 24; h++) {
        const srcH = d.hourly[h];
        if (!srcH) continue;
        const tgtH = target.hourly[h]!;
        tgtH.count += srcH.count;
        tgtH.errorCount += srcH.errorCount;
        tgtH.sum += srcH.sum;
        if (srcH.max > tgtH.max) tgtH.max = srcH.max;
        tgtH.sketch.mergeWire(srcH.sketch);
      }
    }
  }

  const days = Array.from(map.values()).map((target) => ({
    date: target.date,
    count: target.count,
    errorCount: target.errorCount,
    slowCount: target.slowCount,
    sum: target.sum,
    max: target.max,
    sketch: target.sketch.toWire(),
    hourly: target.hourly.map((h) => ({
      count: h.count,
      errorCount: h.errorCount,
      sum: h.sum,
      max: h.max,
      sketch: h.sketch.toWire(),
    })),
  }));

  days.sort((a, b) => a.date.localeCompare(b.date));
  return { days };
}

export function finalizeDailyStats(partial: MergedDailyResult): DaySummary[] {
  return partial.days.map((d) => {
    const sk = RelHist.fromWire(d.sketch);
    const hourlyStats: HourlyBucket[] = d.hourly.map((h, hour) => {
      const hSk = RelHist.fromWire(h.sketch);
      return {
        hour,
        label: `${String(hour).padStart(2, "0")}:00`,
        count: h.count,
        errorCount: h.errorCount,
        avgMs: h.count > 0 ? Math.round(h.sum / h.count) : 0,
        p95Ms: Math.round(sketchQuantile(hSk, 0.95, h.count)),
        p99Ms: Math.round(sketchQuantile(hSk, 0.99, h.count)),
        maxMs: Math.round(h.max),
      };
    });

    return {
      date: d.date,
      count: d.count,
      errorCount: d.errorCount,
      slowCount: d.slowCount,
      avgMs: d.count > 0 ? Math.round(d.sum / d.count) : 0,
      p95Ms: Math.round(sketchQuantile(sk, 0.95, d.count)),
      p99Ms: Math.round(sketchQuantile(sk, 0.99, d.count)),
      maxMs: Math.round(d.max),
      hourlyStats,
    };
  });
}

export function buildDailyStats(store: ColumnarStore | undefined): DaySummary[] {
  if (!store || !store.dates || store.dates.length === 0 || !store.dateIds) {
    return [];
  }
  const dates = store.dates;
  const dateIds = store.dateIds;
  const len = store.count;
  const durations = store.durations;
  const statuses = store.statuses;
  const hours = store.hours;

  const daysData = dates.map((date) => ({
    date,
    count: 0,
    errorCount: 0,
    slowCount: 0,
    sum: 0,
    max: 0,
    sketch: makeRelHist(),
    hourly: Array.from({ length: 24 }, (_, i) => ({
      hour: i,
      count: 0,
      errorCount: 0,
      sumMs: 0,
      maxMs: 0,
      sketch: makeRelHist(),
    })),
  }));

  for (let i = 0; i < len; i++) {
    const dId = dateIds[i];
    if (dId !== undefined && dId > 0 && dId <= dates.length) {
      const day = daysData[dId - 1]!;
      const dur = durations[i] ?? 0;
      const st = statuses[i] ?? 200;
      day.count++;
      day.sum += dur;
      if (dur > day.max) day.max = dur;
      if (st >= 400) day.errorCount++;
      if (dur >= 3000) day.slowCount++;
      day.sketch.accept(dur);

      const h = hours ? hours[i] : undefined;
      if (h !== undefined && h >= 0 && h < 24) {
        const hb = day.hourly[h]!;
        hb.count++;
        hb.sumMs += dur;
        if (dur > hb.maxMs) hb.maxMs = dur;
        if (st >= 400) hb.errorCount++;
        hb.sketch.accept(dur);
      }
    }
  }

  return daysData.map((d) => ({
    date: d.date,
    count: d.count,
    errorCount: d.errorCount,
    slowCount: d.slowCount,
    avgMs: d.count > 0 ? Math.round(d.sum / d.count) : 0,
    p95Ms: Math.round(sketchQuantile(d.sketch, 0.95, d.count)),
    p99Ms: Math.round(sketchQuantile(d.sketch, 0.99, d.count)),
    maxMs: Math.round(d.max),
    hourlyStats: d.hourly.map((b) => ({
      hour: b.hour,
      label: `${String(b.hour).padStart(2, "0")}:00`,
      count: b.count,
      errorCount: b.errorCount,
      avgMs: b.count > 0 ? Math.round(b.sumMs / b.count) : 0,
      p95Ms: Math.round(sketchQuantile(b.sketch, 0.95, b.count)),
      p99Ms: Math.round(sketchQuantile(b.sketch, 0.99, b.count)),
      maxMs: Math.round(b.maxMs),
    })),
  }));
}

export function finalizeHourlyStats(partial: HourlyPartial): HourlyBucket[] {
  return partial.buckets.map((bucket, hour) => {
    const sketch = RelHist.fromWire(bucket.sketch);
    return {
      hour,
      label: `${String(hour).padStart(2, "0")}:00`,
      count: bucket.count,
      errorCount: bucket.errorCount,
      avgMs: bucket.count > 0 ? Math.round(bucket.sum / bucket.count) : 0,
      p95Ms: Math.round(sketchQuantile(sketch, 0.95, bucket.count)),
      p99Ms: Math.round(sketchQuantile(sketch, 0.99, bucket.count)),
      maxMs: Math.round(bucket.max),
    };
  });
}

export function buildHourlyStats(store: ColumnarStore | undefined): HourlyBucket[] {
  const buckets = Array.from({ length: 24 }, (_, i) => ({
    hour: i,
    count: 0,
    errorCount: 0,
    sumMs: 0,
    maxMs: 0,
    sketch: makeRelHist(),
  }));

  if (store && store.hours && store.hours.length > 0) {
    const len = store.count;
    const hours = store.hours;
    const durations = store.durations;
    const statuses = store.statuses;

    for (let i = 0; i < len; i++) {
      const h = hours[i];
      if (h !== undefined && h >= 0 && h < 24) {
        const dur = durations[i] ?? 0;
        const st = statuses[i] ?? 200;
        const b = buckets[h]!;
        b.count++;
        b.sumMs += dur;
        if (dur > b.maxMs) b.maxMs = dur;
        if (st >= 400) b.errorCount++;
        b.sketch.accept(dur);
      }
    }
  }

  return buckets.map((b) => ({
    hour: b.hour,
    label: `${String(b.hour).padStart(2, "0")}:00`,
    count: b.count,
    errorCount: b.errorCount,
    avgMs: b.count > 0 ? Math.round(b.sumMs / b.count) : 0,
    p95Ms: Math.round(sketchQuantile(b.sketch, 0.95, b.count)),
    p99Ms: Math.round(sketchQuantile(b.sketch, 0.99, b.count)),
    maxMs: Math.round(b.maxMs),
  }));
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
    hourlyStats: buildHourlyStats(store),
    methods: Array.from(store.methodSeen).sort(),
    unmatchedSample: store.unmatchedSample,
    unmatchedCount: store.unmatchedCount,
    dates: store.dates ? [...store.dates].sort() : [],
    dailyStats: buildDailyStats(store),
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
    hourlyStats: buildHourlyStats(store),
    methods,
    unmatchedSample: store.unmatchedSample,
    unmatchedCount: store.unmatchedCount,
    dates: store.dates ? [...store.dates].sort() : [],
    dailyStats: buildDailyStats(store),
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
    hourlyStats: buildHourlyStats(store),
    methods,
    unmatchedSample: store.unmatchedSample,
    unmatchedCount: store.unmatchedCount,
    dates: store.dates ? [...store.dates].sort() : [],
    dailyStats: buildDailyStats(store),
  };
}
