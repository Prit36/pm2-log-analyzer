import { extractFingerprint, type MongoDoc, type MongoParsedNode } from "./fingerprint";
import { generateIndexSuggestion } from "./indexSuggestions";
import type {
  MongoCheckpointInfo,
  MongoDriverInfo,
  MongoErrorInfo,
  MongoOperationType,
  MongoSeverity,
  MongoSlowQuery,
} from "./types";

export type ParsedMongoLine =
  | { type: "slow_query"; query: MongoSlowQuery; dateStr: string }
  | {
      type: "connection";
      event: "accepted" | "ended" | "auth_success" | "auth_fail";
      connectionCount?: number | undefined;
      remote?: string | undefined;
      dateStr: string;
    }
  | { type: "driver_meta"; driver: MongoDriverInfo; dateStr: string }
  | { type: "error"; error: MongoErrorInfo; dateStr: string }
  | { type: "checkpoint"; checkpoint: MongoCheckpointInfo; dateStr: string }
  | null;

type ParsedDateInfo = {
  readonly iso: string;
  readonly dateStr: string;
  readonly epochMs: number;
};

let querySeq = 0;

function asString(val: MongoParsedNode | undefined): string | undefined {
  if (val === undefined || val === null) return undefined;
  return String(val) === val ? val : undefined;
}

function asNumber(val: MongoParsedNode | undefined): number | undefined {
  if (val === undefined || val === null) return undefined;
  return Number.isFinite(val) ? Number(val) : undefined;
}

function asDoc(val: MongoParsedNode | undefined): MongoDoc | undefined {
  if (val !== null && val !== undefined && !Array.isArray(val) && val.constructor === Object) {
    // SAFETY: verified value is a non-null, non-array object instance matching MongoDoc structure
    return val as MongoDoc;
  }
  return undefined;
}

function detectOp(command: MongoDoc): MongoOperationType {
  const keys = Object.keys(command);
  const first = keys[0];
  if (!first) return "other";
  switch (first) {
    case "find":
      return "find";
    case "aggregate":
      return "aggregate";
    case "distinct":
      return "distinct";
    case "getMore":
      return "getMore";
    case "insert":
      return "insert";
    case "update":
      return "update";
    case "delete":
      return "delete";
    case "findAndModify":
      return "findAndModify";
    case "createIndexes":
      return "createIndexes";
    case "dropIndexes":
      return "dropIndexes";
    case "count":
      return "count";
    default:
      return "other";
  }
}

function parseDateStr(rawDate: MongoParsedNode | undefined): ParsedDateInfo {
  let iso = "";
  const directStr = asString(rawDate);
  if (directStr !== undefined) {
    iso = directStr;
  } else {
    const docDate = asDoc(rawDate);
    if (docDate && "$date" in docDate) {
      const d = asString(docDate.$date);
      if (d !== undefined) iso = d;
    }
  }

  if (!iso) {
    const now = new Date();
    const fallback: ParsedDateInfo = {
      iso: now.toISOString(),
      dateStr: now.toISOString().slice(0, 10),
      epochMs: now.getTime(),
    };
    return fallback;
  }
  const epochMs = Date.parse(iso) || 0;
  const dateStr = iso.length >= 10 ? iso.slice(0, 10) : "unknown";
  const result: ParsedDateInfo = { iso, dateStr, epochMs };
  return result;
}

