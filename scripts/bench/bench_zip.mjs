/**
 * Benchmark the REAL browser app for ZIP Archive Upload & Classification.
 * (Chromium + Vite preview + Wasm zip-core + Web Workers + React).
 *
 * Defaults: C:/Users/My_Home/Downloads/methaq-api&mongodb-07-09.zip (81.2MB) × 3 runs
 *
 * Usage:
 *   pnpm bench:zip
 *   pnpm bench:zip -- --runs 3 --note "baseline"
 *   node scripts/bench/bench_zip.mjs --runs 1 --skip-build
 *
 * History: scripts/bench/zip_history.json
 */
import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:net";

const HISTORY_PATH = resolve("scripts/bench/zip_history.json");
const PORT = 4175;
const BASE = `http://127.0.0.1:${PORT}`;
const DEFAULT_ZIP = "C:/Users/My_Home/Downloads/methaq-api&mongodb-07-09.zip";

function parseArgs(argv) {
  const args = {
    file: DEFAULT_ZIP,
    runs: 3,
    note: "",
    skipBuild: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--runs") args.runs = Math.max(1, Number(argv[++i]) || 3);
    else if (a === "--note") args.note = argv[++i] ?? "";
    else if (a === "--skip-build") args.skipBuild = true;
    else if (a.startsWith("-")) {
      console.error("Unknown flag:", a);
      process.exit(1);
    } else rest.push(a);
  }
  if (rest[0]) args.file = rest[0];
  return args;
}

