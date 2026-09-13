/**
 * Persistent Rust/Wasm shard for MongoDB log parsing:
 * Slices file range + LINE_EXTEND lookahead, ingests directly into Wasm linear memory,
 * and encodes columnar shard data into a compact ArrayBuffer for zero-copy transfer.
 */

import init, { MongoEngine } from "../wasm/pkg_mongo/mongo_core.js";

export type MongoShardRequest =
  | { type: "INIT"; module: WebAssembly.Module }
  | { type: "CLEAR"; epoch: number }
  | {
      type: "PARSE_SHARD";
      epoch: number;
      file: File;
      start: number;
      end: number;
      shardIndex: number;
      totalSize: number;
    }
  | {
      type: "PARSE_SHARD_BUFFER";
      epoch: number;
      buf: ArrayBuffer;
      start: number;
      end: number;
      shardIndex: number;
      totalSize: number;
    };

export type MongoShardParsed = {
  type: "SHARD_PARSED";
  epoch: number;
  shardIndex: number;
  wire: ArrayBuffer;
};

export type MongoShardReady = { type: "SHARD_READY" };

export type MongoShardError = {
  type: "SHARD_ERROR";
  epoch: number;
  shardIndex: number;
  message: string;
};

export type MongoShardResponse = MongoShardReady | MongoShardParsed | MongoShardError;

interface WorkerGlobal {
  postMessage(message: MongoShardResponse, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<MongoShardRequest>) => Promise<void> | void) | null;
}
declare const self: WorkerGlobal;

const LINE_EXTEND = 256 * 1024;

let engine: MongoEngine | null = null;
let wasmMemory: WebAssembly.Memory | null = null;
let ready = false;

function writeIngest(src: Uint8Array): number {
  const len = src.length;
  const ptr = engine!.ingest_ptr(len);
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

async function ensureInit(module: WebAssembly.Module): Promise<void> {
  if (ready && engine) return;
  const exports = await init({ module_or_path: module });
  wasmMemory = exports.memory;
  engine = new MongoEngine();
  ready = true;
}

self.onmessage = async (e: MessageEvent<MongoShardRequest>) => {
  const msg = e.data;
  try {
    if (msg.type === "INIT") {
      await ensureInit(msg.module);
      self.postMessage({ type: "SHARD_READY" } satisfies MongoShardReady);
      return;
    }

    if (!engine || !ready || !wasmMemory) {
      throw new Error("Mongo shard worker not initialized");
    }

    if (msg.type === "CLEAR") {
      engine.clear();
      return;
    }

    if (msg.type === "PARSE_SHARD") {
      const { file, start, end, shardIndex, epoch, totalSize } = msg;
      const readEnd = Math.min(totalSize, end + LINE_EXTEND);
      const slice = file.slice(start, readEnd);
      const buf = await slice.arrayBuffer();
      const bytes = new Uint8Array(buf);

      writeIngest(bytes);
      engine.parse_shard_ingest(bytes.length, start, end, totalSize);

      const wire = engine.encode_shard();
      const wireBuf = transferableBuffer(wire);
      engine.clear();

      self.postMessage(
        {
          type: "SHARD_PARSED",
          epoch,
          shardIndex,
          wire: wireBuf,
        } satisfies MongoShardParsed,
        [wireBuf],
      );
      return;
    }

    if (msg.type === "PARSE_SHARD_BUFFER") {
      const { buf, start, end, shardIndex, epoch, totalSize } = msg;
      const bytes = new Uint8Array(buf);

      writeIngest(bytes);
      engine.parse_shard_ingest(bytes.length, start, end, totalSize);

      const wire = engine.encode_shard();
      const wireBuf = transferableBuffer(wire);
      engine.clear();

      self.postMessage(
        {
          type: "SHARD_PARSED",
          epoch,
          shardIndex,
          wire: wireBuf,
        } satisfies MongoShardParsed,
        [wireBuf],
      );
    }
  } catch (err) {
    const epoch = "epoch" in msg ? msg.epoch : 0;
    const shardIndex = "shardIndex" in msg ? msg.shardIndex : 0;
    const message = err instanceof Error ? err.message : String(err);
    self.postMessage({
      type: "SHARD_ERROR",
      epoch,
      shardIndex,
      message,
    } satisfies MongoShardError);
  }
};
