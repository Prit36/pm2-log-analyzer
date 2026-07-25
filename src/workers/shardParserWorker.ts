/**
 * Shard worker: parse a byte range of a File with line-boundary rules.
 * Owns [start, end); skips leading partial line; takes straddling trailing line.
 */

import {
  METHOD_INDEX,
  createLineScratch,
  parseLineBytes,
  type CronEventCompact,
  type LogMethod,
} from "../parser";

export type ShardRequest = {
  type: "PARSE_SHARD";
  file: File;
  start: number;
  end: number;
  shardIndex: number;
};

export type ShardResult = {
  type: "SHARD_RESULT";
  shardIndex: number;
  methodCodes: Uint8Array;
  statuses: Uint16Array;
  durations: Float32Array;
  pathIds: Uint32Array;
  count: number;
  pathTable: string[];
  unmatchedCount: number;
  unmatchedSample: string[];
  cronEvents: CronEventCompact[];
  methods: string[];
};

export type ShardError = { type: "SHARD_ERROR"; shardIndex: number; message: string };

const decoder = new TextDecoder();
/** Max line length when extending past ownership end to finish a straddling line. */
const LINE_EXTEND = 256 * 1024;

self.onmessage = async (e: MessageEvent<ShardRequest>) => {
  const msg = e.data;
  if (msg.type !== "PARSE_SHARD") return;
  const { file, start, end, shardIndex } = msg;
  try {
    const readEnd = Math.min(file.size, end + LINE_EXTEND);
    const buf = new Uint8Array(await file.slice(start, readEnd).arrayBuffer());

    const scratch = createLineScratch();
    let methodCodes = new Uint8Array(65536);
    let statuses = new Uint16Array(65536);
    let durations = new Float32Array(65536);
    let pathIds = new Uint32Array(65536);
    let capacity = 65536;
    let count = 0;
    const pathTable: string[] = [];
    const pathIndex = new Map<string, number>();
    let unmatchedCount = 0;
    const unmatchedSample: string[] = [];
    const cronEvents: CronEventCompact[] = [];
    const methodSeen = new Set<string>();

    function ensure(need: number) {
      if (need <= capacity) return;
      const next = Math.max(capacity * 2, need);
      const mc = new Uint8Array(next);
      const st = new Uint16Array(next);
      const du = new Float32Array(next);
      const pi = new Uint32Array(next);
      mc.set(methodCodes.subarray(0, count));
      st.set(statuses.subarray(0, count));
      du.set(durations.subarray(0, count));
      pi.set(pathIds.subarray(0, count));
      methodCodes = mc;
      statuses = st;
      durations = du;
      pathIds = pi;
      capacity = next;
    }

    function intern(path: string): number {
      let id = pathIndex.get(path);
      if (id !== undefined) return id;
      id = pathTable.length;
      pathTable.push(path);
      pathIndex.set(path, id);
      return id;
    }

    function pushHttp(method: LogMethod, path: string, status: number, durationMs: number) {
      const mi = METHOD_INDEX.get(method);
      if (mi === undefined) return;
      ensure(count + 1);
      methodCodes[count] = mi;
      statuses[count] = status;
      durations[count] = durationMs;
      pathIds[count] = intern(path);
      count++;
      methodSeen.add(method);
    }

    let i = 0;
    if (start > 0) {
      while (i < buf.length && buf[i] !== 10) i++;
      if (i < buf.length) i++;
    }

    while (i < buf.length) {
      const lineStart = i;
      const absLineStart = start + lineStart;
      if (absLineStart >= end) break;

      while (i < buf.length && buf[i] !== 10) i++;
      const lineEnd = i;
      const hasNl = i < buf.length && buf[i] === 10;
      if (hasNl) i++;

      // Incomplete line mid-file (extend wasn't enough) — stop; rare for normal logs
      if (!hasNl && readEnd < file.size) break;

      parseLineBytes(buf, lineStart, lineEnd, scratch);
      if (scratch.kind === "empty") continue;
      if (scratch.kind === "cron") {
        cronEvents.push(scratch.cron!);
        continue;
      }
      if (scratch.kind === "http") {
        pushHttp(scratch.method, scratch.path, scratch.status, scratch.durationMs);
        continue;
      }
      unmatchedCount++;
      if (unmatchedSample.length < 40) {
        unmatchedSample.push(
          decoder.decode(buf.subarray(lineStart, Math.min(lineEnd, lineStart + 500))),
        );
      }
    }

    const mc = methodCodes.slice(0, count);
    const st = statuses.slice(0, count);
    const du = durations.slice(0, count);
    const pi = pathIds.slice(0, count);

    const result: ShardResult = {
      type: "SHARD_RESULT",
      shardIndex,
      methodCodes: mc,
      statuses: st,
      durations: du,
      pathIds: pi,
      count,
      pathTable,
      unmatchedCount,
      unmatchedSample,
      cronEvents,
      methods: Array.from(methodSeen),
    };
    self.postMessage(result, [mc.buffer, st.buffer, du.buffer, pi.buffer]);
  } catch (err) {
    const errMsg: ShardError = {
      type: "SHARD_ERROR",
      shardIndex,
      message: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(errMsg);
  }
};
