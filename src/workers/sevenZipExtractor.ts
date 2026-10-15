import { compileZipCoreModule } from "../wasm/loadZipCore";
import { inspect_sevenz, sevenz_crc_combine } from "../wasm/pkg_zip/zip_core.js";
import type { SevenZipDecoded, SevenZipJob } from "./sevenZipDecodeWorker";

type SevenBlock = {
  start: number;
  size: number;
  unpacked: number;
  dictionary: number;
  crc: number | null;
};
type SevenFile = {
  name: string;
  size: number;
  block: number | null;
  crc: number | null;
  directory: boolean;
};
type SevenIndex = { blocks: SevenBlock[]; files: SevenFile[] };
type Segment = { start: number; end: number; offset: number; size: number; dictionary: number };
type PlannedFile = SevenFile & { offset: number; skip: boolean; checksum: number };
type DecodeOutcome = { ok: true; value: SevenZipDecoded } | { ok: false; error: Error };

const WINDOW = 8 * 1024 * 1024;
const MAX_SEGMENT = 32 * 1024 * 1024;

async function scanSegments(file: File, block: SevenBlock): Promise<Segment[] | undefined> {
  const segments: Segment[] = [];
  const end = block.start + block.size;
  let position = block.start;
  let cacheStart = -1;
  let cache = new Uint8Array();
  let start = position;
  let offset = 0;
  let size = 0;
  let groupSize = 0;
  let largestGroup = 0;
  const flush = () => {
    if (!size) return;
    segments.push({
      start,
      end: position,
      offset,
      size,
      dictionary: Math.min(block.dictionary, Math.max(4096, largestGroup, groupSize)),
    });
    offset += size;
    start = position;
    size = 0;
    largestGroup = 0;
    groupSize = 0;
  };
  while (position < end) {
    if (position < cacheStart || position + 6 > cacheStart + cache.length) {
      cacheStart = position;
      cache = new Uint8Array(
        await file.slice(position, Math.min(end, position + 16 * 1024 * 1024)).arrayBuffer(),
      );
    }
    const at = position - cacheStart;
    const control = cache[at]!;
    if (control === 0) {
      flush();
      return position + 1 === end && offset === block.unpacked ? segments : undefined;
    }
    const reset = control >= 0xe0 || control === 1;
    if (position === block.start && !reset) return;
    if (reset) {
      largestGroup = Math.max(largestGroup, groupSize);
      groupSize = 0;
      if (size >= WINDOW) flush();
    }
    const header = control >= 0xc0 ? 6 : control >= 0x80 ? 5 : 3;
    if ((control > 2 && control < 0x80) || at + header > cache.length) return;
    const unpacked =
      control >= 0x80
        ? ((control & 31) << 16) + (cache[at + 1]! << 8) + cache[at + 2]! + 1
        : (cache[at + 1]! << 8) + cache[at + 2]! + 1;
    const compressed = control >= 0x80 ? (cache[at + 3]! << 8) + cache[at + 4]! + 1 : unpacked;
    groupSize += unpacked;
    size += unpacked;
    if (groupSize > MAX_SEGMENT || size > MAX_SEGMENT || position + header + compressed > end)
      return;
    position += header + compressed;
  }
  return;
}

function decode(worker: Worker, job: SevenZipJob): Promise<SevenZipDecoded> {
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }: MessageEvent<SevenZipDecoded>) => {
      if (data.error) reject(new Error(data.error));
      else resolve(data);
    };
    worker.onerror = (event) => reject(new Error(event.message));
    worker.postMessage(job);
  });
}

