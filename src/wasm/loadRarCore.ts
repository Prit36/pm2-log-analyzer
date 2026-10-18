import rarCoreUrl from "./pkg_rar/rar_core_bg.wasm?url";

let cachedModule: Promise<WebAssembly.Module> | undefined;

/** Compile on first RAR upload; callers share the same pending compilation. */
export function compileRarCoreModule(): Promise<WebAssembly.Module> {
  if (!cachedModule) {
    cachedModule = WebAssembly.compileStreaming(fetch(rarCoreUrl));
  }
  return cachedModule;
}
