import type {
  MongoWorkerMessage,
  MongoWorkerResponse,
} from "../workers/mongoParserWorker";
import MongoParserWorker from "../workers/mongoParserWorker.ts?worker&inline";
import { useMongoStore } from "../store/mongoStore";

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

const {
  clearAnalysis,
  setError,
  setParsing,
  setProgress,
  setResult,
  setWorkerReady,
  showToast,
} = useMongoStore.getState();

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

export function runMongoParse(message: MongoWorkerMessage): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const w = getOrCreateMongoWorker();
    setParsing(true);
    setError(null);
    setProgress({ stage: "parsing", processed: 0, total: 100, percent: 0 });
    resolveFn = resolve;
    rejectFn = reject;
    w.postMessage(message);
  });
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
  showToast(`Parsed ${count.toLocaleString()} slow queries (${collscans.toLocaleString()} COLLSCANs) in ${ms}ms`);
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
  showToast(`Parsed ${count.toLocaleString()} slow queries across ${files.length} files in ${ms}ms`);
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
  const filters = useMongoStore.getState().filters;
  const t0 = performance.now();
  await runMongoReagg({ type: "REAGGREGATE", payload: { filters } });
  const ms = Math.round(performance.now() - t0);
  const bench = ensureMongoBench();
  bench.lastReaggMs = ms;
  bench.reaggTimes = [...bench.reaggTimes, ms];
}

export function cancelMongo(): void {
  worker?.postMessage({ type: "CANCEL" } satisfies MongoWorkerMessage);
  setParsing(false);
}

export function clearMongo(): void {
  worker?.postMessage({ type: "CLEAR" } satisfies MongoWorkerMessage);
  clearAnalysis();
}

// Pre-initialize worker singleton
getOrCreateMongoWorker();
