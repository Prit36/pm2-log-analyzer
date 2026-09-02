import type {
  MongoWorkerMessage,
  MongoWorkerResponse,
} from "../workers/mongoParserWorker";
import MongoParserWorker from "../workers/mongoParserWorker.ts?worker&inline";
import { useMongoStore } from "../store/mongoStore";

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
  const t0 = performance.now();
  await runMongoParse({ type: "PARSE_FILE", payload: { file, filters } });
  const ms = Math.round(performance.now() - t0);
  const result = useMongoStore.getState().result;
  const count = result?.summary.slowQueryCount ?? 0;
  const collscans = result?.summary.collscanCount ?? 0;
  showToast(`Parsed ${count.toLocaleString()} slow queries (${collscans.toLocaleString()} COLLSCANs) in ${ms}ms`);
}

export async function parseMongoFiles(files: File[]): Promise<void> {
  if (files.length === 0) return;
  if (files.length === 1) return parseMongoFile(files[0]!);
  const filters = useMongoStore.getState().filters;
  const t0 = performance.now();
  await runMongoParse({ type: "PARSE_FILES", payload: { files, filters } });
  const ms = Math.round(performance.now() - t0);
  const result = useMongoStore.getState().result;
  const count = result?.summary.slowQueryCount ?? 0;
  showToast(`Parsed ${count.toLocaleString()} slow queries across ${files.length} files in ${ms}ms`);
}

export async function parseMongoText(text: string): Promise<void> {
  const filters = useMongoStore.getState().filters;
  const t0 = performance.now();
  await runMongoParse({ type: "PARSE_TEXT", payload: { text, filters } });
  const ms = Math.round(performance.now() - t0);
  const result = useMongoStore.getState().result;
  const count = result?.summary.slowQueryCount ?? 0;
  showToast(`Parsed ${count.toLocaleString()} slow queries in ${ms}ms`);
}

export async function reaggregateMongo(): Promise<void> {
  const filters = useMongoStore.getState().filters;
  await runMongoReagg({ type: "REAGGREGATE", payload: { filters } });
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
