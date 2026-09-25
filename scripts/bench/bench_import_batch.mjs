import { spawn, execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { homedir } from "node:os";
import { createServer } from "node:net";
import { performance } from "node:perf_hooks";
import { chromium } from "playwright";

const DEFAULT_FILES = [
  "monday-14-09.zip",
  "16-09-api.zip",
  "21-09-api.zip",
  "12-days-pm2logs-5-to-16-sep.zip",
  "pm2.log.2.gz",
  "api-error.log.2.gz",
  "24-09-api.zip",
  "api-out.log.2.gz",
  "22-09-all-logs.zip",
].map((name) => resolve(homedir(), "Downloads", name));
const HISTORY_PATH = resolve("scripts/bench/import_batch_history.json");
const args = process.argv.slice(2);
const options = {
  target: "both",
  runs: 1,
  expect: "both",
  port: 9230,
  note: "",
  noHistory: false,
};
const paths = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--") continue;
  if (arg === "--skip-build") options.skipBuild = true;
  else if (arg === "--no-history") options.noHistory = true;
  else if (arg.startsWith("--")) {
    const key = arg.slice(2);
    if (!(key in options)) throw new Error(`Unknown option: ${arg}`);
    options[key] = args[++i];
  } else paths.push(resolve(arg));
}

options.runs = Math.max(1, Number(options.runs) || 1);
options.port = Number(options.port) || 9230;
const targets = options.target === "both" ? ["browser", "native"] : [options.target];
if (targets.some((target) => !["browser", "native"].includes(target))) {
  throw new Error("--target must be browser, native, or both");
}
if (!["pm2", "mongo", "both"].includes(options.expect)) {
  throw new Error("--expect must be pm2, mongo, or both");
}
const inputPaths = paths.length > 0 ? paths : DEFAULT_FILES;
const inputs = inputPaths.map((path) => {
  if (!existsSync(path)) throw new Error(`Input file not found: ${path}`);
  return { path, name: basename(path), bytes: statSync(path).size };
});
const inputBytes = inputs.reduce((sum, file) => sum + file.bytes, 0);
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const log = (...values) => console.error("[batch-bench]", ...values);
const nativeLine =
  /\[native\] ui ready in ([\d.]+)ms \(invoke ([\d.]+)ms, assemble ([\d.]+)ms, native ([\d.]+)ms\)/;

function startRssSampler(kind, rootPid) {
  if (process.platform !== "win32") {
    return { samples: [], ready: Promise.resolve(), stop: async () => {} };
  }
  const script =
    kind === "native"
      ? `
$ErrorActionPreference = 'SilentlyContinue'
$root = [uint32]${rootPid}
$procs = @(Get-CimInstance Win32_Process)
$ids = [System.Collections.Generic.HashSet[uint32]]::new()
[void]$ids.Add($root)
$changed = $true
while ($changed) {
  $changed = $false
  foreach ($p in $procs) {
    if ($ids.Contains([uint32]$p.ParentProcessId) -and $ids.Add([uint32]$p.ProcessId)) { $changed = $true }
  }
}
$processIds = [int[]]@($ids | ForEach-Object { [int]$_ })
`
      : `
$ErrorActionPreference = 'SilentlyContinue'
$procs = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -match '^(chrome|chrome-headless-shell|headless_shell|chromium)\\.exe$' -and
  ($_.CommandLine -match 'ms-playwright' -or $_.CommandLine -match 'playwright_chromium')
})
$processIds = [int[]]@($procs | ForEach-Object { [int]$_.ProcessId })
`;
  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `${script}
while ($true) {
  $total = 0L
  foreach ($p in @(Get-Process -Id $processIds -ErrorAction SilentlyContinue)) { $total += [int64]$p.WorkingSet64 }
  [Console]::Out.WriteLine("$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()),$total")
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 100
}`,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const samples = [];
  let pending = "";
  let readyResolve;
  let readyReject;
  let readySettled = false;
  const ready = new Promise((resolvePromise, reject) => {
    readyResolve = resolvePromise;
    readyReject = reject;
  });
  const readyTimeout = setTimeout(() => {
    if (readySettled) return;
    readySettled = true;
    readyReject(new Error("RSS sampler did not produce a sample"));
  }, 10_000);
  const closed = new Promise((resolvePromise) => child.once("close", resolvePromise));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const [timestamp, bytes] = line.split(",");
      const rssMB = Number(bytes) / (1024 * 1024);
      if (!Number.isFinite(rssMB) || rssMB <= 0) continue;
      samples.push({ at: performance.now(), timestamp: Number(timestamp), rssMB });
      if (!readySettled) {
        readySettled = true;
        clearTimeout(readyTimeout);
        readyResolve();
      }
    }
  });
  child.once("error", (error) => {
    if (readySettled) return;
    readySettled = true;
    clearTimeout(readyTimeout);
    readyReject(error);
  });
  child.once("close", () => {
    if (readySettled) return;
    readySettled = true;
    clearTimeout(readyTimeout);
    readyReject(new Error("RSS sampler exited before producing a sample"));
  });
  let stopped = false;
  return {
    samples,
    ready,
    stop: async () => {
      if (!stopped) {
        stopped = true;
        child.kill();
      }
      await closed;
    },
  };
}

