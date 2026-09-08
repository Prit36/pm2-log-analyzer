import ZipWorkerCtor from "../workers/zipExtractWorker.ts?worker&inline";
import type {
  ExtractedArchiveResult,
  ZipWorkerMessage,
  ZipWorkerResponse,
} from "../workers/zipExtractWorker";
import { useAnalysisStore } from "../store/analysisStore";
import { useMongoStore } from "../store/mongoStore";
import { useAppModeStore } from "../store/appModeStore";
import { parseFiles } from "../hooks/useParserWorker";
import { parseMongoFiles } from "../hooks/useMongoParserWorker";

const {
  appendLoadedFiles: appendPm2Files,
  setLoadedFiles: setPm2Files,
  setProgress: setPm2Progress,
  setParsing: setPm2Parsing,
  showToast: showPm2Toast,
} = useAnalysisStore.getState();

const {
  appendLoadedFiles: appendMongoFiles,
  setLoadedFiles: setMongoFiles,
  setProgress: setMongoProgress,
  setParsing: setMongoParsing,
} = useMongoStore.getState();

const { setMode } = useAppModeStore.getState();

export type ExtractedLogSet = {
  pm2Files: File[];
  mongoFiles: File[];
  skipped: string[];
  totalBytes: number;
  durationMs: number;
};

export type ZipBench = {
  at: string;
  fileName: string;
  zipBytes: number;
  totalDecompressedBytes: number;
  totalFiles: number;
  pm2FilesCount: number;
  mongoFilesCount: number;
  skippedFilesCount: number;
  extractWallMs: number;
  uploadToReadyMs?: number;
};

declare global {
  interface Window {
    __ZIP_BENCH__?: ZipBench;
  }
}

const POOL_CAP = Math.min(
  navigator.hardwareConcurrency ? Math.max(2, navigator.hardwareConcurrency) : 2,
  4,
);
const workerPool: Worker[] = [];

function getWorker(index: number): Worker {
  while (workerPool.length <= index) {
    workerPool.push(new ZipWorkerCtor());
  }
  return workerPool[index]!;
}

// Prewarm extraction workers eagerly at module load
for (let i = 0; i < POOL_CAP; i++) {
  getWorker(i);
}

export function isArchiveFile(file: File): boolean {
  return (
    file.name.endsWith(".zip") ||
    file.name.endsWith(".gz") ||
    file.type === "application/zip" ||
    file.type === "application/x-zip-compressed" ||
    file.type === "application/gzip" ||
    file.type === "application/x-gzip"
  );
}

interface ZipCentralEntry {
  name: string;
  cleanName: string;
  dataStart: number;
  compressedSize: number;
  uncompressedSize: number;
  isDeflated: boolean;
  isDir: boolean;
  category: "pm2" | "mongo" | "unknown" | "skip";
}

function stripPathAndGz(name: string): string {
  const norm = name.replace(/\\/g, "/");
  const fileName = norm.split("/").pop() || norm;
  return fileName.replace(/\.gz$/i, "");
}

function classifyByName(name: string): "pm2" | "mongo" | "unknown" | "skip" {
  const lower = name.toLowerCase().replace(/\\/g, "/");
  const fileName = lower.split("/").pop() || lower;

  if (fileName.startsWith(".") || fileName.startsWith("__macosx") || fileName.includes("error")) {
    return "skip";
  }
  if (
    fileName.startsWith("mongod") ||
    fileName.startsWith("mongodb") ||
    fileName.startsWith("mongo.") ||
    fileName.startsWith("mongo-") ||
    fileName.startsWith("mongo_") ||
    fileName.includes("mongod.log") ||
    fileName.includes("mongodb.log")
  ) {
    return "mongo";
  }
  if (
    fileName.includes("api-out") ||
    fileName.includes("api_out") ||
    fileName.startsWith("api.") ||
    fileName.startsWith("api-") ||
    fileName.includes("pm2") ||
    fileName.startsWith("out.log")
  ) {
    return "pm2";
  }
  return "unknown";
}

