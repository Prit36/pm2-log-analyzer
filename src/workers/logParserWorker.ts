import {
  aggregateCron,
  finalizeDailyStats,
  finalizeHourlyStats,
  finishApiFromPartials,
  mergeDailyPartials,
  mergeHourlyPartials,
  type AggregatedResult,
  type AggPartial,
  type CronEventCompact,
  type DaySummary,
  type LogSummary,
  type NormalizeMode,
  type ParseOptions,
  EMPTY_RESULT,
} from "../parser";
import {
  decodeCronWire,
  decodeDailyWire,
  decodeDatesWire,
  decodeHourlyWire,
  decodePm2Partial,
  decodeUnmatchedWire,
  methodsFromMask,
  normalizeModeCode,
} from "../wasm/decodePartial";
import { compilePm2CoreModule } from "../wasm/loadPm2Core";
import type {
  ShardError,
  ShardModeReady,
  ShardParsed,
  ShardPartial,
  ShardReady,
  ShardRequest,
  ShardTiming,
} from "./shardParserWorker";
import ShardWorkerCtor from "./shardParserWorker.ts?worker&inline";

export type {
  AggregatedEndpoint,
  AggregatedResult,
  CronAggregated,
  CronSummary,
  LogMethod,
  LogSummary,
  NormalizeMode,
  ParseOptions,
  StatusFamily,
} from "../parser";

/** Parse pipeline stages (max across parallel shards where noted). */
export type ParsePerfStages = {
  kind: "parse";
  wasmCompileMs: number;
  shardPoolInitMs: number;
  readMs: number;
  copyIngestMs: number;
  feedMs: number;
  endShardMs: number;
  metaWireMs: number;
  shardWallMaxMs: number;
  mergeMetaMs: number;
  shardReaggMaxMs: number;
  decodePartialsMs: number;
  finishApiMs: number;
  firstReaggMs: number;
  totalParseMs: number;
  shardCount: number;
};

export type ReaggPerfStages = {
  kind: "reagg";
  shardReaggMaxMs: number;
  decodePartialsMs: number;
  finishApiMs: number;
  totalMs: number;
};

export type WorkerMessage =
  | { type: "PARSE_FILE"; payload: { file: File; options: ParseOptions } }
  | { type: "PARSE_FILES"; payload: { files: File[]; options: ParseOptions } }
  | { type: "PARSE_TEXT"; payload: { text: string; options: ParseOptions } }
  | { type: "REAGGREGATE"; payload: { options: ParseOptions } }
  | { type: "CLEAR" }
  | { type: "CANCEL" };

export type WorkerResponse =
  | {
      type: "PROGRESS";
      payload: {
        stage: "reading" | "parsing" | "aggregating";
        processed: number;
        total: number;
        percent: number;
      };
    }
  | { type: "RESULT"; payload: AggregatedResult }
  | { type: "PERF"; payload: ParsePerfStages | ReaggPerfStages }
  | { type: "ERROR"; payload: { message: string } }
  | {
      type: "DONE";
      /** Debug probe: total Wasm linear memory across shard workers (MB). */
      payload?: { workerWasmHeapMB?: number };
    };

let cancelled = false;
let epoch = 0;
let shardPool: Worker[] = [];
let wasmModule: WebAssembly.Module | null = null;
let shardsReady = false;

let hitCount = 0;
let unmatchedCount = 0;
let unmatchedSample: string[] = [];
let cronEvents: CronEventCompact[] = [];
let methods: string[] = [];
let dates: string[] = [];
let dailyStats: DaySummary[] = [];
let activeShardCount = 0;
let hourlyStats = finalizeHourlyStats(mergeHourlyPartials([]));
let cachedSummary: { summary: LogSummary; methods: string[] } | null = null;

let lastParsePartial:
  | (Omit<
      ParsePerfStages,
      | "kind"
      | "firstReaggMs"
      | "shardReaggMaxMs"
      | "decodePartialsMs"
      | "finishApiMs"
      | "totalParseMs"
    > & { workerWasmHeapMB?: number; paths?: number })
  | null = null;
