import { readFileSync, existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "../..");

// Load wasm bytes
const wasmPath = resolve(root, "src/wasm/pkg/pm2_core_bg.wasm");
const wasmBytes = readFileSync(wasmPath);
const wasmModule = await WebAssembly.compile(wasmBytes);

// Dynamic import compiled JS bridge
const { Pm2Engine, default: initWasm } = await import(
  pathToFileURL(resolve(root, "src/wasm/pkg/pm2_core.js")).href
);
const initOutput = await initWasm({ module_or_path: wasmModule });
const wasmMemory = initOutput.memory;

const { decodePm2Partial, decodeHourlyWire, decodeDailyWire } = await import(
  pathToFileURL(resolve(root, "src/wasm/decodePartial.ts")).href
);
const { finishApiFromPartials } = await import(
  pathToFileURL(resolve(root, "src/parser/aggregate.ts")).href
);

// Load test sample data
const samplePath = resolve(root, "test_data/api-out.log");
const sample500Path = resolve(root, "test_data/api-out-500mb.log");
const targetPath = existsSync(samplePath) ? samplePath : sample500Path;
const rawBuffer = readFileSync(targetPath);
const sampleSizeMB = (rawBuffer.byteLength / (1024 * 1024)).toFixed(2);
const lineCount = rawBuffer.reduce((acc, b) => (b === 10 ? acc + 1 : acc), 0);

console.log(`=== PM2 MICRO-BENCHMARK SUITE ===`);
console.log(`Input data: ${targetPath} (${sampleSizeMB} MB, ${lineCount} lines)\n`);

// 1. WASM FEED THROUGHPUT BENCHMARK
function benchFeed(iterations = 10) {
  const engine = new Pm2Engine();
  const times = [];
  const CHUNK = 32 * 1024 * 1024;

  for (let i = 0; i < iterations; i++) {
    engine.clear();
    engine.begin_shard(0, rawBuffer.byteLength, rawBuffer.byteLength);

    const t0 = performance.now();
    for (let off = 0; off < rawBuffer.byteLength; off += CHUNK) {
      const take = Math.min(CHUNK, rawBuffer.byteLength - off);
      const chunk = rawBuffer.subarray(off, off + take);
      const ptr = engine.ingest_ptr(take);
      new Uint8Array(wasmMemory.buffer).set(chunk, ptr);
      engine.feed(take, off);
    }
    engine.end_shard();
    const t1 = performance.now();
    times.push(t1 - t0);
  }

  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  const min = times[0];
  const mbSec = rawBuffer.byteLength / (1024 * 1024) / (min / 1000);
  const mLinesSec = lineCount / 1_000_000 / (min / 1000);

  console.log(`[Wasm Feed Kernel (Single-Core)]`);
  console.log(`  Min Wall Time : ${min.toFixed(2)} ms (Median: ${median.toFixed(2)} ms)`);
  console.log(`  Throughput    : ${mbSec.toFixed(1)} MB/s (${(mbSec / 1024).toFixed(2)} GB/s)`);
  console.log(`  Line Rate     : ${mLinesSec.toFixed(2)} M lines/sec`);
  console.log(`  Hits Parsed   : ${engine.hit_count()} | Unmatched: ${engine.unmatched_count()}`);
  return engine;
}

