import { Extractor } from "node-unrar-js";
import type { ArcFile, ArcFiles, ExtractOptions, FileHeader, SeekMethod } from "node-unrar-js";
import { getUnrar } from "node-unrar-js/esm/js/unrar.singleton";

interface UnrarModule {
  HEAPU8: Uint8Array;
  extractor: BufferedRarExtractor;
}

interface RarFile {
  data: Uint8Array;
  position: number;
  written: number;
}

declare const FileReaderSync: {
  new (): { readAsArrayBuffer: (file: Blob) => ArrayBuffer };
};

// The package's default adapter copies every read and collects output chunks before
// flattening them. UnRAR already supplies each entry's exact size before creating it.
class BufferedRarExtractor extends Extractor<Uint8Array> {
  protected _filePath = "_defaultUnrarJS_.rar";
  private readonly inputFile: File | undefined;
  private readonly inputData: Uint8Array | undefined;
  private readonly inputSize: number;
  private readonly inputReader: InstanceType<typeof FileReaderSync> | undefined;
  private inputPosition = 0;
  private inputCache = new Uint8Array();
  private cacheStart = 0;
  private cacheSize = 8 * 1024 * 1024;
  private output: RarFile | undefined;
  private header: FileHeader | undefined;

  constructor(
    private readonly module: UnrarModule,
    data: ArrayBuffer | File,
  ) {
    super(module);
    if (data instanceof File) {
      this.inputFile = data;
      this.inputSize = data.size;
      this.inputReader = new FileReaderSync();
    } else {
      this.inputData = new Uint8Array(data);
      this.inputSize = data.byteLength;
    }
  }

  override extract(options: ExtractOptions = {}): ArcFiles<Uint8Array> {
    // Small windows keep manifest seeks cheap; sequential extraction benefits
    // from fewer synchronous Blob reads without retaining the whole archive.
    this.cacheSize = 64 * 1024 * 1024;
    const requested = options.files;
    const extracted = super.extract({
      ...options,
      files: (header) => {
        this.header = header;
        this.output = undefined;
        return Array.isArray(requested)
          ? requested.includes(header.name)
          : requested
            ? requested(header)
            : true;
      },
    });
    return { arcHeader: extracted.arcHeader, files: this.entries(extracted.files) };
  }

  private *entries(files: Generator<ArcFile<Uint8Array>>): Generator<ArcFile<Uint8Array>> {
    for (const entry of files) {
      if (entry.fileHeader.flags.directory) {
        yield entry;
        continue;
      }
      const data = this.output?.data ?? new Uint8Array();
      if (
        data.byteLength !== entry.fileHeader.unpSize ||
        this.output?.written !== data.byteLength
      ) {
        if (entry.fileHeader.unpSize !== 0) {
          throw new Error(`Incomplete RAR archive entry: ${entry.fileHeader.name}`);
        }
      }
      // Release our reference before the caller transfers this buffer to another worker.
      this.output = undefined;
      yield { fileHeader: entry.fileHeader, extraction: data };
    }
  }

  protected open(filename: string): number {
    if (filename === this._filePath) return 1;
    throw new Error("RAR file-reference records are not supported");
  }

  protected create(): number {
    const size = this.header?.unpSize ?? 0;
    if (!Number.isSafeInteger(size) || size < 0 || size > 0x7fffffff) {
      throw new Error(`RAR archive entry exceeds the browser size limit: ${this.header?.name}`);
    }
    this.output = { data: new Uint8Array(size), position: 0, written: 0 };
    return 2;
  }

  protected closeFile(fd: number): void {
    if (fd === 1) this.inputPosition = 0;
    else if (this.output) this.output.position = 0;
  }

  protected read(fd: number, ptr: number, size: number): number {
    if (fd !== 1) {
      const file = this.output;
      if (!file || file.position + size > file.data.byteLength) return -1;
      this.module.HEAPU8.set(file.data.subarray(file.position, file.position + size), ptr);
      file.position += size;
      return size;
    }
    if (this.inputPosition + size > this.inputSize) return -1;
    if (this.inputData) {
      this.module.HEAPU8.set(
        this.inputData.subarray(this.inputPosition, this.inputPosition + size),
        ptr,
      );
      this.inputPosition += size;
      return size;
    }
    let copied = 0;
    while (copied < size) {
      if (
        this.inputPosition < this.cacheStart ||
        this.inputPosition >= this.cacheStart + this.inputCache.byteLength
      ) {
        this.cacheStart = Math.floor(this.inputPosition / this.cacheSize) * this.cacheSize;
        this.inputCache = new Uint8Array(
          this.inputReader!.readAsArrayBuffer(
            this.inputFile!.slice(this.cacheStart, this.cacheStart + this.cacheSize),
          ),
        );
      }
      const offset = this.inputPosition - this.cacheStart;
      const count = Math.min(size - copied, this.inputCache.byteLength - offset);
      this.module.HEAPU8.set(this.inputCache.subarray(offset, offset + count), ptr + copied);
      copied += count;
      this.inputPosition += count;
    }
    return size;
  }

  protected write(fd: number, ptr: number, size: number): boolean {
    const file = fd === 2 ? this.output : undefined;
    if (!file || file.position + size > file.data.byteLength) return false;
    file.data.set(this.module.HEAPU8.subarray(ptr, ptr + size), file.position);
    file.position += size;
    file.written = Math.max(file.written, file.position);
    return true;
  }

  protected tell(fd: number): number {
    return fd === 1 ? this.inputPosition : (this.output?.position ?? -1);
  }

  protected seek(fd: number, offset: number, method: SeekMethod): boolean {
    const position = fd === 1 ? this.inputPosition : this.output?.position;
    const size = fd === 1 ? this.inputSize : this.output?.data.byteLength;
    if (position === undefined || size === undefined) return false;
    const next = method === "SET" ? offset : method === "CUR" ? position + offset : size - offset;
    if (next < 0 || next > size) return false;
    if (fd === 1) this.inputPosition = next;
    else if (this.output) this.output.position = next;
    return true;
  }
}

export async function createRarExtractor(
  data: ArrayBuffer | File,
  wasmBinary: ArrayBuffer,
): Promise<Extractor<Uint8Array>> {
  // SAFETY: node-unrar-js's Emscripten module exposes HEAPU8 and the extractor I/O target.
  const module = (await getUnrar({ wasmBinary })) as UnrarModule;
  const extractor = new BufferedRarExtractor(module, data);
  module.extractor = extractor;
  return extractor;
}
