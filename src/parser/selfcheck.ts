import { normalizePath } from "./normalize";
import { createLineScratch, parseLine, parseLineBytes } from "./parseLine";
import { percentile, sortAsc } from "./percentiles";
import { RelHist } from "./relHist";
import {
  aggregateColumnSlice,
  aggregateApiWithSummary,
  buildHourlyStats,
  finalizeHourlyStats,
  finishApiFromPartials,
  mergeHourlyPartials,
  type ColumnarStore,
  type HourlyPartial,
} from "./aggregate";
import type { ParseOptions } from "./types";
import { METHODS } from "./types";
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`selfcheck failed: ${msg}`);
}

function approx(a: number, b: number, eps = 0.01) {
  assert(Math.abs(a - b) <= eps, `expected ${b}, got ${a}`);
}

function relApprox(got: number, exact: number, relTol = 0.02) {
  if (exact === 0) {
    assert(Math.abs(got) <= 1e-9, `expected ~0, got ${got}`);
    return;
  }
  const err = Math.abs(got - exact) / Math.abs(exact);
  assert(err <= relTol, `relative error ${err} > ${relTol} (got ${got}, exact ${exact})`);
}

// --- normalize ---
assert(
  normalizePath("/api/users/507f1f77bcf86cd799439011/profile", "collapseIds") ===
    "/api/users/:id/profile",
  "collapse ObjectId",
);
assert(normalizePath("/api/x?foo=1&bar=2", "stripQuery") === "/api/x", "strip query");
assert(normalizePath("/api/x?foo=1", "exact") === "/api/x?foo=1", "exact keeps query");

