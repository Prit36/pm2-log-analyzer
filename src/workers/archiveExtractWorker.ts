import { archiveSuffix, isArchiveName } from "../utils/archiveFormats";
import { compileZipCoreModule } from "../wasm/loadZipCore";
import init, {
  classify_log_name_or_content,
  extract_archive_stream,
  inspect_tar_blob,
} from "../wasm/pkg_zip/zip_core.js";
import type { ZipWorkerResponse } from "./zipExtractWorker";

export type ArchiveEntryInfo = {
  name: string;
  category: "pm2" | "mongo" | "nginx" | "unknown" | "archive" | "skip";
  size: number;
};

type ManifestEntry = { name: string; size: number; directory: boolean };
type TarEntry = ManifestEntry & { offset: number };

export type ArchiveWorkerResponse =
  | ZipWorkerResponse
  | { type: "MANIFEST"; payload: ArchiveEntryInfo[] };

declare const self: {
  onmessage:
    | ((event: MessageEvent<{ file: File; decoderWorkers: number }>) => Promise<void>)
    | null;
  postMessage: (message: ArchiveWorkerResponse, transfer?: Transferable[]) => void;
};

declare const FileReaderSync: {
  new (): { readAsArrayBuffer: (file: Blob) => ArrayBuffer };
};

function sendEntry(path: string, data: Uint8Array): void {
  const name = path.replace(/\\/g, "/").split("/").pop() || path;
  // SAFETY: the Rust streaming adapter and parallel 7z decoder allocate standalone output arrays.
  const buffer = data.buffer as ArrayBuffer;
  const suffix = archiveSuffix(data);
  const nested = suffix !== null || isArchiveName(name);
  const cleanName = suffix && !isArchiveName(name) ? name + suffix : name;
  const sniffed = classify_log_name_or_content(name, data.subarray(0, 4096));
  self.postMessage(
    {
      type: "ENTRY_RESULT",
      payload: {
        id: 0,
        name: cleanName,
        category: nested
          ? "archive"
          : sniffed === "mongo"
            ? "mongo"
            : sniffed === "nginx"
              ? "nginx"
              : "pm2",
        size: buffer.byteLength,
        buffer,
      },
    },
    [buffer],
  );
  self.postMessage({ type: "PROGRESS", payload: { stage: `Extracted ${name}`, percent: 50 } });
}

function entryInfo(path: string, size: number, isFile = true): ArchiveEntryInfo {
  const name = path.replace(/\\/g, "/").split("/").pop() || path;
  const category = classify_log_name_or_content(name, new Uint8Array());
  return {
    name,
    size,
    category:
      !isFile || category === "skip" || path.startsWith("__MACOSX/")
        ? "skip"
        : isArchiveName(name)
          ? "archive"
          : category === "mongo"
            ? "mongo"
            : category === "nginx"
              ? "nginx"
              : category === "pm2"
                ? "pm2"
                : "unknown",
  };
}

