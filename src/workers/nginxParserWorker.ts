import init, { NginxAggregator } from "../wasm/pkg_nginx/nginx_core.js";
import { compileNginxCoreModule } from "../wasm/loadNginxCore";
import type { NginxFilters, NginxResult } from "../nginx/types";
import type { ParseProgress } from "../store/analysisStore";
import type { NginxShardRequest, NginxShardResponse, NginxShardSource } from "./nginxShardWorker";
import NginxShardWorker from "./nginxShardWorker.ts?worker&inline";

export type NginxInput =
  | { kind: "file"; file: File }
  | { kind: "buffer"; buffer: ArrayBuffer; name: string; size: number };

export type NginxWorkerMessage =
  | { type: "PARSE"; id: number; inputs: NginxInput[]; filters: NginxFilters; append: boolean }
  | { type: "REAGGREGATE"; id: number; filters: NginxFilters }
  | { type: "CANCEL"; id: number }
  | { type: "CLEAR"; id: number };

export type NginxWorkerResponse =
  | { type: "READY" }
  | { type: "PROGRESS"; id: number; payload: ParseProgress }
  | { type: "RESULT"; id: number; payload: NginxResult }
  | { type: "ERROR"; id: number; message: string }
  | { type: "CANCELLED"; id: number };

declare const self: {
  onmessage: ((event: MessageEvent<NginxWorkerMessage>) => void) | null;
  postMessage: (message: NginxWorkerResponse) => void;
};

const pool: Worker[] = [];
const requests = new Map<
  number,
  { resolve: (response: NginxShardResponse) => void; reject: (error: Error) => void }
>();
const compile = compileNginxCoreModule();
const initialized = compile.then(async (module) => {
  await init({ module_or_path: module });
  return module;
});
let rpcId = 0;
let epoch = 0;
let queue = Promise.resolve();
let activeId = 0;
let activeEpoch = 0;
let totalBytes = 0;
let processedBytes: number[] = [];

function request(
  worker: Worker,
  message: NginxShardRequest,
  transfer: Transferable[] = [],
): Promise<NginxShardResponse> {
  if (message.type === "CANCEL") throw new Error("Cancellation does not use a response");
  return new Promise((resolve, reject) => {
    requests.set(message.id, { resolve, reject });
    worker.postMessage(message, transfer);
  });
}

async function ensurePool(count: number): Promise<void> {
  const module = await initialized;
  const ready: Promise<NginxShardResponse>[] = [];
  while (pool.length < count) {
    const worker = new NginxShardWorker();
    const index = pool.length;
    pool.push(worker);
    worker.onmessage = ({ data }: MessageEvent<NginxShardResponse>) => {
      if (data.type === "PROGRESS") {
        if (data.epoch !== activeEpoch || data.epoch !== epoch) return;
        processedBytes[index] = data.processed;
        const processed = processedBytes.reduce((sum, value) => sum + value, 0);
        self.postMessage({
          type: "PROGRESS",
          id: activeId,
          payload: {
            stage: "parsing",
            processed,
            total: totalBytes,
            percent: totalBytes ? Math.min(95, Math.round((processed / totalBytes) * 95)) : 95,
          },
        });
        return;
      }
      const pendingRequest = requests.get(data.id);
      requests.delete(data.id);
      if (data.type === "ERROR") pendingRequest?.reject(new Error(data.message));
      else pendingRequest?.resolve(data);
    };
    worker.onerror = (error) => {
      for (const pendingRequest of requests.values())
        pendingRequest.reject(new Error(error.message || "Nginx shard worker failed"));
      requests.clear();
    };
    ready.push(request(worker, { type: "INIT", id: ++rpcId, module }));
  }
  await Promise.all(ready);
}

async function fileBoundary(file: File, start: number): Promise<number> {
  if (start <= 0) return 0;
  if (start >= file.size) return file.size;
  // Include the previous byte so a boundary already after a newline stays exact.
  let offset = start - 1;
  while (offset < file.size) {
    const bytes = new Uint8Array(
      await file.slice(offset, Math.min(file.size, offset + 65536)).arrayBuffer(),
    );
    const newline = bytes.indexOf(10);
    if (newline >= 0) return offset + newline + 1;
    offset += bytes.length;
  }
  return file.size;
}

