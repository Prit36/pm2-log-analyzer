/**
 * Benchmark the Tauri native pipeline end-to-end: upload -> first painted UI.
 *
 * Usage:
 *   node scripts/bench/bench_native_tauri.mjs [logfile] [--runs N] [--port 9222] [--exe PATH] [--keep-open]
 *
 * Prerequisites:
 *   pnpm tauri build --no-bundle        # optimized app at src-tauri/target/release/app.exe
 *
 * How it works: launches (or reuses) the release app with WebView2 remote debugging,
 * opts the app into its benchmark hook via localStorage, then drives the exact same
 * `handleNativePathsUpload` path a file drop uses and reads the timings the app logs:
 *   ui ready = upload -> KPI row painted (double rAF)
 *   invoke   = native parse + aggregation + JSON + IPC
 *   assemble = JSON.parse + store update
 *   native   = Rust-reported wall (excludes IPC)
 * Progress logs -> stderr, final result JSON -> stdout.
 */
import { spawn, execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const has = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
};

const filePath = resolve(args[0] ?? "test_data/api-out-5gb.log");
const runs = Number(flag("runs") ?? 3);
const port = Number(flag("port") ?? 9222);
const exePath = resolve(flag("exe") ?? "src-tauri/target/release/app.exe");
const keepOpen = has("keep-open");
const fileBytes = statSync(filePath).size;

const log = (...a) => console.error("[bench]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cdpBase = `http://127.0.0.1:${port}`;
const NATIVE_LINE =
  /\[native\] ui ready in ([\d.]+)ms \(invoke ([\d.]+)ms, assemble ([\d.]+)ms, native ([\d.]+)ms\)/;

async function cdpAlive() {
  try {
    const res = await fetch(`${cdpBase}/json/version`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function pageTarget() {
  const targets = await (await fetch(`${cdpBase}/json`)).json();
  return targets.find((t) => t.type === "page" && t.url.startsWith("http"));
}

let appPid = null;
async function launchApp() {
  if (await cdpAlive()) {
    log(`reusing app already listening on :${port}`);
    return;
  }
  log(`launching ${exePath}`);
  const child = spawn(exePath, [], {
    cwd: resolve("src-tauri"),
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
    stdio: "ignore",
    detached: false,
  });
  appPid = child.pid;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (await cdpAlive()) return;
  }
  throw new Error("app did not open the remote debugging port");
}

function killApp() {
  if (appPid === null) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(appPid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(appPid, "SIGKILL");
    }
  } catch {
    // already gone
  }
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.consoleLines = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.method === "Runtime.consoleAPICalled") {
        const text = (m.params.args ?? []).map((a) => a.value ?? "").join(" ");
        if (text.includes("[native]")) this.consoleLines.push(text);
      }
      const resolvePending = this.pending.get(m.id);
      if (resolvePending) {
        this.pending.delete(m.id);
        resolvePending(m);
      }
    };
  }

  static async connect() {
    const target = await pageTarget();
    if (!target) throw new Error("no app page target");
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    const cdp = new Cdp(ws);
    await cdp.send("Runtime.enable");
    return cdp;
  }

  send(method, params = {}) {
    return new Promise((resolve) => {
      const id = ++this.id;
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: false,
    });
    if (r.result?.exceptionDetails) {
      throw new Error(`page exception: ${JSON.stringify(r.result.exceptionDetails)}`);
    }
    return r.result?.result?.value;
  }

  lastNative() {
    for (let i = this.consoleLines.length - 1; i >= 0; i--) {
      const m = NATIVE_LINE.exec(this.consoleLines[i]);
      if (m)
        return {
          line: this.consoleLines[i],
          uiReadyMs: +m[1],
          invokeMs: +m[2],
          assembleMs: +m[3],
          nativeMs: +m[4],
        };
    }
    return null;
  }
}

try {
  await launchApp();
  log("connecting to webview");
  const cdp = await Cdp.connect();

  const url = await cdp.eval("location.href");
  if (!url.startsWith("http://tauri.localhost")) {
    log(`WARNING: page is ${url} — this is a dev-mode binary, not the bundled app`);
  }

  log('enabling benchmark hook (localStorage["pm2-native-bench"] = "1")');
  await cdp.eval(
    `localStorage.setItem("pm2-native-bench","1"); localStorage.removeItem("app-analyzer-mode"); location.reload()`,
  );
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const ready = await cdp.eval(
      `document.querySelector('[data-testid="log-file-input"], [data-testid="mongo-log-file-input"]') !== null`,
    );
    if (ready) break;
    if (i === 59) throw new Error("app UI did not load after reload");
  }
  const hook = await cdp.eval(`typeof window.__nativeUpload`);
  if (hook !== "function")
    throw new Error("benchmark hook not installed (rebuild with pnpm tauri build --no-bundle)");

  log(`file: ${filePath} (${(fileBytes / 1024 / 1024).toFixed(1)} MB), runs: ${runs}`);
  const results = [];
  for (let run = 0; run < runs; run++) {
    cdp.consoleLines = [];
    const t0 = Date.now();
    await cdp.eval(
      "window.__nativeUpload([" +
        JSON.stringify(filePath) +
        "]).catch(e => { window.__benchErr = String(e) })",
    );
    let measured = null;
    while (Date.now() - t0 < 10 * 60 * 1000) {
      await sleep(50);
      const err = await cdp.eval("window.__benchErr ?? null");
      if (err) throw new Error(`native upload failed: ${err}`);
      measured = cdp.lastNative();
      if (measured) break;
    }
    if (!measured) throw new Error("timed out waiting for the [native] timing line");
    const wallMs = Date.now() - t0;
    const row = { run: run + 1, wallMs, ...measured };
    results.push(row);
    log(
      `run ${run + 1}/${runs}: ui ready ${measured.uiReadyMs.toFixed(0)}ms ` +
        `(invoke ${measured.invokeMs.toFixed(0)}, assemble ${measured.assembleMs.toFixed(0)}, native ${measured.nativeMs.toFixed(0)})`,
    );
  }

  const avg = (key) => results.reduce((s, r) => s + r[key], 0) / results.length;
  const min = (key) => Math.min(...results.map((r) => r[key]));
  const best = min("uiReadyMs");
  const output = {
    method: "tauri-native",
    app: exePath,
    file: filePath,
    fileMB: fileBytes / (1024 * 1024),
    runs: results.map((r) => ({
      uiReadyMs: r.uiReadyMs,
      invokeMs: r.invokeMs,
      assembleMs: r.assembleMs,
      nativeMs: r.nativeMs,
    })),
    summary: {
      uiReadyMs: {
        avg: avg("uiReadyMs"),
        min: best,
        max: Math.max(...results.map((r) => r.uiReadyMs)),
      },
      invokeMs: { avg: avg("invokeMs") },
      assembleMs: { avg: avg("assembleMs") },
      nativeMs: { avg: avg("nativeMs") },
      throughputMBps: fileBytes / (1024 * 1024) / (best / 1000),
    },
  };
  console.log(JSON.stringify(output, null, 2));
} catch (err) {
  log(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  if (!keepOpen) killApp();
}
