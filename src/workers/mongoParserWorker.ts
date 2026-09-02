import { aggregateMongoData } from "../mongo/aggregateMongo";
import { parseMongoLine } from "../mongo/parseMongoLine";
import type {
  MongoAggregationResult,
  MongoCheckpointInfo,
  MongoConnectionStats,
  MongoDriverInfo,
  MongoErrorInfo,
  MongoFilters,
  MongoSlowQuery,
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
let allQueries: MongoSlowQuery[] = [];
let connections: MongoConnectionStats = {
  accepted: 0,
  ended: 0,
  peakConcurrent: 0,
  authSuccess: 0,
  authFailed: 0,
  drivers: [],
  clientIps: [],
};
let errors: MongoErrorInfo[] = [];
let checkpoints: MongoCheckpointInfo[] = [];
const datesSet = new Set<string>();
const operationsSet = new Set<string>();
const clientIpMap = new Map<string, number>();
const driverMap = new Map<string, MongoDriverInfo>();
const errorMap = new Map<string, MongoErrorInfo>();
let totalLinesScanned = 0;

function resetWorkerState() {
  allQueries = [];
  connections = {
    accepted: 0,
    ended: 0,
    peakConcurrent: 0,
    authSuccess: 0,
    authFailed: 0,
    drivers: [],
    clientIps: [],
  };
  errors = [];
  checkpoints = [];
  datesSet.clear();
  operationsSet.clear();
  clientIpMap.clear();
  driverMap.clear();
  errorMap.clear();
  totalLinesScanned = 0;
}

function processSingleLine(line: string) {
  totalLinesScanned++;
  const parsed = parseMongoLine(line);
  if (!parsed) return;

  datesSet.add(parsed.dateStr);

  if (parsed.type === "slow_query") {
    allQueries.push(parsed.query);
    operationsSet.add(parsed.query.op);
    if (parsed.query.remote) {
      const ip = parsed.query.remote.split(":")[0] || parsed.query.remote;
      clientIpMap.set(ip, (clientIpMap.get(ip) || 0) + 1);
    }
  } else if (parsed.type === "connection") {
    if (parsed.event === "accepted") {
      connections.accepted++;
      if (parsed.connectionCount && parsed.connectionCount > connections.peakConcurrent) {
        connections.peakConcurrent = parsed.connectionCount;
      }
      if (parsed.remote) {
        const ip = parsed.remote.split(":")[0] || parsed.remote;
        clientIpMap.set(ip, (clientIpMap.get(ip) || 0) + 1);
      }
    } else if (parsed.event === "ended") {
      connections.ended++;
    } else if (parsed.event === "auth_success") {
      connections.authSuccess++;
    } else if (parsed.event === "auth_fail") {
      connections.authFailed++;
    }
  } else if (parsed.type === "driver_meta") {
    const key = `${parsed.driver.driverName}@${parsed.driver.driverVersion}|${parsed.driver.platform}`;
    const cur = driverMap.get(key);
    if (cur) cur.count++;
    else driverMap.set(key, { ...parsed.driver });
  } else if (parsed.type === "error") {
    const key = `${parsed.error.severity}:${parsed.error.id ?? ""}:${parsed.error.msg}`;
    const cur = errorMap.get(key);
    if (cur) cur.count++;
    else errorMap.set(key, { ...parsed.error });
  } else if (parsed.type === "checkpoint") {
    if (checkpoints.length < 500) {
      checkpoints.push(parsed.checkpoint);
    }
  }
}

function finalizeConnectionsAndErrors() {
  connections.drivers = Array.from(driverMap.values()).sort((a, b) => b.count - a.count);
  connections.clientIps = Array.from(clientIpMap.entries())
    .map(([ip, count]) => ({ ip, count }))
    .sort((a, b) => b.count - a.count);
  errors = Array.from(errorMap.values()).sort((a, b) => b.count - a.count);
}

async function streamParseFile(file: File, bytesOffset: number, totalAllBytes: number) {
  const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB chunks
  let offset = 0;
  let carry = "";
  const decoder = new TextDecoder();

  while (offset < file.size) {
    if (isCancelled) return;
    const end = Math.min(offset + CHUNK_SIZE, file.size);
    const slice = file.slice(offset, end);
    const arrayBuffer = await slice.arrayBuffer();
    const chunkStr = carry + decoder.decode(arrayBuffer, { stream: end < file.size });

    const lines = chunkStr.split("\n");
    carry = lines.pop() ?? "";

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line) processSingleLine(line);
    }

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

  if (carry && !isCancelled) {
    processSingleLine(carry);
  }
}

