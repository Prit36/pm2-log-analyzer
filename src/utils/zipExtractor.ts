import ZipWorkerCtor from "../workers/zipExtractWorker.ts?worker&inline";
import type {
  ExtractedArchiveResult,
  ZipWorkerMessage,
  ZipWorkerResponse,
} from "../workers/zipExtractWorker";
import { useAnalysisStore } from "../store/analysisStore";
import { useMongoStore } from "../store/mongoStore";
import { useAppModeStore } from "../store/appModeStore";
import { parseFiles, parsePm2Buffer } from "../hooks/useParserWorker";
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
  localHeaderOffset: number;
  nameLen: number;
  extraLen: number;
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

export function filterValidFiles(fileList: FileList | File[] | null | undefined): File[] {
  if (!fileList || fileList.length === 0) return [];
  return Array.from(fileList).filter(
    (f) =>
      isArchiveFile(f) ||
      /\.(?:log(?:\.\d+)?|txt|json|out|err|\d+)$/i.test(f.name) ||
      f.type === "text/plain" ||
      f.type === "",
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
      category: classifyByName(name),
    });

    offset += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

function extractSingleGz(
  file: File,
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

export async function extractArchive(
  file: File,
  callbacks?: ExtractArchiveCallbacks,
): Promise<ExtractedLogSet> {
  const cbOptions = callbacks ?? {};
  const t0 = performance.now();

  const isGz = file.name.endsWith(".gz");
  if (isGz) {
    return extractSingleGz(file, cbOptions.onProgress);
  }

  const entries = await parseZipCentralDirectoryFromFile(file);
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

  const expectedPm2 = validEntries.filter((e) => e.category === "pm2").length;
  const expectedMongo = validEntries.filter((e) => e.category === "mongo").length;
  const hasUnknown = validEntries.some((e) => e.category === "unknown");
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

          if (item.category === "mongo") {
            const extractedFile =
              expectedMongo === 1
                ? new File([], item.name, { type: "text/plain" })
                : new File([item.buffer], item.name, { type: "text/plain" });
            if (expectedMongo === 1) {
              Object.defineProperty(extractedFile, "size", { value: item.size });
            }
            mongoFiles.push(extractedFile);
            if (item.buffer && expectedMongo === 1) {
              mongoDirectBuffer = { buffer: item.buffer, fileName: item.name, size: item.size };
            }
          } else {
            const extractedFile =
              expectedPm2 === 1
                ? new File([], item.name, { type: "text/plain" })
                : new File([item.buffer], item.name, { type: "text/plain" });
            if (expectedPm2 === 1) {
              Object.defineProperty(extractedFile, "size", { value: item.size });
            }
            pm2Files.push(extractedFile);
            if (item.buffer && expectedPm2 === 1) {
              pm2DirectBuffer = { buffer: item.buffer, fileName: item.name, size: item.size };
            }
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

export async function handleLogFilesUpload(
  files: File[],
  uploadMode: "replace" | "append" = "replace",
): Promise<void> {
  const archive = files.find(isArchiveFile);
  if (archive) {
    return handleArchiveUpload(archive, uploadMode);
  }

  const pm2Files: File[] = [];
  const mongoFiles: File[] = [];
  const activeMode = useAppModeStore.getState().mode;

  for (const file of files) {
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
    const res = uploadMode === "append" ? appendPm2Files(pm2Files) : setPm2Files(pm2Files);
    if (res.length > 0) void parseFiles(res);
  }
  if (mongoFiles.length > 0) {
    const res = uploadMode === "append" ? appendMongoFiles(mongoFiles) : setMongoFiles(mongoFiles);
    if (res.length > 0) void parseMongoFiles(res);
  }

  if (pm2Files.length > 0 && mongoFiles.length > 0) {
    notify(
      `Classified ${pm2Files.length} API log(s) and ${mongoFiles.length} MongoDB log(s). Both tabs populated.`,
    );
  } else if (mongoFiles.length > 0) {
    setMode("mongo");
  } else if (pm2Files.length > 0) {
    setMode("pm2");
  }
}
