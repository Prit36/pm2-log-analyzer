import { compileZipCoreModule } from "../wasm/loadZipCore";
import init, { classify_log_name_or_content, FastDecompressor } from "../wasm/pkg_zip/zip_core.js";

export type ExtractedFileItem = {
  name: string;
  category: "pm2" | "mongo";
  buffer: ArrayBuffer;
  size: number;
};

export type ExtractedArchiveResult = {
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
  category: "pm2" | "mongo" | "unknown";
  entryBlob: Blob;
  compressedSize: number;
  uncompressedSize: number;
  isDeflated: boolean;
};

export type ExtractedEntryResponse = {
  id: number;
  name: string;
  category: "pm2" | "mongo";
  buffer: ArrayBuffer;
  size: number;
};

export type ZipWorkerMessage =
  | { type: "EXTRACT_ENTRY"; payload: EntryExtractJob }
  | { type: "DECOMPRESS_GZ"; payload: { fileBuffer: ArrayBuffer; fileName: string } };

export type ZipWorkerResponse =
  | { type: "PROGRESS"; payload: { stage: string; percent: number } }
  | { type: "ENTRY_RESULT"; payload: ExtractedEntryResponse }
  | { type: "RESULT"; payload: ExtractedArchiveResult }
  | { type: "ERROR"; payload: { message: string; id?: number } };

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

  const sliceBuffer = await job.entryBlob.arrayBuffer();

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

  const { view } = decompressToView(compBytes, job.uncompressedSize, job.isDeflated);
  let category = job.category;

  if (category === "unknown") {
    const sample = view.subarray(0, Math.min(view.byteLength, 4096));
    const sniffed = classify_log_name_or_content(job.name, sample);
    if (sniffed === "pm2" || sniffed === "mongo") {
      category = sniffed;
    }
  }

  const finalCategory: "pm2" | "mongo" = category === "mongo" ? "mongo" : "pm2";

  // Zero-copy path for both Mongo and PM2: slice linear memory into a transferable ArrayBuffer
  // SAFETY: view.byteOffset and view.byteLength point to the decompressed output in wasmMemory
  const standaloneBuf = wasmMemory!.buffer.slice(
    view.byteOffset,
    view.byteOffset + view.byteLength,
  );
  decompressor!.clear();

  const payload: ExtractedEntryResponse = {
    id: job.id,
    name: job.cleanName,
    category: finalCategory,
    buffer: standaloneBuf,
    size: standaloneBuf.byteLength,
  };
  self.postMessage({ type: "ENTRY_RESULT", payload }, [standaloneBuf]);
}

async function handleDecompressGz(fileBuffer: ArrayBuffer, fileName: string): Promise<void> {
  const t0 = performance.now();
  await ensureWasm();

  const gzBytes = new Uint8Array(fileBuffer);
  const ptr = decompressor!.decompress_gzip(gzBytes);
  const len = decompressor!.output_len();
  // SAFETY: Single C++ native slice into transferable ArrayBuffer
  const standaloneBuf = wasmMemory!.buffer.slice(ptr, ptr + len);
  decompressor!.clear();

  const cleanName = fileName.replace(/\.gz$/i, "");
  const sample = new Uint8Array(standaloneBuf, 0, Math.min(standaloneBuf.byteLength, 4096));
  const cat = classify_log_name_or_content(cleanName, sample);

  const durationMs = Math.round(performance.now() - t0);
  const finalCategory: "pm2" | "mongo" = cat === "mongo" ? "mongo" : "pm2";
  const result: ExtractedArchiveResult = {
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

self.onmessage = async (e: MessageEvent<ZipWorkerMessage>) => {
  const msg = e.data;
  try {
    if (msg.type === "EXTRACT_ENTRY") {
      await handleExtractEntry(msg.payload);
    } else if (msg.type === "DECOMPRESS_GZ") {
      await handleDecompressGz(msg.payload.fileBuffer, msg.payload.fileName);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (msg.type === "EXTRACT_ENTRY") {
      self.postMessage({
        type: "ERROR",
        payload: { message, id: msg.payload.id },
      } satisfies ZipWorkerResponse);
    } else {
      self.postMessage({
        type: "ERROR",
        payload: { message },
      } satisfies ZipWorkerResponse);
    }
  }
};
