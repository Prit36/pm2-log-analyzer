/**
 * Detect whether the application is running inside Tauri desktop shell.
 */
export function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
}
