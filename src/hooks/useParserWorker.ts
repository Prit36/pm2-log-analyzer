import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ParsePerfStages,
  ReaggPerfStages,
  WorkerMessage,
  WorkerResponse,
} from "../workers/logParserWorker";
import LogParserWorker from "../workers/logParserWorker.ts?worker&inline";
import {
  useAnalysisStore,
  workerParseOptions,
  type ParseProgress,
} from "../store/analysisStore";

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
  stages?: ParsePerfStages;
  reaggTimes: number[];
  reaggStages: ReaggPerfStages[];
  lastReaggMs?: number;
};

function benchWin(): Window & { __PM2_BENCH__?: Pm2Bench } {
  return window as Window & { __PM2_BENCH__?: Pm2Bench };
}

function ensureBench(partial?: Partial<Pm2Bench>): Pm2Bench {
  const w = benchWin();
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

export function useParserWorker() {
  const workerRef = useRef<Worker | null>(null);
  const resolveRef = useRef<((value: unknown) => void) | null>(null);
  const rejectRef = useRef<((reason: Error) => void) | null>(null);
  const skipNextReagg = useRef(false);

  const setWorkerReady = useAnalysisStore((s) => s.setWorkerReady);
  const setParsing = useAnalysisStore((s) => s.setParsing);
  const setProgress = useAnalysisStore((s) => s.setProgress);
  const setResult = useAnalysisStore((s) => s.setResult);
  const setError = useAnalysisStore((s) => s.setError);
  const showToast = useAnalysisStore((s) => s.showToast);

  useEffect(() => {
    const worker = new LogParserWorker();
    workerRef.current = worker;

    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      switch (msg.type) {
        case "PROGRESS":
          setProgress(msg.payload as ParseProgress);
          break;
        case "PERF": {
          const b = ensureBench();
          if (msg.payload.kind === "reagg") {
            b.reaggStages = [...(b.reaggStages ?? []), msg.payload];
          } else {
            b.stages = msg.payload;
          }
          break;
        }
        case "RESULT":
          setResult(msg.payload);
          setProgress({ stage: "complete", processed: 100, total: 100, percent: 100 });
          setParsing(false);
          resolveRef.current?.(msg.payload);
          resolveRef.current = null;
          rejectRef.current = null;
          break;
        case "ERROR":
          setError(msg.payload.message);
          setParsing(false);
          showToast(msg.payload.message);
          rejectRef.current?.(new Error(msg.payload.message));
          resolveRef.current = null;
          rejectRef.current = null;
          break;
        case "DONE":
          break;
      }
    };

    worker.onerror = (err) => {
      const message = err.message || "Worker error";
      setError(message);
      setParsing(false);
      showToast(message);
      rejectRef.current?.(new Error(message));
      resolveRef.current = null;
      rejectRef.current = null;
    };

    setWorkerReady(true);
    return () => {
      worker.terminate();
      workerRef.current = null;
      setWorkerReady(false);
    };
  }, [setWorkerReady, setParsing, setProgress, setResult, setError, showToast]);

  const run = useCallback(
    (message: WorkerMessage) => {
      return new Promise((resolve, reject) => {
        if (!workerRef.current) {
          reject(new Error("Worker not ready"));
          return;
        }
        setParsing(true);
        setError(null);
        setProgress({ stage: "parsing", processed: 0, total: 100, percent: 0 });
        resolveRef.current = resolve;
        rejectRef.current = reject;
        workerRef.current.postMessage(message);
      });
    },
    [setParsing, setError, setProgress],
  );

  const parseFile = useCallback(
    async (file: File) => {
      const options = workerParseOptions(useAnalysisStore.getState().filters);
      skipNextReagg.current = true;
      // Create before PARSE so PERF messages can land stages.
      ensureBench({
        at: new Date().toISOString(),
        source: "file",
        fileName: file.name,
        fileBytes: file.size,
        crossOriginIsolated: window.crossOriginIsolated,
        reaggTimes: [],
        reaggStages: [],
        stages: undefined,
        parseWallMs: undefined,
      });
      const t0 = performance.now();
      await run({ type: "PARSE_FILE", payload: { file, options } });
      const ms = Math.round(performance.now() - t0);
      const result = useAnalysisStore.getState().result;
      ensureBench({
        parseWallMs: ms,
        matched: result?.summary.matched ?? 0,
        unmatched: result?.summary.unmatched ?? 0,
        apiEndpoints: result?.api.length ?? 0,
        cronJobs: result?.cron.length ?? 0,
        p95Ms: result?.summary.p95Ms ?? 0,
      });
      showToast(`Parsed ${result?.summary.matched.toLocaleString() ?? 0} requests in ${ms}ms`);
    },
    [run, showToast],
  );

  const parseText = useCallback(
    async (text: string) => {
      const options = workerParseOptions(useAnalysisStore.getState().filters);
      skipNextReagg.current = true;
      ensureBench({
        at: new Date().toISOString(),
        source: "text",
        reaggTimes: [],
        reaggStages: [],
        stages: undefined,
        parseWallMs: undefined,
      });
      const t0 = performance.now();
      await run({ type: "PARSE_TEXT", payload: { text, options } });
      const ms = Math.round(performance.now() - t0);
      const result = useAnalysisStore.getState().result;
      ensureBench({
        parseWallMs: ms,
        matched: result?.summary.matched ?? 0,
        unmatched: result?.summary.unmatched ?? 0,
        apiEndpoints: result?.api.length ?? 0,
        cronJobs: result?.cron.length ?? 0,
        p95Ms: result?.summary.p95Ms ?? 0,
      });
      showToast(`Parsed ${result?.summary.matched.toLocaleString() ?? 0} requests in ${ms}ms`);
    },
    [run, showToast],
  );

  const reaggregate = useCallback(async () => {
    const options = workerParseOptions(useAnalysisStore.getState().filters);
    const t0 = performance.now();
    await run({ type: "REAGGREGATE", payload: { options } });
    const ms = Math.round(performance.now() - t0);
    const b = ensureBench();
    b.lastReaggMs = ms;
    b.reaggTimes = [...(b.reaggTimes ?? []), ms];
  }, [run]);

  const cancel = useCallback(() => {
    workerRef.current?.postMessage({ type: "CANCEL" } satisfies WorkerMessage);
    setParsing(false);
  }, [setParsing]);

  const clear = useCallback(() => {
    workerRef.current?.postMessage({ type: "CLEAR" } satisfies WorkerMessage);
    useAnalysisStore.getState().clearAnalysis();
  }, []);

  const normalizeMode = useAnalysisStore((s) => s.filters.normalizeMode);
  const statusFamily = useAnalysisStore((s) => s.filters.statusFamily);
  const minMs = useAnalysisStore((s) => s.filters.minMs);
  const cronQuery = useAnalysisStore((s) => s.filters.cronQuery);
  const cronMinMs = useAnalysisStore((s) => s.filters.cronMinMs);
  const cronShowFailedOnly = useAnalysisStore((s) => s.filters.cronShowFailedOnly);
  const hasData = useAnalysisStore((s) => s.hasData);

  useEffect(() => {
    if (!hasData) return;
    if (skipNextReagg.current) {
      skipNextReagg.current = false;
      return;
    }
    const id = setTimeout(() => {
      void reaggregate();
    }, 150);
    return () => clearTimeout(id);
  }, [
    hasData,
    normalizeMode,
    statusFamily,
    minMs,
    cronQuery,
    cronMinMs,
    cronShowFailedOnly,
    reaggregate,
  ]);

  return { parseFile, parseText, reaggregate, cancel, clear };
}

export function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}
