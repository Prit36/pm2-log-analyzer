/**
 * Benchmark the REAL browser app (Chromium + Vite preview + Web Worker).
 *
 * Defaults: test_data/api-out-5gb.log × 5 runs
 *
 * Usage:
 *   pnpm bench
 *   pnpm bench -- --note "baseline"
 *   node scripts/bench/bench.mjs --runs 3 --note "quick"
 *
 * History: scripts/bench/history.json
 */
import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:net";

const HISTORY_PATH = resolve("scripts/bench/history.json");
const PORT = 4173;
const BASE = `http://127.0.0.1:${PORT}`;

function parseArgs(argv) {
  const args = { file: "test_data/api-out-5gb.log", runs: 5, note: "", skipBuild: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--runs") args.runs = Math.max(1, Number(argv[++i]) || 5);
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

/** Average numeric fields across objects that share the same keys. */
function avgObjects(objs) {
  if (!objs.length) return null;
  const keys = Object.keys(objs[0]).filter((k) => typeof objs[0][k] === "number");
  const out = {};
  for (const k of keys) {
    const vals = objs.map((o) => o[k]).filter((n) => typeof n === "number");
    if (vals.length) out[k] = avg(vals);
  }
  // Preserve non-numeric kind/label from first object when present
  if (typeof objs[0].kind === "string") out.kind = objs[0].kind;
  return out;
}

function fmtStageLine(stages, reaggAvg) {
  if (!stages) return null;
  const n = (k) => (typeof stages[k] === "number" ? stages[k].toFixed(0) : "?");
  let line =
    `stages (avg ms): wasmInit=${n("wasmCompileMs")} pool=${n("shardPoolInitMs")} ` +
    `read=${n("readMs")} copy=${n("copyIngestMs")} feed=${n("feedMs")} ` +
    `endShard=${n("endShardMs")} meta=${n("metaWireMs")} merge=${n("mergeMetaMs")} ` +
    `firstReagg=${n("firstReaggMs")} (shard=${n("shardReaggMaxMs")} decode=${n("decodePartialsMs")} finish=${n("finishApiMs")})`;
  if (reaggAvg) {
    const r = (k) => (typeof reaggAvg[k] === "number" ? reaggAvg[k].toFixed(0) : "?");
    line +=
      ` | reagg shard=${r("shardReaggMaxMs")} decode=${r("decodePartialsMs")} finish=${r("finishApiMs")}`;
  }
  return line;
}

function gitMeta() {
  try {
    return {
      commit: execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim(),
      dirty: execSync("git status --porcelain", { encoding: "utf8" }).trim().length > 0,
    };
  } catch {
    return { commit: null, dirty: null };
  }
}

function loadHistory() {
  if (!existsSync(HISTORY_PATH)) return [];
  return JSON.parse(readFileSync(HISTORY_PATH, "utf8"));
}

function portFree(port) {
  return new Promise((resolvePromise) => {
    const s = createServer();
    s.once("error", () => resolvePromise(false));
    s.once("listening", () => s.close(() => resolvePromise(true)));
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
    child.stderr.on("data", (d) => errChunks.push(d));
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
  console.error("Log file not found:", absFile);
  process.exit(1);
}

console.log("Benchmark target: REAL browser app (Chromium + Web Worker + React)");
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
  console.error(`Port ${PORT} in use — stop other preview servers`);
  process.exit(1);
}

console.log(`Starting preview on ${BASE} …`);
const preview = spawn(
  process.execPath,
  [resolve("node_modules/vite/bin/vite.js"), "preview", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"],
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
      resolve("scripts/bench/runBrowserOnce.mjs"),
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
  const peakRss = iterations.map((r) => r.memory.browserRssPeakMB).filter((n) => typeof n === "number");
  const peakHeap = iterations.map((r) => r.memory.jsHeapPeakMB).filter((n) => typeof n === "number");
  const reaggAvg = iterations.map((r) => r.reaggregate.avgWallMs).filter((n) => typeof n === "number");

  const parseStages = iterations.map((r) => r.stages).filter(Boolean);
  const stagesAvg = avgObjects(parseStages);
  // Flatten all filter-reagg stage blobs across runs, then average numeric fields
  const reaggStageBlobs = iterations.flatMap((r) => r.reaggregate?.stages ?? []).filter(Boolean);
  const reaggStagesAvg = avgObjects(reaggStageBlobs);

  const session = {
    id: new Date().toISOString(),
    method: "browser-app",
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
        ? { avg: avg(peakRss), stddev: stddev(peakRss), min: Math.min(...peakRss), max: Math.max(...peakRss) }
        : null,
      workerWasmHeapMB: iterations.length ? avg(iterations.map((r) => r.memory.workerWasmHeapMB).filter((n) => typeof n === "number")) : null,
      jsHeapPeakMB: peakHeap.length
        ? { avg: avg(peakHeap), stddev: stddev(peakHeap), min: Math.min(...peakHeap), max: Math.max(...peakHeap) }
        : null,
      reaggAvgMs: reaggAvg.length
        ? { avg: avg(reaggAvg), stddev: stddev(reaggAvg), min: Math.min(...reaggAvg), max: Math.max(...reaggAvg) }
        : null,
      stages: stagesAvg,
      reaggStages: reaggStagesAvg,
    },
    iterations: iterations.map((r, i) => ({
      run: i + 1,
      parseWallSec: r.parse.wallSec,
      uploadToReadySec: r.parse.uploadToReadySec,
      throughputMBps: r.parse.throughputMBps,
      reaggAvgMs: r.reaggregate.avgWallMs,
      reaggWallMs: r.reaggregate.wallMs,
      stages: r.stages ?? null,
      reaggStages: r.reaggregate?.stages ?? [],
      browserRssPeakMB: r.memory.browserRssPeakMB,
      jsHeapPeakMB: r.memory.jsHeapPeakMB,
      jsHeapUsedAfterMB: r.memory.jsHeapUsedAfterMB,
    })),
  };

  // Drop obsolete node-inline sessions from being confused as baselines — keep them but tagged
  const history = loadHistory();
  history.push(session);
  writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2) + "\n");

  console.log("\n=== BROWSER APP SUMMARY (avg of", runs, "runs) ===");
  console.log(`parse wall (app):  ${session.summary.parseWallSec.avg.toFixed(2)}s ± ${session.summary.parseWallSec.stddev.toFixed(2)}`);
  console.log(`upload→KPI ready:  ${session.summary.uploadToReadySec.avg.toFixed(2)}s ± ${session.summary.uploadToReadySec.stddev.toFixed(2)}`);
  console.log(`throughput:        ${session.summary.throughputMBps.avg.toFixed(1)} MB/s`);
  if (session.summary.browserRssPeakMB)
    console.log(
      `Chromium RSS peak: ${session.summary.browserRssPeakMB.avg.toFixed(0)} MB (all Chromium procs, incl. workers)`,
    );
  else console.log(`Chromium RSS peak: unavailable`);
  if (session.summary.workerWasmHeapMB != null)
    console.log(
      `Worker Wasm heap:  ${session.summary.workerWasmHeapMB.toFixed(1)} MB (sum of shard worker linear memory)`,
    );
  if (session.summary.jsHeapPeakMB)
    console.log(
      `JS heap peak:      ${session.summary.jsHeapPeakMB.avg.toFixed(1)} MB (main world only — worker heap is in RSS)`,
    );
  if (session.summary.reaggAvgMs)
    console.log(`reagg avg:         ${session.summary.reaggAvgMs.avg.toFixed(0)} ms`);
  const stageLine = fmtStageLine(session.summary.stages, session.summary.reaggStages);
  if (stageLine) console.log(stageLine);
  else console.log("stages:            (missing — PERF race or older build?)");
  console.log(`\nAppended → ${HISTORY_PATH} (session ${history.length})`);
} finally {
  preview.kill();
}
