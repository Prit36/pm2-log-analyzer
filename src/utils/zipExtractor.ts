import ZipWorkerCtor from "../workers/zipExtractWorker.ts?worker&inline";
import type {
  ExtractedArchiveResult,
  ZipWorkerMessage,
  ZipWorkerResponse,
} from "../workers/zipExtractWorker";
import { useAnalysisStore } from "../store/analysisStore";
import { useMongoStore } from "../store/mongoStore";
import { useAppModeStore } from "../store/appModeStore";
import { parseFiles, parsePm2Buffer, parsePm2Shards } from "../hooks/useParserWorker";
import type { ShardBufferDescriptor } from "../workers/logParserWorker";
import { parseMongoBuffer, parseMongoFiles } from "../hooks/useMongoParserWorker";

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
  showToast: showMongoToast,
} = useMongoStore.getState();

const { setMode } = useAppModeStore.getState();

function notify(message: string): void {
  showPm2Toast(message);
  showMongoToast(message);
}

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
const MAX_ARCHIVE_DEPTH = 8;

function getWorker(index: number): Worker {
  while (workerPool.length <= index) {
    workerPool.push(new ZipWorkerCtor());
  }
  return workerPool[index]!;
}

// Prewarm extraction workers eagerly at module load (capped to 2 to minimize idle RSS)
for (let i = 0; i < Math.min(POOL_CAP, 2); i++) {
  getWorker(i);
}

export function isArchiveFile(file: File): boolean {
  return (
    /\.(?:zip|gz)$/i.test(file.name) ||
    file.type === "application/zip" ||
    file.type === "application/x-zip-compressed" ||
    file.type === "application/gzip" ||
    file.type === "application/x-gzip"
  );
}

interface ZipCentralEntry {
  name: string;
  cleanName: string;
  localHeaderOffset: number;
  nameLen: number;
  extraLen: number;
  compressedSize: number;
  uncompressedSize: number;
  isDeflated: boolean;
  isDir: boolean;
  category: "pm2" | "mongo" | "unknown" | "skip" | "archive";
}

function stripPath(name: string): string {
  const norm = name.replace(/\\/g, "/");
  return norm.split("/").pop() || norm;
}

function stripPathAndGz(name: string): string {
  return stripPath(name).replace(/\.gz$/i, "");
}

export function filterValidFiles(
  fileList: FileList | File[] | null | undefined,
  allowUnknownFiles = true,
): File[] {
  if (!fileList || fileList.length === 0) return [];
  return Array.from(fileList).filter(
    (f) =>
      isArchiveFile(f) ||
      /\.(?:log(?:\.\d+)?|txt|json|out|err|\d+)$/i.test(f.name) ||
      (allowUnknownFiles && (f.type === "text/plain" || f.type === "")),
  );
}

export function classifyByName(name: string): "pm2" | "mongo" | "unknown" | "skip" {
  const lower = name.toLowerCase().replace(/\\/g, "/");
  const fileName = lower.split("/").pop() || lower;

  if (fileName.startsWith(".") || fileName.startsWith("__macosx") || fileName.includes("error")) {
    return "skip";
  }
  if (/(?:^|[._-])mongo(?:[._-]|\d|$)|mongod/i.test(fileName)) {
    return "mongo";
  }
  if (/(?:^|[._-])(?:api[._-]out|pm2)|out\.log/i.test(fileName) || /^api[.-]/.test(fileName)) {
    return "pm2";
  }
  return "unknown";
}

