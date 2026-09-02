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

const LOG_METHOD_SET = new Set<string>(METHODS);

function isLogMethod(m: string): m is LogMethod {
  return LOG_METHOD_SET.has(m);
}

function methodOkMask(options: ParseOptions): Uint8Array {
  const methodOk = new Uint8Array(METHODS.length);
  const filter = options.methodFilter;
  if (filter && filter.length > 0) {
    for (const m of filter) {
      if (!isLogMethod(m)) continue;
      const idx = METHODS.indexOf(m);
      if (idx >= 0) methodOk[idx] = 1;
    }
    return methodOk;
  }
  methodOk.fill(1);
  return methodOk;
}

// ── Column slice ────────────────────────────────────────────────────────────

type RawEntry = {
  sketch: RelHist;
  count: number;
  sum: number;
  min: number;
  max: number;
  errorCount: number;
};

type SummaryCtx = {
  sum: number;
  max: number;
  errors: number;
  slow: number;
  sketch: RelHist | null;
};

function createSummaryCtx(needSummary: boolean): SummaryCtx {
  return {
    sum: 0,
    max: 0,
    errors: 0,
    slow: 0,
    sketch: needSummary ? makeRelHist() : null,
  };
}

function trackSummary(ctx: SummaryCtx, durationMs: number, status: number): void {
  const sk = ctx.sketch;
  if (!sk) return;
  ctx.sum += durationMs;
  sk.accept(durationMs);
  if (durationMs > ctx.max) ctx.max = durationMs;
  if (status >= 400) ctx.errors++;
  if (durationMs >= 3000) ctx.slow++;
}

function isHitFiltered(
  durationMs: number,
  status: number,
  methodCode: number,
  methodOk: Uint8Array,
  statusWant: number,
  minMs: number,
): boolean {
  if (durationMs < minMs) return true;
  if (!methodOk[methodCode]) return true;
  if (statusWant !== -1 && ((status / 100) | 0) !== statusWant) return true;
  return false;
}

function getOrCreateRawEntry(byRaw: Map<number, RawEntry>, rawKey: number): RawEntry {
  let entry = byRaw.get(rawKey);
  if (entry) return entry;
  entry = {
    sketch: makeRelHist(),
    count: 0,
    sum: 0,
    min: Infinity,
    max: -Infinity,
    errorCount: 0,
  };
  byRaw.set(rawKey, entry);
  return entry;
}

function updateRawEntry(entry: RawEntry, durationMs: number, status: number): void {
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

function collapseRawToNorm(
  byRaw: Map<number, RawEntry>,
  pathTable: string[],
  normalizeMode: ParseOptions["normalizeMode"],
): Map<string, NormEntry> {
  const byNorm = new Map<string, NormEntry>();
  for (const [rawKey, e] of byRaw) {
    const method = METHODS[rawKey & 7]!;
    const normPath = normalizePath(pathTable[rawKey >>> 3]!, normalizeMode);
    const key = `${method} ${normPath}`;
    const dest = byNorm.get(key);
    if (!dest) {
      byNorm.set(key, {
        method,
        path: normPath,
        sketch: e.sketch,
        count: e.count,
        sum: e.sum,
        min: e.min,
        max: e.max,
        errorCount: e.errorCount,
      });
    } else {
      dest.sketch.merge(e.sketch);
      dest.count += e.count;
      dest.sum += e.sum;
      if (e.min < dest.min) dest.min = e.min;
      if (e.max > dest.max) dest.max = e.max;
      dest.errorCount += e.errorCount;
    }
  }
  return byNorm;
}

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
  const summary = createSummaryCtx(needSummary);
  const byRaw = new Map<number, RawEntry>();

  for (let i = start; i < end; i++) {
    const durationMs = durations[i]!;
    const status = statuses[i]!;
    trackSummary(summary, durationMs, status);
    const methodCode = methodCodes[i]!;
    if (isHitFiltered(durationMs, status, methodCode, methodOk, statusWant, options.minMs))
      continue;
    const rawKey = (pathIds[i]! << 3) | methodCode;
    const entry = getOrCreateRawEntry(byRaw, rawKey);
    updateRawEntry(entry, durationMs, status);
  }

  const byNorm = collapseRawToNorm(byRaw, pathTable, options.normalizeMode);
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
    summary: summary.sketch
      ? {
          sum: summary.sum,
          max: summary.max,
          errors: summary.errors,
          slow: summary.slow,
          sketch: summary.sketch.toWire(),
        }
      : null,
  };
}

