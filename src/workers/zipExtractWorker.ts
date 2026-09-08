import { compileZipCoreModule } from "../wasm/loadZipCore";
import init, {
  classify_log_name_or_content,
  FastDecompressor,
  ZipExtractor,
} from "../wasm/pkg_zip/zip_core.js";

export type ZipEntryMeta = {
  index: number;
  name: string;
  clean_name: string;
  uncompressed_size: number;
  compressed_size: number;
  data_start: number;
  is_deflated: boolean;
  is_dir: boolean;
  category: "pm2" | "mongo" | "unknown" | "skip";
};

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
  compressedBuffer: ArrayBuffer;
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
  | { type: "EXTRACT_ZIP"; payload: { fileBuffer: ArrayBuffer; fileName: string } }
  | { type: "EXTRACT_ENTRY"; payload: EntryExtractJob }
  | { type: "DECOMPRESS_GZ"; payload: { fileBuffer: ArrayBuffer; fileName: string } };

export type ZipWorkerResponse =
  | { type: "PROGRESS"; payload: { stage: string; percent: number } }
  | { type: "ENTRY_RESULT"; payload: ExtractedEntryResponse }
  | { type: "RESULT"; payload: ExtractedArchiveResult }
  | { type: "ERROR"; payload: { message: string; id?: number } };

interface WorkerGlobal {
  postMessage(message: ZipWorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<ZipWorkerMessage>) => Promise<void> | void) | null;
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

function decompressSliceToBuffer(
  compBytes: Uint8Array,
  uncompressedSize: number,
  isDeflated: boolean,
): ArrayBuffer {
  if (!isDeflated || uncompressedSize === 0) {
    const copy = new Uint8Array(compBytes.byteLength);
    copy.set(compBytes);
    return copy.buffer;
  }
  const ptr = decompressor!.decompress_deflate(compBytes, uncompressedSize);
  const len = decompressor!.output_len();
  // SAFETY: Native C++ slice from Wasm linear memory into transferable ArrayBuffer
  const buf = wasmMemory!.buffer.slice(ptr, ptr + len);
  decompressor!.clear();
  return buf;
}

async function handleExtractEntry(job: EntryExtractJob): Promise<void> {
  await ensureWasm();
  const compBytes = new Uint8Array(job.compressedBuffer);
  const buffer = decompressSliceToBuffer(compBytes, job.uncompressedSize, job.isDeflated);
  let category = job.category;

  if (category === "unknown") {
    const sample = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 4096));
    const sniffed = classify_log_name_or_content(job.name, sample);
    if (sniffed === "pm2" || sniffed === "mongo") {
      category = sniffed;
    }
  }

  const payload: ExtractedEntryResponse = {
    id: job.id,
    name: job.cleanName,
    category: category === "mongo" ? "mongo" : "pm2",
    buffer,
    size: buffer.byteLength,
  };

  self.postMessage({ type: "ENTRY_RESULT", payload }, [buffer]);
}

async function handleExtractZip(fileBuffer: ArrayBuffer, fileName: string): Promise<void> {
  const t0 = performance.now();
  await ensureWasm();

  const zipBytes = new Uint8Array(fileBuffer);
  let extractor: ZipExtractor | null = null;

  try {
    extractor = new ZipExtractor(zipBytes);
    // SAFETY: inspect returns an array of ZipEntryMeta objects serialized from Rust
    const entries = extractor.inspect() as ZipEntryMeta[];
    const totalEntries = entries.length;

    const files: ExtractedFileItem[] = [];
    const skipped: string[] = [];
    let totalBytes = 0;

    for (let i = 0; i < totalEntries; i++) {
      const entry = entries[i];
      if (!entry || entry.is_dir) continue;

      const stageMsg = `Extracting ${entry.clean_name}`;
      const percent = Math.round(((i + 1) / totalEntries) * 100);
      self.postMessage({
        type: "PROGRESS",
        payload: { stage: stageMsg, percent },
      } satisfies ZipWorkerResponse);

      // Skip error logs (no timing metrics), system files, and empty entries
      if (
        entry.category === "skip" ||
        entry.name.startsWith("__MACOSX") ||
        entry.name.endsWith(".DS_Store") ||
        entry.uncompressed_size === 0
      ) {
        skipped.push(entry.name);
        continue;
      }

      let decompressedBuffer: ArrayBuffer;
      if (
        entry.is_deflated &&
        entry.uncompressed_size > 0 &&
        entry.data_start + entry.compressed_size <= zipBytes.byteLength
      ) {
        const compSlice = zipBytes.subarray(
          entry.data_start,
          entry.data_start + entry.compressed_size,
        );
        decompressedBuffer = decompressSliceToBuffer(
          compSlice,
          entry.uncompressed_size,
          entry.is_deflated,
        );
      } else {
        const u8 = extractor.extract_entry(entry.index);
        const copy = new Uint8Array(u8.length);
        copy.set(u8);
        decompressedBuffer = copy.buffer;
      }

      let cat = entry.category;
      if (cat === "unknown") {
        const sample = new Uint8Array(
          decompressedBuffer,
          0,
          Math.min(decompressedBuffer.byteLength, 4096),
        );
        const sniffed = classify_log_name_or_content(entry.clean_name, sample);
        if (sniffed === "pm2" || sniffed === "mongo") {
          cat = sniffed;
        }
      }

      if (cat === "pm2" || cat === "mongo") {
        files.push({
          name: entry.clean_name,
          category: cat,
          buffer: decompressedBuffer,
          size: decompressedBuffer.byteLength,
        });
        totalBytes += decompressedBuffer.byteLength;
      } else {
        skipped.push(entry.name);
      }
    }

    const durationMs = Math.round(performance.now() - t0);
    const result: ExtractedArchiveResult = {
      fileName,
      files,
      skipped,
      totalBytes,
      durationMs,
    };

    const transferList = files.map((f) => f.buffer);
    self.postMessage({ type: "RESULT", payload: result } satisfies ZipWorkerResponse, transferList);
  } finally {
    extractor?.free();
  }
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
    } else if (msg.type === "EXTRACT_ZIP") {
      await handleExtractZip(msg.payload.fileBuffer, msg.payload.fileName);
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

