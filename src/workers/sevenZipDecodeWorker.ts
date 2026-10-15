import init, { FastDecompressor } from "../wasm/pkg_zip/zip_core.js";

export type SevenZipPart = { offset: number; length: number };
export type SevenZipJob = {
  input: Blob;
  dictionary: number;
  size: number;
  parts: SevenZipPart[];
};
export type SevenZipDecoded = { buffer: ArrayBuffer; checksums: number[]; error?: string };
type DecodeMessage = { module: WebAssembly.Module } | SevenZipJob;

declare const self: {
  onmessage: ((event: MessageEvent<DecodeMessage>) => Promise<void>) | null;
  postMessage(message: SevenZipDecoded, transfer?: Transferable[]): void;
};

let decoder: FastDecompressor | undefined;
let memory: WebAssembly.Memory | undefined;
let ready: Promise<void> | undefined;

self.onmessage = async ({ data }) => {
  if ("module" in data) {
    ready = init({ module_or_path: data.module }).then((output) => {
      memory = output.memory;
      decoder = new FastDecompressor();
    });
    return;
  }
  try {
    await ready;
    const compressed = new Uint8Array(await data.input.arrayBuffer());
    const pointer = decoder!.decompress_lzma2(compressed, data.dictionary, data.size);
    const checksums = data.parts.map((part) => decoder!.output_crc(part.offset, part.length));
    const buffer = memory!.buffer.slice(pointer, pointer + data.size);
    self.postMessage({ buffer, checksums }, [buffer]);
  } catch (error) {
    self.postMessage({
      buffer: new ArrayBuffer(0),
      checksums: [],
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
