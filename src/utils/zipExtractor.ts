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

let worker: Worker | null = null;

function getZipWorker(): Worker {
  if (worker) return worker;
  worker = new ZipWorkerCtor();
  return worker;
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

export async function extractArchive(
  file: File,
  onProgress?: (p: { stage: string; percent: number }) => void,
): Promise<ExtractedLogSet> {
  const w = getZipWorker();
  const fileBuffer = await file.arrayBuffer();

  const isGz = file.name.endsWith(".gz");
  const msgType = isGz ? "DECOMPRESS_GZ" : "EXTRACT_ZIP";

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
        type: msgType,
        payload: { fileBuffer, fileName: file.name },
      } satisfies ZipWorkerMessage,
      [fileBuffer],
    );
  });
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
