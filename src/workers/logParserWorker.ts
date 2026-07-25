/**
 * Web Worker: stream-parse PM2 logs and aggregate off the main thread.
 * Keeps compact typed arrays for fast re-aggregation when filters change.
 */

import {
  METHOD_INDEX,
  buildResultCached,
  createLineScratch,
  parseLineInto,
  type AggregatedResult,
  type CronEventCompact,
  type LogMethod,
  type LogSummary,
  type ParseOptions,
  EMPTY_RESULT,
} from "../parser";

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
}

function ensureCapacity(need: number) {
  if (need <= capacity) return;
  const next = Math.max(capacity * 2 || 65536, need);
  const mc = new Uint8Array(next);
  const st = new Uint16Array(next);
  const du = new Float32Array(next);
  const pi = new Uint32Array(next);
  if (capacity > 0) {
    mc.set(methodCodes);
    st.set(statuses);
    du.set(durations);
    pi.set(pathIds);
  }
  methodCodes = mc;
  statuses = st;
  durations = du;
  pathIds = pi;
  capacity = next;
}

/** Rough hit estimate from file bytes — avoids repeated typed-array realloc copies. */
function preallocateForFile(fileSize: number) {
  // api-out corpus ≈ 150–160 bytes per HTTP hit including non-HTTP lines
  const estimate = Math.min(8_000_000, Math.max(65536, Math.ceil(fileSize / 140)));
  ensureCapacity(estimate);
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

function makeResult(options: ParseOptions): AggregatedResult {
  self.postMessage({
    type: "PROGRESS",
    payload: { stage: "aggregating", processed: 0, total: 100, percent: 0 },
  } satisfies WorkerResponse);
  const result = buildResultCached(storeSnapshot(), options, cachedSummary);
  cachedSummary = { summary: result.summary, methods: result.methods };
  return result;
}

const PROGRESS_INTERVAL_MS = 150;

function postParseProgress(processed: number, total: number, force: boolean, lastAt: { t: number }) {
  const now = performance.now();
  if (!force && now - lastAt.t < PROGRESS_INTERVAL_MS) return;
  lastAt.t = now;
  self.postMessage({
    type: "PROGRESS",
    payload: {
      stage: "parsing",
      processed,
      total,
      percent: Math.min(force ? 100 : 99, Math.round((processed / total) * 100)),
    },
  } satisfies WorkerResponse);
}

/** Consume complete lines from text; return unfinished trailing fragment. */
function ingestCompleteLines(text: string): string {
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      let line = text.slice(start, i);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      ingestLine(line);
      start = i + 1;
    }
  }
  return start < text.length ? text.slice(start) : "";
}

async function parseFileStream(file: File) {
  resetStore();
  preallocateForFile(file.size);
  const reader = file.stream().getReader();
  const decoder = new TextDecoder();
  let carry = "";
  let bytesRead = 0;
  const total = file.size || 1;
  const lastProgress = { t: 0 };

  while (true) {
    if (cancelled) throw new Error("Cancelled");
    const { done, value } = await reader.read();
    if (done) break;

    bytesRead += value.byteLength;
    const chunk = decoder.decode(value, { stream: true });
    if (carry.length === 0) {
      carry = ingestCompleteLines(chunk);
    } else {
      carry = ingestCompleteLines(carry + chunk);
    }
    postParseProgress(bytesRead, total, false, lastProgress);
  }

  const tail = decoder.decode();
  if (tail) {
    carry = carry.length === 0 ? ingestCompleteLines(tail) : ingestCompleteLines(carry + tail);
  }
  if (carry) ingestLine(carry);

  postParseProgress(total, total, true, lastProgress);
}

function parseText(text: string) {
  resetStore();
  const lines = text.split(/\r?\n/);
  const total = lines.length || 1;
  const lastProgress = { t: 0 };
  for (let i = 0; i < lines.length; i++) {
    if (cancelled) throw new Error("Cancelled");
    ingestLine(lines[i]!);
    postParseProgress(i + 1, total, false, lastProgress);
  }
  postParseProgress(total, total, true, lastProgress);
}

self.onmessage = async (e: MessageEvent<WorkerMessage>) => {
  const msg = e.data;
  try {
    if (msg.type === "CANCEL") {
      cancelled = true;
      return;
    }
    if (msg.type === "CLEAR") {
      resetStore();
      self.postMessage({ type: "DONE" } satisfies WorkerResponse);
      return;
    }

    cancelled = false;

    if (msg.type === "PARSE_FILE") {
      await parseFileStream(msg.payload.file);
      const result = makeResult(msg.payload.options);
      self.postMessage({ type: "RESULT", payload: result } satisfies WorkerResponse);
      self.postMessage({ type: "DONE" } satisfies WorkerResponse);
      return;
    }

    if (msg.type === "PARSE_TEXT") {
      parseText(msg.payload.text);
      const result = makeResult(msg.payload.options);
      self.postMessage({ type: "RESULT", payload: result } satisfies WorkerResponse);
      self.postMessage({ type: "DONE" } satisfies WorkerResponse);
      return;
    }

    if (msg.type === "REAGGREGATE") {
      if (count === 0 && cronEvents.length === 0) {
        self.postMessage({ type: "RESULT", payload: EMPTY_RESULT } satisfies WorkerResponse);
        return;
      }
      const result = makeResult(msg.payload.options);
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
