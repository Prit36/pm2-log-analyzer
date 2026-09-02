/**
 * Persistent Rust/Wasm shard: columns + paths stay in Wasm linear memory.
 * Ingest uses ingest_ptr + memory.set (one copy into Wasm, no wasm-bindgen &[u8] copy).
 */

import init, { Pm2Engine } from "../wasm/pkg/pm2_core.js";
import { normalizeModeCode, statusFamilyCode } from "../wasm/decodePartial";

export type ShardRequest =
  | { type: "INIT"; module: WebAssembly.Module }
  | { type: "CLEAR"; epoch: number }
  | {
      type: "PARSE_SHARD";
      epoch: number;
      file: File;
      start: number;
      end: number;
      shardIndex: number;
      normalizeMode?: string;
    }
  | {
      type: "PARSE_BYTES";
      epoch: number;
      buf: ArrayBuffer;
      shardIndex: number;
    }
  | {
      type: "ENSURE_MODE";
      epoch: number;
      /** 0 exact / 1 stripQuery / 2 collapseIds */
      mode: number;
    }
  | {
      type: "REAGGREGATE";
      epoch: number;
      shardIndex: number;
      normalizeMode: string;
      statusFamily: string;
      minMs: number;
      dateFilter?: string | null | undefined;
      needSummary: boolean;
    };

/** Per-shard parse critical-path pieces (coordinator takes max across shards). */
export type ShardTiming = {
  readMs: number;
  copyIngestMs: number;
  feedMs: number;
  endShardMs: number;
  metaWireMs: number;
  /** Sum of the above for this shard's wall. */
  shardWallMs: number;
};

export type ShardParsed = {
  type: "SHARD_PARSED";
  shardIndex: number;
  epoch: number;
  hitCount: number;
  unmatchedCount: number;
  methodsMask: number;
  cronWire: ArrayBuffer;
  unmatchedWire: ArrayBuffer;
  hourlyWire: ArrayBuffer;
  datesWire: ArrayBuffer;
  dailyWire: ArrayBuffer;
  partialWire?: ArrayBuffer;
  /** Debug probe: current Wasm linear memory size. */
  wasmHeapBytes?: number;
  /** Debug probe: distinct paths interned in this shard. */
  pathCount?: number;
  timing: ShardTiming;
};

export type ShardPartial = {
  type: "SHARD_PARTIAL";
  shardIndex: number;
  epoch: number;
  partial: ArrayBuffer;
  reaggMs: number;
};

export type ShardError = {
  type: "SHARD_ERROR";
  shardIndex: number;
  epoch: number;
  message: string;
};

export type ShardReady = { type: "SHARD_READY" };

export type ShardModeReady = { type: "SHARD_MODE_READY"; epoch: number };

const CHUNK = 16 * 1024 * 1024;
const LINE_EXTEND = 256 * 1024;

let engine: Pm2Engine | null = null;
let wasmMemory: WebAssembly.Memory | null = null;
let ready = false;

/** Write bytes into Wasm ingest window; return length written. */
function writeIngest(src: Uint8Array): number {
  const len = src.length;
  const ptr = engine!.ingest_ptr(len);
  // Re-read heap after possible grow from ingest_ptr.
  new Uint8Array(wasmMemory!.buffer).set(src, ptr);
  return len;
}

function transferableBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    // SAFETY: wasm-bindgen returns an owned Uint8Array for Vec<u8> results.
    return bytes.buffer as ArrayBuffer;
  }
  // SAFETY: Copy a view when its backing buffer is shared with unrelated bytes.
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function ensureInit(module: WebAssembly.Module) {
  if (ready && engine) return;
  const exports = await init({ module_or_path: module });
  wasmMemory = exports.memory;
  engine = new Pm2Engine();
  ready = true;
}

