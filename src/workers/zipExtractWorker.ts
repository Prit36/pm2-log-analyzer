import { archiveSuffix, isArchiveName } from "../utils/archiveFormats";
import { compileZipCoreModule } from "../wasm/loadZipCore";
import init, {
  classify_log_name_or_content,
  FastDecompressor,
  InflateStream,
} from "../wasm/pkg_zip/zip_core.js";

export type ExtractedFileItem = {
  name: string;
  category: "pm2" | "mongo" | "nginx" | "archive";
  buffer: ArrayBuffer;
  size: number;
};

export type ExtractedArchiveResult = {
  id?: number | undefined;
  fileName: string;
  files: ExtractedFileItem[];
  skipped: string[];
  totalBytes: number;
  durationMs: number;
};

export type EntryExtractJob = {
  id: number;
  name: string;
  cleanName: string;
  category: "pm2" | "mongo" | "nginx" | "unknown" | "archive";
  /** The entry's local header and data, sliced from a File or an in-memory archive. */
  entryBlob: Blob | ArrayBuffer;
  compressedSize: number;
  uncompressedSize: number;
  isDeflated: boolean;
};

export type ExtractedEntryResponse = {
  id: number;
  name: string;
  category: "pm2" | "mongo" | "nginx" | "archive";
  buffer: ArrayBuffer;
  size: number;
};

/**
 * Decode one ZIP entry or gzip member with bounded Wasm memory. PM2 and Mongo logs are
 * streamed as ENTRY_BEGIN / ENTRY_CHUNK / ENTRY_END when `stream` is set; nested archives,
 * Nginx logs and non-streamed logs come back whole as ENTRY_RESULT.
 */
export type StreamDecodeJob = {
  id: number;
  format: "deflate" | "stored" | "gzip";
  /** Compressed bytes; for ZIP entries this starts at the local file header. */
  source: Blob | ArrayBuffer;
  zipLocalHeader: boolean;
  compressedSize: number;
  /** Decoded size from the ZIP central directory or the gzip trailer. */
  expectedSize: number;
  name: string;
  cleanName: string;
  stream: boolean;
};

export type EntryBeginResponse = {
  id: number;
  name: string;
  category: "pm2" | "mongo";
  size: number;
};

export type ZipWorkerMessage =
  | { type: "EXTRACT_ENTRY"; payload: EntryExtractJob }
  | { type: "STREAM_DECODE"; payload: StreamDecodeJob }
  | {
      type: "DECOMPRESS_GZ";
      payload: { id?: number | undefined; fileBuffer: ArrayBuffer; fileName: string };
    };

export type ZipWorkerResponse =
  | { type: "PROGRESS"; payload: { stage: string; percent: number } }
  | { type: "ENTRY_RESULT"; payload: ExtractedEntryResponse }
  | { type: "ENTRY_BEGIN"; payload: EntryBeginResponse }
  | { type: "ENTRY_CHUNK"; payload: { id: number; offset: number; buffer: ArrayBuffer } }
  | { type: "ENTRY_END"; payload: { id: number; size: number } }
  | { type: "RESULT"; payload: ExtractedArchiveResult }
  | { type: "ERROR"; payload: { message: string; id?: number | undefined } };

interface WorkerGlobal {
  postMessage: (message: ZipWorkerResponse, transfer?: Transferable[]) => void;
  onmessage: ((e: MessageEvent<ZipWorkerMessage>) => Promise<void> | void) | null;
  addEventListener: (
    type: "message",
    listener: (e: MessageEvent<ZipWorkerMessage>) => void,
  ) => void;
}
declare const self: WorkerGlobal;

let wasmMemory: WebAssembly.Memory | null = null;
let decompressor: FastDecompressor | null = null;

async function ensureWasm(): Promise<void> {
  if (wasmMemory && decompressor) return;
  const module = await compileZipCoreModule();
  const initOutput = await init({ module_or_path: module });
  wasmMemory = initOutput.memory;
  decompressor = new FastDecompressor();
}

// Eagerly initialize Wasm when worker starts
void ensureWasm();

type DecompressViewResult = {
  view: Uint8Array;
  decMs: number;
};

function decompressToView(
  compBytes: Uint8Array,
  uncompressedSize: number,
  isDeflated: boolean,
): DecompressViewResult {
  if (!isDeflated || uncompressedSize === 0) {
    return { view: compBytes, decMs: 0 };
  }
  const tDec0 = performance.now();
  const ptr = decompressor!.decompress_deflate(compBytes, uncompressedSize);
  const len = decompressor!.output_len();
  const decMs = performance.now() - tDec0;

  // SAFETY: Direct zero-copy view into Wasm linear memory. File constructor snapshots directly.
  const view = new Uint8Array(wasmMemory!.buffer, ptr, len);
  return { view, decMs };
}

