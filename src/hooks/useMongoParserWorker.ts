import type { MongoWorkerMessage, MongoWorkerResponse } from "../workers/mongoParserWorker";
import MongoParserWorker from "../workers/mongoParserWorker.ts?worker&inline";
import { useMongoStore } from "../store/mongoStore";
import { isTauri } from "../utils/platform";
import { clearNative, isNativeMongoActive, reaggregateMongoNative } from "../services/nativeBridge";

export type MongoBench = {
  at: string;
  source: string;
  fileName?: string | undefined;
  fileBytes?: number | undefined;
  parseWallMs: number;
  slowQueryCount: number;
  collscanCount: number;
  patternsCount: number;
  collectionsCount: number;
  p95DurationMs: number;
  reaggTimes: number[];
  lastReaggMs?: number | undefined;
};

declare global {
  interface Window {
    __MONGO_BENCH__?: MongoBench;
  }
}

function ensureMongoBench(partial?: Partial<MongoBench>): MongoBench {
  const w = window;
  if (!w.__MONGO_BENCH__) {
    w.__MONGO_BENCH__ = {
      at: new Date().toISOString(),
      source: "unknown",
      parseWallMs: 0,
      slowQueryCount: 0,
      collscanCount: 0,
      patternsCount: 0,
      collectionsCount: 0,
      p95DurationMs: 0,
      reaggTimes: [],
    };
  }
  if (partial) Object.assign(w.__MONGO_BENCH__, partial);
  return w.__MONGO_BENCH__;
}

const { clearAnalysis, setError, setParsing, setProgress, setResult, setWorkerReady, showToast } =
  useMongoStore.getState();

let worker: Worker | null = null;
let resolveFn: (() => void) | null = null;
let rejectFn: ((reason: Error) => void) | null = null;

function handleResultMessage(payload: Extract<MongoWorkerResponse, { type: "RESULT" }>) {
  setResult(payload.payload);
  if (useMongoStore.getState().isParsing) {
    setProgress({ stage: "complete", processed: 100, total: 100, percent: 100 });
    setParsing(false);
  }
  resolveFn?.();
  resolveFn = null;
  rejectFn = null;
}

function handleErrorMessage(payload: { message: string }) {
  setError(payload.message);
  setParsing(false);
  showToast(payload.message);
  rejectFn?.(new Error(payload.message));
  resolveFn = null;
  rejectFn = null;
}

export function getOrCreateMongoWorker(): Worker {
  if (worker) return worker;
  worker = new MongoParserWorker();

  worker.onmessage = (e: MessageEvent<MongoWorkerResponse>) => {
    const msg = e.data;
    if (msg.type === "PROGRESS") {
      setProgress(msg.payload);
    } else if (msg.type === "RESULT") {
      handleResultMessage(msg);
    } else if (msg.type === "ERROR") {
      handleErrorMessage(msg.payload);
    }
  };

  worker.onerror = (err) => {
    const message = err.message || "MongoDB Worker error";
    setError(message);
    setParsing(false);
    showToast(message);
    rejectFn?.(new Error(message));
    resolveFn = null;
    rejectFn = null;
  };

  setWorkerReady(true);
  return worker;
}

export function runMongoParse(
  message: MongoWorkerMessage,
  transfer?: Transferable[],
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const w = getOrCreateMongoWorker();
    setParsing(true);
    setError(null);
    setProgress({ stage: "parsing", processed: 0, total: 100, percent: 0 });
    resolveFn = resolve;
    rejectFn = reject;
    if (transfer && transfer.length > 0) {
      w.postMessage(message, transfer);
    } else {
      w.postMessage(message);
    }
  });
}