let parseWallOrigin = 0;

function poolSize(): number {
  const hc = globalThis.navigator?.hardwareConcurrency ?? 4;
  return Math.max(2, Math.min(5, hc));
}

function shardCountFor(fileSize: number): number {
  if (fileSize < 8 * 1024 * 1024) return 1;
  return poolSize();
}

function resetMeta() {
  hitCount = 0;
  unmatchedCount = 0;
  unmatchedSample = [];
  cronEvents = [];
  methods = [];
  dates = [];
  dailyStats = [];
  activeShardCount = 0;
  hourlyStats = finalizeHourlyStats(mergeHourlyPartials([]));
  cachedSummary = null;
}

function waitReady(worker: Worker): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMsg = (e: MessageEvent<ShardReady | ShardError>) => {
      worker.removeEventListener("message", onMsg);
      if (e.data.type === "SHARD_ERROR") {
        reject(new Error(e.data.message));
        return;
      }
      if (e.data.type === "SHARD_READY") resolve();
    };
    worker.addEventListener("message", onMsg);
  });
}

async function ensureShardPool(): Promise<{ wasmCompileMs: number; shardPoolInitMs: number }> {
  const n = poolSize();
  let wasmCompileMs = 0;
  let shardPoolInitMs = 0;

  if (!wasmModule) {
    const t0 = performance.now();
    wasmModule = await compilePm2CoreModule();
    wasmCompileMs = performance.now() - t0;
  }
  if (shardPool.length === n && shardsReady) {
    return { wasmCompileMs, shardPoolInitMs: 0 };
  }

  const t1 = performance.now();
  for (const w of shardPool) w.terminate();
  shardPool = [];
  shardsReady = false;

  const workers: Worker[] = [];
  for (let i = 0; i < n; i++) workers.push(new ShardWorkerCtor());
  await Promise.all(
    workers.map(async (w) => {
      const ready = waitReady(w);
      w.postMessage({ type: "INIT", module: wasmModule! } satisfies ShardRequest);
      await ready;
    }),
  );
  shardPool = workers;
  shardsReady = true;
  shardPoolInitMs = performance.now() - t1;
  return { wasmCompileMs, shardPoolInitMs };
}

function clearShards(ep: number) {
  for (const w of shardPool) {
    w.postMessage({ type: "CLEAR", epoch: ep } satisfies ShardRequest);
  }
}

function runShardParsed(
  worker: Worker,
  req: Extract<ShardRequest, { type: "PARSE_SHARD" | "PARSE_BYTES" }>,
): Promise<ShardParsed> {
  return new Promise((resolve, reject) => {
    const onMsg = (e: MessageEvent<ShardParsed | ShardError>) => {
      const data = e.data;
      if (data.type !== "SHARD_PARSED" && data.type !== "SHARD_ERROR") return;
      worker.removeEventListener("message", onMsg);
      if (data.type === "SHARD_ERROR") {
        reject(new Error(data.message));
        return;
      }
      resolve(data);
    };
    worker.addEventListener("message", onMsg);
    if (req.type === "PARSE_BYTES") worker.postMessage(req, [req.buf]);
    else worker.postMessage(req);
  });
}

function runShardPartial(
  worker: Worker,
  req: Extract<ShardRequest, { type: "REAGGREGATE" }>,
): Promise<ShardPartial> {
  return new Promise((resolve, reject) => {
    const onMsg = (e: MessageEvent<ShardPartial | ShardError>) => {
      const data = e.data;
      if (data.type !== "SHARD_PARTIAL" && data.type !== "SHARD_ERROR") return;
      worker.removeEventListener("message", onMsg);
      if (data.type === "SHARD_ERROR") {
        reject(new Error(data.message));
        return;
      }
      resolve(data);
    };
    worker.addEventListener("message", onMsg);
    worker.postMessage(req);
  });
}

