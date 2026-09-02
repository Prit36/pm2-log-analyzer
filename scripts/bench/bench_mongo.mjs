/**
 * Benchmark the REAL browser app for MongoDB Logs (Chromium + Vite preview + Web Worker).
 *
 * Defaults: mongodb_logs_sample/methaq-mongod.log (352MB) × 3 runs
 *
 * Usage:
 *   pnpm bench:mongo
 *   pnpm bench:mongo -- --runs 3 --note "baseline"
 *   node scripts/bench/bench_mongo.mjs --runs 1 --skip-build
 *
 * History: scripts/bench/mongo_history.json
 */
import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:net";

const HISTORY_PATH = resolve("scripts/bench/mongo_history.json");
const PORT = 4174;
const BASE = `http://127.0.0.1:${PORT}`;

function parseArgs(argv) {
  const args = {
    file: "mongodb_logs_sample/methaq-mongod.log",
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
  console.error("MongoDB log file not found:", absFile);
  process.exit(1);
}

console.log("=== MONGODB LOG ANALYZER BENCHMARK ===");
console.log("Target: REAL browser app (Chromium + Web Worker + React)");
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
      resolve("scripts/bench/runMongoBrowserOnce.mjs"),
      BASE,
      absFile,
    ]);
    iterations.push(r);
    console.log(
      `  parse ${r.parse.wallSec.toFixed(2)}s (app)  ready ${r.parse.uploadToReadySec.toFixed(2)}s  ${r.parse.throughputMBps.toFixed(1)} MB/s  RSS peak ${r.memory.browserRssPeakMB?.toFixed?.(0) ?? "?"} MB  reaggAvg ${r.reaggregate.avgWallMs?.toFixed?.(0) ?? "?"} ms`,
    );
  }

  const parseWallSec = iterations.map((r) => r.parse.wallSec);
  const readySec = iterations.map((r) => r.parse.uploadToReadySec);
  const throughput = iterations.map((r) => r.parse.throughputMBps);
  const peakRss = iterations.map((r) => r.memory.browserRssPeakMB).filter(Number.isFinite);
  const peakHeap = iterations.map((r) => r.memory.jsHeapPeakMB).filter(Number.isFinite);
  const reaggAvg = iterations.map((r) => r.reaggregate.avgWallMs).filter(Number.isFinite);

  const session = {
    id: new Date().toISOString(),
    method: "browser-app",
    app: "mongodb",
    note: note || null,
    git: gitMeta(),
    file: absFile,
    fileMB: iterations[0].fileMB,
    runs,
    result: iterations[0].result,
    summary: {
      parseWallSec: {
        avg: avg(parseWallSec),
        stddev: stddev(parseWallSec),
        min: Math.min(...parseWallSec),
        max: Math.max(...parseWallSec),
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
      reaggAvgMs: reaggAvg.length
        ? {
            avg: avg(reaggAvg),
            stddev: stddev(reaggAvg),
            min: Math.min(...reaggAvg),
            max: Math.max(...reaggAvg),
          }
        : null,
    },
    iterations: iterations.map((r, i) => ({
      run: i + 1,
      parseWallSec: r.parse.wallSec,
      uploadToReadySec: r.parse.uploadToReadySec,
      throughputMBps: r.parse.throughputMBps,
      reaggAvgMs: r.reaggregate.avgWallMs,
      reaggWallMs: r.reaggregate.wallMs,
      browserRssPeakMB: r.memory.browserRssPeakMB,
      jsHeapPeakMB: r.memory.jsHeapPeakMB,
      jsHeapUsedAfterMB: r.memory.jsHeapUsedAfterMB,
    })),
  };

  const history = loadHistory();
  history.push(session);
  writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2) + "\n");

  console.log("\n=== MONGODB BENCHMARK SUMMARY (avg of", runs, "runs) ===");
  console.log(
    `parse wall (app):  ${session.summary.parseWallSec.avg.toFixed(2)}s ± ${session.summary.parseWallSec.stddev.toFixed(2)}`,
  );
  console.log(
    `upload→KPI ready:  ${session.summary.uploadToReadySec.avg.toFixed(2)}s ± ${session.summary.uploadToReadySec.stddev.toFixed(2)}`,
  );
  console.log(`throughput:        ${session.summary.throughputMBps.avg.toFixed(1)} MB/s`);
  if (session.summary.browserRssPeakMB)
    console.log(
      `Chromium RSS peak: ${session.summary.browserRssPeakMB.avg.toFixed(0)} MB (all Chromium procs, incl. workers)`,
    );
  else console.log(`Chromium RSS peak: unavailable`);
  if (session.summary.jsHeapPeakMB)
    console.log(
      `JS heap peak:      ${session.summary.jsHeapPeakMB.avg.toFixed(1)} MB (main world only — worker heap is in RSS)`,
    );
  if (session.summary.reaggAvgMs)
    console.log(`reagg avg:         ${session.summary.reaggAvgMs.avg.toFixed(0)} ms`);

  console.log(`\nLog Findings:`);
  console.log(`  Slow Queries:    ${session.result.slowQueryCount.toLocaleString()}`);
  console.log(`  COLLSCANs:       ${session.result.collscanCount.toLocaleString()}`);
  console.log(`  Query Patterns:  ${session.result.patternsCount.toLocaleString()}`);
  console.log(`  Collections:     ${session.result.collectionsCount.toLocaleString()}`);
  console.log(`  P95 Latency:     ${session.result.p95DurationMs.toFixed(1)}ms`);

  console.log(`\nAppended → ${HISTORY_PATH} (session ${history.length})`);
} finally {
  preview.kill();
}
