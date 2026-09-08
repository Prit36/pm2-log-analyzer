/**
 * One browser run for ZIP Archive Ingestion & Classification against the real Vite app.
 * Usage: node scripts/bench/runZipBrowserOnce.mjs <baseUrl> <zipPath>
 * Progress logs → stderr; result JSON → stdout.
 */
import { chromium } from "playwright";
import { execFileSync, execSync } from "node:child_process";
import { statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:4173";
const defaultZip = "C:/Users/My_Home/Downloads/methaq-api&mongodb-07-09.zip";
const filePath = resolve(process.argv[3] ?? defaultZip);
const fileBytes = statSync(filePath).size;

function log(...args) {
  console.error("[zip-bench]", ...args);
}

/** Sum WorkingSet of all Playwright-launched Chromium processes. */
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

  log("wait file input");
  await page.waitForSelector('[data-testid="log-file-input"]', {
    state: "attached",
    timeout: 15_000,
  });

  await page.evaluate(() => {
    delete window.__ZIP_BENCH__;
    delete window.__PM2_BENCH__;
    delete window.__MONGO_BENCH__;
  });

  await sample("before");
  const wall0 = performance.now();

  log("setInputFiles", basename(filePath), `${(fileBytes / 1024 / 1024).toFixed(1)} MB`);
  await page.setInputFiles('[data-testid="log-file-input"]', filePath);

  // Sample memory while extracting & ingesting
  const poll = setInterval(() => {
    void sample("extracting");
  }, 500);

  log("wait zip extraction (__ZIP_BENCH__)");
  await page.waitForFunction(
    () =>
      Number.isFinite(window.__ZIP_BENCH__?.extractWallMs) &&
      (window.__ZIP_BENCH__?.extractWallMs ?? 0) > 0,
    undefined,
    { timeout: 180_000 },
  );

  const zipBench = await page.evaluate(() => window.__ZIP_BENCH__);
  log(
    `zip extraction done in ${zipBench.extractWallMs}ms (${zipBench.pm2FilesCount} API, ${zipBench.mongoFilesCount} Mongo, ${zipBench.skippedFilesCount} skipped)`,
  );

  // Wait for downstream parsers to finish
  if (zipBench.pm2FilesCount > 0) {
    log("wait PM2 parse complete");
    await page.waitForFunction(
      () =>
        Number.isFinite(window.__PM2_BENCH__?.parseWallMs) &&
        (window.__PM2_BENCH__?.parseWallMs ?? 0) > 0,
      undefined,
      { timeout: 180_000 },
    );
    await page.waitForSelector('[data-testid="kpi-row"]', { timeout: 30_000 });
  }

  if (zipBench.mongoFilesCount > 0) {
    log("wait Mongo parse complete");
    await page.waitForFunction(
      () =>
        Number.isFinite(window.__MONGO_BENCH__?.parseWallMs) &&
        (window.__MONGO_BENCH__?.parseWallMs ?? 0) > 0,
      undefined,
      { timeout: 180_000 },
    );
  }

  clearInterval(poll);
  const uploadToReadyMs = performance.now() - wall0;
  log(`all logs parsed and ready in ${(uploadToReadyMs / 1000).toFixed(2)}s (upload→ready)`);
  await sample("after-ready");

  const metricsAfter = await chromeMetrics();
  const rssVals = memSamples.map((s) => s.browserRssMB).filter((n) => Number.isFinite(n) && n > 0);
  const heapVals = memSamples.map((s) => s.jsHeapUsedMB).filter(Number.isFinite);

  const decompressedMB = zipBench.totalDecompressedBytes / (1024 * 1024);
  const extractSec = zipBench.extractWallMs / 1000;
  const throughputMBps = extractSec > 0 ? decompressedMB / extractSec : 0;

  log("done");
  await browser.close();

  const out = {
    method: "browser-app",
    app: "zip-archive",
    baseUrl,
    filePath,
    fileBytes,
    fileMB: fileBytes / (1024 * 1024),
    fileName: basename(filePath),
    extract: {
      wallMs: zipBench.extractWallMs,
      wallSec: extractSec,
      decompressedMB,
      throughputMBps,
    },
    pipeline: {
      uploadToReadyMs,
      uploadToReadySec: uploadToReadyMs / 1000,
    },
    classification: {
      totalFiles: zipBench.totalFiles,
      pm2Files: zipBench.pm2FilesCount,
      mongoFiles: zipBench.mongoFilesCount,
      skippedFiles: zipBench.skippedFilesCount,
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
    },
    chrome: {
      taskDuration: metricsAfter.taskDuration,
      scriptDuration: metricsAfter.scriptDuration,
      layoutCount: metricsAfter.layoutCount,
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