function stats(rows, key) {
  const values = rows.map((row) => row[key]).filter(Number.isFinite);
  if (values.length === 0) return null;
  return {
    avg: values.reduce((sum, value) => sum + value, 0) / values.length,
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function maxFinite(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length > 0 ? Math.max(...finite) : null;
}

async function portFree(port) {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once("error", () => resolvePromise(false));
    server.once("listening", () => server.close(() => resolvePromise(true)));
    server.listen(port, "127.0.0.1");
  });
}

async function freePort(start) {
  for (let port = start; port < start + 100; port++) {
    if (await portFree(port)) return port;
  }
  throw new Error(`No free debugging port near ${start}`);
}

async function waitForCdp(port) {
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    try {
      const response = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return base;
    } catch {
      await sleep(250);
    }
  }
  throw new Error(`WebView2 did not open remote debugging port ${port}`);
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.id = 0;
    this.pending = new Map();
    this.consoleLines = [];
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.method === "Runtime.consoleAPICalled") {
        const text = (message.params.args ?? []).map((arg) => arg.value ?? "").join(" ");
        if (text.includes("[native]")) this.consoleLines.push(text);
      }
      const resolvePending = this.pending.get(message.id);
      if (resolvePending) {
        this.pending.delete(message.id);
        resolvePending(message);
      }
    };
  }

  static async connect(base) {
    let target;
    let lastTargets = [];
    for (let i = 0; i < 120; i++) {
      lastTargets = await (await fetch(`${base}/json`)).json();
      target = lastTargets.find((item) => item.type === "page" && item.url.startsWith("http"));
      if (target) break;
      await sleep(250);
    }
    if (!target) throw new Error(`No WebView2 page target found: ${JSON.stringify(lastTargets)}`);
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolvePromise, reject) => {
      socket.onopen = resolvePromise;
      socket.onerror = reject;
    });
    const cdp = new Cdp(socket);
    await cdp.send("Runtime.enable");
    return cdp;
  }

  send(method, params = {}) {
    return new Promise((resolvePromise) => {
      const id = ++this.id;
      this.pending.set(id, resolvePromise);
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: false,
    });
    if (response.result?.exceptionDetails) {
      throw new Error(
        `WebView evaluation failed: ${JSON.stringify(response.result.exceptionDetails)}`,
      );
    }
    return response.result?.result?.value;
  }

  latestNativeTiming() {
    for (let i = this.consoleLines.length - 1; i >= 0; i--) {
      const match = nativeLine.exec(this.consoleLines[i]);
      if (match) {
        return {
          uiReadyMs: Number(match[1]),
          invokeMs: Number(match[2]),
          assembleMs: Number(match[3]),
          nativeMs: Number(match[4]),
        };
      }
    }
    return null;
  }
}