/** Prewarm normalize map; overlaps sibling shard feeds when kicked per SHARD_PARSED. */
function runShardEnsureMode(worker: Worker, epoch: number, mode: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMsg = (e: MessageEvent<ShardModeReady | ShardError>) => {
      const data = e.data;
      if (data.type !== "SHARD_MODE_READY" && data.type !== "SHARD_ERROR") return;
      worker.removeEventListener("message", onMsg);
      if (data.type === "SHARD_ERROR") {
        reject(new Error(data.message));
        return;
      }
      resolve();
    };
    worker.addEventListener("message", onMsg);
    worker.postMessage({ type: "ENSURE_MODE", epoch, mode } satisfies ShardRequest);
  });
}

function absorbMeta(shards: ShardParsed[]) {
  hitCount = 0;
  unmatchedCount = 0;
  unmatchedSample = [];
  cronEvents = [];
  let mask = 0;
  const hourlyPartials = [];
  const allDates: string[] = [];
  const dailyPartials = [];
  for (const s of shards) {
    hitCount += s.hitCount;
    unmatchedCount += s.unmatchedCount;
    mask |= s.methodsMask;
    hourlyPartials.push(decodeHourlyWire(new Uint8Array(s.hourlyWire)));
    cronEvents.push(...decodeCronWire(new Uint8Array(s.cronWire)));
    if (s.datesWire) {
      allDates.push(...decodeDatesWire(new Uint8Array(s.datesWire)));
    }
    if (s.dailyWire) {
      dailyPartials.push(decodeDailyWire(new Uint8Array(s.dailyWire)));
    }
    for (const line of decodeUnmatchedWire(new Uint8Array(s.unmatchedWire))) {
      if (unmatchedSample.length >= 40) break;
      unmatchedSample.push(line);
    }
  }
  hourlyStats = finalizeHourlyStats(mergeHourlyPartials(hourlyPartials));
  methods = methodsFromMask(mask);
  dates = Array.from(new Set(allDates)).sort();
  dailyStats = finalizeDailyStats(mergeDailyPartials(dailyPartials));
  // Summary comes from first reagg (needSummary=true); warm reaggs reuse cache.
  cachedSummary = null;
}

function maxTiming(shards: ShardParsed[]): ShardTiming {
  const z: ShardTiming = {
    readMs: 0,
    copyIngestMs: 0,
    feedMs: 0,
    endShardMs: 0,
    metaWireMs: 0,
    shardWallMs: 0,
  };
  for (const s of shards) {
    const t = s.timing;
    z.readMs = Math.max(z.readMs, t.readMs);
    z.copyIngestMs = Math.max(z.copyIngestMs, t.copyIngestMs);
    z.feedMs = Math.max(z.feedMs, t.feedMs);
    z.endShardMs = Math.max(z.endShardMs, t.endShardMs);
    z.metaWireMs = Math.max(z.metaWireMs, t.metaWireMs);
    z.shardWallMs = Math.max(z.shardWallMs, t.shardWallMs);
  }
  return z;
}

type ReaggTiming = {
  shardReaggMaxMs: number;
  decodePartialsMs: number;
  finishApiMs: number;
  totalMs: number;
};

let prekickedPartials: {
  epoch: number;
  options: ParseOptions;
  tasks: Promise<ShardPartial>[];
} | null = null;

