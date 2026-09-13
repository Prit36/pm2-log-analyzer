/**
 * Benchmark the Tauri native pipeline for MongoDB Logs end-to-end:
 * upload -> first painted UI -> real interactive reaggregations.
 *
 * Usage:
 *   node scripts/bench/bench_native_mongo.mjs [logfile] [--runs N] [--port 9222] [--exe PATH] [--keep-open] [--note "..."]
 *   pnpm bench:native:mongo
 *
 * Prerequisites:
 *   pnpm tauri:build:exe (or pnpm tauri build --no-bundle)
 *
 * History: scripts/bench/native_mongo_history.json
 */
import { spawn, execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const HISTORY_PATH = resolve("scripts/bench/native_mongo_history.json");

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

const runs = Number(flag("runs") ?? 3);
const port = Number(flag("port") ?? 9222);
const exePath = resolve(flag("exe") ?? "src-tauri/target/release/app.exe");
const keepOpen = has("keep-open");
const note = flag("note") ?? "";
const skipBuild = has("skip-build");
const filePath = resolve(args[0] ?? "mongodb_logs_sample/methaq-mongod.log");

if (!existsSync(filePath)) {
  console.error("MongoDB log file not found:", filePath);
  process.exit(1);
}

const fileBytes = statSync(filePath).size;
const log = (...a) => console.error("[mongo-native-bench]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cdpBase = `http://127.0.0.1:${port}`;
const NATIVE_LINE =
  /\[native\] ui ready in ([\d.]+)ms \(invoke ([\d.]+)ms, assemble ([\d.]+)ms, native ([\d.]+)ms\)/;

function avg(nums) {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

function stddev(nums) {
  if (nums.length < 2) return 0;
  const m = avg(nums);
  return Math.sqrt(avg(nums.map((n) => (n - m) ** 2)));
}

function loadHistory() {
  if (!existsSync(HISTORY_PATH)) return [];
  try {
    return JSON.parse(readFileSync(HISTORY_PATH, "utf8"));
  } catch {
    return [];
  }
}

function gitMeta() {
  try {
    const commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
    const dirty = execSync("git status --porcelain", { encoding: "utf8" }).trim().length > 0;
    return { commit, branch, dirty };
  } catch {
    return null;
  }
}

function nativeRssMB(pid) {
  try {
    if (process.platform === "win32") {
      const script = `
$targetPid = ${pid ?? 0}
$app = if ($targetPid -gt 0) { Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -eq $targetPid } } else { Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^app\\.exe$' } }
$wv = Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^msedgewebview2\\.exe$' }
$all = @($app) + @($wv) | Where-Object { $_ } | Select-Object -Unique ProcessId, WorkingSetSize
if (-not $all) { Write-Output 0; exit 0 }
Write-Output (($all | Measure-Object -Property WorkingSetSize -Sum).Sum)
`;
      const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
        encoding: "utf8",
      }).trim();
      const bytes = Number(out.split(/\r?\n/).filter(Boolean).at(-1));
      return Number.isFinite(bytes) && bytes > 0 ? bytes / (1024 * 1024) : null;
    }
    return null;
  } catch {
    return null;
  }
}

const UI_PROBE_INSTALL_JS = `(() => {
  const u = (window.__ui = {
    frames: 0,
    maxFrameGapMs: 0,
    mutations: 0,
    timeline: [],
    startedAt: performance.now(),
    lastFrameAt: performance.now(),
  });
  const frame = () => {
    const now = performance.now();
    const gap = now - u.lastFrameAt;
    if (gap > u.maxFrameGapMs) u.maxFrameGapMs = gap;
    u.lastFrameAt = now;
    u.frames++;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  new MutationObserver(() => {
    u.mutations++;
    if (u.timeline.length < 40) {
      u.timeline.push([
        Math.round(performance.now() - u.startedAt),
        document.body.innerText.replace(/\\s+/g, " ").slice(0, 60),
      ]);
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true });
  return true;
})()`;

const UI_PROBE_READ_JS = `(() => {
  const u = window.__ui;
  return {
    frames: u.frames,
    maxFrameGapMs: Math.round(u.maxFrameGapMs),
    mutations: u.mutations,
    timeline: u.timeline,
    elapsedMs: Math.round(performance.now() - u.startedAt),
    visibility: document.visibilityState,
  };
})()`;

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
  if (!existsSync(exePath) && !skipBuild) {
    log(`building release app (${exePath}) …`);
    execSync("pnpm tauri:build:exe", { stdio: "inherit" });
  }
  if (!existsSync(exePath)) {
    throw new Error(`executable not found at ${exePath}`);
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

  log('enabling benchmark hook and setting mode="mongo"');
  await cdp.eval(
    `localStorage.setItem("pm2-native-bench","1"); localStorage.setItem("app-analyzer-mode","mongo"); location.reload()`,
  );
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const ready = await cdp.eval(
      `document.querySelector('[data-testid="mongo-log-file-input"], [data-testid="log-file-input"]') !== null`,
    );
    if (ready) break;
    if (i === 59) throw new Error("app UI did not load after reload");
  }

  // Ensure switcher is on mongo
  const isMongoTab = await cdp.eval(
    `document.querySelector('[data-testid="mongo-log-file-input"]') !== null`,
  );
  if (!isMongoTab) {
    log("clicking mongo tab switcher");
    await cdp.eval(`document.querySelector('[data-testid="app-switcher-mongo"]')?.click()`);
    await sleep(200);
  }

  const hook = await cdp.eval(`typeof window.__nativeUpload`);
  if (hook !== "function")
    throw new Error("benchmark hook not installed (rebuild with pnpm tauri:build:exe)");

  log(`file: ${filePath} (${(fileBytes / 1024 / 1024).toFixed(1)} MB), runs: ${runs}`);
  if (note) log(`note: ${note}`);

  const results = [];
  for (let run = 0; run < runs; run++) {
    cdp.consoleLines = [];
    await cdp.eval(
      `delete window.__benchErr; if (window.__MONGO_BENCH__) window.__MONGO_BENCH__.reaggTimes = [];`,
    );
    await cdp.eval(UI_PROBE_INSTALL_JS);

    const rssBefore = nativeRssMB(appPid);
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

    // Wait for KPI row
    let kpiReady = false;
    for (let k = 0; k < 100; k++) {
      kpiReady = await cdp.eval(`document.querySelector('[data-testid="mongo-kpi-row"]') !== null`);
      if (kpiReady) break;
      await sleep(50);
    }
    if (!kpiReady) throw new Error('timed out waiting for [data-testid="mongo-kpi-row"]');

    const wallMs = Date.now() - t0;
    const ui = await cdp.eval(UI_PROBE_READ_JS);
    const toast = await cdp.eval(
      `document.querySelector('.fixed.bottom-4.right-4')?.textContent ?? null`,
    );

    const rssPeak = nativeRssMB(appPid);

    // --- Interactive Reaggregations ---
    log(`  [run ${run + 1}] executing 3 interactive reaggregations…`);
    await cdp.eval(`if (window.__MONGO_BENCH__) window.__MONGO_BENCH__.reaggTimes = [];`);

    // Reagg #1: COLLSCAN only
    const reagg1_t0 = Date.now();
    await cdp.eval(`document.querySelector('[data-testid="mongo-filter-plan-collscan"]')?.click()`);
    for (let w = 0; w < 100; w++) {
      const cnt = await cdp.eval(`window.__MONGO_BENCH__?.reaggTimes?.length ?? 0`);
      if (cnt >= 1) break;
      await sleep(20);
    }
    const reagg1_wall = Date.now() - reagg1_t0;

    // Reagg #2: All Plans
    const reagg2_t0 = Date.now();
    await cdp.eval(`document.querySelector('[data-testid="mongo-filter-plan-all"]')?.click()`);
    for (let w = 0; w < 100; w++) {
      const cnt = await cdp.eval(`window.__MONGO_BENCH__?.reaggTimes?.length ?? 0`);
      if (cnt >= 2) break;
      await sleep(20);
    }
    const reagg2_wall = Date.now() - reagg2_t0;

    // Reagg #3: minDuration > 100ms
    const reagg3_t0 = Date.now();
    await cdp.eval(`document.querySelector('[data-testid="mongo-filter-duration-100"]')?.click()`);
    for (let w = 0; w < 100; w++) {
      const cnt = await cdp.eval(`window.__MONGO_BENCH__?.reaggTimes?.length ?? 0`);
      if (cnt >= 3) break;
      await sleep(20);
    }
    const reagg3_wall = Date.now() - reagg3_t0;

    const mongoBench = await cdp.eval(`window.__MONGO_BENCH__ ?? null`);
    const reaggTimes = mongoBench?.reaggTimes ?? [reagg1_wall, reagg2_wall, reagg3_wall];
    const avgReagg = avg(reaggTimes);

    const row = {
      run: run + 1,
      wallMs,
      ...measured,
      ui,
      toast,
      rssBeforeMB: rssBefore,
      rssPeakMB: rssPeak,
      reaggregations: {
        timesMs: reaggTimes,
        avgMs: avgReagg,
      },
      mongoResult: {
        slowQueryCount: mongoBench?.slowQueryCount ?? null,
        collscanCount: mongoBench?.collscanCount ?? null,
        patternsCount: mongoBench?.patternsCount ?? null,
        collectionsCount: mongoBench?.collectionsCount ?? null,
        p95DurationMs: mongoBench?.p95DurationMs ?? null,
      },
    };
    results.push(row);

    log(
      `run ${run + 1}/${runs}: ui ready ${measured.uiReadyMs.toFixed(0)}ms ` +
        `(invoke ${measured.invokeMs.toFixed(0)}, assemble ${measured.assembleMs.toFixed(0)}, native ${measured.nativeMs.toFixed(0)}) ` +
        `reaggAvg ${avgReagg.toFixed(0)}ms RSS peak ${rssPeak != null ? rssPeak.toFixed(0) + "MB" : "?"}`,
    );
    log(`  parsed: ${toast}`);
    log(
      `  ui: ${ui.frames} frames, longest freeze ${ui.maxFrameGapMs}ms, ${ui.mutations} dom updates (${ui.visibility})`,
    );
  }

  const avgKey = (key) => results.reduce((s, r) => s + r[key], 0) / results.length;
  const minKey = (key) => Math.min(...results.map((r) => r[key]));
  const maxKey = (key) => Math.max(...results.map((r) => r[key]));

  const bestReady = minKey("uiReadyMs");
  const bestNative = minKey("nativeMs");
  const avgReaggAcrossRuns = avg(results.map((r) => r.reaggregations.avgMs));

  const output = {
    method: "tauri-native",
    app: "mongodb",
    exe: exePath,
    file: filePath,
    fileName: basename(filePath),
    fileBytes,
    fileMB: fileBytes / (1024 * 1024),
    runs: results.map((r) => ({
      uiReadyMs: r.uiReadyMs,
      invokeMs: r.invokeMs,
      assembleMs: r.assembleMs,
      nativeMs: r.nativeMs,
      maxFrameGapMs: r.ui.maxFrameGapMs,
      domUpdates: r.ui.mutations,
      reaggAvgMs: r.reaggregations.avgMs,
      reaggTimesMs: r.reaggregations.timesMs,
      rssPeakMB: r.rssPeakMB,
      toast: r.toast,
    })),
    summary: {
      uiReadyMs: {
        avg: avgKey("uiReadyMs"),
        stddev: stddev(results.map((r) => r.uiReadyMs)),
        min: bestReady,
        max: maxKey("uiReadyMs"),
      },
      nativeMs: {
        avg: avgKey("nativeMs"),
        stddev: stddev(results.map((r) => r.nativeMs)),
        min: bestNative,
        max: maxKey("nativeMs"),
      },
      invokeMs: { avg: avgKey("invokeMs") },
      assembleMs: { avg: avgKey("assembleMs") },
      throughputMBps: fileBytes / (1024 * 1024) / (bestReady / 1000),
      nativeThroughputMBps: fileBytes / (1024 * 1024) / (bestNative / 1000),
      uiMaxFrameGapMs: {
        avg: results.reduce((s, r) => s + r.ui.maxFrameGapMs, 0) / results.length,
        max: Math.max(...results.map((r) => r.ui.maxFrameGapMs)),
      },
      uiMutations: { avg: results.reduce((s, r) => s + r.ui.mutations, 0) / results.length },
      reaggregate: {
        avgWallMs: avgReaggAcrossRuns,
      },
      rssPeakMB: {
        max: Math.max(...results.map((r) => r.rssPeakMB ?? 0)),
      },
    },
    result: results[0].mongoResult,
  };

  const history = loadHistory();
  const session = {
    id: new Date().toISOString(),
    method: "tauri-native",
    app: "mongodb",
    note: note || null,
    git: gitMeta(),
    file: filePath,
    fileMB: output.fileMB,
    runs,
    result: output.result,
    summary: {
      uiReadyMs: output.summary.uiReadyMs,
      nativeMs: output.summary.nativeMs,
      invokeMs: output.summary.invokeMs,
      assembleMs: output.summary.assembleMs,
      throughputMBps: output.summary.throughputMBps,
      nativeThroughputMBps: output.summary.nativeThroughputMBps,
      reaggAvgMs: avgReaggAcrossRuns,
      peakRssMB: output.summary.rssPeakMB.max,
    },
  };
  history.push(session);
  writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));

  console.log(JSON.stringify(output, null, 2));
} catch (err) {
  log(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  if (!keepOpen) killApp();
}