export async function parseMongoBuffer(
  buffer: ArrayBuffer,
  fileName: string,
  fileBytes: number,
): Promise<void> {
  const filters = useMongoStore.getState().filters;
  ensureMongoBench({
    at: new Date().toISOString(),
    source: "buffer",
    fileName,
    fileBytes,
    parseWallMs: 0,
    reaggTimes: [],
  });
  const t0 = performance.now();
  await runMongoParse({ type: "PARSE_BUFFER", payload: { buffer, fileName, filters } }, [buffer]);
  const ms = Math.round(performance.now() - t0);
  const result = useMongoStore.getState().result;
  const count = result?.summary.slowQueryCount ?? 0;
  const collscans = result?.summary.collscanCount ?? 0;
  ensureMongoBench({
    parseWallMs: ms,
    slowQueryCount: count,
    collscanCount: collscans,
    patternsCount: result?.patterns.length ?? 0,
    collectionsCount: result?.collections.length ?? 0,
    p95DurationMs: result?.summary.p95DurationMs ?? 0,
  });
  showToast(
    `Parsed ${count.toLocaleString()} slow queries (${collscans.toLocaleString()} COLLSCANs) in ${ms}ms`,
  );
}

export function runMongoReagg(message: MongoWorkerMessage): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const w = getOrCreateMongoWorker();
    setError(null);
    resolveFn = resolve;
    rejectFn = reject;
    w.postMessage(message);
  });
}

export async function parseMongoFile(file: File): Promise<void> {
  const filters = useMongoStore.getState().filters;
  ensureMongoBench({
    at: new Date().toISOString(),
    source: "file",
    fileName: file.name,
    fileBytes: file.size,
    parseWallMs: 0,
    reaggTimes: [],
  });
  const t0 = performance.now();
  await runMongoParse({ type: "PARSE_FILE", payload: { file, filters } });
  const ms = Math.round(performance.now() - t0);
  const result = useMongoStore.getState().result;
  const count = result?.summary.slowQueryCount ?? 0;
  const collscans = result?.summary.collscanCount ?? 0;
  ensureMongoBench({
    parseWallMs: ms,
    slowQueryCount: count,
    collscanCount: collscans,
    patternsCount: result?.patterns.length ?? 0,
    collectionsCount: result?.collections.length ?? 0,
    p95DurationMs: result?.summary.p95DurationMs ?? 0,
  });
  showToast(
    `Parsed ${count.toLocaleString()} slow queries (${collscans.toLocaleString()} COLLSCANs) in ${ms}ms`,
  );
}

export async function parseMongoFiles(files: File[]): Promise<void> {
  if (files.length === 0) return;
  if (files.length === 1) return parseMongoFile(files[0]!);
  const filters = useMongoStore.getState().filters;
  const totalBytes = files.reduce((acc, f) => acc + f.size, 0);
  ensureMongoBench({
    at: new Date().toISOString(),
    source: "files",
    fileName: `${files.length} files`,
    fileBytes: totalBytes,
    parseWallMs: 0,
    reaggTimes: [],
  });
  const t0 = performance.now();
  await runMongoParse({ type: "PARSE_FILES", payload: { files, filters } });
  const ms = Math.round(performance.now() - t0);
  const result = useMongoStore.getState().result;
  const count = result?.summary.slowQueryCount ?? 0;
  const collscans = result?.summary.collscanCount ?? 0;
  ensureMongoBench({
    parseWallMs: ms,
    slowQueryCount: count,
    collscanCount: collscans,
    patternsCount: result?.patterns.length ?? 0,
    collectionsCount: result?.collections.length ?? 0,
    p95DurationMs: result?.summary.p95DurationMs ?? 0,
  });
  showToast(
    `Parsed ${count.toLocaleString()} slow queries across ${files.length} files in ${ms}ms`,
  );
}

let streamStartedAt = 0;

/** Open a streamed import; previous results stay visible until it finishes. */
export function startMongoStreams(): void {
  streamStartedAt = performance.now();
  ensureMongoBench({
    at: new Date().toISOString(),
    source: "stream",
    parseWallMs: 0,
    reaggTimes: [],
  });
  getOrCreateMongoWorker().postMessage({ type: "STREAMS_START" } satisfies MongoWorkerMessage);
}

