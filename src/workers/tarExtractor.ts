interface TarOverrides {
  path?: string;
  size?: number;
}

const decoder = new TextDecoder();

function tarString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return decoder.decode(end < 0 ? bytes : bytes.subarray(0, end));
}

function tarNumber(bytes: Uint8Array): number {
  if (bytes[0]! & 0x80) {
    if (bytes[0]! & 0x40) throw new Error("Negative TAR entry size");
    let value = bytes[0]! & 0x7f;
    for (let i = 1; i < bytes.length; i++) value = value * 256 + bytes[i]!;
    if (!Number.isSafeInteger(value)) throw new Error("TAR entry size exceeds the browser limit");
    return value;
  }
  const text = tarString(bytes).trim();
  if (!/^[0-7]*$/.test(text)) throw new Error("Invalid TAR numeric field");
  const value = text ? Number.parseInt(text, 8) : 0;
  if (!Number.isSafeInteger(value)) throw new Error("TAR entry size exceeds the browser limit");
  return value;
}

function paxOverrides(bytes: Uint8Array, target: TarOverrides): void {
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    if (space < 0) throw new Error("Invalid TAR PAX record");
    const lengthText = decoder.decode(bytes.subarray(offset, space));
    if (!/^[0-9]+$/.test(lengthText)) throw new Error("Invalid TAR PAX record length");
    const end = offset + Number(lengthText);
    if (
      !Number.isSafeInteger(end) ||
      end <= space + 1 ||
      end > bytes.length ||
      bytes[end - 1] !== 10
    )
      throw new Error("Incomplete TAR PAX record");
    const record = decoder.decode(bytes.subarray(space + 1, end - 1));
    const equals = record.indexOf("=");
    if (equals < 0) throw new Error("Invalid TAR PAX attribute");
    const key = record.slice(0, equals);
    const value = record.slice(equals + 1);
    if (
      key.includes("sparse") ||
      key === "SCHILY.realsize" ||
      (key === "SCHILY.filetype" && value === "sparse")
    ) {
      throw new Error("Sparse TAR entries require the compatibility decoder");
    }
    if (key === "path") target.path = value;
    else if (key === "size") {
      const size = Number(value);
      if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(size)) {
        throw new Error("Invalid TAR PAX entry size");
      }
      target.size = size;
    }
    offset = end;
  }
}

// Consume decoder chunks directly, copying only file bytes into their final
// transferable allocation. Skipped entries never allocate an output buffer.
class TarStream {
  private chunk: Uint8Array = new Uint8Array();
  private offset = 0;
  private position = 0;

  constructor(
    private readonly reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
    private readonly file: File | undefined,
  ) {}

  async read(size: number): Promise<Uint8Array> {
    if (this.file) {
      if (this.position + size > this.file.size) throw new Error("Truncated TAR archive");
      const data = new Uint8Array(
        await this.file.slice(this.position, this.position + size).arrayBuffer(),
      );
      this.position += size;
      return data;
    }
    const data = new Uint8Array(size);
    await this.consume(size, data);
    return data;
  }

  async consume(size: number, output?: Uint8Array): Promise<void> {
    if (this.file) {
      if (output) output.set(await this.read(size));
      else {
        this.position += size;
        if (this.position > this.file.size) throw new Error("Truncated TAR archive");
      }
      return;
    }
    let written = 0;
    while (written < size) {
      if (this.offset === this.chunk.length) {
        const next = await this.reader!.read();
        if (next.done) throw new Error("Truncated TAR archive");
        this.chunk = next.value;
        this.offset = 0;
      }
      const count = Math.min(size - written, this.chunk.length - this.offset);
      output?.set(this.chunk.subarray(this.offset, this.offset + count), written);
      this.offset += count;
      written += count;
    }
  }

  async drain(): Promise<void> {
    this.chunk = new Uint8Array();
    while (this.reader && !(await this.reader.read()).done) {
      // Reading through EOF validates the gzip trailer; unsupported streams fail.
    }
  }
}

export async function extractTar(
  file: File,
  onEntry: (path: string, data: Uint8Array) => void,
  onSkipped: (path: string) => void,
  shouldSkip: (path: string) => boolean = () => false,
): Promise<number> {
  const gzip = /\.(?:tar\.gz|tgz)$/i.test(file.name);
  const reader = gzip
    ? file.stream().pipeThrough(new DecompressionStream("gzip")).getReader()
    : undefined;
  const input = new TarStream(reader, gzip ? undefined : file);
  const header = new Uint8Array(512);
  const globals: TarOverrides = {};
  let local: TarOverrides = {};
  let longName: string | undefined;
  let totalBytes = 0;
  try {
    for (;;) {
      await input.consume(512, header);
      if (header.every((byte) => byte === 0)) {
        await input.consume(512, header);
        if (!header.every((byte) => byte === 0)) throw new Error("Invalid TAR end marker");
        await input.drain();
        return totalBytes;
      }
      let checksum = 0;
      let signedChecksum = 0;
      for (let i = 0; i < 512; i++) {
        const byte = i >= 148 && i < 156 ? 32 : header[i]!;
        checksum += byte;
        signedChecksum += byte > 127 ? byte - 256 : byte;
      }
      const expected = tarNumber(header.subarray(148, 156));
      if (expected !== checksum && expected !== signedChecksum) {
        throw new Error("Invalid TAR header checksum");
      }
      const type = header[156]!;
      const headerSize = tarNumber(header.subarray(124, 136));
      let path = tarString(header.subarray(0, 100));
      if (tarString(header.subarray(257, 263)) === "ustar") {
        const prefix = tarString(header.subarray(345, 500));
        if (prefix) path = prefix + "/" + path;
      }
      if (type === 120 || type === 103 || type === 76 || type === 75) {
        if (headerSize > 1024 * 1024)
          throw new Error("TAR metadata requires the compatibility decoder");
        const metadata = await input.read(headerSize);
        await input.consume((512 - (headerSize % 512)) % 512);
        if (type === 120 || type === 103) paxOverrides(metadata, type === 103 ? globals : local);
        else if (type === 76) longName = tarString(metadata);
        continue;
      }
      path = local.path ?? longName ?? globals.path ?? path;
      const size = local.size ?? globals.size ?? headerSize;
      local = {};
      longName = undefined;
      if (type === 83 || ![0, 48, 49, 50, 51, 52, 53, 54, 55].includes(type)) {
        throw new Error("TAR entry requires the compatibility decoder");
      }
      if (type === 0 || type === 48 || type === 55) {
        if (size > 0 && !shouldSkip(path)) {
          if (size > 0x7fffffff)
            throw new Error(`Archive entry exceeds the browser size limit: ${path}`);
          const data = await input.read(size);
          totalBytes += size;
          onEntry(path, data);
        } else {
          await input.consume(size);
          if (size) onSkipped(path);
        }
      } else {
        onSkipped(path);
        await input.consume(size);
      }
      await input.consume((512 - (size % 512)) % 512);
    }
  } finally {
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}