self.onmessage = async (e: MessageEvent<MongoWorkerMessage>) => {
  const msg = e.data;

  if (msg.type === "CANCEL") {
    isCancelled = true;
    return;
  }

  if (msg.type === "CLEAR") {
    resetWorkerState();
    return;
  }

  if (msg.type === "REAGGREGATE") {
    const t0 = performance.now();
    const result = aggregateMongoData({
      allQueries,
      filters: msg.payload.filters,
      connections,
      errors,
      checkpoints,
      dates: Array.from(datesSet).sort(),
      operations: Array.from(operationsSet).sort(),
      totalLines: totalLinesScanned,
    });
    self.postMessage({ type: "RESULT", payload: result } satisfies MongoWorkerResponse);
    self.postMessage({
      type: "PERF",
      payload: { kind: "reagg", totalMs: Math.round(performance.now() - t0) },
    } satisfies MongoWorkerResponse);
    return;
  }

  if (msg.type === "PARSE_FILE" || msg.type === "PARSE_FILES") {
    isCancelled = false;
    resetWorkerState();
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

    finalizeConnectionsAndErrors();

    self.postMessage({
      type: "PROGRESS",
      payload: {
        stage: "aggregating",
        processed: totalBytes,
        total: totalBytes,
        percent: 98,
      },
    } satisfies MongoWorkerResponse);

    const result = aggregateMongoData({
      allQueries,
      filters: msg.payload.filters,
      connections,
      errors,
      checkpoints,
      dates: Array.from(datesSet).sort(),
      operations: Array.from(operationsSet).sort(),
      totalLines: totalLinesScanned,
    });

    self.postMessage({ type: "RESULT", payload: result } satisfies MongoWorkerResponse);
    self.postMessage({
      type: "PERF",
      payload: { kind: "parse", totalMs: Math.round(performance.now() - t0) },
    } satisfies MongoWorkerResponse);
    return;
  }

  if (msg.type === "PARSE_TEXT") {
    isCancelled = false;
    resetWorkerState();
    const t0 = performance.now();

    const lines = msg.payload.text.split("\n");
    const totalLines = lines.length;

    for (let i = 0; i < totalLines; i++) {
      if (isCancelled) break;
      const line = lines[i];
      if (line) processSingleLine(line);

      if (i % 5000 === 0) {
        self.postMessage({
          type: "PROGRESS",
          payload: {
            stage: "parsing",
            processed: i,
            total: totalLines,
            percent: Math.min(95, Math.round((i / totalLines) * 95)),
          },
        } satisfies MongoWorkerResponse);
      }
    }

    if (isCancelled) return;

    finalizeConnectionsAndErrors();

    const result = aggregateMongoData({
      allQueries,
      filters: msg.payload.filters,
      connections,
      errors,
      checkpoints,
      dates: Array.from(datesSet).sort(),
      operations: Array.from(operationsSet).sort(),
      totalLines: totalLinesScanned,
    });

    self.postMessage({ type: "RESULT", payload: result } satisfies MongoWorkerResponse);
    self.postMessage({
      type: "PERF",
      payload: { kind: "parse", totalMs: Math.round(performance.now() - t0) },
    } satisfies MongoWorkerResponse);
  }
};