async function runBrowser() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-dev-shm-usage", "--enable-precise-memory-info"],
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(15 * 60 * 1000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  const heapSamples = [];
  const captureHeap = async (label) => {
    const { metrics } = await cdp.send("Performance.getMetrics");
    const map = Object.fromEntries(metrics.map((metric) => [metric.name, metric.value]));
    heapSamples.push({
      label,
      at: performance.now(),
      jsHeapMB: Number.isFinite(map.JSHeapUsedSize) ? map.JSHeapUsedSize / (1024 * 1024) : null,
    });
  };

  let rssSampler;
  let startedAt = 0;
  let sampling = false;
  let sampler = Promise.resolve();
  try {
    await page.goto("http://127.0.0.1:4175", { waitUntil: "load", timeout: 30_000 });
    await page.waitForSelector('[data-testid="log-file-input"]', { state: "attached" });
    await page.evaluate(() => {
      delete window.__PM2_BENCH__;
      delete window.__MONGO_BENCH__;
      delete window.__ZIP_BENCH__;
    });
    rssSampler = startRssSampler("browser");
    await rssSampler.ready;
    await captureHeap("before");
    sampling = true;
    sampler = (async () => {
      while (sampling) {
        await sleep(500);
        if (sampling) await captureHeap("ingest");
      }
    })();

    startedAt = performance.now();
    await page.setInputFiles(
      '[data-testid="log-file-input"]',
      inputs.map((file) => file.path),
    );
    await page.waitForFunction(
      (expect) => {
        const pm2 = (window.__PM2_BENCH__?.parseWallMs ?? 0) > 0;
        const mongo = (window.__MONGO_BENCH__?.parseWallMs ?? 0) > 0;
        return (expect === "mongo" || pm2) && (expect === "pm2" || mongo);
      },
      options.expect,
      { timeout: 15 * 60 * 1000 },
    );
    await page.waitForFunction(
      () =>
        Boolean(document.querySelector('[data-testid="kpi-row"], [data-testid="mongo-kpi-row"]')),
      undefined,
      { timeout: 30_000 },
    );
    await page.evaluate(
      () =>
        new Promise((resolvePromise) =>
          requestAnimationFrame(() => requestAnimationFrame(resolvePromise)),
        ),
    );
    const uploadToReadyMs = performance.now() - startedAt;
    const parserStats = await page.evaluate(() => ({
      pm2: window.__PM2_BENCH__ ?? null,
      mongo: window.__MONGO_BENCH__ ?? null,
    }));
    const activeText = await page.locator("body").innerText();
    if (errors.length > 0) throw new Error(`Browser page errors: ${errors.join(" | ")}`);
    sampling = false;
    await sampler;
    await captureHeap("after-ready");
    await rssSampler.stop();
    const rssSamples = rssSampler.samples;
    return {
      uploadToReadyMs,
      rssBeforeMB: rssSamples[0]?.rssMB ?? null,
      rssPeakMB: maxFinite(rssSamples.map((sample) => sample.rssMB)),
      rssAfterMB: rssSamples.at(-1)?.rssMB ?? null,
      rssSamples: rssSamples.map((sample) => ({
        ms: Math.round(sample.at - startedAt),
        rssMB: sample.rssMB,
      })),
      jsHeapPeakMB: maxFinite(heapSamples.map((sample) => sample.jsHeapMB)),
      samples: rssSamples.length,
      pm2: parserStats.pm2
        ? {
            fileCount: Number.parseInt(parserStats.pm2.fileName ?? "", 10) || 1,
            bytes: parserStats.pm2.fileBytes ?? 0,
            parseWallMs: parserStats.pm2.parseWallMs ?? 0,
            requests: parserStats.pm2.matched ?? 0,
            endpoints: parserStats.pm2.apiEndpoints ?? 0,
            workerWasmHeapMB: parserStats.pm2.workerWasmHeapMB ?? null,
            stages: parserStats.pm2.stages ?? null,
            reaggStages: parserStats.pm2.reaggStages ?? [],
          }
        : null,
      mongo: parserStats.mongo
        ? {
            fileCount: Number.parseInt(parserStats.mongo.fileName ?? "", 10) || 1,
            bytes: parserStats.mongo.fileBytes ?? 0,
            parseWallMs: parserStats.mongo.parseWallMs ?? 0,
            slowQueries: parserStats.mongo.slowQueryCount ?? 0,
            patterns: parserStats.mongo.patternsCount ?? 0,
          }
        : null,
      uiSummary: activeText.match(/Parsed[^\n]*/)?.[0] ?? null,
    };
  } finally {
    sampling = false;
    await sampler;
    await rssSampler?.stop();
    await browser.close();
  }
}