export function parseMongoLine(line: string): ParsedMongoLine {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;

  let rawParsed: MongoParsedNode;
  try {
    // SAFETY: JSON.parse output on valid JSON strings conforms to MongoParsedNode
    rawParsed = JSON.parse(trimmed) as MongoParsedNode;
  } catch {
    return null;
  }

  const entry = asDoc(rawParsed);
  if (!entry) return null;

  const { iso: timestamp, dateStr, epochMs } = parseDateStr(entry.t);
  const sStr = asString(entry.s) ?? "I";
  // SAFETY: sStr guaranteed string fallback from single-char severity field
  const severity = sStr as MongoSeverity;
  const component = asString(entry.c) ?? "UNKNOWN";
  const ctx = asString(entry.ctx) ?? "";
  const msg = asString(entry.msg) ?? "";
  const attr = asDoc(entry.attr) ?? {};

  // Check for Slow Query
  const durationMs = asNumber(attr.durationMillis);
  if (durationMs !== undefined) {
    const ns = asString(attr.ns) ?? "";
    const parts = ns.split(".");
    const db = parts[0] ?? "unknown";
    const collection = parts.length > 1 ? parts.slice(1).join(".") : "unknown";

    const command = asDoc(attr.command) ?? {};
    const op = detectOp(command);
    const planSummary = asString(attr.planSummary) ?? "";
    const isCollscan = planSummary.includes("COLLSCAN");
    const keysExamined = asNumber(attr.keysExamined) ?? 0;
    const docsExamined = asNumber(attr.docsExamined) ?? 0;
    const nreturned = asNumber(attr.nreturned) ?? 0;
    const numYields = asNumber(attr.numYields) ?? 0;
    const reslen = asNumber(attr.reslen) ?? 0;
    const scanRatio = docsExamined / Math.max(nreturned, 1);

    const { fingerprint, filterKeys, sortKeys } = extractFingerprint(op, collection, command);
    const indexSuggestion = generateIndexSuggestion(
      collection,
      filterKeys,
      sortKeys,
      planSummary,
    );

    querySeq++;
    const query: MongoSlowQuery = {
      id: `query-${epochMs}-${querySeq}`,
      timestamp,
      epochMs,
      severity,
      component,
      ctx,
      ns,
      db,
      collection,
      op,
      durationMs,
      planningTimeMicros: asNumber(attr.planningTimeMicros),
      planSummary,
      isCollscan,
      keysExamined,
      docsExamined,
      nreturned,
      scanRatio,
      numYields,
      reslen,
      queryHash: asString(attr.queryHash),
      planCacheKey: asString(attr.planCacheKey),
      remote: asString(attr.remote),
      command,
      originatingCommand: asDoc(attr.originatingCommand),
      locks: asDoc(attr.locks),
      storage: asDoc(attr.storage),
      fingerprint,
      indexSuggestion,
    };

    return { type: "slow_query", query, dateStr };
  }

  // Check for Client Driver Metadata
  if (msg === "client metadata" && attr.doc) {
    const doc = asDoc(attr.doc);
    const driver = asDoc(doc?.driver);
    const os = asDoc(doc?.os);

    const driverInfo: MongoDriverInfo = {
      driverName: asString(driver?.name) ?? "unknown",
      driverVersion: asString(driver?.version) ?? "unknown",
      platform: asString(doc?.platform) ?? "unknown",
      osName: asString(os?.name) ?? "unknown",
      osVersion: asString(os?.version) ?? "unknown",
      count: 1,
    };
    return { type: "driver_meta", driver: driverInfo, dateStr };
  }

  // Connection events
  if (msg === "Connection accepted") {
    const connectionCount = asNumber(attr.connectionCount);
    const remote = asString(attr.remote);
    return { type: "connection", event: "accepted", connectionCount, remote, dateStr };
  }
  if (msg === "Connection ended") {
    return { type: "connection", event: "ended", dateStr };
  }
  if (msg === "Authentication succeeded" || msg === "Successfully authenticated") {
    return { type: "connection", event: "auth_success", dateStr };
  }
  if (msg === "Authentication failed") {
    return { type: "connection", event: "auth_fail", dateStr };
  }

  // Checkpoints
  if (component === "WTCHKPT") {
    const message = asDoc(attr.message);
    return {
      type: "checkpoint",
      checkpoint: {
        timestamp,
        thread: asString(message?.thread),
        msg: asString(message?.msg) ?? msg,
      },
      dateStr,
    };
  }

  // Warnings and Errors
  if (severity === "W" || severity === "E" || severity === "F") {
    const errorId = asNumber(entry.id);
    return {
      type: "error",
      error: {
        timestamp,
        severity,
        component,
        id: errorId,
        msg,
        attr,
        count: 1,
      },
      dateStr,
    };
  }

  return null;
}
