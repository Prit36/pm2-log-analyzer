/**
 * Web Worker: stream-parse PM2 logs and aggregate off the main thread.
 * Keeps compact typed arrays for fast re-aggregation when filters change.
 */

import {
  METHOD_INDEX,
  buildResultCached,
  parseLine,
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

function internPath(path: string): number {
  let id = pathIndex.get(path);
  if (id !== undefined) return id;
  id = pathTable.length;
  pathTable.push(path);
  pathIndex.set(path, id);
  return id;
}

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
  const parsed = parseLine(line);
  if (parsed.kind === "empty") return;
  if (parsed.kind === "cron") {
    cronEvents.push(parsed.event);
    return;
  }
  if (parsed.kind === "http") {
    const { method, path, status, durationMs } = parsed.hit;
    pushRequest(method, path, status, durationMs);
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

async function parseFileStream(file: File) {
  resetStore();
  const reader = file.stream().getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let bytesRead = 0;
  const total = file.size || 1;
  let linesSinceProgress = 0;

  while (true) {
    if (cancelled) throw new Error("Cancelled");
    const { done, value } = await reader.read();
    if (done) break;

    bytesRead += value.byteLength;
    buffer += decoder.decode(value, { stream: true });

    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
      const c = buffer.charCodeAt(i);
      if (c === 10) {
        let line = buffer.slice(start, i);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        ingestLine(line);
        start = i + 1;
        linesSinceProgress++;
      }
    }
    buffer = buffer.slice(start);

    if (linesSinceProgress >= 8000) {
      linesSinceProgress = 0;
      self.postMessage({
        type: "PROGRESS",
        payload: {
          stage: "parsing",
          processed: bytesRead,
          total,
          percent: Math.min(99, Math.round((bytesRead / total) * 100)),
        },
      } satisfies WorkerResponse);
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  }

  buffer += decoder.decode();
  if (buffer) ingestLine(buffer);

  self.postMessage({
    type: "PROGRESS",
    payload: { stage: "parsing", processed: total, total, percent: 100 },
  } satisfies WorkerResponse);
}

function parseText(text: string) {
  resetStore();
  const lines = text.split(/\r?\n/);
  const total = lines.length || 1;
  for (let i = 0; i < lines.length; i++) {
    if (cancelled) throw new Error("Cancelled");
    ingestLine(lines[i]!);
    if (i > 0 && i % 10000 === 0) {
      self.postMessage({
        type: "PROGRESS",
        payload: {
          stage: "parsing",
          processed: i,
          total,
          percent: Math.round((i / total) * 100),
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
