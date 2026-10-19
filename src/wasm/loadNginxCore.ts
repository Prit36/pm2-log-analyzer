import { NGINX_CORE_WASM_BASE64 } from "./nginxCoreBytes";

let cachedBytes: Uint8Array | null = null;
let cachedModule: WebAssembly.Module | null = null;
let compiling: Promise<WebAssembly.Module> | null = null;

export function nginxCoreWasmBytes(): Uint8Array {
  if (cachedBytes) return cachedBytes;
  const bin = atob(NGINX_CORE_WASM_BASE64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  cachedBytes = out;
  return out;
}

/** Compile once; Module is structured-cloneable to Web Workers. */
export async function compileNginxCoreModule(): Promise<WebAssembly.Module> {
  if (cachedModule) return cachedModule;
  if (!compiling) {
    // SAFETY: Decoded Wasm bytes are ArrayBuffer-backed and satisfy BufferSource.
    compiling = WebAssembly.compile(nginxCoreWasmBytes() as BufferSource).then((module) => {
      cachedModule = module;
      return module;
    });
  }
  return compiling;
}
