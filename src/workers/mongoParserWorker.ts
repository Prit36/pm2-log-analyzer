import { compileMongoCoreModule } from "../wasm/loadMongoCore";
import init, { MongoEngine } from "../wasm/pkg_mongo/mongo_core.js";
import {
  DEFAULT_MONGO_FILTERS,
  type MongoAggregationResult,
  type MongoFilters,
} from "../mongo/types";

export type MongoWorkerMessage =
  | { type: "PARSE_FILE"; payload: { file: File; filters: MongoFilters } }
  | { type: "PARSE_FILES"; payload: { files: File[]; filters: MongoFilters } }
  | { type: "PARSE_TEXT"; payload: { text: string; filters: MongoFilters } }
  | { type: "REAGGREGATE"; payload: { filters: MongoFilters } }
  | { type: "CLEAR" }
  | { type: "CANCEL" };

export type MongoWorkerResponse =
  | {
      type: "PROGRESS";
      payload: {
        stage: "reading" | "parsing" | "aggregating";
        processed: number;
        total: number;
        percent: number;
      };
    }
  | { type: "RESULT"; payload: MongoAggregationResult }
  | { type: "PERF"; payload: { kind: "parse" | "reagg"; totalMs: number } }
  | { type: "ERROR"; payload: { message: string } };

let isCancelled = false;
let engine: MongoEngine | null = null;
let wasmMemory: WebAssembly.Memory | null = null;
let isReady = false;
let currentFilters: MongoFilters = { ...DEFAULT_MONGO_FILTERS };

async function ensureEngine(): Promise<MongoEngine> {
  if (isReady && engine) return engine;
  const module = await compileMongoCoreModule();
  const exports = await init({ module_or_path: module });
  wasmMemory = exports.memory;
  engine = new MongoEngine();
  isReady = true;
  return engine;
}

function writeIngest(eng: MongoEngine, src: Uint8Array): number {
  const len = src.length;
  const ptr = eng.ingest_ptr(len);
  // Re-read memory buffer after possible linear memory growth
  new Uint8Array(wasmMemory!.buffer).set(src, ptr);
  return len;
}

function runReaggregate(eng: MongoEngine, filters: MongoFilters): MongoAggregationResult {
  const planCode =
    filters.planFilter === "collscan_only"
      ? 1
      : filters.planFilter === "ixscan_only"
        ? 2
        : 0;

  const jsonStr = eng.reaggregate(
    filters.operation,
    planCode,
    filters.minDurationMs,
    filters.collection,
    filters.searchQuery,
    filters.highScanRatioOnly,
  );

  // SAFETY: Rust reaggregate returns a JSON serialized MongoAggregationResult structure
  return JSON.parse(jsonStr) as MongoAggregationResult;
}

async function streamParseFile(file: File, bytesOffset: number, totalAllBytes: number) {
  const eng = await ensureEngine();
  const CHUNK_SIZE = 8 * 1024 * 1024; // 8MB streaming chunks
  let offset = 0;

  while (offset < file.size) {
    if (isCancelled) return;
    const end = Math.min(offset + CHUNK_SIZE, file.size);
    const slice = file.slice(offset, end);
    const arrayBuffer = await slice.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    writeIngest(eng, bytes);
    eng.feed(bytes.length, offset);

    offset = end;
    const currentTotalBytes = bytesOffset + offset;
    const percent = Math.min(95, Math.round((currentTotalBytes / totalAllBytes) * 95));

    self.postMessage({
      type: "PROGRESS",
      payload: {
        stage: "parsing",
        processed: currentTotalBytes,
        total: totalAllBytes,
        percent,
      },
    } satisfies MongoWorkerResponse);
  }

  eng.end_shard();
}

self.onmessage = async (e: MessageEvent<MongoWorkerMessage>) => {
  const msg = e.data;

  if (msg.type === "CANCEL") {
    isCancelled = true;
    return;
  }

  if (msg.type === "CLEAR") {
    if (engine) engine.clear();
    return;
  }

  if (msg.type === "REAGGREGATE") {
    const t0 = performance.now();
    currentFilters = msg.payload.filters;
    const eng = await ensureEngine();
    const result = runReaggregate(eng, currentFilters);

    self.postMessage({ type: "RESULT", payload: result } satisfies MongoWorkerResponse);
    self.postMessage({
      type: "PERF",
      payload: { kind: "reagg", totalMs: Math.round(performance.now() - t0) },
    } satisfies MongoWorkerResponse);
    return;
  }

  if (msg.type === "PARSE_FILE" || msg.type === "PARSE_FILES") {
    isCancelled = false;
    currentFilters = msg.payload.filters;
    const eng = await ensureEngine();
    eng.clear();

    const t0 = performance.now();
    const files = msg.type === "PARSE_FILE" ? [msg.payload.file] : msg.payload.files;
    const totalBytes = files.reduce((acc, f) => acc + f.size, 0);

    let bytesSoFar = 0;
    for (const file of files) {
      if (isCancelled) break;
      await streamParseFile(file, bytesSoFar, totalBytes);
      bytesSoFar += file.size;
    }

    if (isCancelled) return;

    self.postMessage({
      type: "PROGRESS",
      payload: {
        stage: "aggregating",
        processed: totalBytes,
        total: totalBytes,
        percent: 98,
      },
    } satisfies MongoWorkerResponse);

    const result = runReaggregate(eng, currentFilters);

    self.postMessage({ type: "RESULT", payload: result } satisfies MongoWorkerResponse);
    self.postMessage({
      type: "PERF",
      payload: { kind: "parse", totalMs: Math.round(performance.now() - t0) },
    } satisfies MongoWorkerResponse);
    return;
  }

  if (msg.type === "PARSE_TEXT") {
    isCancelled = false;
    currentFilters = msg.payload.filters;
    const eng = await ensureEngine();
    eng.clear();

    const t0 = performance.now();
    const encoder = new TextEncoder();
    const bytes = encoder.encode(msg.payload.text);

    writeIngest(eng, bytes);
    eng.feed(bytes.length, 0);
    eng.end_shard();

    if (isCancelled) return;

    const result = runReaggregate(eng, currentFilters);

    self.postMessage({ type: "RESULT", payload: result } satisfies MongoWorkerResponse);
    self.postMessage({
      type: "PERF",
      payload: { kind: "parse", totalMs: Math.round(performance.now() - t0) },
    } satisfies MongoWorkerResponse);
  }
};
