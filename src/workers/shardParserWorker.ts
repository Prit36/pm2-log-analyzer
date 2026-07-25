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
    }
  | {
      type: "PARSE_BYTES";
      epoch: number;
      buf: ArrayBuffer;
      shardIndex: number;
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

export type ShardTiming = {
  readMs: number;
  scanParseMs: number;
  internMs: number;
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
  timing: ShardTiming;
};

export type ShardPartial = {
  type: "SHARD_PARTIAL";
  shardIndex: number;
  epoch: number;
  partial: ArrayBuffer;
};

export type ShardError = {
  type: "SHARD_ERROR";
  shardIndex: number;
  epoch: number;
  message: string;
};

export type ShardReady = { type: "SHARD_READY" };

const CHUNK = 8 * 1024 * 1024;
const LINE_EXTEND = 256 * 1024;

let engine: Pm2Engine | null = null;
let wasmMemory: WebAssembly.Memory | null = null;
let ready = false;

function heapU8(): Uint8Array {
  return new Uint8Array(wasmMemory!.buffer);
}

/** Write bytes into Wasm ingest window; return length written. */
function writeIngest(src: Uint8Array): number {
  const len = Math.min(src.length, CHUNK);
  const ptr = engine!.ingest_ptr(len);
  // Re-read heap after possible grow from ingest_ptr.
  heapU8().set(src.subarray(0, len), ptr);
  return len;
}

async function ensureInit(module: WebAssembly.Module) {
  if (ready && engine) return;
  const exports = await init({ module_or_path: module });
  wasmMemory = exports.memory;
  engine = new Pm2Engine();
  ready = true;
}

async function parseFileRange(
  file: File,
  start: number,
  end: number,
): Promise<ShardTiming> {
  let readMs = 0;
  let scanParseMs = 0;

  engine!.begin_shard(start, end, file.size);
  const readEnd = Math.min(file.size, end + LINE_EXTEND);
  let off = start;

  while (off < readEnd) {
    const take = Math.min(CHUNK, readEnd - off);
    const t0 = performance.now();
    const chunk = new Uint8Array(await file.slice(off, off + take).arrayBuffer());
    readMs += performance.now() - t0;

    const t1 = performance.now();
    const n = writeIngest(chunk);
    engine!.feed(n, off);
    scanParseMs += performance.now() - t1;
    off += take;

    // Early exit once past ownership and no need for extend (engine keeps carry).
    if (off >= end + LINE_EXTEND) break;
  }

  const t2 = performance.now();
  engine!.end_shard();
  // Only the mode used by first reagg — ensure_mode is lazy inside reaggregate.
  scanParseMs += performance.now() - t2;

  return { readMs, scanParseMs, internMs: 0 };
}

function metaBuffers(): { cronWire: ArrayBuffer; unmatchedWire: ArrayBuffer } {
  const cron = engine!.cron_wire();
  const unmatched = engine!.unmatched_sample_wire();
  return {
    cronWire: cron.buffer.slice(cron.byteOffset, cron.byteOffset + cron.byteLength),
    unmatchedWire: unmatched.buffer.slice(
      unmatched.byteOffset,
      unmatched.byteOffset + unmatched.byteLength,
    ),
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

    if (msg.type === "PARSE_SHARD") {
      const { file, start, end, shardIndex, epoch } = msg;
      engine.clear();
      const timing = await parseFileRange(file, start, end);
      const { cronWire, unmatchedWire } = metaBuffers();
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

    if (msg.type === "PARSE_BYTES") {
      const { buf, shardIndex, epoch } = msg;
      engine.clear();
      const bytes = new Uint8Array(buf);
      const t0 = performance.now();
      engine.begin_shard(0, bytes.length, bytes.length);
      let off = 0;
      while (off < bytes.length) {
        const take = Math.min(CHUNK, bytes.length - off);
        const n = writeIngest(bytes.subarray(off, off + take));
        engine.feed(n, off);
        off += take;
      }
      engine.end_shard();
      const scanParseMs = performance.now() - t0;
      const { cronWire, unmatchedWire } = metaBuffers();
      const result: ShardParsed = {
        type: "SHARD_PARSED",
        shardIndex,
        epoch,
        hitCount: engine.hit_count(),
        unmatchedCount: engine.unmatched_count(),
        methodsMask: engine.methods_mask(),
        cronWire,
        unmatchedWire,
        timing: { readMs: 0, scanParseMs, internMs: 0 },
      };
      self.postMessage(result, [cronWire, unmatchedWire]);
      return;
    }

    if (msg.type === "REAGGREGATE") {
      const partial = engine.reaggregate(
        normalizeModeCode(msg.normalizeMode),
        statusFamilyCode(msg.statusFamily),
        msg.minMs,
        msg.needSummary,
      );
      const ab = partial.buffer.slice(
        partial.byteOffset,
        partial.byteOffset + partial.byteLength,
      );
      self.postMessage(
        {
          type: "SHARD_PARTIAL",
          shardIndex: msg.shardIndex,
          epoch: msg.epoch,
          partial: ab,
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
