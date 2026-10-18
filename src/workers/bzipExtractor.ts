import { BzipScanner, TarStream } from "../wasm/pkg_zip/zip_core.js";
import { compileZipCoreModule } from "../wasm/loadZipCore";
import type { BzipDecoded, BzipJob } from "./bzipDecodeWorker";

type Marker = { bit: number; end: boolean };
type Outcome = { ok: true; value: BzipDecoded } | { ok: false; error: Error };

function decode(worker: Worker, job: BzipJob): Promise<Outcome> {
  return new Promise((resolve) => {
    worker.onmessage = ({ data }: MessageEvent<BzipDecoded>) => {
      resolve(data.error ? { ok: false, error: new Error(data.error) } : { ok: true, value: data });
    };
    worker.onerror = (event) => resolve({ ok: false, error: new Error(event.message) });
    worker.postMessage(job);
  });
}

function bits(bytes: Uint8Array, start: number, length: number): number {
  let value = 0;
  for (let bit = start; bit < start + length; bit++) {
    if (bit >>> 3 >= bytes.length) throw new Error("Truncated Bzip2 trailer");
    value = value * 2 + ((bytes[bit >>> 3]! >>> (7 - (bit & 7))) & 1);
  }
  return value;
}

/** Decode independent Bzip2 blocks in a bounded pool, then feed TAR in stream order. */
export async function extractBzipTar(
  file: File,
  memory: WebAssembly.Memory,
  onEntry: (path: string, data: Uint8Array) => void,
  onSkipped: (path: string) => void,
  workerCap: number,
): Promise<number> {
  const scanner = new BzipScanner();
  let markers: Marker[];
  try {
    for (let offset = 0; offset < file.size; offset += 8 * 1024 * 1024) {
      scanner.scan(
        new Uint8Array(await file.slice(offset, offset + 8 * 1024 * 1024).arrayBuffer()),
      );
    }
    // SAFETY: Rust serializes the scanner's bit offsets and marker kinds directly.
    markers = JSON.parse(scanner.markers()) as Marker[];
  } finally {
    scanner.free();
  }
  const blocks = markers.flatMap((marker, index) =>
    marker.end ? [] : [{ start: marker.bit, end: markers[index + 1]?.bit ?? file.size * 8 }],
  );
  const count = Math.min(
    4,
    workerCap,
    navigator.hardwareConcurrency || 4,
    Math.max(1, blocks.length),
  );
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
      const worker = new Worker(new URL("./bzipDecodeWorker.ts", import.meta.url), {
        type: "module",
      });
      workers.push(worker);
      worker.postMessage({ module });
    }
    const schedule = (index: number) =>
      decode(workers[index % count]!, { file, ...blocks[index]! });
    const pending: (Promise<Outcome> | undefined)[] = blocks
      .slice(0, count)
      .map((_, index) => schedule(index));
    let expected = 32;
    let crc = 0;
    let blockIndex = 0;
    let ended = false;
    let header = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    let level = header[3]! - 48;
    if (header[0] !== 66 || header[1] !== 90 || header[2] !== 104 || level < 1 || level > 9)
      throw new Error("Invalid Bzip2 stream header");
    for (const marker of markers) {
      if (marker.end) {
        if (marker.bit < expected) continue;
        if (marker.bit !== expected) throw new Error("Invalid Bzip2 block boundary");
        const start = Math.floor(marker.bit / 8);
        const next = Math.ceil((marker.bit + 80) / 8);
        const trailer = new Uint8Array(await file.slice(start, next + 4).arrayBuffer());
        if (bits(trailer, (marker.bit % 8) + 48, 32) !== crc)
          throw new Error("Bzip2 stream checksum mismatch");
        ended = true;
        if (next === file.size) break;
        header = trailer.subarray(next - start);
        if (header[0] !== 66 || header[1] !== 90 || header[2] !== 104) break;
        level = header[3]! - 48;
        if (header.length < 4 || level < 1 || level > 9)
          throw new Error("Truncated or invalid Bzip2 stream header");
        crc = 0;
        expected = next * 8 + 32;
        ended = false;
        continue;
      }
      const slot = blockIndex % count;
      const outcome = await pending[slot]!;
      pending[slot] = undefined;
      // Refill while the coordinator copies this output into its TAR entry.
      if (blockIndex + count < blocks.length) pending[slot] = schedule(blockIndex + count);
      if (marker.bit >= expected) {
        if (marker.bit !== expected) throw new Error("Invalid Bzip2 block boundary");
        if (!outcome.ok) throw outcome.error;
        const result = outcome.value;
        if (result.length > level * 100000) throw new Error("Bzip2 block exceeds its stream limit");
        expected = result.end;
        crc = (((crc << 1) | (crc >>> 31)) ^ result.crc) >>> 0;
        tar.feed(new Uint8Array(result.buffer));
      }
      blockIndex++;
    }
    if (!ended) throw new Error("Truncated Bzip2 stream");
    return tar.finish();
  } finally {
    tar.free();
    for (const worker of workers) worker.terminate();
  }
}
