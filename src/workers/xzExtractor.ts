import { inspect_xz_blob, TarStream } from "../wasm/pkg_zip/zip_core.js";
import { compileZipCoreModule } from "../wasm/loadZipCore";
import type { XzDecoded, XzJob } from "./xzDecodeWorker";

type XzBlock = Omit<XzJob, "file" | "check">;
type XzPlan = { check: number; blocks: XzBlock[] };
type Outcome = { ok: true; value: XzDecoded } | { ok: false; error: Error };

declare const FileReaderSync: {
  new (): { readAsArrayBuffer: (file: Blob) => ArrayBuffer };
};

function decode(worker: Worker, job: XzJob): Promise<Outcome> {
  return new Promise((resolve) => {
    worker.onmessage = ({ data }: MessageEvent<XzDecoded>) => {
      resolve(data.error ? { ok: false, error: new Error(data.error) } : { ok: true, value: data });
    };
    worker.onerror = (event) => resolve({ ok: false, error: new Error(event.message) });
    worker.postMessage(job);
  });
}

/** Decode indexed XZ blocks with bounded memory, then feed TAR in stream order. */
export async function extractXzTar(
  file: File,
  memory: WebAssembly.Memory,
  onEntry: (path: string, data: Uint8Array) => void,
  onSkipped: (path: string) => void,
  workerCap: number,
): Promise<number | undefined> {
  const reader = new FileReaderSync();
  let cached = new Uint8Array();
  let cachedOffset = -1;
  const json = inspect_xz_blob(file.size, (offset: number, pointer: number, length: number) => {
    if (offset < cachedOffset || offset + length > cachedOffset + cached.byteLength) {
      cachedOffset = Math.floor(offset / (1024 * 1024)) * 1024 * 1024;
      cached = new Uint8Array(
        reader.readAsArrayBuffer(
          file.slice(cachedOffset, Math.max(cachedOffset + 1024 * 1024, offset + length)),
        ),
      );
    }
    const start = offset - cachedOffset;
    if (start + length > cached.byteLength) throw new Error("Truncated XZ input");
    new Uint8Array(memory.buffer, pointer, length).set(cached.subarray(start, start + length));
  });
  if (!json) return undefined;
  // SAFETY: Rust validates the XZ index, bounds, block headers and dictionary sizes before serialization.
  const { check, blocks } = JSON.parse(json) as XzPlan;
  if (blocks.length < 2) return undefined;
  const count = Math.min(4, workerCap, navigator.hardwareConcurrency || 4, blocks.length);
  const module = await compileZipCoreModule();
  const workers: Worker[] = [];
  let output = new Uint8Array();
  let path = "";
  let written = 0;
  const tar = new TarStream(
    (name: string, size: number) => {
      path = name;
      output = new Uint8Array(size);
      written = 0;
    },
    (pointer: number, length: number) => {
      output.set(new Uint8Array(memory.buffer, pointer, length), written);
      written += length;
    },
    () => {
      onEntry(path, output);
      output = new Uint8Array();
    },
    onSkipped,
  );
  try {
    for (let index = 0; index < count; index++) {
      const worker = new Worker(new URL("./xzDecodeWorker.ts", import.meta.url), {
        type: "module",
      });
      workers.push(worker);
      worker.postMessage({ module });
    }
    const schedule = (index: number) =>
      decode(workers[index % count]!, { file, check, ...blocks[index]! });
    const pending: (Promise<Outcome> | undefined)[] = blocks
      .slice(0, count)
      .map((_, index) => schedule(index));
    for (let index = 0; index < blocks.length; index++) {
      const slot = index % count;
      const result = await pending[slot]!;
      pending[slot] = undefined;
      if (!result.ok) throw result.error;
      if (index + count < blocks.length) pending[slot] = schedule(index + count);
      tar.feed(new Uint8Array(result.value.buffer));
    }
    return tar.finish();
  } finally {
    tar.free();
    for (const worker of workers) worker.terminate();
  }
}
