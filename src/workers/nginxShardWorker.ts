import init, { NginxEngine } from "../wasm/pkg_nginx/nginx_core.js";

export type NginxShardSource =
  | { kind: "file"; file: File; start: number; end: number }
  | { kind: "buffer"; buffer: ArrayBuffer };

export type NginxShardRequest =
  | { type: "INIT"; id: number; module: WebAssembly.Module }
  | { type: "PARSE"; id: number; epoch: number; sources: NginxShardSource[]; replace: boolean }
  | { type: "PARTIAL"; id: number; filters: string; pending: boolean }
  | { type: "COMMIT" | "ROLLBACK" | "CLEAR"; id: number }
  | { type: "CANCEL"; epoch: number };

export type NginxShardResponse =
  | { type: "OK"; id: number }
  | { type: "PARTIALS"; id: number; buffers: ArrayBuffer[] }
  | { type: "PROGRESS"; epoch: number; processed: number }
  | { type: "ERROR"; id: number; message: string };

declare const self: {
  onmessage: ((event: MessageEvent<NginxShardRequest>) => void) | null;
  postMessage: (message: NginxShardResponse, transfer?: Transferable[]) => void;
};

// Small windows keep the Wasm ingest buffer and in-flight Blob reads cheap per worker;
// several reads in flight hide Blob read latency behind parsing.
const WINDOW = 8 * 1024 * 1024;
const READ_AHEAD = 3;
// Buffer sources yield to the event loop at this cadence (nested timers clamp to 4 ms).
const YIELD_BYTES = 32 * 1024 * 1024;
let memory: WebAssembly.Memory;
let committed: NginxEngine[] = [];
let pending: NginxEngine | null = null;
let cancelledEpoch = -1;
let queue = Promise.resolve();

function discardPending(): void {
  pending?.free();
  pending = null;
}

function clearEngines(): void {
  discardPending();
  for (const engine of committed) engine.free();
  committed = [];
}

function checkCancelled(epoch: number): void {
  if (epoch <= cancelledEpoch) throw new Error("Nginx parsing cancelled");
}

async function parseSources(message: Extract<NginxShardRequest, { type: "PARSE" }>): Promise<void> {
  if (message.replace) clearEngines();
  else discardPending();
  checkCancelled(message.epoch);
  pending = new NginxEngine();
  let processed = 0;
  let unyielded = 0;
  try {
    for (const source of message.sources) {
      const start = source.kind === "file" ? source.start : 0;
      const end = source.kind === "file" ? source.end : source.buffer.byteLength;
      const buffer = source.kind === "buffer" ? new Uint8Array(source.buffer) : null;
      const reads: Promise<ArrayBuffer>[] = [];
      let nextRead = start;
      const readAhead = () => {
        while (source.kind === "file" && reads.length < READ_AHEAD && nextRead < end) {
          reads.push(source.file.slice(nextRead, Math.min(end, nextRead + WINDOW)).arrayBuffer());
          nextRead += WINDOW;
        }
      };
      readAhead();
      for (let offset = start; offset < end; offset += WINDOW) {
        checkCancelled(message.epoch);
        const take = Math.min(WINDOW, end - offset);
        const bytes = buffer
          ? buffer.subarray(offset, offset + take)
          : new Uint8Array(await reads.shift()!);
        readAhead();
        checkCancelled(message.epoch);
        const pointer = pending.ingest_ptr(take);
        new Uint8Array(memory.buffer, pointer, take).set(bytes);
        pending.feed(take);
        // The runtime only switches a function to optimized code on a later call. One
        // throwaway aggregate while more input remains lets that compile finish in the
        // background, so the real first aggregate does not run in the baseline tier.
        if (processed === 0 && offset + take < end) pending.partial("{}");
        processed += take;
        unyielded += take;
        self.postMessage({ type: "PROGRESS", epoch: message.epoch, processed });
        // Let cancellation and new requests reach the worker between bounded windows.
        if (buffer && unyielded >= YIELD_BYTES) {
          unyielded = 0;
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }
      checkCancelled(message.epoch);
      pending.end_source();
    }
  } catch (error) {
    discardPending();
    throw error;
  }
}

async function handleMessage(
  message: Exclude<NginxShardRequest, { type: "CANCEL" }>,
): Promise<void> {
  try {
    if (message.type === "INIT") {
      memory = (await init({ module_or_path: message.module })).memory;
    } else if (message.type === "PARSE") {
      await parseSources(message);
    } else if (message.type === "PARTIAL") {
      const engines = message.pending && pending ? [...committed, pending] : committed;
      const buffers = engines.map((engine) => {
        const bytes = engine.partial(message.filters);
        // SAFETY: wasm-bindgen copies Vec<u8> results into owned ArrayBuffer-backed arrays.
        return bytes.buffer as ArrayBuffer;
      });
      self.postMessage({ type: "PARTIALS", id: message.id, buffers }, buffers);
      return;
    } else if (message.type === "COMMIT") {
      if (pending) committed.push(pending);
      pending = null;
    } else if (message.type === "ROLLBACK") {
      discardPending();
    } else if (message.type === "CLEAR") {
      clearEngines();
    }
    self.postMessage({ type: "OK", id: message.id });
  } catch (error) {
    self.postMessage({
      type: "ERROR",
      id: message.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

self.onmessage = ({ data }) => {
  if (data.type === "CANCEL") {
    cancelledEpoch = Math.max(cancelledEpoch, data.epoch);
    return;
  }
  queue = queue.then(() => handleMessage(data));
};
