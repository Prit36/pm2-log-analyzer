import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** COOP/COEP keep crossOriginIsolated available for any SAB use; Wasm path does not require it. */
const coiHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

// https://vite.dev/config/
export default defineConfig({
  clearScreen: false,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    headers: coiHeaders,
    // Cargo/tauri builds write thousands of files into src-tauri/target, and the
    // watcher sends every one of those events to the dev server, which stalls
    // module responses for seconds (measured: 16.4s to first paint while a
    // build runs vs 0.5s idle). Nothing under src-tauri is part of the web app.
    watch: { ignored: ["**/src-tauri/**", "**/target/**"] },
  },
  preview: { headers: coiHeaders },
  worker: {
    format: "es",
    plugins: () => [],
  },
});