function avg(nums) {
  return nums.reduce((a, b) => a + b, 0) / nums.length;
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

function portFree(port) {
  return new Promise((res) => {
    const s = createServer();
    s.once("error", () => res(false));
    s.once("listening", () => {
      s.close();
      res(true);
    });
    s.listen(port, "127.0.0.1");
  });
}

function run(cmd, args, opts = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, {
      stdio: opts.stdio ?? "inherit",
      env: { ...process.env, ...opts.env },
      shell: opts.shell ?? false,
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`));
      else resolvePromise();
    });
  });
}

function runCapture(cmd, args) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    const errChunks = [];
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => {
      errChunks.push(d);
      process.stderr.write(d);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const stdout = Buffer.concat(chunks).toString("utf8").trim();
      const stderr = Buffer.concat(errChunks).toString("utf8");
      if (code !== 0) reject(new Error(`${args.join(" ")} exited ${code}\n${stderr}\n${stdout}`));
      else {
        try {
          resolvePromise(JSON.parse(stdout.split("\n").filter(Boolean).at(-1)));
        } catch {
          reject(new Error(`invalid JSON\n${stdout}\n${stderr}`));
        }
      }
    });
  });
}

async function waitForServer(url, ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Server not ready: ${url}`);
}

const { file, runs, note, skipBuild } = parseArgs(process.argv.slice(2));
const absFile = resolve(file);
if (!existsSync(absFile)) {
  console.error("ZIP log file not found:", absFile);
  process.exit(1);
}

console.log("=== ZIP ARCHIVE LOG INGESTION BENCHMARK ===");
console.log("Target: REAL browser app (Chromium + Wasm zip-core + Web Workers)");
console.log(`File: ${absFile}`);
console.log(`Runs: ${runs}`);
if (note) console.log(`Note: ${note}`);

if (!skipBuild) {
  console.log("\nBuilding production bundle…");
  await run(process.execPath, [resolve("node_modules/vite/bin/vite.js"), "build"]);
} else if (!existsSync(resolve("dist/index.html"))) {
  console.error("dist/ missing — run without --skip-build");
  process.exit(1);
}

if (!(await portFree(PORT))) {
  console.error(`Port ${PORT} in use — stop other preview servers or wait a moment`);
  process.exit(1);
}

console.log(`Starting preview on ${BASE} …`);
const preview = spawn(
  process.execPath,
  [
    resolve("node_modules/vite/bin/vite.js"),
    "preview",
    "--host",
    "127.0.0.1",
    "--port",
    String(PORT),
    "--strictPort",
  ],
  { stdio: ["ignore", "pipe", "pipe"], env: process.env },
);
preview.stderr.on("data", (d) => process.stderr.write(d));
preview.stdout.on("data", (d) => process.stderr.write(d));

try {
  await waitForServer(BASE);

  const iterations = [];
  for (let i = 1; i <= runs; i++) {
    console.log(`--- run ${i}/${runs} ---`);
    const r = await runCapture(process.execPath, [
      resolve("scripts/bench/runZipBrowserOnce.mjs"),
      BASE,
      absFile,
    ]);
    iterations.push(r);
    console.log(
      `  extract ${r.extract.wallSec.toFixed(2)}s  ready ${r.pipeline.uploadToReadySec.toFixed(2)}s  ${r.extract.throughputMBps.toFixed(1)} MB/s  RSS peak ${r.memory.browserRssPeakMB?.toFixed?.(0) ?? "?"} MB`,
    );
  }

  const extractSec = iterations.map((r) => r.extract.wallSec);
  const readySec = iterations.map((r) => r.pipeline.uploadToReadySec);
  const throughput = iterations.map((r) => r.extract.throughputMBps);
  const peakRss = iterations.map((r) => r.memory.browserRssPeakMB).filter(Number.isFinite);
  const peakHeap = iterations.map((r) => r.memory.jsHeapPeakMB).filter(Number.isFinite);

  const session = {
    id: new Date().toISOString(),
    method: "browser-app",
    app: "zip-archive",
    note: note || null,
    git: gitMeta(),
    file: absFile,
    fileMB: iterations[0].fileMB,
    runs,
    classification: iterations[0].classification,
    summary: {
      extractWallSec: {
        avg: avg(extractSec),
        stddev: stddev(extractSec),
        min: Math.min(...extractSec),
        max: Math.max(...extractSec),
      },
      uploadToReadySec: {
        avg: avg(readySec),
        stddev: stddev(readySec),
        min: Math.min(...readySec),
        max: Math.max(...readySec),
      },
      throughputMBps: {
        avg: avg(throughput),
        stddev: stddev(throughput),
        min: Math.min(...throughput),
        max: Math.max(...throughput),
      },
      browserRssPeakMB: peakRss.length
        ? {
            avg: avg(peakRss),
            stddev: stddev(peakRss),
            min: Math.min(...peakRss),
            max: Math.max(...peakRss),
          }
        : null,
      jsHeapPeakMB: peakHeap.length
        ? {
            avg: avg(peakHeap),
            stddev: stddev(peakHeap),
            min: Math.min(...peakHeap),
            max: Math.max(...peakHeap),
          }
        : null,
    },
    iterations: iterations.map((r, i) => ({
      run: i + 1,
      extractWallSec: r.extract.wallSec,
      uploadToReadySec: r.pipeline.uploadToReadySec,
      throughputMBps: r.extract.throughputMBps,
      browserRssPeakMB: r.memory.browserRssPeakMB,
      jsHeapPeakMB: r.memory.jsHeapPeakMB,
      jsHeapUsedAfterMB: r.memory.jsHeapUsedAfterMB,
    })),
  };

  const history = loadHistory();
  history.push(session);
  writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2) + "\n");

  console.log("\n=== ZIP ARCHIVE BENCHMARK SUMMARY (avg of", runs, "runs) ===");
  console.log(
    `extract wall (Wasm): ${session.summary.extractWallSec.avg.toFixed(2)}s ± ${session.summary.extractWallSec.stddev.toFixed(2)}`,
  );
  console.log(
    `upload→ready total:  ${session.summary.uploadToReadySec.avg.toFixed(2)}s ± ${session.summary.uploadToReadySec.stddev.toFixed(2)}`,
  );
  console.log(`throughput:          ${session.summary.throughputMBps.avg.toFixed(1)} MB/s`);
  if (session.summary.browserRssPeakMB)
    console.log(
      `Chromium RSS peak:   ${session.summary.browserRssPeakMB.avg.toFixed(0)} MB (all Chromium procs)`,
    );
  if (session.summary.jsHeapPeakMB)
    console.log(`JS heap peak:        ${session.summary.jsHeapPeakMB.avg.toFixed(1)} MB`);

  console.log(`\nClassification Results:`);
  console.log(`  Total Log Files:   ${session.classification.totalFiles}`);
  console.log(`  PM2 API Logs:      ${session.classification.pm2Files}`);
  console.log(`  MongoDB Logs:      ${session.classification.mongoFiles}`);
  console.log(`  Skipped Entries:   ${session.classification.skippedFiles}`);

  console.log(`\nAppended → ${HISTORY_PATH} (session ${history.length})`);
} finally {
  preview.kill();
}