async function handleExtractEntry(job: EntryExtractJob): Promise<void> {
  await ensureWasm();

  const sliceBuffer =
    job.entryBlob instanceof ArrayBuffer ? job.entryBlob : await job.entryBlob.arrayBuffer();

  // Read local file header (30 bytes)
  let compBytes: Uint8Array;
  if (sliceBuffer.byteLength >= 30) {
    const view = new DataView(sliceBuffer);
    const lhNameLen = view.getUint16(26, true);
    const lhExtraLen = view.getUint16(28, true);
    const dataStart = 30 + lhNameLen + lhExtraLen;
    if (dataStart + job.compressedSize <= sliceBuffer.byteLength) {
      compBytes = new Uint8Array(sliceBuffer, dataStart, job.compressedSize);
    } else {
      compBytes = new Uint8Array(sliceBuffer, dataStart);
    }
  } else {
    compBytes = new Uint8Array(sliceBuffer);
  }

  let { view } = decompressToView(compBytes, job.uncompressedSize, job.isDeflated);
  if (view[0] === 0x1f && view[1] === 0x8b) {
    const gzipBytes = view.slice();
    const ptr = decompressor!.decompress_gzip(gzipBytes);
    view = new Uint8Array(wasmMemory!.buffer, ptr, decompressor!.output_len());
  }

  let category = job.category;
  const suffix = archiveSuffix(view);
  if (suffix || isArchiveName(job.cleanName)) {
    category = "archive";
  } else {
    const sample = view.subarray(0, Math.min(view.byteLength, 4096));
    const sniffed = classify_log_name_or_content(job.name, sample);
    category = sniffed === "mongo" ? "mongo" : sniffed === "nginx" ? "nginx" : "pm2";
  }

  const finalCategory: "pm2" | "mongo" | "nginx" | "archive" =
    category === "archive"
      ? "archive"
      : category === "mongo"
        ? "mongo"
        : category === "nginx"
          ? "nginx"
          : "pm2";

  // SAFETY: view points to the decompressed output in wasmMemory.
  const standaloneBuf = view.slice().buffer;
  decompressor!.clear();

  const payload: ExtractedEntryResponse = {
    id: job.id,
    name: suffix && !isArchiveName(job.cleanName) ? job.cleanName + suffix : job.cleanName,
    category: finalCategory,
    buffer: standaloneBuf,
    size: standaloneBuf.byteLength,
  };
  self.postMessage({ type: "ENTRY_RESULT", payload }, [standaloneBuf]);
}

async function handleDecompressGz(
  fileBuffer: ArrayBuffer,
  fileName: string,
  id?: number,
): Promise<void> {
  const t0 = performance.now();
  await ensureWasm();

  const gzBytes = new Uint8Array(fileBuffer);
  let ptr = decompressor!.decompress_gzip(gzBytes);
  let len = decompressor!.output_len();
  // SAFETY: Single C++ native slice into transferable ArrayBuffer
  let standaloneBuf = wasmMemory!.buffer.slice(ptr, ptr + len);
  decompressor!.clear();

  let cleanName = fileName.replace(/\.gz$/i, "");
  let view = new Uint8Array(standaloneBuf);
  if (view[0] === 0x1f && view[1] === 0x8b) {
    const nestedGzip = view.slice();
    ptr = decompressor!.decompress_gzip(nestedGzip);
    len = decompressor!.output_len();
    standaloneBuf = wasmMemory!.buffer.slice(ptr, ptr + len);
    decompressor!.clear();
    view = new Uint8Array(standaloneBuf);
    if (!cleanName.toLowerCase().endsWith(".gz")) cleanName += ".gz";
  }
  const suffix = archiveSuffix(view);
  if (suffix && !isArchiveName(cleanName)) cleanName += suffix;
  const cat =
    suffix || isArchiveName(cleanName)
      ? "archive"
      : classify_log_name_or_content(cleanName, view.subarray(0, Math.min(view.byteLength, 4096)));

  const durationMs = Math.round(performance.now() - t0);
  const finalCategory: "pm2" | "mongo" | "nginx" | "archive" =
    cat === "archive" ? "archive" : cat === "mongo" ? "mongo" : cat === "nginx" ? "nginx" : "pm2";
  const result: ExtractedArchiveResult = {
    id,
    fileName,
    files: [
      {
        name: cleanName,
        category: finalCategory,
        buffer: standaloneBuf,
        size: standaloneBuf.byteLength,
      },
    ],
    skipped: [],
    totalBytes: standaloneBuf.byteLength,
    durationMs,
  };

  self.postMessage({ type: "RESULT", payload: result } satisfies ZipWorkerResponse, [
    standaloneBuf,
  ]);
}

/** Decoded bytes per streamed chunk and per Wasm output window. */
const OUTPUT_WINDOW = 8 * 1024 * 1024;
const INPUT_WINDOW = 2 * 1024 * 1024;

function compressedBytes(job: StreamDecodeJob, buffer: ArrayBuffer): Uint8Array {
  if (!job.zipLocalHeader) return new Uint8Array(buffer);
  if (buffer.byteLength < 30) throw new Error(`Truncated ZIP entry: ${job.name}`);
  const view = new DataView(buffer);
  const dataStart = 30 + view.getUint16(26, true) + view.getUint16(28, true);
  const end = Math.min(buffer.byteLength, dataStart + job.compressedSize);
  return new Uint8Array(buffer, dataStart, end - dataStart);
}