function parseZipCentralDirectory(buffer: ArrayBuffer): ZipCentralEntry[] | null {
  const bytes = new Uint8Array(buffer);
  const len = bytes.length;
  if (len < 22) return null;

  // Search for EOCD signature (0x06054b50) in last 65KB
  const searchStart = Math.max(0, len - 65557);
  let eocdOffset = -1;
  for (let i = len - 22; i >= searchStart; i--) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x05 &&
      bytes[i + 3] === 0x06
    ) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) return null;

  const view = new DataView(buffer);
  const numEntries = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);
  if (cdOffset >= len) return null;

  const entries: ZipCentralEntry[] = [];
  const textDecoder = new TextDecoder("utf-8");
  let offset = cdOffset;

  for (let i = 0; i < numEntries && offset + 46 <= len; i++) {
    const sig = view.getUint32(offset, true);
    if (sig !== 0x02014b50) break;

    const method = view.getUint16(offset + 10, true);
    const compSize = view.getUint32(offset + 20, true);
    const uncompSize = view.getUint32(offset + 24, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);

    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLen);
    const name = textDecoder.decode(nameBytes);
    const isDir = name.endsWith("/") || uncompSize === 0;

    let dataStart = localHeaderOffset + 30;
    if (localHeaderOffset + 30 <= len) {
      const lhNameLen = view.getUint16(localHeaderOffset + 26, true);
      const lhExtraLen = view.getUint16(localHeaderOffset + 28, true);
      dataStart = localHeaderOffset + 30 + lhNameLen + lhExtraLen;
    }

    if (dataStart + compSize > len) {
      return null;
    }

    entries.push({
      name,
      cleanName: stripPathAndGz(name),
      dataStart,
      compressedSize: compSize,
      uncompressedSize: uncompSize,
      isDeflated: method === 8,
      isDir,
      category: classifyByName(name),
    });

    offset += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

function extractSingleGz(
  file: File,
  fileBuffer: ArrayBuffer,
  onProgress?: (p: { stage: string; percent: number }) => void,
): Promise<ExtractedLogSet> {
  const w = getWorker(0);
  return new Promise<ExtractedLogSet>((resolve, reject) => {
    const handleMessage = (e: MessageEvent<ZipWorkerResponse>) => {
      const res = e.data;
      if (res.type === "PROGRESS") {
        onProgress?.(res.payload);
      } else if (res.type === "RESULT") {
        cleanup();
        // SAFETY: res.type === "RESULT" discriminates ExtractedArchiveResult payload
        const payload = res.payload as ExtractedArchiveResult;
        const pm2Files: File[] = [];
        const mongoFiles: File[] = [];
        for (const item of payload.files) {
          const extractedFile = new File([item.buffer], item.name, {
            type: "text/plain",
            lastModified: file.lastModified,
          });
          if (item.category === "mongo") {
            mongoFiles.push(extractedFile);
          } else {
            pm2Files.push(extractedFile);
          }
        }
        resolve({
          pm2Files,
          mongoFiles,
          skipped: payload.skipped,
          totalBytes: payload.totalBytes,
          durationMs: payload.durationMs,
        });
      } else if (res.type === "ERROR") {
        cleanup();
        reject(new Error(res.payload.message));
      }
    };
    const handleError = (err: ErrorEvent) => {
      cleanup();
      reject(new Error(err.message || "Archive worker error"));
    };
    const cleanup = () => {
      w.removeEventListener("message", handleMessage);
      w.removeEventListener("error", handleError);
    };
    w.addEventListener("message", handleMessage);
    w.addEventListener("error", handleError);
    w.postMessage(
      {
        type: "DECOMPRESS_GZ",
        payload: { fileBuffer, fileName: file.name },
      } satisfies ZipWorkerMessage,
      [fileBuffer],
    );
  });
}

export async function extractArchive(
  file: File,
  onProgress?: (p: { stage: string; percent: number }) => void,
): Promise<ExtractedLogSet> {
  const t0 = performance.now();
  const fileBuffer = await file.arrayBuffer();

  const isGz = file.name.endsWith(".gz");
  if (isGz) {
    return extractSingleGz(file, fileBuffer, onProgress);
  }

  const entries = parseZipCentralDirectory(fileBuffer);
  if (!entries) {
    throw new Error("Invalid or unsupported ZIP archive: central directory not found");
  }

  const skipped: string[] = [];
  const validEntries: (ZipCentralEntry & { category: "pm2" | "mongo" | "unknown" })[] = [];

  for (const e of entries) {
    if (
      e.category === "skip" ||
      e.isDir ||
      e.name.startsWith("__MACOSX") ||
      e.name.endsWith(".DS_Store") ||
      e.uncompressedSize === 0
    ) {
      skipped.push(e.name);
    } else {
      // SAFETY: e.category is guaranteed not to be "skip" by the preceding branch
      validEntries.push(e as ZipCentralEntry & { category: "pm2" | "mongo" | "unknown" });
    }
  }

  if (validEntries.length === 0) {
    const durationMs = Math.round(performance.now() - t0);
    return { pm2Files: [], mongoFiles: [], skipped, totalBytes: 0, durationMs };
  }

  const concurrency = Math.min(
    navigator.hardwareConcurrency ? Math.max(1, navigator.hardwareConcurrency) : 4,
    validEntries.length,
  );

  let completedCount = 0;
  const pm2Files: File[] = [];
  const mongoFiles: File[] = [];
  let totalBytes = 0;

  const tasks = validEntries.map((entry, idx) => {
    const workerIndex = idx % concurrency;
    const worker = getWorker(workerIndex);

    const compressedBuffer = fileBuffer.slice(
      entry.dataStart,
      entry.dataStart + entry.compressedSize,
    );

    return new Promise<void>((resolve, reject) => {
      const handleMessage = (e: MessageEvent<ZipWorkerResponse>) => {
        const res = e.data;
        if (res.type === "ENTRY_RESULT" && res.payload.id === idx) {
          cleanup();
          const item = res.payload;
          const extractedFile = new File([item.buffer], item.name, {
            type: "text/plain",
            lastModified: file.lastModified,
          });

          if (item.category === "mongo") {
            mongoFiles.push(extractedFile);
          } else {
            pm2Files.push(extractedFile);
          }
          totalBytes += item.size;

          completedCount++;
          const percent = Math.round((completedCount / validEntries.length) * 100);
          onProgress?.({ stage: `Extracted ${item.name}`, percent });
          resolve();
        } else if (res.type === "ERROR" && res.payload.id === idx) {
          cleanup();
          reject(new Error(res.payload.message));
        }
      };

      const handleError = (err: ErrorEvent) => {
        cleanup();
        reject(new Error(err.message || "Archive worker error"));
      };

      const cleanup = () => {
        worker.removeEventListener("message", handleMessage);
        worker.removeEventListener("error", handleError);
      };

      worker.addEventListener("message", handleMessage);
      worker.addEventListener("error", handleError);

      worker.postMessage(
        {
          type: "EXTRACT_ENTRY",
          payload: {
            id: idx,
            name: entry.name,
            cleanName: entry.cleanName,
            category: entry.category,
            compressedBuffer,
            uncompressedSize: entry.uncompressedSize,
            isDeflated: entry.isDeflated,
          },
        } satisfies ZipWorkerMessage,
        [compressedBuffer],
      );
    });
  });

  await Promise.all(tasks);

  const durationMs = Math.round(performance.now() - t0);
  return {
    pm2Files,
    mongoFiles,
    skipped,
    totalBytes,
    durationMs,
  };
}

