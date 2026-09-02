import type {
  ParsePerfStages,
  ReaggPerfStages,
  WorkerMessage,
  WorkerResponse,
} from "../workers/logParserWorker";
import LogParserWorker from "../workers/logParserWorker.ts?worker&inline";
import { useAnalysisStore, workerParseOptions } from "../store/analysisStore";

type Pm2Bench = {
  at: string;
  source: string;
  fileName?: string;
  fileBytes?: number;
  parseWallMs?: number;
  matched?: number;
  unmatched?: number;
  apiEndpoints?: number;
  cronJobs?: number;
  p95Ms?: number;
  crossOriginIsolated?: boolean;
  workerWasmHeapMB?: number;
  stages?: ParsePerfStages;
  reaggTimes: number[];
  reaggStages: ReaggPerfStages[];
  lastReaggMs?: number;
};

declare global {
  interface Window {
    __PM2_BENCH__?: Pm2Bench;
  }
}

function ensureBench(partial?: Partial<Pm2Bench>): Pm2Bench {
  const w = window;
  if (!w.__PM2_BENCH__) {
    w.__PM2_BENCH__ = {
      at: new Date().toISOString(),
      source: "unknown",
      reaggTimes: [],
      reaggStages: [],
    };
  }
  if (partial) Object.assign(w.__PM2_BENCH__, partial);
  return w.__PM2_BENCH__;
}

function createBenchForParse(source: Pm2Bench["source"], fileName?: string, fileBytes?: number) {
  const partial: Partial<Pm2Bench> = {
    at: new Date().toISOString(),
    source,
    crossOriginIsolated: window.crossOriginIsolated,
    reaggTimes: [],
    reaggStages: [],
    parseWallMs: 0,
    workerWasmHeapMB: 0,
  };
  if (fileName !== undefined) partial.fileName = fileName;
  if (fileBytes !== undefined) partial.fileBytes = fileBytes;
  ensureBench(partial);
}

function finalizeBench(parseWallMs: number) {
  const result = useAnalysisStore.getState().result;
  ensureBench({
    parseWallMs,
    matched: result?.summary.matched ?? 0,
    unmatched: result?.summary.unmatched ?? 0,
    apiEndpoints: result?.api.length ?? 0,
    cronJobs: result?.cron.length ?? 0,
    p95Ms: result?.summary.p95Ms ?? 0,
  });
  return result;
}

const { clearAnalysis, setError, setParsing, setProgress, setResult, setWorkerReady, showToast } =
  useAnalysisStore.getState();

let worker: Worker | null = null;
let resolveFn: (() => void) | null = null;
let rejectFn: ((reason: Error) => void) | null = null;

function handlePerfMessage(payload: ParsePerfStages | ReaggPerfStages) {
  const b = ensureBench();
  if (payload.kind === "reagg") b.reaggStages = [...(b.reaggStages ?? []), payload];
  else b.stages = payload;
}

