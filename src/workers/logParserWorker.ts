/**
 * Coordinator worker: shard File.slice parse across child workers, merge stores, aggregate.
 */

import {
  METHOD_INDEX,
  buildResultCached,
  buildResultFromPartials,
  createLineScratch,
  parseLineInto,
  type AggregatedResult,
  type AggPartial,
  type CronEventCompact,
  type LogMethod,
  type LogSummary,
  type ParseOptions,
  EMPTY_RESULT,
} from "../parser";
import type { ShardError, ShardRequest, ShardResult } from "./shardParserWorker";
import type { AggShardError, AggShardRequest, AggShardResult } from "./aggShardWorker";
// Inline so vite-plugin-singlefile does not leave separate worker chunks
import ShardWorkerCtor from "./shardParserWorker.ts?worker&inline";
import AggWorkerCtor from "./aggShardWorker.ts?worker&inline";

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
  | { type: "ERROR"; payload: { message: string } }
  | { type: "DONE" };

/** Below this hit count, parallel reagg isn't worth the worker fan-out. */
const PARALLEL_AGG_MIN = 250_000;

function canShareColumns(): boolean {
  return typeof SharedArrayBuffer !== "undefined" && !!self.crossOriginIsolated;
}

function allocU8(n: number): Uint8Array {
  return canShareColumns() ? new Uint8Array(new SharedArrayBuffer(n)) : new Uint8Array(n);
}
function allocU16(n: number): Uint16Array {
  return canShareColumns()
    ? new Uint16Array(new SharedArrayBuffer(n * 2))
    : new Uint16Array(n);
}
function allocF32(n: number): Float32Array {
  return canShareColumns()
    ? new Float32Array(new SharedArrayBuffer(n * 4))
    : new Float32Array(n);
}
function allocU32(n: number): Uint32Array {
  return canShareColumns()
    ? new Uint32Array(new SharedArrayBuffer(n * 4))
    : new Uint32Array(n);
}

let cancelled = false;
let methodCodes = new Uint8Array(0);
let statuses = new Uint16Array(0);
let durations = new Float32Array(0);
let pathIds = new Uint32Array(0);
let pathTable: string[] = [];
let pathIndex = new Map<string, number>();
let count = 0;
let capacity = 0;
let unmatchedCount = 0;
let unmatchedSample: string[] = [];
let cronEvents: CronEventCompact[] = [];
let methodSeen = new Set<string>();
let cachedSummary: { summary: LogSummary; methods: string[] } | null = null;

let shardPool: Worker[] = [];
let aggPool: Worker[] = [];
/** Bumped when pathTable identity changes; agg workers refresh when mismatched. */
let pathTableGen = 0;
let aggPathTableGen = -1;
/** Bumped when column SharedArrayBuffers are replaced (capacity growth). */
let columnsGen = 0;
let aggColumnsGen = -1;

function resetStore() {
  methodCodes = new Uint8Array(0);
  statuses = new Uint16Array(0);
  durations = new Float32Array(0);
  pathIds = new Uint32Array(0);
  pathTable = [];
  pathIndex = new Map();
  count = 0;
  capacity = 0;
  unmatchedCount = 0;
  unmatchedSample = [];
  cronEvents = [];
  methodSeen = new Set();
  cachedSummary = null;
  pathTableGen++;
  columnsGen++;
}

function terminateShards() {
  for (const w of shardPool) w.terminate();
  shardPool = [];
}

function terminateAgg() {
  for (const w of aggPool) w.terminate();
  aggPool = [];
  aggPathTableGen = -1;
  aggColumnsGen = -1;
}

function ensureCapacity(need: number) {
  if (need <= capacity) return;
  const next = Math.max(capacity * 2 || 65536, need);
  const mc = allocU8(next);
  const st = allocU16(next);
  const du = allocF32(next);
  const pi = allocU32(next);
  if (capacity > 0) {
    mc.set(methodCodes.subarray(0, count));
    st.set(statuses.subarray(0, count));
    du.set(durations.subarray(0, count));
    pi.set(pathIds.subarray(0, count));
  }
  methodCodes = mc;
  statuses = st;
  durations = du;
  pathIds = pi;
  capacity = next;
  columnsGen++;
}

function internPath(path: string): number {
  let id = pathIndex.get(path);
  if (id !== undefined) return id;
  id = pathTable.length;
  pathTable.push(path);
  pathIndex.set(path, id);
  return id;
}

const lineScratch = createLineScratch();

function pushRequest(method: LogMethod, path: string, status: number, durationMs: number) {
  ensureCapacity(count + 1);
  const mi = METHOD_INDEX.get(method);
  if (mi === undefined) return;
  methodCodes[count] = mi;
  statuses[count] = status;
  durations[count] = durationMs;
  pathIds[count] = internPath(path);
  count++;
  methodSeen.add(method);
}