/** Calls `onWindow` with each decoded window; the view is only valid during the call. */
function decodeWindows(
  job: StreamDecodeJob,
  input: Uint8Array,
  onWindow: (view: Uint8Array) => void,
): void {
  if (job.format === "stored") {
    for (let offset = 0; offset < input.length; offset += OUTPUT_WINDOW) {
      onWindow(input.subarray(offset, Math.min(input.length, offset + OUTPUT_WINDOW)));
    }
    return;
  }
  const stream = new InflateStream(job.format === "gzip", OUTPUT_WINDOW);
  try {
    let inputOffset = 0;
    for (;;) {
      const status = stream.pump();
      if (status === 0) {
        if (inputOffset >= input.length) throw new Error(`Truncated compressed data: ${job.name}`);
        const take = Math.min(INPUT_WINDOW, input.length - inputOffset);
        const pointer = stream.input_ptr(take);
        new Uint8Array(wasmMemory!.buffer, pointer, take).set(
          input.subarray(inputOffset, inputOffset + take),
        );
        inputOffset += take;
        continue;
      }
      const length = stream.output_len();
      if (length > 0) onWindow(new Uint8Array(wasmMemory!.buffer, stream.output_ptr(), length));
      stream.reset_output();
      if (status === 2) return;
    }
  } finally {
    stream.free();
  }
}

type DecodeState = {
  /** Chosen from the first decoded window: streamed chunks or one whole buffer. */
  mode: "stream" | "whole" | undefined;
  category: ExtractedEntryResponse["category"];
};

async function handleStreamDecode(job: StreamDecodeJob): Promise<void> {
  await ensureWasm();
  const source = job.source instanceof ArrayBuffer ? job.source : await job.source.arrayBuffer();
  const input = compressedBytes(job, source);

  // Mutated inside the window callback, so kept in an object TypeScript does not narrow.
  const out: DecodeState = { mode: undefined, category: "pm2" };
  let name = job.cleanName;
  let whole = new Uint8Array(0);
  let written = 0;

  decodeWindows(job, input, (view) => {
    if (out.mode === undefined) {
      const suffix = archiveSuffix(view);
      if (suffix || isArchiveName(job.cleanName)) {
        out.category = "archive";
        if (suffix && !isArchiveName(job.cleanName)) name = job.cleanName + suffix;
      } else {
        const sniffed = classify_log_name_or_content(
          job.format === "gzip" ? job.cleanName : job.name,
          view.subarray(0, Math.min(view.byteLength, 4096)),
        );
        out.category = sniffed === "mongo" ? "mongo" : sniffed === "nginx" ? "nginx" : "pm2";
      }
      const category = out.category;
      out.mode = job.stream && (category === "pm2" || category === "mongo") ? "stream" : "whole";
      if (job.stream && (category === "pm2" || category === "mongo")) {
        self.postMessage({
          type: "ENTRY_BEGIN",
          payload: { id: job.id, name, category, size: job.expectedSize },
        });
      } else {
        whole = new Uint8Array(job.expectedSize);
      }
    }
    if (out.mode === "stream") {
      const buffer = view.slice().buffer;
      self.postMessage({ type: "ENTRY_CHUNK", payload: { id: job.id, offset: written, buffer } }, [
        buffer,
      ]);
    } else {
      if (written + view.byteLength > whole.byteLength) {
        // The gzip trailer size is modulo 2^32 and may be wrong; grow geometrically.
        const grown = new Uint8Array(Math.max(written + view.byteLength, whole.byteLength * 2));
        grown.set(whole.subarray(0, written));
        whole = grown;
      }
      whole.set(view, written);
    }
    written += view.byteLength;
  });

  if (job.format !== "gzip" && written !== job.expectedSize) {
    throw new Error(`Decoded size mismatch for ${job.name}`);
  }
  if (out.mode === "stream") {
    self.postMessage({ type: "ENTRY_END", payload: { id: job.id, size: written } });
    return;
  }
  const buffer = written === whole.byteLength ? whole.buffer : whole.buffer.slice(0, written);
  self.postMessage(
    {
      type: "ENTRY_RESULT",
      payload: { id: job.id, name, category: out.category, buffer, size: written },
    },
    [buffer],
  );
}

self.onmessage = async (e: MessageEvent<ZipWorkerMessage>) => {
  const msg = e.data;
  try {
    if (msg.type === "STREAM_DECODE") {
      await handleStreamDecode(msg.payload);
    } else if (msg.type === "EXTRACT_ENTRY") {
      await handleExtractEntry(msg.payload);
    } else if (msg.type === "DECOMPRESS_GZ") {
      await handleDecompressGz(msg.payload.fileBuffer, msg.payload.fileName, msg.payload.id);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const id = "id" in msg.payload ? msg.payload.id : undefined;
    self.postMessage({
      type: "ERROR",
      payload: { message, id },
    } satisfies ZipWorkerResponse);
  }
};