// --- percentiles (exact nearest-rank) ---
const sorted = sortAsc([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
approx(percentile(sorted, 50), 50);
approx(percentile(sorted, 95), 100);
assert(percentile([], 95) === 0, "empty percentile");

// --- RelHist ~±1% relative; allow 2% vs exact ---
{
  const values: number[] = [];
  for (let i = 1; i <= 1000; i++) values.push(i * 10);
  const sketch = new RelHist();
  for (const v of values) sketch.accept(v);
  const exact = sortAsc(values);
  relApprox(sketch.quantile(0.95), percentile(exact, 95), 0.02);
  relApprox(sketch.quantile(0.5), percentile(exact, 50), 0.02);

  const a = new RelHist();
  const b = new RelHist();
  for (let i = 0; i < 500; i++) a.accept(values[i]!);
  for (let i = 500; i < 1000; i++) b.accept(values[i]!);
  a.merge(b);
  relApprox(a.quantile(0.95), percentile(exact, 95), 0.02);
}

// --- HTTP pattern A ---
const httpA = parseLine("2026-07-24T00:00:10: GET /api/health 200 12.5 ms - 42");
assert(httpA.kind === "http", "pattern A kind");
if (httpA.kind === "http") {
  assert(httpA.hit.method === "GET", "method");
  assert(httpA.hit.path === "/api/health", "path");
  assert(httpA.hit.status === 200, "status");
  approx(httpA.hit.durationMs, 12.5);
}

// --- HTTP pattern A without PM2 timestamp (Server B) ---
const httpANoTs = parseLine(
  "\u001b[0mPOST /api/admin/dashboard/dashboarddata \u001b[32m200\u001b[0m 71.197 ms - 223\u001b[0m",
);
assert(httpANoTs.kind === "http", "pattern A no-ts kind");
if (httpANoTs.kind === "http") {
  assert(httpANoTs.hit.method === "POST", "no-ts method");
  assert(httpANoTs.hit.path === "/api/admin/dashboard/dashboarddata", "no-ts path");
  assert(httpANoTs.hit.status === 200, "no-ts status");
  approx(httpANoTs.hit.durationMs, 71.197);
}

// --- bytes parity with string parser ---
{
  const enc = new TextEncoder();
  const samples = [
    "2026-07-24T00:00:10: GET /api/health 200 12.5 ms - 42",
    "2026-07-24T00:00:10: \u001b[0mPOST /api/x \u001b[32m201\u001b[0m 3.1 ms - -\u001b[0m",
    "\u001b[0mPOST /api/admin/dashboard/dashboarddata \u001b[32m200\u001b[0m 71.197 ms - 223\u001b[0m",
    "68064.174ms\tPOST /api/admin/user/getuserbyrole",
    "2026-07-24T09:15:38: [cron] done export-motor-policy-csv 179ms",
    "socket connected",
    "   ",
  ];
  const out = createLineScratch();
  for (const s of samples) {
    const a = parseLine(s);
    const bytes = enc.encode(s);
    parseLineBytes(bytes, 0, bytes.length, out);
    assert(a.kind === out.kind, `bytes kind parity for ${JSON.stringify(s)}`);
    if (a.kind === "http" && out.kind === "http") {
      assert(a.hit.method === out.method, "bytes method");
      assert(a.hit.path === out.path, "bytes path");
      assert(a.hit.status === out.status, "bytes status");
      approx(a.hit.durationMs, out.durationMs);
    }
  }
}

// --- ANSI ---
const ansi = parseLine(
  "2026-07-24T00:00:10: \u001b[0mPOST /api/x \u001b[32m201\u001b[0m 3.1 ms - -\u001b[0m",
);
assert(ansi.kind === "http", "ANSI pattern A");
if (ansi.kind === "http") {
  assert(ansi.hit.status === 201, "ANSI status");
  approx(ansi.hit.durationMs, 3.1);
}

// --- HTTP pattern B ---
const httpB = parseLine("68064.174ms\tPOST /api/admin/user/getuserbyrole");
assert(httpB.kind === "http", "pattern B kind");
if (httpB.kind === "http") {
  assert(httpB.hit.method === "POST", "B method");
  approx(httpB.hit.durationMs, 68064.174);
}

// --- cron ---
const cron = parseLine("2026-07-24T09:15:38: [cron] done export-motor-policy-csv 179ms");
assert(cron.kind === "cron", "cron kind");
if (cron.kind === "cron") {
  assert(cron.event.event === "done", "cron event");
  assert(cron.event.name === "export-motor-policy-csv", "cron name");
  approx(cron.event.durationMs ?? 0, 179);
}

assert(parseLine("socket connected").kind === "unmatched", "unmatched");
assert(parseLine("   ").kind === "empty", "empty");

// --- parallel column-slice agg merges to same result as one-pass ---
{
  const n = 10_000;
  const methodCodes = new Uint8Array(n);
  const statuses = new Uint16Array(n);
  const durations = new Float32Array(n);
  const pathIds = new Uint32Array(n);
  const pathTable = ["/a", "/b/:id", "/c?x=1", "/users/1"];
  for (let i = 0; i < n; i++) {
    methodCodes[i] = i % METHODS.length;
    statuses[i] = i % 17 === 0 ? 500 : 200;
    durations[i] = 10 + (i % 1000);
    pathIds[i] = i % pathTable.length;
  }
  const store: ColumnarStore = {
    methodCodes,
    statuses,
    durations,
    pathIds,
    pathTable,
    count: n,
    unmatchedCount: 3,
    unmatchedSample: [],
    cronEvents: [],
    methodSeen: new Set(["GET", "POST"]),
  };
  const options: ParseOptions = {
    normalizeMode: "collapseIds",
    methodFilter: null,
    statusFamily: "all",
    minMs: 0,
    cronQuery: "",
    cronMinMs: 0,
    cronShowFailedOnly: false,
  };
  const one = aggregateApiWithSummary(store, options, true);
  const mid = (n / 2) | 0;
  const p0 = aggregateColumnSlice(
    methodCodes,
    statuses,
    durations,
    pathIds,
    pathTable,
    0,
    mid,
    options,
    true,
  );
  const p1 = aggregateColumnSlice(
    methodCodes,
    statuses,
    durations,
    pathIds,
    pathTable,
    mid,
    n,
    options,
    true,
  );
  const two = finishApiFromPartials([p0, p1], options, {
    count: n,
    unmatchedCount: 3,
  });
  assert(one.api.length === two.api.length, "api row count parity");
  const byKey = new Map(two.api.map((r) => [r.key, r]));
  for (const r of one.api) {
    const o = byKey.get(r.key);
    assert(o, `missing key ${r.key}`);
    assert(o!.count === r.count, `count ${r.key}`);
    assert(o!.errorCount === r.errorCount, `errors ${r.key}`);
    approx(o!.avgMs, r.avgMs, 1e-6);
    approx(o!.p95Ms, r.p95Ms, 1e-6);
  }
  assert(one.summary && two.summary, "summaries present");
  assert(one.summary!.matched === two.summary!.matched, "summary matched");
  assert(one.summary!.errors === two.summary!.errors, "summary errors");
  approx(one.summary!.avg, two.summary!.avg, 1e-6);
  approx(one.summary!.p95Ms, two.summary!.p95Ms, 1e-6);
}

// --- hourly chart data uses explicit request hours and merged sketches ---
{
  const durations = new Float32Array([10, 20, 40, 80]);
  const statuses = new Uint16Array([200, 500, 200, 200]);
  const store: ColumnarStore = {
    methodCodes: new Uint8Array([0, 0, 1, 1]),
    statuses,
    durations,
    pathIds: new Uint32Array([0, 0, 1, 1]),
    pathTable: ["/a", "/b"],
    hours: new Uint8Array([3, 3, 15, 15]),
    count: 4,
    unmatchedCount: 0,
    unmatchedSample: [],
    cronEvents: [],
    methodSeen: new Set(["GET", "POST"]),
  };
  const hourly = buildHourlyStats(store);
  assert(hourly.length === 24, "hourly bucket count");
  assert(hourly[3]!.count === 2, "hour 3 count");
  assert(hourly[3]!.errorCount === 1, "hour 3 errors");
  assert(hourly[3]!.avgMs === 15, "hour 3 average");
  assert(hourly[3]!.maxMs === 20, "hour 3 max");
  assert(hourly[15]!.count === 2, "hour 15 count");
  assert(hourly[15]!.avgMs === 60, "hour 15 average");
  assert(hourly[15]!.maxMs === 80, "hour 15 max");
  assert(hourly[0]!.count === 0, "empty hour remains empty");

  const noHours = buildHourlyStats({ ...store, hours: undefined as unknown as Uint8Array });
  assert(
    noHours.every((bucket) => bucket.count === 0),
    "no synthetic hourly data",
  );

  const partA: HourlyPartial = {
    buckets: hourly.map((bucket, hour) => {
      const sketch = new RelHist();
      if (hour === 3) {
        sketch.accept(10);
        sketch.accept(20);
      }
      if (hour === 15) {
        sketch.accept(40);
        sketch.accept(80);
      }
      return {
        count: bucket.count,
        errorCount: bucket.errorCount,
        sum: bucket.count * bucket.avgMs,
        max: bucket.maxMs,
        sketch: sketch.toWire(),
      };
    }),
  };
  const partB: HourlyPartial = {
    buckets: hourly.map((bucket, hour) => {
      const sketch = new RelHist();
      if (hour === 3) {
        sketch.accept(10);
        sketch.accept(20);
      }
      if (hour === 15) {
        sketch.accept(40);
        sketch.accept(80);
      }
      return {
        count: bucket.count,
        errorCount: bucket.errorCount,
        sum: bucket.count * bucket.avgMs,
        max: bucket.maxMs,
        sketch: sketch.toWire(),
      };
    }),
  };
  const merged = finalizeHourlyStats(mergeHourlyPartials([partA, partB]));
  assert(merged[3]!.count === 4, "merged hour count");
  assert(merged[3]!.errorCount === 2, "merged hour errors");
}

// --- Wasm core parity (Node): parse + reagg vs TS column slice ---
{
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const path = await import("node:path");
  const root = path.dirname(fileURLToPath(import.meta.url));
  const wasmPath = path.resolve(root, "../wasm/pkg/pm2_core_bg.wasm");
  const { default: init, Pm2Engine, initSync } = await import("../wasm/pkg/pm2_core.js");
  void init;
  const wasmBytes = readFileSync(wasmPath);
  initSync({ module: wasmBytes });
  const eng = new Pm2Engine();
  const sample = [
    "2026-07-24T00:00:10: GET /api/health 200 12.5 ms - 42",
    "2026-07-24T00:00:11: POST /api/users/507f1f77bcf86cd799439011 201 3.1 ms - -",
    "2026-07-24T00:00:12: GET /api/health 500 40 ms - 1",
    "socket connected",
    "2026-07-24T09:15:38: [cron] done export-motor-policy-csv 179ms",
  ].join("\n");
  const buf = new TextEncoder().encode(sample);
  eng.parse_shard(buf, 0, buf.length, buf.length);
  eng.finalize_paths();
  assert(eng.hit_count() === 3, `wasm hits ${eng.hit_count()}`);
  assert(eng.unmatched_count() === 1, "wasm unmatched");
  const { decodeHourlyWire, decodePm2Partial, decodeCronWire } =
    await import("../wasm/decodePartial");
  const wire = eng.reaggregate(2, 0, 0, true); // collapseIds, all
  const { matched, unmatched, partial } = decodePm2Partial(wire);
  assert(matched === 3, "partial matched");
  assert(unmatched === 1, "partial unmatched");
  assert(partial.buckets.length >= 2, "wasm endpoints");
  const health = partial.buckets.find((b) => b.path === "/api/health" && b.method === "GET");
  assert(health && health.count === 2, "health count");
  assert(health!.errorCount === 1, "health errors");
  const hourlyPartial = decodeHourlyWire(eng.hourly_wire());
  const hourlyStats = finalizeHourlyStats(hourlyPartial);
  assert(hourlyStats[0]!.count === 3, "wasm hour 0 count");
  assert(hourlyStats[0]!.errorCount === 1, "wasm hour 0 errors");
  approx(hourlyStats[0]!.avgMs, (12.5 + 3.1 + 40) / 3, 0.5);
  assert(hourlyStats[0]!.maxMs === 40, "wasm hour 0 max");
  assert(hourlyStats[9]!.count === 0, "wasm empty hour");
  assert(
    hourlyStats.every((bucket) => bucket.count === 0 || bucket.hour === 0),
    "wasm timestamp buckets",
  );
  const cronEv = decodeCronWire(eng.cron_wire());
  assert(cronEv.length === 1 && cronEv[0]!.name === "export-motor-policy-csv", "cron wire");

  const noTimestamp = new Pm2Engine();
  const noTimestampBytes = new TextEncoder().encode("40ms GET /api/untimestamped");
  noTimestamp.parse_shard(noTimestampBytes, 0, noTimestampBytes.length, noTimestampBytes.length);
  const noTimestampStats = finalizeHourlyStats(decodeHourlyWire(noTimestamp.hourly_wire()));
  assert(
    noTimestampStats.every((bucket) => bucket.count === 0),
    "wasm no synthetic hours",
  );

  const shardA = new Pm2Engine();
  const shardB = new Pm2Engine();
  const firstShardBytes = new TextEncoder().encode(sample.split("\n").slice(0, 2).join("\n"));
  const secondShardBytes = new TextEncoder().encode(sample.split("\n")[2]!);
  shardA.parse_shard(firstShardBytes, 0, firstShardBytes.length, firstShardBytes.length);
  shardB.parse_shard(secondShardBytes, 0, secondShardBytes.length, secondShardBytes.length);
  const mergedShardStats = finalizeHourlyStats(
    mergeHourlyPartials([
      decodeHourlyWire(shardA.hourly_wire()),
      decodeHourlyWire(shardB.hourly_wire()),
    ]),
  );
  assert(mergedShardStats[0]!.count === hourlyStats[0]!.count, "merged wasm hour count");
  assert(mergedShardStats[0]!.errorCount === hourlyStats[0]!.errorCount, "merged wasm errors");
  assert(mergedShardStats[0]!.maxMs === hourlyStats[0]!.maxMs, "merged wasm max");
  assert(mergedShardStats[0]!.avgMs === hourlyStats[0]!.avgMs, "merged wasm average");
}

// --- OPTIONS and socket lines are dropped at parse (both Rust + TS parity) ---
{
  const noiseSample = [
    "2026-07-24T00:00:10: \u001b[0mOPTIONS /api/x \u001b[32m204\u001b[0m 0.115 ms - 0\u001b[0m",
    "2026-07-24T00:00:10: \u001b[0mGET /api/health 200 12.5 ms - 42\u001b[0m",
    "2026-07-24T00:00:05: New Connection { address: '::ffff:127.0.0.1', id: 'abc' }",
    "2026-07-24T00:01:29: join {",
    "  { 'abc': undefined }",
    "}",
    "] { CoNctv8nmitCu03iAAEW: undefined }",
    "] Length: 5",
    "2026-07-24T00:04:28: Token parts: [",
    "  address: '::ffff:127.0.0.1',",
    "  method: 'join'",
    "useOfVehicle 1 vehicleUsage 1",
  ].join("\n");
  const out = createLineScratch();
  const enc = new TextEncoder();
  const noiseLines = noiseSample.split("\n");
  const noiseKinds = noiseLines.map((l) => {
    parseLineBytes(enc.encode(l), 0, l.length, out);
    return out.kind;
  });
  // OPTIONS + socket lines are dropped (empty); the GET stays http; legit
  // non-HTTP content (useOfVehicle) stays unmatched.
  const expected = [
    "unmatched",
    "http",
    "empty",
    "empty",
    "empty",
    "empty",
    "empty",
    "empty",
    "empty",
    "empty",
    "empty",
    "unmatched",
  ];
  assert(
    noiseKinds.every((k, i) => k === expected[i]),
    `noise kinds ${noiseKinds}`,
  );
  const httpLine = noiseLines.find((l) => l.includes("GET /api/health"));
  assert(httpLine !== undefined, "health line present");
  parseLineBytes(enc.encode(httpLine!), 0, httpLine!.length, out);
  assert(out.method === "GET" && out.path === "/api/health", "GET still parsed");

  // Wasm parity: same sample through the engine — only the GET counts; OPTIONS
  // and socket noise are dropped, useOfVehicle stays unmatched.
  const { Pm2Engine: WasmEngine } = await import("../wasm/pkg/pm2_core.js");
  const eng = new WasmEngine();
  const buf = enc.encode(noiseSample);
  eng.parse_shard(buf, 0, buf.length, buf.length);
  assert(eng.hit_count() === 1, `wasm noise hits ${eng.hit_count()}`);
  assert(eng.unmatched_count() === 2, `wasm noise unmatched ${eng.unmatched_count()}`);
}

console.log("parser selfcheck: ok");