async function runNative(portStart) {
  const exePath = resolve("src-tauri/target/release/app.exe");
  if (!existsSync(exePath)) throw new Error(`Native app not found: ${exePath}`);
  const port = await freePort(portStart);
  const child = spawn(exePath, [], {
    cwd: resolve("src-tauri"),
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
    stdio: "ignore",
  });
  const appPid = child.pid;
  if (!appPid) throw new Error("Failed to launch the Tauri app");

  let cdp;
  let rssSampler;
  try {
    const base = await waitForCdp(port);
    cdp = await Cdp.connect(base);
    await cdp.evaluate(
      'localStorage.setItem("pm2-native-bench","1"); localStorage.removeItem("app-analyzer-mode"); location.reload()',
    );
    for (let i = 0; i < 120; i++) {
      await sleep(250);
      if (await cdp.evaluate('typeof window.__nativeUpload === "function"')) break;
      if (i === 119) throw new Error("Native benchmark hook did not load after reload");
    }

    await cdp.evaluate("delete window.__benchErr; delete window.__MONGO_BENCH__;");
    await cdp.evaluate(UI_PROBE_INSTALL_JS);
    rssSampler = startRssSampler("native", appPid);
    await rssSampler.ready;
    const startedPerf = performance.now();
    const startedAt = Date.now();
    await cdp.evaluate(
      `window.__nativeUpload(${JSON.stringify(inputs.map((file) => file.path))}).catch(error => { window.__benchErr = String(error) })`,
    );
    let timing = null;
    while (Date.now() - startedAt < 15 * 60 * 1000) {
      await sleep(100);
      const error = await cdp.evaluate("window.__benchErr ?? null");
      if (error) throw new Error(`Native ingest failed: ${error}`);
      timing = cdp.latestNativeTiming();
      if (timing) break;
    }
    if (!timing) throw new Error("Timed out waiting for native UI-ready timing");
    const ui = await cdp.evaluate(UI_PROBE_READ_JS);
    const toast = await cdp.evaluate(
      'document.querySelector(".fixed.bottom-4.right-4")?.textContent ?? null',
    );
    const mongo = await cdp.evaluate("window.__MONGO_BENCH__ ?? null");
    await rssSampler.stop();
    const rssSamples = rssSampler.samples;
    return {
      ...timing,
      wallMs: Date.now() - startedAt,
      rssBeforeMB: rssSamples[0]?.rssMB ?? null,
      rssPeakMB: maxFinite(rssSamples.map((sample) => sample.rssMB)),
      rssAfterMB: rssSamples.at(-1)?.rssMB ?? null,
      rssSamples: rssSamples.map((sample) => ({
        ms: Math.round(sample.at - startedPerf),
        rssMB: sample.rssMB,
      })),
      samples: rssSamples.length,
      maxFrameGapMs: ui?.maxFrameGapMs ?? null,
      mongoSlowQueries: mongo?.slowQueryCount ?? null,
      mongoPatterns: mongo?.patternsCount ?? null,
      toast,
    };
  } finally {
    await rssSampler?.stop();
    cdp?.socket.close();
    try {
      if (process.platform === "win32") {
        execFileSync("taskkill", ["/PID", String(appPid), "/T", "/F"], { stdio: "ignore" });
      } else {
        process.kill(appPid, "SIGKILL");
      }
    } catch {
      // The app may already have exited.
    }
  }
}