async function reaggregateShards(
  options: ParseOptions,
): Promise<{ result: AggregatedResult; timing: ReaggTiming }> {
  const isDateFiltered = !!options.dateFilter && options.dateFilter !== "all";
  // Summary is filter-independent unless date-filtered; first reagg builds it, later runs reuse cache.
  const needSummary = !cachedSummary?.summary || isDateFiltered;
  if (activeShardCount === 0) {
    return {
      result: EMPTY_RESULT,
      timing: { shardReaggMaxMs: 0, decodePartialsMs: 0, finishApiMs: 0, totalMs: 0 },
    };
  }

  const t0 = performance.now();
  let tasks: Promise<ShardPartial>[];
  if (
    prekickedPartials &&
    prekickedPartials.epoch === epoch &&
    prekickedPartials.options.normalizeMode === options.normalizeMode &&
    prekickedPartials.options.statusFamily === options.statusFamily &&
    prekickedPartials.options.minMs === options.minMs &&
    prekickedPartials.options.dateFilter === options.dateFilter
  ) {
    tasks = prekickedPartials.tasks;
    prekickedPartials = null;
  } else {
    tasks = [];
    for (let i = 0; i < activeShardCount; i++) {
      tasks.push(
        runShardPartial(shardPool[i]!, {
          type: "REAGGREGATE",
          epoch,
          shardIndex: i,
          normalizeMode: options.normalizeMode,
          statusFamily: options.statusFamily,
          minMs: options.minMs,
          dateFilter: options.dateFilter,
          needSummary,
        }),
      );
    }
  }
  const wires = await Promise.all(tasks);
  wires.sort((a, b) => a.shardIndex - b.shardIndex);
  let shardReaggMaxMs = 0;
  for (const w of wires) shardReaggMaxMs = Math.max(shardReaggMaxMs, w.reaggMs);

  const tDecode = performance.now();
  const partials: AggPartial[] = [];
  let totalMatched = 0;
  let totalUnmatched = 0;
  for (const w of wires) {
    const { matched, unmatched, partial } = decodePm2Partial(new Uint8Array(w.partial));
    totalMatched += matched;
    totalUnmatched += unmatched;
    partials.push(needSummary ? partial : { buckets: partial.buckets, summary: null });
  }
  const decodePartialsMs = performance.now() - tDecode;

  const tFinish = performance.now();
  const { api, summary: built } = finishApiFromPartials(partials, options, {
    count: totalMatched,
    unmatchedCount: totalUnmatched,
  });
  const cron = aggregateCron(cronEvents, options);
  const summary = (isDateFiltered ? built : cachedSummary?.summary) ?? built!;
  const methodList = cachedSummary?.methods ?? methods;

  let starts = 0;
  let dones = 0;
  let fails = 0;
  const dateFilter = isDateFiltered ? options.dateFilter! : null;
  for (const e of cronEvents) {
    if (dateFilter && e.ts && !e.ts.startsWith(dateFilter)) continue;
    if (e.event === "start") starts++;
    else if (e.event === "done") dones++;
    else fails++;
  }

  const activeHourlyStats = isDateFiltered
    ? (dailyStats.find((d) => d.date === options.dateFilter)?.hourlyStats ?? hourlyStats)
    : hourlyStats;

  const result: AggregatedResult = {
    api,
    cron,
    summary,
    cronSummary: {
      starts,
      dones,
      fails,
      jobs: cron.length,
      slowestRun: cron.reduce((m, r) => Math.max(m, r.maxMs), 0),
    },
    hourlyStats: activeHourlyStats,
    methods: methodList,
    unmatchedSample,
    unmatchedCount,
    dates,
    dailyStats,
  };
  const finishApiMs = performance.now() - tFinish;
  const totalMs = performance.now() - t0;

  if (!isDateFiltered) {
    cachedSummary = { summary: result.summary, methods: result.methods };
  }
  return {
    result,
    timing: { shardReaggMaxMs, decodePartialsMs, finishApiMs, totalMs },
  };
}

