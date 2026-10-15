import { libarchiveWasm } from "libarchive-wasm";
import type { LibarchiveWasm } from "libarchive-wasm/dist/libarchiveWasm";
import wasmUrl from "libarchive-wasm/dist/libarchive.wasm?url";
import unrarUrl from "node-unrar-js/esm/js/unrar.wasm?url";
import { archiveSuffix, isArchiveName } from "../utils/archiveFormats";
import { compileZipCoreModule } from "../wasm/loadZipCore";
import init, { classify_log_name_or_content } from "../wasm/pkg_zip/zip_core.js";
import type { ZipWorkerResponse } from "./zipExtractWorker";

export type ArchiveEntryInfo = {
  name: string;
  category: "pm2" | "mongo" | "unknown" | "archive" | "skip";
  size: number;
};

export type ArchiveWorkerResponse =
  | ZipWorkerResponse
  | { type: "MANIFEST"; payload: ArchiveEntryInfo[] }
  | { type: "RESET" };

declare const self: {
  onmessage:
    | ((event: MessageEvent<{ file: File; decoderWorkers: number }>) => Promise<void>)
    | null;
  postMessage: (message: ArchiveWorkerResponse, transfer?: Transferable[]) => void;
};

function sendEntry(path: string, data: Int8Array | Uint8Array): void {
  const name = path.replace(/\\/g, "/").split("/").pop() || path;
  // SAFETY: both decoders return a newly allocated, standalone typed array.
  const buffer = data.buffer as ArrayBuffer;
  const view = new Uint8Array(buffer);
  const suffix = archiveSuffix(view);
  const nested = suffix !== null || isArchiveName(name);
  const cleanName = suffix && !isArchiveName(name) ? name + suffix : name;
  const sniffed = classify_log_name_or_content(name, view.subarray(0, 4096));
  self.postMessage(
    {
      type: "ENTRY_RESULT",
      payload: {
        id: 0,
        name: cleanName,
        category: nested ? "archive" : sniffed === "mongo" ? "mongo" : "pm2",
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
            : category === "pm2"
              ? "pm2"
              : "unknown",
  };
}

self.onmessage = async ({ data: { file, decoderWorkers } }) => {
  const t0 = performance.now();
  let archive: LibarchiveWasm | undefined;
  let handle = 0;
  let inputPtr = 0;
  let scratchPtr = 0;
  try {
    const [header] = await Promise.all([
      file.slice(0, 512).arrayBuffer(),
      compileZipCoreModule().then((module) => init({ module_or_path: module })),
    ]);
    const suffix = archiveSuffix(new Uint8Array(header));
    if (suffix === ".7z" && file.size < 32) throw new Error("Truncated 7z archive header");
    let totalBytes = 0;
    const skipped: string[] = [];
    if (/\.rar$/i.test(file.name) || suffix === ".rar") {
      const [{ createRarExtractor }, response] = await Promise.all([
        import("./rarExtractor"),
        fetch(unrarUrl),
      ]);
      if (!response.ok) throw new Error("Could not load RAR decoder");
      const extractor = await createRarExtractor(file, await response.arrayBuffer());
      const manifest = extractor.getFileList();
      if (manifest.arcHeader.flags.volume)
        throw new Error("Split-volume RAR archives are not supported");
      self.postMessage({
        type: "MANIFEST",
        payload: Array.from(manifest.fileHeaders, (entry) => {
          if (entry.flags.encrypted)
            throw new Error("Password-protected archives are not supported");
          return entryInfo(entry.name, entry.unpSize, !entry.flags.directory);
        }),
      });
      const extracted = extractor.extract({
        files: (entry) => {
          const info = entryInfo(entry.name, entry.unpSize, !entry.flags.directory);
          if (info.category === "skip") {
            skipped.push(entry.name);
            return false;
          }
          return true;
        },
      });
      for (const entry of extracted.files) {
        if (!entry.extraction?.byteLength) continue;
        totalBytes += entry.extraction.byteLength;
        sendEntry(entry.fileHeader.name, entry.extraction);
      }
    } else {
      if (suffix === ".7z") {
        const { extractSevenZip } = await import("./sevenZipExtractor");
        const extractedBytes = await extractSevenZip(
          file,
          sendEntry,
          (path) => skipped.push(path),
          (path) => entryInfo(path, 1).category === "skip",
          decoderWorkers,
          (entries) => {
            self.postMessage({
              type: "MANIFEST",
              payload: entries.map((entry) => entryInfo(entry.name, entry.size, !entry.directory)),
            });
          },
        );
        if (extractedBytes !== undefined) {
          self.postMessage({
            type: "RESULT",
            payload: {
              fileName: file.name,
              files: [],
              skipped,
              totalBytes: extractedBytes,
              durationMs: Math.round(performance.now() - t0),
            },
          });
          return;
        }
      }
      const isTar =
        /\.(?:tar|tar\.(?:gz|bz2|xz)|tgz|tbz2?|txz)$/i.test(file.name) ||
        suffix === ".tar" ||
        suffix === ".bz2" ||
        suffix === ".xz";
      if (isTar) {
        try {
          const { extract_tar_wasm } = await import("../wasm/pkg_zip/zip_core.js");
          const bytes = new Uint8Array(await file.arrayBuffer());
          totalBytes = extract_tar_wasm(
            bytes,
            (path: string, data: Uint8Array) => sendEntry(path, data),
            (path: string) => skipped.push(path),
          );
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
          return;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (
            /corrupt|truncated|incomplete|invalid|mismatch|overflow|checksum|trailer|unexpectedeof/i.test(
              msg,
            )
          ) {
            throw error;
          }
          // Keep libarchive compatibility for sparse/PAX edge cases
          self.postMessage({ type: "RESET" });
          skipped.length = 0;
          totalBytes = 0;
        }
      }
      archive = await libarchiveWasm({ locateFile: () => wasmUrl });
      inputPtr = archive.module._malloc(file.size);
      if (!inputPtr) throw new Error("Could not allocate archive input buffer");
      // Copy bounded slices directly into Wasm, avoiding a second whole compressed archive.
      for (let offset = 0; offset < file.size; offset += 16 * 1024 * 1024) {
        const chunk = await file.slice(offset, offset + 16 * 1024 * 1024).arrayBuffer();
        archive.module.HEAP8.set(new Int8Array(chunk), inputPtr + offset);
      }
      const openReader = () => {
        const reader = archive!.read_new();
        archive!.read_support_filter_all(reader);
        archive!.read_support_format_all(reader);
        archive!.read_open_memory(reader, inputPtr, file.size);
        return reader;
      };
      handle = openReader();
      const scratchSize = 8 * 1024 * 1024;
      scratchPtr = archive.module._malloc(scratchSize);
      if (!scratchPtr) throw new Error("Could not allocate archive decode buffer");
      for (
        let entry = archive.read_next_entry(handle);
        entry;
        entry = archive.read_next_entry(handle)
      ) {
        const path = archive.entry_pathname(entry);
        const info = entryInfo(
          path,
          archive.entry_size(entry),
          archive.entry_filetype(entry) === 0o100000,
        );
        if (archive.entry_is_encrypted(entry))
          throw new Error("Password-protected archives are not supported");
        if (info.category === "skip" || info.size === 0) {
          skipped.push(path);
          archive.read_data_skip(handle);
          continue;
        }
        if (!Number.isSafeInteger(info.size) || info.size < 0 || info.size > 0x7fffffff) {
          throw new Error(`Archive entry exceeds the browser size limit: ${path}`);
        }
        const data = new Int8Array(info.size);
        let offset = 0;
        while (offset < info.size) {
          const count = archive.read_data(
            handle,
            scratchPtr,
            Math.min(scratchSize, info.size - offset),
          );
          if (!count) throw new Error(`Incomplete archive entry: ${path}`);
          data.set(archive.module.HEAP8.subarray(scratchPtr, scratchPtr + count), offset);
          offset += count;
        }
        if (archive.read_data(handle, scratchPtr, 1) !== 0)
          throw new Error(`Archive entry size mismatch: ${path}`);
        totalBytes += data.byteLength;
        sendEntry(path, data);
      }
      const error = archive.error_string(handle);
      if (error) throw new Error(error);
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
    self.postMessage({
      type: "ERROR",
      payload: {
        message: error instanceof Error ? error.message : String(error),
      },
    });
  } finally {
    if (scratchPtr) archive?.module._free(scratchPtr);
    if (handle) archive?.read_free(handle);
    if (inputPtr) archive?.module._free(inputPtr);
  }
};