const UI_PROBE_INSTALL_JS = `(() => {
  const probe = (window.__ui = { frames: 0, maxFrameGapMs: 0, mutations: 0, last: performance.now() });
  const frame = () => {
    const now = performance.now();
    probe.maxFrameGapMs = Math.max(probe.maxFrameGapMs, now - probe.last);
    probe.last = now;
    probe.frames++;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  new MutationObserver(() => probe.mutations++).observe(document.body, { subtree: true, childList: true, characterData: true });
})()`;
const UI_PROBE_READ_JS = `(() => ({
  frames: window.__ui?.frames ?? 0,
  maxFrameGapMs: Math.round(window.__ui?.maxFrameGapMs ?? 0),
  mutations: window.__ui?.mutations ?? 0,
}))()`;

if (!options.skipBuild) {
  if (targets.includes("browser")) {
    log("building browser app");
    execSync("pnpm run build", { stdio: "inherit" });
  }
  if (targets.includes("native")) {
    log("building Tauri app");
    execSync("pnpm tauri:build:exe", { stdio: "inherit" });
  }
}

let preview;
try {
  if (targets.includes("browser")) {
    if (!existsSync(resolve("dist/index.html")))
      throw new Error("dist/ is missing; run with build enabled");
    preview = spawn(
      process.execPath,
      [
        resolve("node_modules/vite/bin/vite.js"),
        "preview",
        "--host",
        "127.0.0.1",
        "--port",
        "4175",
        "--strictPort",
      ],
      { stdio: "ignore" },
    );
    let ready = false;
    for (let i = 0; i < 200; i++) {
      try {
        const response = await fetch("http://127.0.0.1:4175");
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        await sleep(100);
      }
    }
    if (!ready) throw new Error("Vite preview did not become ready on port 4175");
  }

  log(
    `target=${options.target} runs=${options.runs} files=${inputs.length} compressedMiB=${(inputBytes / (1024 * 1024)).toFixed(1)} note=${options.note || "(none)"}`,
  );
  const results = {};
  for (const target of targets) {
    results[target] = [];
    for (let run = 1; run <= options.runs; run++) {
      log(`${target} run ${run}/${options.runs}`);
      const result =
        target === "browser" ? await runBrowser() : await runNative(options.port + run - 1);
      results[target].push(result);
      log(
        `  UI-ready=${(result.uploadToReadyMs ?? result.uiReadyMs).toFixed(0)}ms RSS-peak=${Number.isFinite(result.rssPeakMB) ? `${result.rssPeakMB.toFixed(0)}MiB` : "unavailable"}`,
      );
    }
  }

  const session = {
    at: new Date().toISOString(),
    note: options.note || null,
    target: options.target,
    runs: options.runs,
    gitCommit: execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(),
    runtime: { platform: process.platform, arch: process.arch, node: process.version },
    inputs: inputs.map(({ name, bytes }) => ({ name, bytes })),
    inputBytes,
    summary: Object.fromEntries(
      Object.entries(results).map(([target, rows]) => [
        target,
        {
          uploadToReadyMs: stats(rows, "uploadToReadyMs") ?? stats(rows, "uiReadyMs"),
          rssPeakMB: stats(rows, "rssPeakMB"),
          jsHeapPeakMB: stats(rows, "jsHeapPeakMB"),
          nativeMs: stats(rows, "nativeMs"),
        },
      ]),
    ),
    iterations: results,
  };
  if (!options.noHistory) {
    const history = existsSync(HISTORY_PATH) ? JSON.parse(readFileSync(HISTORY_PATH, "utf8")) : [];
    history.push(session);
    writeFileSync(HISTORY_PATH, `${JSON.stringify(history, null, 2)}\n`);
    log(`results appended to ${HISTORY_PATH}`);
  }
  console.log(JSON.stringify(session, null, 2));
} finally {
  preview?.kill();
}