async function parseFilesSharded(input: File | File[], normalizeMode: NormalizeMode) {
  const files = Array.isArray(input) ? input : [input];
  // SAFETY: Blob satisfies the Blob/File slice and size interface consumed by parseBlobChunked.
  const compositeFile = files.length === 1 ? files[0]! : (new Blob(files) as File);
  epoch++;
  const ep = epoch;
  resetMeta();
  parseWallOrigin = performance.now();
  const n = shardCountFor(compositeFile.size);
  const { wasmCompileMs, shardPoolInitMs } = await ensureShardPool();
  clearShards(ep);

  const total = compositeFile.size || 1;
  const lastProgress = { t: 0 };
  const PROGRESS_MS = 150;

  const postProgress = (processed: number, force: boolean) => {
    const now = performance.now();
    if (!force && now - lastProgress.t < PROGRESS_MS) return;
    lastProgress.t = now;
    self.postMessage({
      type: "PROGRESS",
      payload: {
        stage: "parsing",
        processed,
        total,
        percent: Math.min(force ? 100 : 99, Math.round((processed / total) * 100)),
      },
    } satisfies WorkerResponse);
  };

  const ranges: { start: number; end: number }[] = [];
  if (n === 1) {
    ranges.push({ start: 0, end: compositeFile.size });
  } else {
    const chunk = Math.ceil(compositeFile.size / n);
    for (let i = 0; i < n; i++) {
      const start = i * chunk;
      const end = i === n - 1 ? compositeFile.size : Math.min(compositeFile.size, (i + 1) * chunk);
      if (start >= compositeFile.size) break;
      ranges.push({ start, end });
    }
  }

  let completedBytes = 0;
  const progressTimer = setInterval(() => {
    postProgress(Math.min(total - 1, completedBytes), false);
  }, PROGRESS_MS);

  try {
    if (cancelled) throw new Error("Cancelled");
    const defaultOptions: ParseOptions = {
      normalizeMode,
      statusFamily: "all",
      minMs: 0,
      methodFilter: null,
      cronQuery: "",
      cronMinMs: 0,
      cronShowFailedOnly: false,
    };
    const prekickedTasks: Promise<ShardPartial>[] = Array.from({ length: ranges.length });
    prekickedPartials = { epoch: ep, options: defaultOptions, tasks: prekickedTasks };

    const results = await Promise.all(
      ranges.map(async (r, i) => {
        const parsed = await runShardParsed(shardPool[i]!, {
          type: "PARSE_SHARD",
          epoch: ep,
          file: compositeFile,
          start: r.start,
          end: r.end,
          shardIndex: i,
          normalizeMode,
        });
        completedBytes += r.end - r.start;
        if (parsed.partialWire) {
          prekickedTasks[i] = Promise.resolve({
            type: "SHARD_PARTIAL",
            shardIndex: i,
            epoch: ep,
            partial: parsed.partialWire,
            reaggMs: 0,
          });
        }
        return parsed;
      }),
    );
    if (ep !== epoch) throw new Error("Cancelled");
    results.sort((a, b) => a.shardIndex - b.shardIndex);
    const mt = maxTiming(results);
    absorbMeta(results);
    activeShardCount = results.length;
    const wasmHeapMB = results.reduce((s, r) => s + (r.wasmHeapBytes ?? 0), 0) / (1024 * 1024);
    const perShardEntryMB = results.reduce((s, r) => s + (r.hitCount * 16) / (1024 * 1024), 0);
    self.postMessage({
      type: "PROGRESS",
      payload: { stage: "parsing", processed: total, total, percent: 100 },
    } satisfies WorkerResponse);
    const pathCount = results.reduce((s, r) => s + (r.pathCount ?? 0), 0);
    console.info(
      `[memprobe] shards=${results.length} wasmTotal=${wasmHeapMB.toFixed(1)}MB entriesMB=${perShardEntryMB.toFixed(1)} paths=${pathCount}`,
    );
    lastParsePartial = {
      wasmCompileMs,
      shardPoolInitMs,
      readMs: mt.readMs,
      copyIngestMs: mt.copyIngestMs,
      feedMs: mt.feedMs,
      endShardMs: mt.endShardMs,
      metaWireMs: mt.metaWireMs,
      shardWallMaxMs: mt.shardWallMs,
      mergeMetaMs: 0,
      shardCount: results.length,
      workerWasmHeapMB: wasmHeapMB,
      paths: pathCount,
    };
  } finally {
    clearInterval(progressTimer);
  }
}

