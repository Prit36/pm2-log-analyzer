import NginxParserWorker from "../workers/nginxParserWorker.ts?worker&inline";
import type {
  NginxInput,
  NginxWorkerMessage,
  NginxWorkerResponse,
} from "../workers/nginxParserWorker";
import type { NginxResult } from "../nginx/types";
import type { NginxSource } from "../store/nginxStore";
import { useNginxStore } from "../store/nginxStore";
import { isTauri } from "../utils/platform";
import {
  cancelNginxNative,
  clearNginxNative,
  isNativeNginxActive,
  parseNginxTextNative,
  reaggregateNginxNative,
} from "../services/nativeBridge";

export type NginxBench = {
  at: string;
  source: string;
  fileName: string;
  fileBytes: number;
  parseWallMs: number;
  requestCount: number;
  endpointCount: number;
  reaggTimes: number[];
  lastReaggMs?: number;
};

declare global {
  interface Window {
    __NGINX_BENCH__?: NginxBench;
  }
}

const {
  setWorkerReady,
  setParsing,
  setProgress,
  setResult,
  setError,
  showToast,
  clearAnalysis,
  setSourceFiles,
  appendSourceFiles,
  setSourcePaste,
} = useNginxStore.getState();
const pending = new Map<
  number,
  { resolve: (result: NginxResult | null) => void; reject: (error: Error) => void }
>();
let worker: Worker | null = null;
let sequence = 0;
let uploadGeneration = 0;

export function getNginxUploadGeneration(): number {
  return uploadGeneration;
}

function getWorker(): Worker {
  if (worker) return worker;
  worker = new NginxParserWorker();
  worker.onmessage = ({ data }: MessageEvent<NginxWorkerResponse>) => {
    if (data.type === "READY") {
      setWorkerReady(true);
      return;
    }
    const operation = pending.get(data.id);
    if (data.id !== sequence) {
      if (data.type !== "PROGRESS") {
        operation?.resolve(null);
        pending.delete(data.id);
      }
      return;
    }
    if (data.type === "PROGRESS") setProgress(data.payload);
    else if (data.type === "RESULT") {
      setResult(data.payload);
      setParsing(false);
      setProgress({ stage: "complete", processed: 100, total: 100, percent: 100 });
      operation?.resolve(data.payload);
      pending.delete(data.id);
    } else if (data.type === "ERROR") {
      setError(data.message);
      setParsing(false);
      showToast(data.message);
      operation?.reject(new Error(data.message));
      pending.delete(data.id);
    } else {
      operation?.resolve(null);
      pending.delete(data.id);
    }
  };
  worker.onerror = (error) => {
    const message = error.message || "Nginx worker failed";
    setParsing(false);
    setError(message);
    showToast(message);
    for (const operation of pending.values()) operation.reject(new Error(message));
    pending.clear();
    worker?.terminate();
    worker = null;
    setWorkerReady(false);
  };
  return worker;
}

function run(
  message: NginxWorkerMessage,
  transfer: Transferable[] = [],
): Promise<NginxResult | null> {
  return new Promise((resolve, reject) => {
    pending.set(message.id, { resolve, reject });
    getWorker().postMessage(message, transfer);
  });
}

async function parseInputs(
  inputs: NginxInput[],
  sources: NginxSource[],
  mode: "replace" | "append",
  source: string,
): Promise<void> {
  if (!inputs.length) return;
  const id = ++sequence;
  const t0 = performance.now();
  if (isTauri() && isNativeNginxActive()) await clearNginxNative();
  if (id !== sequence) return;
  if (mode === "replace") clearAnalysis();
  setParsing(true);
  setError(null);
  setProgress({ stage: "parsing", processed: 0, total: 100, percent: 0 });
  const filters = useNginxStore.getState().filters;
  const result = await run(
    { type: "PARSE", id, inputs, filters, append: mode === "append" },
    inputs.flatMap((input) => (input.kind === "buffer" ? [input.buffer] : [])),
  );
  if (!result || id !== sequence) return;
  if (source === "paste") setSourcePaste();
  else if (mode === "append") appendSourceFiles(sources);
  else setSourceFiles(sources);
  const ms = Math.round(performance.now() - t0);
  window.__NGINX_BENCH__ = {
    at: new Date().toISOString(),
    source,
    fileName: sources.length === 1 ? sources[0]!.name : `${sources.length} files`,
    fileBytes: sources.reduce((sum, item) => sum + item.size, 0),
    parseWallMs: ms,
    requestCount: result.summary.count,
    endpointCount: result.endpointCount,
    reaggTimes: [],
  };
  showToast(`Parsed ${result.summary.count.toLocaleString()} Nginx requests in ${ms}ms`);
  if (JSON.stringify(filters) !== JSON.stringify(useNginxStore.getState().filters))
    await reaggregateNginx();
}

export function parseNginxFiles(
  files: File[],
  uploadMode: "replace" | "append" = "replace",
): Promise<void> {
  return parseInputs(
    files.map((file) => ({ kind: "file", file })),
    files.map((file) => ({ name: file.name, size: file.size })),
    uploadMode,
    "files",
  );
}

export function parseNginxBuffer(
  buffer: ArrayBuffer,
  name: string,
  bytes: number,
  uploadMode: "replace" | "append" = "replace",
): Promise<void> {
  return parseNginxBuffers([{ buffer, name, size: bytes }], uploadMode);
}

export function parseNginxBuffers(
  buffers: { buffer: ArrayBuffer; name: string; size: number }[],
  uploadMode: "replace" | "append" = "replace",
): Promise<void> {
  return parseInputs(
    buffers.map((item) => ({ kind: "buffer", ...item })),
    buffers.map((item) => ({ name: item.name, size: item.size })),
    uploadMode,
    "buffer",
  );
}

export function parseNginxText(text: string): Promise<void> {
  if (isTauri()) return parseNginxTextNative(text);
  const bytes = new TextEncoder().encode(text);
  return parseInputs(
    [{ kind: "buffer", buffer: bytes.buffer, name: "Pasted Nginx logs", size: bytes.byteLength }],
    [{ name: "Pasted Nginx logs", size: bytes.byteLength }],
    "replace",
    "paste",
  );
}

export async function reaggregateNginx(): Promise<void> {
  if (useNginxStore.getState().isParsing || !useNginxStore.getState().hasData) return;
  const id = ++sequence;
  const t0 = performance.now();
  setError(null);
  if (isTauri() && isNativeNginxActive()) await reaggregateNginxNative();
  else await run({ type: "REAGGREGATE", id, filters: useNginxStore.getState().filters });
  if (id !== sequence) return;
  const ms = Math.round(performance.now() - t0);
  const bench = window.__NGINX_BENCH__;
  if (bench) {
    bench.lastReaggMs = ms;
    bench.reaggTimes.push(ms);
  }
}

export function cancelNginx(): void {
  uploadGeneration++;
  const id = ++sequence;
  worker?.postMessage({ type: "CANCEL", id } satisfies NginxWorkerMessage);
  for (const operation of pending.values()) operation.resolve(null);
  pending.clear();
  if (isTauri()) cancelNginxNative();
  setParsing(false);
  setProgress(null);
}

export function clearNginx(): void {
  cancelNginx();
  worker?.postMessage({ type: "CLEAR", id: ++sequence } satisfies NginxWorkerMessage);
  if (isTauri()) void clearNginxNative();
  clearAnalysis();
}

getWorker();
