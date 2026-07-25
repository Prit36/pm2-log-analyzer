import { PM2_CORE_WASM_BASE64 } from "./pm2CoreBytes";

let cachedBytes: Uint8Array | null = null;
let cachedModule: WebAssembly.Module | null = null;

export function pm2CoreWasmBytes(): Uint8Array {
  if (cachedBytes) return cachedBytes;
  const bin = atob(PM2_CORE_WASM_BASE64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  cachedBytes = out;
  return out;
}

/** Compile once on the coordinator; Module is structured-cloneable to workers. */
export async function compilePm2CoreModule(): Promise<WebAssembly.Module> {
  if (cachedModule) return cachedModule;
  cachedModule = await WebAssembly.compile(pm2CoreWasmBytes());
  return cachedModule;
}