/** `exactSize` is false when `size` is only a hint, as with gzip trailers. */
export function openMongoSource(
  sourceId: number,
  order: number[],
  size: number,
  exactSize: boolean,
): void {
  getOrCreateMongoWorker().postMessage({
    type: "SOURCE_OPEN",
    payload: { sourceId, order, size, exactSize },
  } satisfies MongoWorkerMessage);
}

/** Transfers `buffer`, which holds the source's bytes from offset `offset`. */
export function pushMongoChunk(sourceId: number, offset: number, buffer: ArrayBuffer): void {
  getOrCreateMongoWorker().postMessage(
    { type: "SOURCE_CHUNK", payload: { sourceId, offset, buffer } } satisfies MongoWorkerMessage,
    [buffer],
  );
}

export function closeMongoSource(sourceId: number, size: number): void {
  getOrCreateMongoWorker().postMessage({
    type: "SOURCE_CLOSE",
    payload: { sourceId, size },
  } satisfies MongoWorkerMessage);
}

export async function finishMongoStreams(fileCount: number, fileBytes: number): Promise<void> {
  const filters = useMongoStore.getState().filters;
  ensureMongoBench({ fileName: `${fileCount} files`, fileBytes });
  await runMongoParse({ type: "STREAMS_FINISH", payload: { filters } });
  const ms = Math.round(performance.now() - streamStartedAt);
  const result = useMongoStore.getState().result;
  const count = result?.summary.slowQueryCount ?? 0;
  ensureMongoBench({
    parseWallMs: ms,
    slowQueryCount: count,
    collscanCount: result?.summary.collscanCount ?? 0,
    patternsCount: result?.patterns.length ?? 0,
    collectionsCount: result?.collections.length ?? 0,
    p95DurationMs: result?.summary.p95DurationMs ?? 0,
  });
  showToast(
    fileCount > 1
      ? `Parsed ${count.toLocaleString()} slow queries across ${fileCount} files in ${ms}ms`
      : `Parsed ${count.toLocaleString()} slow queries in ${ms}ms`,
  );
}

export async function parseMongoText(text: string): Promise<void> {
  const filters = useMongoStore.getState().filters;
  ensureMongoBench({
    at: new Date().toISOString(),
    source: "paste",
    fileBytes: text.length,
    parseWallMs: 0,
    reaggTimes: [],
  });
  const t0 = performance.now();
  await runMongoParse({ type: "PARSE_TEXT", payload: { text, filters } });
  const ms = Math.round(performance.now() - t0);
  const result = useMongoStore.getState().result;
  const count = result?.summary.slowQueryCount ?? 0;
  const collscans = result?.summary.collscanCount ?? 0;
  ensureMongoBench({
    parseWallMs: ms,
    slowQueryCount: count,
    collscanCount: collscans,
    patternsCount: result?.patterns.length ?? 0,
    collectionsCount: result?.collections.length ?? 0,
    p95DurationMs: result?.summary.p95DurationMs ?? 0,
  });
  showToast(`Parsed ${count.toLocaleString()} slow queries in ${ms}ms`);
}

export async function reaggregateMongo(): Promise<void> {
  const t0 = performance.now();
  if (isTauri() && isNativeMongoActive()) {
    await reaggregateMongoNative();
  } else {
    const filters = useMongoStore.getState().filters;
    await runMongoReagg({ type: "REAGGREGATE", payload: { filters } });
  }
  const ms = Math.round(performance.now() - t0);
  const bench = ensureMongoBench();
  bench.lastReaggMs = ms;
  bench.reaggTimes = [...bench.reaggTimes, ms];
}

export async function resetMongoFilters(): Promise<void> {
  useMongoStore.getState().resetFilters();
  await reaggregateMongo();
}

export function cancelMongo(): void {
  worker?.postMessage({ type: "CANCEL" } satisfies MongoWorkerMessage);
  setParsing(false);
}

export function clearMongo(): void {
  if (isTauri() && isNativeMongoActive()) {
    void clearNative();
  }
  worker?.postMessage({ type: "CLEAR" } satisfies MongoWorkerMessage);
  clearAnalysis();
}

// Pre-initialize worker singleton
getOrCreateMongoWorker();