function handleResultMessage(payload: WorkerResponse & { type: "RESULT" }) {
  setResult(payload.payload);
  if (useAnalysisStore.getState().isParsing) {
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

const workerHandlers = {
  PROGRESS: (msg: WorkerResponse) => {
    // SAFETY: handler invoked only for matching type
    setProgress((msg as Extract<WorkerResponse, { type: "PROGRESS" }>).payload);
  },
  PERF: (msg: WorkerResponse) => {
    // SAFETY: payload kind checked inside handlePerfMessage
    handlePerfMessage((msg as Extract<WorkerResponse, { type: "PERF" }>).payload);
  },
  RESULT: (msg: WorkerResponse) => {
    // SAFETY: RESULT payload is AggregatedResult
    handleResultMessage(msg as Extract<WorkerResponse, { type: "RESULT" }>);
  },
  ERROR: (msg: WorkerResponse) => {
    // SAFETY: ERROR payload always has message
    handleErrorMessage((msg as Extract<WorkerResponse, { type: "ERROR" }>).payload);
  },
  DONE: (msg: WorkerResponse) => {
    // SAFETY: DONE payload optional workerWasmHeapMB
    const p = (msg as Extract<WorkerResponse, { type: "DONE" }>).payload;
    if (p?.workerWasmHeapMB != null) ensureBench({ workerWasmHeapMB: p.workerWasmHeapMB });
  },
} satisfies Record<WorkerResponse["type"], (msg: WorkerResponse) => void>;

export function getOrCreateWorker(): Worker {
  if (worker) return worker;
  worker = new LogParserWorker();

  worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
    const msg = e.data;
    // SAFETY: msg.type is a valid WorkerResponse discriminator — handler map is exhaustive
    const handler = workerHandlers[msg.type as keyof typeof workerHandlers];
    if (handler) {
      // SAFETY: handler signature matches WorkerResponse union
      const typedHandler = handler as (m: WorkerResponse) => void;
      typedHandler(msg);
    }
  };

  worker.onerror = (err) => {
    const message = err.message || "Worker error";
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

export function runParse(message: WorkerMessage): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const w = getOrCreateWorker();
    setParsing(true);
    setError(null);
    setProgress({ stage: "parsing", processed: 0, total: 100, percent: 0 });
    resolveFn = resolve;
    rejectFn = reject;
    w.postMessage(message);
  });
}

export function runReagg(message: WorkerMessage): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const w = getOrCreateWorker();
    setError(null);
    resolveFn = resolve;
    rejectFn = reject;
    w.postMessage(message);
  });
}

export async function parseFile(file: File): Promise<void> {
  const options = workerParseOptions(useAnalysisStore.getState().filters);
  createBenchForParse("file", file.name, file.size);
  const t0 = performance.now();
  await runParse({ type: "PARSE_FILE", payload: { file, options } });
  const ms = Math.round(performance.now() - t0);
  const result = finalizeBench(ms);
  showToast(`Parsed ${result?.summary.matched.toLocaleString() ?? 0} requests in ${ms}ms`);
}

export async function parseFiles(files: File[]): Promise<void> {
  if (files.length === 0) return;
  if (files.length === 1) return parseFile(files[0]!);
  const totalBytes = files.reduce((acc, f) => acc + f.size, 0);
  const options = workerParseOptions(useAnalysisStore.getState().filters);
  createBenchForParse("files", `${files.length} files`, totalBytes);
  const t0 = performance.now();
  await runParse({ type: "PARSE_FILES", payload: { files, options } });
  const ms = Math.round(performance.now() - t0);
  const result = finalizeBench(ms);
  showToast(
    `Parsed ${result?.summary.matched.toLocaleString() ?? 0} requests across ${files.length} files in ${ms}ms`,
  );
}

export async function parseText(text: string): Promise<void> {
  const options = workerParseOptions(useAnalysisStore.getState().filters);
  createBenchForParse("text");
  const t0 = performance.now();
  await runParse({ type: "PARSE_TEXT", payload: { text, options } });
  const ms = Math.round(performance.now() - t0);
  const result = finalizeBench(ms);
  showToast(`Parsed ${result?.summary.matched.toLocaleString() ?? 0} requests in ${ms}ms`);
}

export async function reaggregate(): Promise<void> {
  const options = workerParseOptions(useAnalysisStore.getState().filters);
  const t0 = performance.now();
  await runReagg({ type: "REAGGREGATE", payload: { options } });
  const ms = Math.round(performance.now() - t0);
  const b = ensureBench();
  b.lastReaggMs = ms;
  b.reaggTimes = [...(b.reaggTimes ?? []), ms];
}

export function cancel(): void {
  worker?.postMessage({ type: "CANCEL" } satisfies WorkerMessage);
  setParsing(false);
}

export function clear(): void {
  worker?.postMessage({ type: "CLEAR" } satisfies WorkerMessage);
  clearAnalysis();
}

getOrCreateWorker();
