import init, { XzBlockDecoder } from "../wasm/pkg_zip/zip_core.js";

export type XzJob = {
  file: File;
  start: number;
  size: number;
  unpadded: number;
  uncompressed: number;
  check: number;
};
export type XzDecoded = { buffer: ArrayBuffer; error?: string };

declare const self: {
  onmessage:
    | ((event: MessageEvent<{ module: WebAssembly.Module } | XzJob>) => Promise<void>)
    | null;
  postMessage(message: XzDecoded, transfer?: Transferable[]): void;
};

let decoder: XzBlockDecoder;
let memory: WebAssembly.Memory;
let ready: Promise<void>;
self.onmessage = async ({ data }) => {
  if ("module" in data) {
    ready = init({ module_or_path: data.module }).then((output) => {
      memory = output.memory;
      decoder = new XzBlockDecoder();
    });
    return;
  }
  try {
    await ready;
    const input = new Uint8Array(
      await data.file.slice(data.start, data.start + data.size).arrayBuffer(),
    );
    const pointer = decoder.decode(input, data.check, data.unpadded, data.uncompressed);
    const buffer = memory.buffer.slice(pointer, pointer + decoder.output_len());
    self.postMessage({ buffer }, [buffer]);
  } catch (error) {
    self.postMessage({
      buffer: new ArrayBuffer(0),
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