export type ApiReaggregateResult = {
  api: AggregatedEndpoint[];
  summary: LogSummary | null;
};

// ── Finish / merge ──────────────────────────────────────────────────────────

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

type SummaryMergeCtx = {
  sum: number;
  max: number;
  errors: number;
  slow: number;
  sketch: RelHist | null;
};

function createSummaryMergeCtx(): SummaryMergeCtx {
  return { sum: 0, max: 0, errors: 0, slow: 0, sketch: null };
}

function mergeSummaryWire(ctx: SummaryMergeCtx, wire: NonNullable<AggPartial["summary"]>): void {
  if (!ctx.sketch) ctx.sketch = makeRelHist();
  ctx.sketch.mergeWire(wire.sketch);
  ctx.sum += wire.sum;
  if (wire.max > ctx.max) ctx.max = wire.max;
  ctx.errors += wire.errors;
  ctx.slow += wire.slow;
}

function upsertMerged(byNorm: Map<string, Merged>, b: NormBucketWire): void {
  const key = b.method + " " + b.path;
  const existing = byNorm.get(key);
  if (!existing) {
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
    return;
  }
  existing.sketch.mergeWire(b.sketch);
  existing.count += b.count;
  existing.sum += b.sum;
  if (b.min < existing.min) existing.min = b.min;
  if (b.max > existing.max) existing.max = b.max;
  existing.errorCount += b.errorCount;
}

function buildApiRows(byNorm: Map<string, Merged>): AggregatedEndpoint[] {
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
  return api;
}

export function finishApiFromPartials(
  partials: AggPartial[],
  _options: ParseOptions,
  storeMeta: { count: number; unmatchedCount: number },
): ApiReaggregateResult {
  const byNorm = new Map<string, Merged>();
  const sumCtx = createSummaryMergeCtx();

  for (const p of partials) {
    if (p.summary) mergeSummaryWire(sumCtx, p.summary);
    for (const b of p.buckets) upsertMerged(byNorm, b);
  }

  const api = buildApiRows(byNorm);
  const summary =
    sumCtx.sketch != null
      ? {
          matched: storeMeta.count,
          unmatched: storeMeta.unmatchedCount,
          max: sumCtx.max,
          avg: storeMeta.count ? sumCtx.sum / storeMeta.count : 0,
          p95Ms: sketchQuantile(sumCtx.sketch, 0.95, storeMeta.count),
          errors: sumCtx.errors,
          slow: sumCtx.slow,
        }
      : null;

  return { api, summary };
}

// ── Cron ────────────────────────────────────────────────────────────────────

type CronBucket = {
  name: string;
  starts: number;
  durations: number[];
  fails: number;
  lastRunTs?: string;
  lastDurationMs?: number;
};

function shouldSkipCronEvent(ev: CronEventCompact, dateFilter: string | null, q: string): boolean {
  if (dateFilter && ev.ts && !ev.ts.startsWith(dateFilter)) return true;
  if (q && !ev.name.toLowerCase().includes(q)) return true;
  return false;
}

function getOrCreateCronBucket(map: Map<string, CronBucket>, name: string): CronBucket {
  let bucket = map.get(name);
  if (bucket) return bucket;
  bucket = { name, starts: 0, durations: [], fails: 0 };
  map.set(name, bucket);
  return bucket;
}

function resolveCronDuration(
  ev: CronEventCompact,
  startMap: Map<string, string | undefined>,
  minMs: number,
): number | undefined {
  if (ev.durationMs !== undefined) return ev.durationMs >= minMs ? ev.durationMs : undefined;
  const startTs = startMap.get(ev.name);
  if (!startTs || !ev.ts) return undefined;
  const s = Date.parse(startTs.replace(" ", "T"));
  const e = Date.parse(ev.ts.replace(" ", "T"));
  if (Number.isNaN(s) || Number.isNaN(e) || e < s) return undefined;
  const dur = e - s;
  return dur >= minMs ? dur : undefined;
}