async function parseText(text: string, normalizeMode: NormalizeMode) {
  epoch++;
  const ep = epoch;
  resetMeta();
  parseWallOrigin = performance.now();
  const { wasmCompileMs, shardPoolInitMs } = await ensureShardPool();
  clearShards(ep);
  const buf = new TextEncoder().encode(text).buffer;
  const shard = await runShardParsed(shardPool[0]!, {
    type: "PARSE_BYTES",
    epoch: ep,
    buf,
    shardIndex: 0,
  });
  await runShardEnsureMode(shardPool[0]!, ep, normalizeModeCode(normalizeMode));
  const tM = performance.now();
  absorbMeta([shard]);
  activeShardCount = 1;
  const mergeMetaMs = performance.now() - tM;
  const mt = shard.timing;
  lastParsePartial = {
    wasmCompileMs,
    shardPoolInitMs,
    readMs: mt.readMs,
    copyIngestMs: mt.copyIngestMs,
    feedMs: mt.feedMs,
    endShardMs: mt.endShardMs,
    metaWireMs: mt.metaWireMs,
    shardWallMaxMs: mt.shardWallMs,
    mergeMetaMs,
    shardCount: 1,
  };
}

function buildParsePerf(reagg: ReaggTiming): ParsePerfStages {
  const base = lastParsePartial!;
  return {
    kind: "parse",
    ...base,
    shardReaggMaxMs: reagg.shardReaggMaxMs,
    decodePartialsMs: reagg.decodePartialsMs,
    finishApiMs: reagg.finishApiMs,
    firstReaggMs: reagg.totalMs,
    totalParseMs: performance.now() - parseWallOrigin,
  };
}

self.onmessage = async (e: MessageEvent<WorkerMessage>) => {
  const msg = e.data;
  try {
    if (msg.type === "CANCEL") {
      cancelled = true;
      epoch++;
      return;
    }
    if (msg.type === "CLEAR") {
      epoch++;
      resetMeta();
      clearShards(epoch);
      self.postMessage({ type: "DONE" } satisfies WorkerResponse);
      return;
    }

    cancelled = false;

    if (msg.type === "PARSE_FILE" || msg.type === "PARSE_FILES") {
      const files = "files" in msg.payload ? msg.payload.files : [msg.payload.file];
      await parseFilesSharded(files, msg.payload.options.normalizeMode);
      if (cancelled) throw new Error("Cancelled");
      const { result, timing } = await reaggregateShards(msg.payload.options);
      if (lastParsePartial) {
        self.postMessage({
          type: "PERF",
          payload: buildParsePerf(timing),
        } satisfies WorkerResponse);
      }
      self.postMessage({ type: "RESULT", payload: result } satisfies WorkerResponse);
      const heapMB = lastParsePartial?.workerWasmHeapMB;
      const doneResponse: WorkerResponse =
        heapMB != null ? { type: "DONE", payload: { workerWasmHeapMB: heapMB } } : { type: "DONE" };
      self.postMessage(doneResponse);
      return;
    }

    if (msg.type === "PARSE_TEXT") {
      await parseText(msg.payload.text, msg.payload.options.normalizeMode);
      const { result, timing } = await reaggregateShards(msg.payload.options);
      if (lastParsePartial) {
        self.postMessage({
          type: "PERF",
          payload: buildParsePerf(timing),
        } satisfies WorkerResponse);
      }
      self.postMessage({ type: "RESULT", payload: result } satisfies WorkerResponse);
      self.postMessage({ type: "DONE" } satisfies WorkerResponse);
      return;
    }

    if (msg.type === "REAGGREGATE") {
      if (activeShardCount === 0) {
        self.postMessage({ type: "RESULT", payload: EMPTY_RESULT } satisfies WorkerResponse);
        return;
      }
      const { result, timing } = await reaggregateShards(msg.payload.options);
      self.postMessage({
        type: "PERF",
        payload: { kind: "reagg", ...timing },
      } satisfies WorkerResponse);
      self.postMessage({ type: "RESULT", payload: result } satisfies WorkerResponse);
      self.postMessage({ type: "DONE" } satisfies WorkerResponse);
    }
  } catch (err) {
    self.postMessage({
      type: "ERROR",
      payload: { message: err instanceof Error ? err.message : String(err) },
    } satisfies WorkerResponse);
  }
};