async function parseZipCentralDirectoryFromFile(file: File): Promise<ZipCentralEntry[] | null> {
  const fileSize = file.size;
  if (fileSize < 22) return null;

  const tailSize = Math.min(fileSize, 65557);
  const tailBuffer = await file.slice(fileSize - tailSize, fileSize).arrayBuffer();
  const tailBytes = new Uint8Array(tailBuffer);

  let eocdOffsetInTail = -1;
  for (let i = tailSize - 22; i >= 0; i--) {
    if (
      tailBytes[i] === 0x50 &&
      tailBytes[i + 1] === 0x4b &&
      tailBytes[i + 2] === 0x05 &&
      tailBytes[i + 3] === 0x06
    ) {
      eocdOffsetInTail = i;
      break;
    }
  }

  if (eocdOffsetInTail < 0) return null;

  const tailView = new DataView(tailBuffer);
  const numEntries = tailView.getUint16(eocdOffsetInTail + 10, true);
  const cdSize = tailView.getUint32(eocdOffsetInTail + 12, true);
  const cdOffset = tailView.getUint32(eocdOffsetInTail + 16, true);

  if (cdOffset + cdSize > fileSize) return null;

  let cdBuffer: ArrayBuffer;
  let cdOffsetInBuffer = 0;
  const tailStartOffset = fileSize - tailSize;

  if (cdOffset >= tailStartOffset) {
    cdBuffer = tailBuffer;
    cdOffsetInBuffer = cdOffset - tailStartOffset;
  } else {
    cdBuffer = await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer();
    cdOffsetInBuffer = 0;
  }

  const cdView = new DataView(cdBuffer);
  const cdBytes = new Uint8Array(cdBuffer);
  const entries: ZipCentralEntry[] = [];
  const textDecoder = new TextDecoder("utf-8");
  let offset = cdOffsetInBuffer;

  for (let i = 0; i < numEntries && offset + 46 <= cdBuffer.byteLength; i++) {
    const sig = cdView.getUint32(offset, true);
    if (sig !== 0x02014b50) break;

    const method = cdView.getUint16(offset + 10, true);
    const compSize = cdView.getUint32(offset + 20, true);
    const uncompSize = cdView.getUint32(offset + 24, true);
    const nameLen = cdView.getUint16(offset + 28, true);
    const extraLen = cdView.getUint16(offset + 30, true);
    const commentLen = cdView.getUint16(offset + 32, true);
    const localHeaderOffset = cdView.getUint32(offset + 42, true);

    const nameBytes = cdBytes.subarray(offset + 46, offset + 46 + nameLen);
    const name = textDecoder.decode(nameBytes);
    const isDir = name.endsWith("/") || uncompSize === 0;

    entries.push({
      name,
      cleanName: stripPathAndGz(name),
      localHeaderOffset,
      nameLen,
      extraLen,
      compressedSize: compSize,
      uncompressedSize: uncompSize,
      isDeflated: method === 8,
      isDir,
      category: /\.zip$/i.test(name) ? "archive" : classifyByName(name),
    });

    offset += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

function extractSingleGz(
  file: File,
  onProgress?: (p: { stage: string; percent: number }) => void,
  depth = 0,
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
        const result: ExtractedLogSet = {
          pm2Files: [],
          mongoFiles: [],
          skipped: payload.skipped,
          totalBytes: payload.totalBytes,
          durationMs: payload.durationMs,
        };
        const nestedArchives: File[] = [];
        for (const item of payload.files) {
          const extractedFile = new File([item.buffer], item.name, {
            type: "text/plain",
            lastModified: file.lastModified,
          });
          if (item.category === "archive") {
            nestedArchives.push(extractedFile);
          } else if (item.category === "mongo") {
            result.mongoFiles.push(extractedFile);
          } else {
            result.pm2Files.push(extractedFile);
          }
        }
        void (async () => {
          for (const nested of nestedArchives) {
            try {
              mergeLogSets(
                result,
                await extractArchive(nested, onProgress ? { onProgress } : undefined, depth + 1),
              );
            } catch {
              result.skipped.push(nested.name);
            }
          }
          resolve(result);
        })().catch(reject);
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
    void file.arrayBuffer().then((fileBuffer) => {
      w.postMessage(
        {
          type: "DECOMPRESS_GZ",
          payload: { fileBuffer, fileName: file.name },
        } satisfies ZipWorkerMessage,
        [fileBuffer],
      );
    });
  });
}

export type Pm2ReadyPayload = {
  files: File[];
  directBuffer?: { buffer: ArrayBuffer; fileName: string; size: number } | undefined;
};

export type MongoReadyPayload = {
  files: File[];
  directBuffer?: { buffer: ArrayBuffer; fileName: string; size: number } | undefined;
};

export type ExtractArchiveCallbacks = {
  onProgress?: (p: { stage: string; percent: number }) => void;
  onPm2Ready?: (payload: Pm2ReadyPayload) => void;
  onMongoReady?: (payload: MongoReadyPayload) => void;
};

function mergeLogSets(target: ExtractedLogSet, source: ExtractedLogSet): void {
  target.pm2Files.push(...source.pm2Files);
  target.mongoFiles.push(...source.mongoFiles);
  target.skipped.push(...source.skipped);
  target.totalBytes += source.totalBytes;
}