// 2. REAGGREGATION & WIRE SERIALIZATION BENCHMARK
function benchReaggregate(engine, iterations = 20) {
  engine.ensure_mode(1); // CollapseIds
  const filterConfigs = [
    {
      name: "Unfiltered (All, minMs=0)",
      mode: 1,
      family: 0,
      minMs: 0,
      dateId: 0,
      needSummary: false,
    },
    { name: "Status 5xx errors", mode: 1, family: 5, minMs: 0, dateId: 0, needSummary: false },
    { name: "Min Latency > 100ms", mode: 1, family: 0, minMs: 100, dateId: 0, needSummary: false },
    { name: "With Summary Sketch", mode: 1, family: 0, minMs: 0, dateId: 0, needSummary: true },
  ];

  console.log(`\n[Wasm Shard Reaggregation]`);
  for (const cfg of filterConfigs) {
    const times = [];
    let lastWireLength = 0;
    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now();
      const wire = engine.reaggregate(cfg.mode, cfg.family, cfg.minMs, cfg.dateId, cfg.needSummary);
      const t1 = performance.now();
      times.push(t1 - t0);
      lastWireLength = wire.byteLength;
    }
    times.sort((a, b) => a - b);
    const min = times[0];
    const med = times[Math.floor(times.length / 2)];
    console.log(
      `  ${cfg.name.padEnd(28)}: ${min.toFixed(3)} ms (med: ${med.toFixed(3)} ms, wire: ${(lastWireLength / 1024).toFixed(1)} KB)`,
    );
  }
}

// 3. WIRE DECODING BENCHMARK
function benchWireDecoding(engine, iterations = 50) {
  const pm2pWire = engine.reaggregate(1, 0, 0, 0, true);
  const hourlyWire = engine.hourly_wire();
  const dailyWire = engine.daily_wire();

  console.log(`\n[Wire Buffer Decoding (JS / V8)]`);

  // Decode PM2P
  const pm2pTimes = [];
  let endpointsCount = 0;
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    const decoded = decodePm2Partial(pm2pWire);
    const t1 = performance.now();
    pm2pTimes.push(t1 - t0);
    endpointsCount = decoded.partial.buckets.length;
  }
  pm2pTimes.sort((a, b) => a - b);
  console.log(
    `  decodePm2Partial (${endpointsCount} endpoints): ${pm2pTimes[0].toFixed(3)} ms (med: ${pm2pTimes[Math.floor(iterations / 2)].toFixed(3)} ms)`,
  );

  // Decode Hourly
  const hTimes = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    decodeHourlyWire(hourlyWire);
    const t1 = performance.now();
    hTimes.push(t1 - t0);
  }
  hTimes.sort((a, b) => a - b);
  console.log(`  decodeHourlyWire (24 buckets) : ${hTimes[0].toFixed(3)} ms`);

  // Decode Daily
  const dTimes = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    decodeDailyWire(dailyWire);
    const t1 = performance.now();
    dTimes.push(t1 - t0);
  }
  dTimes.sort((a, b) => a - b);
  console.log(`  decodeDailyWire               : ${dTimes[0].toFixed(3)} ms`);
}

// 4. MULTI-SHARD MERGE & QUANTILE CALCULATION
function benchMultiShardMerge(engine, iterations = 30) {
  const partial = decodePm2Partial(engine.reaggregate(1, 0, 0, 0, true)).partial;
  const numShardsList = [4, 6, 8];

  console.log(`\n[Multi-Shard Merge & Quantiles (finishApiFromPartials)]`);
  for (const numShards of numShardsList) {
    const partials = Array.from({ length: numShards }, () => partial);
    const times = [];
    let endpointTotal = 0;
    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now();
      const { api } = finishApiFromPartials(
        partials,
        {
          normalizeMode: "collapse-ids",
          statusFamily: "all",
          minMs: 0,
          methodFilter: null,
        },
        { count: engine.hit_count() * numShards, unmatchedCount: 0 },
      );
      const t1 = performance.now();
      times.push(t1 - t0);
      endpointTotal = api.length;
    }
    times.sort((a, b) => a - b);
    const min = times[0];
    const med = times[Math.floor(times.length / 2)];
    console.log(
      `  Merge ${numShards} Shards (${endpointTotal} unique endpoints): ${min.toFixed(2)} ms (med: ${med.toFixed(2)} ms)`,
    );
  }
}

// Run all
const engine = benchFeed(10);
benchReaggregate(engine, 20);
benchWireDecoding(engine, 50);
benchMultiShardMerge(engine, 30);
console.log(`\n=== BENCHMARK COMPLETE ===`);