async function splitInputs(inputs: NginxInput[], count: number): Promise<NginxShardSource[][]> {
  const shards: NginxShardSource[][] = Array.from({ length: count }, () => []);
  for (const input of inputs) {
    const size = input.kind === "file" ? input.file.size : input.buffer.byteLength;
    const boundaries = [0];
    if (input.kind === "file") {
      boundaries.push(
        ...(await Promise.all(
          Array.from({ length: count - 1 }, (_, index) =>
            fileBoundary(input.file, Math.floor((size * (index + 1)) / count)),
          ),
        )),
      );
    } else {
      const bytes = new Uint8Array(input.buffer);
      for (let index = 1; index < count; index++) {
        const offset = Math.floor((size * index) / count);
        const newline = bytes.indexOf(10, Math.max(0, offset - 1));
        boundaries.push(newline < 0 ? size : newline + 1);
      }
    }
    boundaries.push(size);
    for (let index = 0; index < count; index++) {
      const start = boundaries[index]!;
      const end = boundaries[index + 1]!;
      if (end <= start) continue;
      if (input.kind === "file")
        shards[index]!.push({ kind: "file", file: input.file, start, end });
      else
        shards[index]!.push({
          kind: "buffer",
          buffer: count === 1 ? input.buffer : input.buffer.slice(start, end),
        });
    }
    if (input.kind === "buffer") input.buffer = new ArrayBuffer(0);
  }
  return shards;
}

function checkEpoch(token: number): void {
  if (token !== epoch) throw new Error("Nginx parsing cancelled");
}

async function aggregate(
  filters: NginxFilters,
  includePending: boolean,
  token: number,
): Promise<NginxResult> {
  const json = JSON.stringify(filters);
  const partials = await Promise.all(
    pool.map((worker) =>
      request(worker, { type: "PARTIAL", id: ++rpcId, filters: json, pending: includePending }),
    ),
  );
  checkEpoch(token);
  const aggregator = new NginxAggregator();
  try {
    for (const response of partials) {
      if (response.type === "PARTIALS")
        for (const buffer of response.buffers) aggregator.add_partial(new Uint8Array(buffer));
    }
    // SAFETY: Rust serializes the shared NginxResult contract consumed by the dashboard.
    return JSON.parse(aggregator.finish(json)) as NginxResult;
  } finally {
    aggregator.free();
  }
}

async function processMessage(message: NginxWorkerMessage, token: number): Promise<void> {
  try {
    await initialized;
    checkEpoch(token);
    if (message.type === "CLEAR") {
      await Promise.all(pool.map((worker) => request(worker, { type: "CLEAR", id: ++rpcId })));
      return;
    }
    if (message.type === "CANCEL") return;
    if (message.type === "REAGGREGATE") {
      const result = await aggregate(message.filters, false, token);
      checkEpoch(token);
      self.postMessage({ type: "RESULT", id: message.id, payload: result });
      return;
    }
    activeId = message.id;
    activeEpoch = token;
    totalBytes = message.inputs.reduce(
      (sum, input) => sum + (input.kind === "file" ? input.file.size : input.buffer.byteLength),
      0,
    );
    const count =
      totalBytes < 8 * 1024 * 1024
        ? 1
        : Math.max(1, Math.min(4, navigator.hardwareConcurrency || 4));
    await ensurePool(count);
    checkEpoch(token);
    if (!message.append)
      await Promise.all(pool.map((worker) => request(worker, { type: "CLEAR", id: ++rpcId })));
    const shards = await splitInputs(message.inputs, count);
    checkEpoch(token);
    processedBytes = Array.from({ length: pool.length }, () => 0);
    await Promise.all(
      shards.map((sources, index) =>
        request(
          pool[index]!,
          { type: "PARSE", id: ++rpcId, epoch: token, sources, replace: false },
          sources.flatMap((source) => (source.kind === "buffer" ? [source.buffer] : [])),
        ),
      ),
    );
    checkEpoch(token);
    self.postMessage({
      type: "PROGRESS",
      id: message.id,
      payload: { stage: "aggregating", processed: 95, total: 100, percent: 95 },
    });
    const result = await aggregate(message.filters, true, token);
    checkEpoch(token);
    // Commit and publish in one event-loop turn so cancellation cannot split them.
    for (const worker of pool)
      worker.postMessage({ type: "COMMIT", id: ++rpcId } satisfies NginxShardRequest);
    self.postMessage({ type: "RESULT", id: message.id, payload: result });
  } catch (error) {
    await Promise.allSettled(
      pool.map((worker) => request(worker, { type: "ROLLBACK", id: ++rpcId })),
    );
    if (token !== epoch) self.postMessage({ type: "CANCELLED", id: message.id });
    else
      self.postMessage({
        type: "ERROR",
        id: message.id,
        message: error instanceof Error ? error.message : String(error),
      });
  }
}

self.onmessage = ({ data }) => {
  const token = ++epoch;
  // Invalidate in-flight ingest immediately; queued commands run after rollback.
  for (const worker of pool)
    worker.postMessage({ type: "CANCEL", epoch: token - 1 } satisfies NginxShardRequest);
  queue = queue.then(() => processMessage(data, token));
};

void initialized.then(() => self.postMessage({ type: "READY" })).catch(() => {});
