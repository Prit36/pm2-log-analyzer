import { compileZipCoreModule } from "../wasm/loadZipCore";
import init, {
  classify_log_name_or_content,
  decompress_gz_bytes,
  ZipExtractor,
} from "../wasm/pkg_zip/zip_core.js";

export type ZipEntryMeta = {
  index: number;
  name: string;
  clean_name: string;
  uncompressed_size: number;
  compressed_size: number;
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

export type ZipWorkerMessage =
  | { type: "EXTRACT_ZIP"; payload: { fileBuffer: ArrayBuffer; fileName: string } }
  | { type: "DECOMPRESS_GZ"; payload: { fileBuffer: ArrayBuffer; fileName: string } };

export type ZipWorkerResponse =
  | { type: "PROGRESS"; payload: { stage: string; percent: number } }
  | { type: "RESULT"; payload: ExtractedArchiveResult }
  | { type: "ERROR"; payload: { message: string } };

interface WorkerGlobal {
  postMessage(message: ZipWorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<ZipWorkerMessage>) => Promise<void> | void) | null;
}
declare const self: WorkerGlobal;

let isReady = false;

async function ensureWasm(): Promise<void> {
  if (isReady) return;
  const module = await compileZipCoreModule();
  await init({ module_or_path: module });
  isReady = true;
}

function copyToStandaloneBuffer(u8: Uint8Array): ArrayBuffer {
  // SAFETY: Copying ensures the buffer is independent of Wasm memory and transferable
  const copy = new Uint8Array(u8.length);
  copy.set(u8);
  return copy.buffer;
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

      const decompressed = extractor.extract_entry(entry.index);
      let cat = entry.category;

      if (cat === "unknown") {
        const sample = decompressed.subarray(0, Math.min(decompressed.length, 4096));
        const sniffed = extractor.classify_entry_content(sample);
        if (sniffed === "pm2" || sniffed === "mongo") {
          cat = sniffed;
        }
      }

      if (cat === "pm2" || cat === "mongo") {
        const standaloneBuf = copyToStandaloneBuffer(decompressed);
        files.push({
          name: entry.clean_name,
          category: cat,
          buffer: standaloneBuf,
          size: decompressed.length,
        });
        totalBytes += decompressed.length;
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
  const decompressed = decompress_gz_bytes(gzBytes);
  const cleanName = fileName.replace(/\.gz$/i, "");
  const sample = decompressed.subarray(0, Math.min(decompressed.length, 4096));
  const cat = classify_log_name_or_content(cleanName, sample);

  const durationMs = Math.round(performance.now() - t0);
  const standaloneBuf = copyToStandaloneBuffer(decompressed);

  const finalCategory: "pm2" | "mongo" = cat === "mongo" ? "mongo" : "pm2";
  const result: ExtractedArchiveResult = {
    fileName,
    files: [
      {
        name: cleanName,
        category: finalCategory,
        buffer: standaloneBuf,
        size: decompressed.length,
      },
    ],
    skipped: [],
    totalBytes: decompressed.length,
    durationMs,
  };

  self.postMessage({ type: "RESULT", payload: result } satisfies ZipWorkerResponse, [
    standaloneBuf,
  ]);
}

self.onmessage = async (e: MessageEvent<ZipWorkerMessage>) => {
  const msg = e.data;
  try {
    if (msg.type === "EXTRACT_ZIP") {
      await handleExtractZip(msg.payload.fileBuffer, msg.payload.fileName);
    } else if (msg.type === "DECOMPRESS_GZ") {
      await handleDecompressGz(msg.payload.fileBuffer, msg.payload.fileName);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    self.postMessage({ type: "ERROR", payload: { message } } satisfies ZipWorkerResponse);
  }
};
