/**
 * One browser run for MongoDB Log Analyzer against the real Vite app (Web Worker + React + Zustand).
 * Usage: node scripts/bench/runMongoBrowserOnce.mjs <baseUrl> <logfile>
 * Progress logs → stderr; result JSON → stdout.
 */
import { chromium } from "playwright";
import { execFileSync, execSync } from "node:child_process";
import { statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:4173";
const filePath = resolve(process.argv[3] ?? "mongodb_logs_sample/methaq-mongod.log");
const fileBytes = statSync(filePath).size;

function log(...args) {
  console.error("[mongo-bench]", ...args);
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
page.setDefaultTimeout(180_000);

page.on("pageerror", (err) => log("pageerror", err.message));
page.on("console", (msg) => {
  if (msg.type() === "error") log("console.error", msg.text());
});

const cdp = await context.newCDPSession(page);
await cdp.send("Performance.enable");

async function chromeMetrics() {
  const { metrics } = await cdp.send("Performance.getMetrics");
  const map = Object.fromEntries(metrics.map((m) => [m.name, m.value]));
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

  log("switch to MongoDB Logs tab");
  await page.click('[data-testid="app-switcher-mongo"]');

  log("wait file input");
  await page.waitForSelector('[data-testid="mongo-log-file-input"]', {
    state: "attached",
    timeout: 15_000,
  });

  await page.evaluate(() => {
    delete window.__MONGO_BENCH__;
  });

  await sample("before");
  const wall0 = performance.now();

  log("setInputFiles", basename(filePath), `${(fileBytes / 1024 / 1024).toFixed(1)} MB`);
  await page.setInputFiles('[data-testid="mongo-log-file-input"]', filePath);

  // Sample while parsing (streaming chunks)
  const parsePoll = setInterval(() => {
    void sample("parsing");
  }, 1000);

  log("wait parse complete (__MONGO_BENCH__)");
  await page.waitForFunction(
    () =>
      Number.isFinite(window.__MONGO_BENCH__?.parseWallMs) &&
      (window.__MONGO_BENCH__?.parseWallMs ?? 0) > 0,
    undefined,
    { timeout: 10 * 60 * 1000 },
  );
  clearInterval(parsePoll);

  log("wait KPI row");
  await page.waitForSelector('[data-testid="mongo-kpi-row"]', { timeout: 30_000 });
  const uploadToReadyMs = performance.now() - wall0;
  log(`parse done in ${(uploadToReadyMs / 1000).toFixed(2)}s (upload→KPI)`);
  await sample("after-parse");

  await page.evaluate(() => {
    if (window.__MONGO_BENCH__) {
      window.__MONGO_BENCH__.reaggTimes = [];
    }
  });

  async function waitReaggCount(n) {
    await page.waitForFunction(
      (need) => (window.__MONGO_BENCH__?.reaggTimes?.length ?? 0) >= need,
      n,
      { timeout: 60_000 },
    );
  }

  log("reagg #1 COLLSCAN only");
  await page.click('[data-testid="mongo-filter-plan-collscan"]');
  await waitReaggCount(1);
  await sample("reagg-1");

  log("reagg #2 All Plans");
  await page.click('[data-testid="mongo-filter-plan-all"]');
  await waitReaggCount(2);
  await sample("reagg-2");

  log("reagg #3 minDuration >100ms");
  await page.click('[data-testid="mongo-filter-duration-100"]');
  await waitReaggCount(3);
  await sample("reagg-3");

  const finalBench = await page.evaluate(() => window.__MONGO_BENCH__);
  const reaggTimes = finalBench?.reaggTimes ?? [];
  const metricsAfter = await chromeMetrics();

  const rssVals = memSamples.map((s) => s.browserRssMB).filter((n) => Number.isFinite(n) && n > 0);
  const heapVals = memSamples.map((s) => s.jsHeapUsedMB).filter(Number.isFinite);

  log("done");
  await browser.close();

  const out = {
    method: "browser-app",
    app: "mongodb",
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
    reaggregate: {
      runs: reaggTimes.length,
      wallMs: reaggTimes,
      avgWallMs: reaggTimes.length
        ? reaggTimes.reduce((a, b) => a + b, 0) / reaggTimes.length
        : null,
    },
    memory: {
      browserRssBeforeMB: memSamples.find((s) => s.label === "before")?.browserRssMB ?? null,
      browserRssAfterMB: memSamples.at(-1)?.browserRssMB ?? null,
      browserRssPeakMB: rssVals.length ? Math.max(...rssVals) : null,
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
      slowQueryCount: finalBench.slowQueryCount,
      collscanCount: finalBench.collscanCount,
      patternsCount: finalBench.patternsCount,
      collectionsCount: finalBench.collectionsCount,
      p95DurationMs: finalBench.p95DurationMs,
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