async function parseFileRange(file: File, start: number, end: number): Promise<ShardTiming> {
  let readMs = 0;
  let copyIngestMs = 0;
  let feedMs = 0;

  engine!.begin_shard(start, end, file.size);
  const readEnd = Math.min(file.size, end + LINE_EXTEND);
  // Include the byte before nonzero shard starts so a boundary exactly after a newline
  // does not discard the first complete line. The shard still owns [start, end).
  let off = start > 0 ? start - 1 : start;

  // Pipelined multi-buffered prefetch queue (depth 2) into Wasm ingest window
  const QUEUE_DEPTH = 2;
  const pendingReads: Promise<{ chunk: Uint8Array; readTime: number }>[] = [];

  const enqueue = (chunkOff: number) => {
    if (chunkOff >= readEnd) return;
    const take = Math.min(CHUNK, readEnd - chunkOff);
    const t0 = performance.now();
    const slice = file.slice(chunkOff, chunkOff + take);
    pendingReads.push(
      slice.arrayBuffer().then((buf) => ({
        chunk: new Uint8Array(buf),
        readTime: performance.now() - t0,
      })),
    );
  };

  let readNextOff = off;
  for (let q = 0; q < QUEUE_DEPTH && readNextOff < readEnd; q++) {
    const take = Math.min(CHUNK, readEnd - readNextOff);
    enqueue(readNextOff);
    readNextOff += take;
  }

  while (off < readEnd && pendingReads.length > 0) {
    const chunkOff = off;
    const take = Math.min(CHUNK, readEnd - off);
    off += take;

    if (readNextOff < readEnd) {
      const takeNext = Math.min(CHUNK, readEnd - readNextOff);
      enqueue(readNextOff);
      readNextOff += takeNext;
    }

    const { chunk, readTime } = await pendingReads.shift()!;
    readMs += readTime;

    const tCopy = performance.now();
    const n = writeIngest(chunk);
    copyIngestMs += performance.now() - tCopy;

    const tFeed = performance.now();
    engine!.feed(n, chunkOff);
    feedMs += performance.now() - tFeed;

    if (chunkOff >= end + LINE_EXTEND) break;
  }

  const tEnd = performance.now();
  engine!.end_shard();
  const endShardMs = performance.now() - tEnd;

  return {
    readMs,
    copyIngestMs,
    feedMs,
    endShardMs,
    metaWireMs: 0,
    shardWallMs: readMs + copyIngestMs + feedMs + endShardMs,
  };
}

export type ShardResponse = ShardReady | ShardModeReady | ShardParsed | ShardPartial | ShardError;

interface WorkerGlobal {
  postMessage(message: ShardResponse, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<ShardRequest>) => Promise<void> | void) | null;
}
declare const self: WorkerGlobal;

type ShardMetaBuffers = {
  cronWire: ArrayBuffer;
  unmatchedWire: ArrayBuffer;
  hourlyWire: ArrayBuffer;
  datesWire: ArrayBuffer;
  dailyWire: ArrayBuffer;
};

function metaBuffers(): ShardMetaBuffers {
  const cron = engine!.cron_wire();
  const unmatched = engine!.unmatched_sample_wire();
  const hourly = engine!.hourly_wire();
  const dates = engine!.dates_wire();
  const daily = engine!.daily_wire();
  const cronWire = transferableBuffer(cron);
  const unmatchedWire = transferableBuffer(unmatched);
  const hourlyWire = transferableBuffer(hourly);
  const datesWire = transferableBuffer(dates);
  const dailyWire = transferableBuffer(daily);
  return { cronWire, unmatchedWire, hourlyWire, datesWire, dailyWire };
}

