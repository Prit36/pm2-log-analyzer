import { normalizePath } from "./normalize";
import { createLineScratch, parseLine, parseLineBytes } from "./parseLine";
import { percentile, sortAsc } from "./percentiles";
import { RelHist } from "./relHist";

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

// --- bytes parity with string parser ---
{
  const enc = new TextEncoder();
  const samples = [
    "2026-07-24T00:00:10: GET /api/health 200 12.5 ms - 42",
    "2026-07-24T00:00:10: \u001b[0mPOST /api/x \u001b[32m201\u001b[0m 3.1 ms - -\u001b[0m",
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

console.log("parser selfcheck: ok");