function ingestLine(line: string) {
  parseLineInto(line, lineScratch);
  if (lineScratch.kind === "empty") return;
  if (lineScratch.kind === "cron") {
    cronEvents.push(lineScratch.cron!);
    return;
  }
  if (lineScratch.kind === "http") {
    pushRequest(lineScratch.method, lineScratch.path, lineScratch.status, lineScratch.durationMs);
    return;
  }
  unmatchedCount++;
  if (unmatchedSample.length < 40) unmatchedSample.push(line.slice(0, 500));
}

function storeSnapshot() {
  return {
    methodCodes,
    statuses,
    durations,
    pathIds,
    pathTable,
    count,
    unmatchedCount,
    unmatchedSample,
    cronEvents,
    methodSeen,
  };
}

function poolSize(): number {
  const hc =
    typeof navigator !== "undefined" && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : 4;
  return Math.max(2, Math.min(4, hc));
}

function runAggSlice(
  worker: Worker,
  req: Extract<AggShardRequest, { type: "AGG_SLICE" }>,
): Promise<AggPartial> {
  return new Promise((resolve, reject) => {
    const onMsg = (e: MessageEvent<AggShardResult | AggShardError>) => {
      worker.removeEventListener("message", onMsg);
      const data = e.data;
      if (data.type === "AGG_ERROR") {
        reject(new Error(data.message));
        return;
      }
      resolve(data.partial);
    };
    worker.addEventListener("message", onMsg);
    worker.postMessage(req);
  });
}

async function aggregateParallel(options: ParseOptions): Promise<AggregatedResult> {
  const needSummary = !cachedSummary?.summary;
  // Without SharedArrayBuffer (no COOP/COEP), column copies cancel the parallel win — stay sync.
  const n =
    count < PARALLEL_AGG_MIN || !canShareColumns() ? 1 : poolSize();

  if (n === 1) {
    return buildResultCached(storeSnapshot(), options, cachedSummary);
  }

  if (aggPool.length !== n) {
    terminateAgg();
    for (let i = 0; i < n; i++) aggPool.push(new AggWorkerCtor());
  }
  if (aggPathTableGen !== pathTableGen) {
    for (const w of aggPool) {
      w.postMessage({ type: "SET_PATH_TABLE", pathTable } satisfies AggShardRequest);
    }
    aggPathTableGen = pathTableGen;
  }
  if (aggColumnsGen !== columnsGen) {
    const mc = methodCodes.buffer as SharedArrayBuffer;
    const st = statuses.buffer as SharedArrayBuffer;
    const du = durations.buffer as SharedArrayBuffer;
    const pi = pathIds.buffer as SharedArrayBuffer;
    for (const w of aggPool) {
      w.postMessage({
        type: "SET_COLUMNS",
        methodCodes: mc,
        statuses: st,
        durations: du,
        pathIds: pi,
      } satisfies AggShardRequest);
    }
    aggColumnsGen = columnsGen;
  }

  const chunk = Math.ceil(count / n);
  const tasks: Promise<AggPartial>[] = [];
  for (let i = 0; i < n; i++) {
    const start = i * chunk;
    const end = Math.min(count, (i + 1) * chunk);
    if (start >= end) break;
    tasks.push(
      runAggSlice(aggPool[i]!, {
        type: "AGG_SLICE",
        shardIndex: i,
        start,
        end,
        options,
        needSummary,
      }),
    );
  }
  const partials = await Promise.all(tasks);
  return buildResultFromPartials(storeSnapshot(), options, partials, cachedSummary);
}

async function makeResult(options: ParseOptions): Promise<AggregatedResult> {
  self.postMessage({
    type: "PROGRESS",
    payload: { stage: "aggregating", processed: 0, total: 100, percent: 0 },
  } satisfies WorkerResponse);
  const result = await aggregateParallel(options);
  cachedSummary = { summary: result.summary, methods: result.methods };
  return result;
}

function shardCountFor(fileSize: number): number {
  if (fileSize < 8 * 1024 * 1024) return 1;
  return poolSize();
}

function mergeShard(shard: ShardResult) {
  const remap = new Uint32Array(shard.pathTable.length);
  for (let p = 0; p < shard.pathTable.length; p++) {
    remap[p] = internPath(shard.pathTable[p]!);
  }
  ensureCapacity(count + shard.count);
  methodCodes.set(shard.methodCodes, count);
  statuses.set(shard.statuses, count);
  durations.set(shard.durations, count);
  for (let i = 0; i < shard.count; i++) {
    pathIds[count + i] = remap[shard.pathIds[i]!]!;
  }
  count += shard.count;
  unmatchedCount += shard.unmatchedCount;
  for (const s of shard.unmatchedSample) {
    if (unmatchedSample.length >= 40) break;
    unmatchedSample.push(s);
  }
  for (const ev of shard.cronEvents) cronEvents.push(ev);
  for (const m of shard.methods) methodSeen.add(m);
}