function handleCronStart(
  bucket: CronBucket,
  ev: CronEventCompact,
  startMap: Map<string, string | undefined>,
): void {
  bucket.starts++;
  startMap.set(ev.name, ev.ts);
}

function handleCronCompletion(
  bucket: CronBucket,
  ev: CronEventCompact,
  startMap: Map<string, string | undefined>,
  minMs: number,
): void {
  const dur = resolveCronDuration(ev, startMap, minMs);
  startMap.delete(ev.name);
  if (dur !== undefined) {
    bucket.durations.push(dur);
    bucket.lastDurationMs = dur;
    if (ev.ts) bucket.lastRunTs = ev.ts;
  }
  if (ev.event === "fail") bucket.fails++;
}

function buildCronRows(
  map: Map<string, CronBucket>,
  cronShowFailedOnly: boolean,
): CronAggregated[] {
  const out: CronAggregated[] = [];
  for (const b of map.values()) {
    if (cronShowFailedOnly && b.fails === 0) continue;
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

export function aggregateCron(events: CronEventCompact[], options: ParseOptions): CronAggregated[] {
  const q = options.cronQuery.trim().toLowerCase();
  const minMs = options.cronMinMs;
  const dateFilter = options.dateFilter && options.dateFilter !== "all" ? options.dateFilter : null;
  const map = new Map<string, CronBucket>();
  const startMap = new Map<string, string | undefined>();

  for (const ev of events) {
    if (shouldSkipCronEvent(ev, dateFilter, q)) continue;
    const bucket = getOrCreateCronBucket(map, ev.name);
    if (ev.event === "start") handleCronStart(bucket, ev, startMap);
    else handleCronCompletion(bucket, ev, startMap, minMs);
  }

  return buildCronRows(map, options.cronShowFailedOnly);
}

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

function ensureDayEntry(
  map: Map<
    string,
    {
      date: string;
      count: number;
      errorCount: number;
      slowCount: number;
      sum: number;
      max: number;
      sketch: RelHist;
      hourly: { count: number; errorCount: number; sum: number; max: number; sketch: RelHist }[];
    }
  >,
  date: string,
) {
  let target = map.get(date);
  if (target) return target;
  target = {
    date,
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
  map.set(date, target);
  return target;
}

function mergeDayFromPartial(target: ReturnType<typeof ensureDayEntry>, d: DayMerged): void {
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

export function mergeDailyPartials(partials: DailyPartial[]): MergedDailyResult {
  const map = new Map<string, ReturnType<typeof ensureDayEntry>>();

  for (const partial of partials) {
    for (const d of partial.days) {
      const target = ensureDayEntry(map, d.date);
      mergeDayFromPartial(target, d);
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

// ── Daily / Hourly builders ─────────────────────────────────────────────────

type DaySkeleton = {
  date: string;
  count: number;
  errorCount: number;
  slowCount: number;
  sum: number;
  max: number;
  sketch: RelHist;
  hourly: {
    hour: number;
    count: number;
    errorCount: number;
    sumMs: number;
    maxMs: number;
    sketch: RelHist;
  }[];
};

function createDaySkeletons(dates: string[]): DaySkeleton[] {
  return dates.map((date) => ({
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
}

function updateDayWithHit(
  day: DaySkeleton,
  dur: number,
  status: number,
  hour: number | undefined,
): void {
  day.count++;
  day.sum += dur;
  if (dur > day.max) day.max = dur;
  if (status >= 400) day.errorCount++;
  if (dur >= 3000) day.slowCount++;
  day.sketch.accept(dur);
  if (hour === undefined || hour < 0 || hour >= 24) return;
  const hb = day.hourly[hour]!;
  hb.count++;
  hb.sumMs += dur;
  if (dur > hb.maxMs) hb.maxMs = dur;
  if (status >= 400) hb.errorCount++;
  hb.sketch.accept(dur);
}

function daySkeletonToSummary(d: DaySkeleton): DaySummary {
  const sk = d.sketch;
  return {
    date: d.date,
    count: d.count,
    errorCount: d.errorCount,
    slowCount: d.slowCount,
    avgMs: d.count > 0 ? Math.round(d.sum / d.count) : 0,
    p95Ms: Math.round(sketchQuantile(sk, 0.95, d.count)),
    p99Ms: Math.round(sketchQuantile(sk, 0.99, d.count)),
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
  };
}

export function buildDailyStats(store: ColumnarStore | undefined): DaySummary[] {
  if (!store || !store.dates || store.dates.length === 0 || !store.dateIds) return [];
  const daysData = createDaySkeletons(store.dates);
  const len = store.count;
  for (let i = 0; i < len; i++) {
    const dId = store.dateIds![i];
    if (dId === undefined || dId === 0 || dId > store.dates.length) continue;
    const day = daysData[dId - 1]!;
    const dur = store.durations[i] ?? 0;
    const st = store.statuses[i] ?? 200;
    const h = store.hours ? store.hours[i] : undefined;
    updateDayWithHit(day, dur, st, h);
  }
  return daysData.map(daySkeletonToSummary);
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

type HourlyAcc = {
  hour: number;
  count: number;
  errorCount: number;
  sumMs: number;
  maxMs: number;
  sketch: RelHist;
};

function createHourlyAccs(): HourlyAcc[] {
  return Array.from({ length: 24 }, (_, i) => ({
    hour: i,
    count: 0,
    errorCount: 0,
    sumMs: 0,
    maxMs: 0,
    sketch: makeRelHist(),
  }));
}

function updateHourlyAcc(
  buckets: HourlyAcc[],
  hour: number | undefined,
  dur: number,
  status: number,
): void {
  if (hour === undefined || hour < 0 || hour >= 24) return;
  const b = buckets[hour]!;
  b.count++;
  b.sumMs += dur;
  if (dur > b.maxMs) b.maxMs = dur;
  if (status >= 400) b.errorCount++;
  b.sketch.accept(dur);
}

export function buildHourlyStats(store: ColumnarStore | undefined): HourlyBucket[] {
  const buckets = createHourlyAccs();
  if (store?.hours?.length) {
    for (let i = 0; i < store.count; i++)
      updateHourlyAcc(buckets, store.hours[i], store.durations[i] ?? 0, store.statuses[i] ?? 200);
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

export function buildResult(store: ColumnarStore, options: ParseOptions): AggregatedResult {
  const { api, summary } = aggregateApiWithSummary(store, options, true);
  const cron = aggregateCron(store.cronEvents, options);
  return {
    api,
    cron,
    summary: summary!,
    cronSummary: buildCronSummary(store.cronEvents, cron),
    hourlyStats: buildHourlyStats(store),
    methods: Array.from(store.methodSeen).sort((a, b) => a.localeCompare(b)),
    unmatchedSample: store.unmatchedSample,
    unmatchedCount: store.unmatchedCount,
    dates: store.dates ? [...store.dates].sort((a, b) => a.localeCompare(b)) : [],
    dailyStats: buildDailyStats(store),
  };
}

export function buildResultCached(
  store: ColumnarStore,
  options: ParseOptions,
  cached: { summary: LogSummary; methods: string[] } | null,
): AggregatedResult {
  const needSummary = !cached?.summary;
  const { api, summary: built } = aggregateApiWithSummary(store, options, needSummary);
  const cron = aggregateCron(store.cronEvents, options);
  return {
    api,
    cron,
    summary: cached?.summary ?? built!,
    cronSummary: buildCronSummary(store.cronEvents, cron),
    hourlyStats: buildHourlyStats(store),
    methods: cached?.methods ?? Array.from(store.methodSeen).sort((a, b) => a.localeCompare(b)),
    unmatchedSample: store.unmatchedSample,
    unmatchedCount: store.unmatchedCount,
    dates: store.dates ? [...store.dates].sort((a, b) => a.localeCompare(b)) : [],
    dailyStats: buildDailyStats(store),
  };
}

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
  return {
    api,
    cron,
    summary: cached?.summary ?? built!,
    cronSummary: buildCronSummary(store.cronEvents, cron),
    hourlyStats: buildHourlyStats(store),
    methods: cached?.methods ?? Array.from(store.methodSeen).sort((a, b) => a.localeCompare(b)),
    unmatchedSample: store.unmatchedSample,
    unmatchedCount: store.unmatchedCount,
    dates: store.dates ? [...store.dates].sort((a, b) => a.localeCompare(b)) : [],
    dailyStats: buildDailyStats(store),
  };
}