self.onmessage = async (e: MessageEvent<ShardRequest>) => {
  const msg = e.data;
  try {
    if (msg.type === "INIT") {
      await ensureInit(msg.module);
      self.postMessage({ type: "SHARD_READY" } satisfies ShardReady);
      return;
    }
    if (!engine || !ready || !wasmMemory) {
      throw new Error("shard wasm not initialized");
    }

    if (msg.type === "CLEAR") {
      engine.clear();
      return;
    }

    if (msg.type === "ENSURE_MODE") {
      engine.ensure_mode(msg.mode);
      self.postMessage({ type: "SHARD_MODE_READY", epoch: msg.epoch } satisfies ShardModeReady);
      return;
    }

    if (msg.type === "PARSE_SHARD") {
      const { file, start, end, shardIndex, epoch, normalizeMode } = msg;
      engine.clear();
      const timing = await parseFileRange(file, start, end);
      const modeCode = normalizeModeCode(normalizeMode ?? "collapseIds");
      engine.ensure_mode(modeCode);
      const partialWireU8 = engine.reaggregate(modeCode, 0, 0, new Uint8Array(), true);
      const partialWire = transferableBuffer(partialWireU8);
      const tMeta = performance.now();
      const { cronWire, unmatchedWire, hourlyWire, datesWire, dailyWire } = metaBuffers();
      timing.metaWireMs = performance.now() - tMeta;
      timing.shardWallMs =
        timing.readMs + timing.copyIngestMs + timing.feedMs + timing.endShardMs + timing.metaWireMs;
      const result: ShardParsed = {
        type: "SHARD_PARSED",
        shardIndex,
        epoch,
        hitCount: engine.hit_count(),
        unmatchedCount: engine.unmatched_count(),
        methodsMask: engine.methods_mask(),
        cronWire,
        unmatchedWire,
        hourlyWire,
        datesWire,
        dailyWire,
        partialWire,
        wasmHeapBytes: wasmMemory!.buffer.byteLength,
        pathCount: engine.path_count(),
        timing,
      };
      self.postMessage(result, [
        cronWire,
        unmatchedWire,
        hourlyWire,
        datesWire,
        dailyWire,
        partialWire,
      ]);
      return;
    }

    if (msg.type === "PARSE_BYTES") {
      const { buf, shardIndex, epoch } = msg;
      engine.clear();
      const bytes = new Uint8Array(buf);
      let copyIngestMs = 0;
      let feedMs = 0;
      engine.begin_shard(0, bytes.length, bytes.length);
      let off = 0;
      while (off < bytes.length) {
        const take = Math.min(CHUNK, bytes.length - off);
        const tCopy = performance.now();
        const n = writeIngest(bytes.subarray(off, off + take));
        copyIngestMs += performance.now() - tCopy;
        const tFeed = performance.now();
        engine.feed(n, off);
        feedMs += performance.now() - tFeed;
        off += take;
      }
      const tEnd = performance.now();
      engine.end_shard();
      const endShardMs = performance.now() - tEnd;
      const tMeta = performance.now();
      const { cronWire, unmatchedWire, hourlyWire, datesWire, dailyWire } = metaBuffers();
      const metaWireMs = performance.now() - tMeta;
      const timing: ShardTiming = {
        readMs: 0,
        copyIngestMs,
        feedMs,
        endShardMs,
        metaWireMs,
        shardWallMs: copyIngestMs + feedMs + endShardMs + metaWireMs,
      };
      const result: ShardParsed = {
        type: "SHARD_PARSED",
        shardIndex,
        epoch,
        hitCount: engine.hit_count(),
        unmatchedCount: engine.unmatched_count(),
        methodsMask: engine.methods_mask(),
        cronWire,
        unmatchedWire,
        hourlyWire,
        datesWire,
        dailyWire,
        timing,
      };
      self.postMessage(result, [cronWire, unmatchedWire, hourlyWire, datesWire, dailyWire]);
      return;
    }

    if (msg.type === "REAGGREGATE") {
      const t0 = performance.now();
      const dateFilterBytes =
        msg.dateFilter && msg.dateFilter !== "all"
          ? new TextEncoder().encode(msg.dateFilter)
          : new Uint8Array();
      const partial = engine.reaggregate(
        normalizeModeCode(msg.normalizeMode),
        statusFamilyCode(msg.statusFamily),
        msg.minMs,
        dateFilterBytes,
        msg.needSummary,
      );
      const reaggMs = performance.now() - t0;
      const ab = transferableBuffer(partial);
      self.postMessage(
        {
          type: "SHARD_PARTIAL",
          shardIndex: msg.shardIndex,
          epoch: msg.epoch,
          partial: ab,
          reaggMs,
        } satisfies ShardPartial,
        [ab],
      );
      return;
    }
  } catch (err) {
    const shardIndex = "shardIndex" in msg ? msg.shardIndex : 0;
    const epoch = "epoch" in msg ? msg.epoch : 0;
    self.postMessage({
      type: "SHARD_ERROR",
      shardIndex,
      epoch,
      message: err instanceof Error ? err.message : String(err),
    } satisfies ShardError);
  }
};
