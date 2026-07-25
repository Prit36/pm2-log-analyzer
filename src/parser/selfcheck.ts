import { normalizePath } from "./normalize";
import { parseLine } from "./parseLine";
import { percentile, sortAsc } from "./percentiles";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`selfcheck failed: ${msg}`);
}

function approx(a: number, b: number, eps = 0.01) {
  assert(Math.abs(a - b) <= eps, `expected ${b}, got ${a}`);
}

// --- normalize ---
assert(
  normalizePath("/api/users/507f1f77bcf86cd799439011/profile", "collapseIds") ===
    "/api/users/:id/profile",
  "collapse ObjectId",
);
assert(
  normalizePath("/api/x?foo=1&bar=2", "stripQuery") === "/api/x",
  "strip query",
);
assert(normalizePath("/api/x?foo=1", "exact") === "/api/x?foo=1", "exact keeps query");

// --- percentiles ---
const sorted = sortAsc([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
approx(percentile(sorted, 50), 50);
approx(percentile(sorted, 95), 100);
assert(percentile([], 95) === 0, "empty percentile");

// --- HTTP pattern A ---
const httpA = parseLine(
  "2026-07-24T00:00:10: GET /api/health 200 12.5 ms - 42",
);
assert(httpA.kind === "http", "pattern A kind");
if (httpA.kind === "http") {
  assert(httpA.hit.method === "GET", "method");
  assert(httpA.hit.path === "/api/health", "path");
  assert(httpA.hit.status === 200, "status");
  approx(httpA.hit.durationMs, 12.5);
}

// --- ANSI strip ---
const ansi = parseLine(
  "2026-07-24T00:00:10: \u001b[0mPOST /api/x 201 3.1 ms - -\u001b[0m",
);
assert(ansi.kind === "http", "ANSI pattern A");

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