function runShard(worker: Worker, req: ShardRequest): Promise<ShardResult> {
  return new Promise((resolve, reject) => {
    const onMsg = (e: MessageEvent<ShardResult | ShardError>) => {
      worker.removeEventListener("message", onMsg);
      const data = e.data;
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

async function parseFileSharded(file: File) {
  resetStore();
  terminateShards();
  const n = shardCountFor(file.size);
  const total = file.size || 1;
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

  if (n === 1) {
    const worker = new ShardWorkerCtor();
    shardPool = [worker];
    if (cancelled) throw new Error("Cancelled");
    const shard = await runShard(worker, {
      type: "PARSE_SHARD",
      file,
      start: 0,
      end: file.size,
      shardIndex: 0,
    });
    mergeShard(shard);
    postProgress(total, true);
    terminateShards();
    return;
  }

  const chunk = Math.ceil(file.size / n);
  const ranges: { start: number; end: number }[] = [];
  for (let i = 0; i < n; i++) {
    const start = i * chunk;
    const end = i === n - 1 ? file.size : Math.min(file.size, (i + 1) * chunk);
    if (start >= file.size) break;
    ranges.push({ start, end });
  }

  shardPool = ranges.map(() => new ShardWorkerCtor());

  let completedBytes = 0;
  const progressTimer = setInterval(() => {
    postProgress(Math.min(total - 1, completedBytes), false);
  }, PROGRESS_MS);

  try {
    if (cancelled) throw new Error("Cancelled");
    const results = await Promise.all(
      ranges.map((r, i) => {
        const p = runShard(shardPool[i]!, {
          type: "PARSE_SHARD",
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
    results.sort((a, b) => a.shardIndex - b.shardIndex);
    for (const shard of results) mergeShard(shard);
    postProgress(total, true);
  } finally {
    clearInterval(progressTimer);
    terminateShards();
  }
}

function parseText(text: string) {
  resetStore();
  const lines = text.split(/\r?\n/);
  const total = lines.length || 1;
  let last = 0;
  for (let i = 0; i < lines.length; i++) {
    if (cancelled) throw new Error("Cancelled");
    ingestLine(lines[i]!);
    const now = performance.now();
    if (now - last > 150) {
      last = now;
      self.postMessage({
        type: "PROGRESS",
        payload: {
          stage: "parsing",
          processed: i + 1,
          total,
          percent: Math.round(((i + 1) / total) * 100),
        },
      } satisfies WorkerResponse);
    }
  }
}

self.onmessage = async (e: MessageEvent<WorkerMessage>) => {
  const msg = e.data;
  try {
    if (msg.type === "CANCEL") {
      cancelled = true;
      terminateShards();
      terminateAgg();
      return;
    }
    if (msg.type === "CLEAR") {
      resetStore();
      terminateShards();
      terminateAgg();
      self.postMessage({ type: "DONE" } satisfies WorkerResponse);
      return;
    }

    cancelled = false;

    if (msg.type === "PARSE_FILE") {
      await parseFileSharded(msg.payload.file);
      if (cancelled) throw new Error("Cancelled");
      const result = await makeResult(msg.payload.options);
      self.postMessage({ type: "RESULT", payload: result } satisfies WorkerResponse);
      self.postMessage({ type: "DONE" } satisfies WorkerResponse);
      return;
    }

    if (msg.type === "PARSE_TEXT") {
      parseText(msg.payload.text);
      const result = await makeResult(msg.payload.options);
      self.postMessage({ type: "RESULT", payload: result } satisfies WorkerResponse);
      self.postMessage({ type: "DONE" } satisfies WorkerResponse);
      return;
    }

    if (msg.type === "REAGGREGATE") {
      if (count === 0 && cronEvents.length === 0) {
        self.postMessage({ type: "RESULT", payload: EMPTY_RESULT } satisfies WorkerResponse);
        return;
      }
      const result = await makeResult(msg.payload.options);
      self.postMessage({ type: "RESULT", payload: result } satisfies WorkerResponse);
      self.postMessage({ type: "DONE" } satisfies WorkerResponse);
    }
  } catch (err) {
    terminateShards();
    terminateAgg();
    self.postMessage({
      type: "ERROR",
      payload: { message: err instanceof Error ? err.message : String(err) },
    } satisfies WorkerResponse);
  }
};
