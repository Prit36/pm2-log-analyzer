/**
 * One browser run against the real Vite app (Web Worker + React + Zustand).
 * Usage: node scripts/bench/runBrowserOnce.mjs <baseUrl> <logfile>
 * Progress logs → stderr; result JSON → stdout.
 */
import { chromium } from "playwright";
import { execFileSync, execSync } from "node:child_process";
import { statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:4173";
const filePath = resolve(process.argv[3] ?? "test_data/api-out-5gb.log");
const fileBytes = statSync(filePath).size;

function log(...args) {
  console.error("[bench]", ...args);
}

/** Sum WorkingSet of all Playwright-launched Chromium processes (browser + GPU + renderers + workers). */
function playwrightChromiumRssMB() {
  try {
    if (process.platform === "win32") {
      const script = `
$procs = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -match '^(chrome|chrome-headless-shell|headless_shell|chromium)\\.exe$' -and
  ($_.CommandLine -match 'ms-playwright' -or $_.CommandLine -match 'playwright_chromium')
}
if (-not $procs) { Write-Output 0; exit 0 }
Write-Output (($procs | Measure-Object -Property WorkingSetSize -Sum).Sum)
`;
      const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
        encoding: "utf8",
      }).trim();
      const bytes = Number(out.split(/\r?\n/).filter(Boolean).at(-1));
      return Number.isFinite(bytes) && bytes > 0 ? bytes / (1024 * 1024) : null;
    }
    const out = execSync(
      "ps -eo rss=,args= | grep -E 'ms-playwright|playwright_chromium' | grep -v grep | awk '{s+=$1} END {print s+0}'",
      { encoding: "utf8", shell: "/bin/bash" },
    ).trim();
    const kb = Number(out);
    return Number.isFinite(kb) && kb > 0 ? kb / 1024 : null;
  } catch {
    return null;
  }
}

log("launch chromium");
const browser = await chromium.launch({
  headless: true,
  args: ["--disable-dev-shm-usage", "--enable-precise-memory-info"],
});

const context = await browser.newContext();
const page = await context.newPage();
page.setDefaultTimeout(120_000);

page.on("pageerror", (err) => log("pageerror", err.message));
page.on("console", (msg) => {
  if (msg.type() === "error") log("console.error", msg.text());
});

const cdp = await context.newCDPSession(page);
await cdp.send("Performance.enable");

async function chromeMetrics() {
  const { metrics } = await cdp.send("Performance.getMetrics");
  const map = Object.fromEntries(metrics.map((m) => [m.name, m.value]));
  // Prefer CDP heap sizes (bytes) — covers main isolate; worker is separate.
  const cdpUsed = map.JSHeapUsedSize ?? null;
  const cdpTotal = map.JSHeapTotalSize ?? null;
  return {
    jsHeapUsedMB: cdpUsed != null ? cdpUsed / (1024 * 1024) : null,
    jsHeapTotalMB: cdpTotal != null ? cdpTotal / (1024 * 1024) : null,
    taskDuration: map.TaskDuration ?? null,
    scriptDuration: map.ScriptDuration ?? null,
    layoutCount: map.LayoutCount ?? null,
  };
}

const memSamples = [];
async function sample(label) {
  const chrome = await chromeMetrics();
  const rss = playwrightChromiumRssMB();
  memSamples.push({
    label,
    t: performance.now(),
    browserRssMB: rss,
    jsHeapUsedMB: chrome.jsHeapUsedMB,
    jsHeapTotalMB: chrome.jsHeapTotalMB,
  });
  log(
    `mem[${label}] RSS=${rss != null ? rss.toFixed(0) + "MB" : "?"}  heap=${chrome.jsHeapUsedMB != null ? chrome.jsHeapUsedMB.toFixed(1) + "MB" : "?"}`,
  );
  return chrome;
}