export async function handleArchiveUpload(
  file: File,
  uploadMode: "replace" | "append" = "replace",
): Promise<void> {
  // Set visual progress on active store
  setPm2Parsing(true);
  setPm2Progress({ stage: "reading", processed: 10, total: 100, percent: 10 });
  setMongoParsing(true);
  setMongoProgress({ stage: "reading", processed: 10, total: 100, percent: 10 });

  try {
    const logSet = await extractArchive(file, (p) => {
      setPm2Progress({ stage: "reading", processed: p.percent, total: 100, percent: p.percent });
      setMongoProgress({ stage: "reading", processed: p.percent, total: 100, percent: p.percent });
    });

    const hasPm2 = logSet.pm2Files.length > 0;
    const hasMongo = logSet.mongoFiles.length > 0;

    window.__ZIP_BENCH__ = {
      at: new Date().toISOString(),
      fileName: file.name,
      zipBytes: file.size,
      totalDecompressedBytes: logSet.totalBytes,
      totalFiles: logSet.pm2Files.length + logSet.mongoFiles.length,
      pm2FilesCount: logSet.pm2Files.length,
      mongoFilesCount: logSet.mongoFiles.length,
      skippedFilesCount: logSet.skipped.length,
      extractWallMs: logSet.durationMs,
    };

    if (!hasPm2 && !hasMongo) {
      setPm2Parsing(false);
      setMongoParsing(false);
      showPm2Toast(`No valid API or MongoDB logs found in ${file.name}`);
      return;
    }

    // Ingest PM2 files if present
    if (hasPm2) {
      if (uploadMode === "append") {
        const combined = appendPm2Files(logSet.pm2Files);
        void parseFiles(combined);
      } else {
        const unique = setPm2Files(logSet.pm2Files);
        void parseFiles(unique);
      }
    } else {
      setPm2Parsing(false);
    }

    // Ingest Mongo files if present
    if (hasMongo) {
      if (uploadMode === "append") {
        const combined = appendMongoFiles(logSet.mongoFiles);
        void parseMongoFiles(combined);
      } else {
        const unique = setMongoFiles(logSet.mongoFiles);
        void parseMongoFiles(unique);
      }
    } else {
      setMongoParsing(false);
    }

    // Tab switching and toast notification
    if (hasPm2 && hasMongo) {
      showPm2Toast(
        `Extracted ${logSet.pm2Files.length} API log(s) and ${logSet.mongoFiles.length} MongoDB log(s) in ${logSet.durationMs}ms! Both tabs populated.`,
      );
    } else if (hasMongo) {
      setMode("mongo");
      showPm2Toast(
        `Extracted ${logSet.mongoFiles.length} MongoDB log(s) in ${logSet.durationMs}ms into MongoDB Analyzer`,
      );
    } else {
      setMode("pm2");
      showPm2Toast(
        `Extracted ${logSet.pm2Files.length} API log(s) in ${logSet.durationMs}ms into PM2 Analyzer`,
      );
    }
  } catch (err) {
    setPm2Parsing(false);
    setMongoParsing(false);
    const errMessage = err instanceof Error ? err.message : String(err);
    showPm2Toast(`Extraction failed: ${errMessage}`);
  }
}