export async function extractArchive(
  file: File,
  callbacks?: ExtractArchiveCallbacks,
  depth = 0,
): Promise<ExtractedLogSet> {
  const cbOptions = callbacks ?? {};
  const t0 = performance.now();

  if (depth >= MAX_ARCHIVE_DEPTH) {
    return {
      pm2Files: [],
      mongoFiles: [],
      skipped: [file.name],
      totalBytes: 0,
      durationMs: 0,
    };
  }

  if (/\.gz$/i.test(file.name)) {
    return extractSingleGz(file, cbOptions.onProgress, depth);
  }

  const entries = await parseZipCentralDirectoryFromFile(file);
  if (!entries) {
    throw new Error("Invalid or unsupported ZIP archive: central directory not found");
  }

  const skipped: string[] = [];
  const validEntries: (ZipCentralEntry & { category: "pm2" | "mongo" | "unknown" | "archive" })[] =
    [];

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
      validEntries.push(
        e as ZipCentralEntry & {
          category: "pm2" | "mongo" | "unknown" | "archive";
        },
      );
    }
  }

  if (validEntries.length === 0) {
    const durationMs = Math.round(performance.now() - t0);
    return { pm2Files: [], mongoFiles: [], skipped, totalBytes: 0, durationMs };
  }

  const expectedPm2 = validEntries.filter((e) => e.category === "pm2").length;
  const expectedMongo = validEntries.filter((e) => e.category === "mongo").length;
  const hasUnknown = validEntries.some((e) => e.category === "unknown" || e.category === "archive");
  let pm2Dispatched = false;
  let mongoDispatched = false;

  validEntries.sort((a, b) => b.compressedSize - a.compressedSize);

  const concurrency = Math.min(
    navigator.hardwareConcurrency ? Math.max(1, navigator.hardwareConcurrency) : 4,
    validEntries.length,
  );

  // Terminate any excess prewarmed workers immediately to free memory
  while (workerPool.length > concurrency) {
    const w = workerPool.pop();
    w?.terminate();
  }

  let completedCount = 0;
  const pm2Files: File[] = [];
  const mongoFiles: File[] = [];
  const nestedArchives: File[] = [];
  const canUsePm2DirectBuffer = Boolean(cbOptions.onPm2Ready) && !hasUnknown;
  const canUseMongoDirectBuffer = Boolean(cbOptions.onMongoReady) && !hasUnknown;
  let totalBytes = 0;

  const queue = validEntries.map((entry, idx) => ({ entry, idx }));

  let mongoDirectBuffer: { buffer: ArrayBuffer; fileName: string; size: number } | undefined;
  let pm2DirectBuffer: { buffer: ArrayBuffer; fileName: string; size: number } | undefined;

  const extractSingleEntry = (
    worker: Worker,
    entry: (typeof validEntries)[number],
    jobId: number,
  ): Promise<void> => {
    const sliceEnd = Math.min(
      file.size,
      entry.localHeaderOffset + 30 + entry.nameLen + entry.extraLen + entry.compressedSize + 1024,
    );
    const entryBlob = file.slice(entry.localHeaderOffset, sliceEnd);

    return new Promise<void>((resolve, reject) => {
      const handleMessage = (e: MessageEvent<ZipWorkerResponse>) => {
        const res = e.data;
        if (res.type === "ENTRY_RESULT" && res.payload.id === jobId) {
          cleanup();
          const item = res.payload;

          if (item.category === "archive") {
            nestedArchives.push(new File([item.buffer], item.name));
          } else if (item.category === "mongo") {
            const useDirectBuffer = expectedMongo === 1 && canUseMongoDirectBuffer;
            const extractedFile = useDirectBuffer
              ? new File([], item.name, { type: "text/plain" })
              : new File([item.buffer], item.name, { type: "text/plain" });
            if (useDirectBuffer) {
              Object.defineProperty(extractedFile, "size", { value: item.size });
              mongoDirectBuffer = { buffer: item.buffer, fileName: item.name, size: item.size };
            }
            mongoFiles.push(extractedFile);
          } else {
            const useDirectBuffer = expectedPm2 === 1 && canUsePm2DirectBuffer;
            const extractedFile = useDirectBuffer
              ? new File([], item.name, { type: "text/plain" })
              : new File([item.buffer], item.name, { type: "text/plain" });
            if (useDirectBuffer) {
              Object.defineProperty(extractedFile, "size", { value: item.size });
              pm2DirectBuffer = { buffer: item.buffer, fileName: item.name, size: item.size };
            }
            pm2Files.push(extractedFile);
          }
          totalBytes += item.size;

          completedCount++;
          const percent = Math.round((completedCount / validEntries.length) * 100);
          cbOptions.onProgress?.({ stage: `Extracted ${item.name}`, percent });

          // Eager dispatch when all files of a known category are ready
          if (!hasUnknown) {
            if (!pm2Dispatched && pm2Files.length === expectedPm2 && expectedPm2 > 0) {
              pm2Dispatched = true;
              cbOptions.onPm2Ready?.({
                files: [...pm2Files],
                directBuffer: expectedPm2 === 1 ? pm2DirectBuffer : undefined,
              });
            }
            if (!mongoDispatched && mongoFiles.length === expectedMongo && expectedMongo > 0) {
              mongoDispatched = true;
              cbOptions.onMongoReady?.({
                files: [...mongoFiles],
                directBuffer: expectedMongo === 1 ? mongoDirectBuffer : undefined,
              });
            }
          }
          resolve();
        } else if (res.type === "ERROR" && res.payload.id === jobId) {
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

      worker.postMessage({
        type: "EXTRACT_ENTRY",
        payload: {
          id: jobId,
          name: entry.name,
          cleanName: entry.cleanName,
          category: entry.category,
          entryBlob,
          compressedSize: entry.compressedSize,
          uncompressedSize: entry.uncompressedSize,
          isDeflated: entry.isDeflated,
        },
      } satisfies ZipWorkerMessage);
    });
  };

  const workerTasks = Array.from({ length: concurrency }, async (_, workerIndex) => {
    const worker = getWorker(workerIndex);
    try {
      while (queue.length > 0) {
        const item = queue.shift();
        if (!item) break;
        await extractSingleEntry(worker, item.entry, item.idx);
      }
    } finally {
      // Worker has completed all assigned tasks; terminate immediately to free Wasm memory & thread
      worker.terminate();
    }
  });

  await Promise.all(workerTasks);
  workerPool.length = 0;

  const result: ExtractedLogSet = {
    pm2Files,
    mongoFiles,
    skipped,
    totalBytes,
    durationMs: 0,
  };
  for (const nested of nestedArchives) {
    try {
      mergeLogSets(
        result,
        await extractArchive(
          nested,
          cbOptions.onProgress ? { onProgress: cbOptions.onProgress } : undefined,
          depth + 1,
        ),
      );
    } catch {
      result.skipped.push(nested.name);
    }
  }
  result.durationMs = Math.round(performance.now() - t0);
  return result;
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

  let pm2Started = false;
  let mongoStarted = false;

  const startPm2 = (payload: Pm2ReadyPayload) => {
    if (pm2Started || payload.files.length === 0) return;
    pm2Started = true;
    if (payload.directBuffer && uploadMode === "replace") {
      setPm2Files(payload.files);
      void parsePm2Buffer(
        payload.directBuffer.buffer,
        payload.directBuffer.fileName,
        payload.directBuffer.size,
      );
    } else if (uploadMode === "append") {
      const combined = appendPm2Files(payload.files);
      void parseFiles(combined);
    } else {
      const unique = setPm2Files(payload.files);
      void parseFiles(unique);
    }
  };

  const startMongo = (payload: MongoReadyPayload) => {
    if (mongoStarted || payload.files.length === 0) return;
    mongoStarted = true;
    if (payload.directBuffer && uploadMode === "replace") {
      setMongoFiles(payload.files);
      void parseMongoBuffer(
        payload.directBuffer.buffer,
        payload.directBuffer.fileName,
        payload.directBuffer.size,
      );
    } else if (uploadMode === "append") {
      const combined = appendMongoFiles(payload.files);
      void parseMongoFiles(combined);
    } else {
      const unique = setMongoFiles(payload.files);
      void parseMongoFiles(unique);
    }
  };

  try {
    const logSet = await extractArchive(file, {
      onProgress: (p) => {
        setPm2Progress({ stage: "reading", processed: p.percent, total: 100, percent: p.percent });
        setMongoProgress({
          stage: "reading",
          processed: p.percent,
          total: 100,
          percent: p.percent,
        });
      },
      onPm2Ready: startPm2,
      onMongoReady: startMongo,
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

    // In case eager dispatch didn't trigger (e.g. unknown categories)
    if (hasPm2 && !pm2Started) {
      startPm2({ files: logSet.pm2Files });
    } else if (!hasPm2) {
      setPm2Parsing(false);
    }

    if (hasMongo && !mongoStarted) {
      startMongo({ files: logSet.mongoFiles });
    } else if (!hasMongo) {
      setMongoParsing(false);
    }

    // Tab switching and toast notification
    if (hasPm2 && hasMongo) {
      notify(
        `Extracted ${logSet.pm2Files.length} API log(s) and ${logSet.mongoFiles.length} MongoDB log(s) in ${logSet.durationMs}ms! Both tabs populated.`,
      );
    } else if (hasMongo) {
      setMode("mongo");
      notify(
        `Extracted ${logSet.mongoFiles.length} MongoDB log(s) in ${logSet.durationMs}ms into MongoDB Analyzer`,
      );
    } else {
      setMode("pm2");
      notify(
        `Extracted ${logSet.pm2Files.length} API log(s) in ${logSet.durationMs}ms into PM2 Analyzer`,
      );
    }
  } catch (err) {
    setPm2Parsing(false);
    setMongoParsing(false);
    const errMessage = err instanceof Error ? err.message : String(err);
    notify(`Extraction failed: ${errMessage}`);
  }
}

function createTextFile(
  content: BlobPart[],
  name: string,
  lastModified?: number | undefined,
): File {
  const options: FilePropertyBag = { type: "text/plain" };
  if (lastModified !== undefined) {
    options.lastModified = lastModified;
  }
  return new File(content, name, options);
}

interface ExtractedBatchItem {
  name: string;
  category: "pm2" | "mongo" | "archive" | "skip" | "unknown";
  buffer: ArrayBuffer;
  size: number;
  archiveIndex: number;
  entryIndex: number;
  lastModified?: number | undefined;
}

interface BatchExtractTask {
  id: number;
  kind: "zip_entry" | "gz_file" | "gz_buffer";
  file?: File | undefined;
  buffer?: ArrayBuffer | undefined;
  entry?: ZipCentralEntry | undefined;
  name: string;
  cleanName: string;
  category: "pm2" | "mongo" | "archive" | "skip" | "unknown";
  compressedSize: number;
  uncompressedSize: number;
  isDeflated?: boolean | undefined;
  archiveIndex: number;
  entryIndex: number;
  lastModified?: number | undefined;
}

export async function handleLogFilesUpload(
  files: File[],
  uploadMode: "replace" | "append" = "replace",
): Promise<void> {
  const archives = files.filter(isArchiveFile);
  if (archives.length === 1 && files.length === 1) {
    return handleArchiveUpload(archives[0]!, uploadMode);
  }

  const rawFiles = files.filter((f) => !isArchiveFile(f));
  const activeMode = useAppModeStore.getState().mode;

  if (archives.length === 0) {
    const pm2Files: File[] = [];
    const mongoFiles: File[] = [];
    for (const file of rawFiles) {
      const cat = classifyByName(file.name);
      if (cat === "mongo") {
        mongoFiles.push(file);
      } else if (cat === "pm2") {
        pm2Files.push(file);
      } else if (cat === "unknown") {
        if (activeMode === "mongo") mongoFiles.push(file);
        else pm2Files.push(file);
      }
    }

    if (pm2Files.length > 0) {
      const result = uploadMode === "append" ? appendPm2Files(pm2Files) : setPm2Files(pm2Files);
      if (result.length > 0) void parseFiles(result);
    }
    if (mongoFiles.length > 0) {
      const result =
        uploadMode === "append" ? appendMongoFiles(mongoFiles) : setMongoFiles(mongoFiles);
      if (result.length > 0) void parseMongoFiles(result);
    }
    return;
  }

  setPm2Parsing(true);
  setMongoParsing(true);
  setPm2Progress({ stage: "reading", processed: 0, total: 100, percent: 0 });
  setMongoProgress({ stage: "reading", processed: 0, total: 100, percent: 0 });

  let nextTaskId = 0;
  const initialTasks: BatchExtractTask[] = [];
  const failedArchives: string[] = [];
  const skipped: string[] = [];

  // Parse central directories across all archives in parallel (< 3ms total)
  await Promise.all(
    archives.map(async (archiveFile, archiveIndex) => {
      if (/\.gz$/i.test(archiveFile.name)) {
        const clean = stripPathAndGz(archiveFile.name);
        const cat = classifyByName(clean);
        initialTasks.push({
          id: ++nextTaskId,
          kind: "gz_file",
          file: archiveFile,
          name: archiveFile.name,
          cleanName: clean,
          category: cat === "skip" ? "skip" : cat === "mongo" ? "mongo" : "pm2",
          compressedSize: archiveFile.size,
          uncompressedSize: archiveFile.size * 3,
          archiveIndex,
          entryIndex: 0,
          lastModified: archiveFile.lastModified,
        });
        return;
      }

      try {
        const entries = await parseZipCentralDirectoryFromFile(archiveFile);
        if (!entries) {
          failedArchives.push(archiveFile.name);
          return;
        }
        for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
          const entry = entries[entryIndex]!;
          if (
            entry.isDir ||
            entry.uncompressedSize === 0 ||
            entry.category === "skip" ||
            entry.name.startsWith("__MACOSX") ||
            entry.name.endsWith(".DS_Store")
          ) {
            skipped.push(entry.name);
          } else {
            initialTasks.push({
              id: ++nextTaskId,
              kind: "zip_entry",
              file: archiveFile,
              entry,
              name: entry.name,
              cleanName: entry.cleanName,
              category: entry.category,
              compressedSize: entry.compressedSize,
              uncompressedSize: entry.uncompressedSize,
              isDeflated: entry.isDeflated,
              archiveIndex,
              entryIndex,
              lastModified: archiveFile.lastModified,
            });
          }
        }
      } catch {
        failedArchives.push(archiveFile.name);
      }
    }),
  );

  const rawPm2Items: ExtractedBatchItem[] = [];
  const rawMongoItems: ExtractedBatchItem[] = [];
  await Promise.all(
    rawFiles.map(async (rawFile, rawIndex) => {
      const cat = classifyByName(rawFile.name);
      const targetCat =
        cat === "mongo"
          ? "mongo"
          : cat === "pm2"
            ? "pm2"
            : activeMode === "mongo"
              ? "mongo"
              : "pm2";
      const buffer = await rawFile.arrayBuffer();
      const item: ExtractedBatchItem = {
        name: rawFile.name,
        category: targetCat,
        buffer,
        size: rawFile.size,
        archiveIndex: -1,
        entryIndex: rawIndex,
        lastModified: rawFile.lastModified,
      };
      if (targetCat === "mongo") rawMongoItems.push(item);
      else rawPm2Items.push(item);
    }),
  );

  // Sort tasks descending by compressed size (Longest Processing Time first)
  initialTasks.sort((a, b) => b.compressedSize - a.compressedSize);

  const concurrency = Math.min(POOL_CAP, Math.max(1, initialTasks.length));
  for (let i = 0; i < concurrency; i++) {
    getWorker(i);
  }
  while (workerPool.length > concurrency) {
    workerPool.pop()?.terminate();
  }

  const queue: BatchExtractTask[] = [...initialTasks];
  let totalDispatched = queue.length;
  let completedCount = 0;
  const runningTasks = new Map<number, BatchExtractTask>();

  const pm2Results: ExtractedBatchItem[] = [...rawPm2Items];
  const mongoResults: ExtractedBatchItem[] = [...rawMongoItems];
  let mongoDispatched = false;

  const checkEagerMongo = () => {
    if (mongoDispatched || uploadMode !== "replace") return;
    if (mongoResults.length === 0) return;

    const hasPendingMongo =
      queue.some(
        (t) =>
          t.category === "mongo" ||
          t.category === "unknown" ||
          (t.category === "archive" && /(?:mongo|archive)/i.test(t.name)),
      ) ||
      Array.from(runningTasks.values()).some(
        (t) =>
          t.category === "mongo" ||
          t.category === "unknown" ||
          (t.category === "archive" && /(?:mongo|archive)/i.test(t.name)),
      );

    if (!hasPendingMongo && mongoResults.length === 1) {
      mongoDispatched = true;
      const mongoItem = mongoResults[0]!;
      const dummyFile = createTextFile([], mongoItem.name, mongoItem.lastModified);
      Object.defineProperty(dummyFile, "size", { value: mongoItem.size });
      setMongoFiles([dummyFile]);
      void parseMongoBuffer(mongoItem.buffer, mongoItem.name, mongoItem.size);
    }
  };

  const handleExtractedResult = async (item: ExtractedBatchItem): Promise<void> => {
    if (item.category === "archive") {
      if (/\.gz$/i.test(item.name)) {
        const clean = stripPathAndGz(item.name);
        const cat = classifyByName(clean);
        queue.push({
          id: ++nextTaskId,
          kind: "gz_buffer",
          buffer: item.buffer,
          name: item.name,
          cleanName: clean,
          category: cat === "skip" ? "skip" : cat === "mongo" ? "mongo" : "pm2",
          compressedSize: item.size,
          uncompressedSize: item.size * 3,
          archiveIndex: item.archiveIndex,
          entryIndex: item.entryIndex,
          lastModified: item.lastModified,
        });
        totalDispatched++;
        return;
      }

      if (/\.zip$/i.test(item.name)) {
        try {
          const nestedFile = new File([item.buffer], item.name);
          const entries = await parseZipCentralDirectoryFromFile(nestedFile);
          if (entries) {
            for (let idx = 0; idx < entries.length; idx++) {
              const entry = entries[idx]!;
              if (
                entry.isDir ||
                entry.uncompressedSize === 0 ||
                entry.category === "skip" ||
                entry.name.startsWith("__MACOSX") ||
                entry.name.endsWith(".DS_Store")
              ) {
                skipped.push(entry.name);
              } else {
                queue.push({
                  id: ++nextTaskId,
                  kind: "zip_entry",
                  file: nestedFile,
                  entry,
                  name: entry.name,
                  cleanName: entry.cleanName,
                  category: entry.category,
                  compressedSize: entry.compressedSize,
                  uncompressedSize: entry.uncompressedSize,
                  isDeflated: entry.isDeflated,
                  archiveIndex: item.archiveIndex,
                  entryIndex: item.entryIndex + (idx + 1) * 0.01,
                  lastModified: item.lastModified,
                });
                totalDispatched++;
              }
            }
            return;
          }
        } catch {
          skipped.push(item.name);
          return;
        }
      }
    }

    if (item.category === "mongo") {
      mongoResults.push(item);
      checkEagerMongo();
    } else if (item.category === "pm2" || item.category === "unknown") {
      pm2Results.push(item);
    } else {
      skipped.push(item.name);
    }
  };

  const executeTask = (worker: Worker, task: BatchExtractTask): Promise<void> => {
    runningTasks.set(task.id, task);

    return new Promise<void>((resolve) => {
      const handleMessage = async (e: MessageEvent<ZipWorkerResponse>) => {
        const res = e.data;
        if (res.type === "ENTRY_RESULT" && res.payload.id === task.id) {
          cleanup();
          runningTasks.delete(task.id);
          const p = res.payload;
          await handleExtractedResult({
            name: p.name,
            category: p.category,
            buffer: p.buffer,
            size: p.size,
            archiveIndex: task.archiveIndex,
            entryIndex: task.entryIndex,
            lastModified: task.lastModified,
          });
          resolve();
        } else if (res.type === "RESULT" && res.payload.id === task.id) {
          cleanup();
          runningTasks.delete(task.id);
          const p = res.payload;
          for (const f of p.files) {
            await handleExtractedResult({
              name: f.name,
              category: f.category,
              buffer: f.buffer,
              size: f.size,
              archiveIndex: task.archiveIndex,
              entryIndex: task.entryIndex,
              lastModified: task.lastModified,
            });
          }
          resolve();
        } else if (res.type === "ERROR" && res.payload.id === task.id) {
          cleanup();
          runningTasks.delete(task.id);
          skipped.push(task.name);
          resolve();
        }
      };

      const handleError = () => {
        cleanup();
        runningTasks.delete(task.id);
        skipped.push(task.name);
        resolve();
      };

      const cleanup = () => {
        worker.removeEventListener("message", handleMessage);
        worker.removeEventListener("error", handleError);
      };

      worker.addEventListener("message", handleMessage);
      worker.addEventListener("error", handleError);

      if (task.kind === "zip_entry" && task.file && task.entry) {
        const sliceEnd = Math.min(
          task.file.size,
          task.entry.localHeaderOffset +
            30 +
            task.entry.nameLen +
            task.entry.extraLen +
            task.entry.compressedSize +
            1024,
        );
        const entryBlob = task.file.slice(task.entry.localHeaderOffset, sliceEnd);
        worker.postMessage({
          type: "EXTRACT_ENTRY",
          payload: {
            id: task.id,
            name: task.entry.name,
            cleanName: task.entry.cleanName,
            category: task.entry.category === "skip" ? "pm2" : task.entry.category,
            entryBlob,
            compressedSize: task.entry.compressedSize,
            uncompressedSize: task.entry.uncompressedSize,
            isDeflated: Boolean(task.entry.isDeflated),
          },
        } satisfies ZipWorkerMessage);
      } else if (task.kind === "gz_file" && task.file) {
        void task.file.arrayBuffer().then((fileBuffer) => {
          worker.postMessage(
            {
              type: "DECOMPRESS_GZ",
              payload: {
                id: task.id,
                fileBuffer,
                fileName: task.file!.name,
              },
            } satisfies ZipWorkerMessage,
            [fileBuffer],
          );
        });
      } else if (task.kind === "gz_buffer" && task.buffer) {
        const buf = task.buffer;
        worker.postMessage(
          {
            type: "DECOMPRESS_GZ",
            payload: {
              id: task.id,
              fileBuffer: buf,
              fileName: task.name,
            },
          } satisfies ZipWorkerMessage,
          [buf],
        );
      }
    });
  };

  const idleWorkers = Array.from({ length: concurrency }, (_, i) => getWorker(i));

  await new Promise<void>((resolve) => {
    function pump() {
      if (queue.length === 0 && runningTasks.size === 0) {
        resolve();
        return;
      }

      while (idleWorkers.length > 0 && queue.length > 0) {
        const worker = idleWorkers.pop()!;
        const task = queue.shift()!;
        void executeTask(worker, task).then(() => {
          completedCount++;
          const percent = Math.min(
            99,
            Math.round((completedCount / Math.max(1, totalDispatched)) * 100),
          );
          setPm2Progress({ stage: "reading", processed: percent, total: 100, percent });
          setMongoProgress({ stage: "reading", processed: percent, total: 100, percent });
          checkEagerMongo();
          idleWorkers.push(worker);
          pump();
        });
      }
    }

    pump();
  });

  // Terminate extraction workers post-extraction to reclaim ~512 MB RSS immediately
  for (const w of workerPool) {
    w.terminate();
  }
  workerPool.length = 0;

  // Finalize Mongo parsing if not already dispatched eagerly
  if (!mongoDispatched) {
    if (mongoResults.length === 1 && uploadMode === "replace") {
      mongoDispatched = true;
      const item = mongoResults[0]!;
      const dummyFile = createTextFile([], item.name, item.lastModified);
      Object.defineProperty(dummyFile, "size", { value: item.size });
      setMongoFiles([dummyFile]);
      void parseMongoBuffer(item.buffer, item.name, item.size);
    } else if (mongoResults.length > 0) {
      mongoDispatched = true;
      const files = mongoResults.map((item) =>
        createTextFile([item.buffer], item.name, item.lastModified),
      );
      const result = uploadMode === "append" ? appendMongoFiles(files) : setMongoFiles(files);
      if (result.length > 0) void parseMongoFiles(result);
    } else {
      setMongoParsing(false);
    }
  }

  // Finalize PM2 parsing
  if (pm2Results.length === 0) {
    setPm2Parsing(false);
  } else {
    // Maintain deterministic sequential order across archives and entries
    pm2Results.sort((a, b) =>
      a.archiveIndex !== b.archiveIndex
        ? a.archiveIndex - b.archiveIndex
        : a.entryIndex - b.entryIndex,
    );

    // Deduplicate by size (matching setLoadedFiles behavior)
    const seenSizes = new Set<number>();
    const uniquePm2: ExtractedBatchItem[] = [];
    for (const item of pm2Results) {
      if (!seenSizes.has(item.size)) {
        seenSizes.add(item.size);
        uniquePm2.push(item);
      }
    }

    if (uploadMode === "replace") {
      // Direct transferable buffer pipeline
      const dummyFiles = uniquePm2.map((item) => {
        const f = createTextFile([], item.name, item.lastModified);
        Object.defineProperty(f, "size", { value: item.size });
        return f;
      });
      setPm2Files(dummyFiles);

      const totalPm2Bytes = uniquePm2.reduce((acc, item) => acc + item.size, 0);
      const total = totalPm2Bytes || 1;
      const hc = navigator.hardwareConcurrency ? Math.max(2, navigator.hardwareConcurrency) : 4;
      const n = Math.max(2, Math.min(4, hc));
      const chunk = Math.ceil(total / n);
      const LINE_EXTEND = 256 * 1024;

      const ranges: {
        shardIndex: number;
        start: number;
        end: number;
        totalSize: number;
        readStart: number;
        readEnd: number;
        buf: ArrayBuffer;
        u8: Uint8Array;
      }[] = [];
      for (let i = 0; i < n; i++) {
        const start = i * chunk;
        const end = i === n - 1 ? total : Math.min(total, (i + 1) * chunk);
        if (start >= total) break;
        const readStart = start > 0 ? start - 1 : start;
        const readEnd = Math.min(total, end + LINE_EXTEND);
        const buf = new ArrayBuffer(readEnd - readStart);
        ranges.push({
          shardIndex: i,
          start,
          end,
          totalSize: total,
          readStart,
          readEnd,
          buf,
          u8: new Uint8Array(buf),
        });
      }

      let itemOffset = 0;
      for (const item of uniquePm2) {
        const itemStart = itemOffset;
        const itemEnd = itemOffset + item.size;
        itemOffset += item.size;
        const itemU8 = new Uint8Array(item.buffer);

        for (const r of ranges) {
          const oStart = Math.max(itemStart, r.readStart);
          const oEnd = Math.min(itemEnd, r.readEnd);
          if (oEnd > oStart) {
            const srcStart = oStart - itemStart;
            const srcEnd = oEnd - itemStart;
            const dstStart = oStart - r.readStart;
            r.u8.set(itemU8.subarray(srcStart, srcEnd), dstStart);
          }
        }
        item.buffer = new ArrayBuffer(0);
      }

      const shardDescriptors: ShardBufferDescriptor[] = ranges.map((r) => ({
        shardIndex: r.shardIndex,
        start: r.start,
        end: r.end,
        totalSize: r.totalSize,
        readStart: r.readStart,
        buf: r.buf,
      }));

      const displayName = uniquePm2.length === 1 ? uniquePm2[0]!.name : `${uniquePm2.length} files`;
      pm2Results.length = 0;
      mongoResults.length = 0;
      initialTasks.length = 0;
      queue.length = 0;
      runningTasks.clear();
      uniquePm2.length = 0;
      void parsePm2Shards(shardDescriptors, displayName, totalPm2Bytes, dummyFiles.length);
    } else {
      const files = uniquePm2.map((item) =>
        createTextFile([item.buffer], item.name, item.lastModified),
      );
      const result = appendPm2Files(files);
      if (result.length > 0) void parseFiles(result);
    }
  }

  if (pm2Results.length === 0 && mongoResults.length === 0) {
    setPm2Parsing(false);
    setMongoParsing(false);
    const skippedMessage =
      failedArchives.length > 0 ? ` (${failedArchives.length} unreadable archive(s) skipped)` : "";
    notify(`No valid API or MongoDB logs found in the selected files${skippedMessage}`);
  } else if (pm2Results.length > 0 && mongoResults.length > 0) {
    const skippedMessage =
      failedArchives.length > 0 ? ` ${failedArchives.length} unreadable archive(s) skipped.` : "";
    notify(
      `Imported ${pm2Results.length} API log(s) and ${mongoResults.length} MongoDB log(s). Both tabs populated.${skippedMessage}`,
    );
  } else if (mongoResults.length > 0) {
    setMode("mongo");
    if (failedArchives.length > 0) {
      notify(`Imported MongoDB logs; ${failedArchives.length} unreadable archive(s) skipped.`);
    }
  } else if (pm2Results.length > 0) {
    setMode("pm2");
    if (failedArchives.length > 0) {
      notify(`Imported API logs; ${failedArchives.length} unreadable archive(s) skipped.`);
    }
  }
}