try {
  log("goto", baseUrl);
  await page.goto(baseUrl, { waitUntil: "load", timeout: 30_000 });

  log("wait file input");
  await page.waitForSelector('[data-testid="log-file-input"]', {
    state: "attached",
    timeout: 15_000,
  });

  await page.evaluate(() => {
    delete window.__PM2_BENCH__;
  });

  await sample("before");
  const wall0 = performance.now();

  log("setInputFiles", basename(filePath), `${(fileBytes / 1024 / 1024).toFixed(1)} MB`);
  await page.setInputFiles('[data-testid="log-file-input"]', filePath);

  // Sample while parsing (worker holds most memory here)
  const parsePoll = setInterval(() => {
    void sample("parsing");
  }, 1500);

  log("wait parse complete (__PM2_BENCH__)");
  await page.waitForFunction(
    () =>
      typeof window.__PM2_BENCH__?.parseWallMs === "number" && window.__PM2_BENCH__.parseWallMs > 0,
    undefined,
    { timeout: 10 * 60 * 1000 },
  );
  clearInterval(parsePoll);

  log("wait KPI row");
  await page.waitForSelector('[data-testid="kpi-row"]', { timeout: 30_000 });
  const uploadToReadyMs = performance.now() - wall0;
  log(`parse done in ${(uploadToReadyMs / 1000).toFixed(2)}s (upload→KPI)`);
  await sample("after-parse");

  await page.evaluate(() => {
    if (window.__PM2_BENCH__) {
      window.__PM2_BENCH__.reaggTimes = [];
      window.__PM2_BENCH__.reaggStages = [];
    }
  });

  async function waitReaggCount(n) {
    await page.waitForFunction(
      (need) => (window.__PM2_BENCH__?.reaggTimes?.length ?? 0) >= need,
      n,
      { timeout: 180_000 },
    );
  }

  log("reagg #1 status=2xx");
  await page.selectOption('[data-testid="filter-status"]', "2xx");
  await waitReaggCount(1);
  await sample("reagg-1");

  log("reagg #2 status=all");
  await page.selectOption('[data-testid="filter-status"]', "all");
  await waitReaggCount(2);
  await sample("reagg-2");

  log("reagg #3 minMs=50");
  await page.locator('[data-testid="filter-min-ms"]').evaluate((el) => {
    const input = /** @type {HTMLInputElement} */ (el);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, "50");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await waitReaggCount(3);
  await sample("reagg-3");

  const finalBench = await page.evaluate(() => window.__PM2_BENCH__);
  const reaggTimes = finalBench?.reaggTimes ?? [];
  const metricsAfter = await chromeMetrics();
  const workerWasmHeapMB = finalBench?.workerWasmHeapMB ?? null;

  const rssVals = memSamples
    .map((s) => s.browserRssMB)
    .filter((n) => typeof n === "number" && n > 0);
  const heapVals = memSamples.map((s) => s.jsHeapUsedMB).filter((n) => typeof n === "number");

  log("done");
  await browser.close();

  const out = {
    method: "browser-app",
    baseUrl,
    filePath,
    fileBytes,
    fileMB: fileBytes / (1024 * 1024),
    fileName: basename(filePath),
    parse: {
      wallMs: finalBench.parseWallMs,
      wallSec: finalBench.parseWallMs / 1000,
      uploadToReadyMs,
      uploadToReadySec: uploadToReadyMs / 1000,
      throughputMBps: fileBytes / (1024 * 1024) / (finalBench.parseWallMs / 1000),
    },
    stages: finalBench.stages ?? null,
    reaggregate: {
      runs: reaggTimes.length,
      wallMs: reaggTimes,
      avgWallMs: reaggTimes.length
        ? reaggTimes.reduce((a, b) => a + b, 0) / reaggTimes.length
        : null,
      stages: finalBench.reaggStages ?? [],
    },
    memory: {
      browserRssBeforeMB: memSamples.find((s) => s.label === "before")?.browserRssMB ?? null,
      browserRssAfterMB: memSamples.at(-1)?.browserRssMB ?? null,
      browserRssPeakMB: rssVals.length ? Math.max(...rssVals) : null,
      workerWasmHeapMB,
      jsHeapUsedBeforeMB: memSamples.find((s) => s.label === "before")?.jsHeapUsedMB ?? null,
      jsHeapUsedAfterMB: metricsAfter.jsHeapUsedMB,
      jsHeapPeakMB: heapVals.length ? Math.max(...heapVals) : null,
      jsHeapTotalAfterMB: metricsAfter.jsHeapTotalMB,
      samples: memSamples.length,
      note: "browserRssPeakMB = sum of Playwright Chromium process WorkingSets (includes workers). jsHeap* = main-world isolate only.",
    },
    chrome: {
      taskDuration: metricsAfter.taskDuration,
      scriptDuration: metricsAfter.scriptDuration,
      layoutCount: metricsAfter.layoutCount,
    },
    result: {
      matched: finalBench.matched,
      unmatched: finalBench.unmatched,
      apiEndpoints: finalBench.apiEndpoints,
      cronJobs: finalBench.cronJobs,
      p95Ms: finalBench.p95Ms,
    },
  };

  process.stdout.write(JSON.stringify(out) + "\n");
} catch (err) {
  log("FAILED", err);
  try {
    await browser.close();
  } catch {
    /* ignore */
  }
  process.exit(1);
}
