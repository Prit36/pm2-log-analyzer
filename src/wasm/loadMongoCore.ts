import { MONGO_CORE_WASM_BASE64 } from "./mongoCoreBytes";

let cachedBytes: Uint8Array | null = null;
let cachedModule: WebAssembly.Module | null = null;

export function mongoCoreWasmBytes(): Uint8Array {
  if (cachedBytes) return cachedBytes;
  const bin = atob(MONGO_CORE_WASM_BASE64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  cachedBytes = out;
  return out;
}

/** Compile once; Module is structured-cloneable to Web Workers. */
export async function compileMongoCoreModule(): Promise<WebAssembly.Module> {
  if (cachedModule) return cachedModule;
  // SAFETY: Base64 decoded bytes produce an ArrayBuffer-backed Uint8Array matching the Wasm BufferSource interface.
  cachedModule = await WebAssembly.compile(mongoCoreWasmBytes() as BufferSource);
  return cachedModule;
}
