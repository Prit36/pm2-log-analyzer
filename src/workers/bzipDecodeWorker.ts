import init, { BzipBlockDecoder } from "../wasm/pkg_zip/zip_core.js";

export type BzipJob = { file: File; start: number; end: number };
export type BzipDecoded = {
  buffer: ArrayBuffer;
  crc: number;
  end: number;
  length: number;
  error?: string;
};

declare const self: {
  onmessage:
    | ((event: MessageEvent<{ module: WebAssembly.Module } | BzipJob>) => Promise<void>)
    | null;
  postMessage(message: BzipDecoded, transfer?: Transferable[]): void;
};

let decoder: BzipBlockDecoder;
let memory: WebAssembly.Memory;
let ready: Promise<void>;
// pbz2-core bounds compressed blocks to 2,400,000 bytes; allow marker/alignment bytes.
const MAX_BLOCK_INPUT = 2_400_016;
self.onmessage = async ({ data }) => {
  if ("module" in data) {
    ready = init({ module_or_path: data.module }).then((output) => {
      memory = output.memory;
      decoder = new BzipBlockDecoder();
    });
    return;
  }
  try {
    await ready;
    const start = Math.floor(data.start / 8);
    let input = new Uint8Array(
      await data.file
        .slice(start, Math.min(Math.ceil(data.end / 8), start + MAX_BLOCK_INPUT))
        .arrayBuffer(),
    );
    let pointer: number;
    try {
      pointer = decoder.decode(input, data.start % 8);
    } catch (error) {
      // Scanner candidates can occur inside compressed data. Decode past a false
      // candidate; the coordinator ignores markers swallowed by this block.
      if (!String(error).includes("Truncated")) throw error;
      input = new Uint8Array(await data.file.slice(start, start + MAX_BLOCK_INPUT).arrayBuffer());
      pointer = decoder.decode(input, data.start % 8);
    }
    const buffer = memory.buffer.slice(pointer, pointer + decoder.output_len());
    self.postMessage(
      {
        buffer,
        crc: decoder.crc(),
        end: start * 8 + decoder.end_bit(),
        length: decoder.block_length(),
      },
      [buffer],
    );
  } catch (error) {
    self.postMessage({
      buffer: new ArrayBuffer(0),
      crc: 0,
      end: 0,
      length: 0,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
