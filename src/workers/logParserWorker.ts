/**
 * Coordinator: persistent Wasm shards; merges compact endpoint partials only.
 */

import {
  aggregateCron,
  finishApiFromPartials,
  type AggregatedResult,
  type AggPartial,
  type CronEventCompact,
  type LogSummary,
  type ParseOptions,
  EMPTY_RESULT,
} from "../parser";
import {
  decodeCronWire,
  decodePm2Partial,
  decodeUnmatchedWire,
  methodsFromMask,
} from "../wasm/decodePartial";
import { compilePm2CoreModule } from "../wasm/loadPm2Core";
import type {
  ShardError,
  ShardParsed,
  ShardPartial,
  ShardReady,
  ShardRequest,
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

export type WorkerMessage =
  | { type: "PARSE_FILE"; payload: { file: File; options: ParseOptions } }
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
  | {
      type: "PERF";
      payload: {
        readMs: number;
        scanParseMs: number;
        internMs: number;
        mergeMs: number;
        aggMs: number;
        totalParseMs: number;
      };
    }
  | { type: "ERROR"; payload: { message: string } }
  | { type: "DONE" };

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
let activeShardCount = 0;
let cachedSummary: { summary: LogSummary; methods: string[] } | null = null;

let lastPerf: {
  readMs: number;
  scanParseMs: number;
  internMs: number;
  mergeMs: number;
  aggMs: number;
  totalParseMs: number;
} | null = null;

function poolSize(): number {
  const hc =
    typeof navigator !== "undefined" && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : 4;
  return Math.max(2, Math.min(4, hc));
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
  activeShardCount = 0;
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

async function ensureShardPool() {
  const n = poolSize();
  if (!wasmModule) wasmModule = await compilePm2CoreModule();
  if (shardPool.length === n && shardsReady) return;

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

function absorbMeta(shards: ShardParsed[]) {
  hitCount = 0;
  unmatchedCount = 0;
  unmatchedSample = [];
  cronEvents = [];
  let mask = 0;
  for (const s of shards) {
    hitCount += s.hitCount;
    unmatchedCount += s.unmatchedCount;
    mask |= s.methodsMask;
    cronEvents.push(...decodeCronWire(new Uint8Array(s.cronWire)));
    for (const line of decodeUnmatchedWire(new Uint8Array(s.unmatchedWire))) {
      if (unmatchedSample.length >= 40) break;
      unmatchedSample.push(line);
    }
  }
  methods = methodsFromMask(mask);
}

async function reaggregateShards(options: ParseOptions): Promise<AggregatedResult> {
  const needSummary = !cachedSummary?.summary;
  if (activeShardCount === 0) return EMPTY_RESULT;

  self.postMessage({
    type: "PROGRESS",
    payload: { stage: "aggregating", processed: 0, total: 100, percent: 0 },
  } satisfies WorkerResponse);

  const t0 = performance.now();
  const tasks: Promise<ShardPartial>[] = [];
  for (let i = 0; i < activeShardCount; i++) {
    tasks.push(
      runShardPartial(shardPool[i]!, {
        type: "REAGGREGATE",
        epoch,
        shardIndex: i,
        normalizeMode: options.normalizeMode,
        statusFamily: options.statusFamily,
        minMs: options.minMs,
        needSummary,
      }),
    );
  }
  const wires = await Promise.all(tasks);
  wires.sort((a, b) => a.shardIndex - b.shardIndex);

  const partials: AggPartial[] = [];
  for (const w of wires) {
    const { partial } = decodePm2Partial(new Uint8Array(w.partial));
    partials.push(needSummary ? partial : { buckets: partial.buckets, summary: null });
  }

  const { api, summary: built } = finishApiFromPartials(partials, options, {
    count: hitCount,
    unmatchedCount,
  });
  const cron = aggregateCron(cronEvents, options);
  const summary = cachedSummary?.summary ?? built!;
  const methodList = cachedSummary?.methods ?? methods;

  let starts = 0;
  let dones = 0;
  let fails = 0;
  for (const e of cronEvents) {
    if (e.event === "start") starts++;
    else if (e.event === "done") dones++;
    else fails++;
  }

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
    methods: methodList,
    unmatchedSample,
    unmatchedCount,
  };

  if (lastPerf) lastPerf.aggMs = performance.now() - t0;
  cachedSummary = { summary: result.summary, methods: result.methods };
  return result;
}

async function parseFileSharded(file: File) {
  epoch++;
  const ep = epoch;
  resetMeta();
  const tParse0 = performance.now();
  const n = shardCountFor(file.size);
  await ensureShardPool();
  clearShards(ep);

  const total = file.size || 1;
  const lastProgress = { t: 0 };
  const PROGRESS_MS = 150;
  let readMs = 0;
  let scanParseMs = 0;

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
    ranges.push({ start: 0, end: file.size });
  } else {
    const chunk = Math.ceil(file.size / n);
    for (let i = 0; i < n; i++) {
      const start = i * chunk;
      const end = i === n - 1 ? file.size : Math.min(file.size, (i + 1) * chunk);
      if (start >= file.size) break;
      ranges.push({ start, end });
    }
  }

  let completedBytes = 0;
  const progressTimer = setInterval(() => {
    postProgress(Math.min(total - 1, completedBytes), false);
  }, PROGRESS_MS);

  try {
    if (cancelled) throw new Error("Cancelled");
    const results = await Promise.all(
      ranges.map((r, i) => {
        const p = runShardParsed(shardPool[i]!, {
          type: "PARSE_SHARD",
          epoch: ep,
          file,
          start: r.start,
          end: r.end,
          shardIndex: i,
        });
        void p.then(() => {
          completedBytes += r.end - r.start;
        });
        return p;
      }),
    );
    if (ep !== epoch) throw new Error("Cancelled");
    results.sort((a, b) => a.shardIndex - b.shardIndex);
    for (const s of results) {
      readMs = Math.max(readMs, s.timing.readMs);
      scanParseMs = Math.max(scanParseMs, s.timing.scanParseMs);
    }
    const tM = performance.now();
    absorbMeta(results);
    activeShardCount = results.length;
    const mergeMs = performance.now() - tM;
    postProgress(total, true);
    lastPerf = {
      readMs,
      scanParseMs,
      internMs: 0,
      mergeMs,
      aggMs: 0,
      totalParseMs: performance.now() - tParse0,
    };
  } finally {
    clearInterval(progressTimer);
  }
}

async function parseText(text: string) {
  epoch++;
  const ep = epoch;
  resetMeta();
  await ensureShardPool();
  clearShards(ep);
  const buf = new TextEncoder().encode(text).buffer;
  const shard = await runShardParsed(shardPool[0]!, {
    type: "PARSE_BYTES",
    epoch: ep,
    buf,
    shardIndex: 0,
  });
  absorbMeta([shard]);
  activeShardCount = 1;
  lastPerf = {
    readMs: 0,
    scanParseMs: shard.timing.scanParseMs,
    internMs: 0,
    mergeMs: 0,
    aggMs: 0,
    totalParseMs: shard.timing.scanParseMs,
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

    if (msg.type === "PARSE_FILE") {
      await parseFileSharded(msg.payload.file);
      if (cancelled) throw new Error("Cancelled");
      const result = await reaggregateShards(msg.payload.options);
      if (lastPerf) {
        self.postMessage({ type: "PERF", payload: lastPerf } satisfies WorkerResponse);
      }
      self.postMessage({ type: "RESULT", payload: result } satisfies WorkerResponse);
      self.postMessage({ type: "DONE" } satisfies WorkerResponse);
      return;
    }

    if (msg.type === "PARSE_TEXT") {
      await parseText(msg.payload.text);
      const result = await reaggregateShards(msg.payload.options);
      self.postMessage({ type: "RESULT", payload: result } satisfies WorkerResponse);
      self.postMessage({ type: "DONE" } satisfies WorkerResponse);
      return;
    }

    if (msg.type === "REAGGREGATE") {
      if (activeShardCount === 0) {
        self.postMessage({ type: "RESULT", payload: EMPTY_RESULT } satisfies WorkerResponse);
        return;
      }
      const result = await reaggregateShards(msg.payload.options);
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