/** Parallelize only independently decodable LZMA2 ranges; retain the general decoder fallback. */
export async function extractSevenZip(
  file: File,
  onEntry: (path: string, bytes: Uint8Array) => void,
  onSkipped: (path: string) => void,
  shouldSkip: (path: string) => boolean,
  workerCap = Math.max(4, Math.min(navigator.hardwareConcurrency || 4, 8)),
  onManifest?: (files: SevenFile[]) => void,
): Promise<number | undefined> {
  const tailStart = Math.max(0, file.size - 256 * 1024);
  const [signature, tail] = await Promise.all([
    file.slice(0, 32).arrayBuffer(),
    file.slice(tailStart).arrayBuffer(),
  ]);
  const json = inspect_sevenz(
    new Uint8Array(signature),
    new Uint8Array(tail),
    tailStart,
    file.size,
  );
  if (!json) return;
  // SAFETY: Rust serializes this exact metadata structure after validating the 7z header.
  const index = JSON.parse(json) as SevenIndex;
  onManifest?.(index.files);
  const plans: { files: PlannedFile[]; segments: Segment[] }[] = [];
  for (const [blockIndex, block] of index.blocks.entries()) {
    let offset = 0;
    const files = index.files
      .filter((entry) => entry.block === blockIndex && !entry.directory && entry.size > 0)
      .map((entry) => {
        const planned = { ...entry, offset, skip: shouldSkip(entry.name), checksum: 0 };
        offset += entry.size;
        return planned;
      });
    if (
      offset !== block.unpacked ||
      files.some((entry) => !Number.isSafeInteger(entry.size) || entry.size > 0x7fffffff)
    )
      return;
    // A folder-only CRC cannot be checked before emitting several files from that folder.
    if (block.crc !== null) {
      if (files.length > 1) return;
      if (files[0]?.crc !== null && files[0]?.crc !== block.crc) return;
      if (files[0] && files[0].crc === null) files[0].crc = block.crc;
    }
    const segments = await scanSegments(file, block);
    if (!segments) return;
    plans.push({ files, segments });
  }
  const module = await compileZipCoreModule();
  let workerBytes = WINDOW;
  let jobs = 0;
  for (const plan of plans) {
    jobs += plan.segments.length;
    for (const segment of plan.segments)
      workerBytes = Math.max(
        workerBytes,
        segment.dictionary + 2 * segment.size + 2 * (segment.end - segment.start),
      );
  }
  const count = Math.min(
    workerCap,
    Math.max(1, jobs),
    navigator.hardwareConcurrency || 4,
    Math.max(1, Math.floor((workerCap * 64 * 1024 * 1024) / workerBytes)),
  );
  const workers: Worker[] = [];
  let totalBytes = 0;
  try {
    for (let index = 0; index < count; index++) {
      const worker = new Worker(new URL("./sevenZipDecodeWorker.ts", import.meta.url), {
        type: "module",
      });
      workers.push(worker);
      worker.postMessage({ module });
    }
    for (const entry of index.files) {
      if (entry.directory || entry.size === 0) onSkipped(entry.name);
    }
    for (const plan of plans) {
      let output: Uint8Array | undefined;
      let current: PlannedFile | undefined;
      const schedule = (index: number): Promise<DecodeOutcome> => {
        const segment = plan.segments[index]!;
        const parts = plan.files
          .filter(
            (entry) =>
              entry.crc !== null &&
              entry.offset < segment.offset + segment.size &&
              entry.offset + entry.size > segment.offset,
          )
          .map((entry) => ({
            offset: Math.max(entry.offset, segment.offset) - segment.offset,
            length:
              Math.min(entry.offset + entry.size, segment.offset + segment.size) -
              Math.max(entry.offset, segment.offset),
          }));
        // Handle every rejection immediately, even while an earlier range is awaited.
        return decode(workers[index % count]!, {
          input: file.slice(segment.start, segment.end),
          dictionary: segment.dictionary,
          size: segment.size,
          parts,
        }).then<DecodeOutcome, DecodeOutcome>(
          (value) => ({ ok: true, value }),
          (error: Error) => ({ ok: false, error }),
        );
      };
      const pending: (Promise<DecodeOutcome> | undefined)[] = plan.segments
        .slice(0, count)
        .map((_, index) => schedule(index));
      for (let index = 0; index < plan.segments.length; index++) {
        const slot = index % count;
        const outcome = await pending[slot]!;
        pending[slot] = undefined;
        if (!outcome.ok) throw outcome.error;
        const segment = plan.segments[index]!;
        const result = outcome.value;
        const bytes = new Uint8Array(result.buffer);
        let checksumIndex = 0;
        for (const entry of plan.files) {
          const begin = Math.max(entry.offset, segment.offset);
          const end = Math.min(entry.offset + entry.size, segment.offset + segment.size);
          if (begin >= end) continue;
          if (entry.crc !== null)
            entry.checksum = sevenz_crc_combine(
              entry.checksum,
              result.checksums[checksumIndex++]!,
              end - begin,
            );
          if (!entry.skip) {
            if (current !== entry) {
              current = entry;
              output = new Uint8Array(entry.size);
            }
            output!.set(
              bytes.subarray(begin - segment.offset, end - segment.offset),
              begin - entry.offset,
            );
          }
          if (end === entry.offset + entry.size) {
            if (entry.crc !== null && entry.checksum !== entry.crc)
              throw new Error(`7z checksum mismatch: ${entry.name}`);
            if (entry.skip) onSkipped(entry.name);
            else {
              totalBytes += entry.size;
              onEntry(entry.name, output!);
              output = undefined;
              current = undefined;
            }
          }
        }
        // Refill only the consumed slot: ready and running outputs stay bounded by count.
        if (index + count < plan.segments.length) pending[slot] = schedule(index + count);
      }
    }
    return totalBytes;
  } finally {
    for (const worker of workers) worker.terminate();
  }
}
