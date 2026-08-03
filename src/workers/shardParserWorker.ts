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
  partialWire?: ArrayBuffer;
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

function heapU8(): Uint8Array {
  return new Uint8Array(wasmMemory!.buffer);
}

/** Write bytes into Wasm ingest window; return length written. */
function writeIngest(src: Uint8Array): number {
  const len = src.length;
  const ptr = engine!.ingest_ptr(len);
  // Re-read heap after possible grow from ingest_ptr.
  heapU8().set(src, ptr);
  return len;
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
  let off = start;

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

function metaBuffers(): { cronWire: ArrayBuffer; unmatchedWire: ArrayBuffer } {
  const cron = engine!.cron_wire();
  const unmatched = engine!.unmatched_sample_wire();
  return {
    cronWire: cron.buffer.slice(cron.byteOffset, cron.byteOffset + cron.byteLength) as ArrayBuffer,
    unmatchedWire: unmatched.buffer.slice(
      unmatched.byteOffset,
      unmatched.byteOffset + unmatched.byteLength,
    ) as ArrayBuffer,
  };
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
      const partialWire = engine.reaggregate(modeCode, 0, 0, true).buffer;
      const tMeta = performance.now();
      const { cronWire, unmatchedWire } = metaBuffers();
      timing.metaWireMs = performance.now() - tMeta;
      timing.shardWallMs =
        timing.readMs +
        timing.copyIngestMs +
        timing.feedMs +
        timing.endShardMs +
        timing.metaWireMs;
      const result: ShardParsed = {
        type: "SHARD_PARSED",
        shardIndex,
        epoch,
        hitCount: engine.hit_count(),
        unmatchedCount: engine.unmatched_count(),
        methodsMask: engine.methods_mask(),
        cronWire,
        unmatchedWire,
        partialWire,
        timing,
      };
      self.postMessage(result, [cronWire, unmatchedWire, partialWire]);
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
      const { cronWire, unmatchedWire } = metaBuffers();
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
        timing,
      };
      self.postMessage(result, [cronWire, unmatchedWire]);
      return;
    }

    if (msg.type === "REAGGREGATE") {
      const t0 = performance.now();
      const partial = engine.reaggregate(
        normalizeModeCode(msg.normalizeMode),
        statusFamilyCode(msg.statusFamily),
        msg.minMs,
        msg.needSummary,
      );
      const reaggMs = performance.now() - t0;
      const ab = partial.buffer.slice(
        partial.byteOffset,
        partial.byteOffset + partial.byteLength,
      ) as ArrayBuffer;
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
    const shardIndex = "shardIndex" in msg ? (msg as { shardIndex: number }).shardIndex : 0;
    const epoch = "epoch" in msg ? (msg as { epoch: number }).epoch : 0;
    self.postMessage({
      type: "SHARD_ERROR",
      shardIndex,
      epoch,
      message: err instanceof Error ? err.message : String(err),
    } satisfies ShardError);
  }
};