self.onmessage = async ({ data: { file, decoderWorkers } }) => {
  const t0 = performance.now();
  try {
    const [header, wasm] = await Promise.all([
      file.slice(0, 512).arrayBuffer(),
      compileZipCoreModule().then((module) => init({ module_or_path: module })),
    ]);
    const suffix = archiveSuffix(new Uint8Array(header));
    if (suffix === ".7z" && file.size < 32) throw new Error("Truncated 7z archive header");
    const skipped: string[] = [];
    const onManifest = (entries: ManifestEntry[]) => {
      self.postMessage({
        type: "MANIFEST",
        payload: entries.map((entry) => entryInfo(entry.name, entry.size, !entry.directory)),
      });
    };
    let totalBytes: number | undefined;
    if (suffix === ".rar" || /\.rar$/i.test(file.name)) {
      const [{ compileRarCoreModule }, { default: initRar, RarExtractor }] = await Promise.all([
        import("../wasm/loadRarCore"),
        import("../wasm/pkg_rar/rar_core.js"),
      ]);
      const rar = await initRar({ module_or_path: await compileRarCoreModule() });
      const reader = new FileReaderSync();
      const extractor = new RarExtractor(
        file.size,
        (offset: number, pointer: number, length: number) => {
          const bytes = reader.readAsArrayBuffer(file.slice(offset, offset + length));
          if (bytes.byteLength !== length) throw new Error("Truncated RAR input");
          new Uint8Array(rar.memory.buffer, pointer, length).set(new Uint8Array(bytes));
        },
      );
      try {
        // SAFETY: Rust serializes validated RAR entry names, sizes and file types.
        const entries = JSON.parse(extractor.manifest()) as ManifestEntry[];
        onManifest(entries);
        totalBytes = 0;
        for (const [index, entry] of entries.entries()) {
          if (
            entryInfo(entry.name, entry.size, !entry.directory).category === "skip" ||
            entry.size === 0
          ) {
            skipped.push(entry.name);
            extractor.skip(index);
            continue;
          }
          if (entry.size > 0x7fffffff)
            throw new Error(`RAR entry exceeds the browser size limit: ${entry.name}`);
          const output = new Uint8Array(entry.size);
          let written = 0;
          extractor.extract(index, (pointer: number, length: number) => {
            output.set(new Uint8Array(rar.memory.buffer, pointer, length), written);
            written += length;
          });
          totalBytes += output.byteLength;
          sendEntry(entry.name, output);
        }
      } finally {
        extractor.free();
      }
    }
    if (suffix === ".7z") {
      const { extractSevenZip } = await import("./sevenZipExtractor");
      totalBytes = await extractSevenZip(
        file,
        sendEntry,
        (path) => skipped.push(path),
        (path) => entryInfo(path, 1).category === "skip",
        decoderWorkers,
        onManifest,
      );
    }
    if (suffix === ".xz" && decoderWorkers > 1) {
      const { extractXzTar } = await import("./xzExtractor");
      totalBytes = await extractXzTar(
        file,
        wasm.memory,
        sendEntry,
        (path) => skipped.push(path),
        decoderWorkers,
      );
    }
    if (totalBytes === undefined) {
      const reader = new FileReaderSync();
      const read = (offset: number, pointer: number, length: number) => {
        const bytes = reader.readAsArrayBuffer(file.slice(offset, offset + length));
        if (bytes.byteLength !== length) throw new Error("Truncated archive input");
        new Uint8Array(wasm.memory.buffer, pointer, length).set(new Uint8Array(bytes));
      };
      if (suffix === ".tar" || (suffix === null && /\.tar$/i.test(file.name))) {
        // SAFETY: Rust's TAR reader validates metadata, entry offsets and input bounds.
        const entries = JSON.parse(inspect_tar_blob(file.size, read)) as TarEntry[];
        onManifest(entries);
        totalBytes = 0;
        let next = 0;
        await Promise.all(
          Array.from({ length: Math.min(2, entries.length) }, async () => {
            while (next < entries.length) {
              const entry = entries[next++]!;
              if (
                entryInfo(entry.name, entry.size, !entry.directory).category === "skip" ||
                entry.size === 0
              ) {
                skipped.push(entry.name);
                continue;
              }
              if (entry.size > 0x7fffffff)
                throw new Error(`Archive entry exceeds the browser size limit: ${entry.name}`);
              const buffer = await file
                .slice(entry.offset, entry.offset + entry.size)
                .arrayBuffer();
              totalBytes! += buffer.byteLength;
              sendEntry(entry.name, new Uint8Array(buffer));
            }
          }),
        );
      } else if (suffix === ".bz2" && decoderWorkers > 1 && file.size >= 1024 * 1024) {
        const { extractBzipTar } = await import("./bzipExtractor");
        totalBytes = await extractBzipTar(
          file,
          wasm.memory,
          sendEntry,
          (path) => skipped.push(path),
          decoderWorkers,
        );
      } else {
        let output = new Uint8Array();
        let outputPath = "";
        let written = 0;
        totalBytes = extract_archive_stream(
          file.size,
          suffix?.slice(1) ?? (/\.rar$/i.test(file.name) ? "rar" : "tar"),
          read,
          (path: string, size: number) => {
            outputPath = path;
            output = new Uint8Array(size);
            written = 0;
          },
          (pointer: number, length: number) => {
            output.set(new Uint8Array(wasm.memory.buffer, pointer, length), written);
            written += length;
          },
          () => {
            sendEntry(outputPath, output);
            output = new Uint8Array();
          },
          (path: string) => skipped.push(path),
          (json: string) => {
            // SAFETY: Rust serializes validated archive entries using this exact structure.
            onManifest(JSON.parse(json) as ManifestEntry[]);
          },
        );
      }
    }
    self.postMessage({
      type: "RESULT",
      payload: {
        fileName: file.name,
        files: [],
        skipped,
        totalBytes,
        durationMs: Math.round(performance.now() - t0),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    self.postMessage({
      type: "ERROR",
      payload: {
        message: message.includes("AES256_SHA256")
          ? "Password-protected archives are not supported"
          : message,
      },
    });
  }
};
