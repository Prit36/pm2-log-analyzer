/**
 * Web Worker: stream-parse PM2 logs and aggregate off the main thread.
 * Keeps compact typed arrays for fast re-aggregation when filters change.
 */

export type LogMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";
export type NormalizeMode = "exact" | "stripQuery" | "collapseIds";

export type AggregatedEndpoint = {
  key: string;
  method: LogMethod;
  path: string;
  count: number;
  avgMs: number;
  p50Ms: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  minMs: number;
  errorCount: number;
};

export type CronAggregated = {
  name: string;
  runs: number;
  starts: number;
  fails: number;
  avgMs: number;
  p50Ms: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  minMs: number;
  lastRunTs?: string;
  lastDurationMs?: number;
};

export type LogSummary = {
  matched: number;
  unmatched: number;
  max: number;
  avg: number;
  errors: number;
  slow: number;
};

export type CronSummary = {
  starts: number;
  dones: number;
  fails: number;
  jobs: number;
  slowestRun: number;
};

export type ParseOptions = {
  normalizeMode: NormalizeMode;
  methodFilter: string[] | null;
  statusFamily: "all" | "2xx" | "3xx" | "4xx" | "5xx";
  minMs: number;
  cronQuery: string;
  cronMinMs: number;
  cronShowFailedOnly: boolean;
};

export type AggregatedResult = {
  api: AggregatedEndpoint[];
  cron: CronAggregated[];
  summary: LogSummary;
  cronSummary: CronSummary;
  methods: string[];
  unmatchedSample: string[];
  unmatchedCount: number;
};

export type WorkerMessage =
  | { type: "PARSE_FILE"; payload: { file: File; options: ParseOptions } }
  | { type: "PARSE_TEXT"; payload: { text: string; options: ParseOptions } }
  | { type: "REAGGREGATE"; payload: { options: ParseOptions } }
  | { type: "CLEAR" }
  | { type: "CANCEL" };

export type WorkerResponse =
  | {
      type: "PROGRESS";
      payload: {
        stage: "reading" | "parsing" | "aggregating";
        processed: number;
        total: number;
        percent: number;
      };
    }
  | { type: "RESULT"; payload: AggregatedResult }
  | { type: "ERROR"; payload: { message: string } }
  | { type: "DONE" };

const METHODS: LogMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"];
const METHOD_INDEX = new Map(METHODS.map((m, i) => [m, i]));

// oxlint-disable-next-line no-control-regex -- intentional ESC (0x1b) for ANSI strip
const ANSI_REGEX = /\u001b\[[0-9;]*m/g;
// After stripAnsi: "2026-07-24T00:00:10: GET /api/... 200 150.517 ms - 379"
const LINE_REGEX_A =
  /^\s*(?:\d{4}-\d{2}-\d{2}(?:T|\s)\d{2}:\d{2}:\d{2}):\s*(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+(\S+)\s+(\d{3})\s+([0-9.]+)\s*ms\s*-\s*(-|\d+)\s*$/;
const LINE_REGEX_B =
  /^\s*([0-9.]+)\s*ms\s*[\t ]+\s*(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+(\S+)\s*$/;
const CRON_REGEX =
  /^\s*(?:(\d{4}-\d{2}-\d{2}(?:T|\s)\d{2}:\d{2}:\d{2}):\s*)?\[cron\]\s+(start|done|fail)\s+(.+?)\s*$/i;

function stripAnsi(input: string): string {
  return input.replace(ANSI_REGEX, "");
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

function normalizePath(path: string, mode: NormalizeMode): string {
  if (mode === "exact") return path;
  let p = path;
  if (mode === "stripQuery" || mode === "collapseIds") {
    const q = p.indexOf("?");
    if (q !== -1) p = p.slice(0, q);
  }
  if (mode === "collapseIds") {
    p = p
      .split("/")
      .map((seg) => {
        if (!seg) return seg;
        if (/^[a-f0-9]{24}$/i.test(seg)) return ":id";
        if (/^[0-9]{6,}$/.test(seg)) return ":id";
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg))
          return ":id";
        if (/^PR-[A-Z]{3,}-\d{8,}$/i.test(seg)) return ":id";
        if (/^[A-Z]{2,}-[A-Z]{2,}-\d{6,}$/i.test(seg)) return ":id";
        return seg;
      })
      .join("/");
  }
  return p;
}

/* ---------- compact in-worker store ---------- */

type CronEventCompact = {
  ts?: string;
  event: "start" | "done" | "fail";
  name: string;
  durationMs?: number;
};

let cancelled = false;
let methodCodes = new Uint8Array(0);
let statuses = new Uint16Array(0);
let durations = new Float32Array(0);
let pathIds = new Uint32Array(0);
let pathTable: string[] = [];
let pathIndex = new Map<string, number>();
let count = 0;
let capacity = 0;
let unmatchedCount = 0;
let unmatchedSample: string[] = [];
let cronEvents: CronEventCompact[] = [];
let methodSeen = new Set<string>();

function resetStore() {
  methodCodes = new Uint8Array(0);
  statuses = new Uint16Array(0);
  durations = new Float32Array(0);
  pathIds = new Uint32Array(0);
  pathTable = [];
  pathIndex = new Map();
  count = 0;
  capacity = 0;
  unmatchedCount = 0;
  unmatchedSample = [];
  cronEvents = [];
  methodSeen = new Set();
}

function ensureCapacity(need: number) {
  if (need <= capacity) return;
  const next = Math.max(capacity * 2 || 65536, need);
  const mc = new Uint8Array(next);
  const st = new Uint16Array(next);
  const du = new Float32Array(next);
  const pi = new Uint32Array(next);
  if (capacity > 0) {
    mc.set(methodCodes);
    st.set(statuses);
    du.set(durations);
    pi.set(pathIds);
  }
  methodCodes = mc;
  statuses = st;
  durations = du;
  pathIds = pi;
  capacity = next;
}

function internPath(path: string): number {
  let id = pathIndex.get(path);
  if (id !== undefined) return id;
  id = pathTable.length;
  pathTable.push(path);
  pathIndex.set(path, id);
  return id;
}

function pushRequest(method: LogMethod, path: string, status: number, durationMs: number) {
  ensureCapacity(count + 1);
  const mi = METHOD_INDEX.get(method);
  if (mi === undefined) return;
  methodCodes[count] = mi;
  statuses[count] = status;
  durations[count] = durationMs;
  pathIds[count] = internPath(path);
  count++;
  methodSeen.add(method);
}

function parseLine(line: string) {
  if (!line.trim()) return;

  const clean = stripAnsi(line).trim();

  const cronMatch = clean.match(CRON_REGEX);
  if (cronMatch) {
    const ts = cronMatch[1];
    const event = cronMatch[2]!.toLowerCase() as "start" | "done" | "fail";
    let name = cronMatch[3]!.trim();
    let durationMs: number | undefined;
    const durMatch = name.match(/^(.+?)\s+([0-9.]+)\s*ms\s*$/);
    if (durMatch) {
      name = durMatch[1]!.trim();
      durationMs = Number(durMatch[2]);
    }
    const ev: CronEventCompact = { event, name };
    if (ts) ev.ts = ts;
    if (durationMs !== undefined) ev.durationMs = durationMs;
    cronEvents.push(ev);
    return;
  }

  const matchA = clean.match(LINE_REGEX_A);
  if (matchA) {
    pushRequest(matchA[1] as LogMethod, matchA[2]!, Number(matchA[3]), Number(matchA[4]));
    return;
  }

  const matchB = clean.match(LINE_REGEX_B);
  if (matchB) {
    pushRequest(matchB[2] as LogMethod, matchB[3]!, 0, Number(matchB[1]));
    return;
  }

  unmatchedCount++;
  if (unmatchedSample.length < 40) unmatchedSample.push(line.slice(0, 500));
}

function aggregateApi(options: ParseOptions): AggregatedEndpoint[] {
  const methodFilter = options.methodFilter ? new Set(options.methodFilter) : null;
  const bucket = new Map<
    string,
    { method: LogMethod; path: string; durations: number[]; errorCount: number }
  >();

  for (let i = 0; i < count; i++) {
    const durationMs = durations[i]!;
    if (durationMs < options.minMs) continue;

    const method = METHODS[methodCodes[i]!]!;
    if (methodFilter && !methodFilter.has(method)) continue;

    const status = statuses[i]!;
    if (options.statusFamily !== "all") {
      const want = Number(options.statusFamily[0]);
      if (Math.floor(status / 100) !== want) continue;
    }

    const rawPath = pathTable[pathIds[i]!]!;
    const normPath = normalizePath(rawPath, options.normalizeMode);
    const key = `${method} ${normPath}`;
    let entry = bucket.get(key);
    if (!entry) {
      entry = { method, path: normPath, durations: [], errorCount: 0 };
      bucket.set(key, entry);
    }
    entry.durations.push(durationMs);
    if (status >= 400) entry.errorCount++;
  }

  const out: AggregatedEndpoint[] = [];
  for (const [key, v] of bucket) {
    const sorted = v.durations.slice().sort((a, b) => a - b);
    const n = sorted.length;
    const sum = sorted.reduce((a, b) => a + b, 0);
    out.push({
      key,
      method: v.method,
      path: v.path,
      count: n,
      avgMs: n ? sum / n : 0,
      p50Ms: percentile(sorted, 50),
      p90Ms: percentile(sorted, 90),
      p95Ms: percentile(sorted, 95),
      p99Ms: percentile(sorted, 99),
      minMs: sorted[0] ?? 0,
      maxMs: sorted[n - 1] ?? 0,
      errorCount: v.errorCount,
    });
  }
  return out;
}

function aggregateCron(options: ParseOptions): CronAggregated[] {
  const q = options.cronQuery.trim().toLowerCase();
  const minMs = options.cronMinMs;
  const map = new Map<
    string,
    {
      name: string;
      starts: number;
      durations: number[];
      fails: number;
      lastRunTs?: string;
      lastDurationMs?: number;
    }
  >();
  const startMap = new Map<string, string | undefined>();

  for (const ev of cronEvents) {
    if (q && !ev.name.toLowerCase().includes(q)) continue;
    const bucket = map.get(ev.name) ?? { name: ev.name, starts: 0, durations: [], fails: 0 };

    if (ev.event === "start") {
      bucket.starts++;
      startMap.set(ev.name, ev.ts);
    } else if (ev.event === "done" || ev.event === "fail") {
      let dur = ev.durationMs;
      if (dur === undefined) {
        const startTs = startMap.get(ev.name);
        if (startTs && ev.ts) {
          const s = Date.parse(startTs.replace(" ", "T"));
          const e = Date.parse(ev.ts.replace(" ", "T"));
          if (!Number.isNaN(s) && !Number.isNaN(e) && e >= s) dur = e - s;
        }
        startMap.delete(ev.name);
      }
      if (dur !== undefined && dur >= minMs) {
        bucket.durations.push(dur);
        bucket.lastDurationMs = dur;
        if (ev.ts) bucket.lastRunTs = ev.ts;
      }
      if (ev.event === "fail") bucket.fails++;
    }
    map.set(ev.name, bucket);
  }

  const out: CronAggregated[] = [];
  for (const b of map.values()) {
    if (options.cronShowFailedOnly && b.fails === 0) continue;
    const sorted = b.durations.slice().sort((a, b) => a - b);
    const runs = sorted.length;
    const sum = sorted.reduce((a, x) => a + x, 0);
    const row: CronAggregated = {
      name: b.name,
      runs,
      starts: b.starts,
      fails: b.fails,
      avgMs: runs ? sum / runs : 0,
      p50Ms: percentile(sorted, 50),
      p90Ms: percentile(sorted, 90),
      p95Ms: percentile(sorted, 95),
      p99Ms: percentile(sorted, 99),
      minMs: sorted[0] ?? 0,
      maxMs: sorted[runs - 1] ?? 0,
    };
    if (b.lastRunTs !== undefined) row.lastRunTs = b.lastRunTs;
    if (b.lastDurationMs !== undefined) row.lastDurationMs = b.lastDurationMs;
    out.push(row);
  }
  return out;
}

function buildResult(options: ParseOptions): AggregatedResult {
  self.postMessage({
    type: "PROGRESS",
    payload: { stage: "aggregating", processed: 0, total: 100, percent: 0 },
  } satisfies WorkerResponse);

  const api = aggregateApi(options);
  const cron = aggregateCron(options);

  let max = 0;
  let sum = 0;
  let errors = 0;
  let slow = 0;
  for (let i = 0; i < count; i++) {
    const d = durations[i]!;
    sum += d;
    if (d > max) max = d;
    if (statuses[i]! >= 400) errors++;
    if (d >= 3000) slow++;
  }

  const summary: LogSummary = {
    matched: count,
    unmatched: unmatchedCount,
    max,
    avg: count ? sum / count : 0,
    errors,
    slow,
  };

  const cronSummary: CronSummary = {
    starts: cronEvents.filter((e) => e.event === "start").length,
    dones: cronEvents.filter((e) => e.event === "done").length,
    fails: cronEvents.filter((e) => e.event === "fail").length,
    jobs: cron.length,
    slowestRun: cron.reduce((m, r) => Math.max(m, r.maxMs), 0),
  };

  return {
    api,
    cron,
    summary,
    cronSummary,
    methods: Array.from(methodSeen).sort(),
    unmatchedSample,
    unmatchedCount,
  };
}

async function parseFileStream(file: File) {
  resetStore();
  const reader = file.stream().getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let bytesRead = 0;
  const total = file.size || 1;
  let linesSinceProgress = 0;

  while (true) {
    if (cancelled) throw new Error("Cancelled");
    const { done, value } = await reader.read();
    if (done) break;

    bytesRead += value.byteLength;
    buffer += decoder.decode(value, { stream: true });

    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
      const c = buffer.charCodeAt(i);
      if (c === 10) {
        let line = buffer.slice(start, i);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        parseLine(line);
        start = i + 1;
        linesSinceProgress++;
      }
    }
    buffer = buffer.slice(start);

    if (linesSinceProgress >= 8000) {
      linesSinceProgress = 0;
      self.postMessage({
        type: "PROGRESS",
        payload: {
          stage: "parsing",
          processed: bytesRead,
          total,
          percent: Math.min(99, Math.round((bytesRead / total) * 100)),
        },
      } satisfies WorkerResponse);
      // Yield so progress messages flush
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  }

  buffer += decoder.decode();
  if (buffer) parseLine(buffer);

  self.postMessage({
    type: "PROGRESS",
    payload: { stage: "parsing", processed: total, total, percent: 100 },
  } satisfies WorkerResponse);
}

function parseText(text: string) {
  resetStore();
  const lines = text.split(/\r?\n/);
  const total = lines.length || 1;
  for (let i = 0; i < lines.length; i++) {
    if (cancelled) throw new Error("Cancelled");
    parseLine(lines[i]!);
    if (i > 0 && i % 10000 === 0) {
      self.postMessage({
        type: "PROGRESS",
        payload: {
          stage: "parsing",
          processed: i,
          total,
          percent: Math.round((i / total) * 100),
        },
      } satisfies WorkerResponse);
    }
  }
}

self.onmessage = async (e: MessageEvent<WorkerMessage>) => {
  const msg = e.data;
  try {
    if (msg.type === "CANCEL") {
      cancelled = true;
      return;
    }
    if (msg.type === "CLEAR") {
      resetStore();
      self.postMessage({ type: "DONE" } satisfies WorkerResponse);
      return;
    }

    cancelled = false;

    if (msg.type === "PARSE_FILE") {
      await parseFileStream(msg.payload.file);
      const result = buildResult(msg.payload.options);
      self.postMessage({ type: "RESULT", payload: result } satisfies WorkerResponse);
      self.postMessage({ type: "DONE" } satisfies WorkerResponse);
      return;
    }

    if (msg.type === "PARSE_TEXT") {
      parseText(msg.payload.text);
      const result = buildResult(msg.payload.options);
      self.postMessage({ type: "RESULT", payload: result } satisfies WorkerResponse);
      self.postMessage({ type: "DONE" } satisfies WorkerResponse);
      return;
    }

    if (msg.type === "REAGGREGATE") {
      if (count === 0 && cronEvents.length === 0) {
        self.postMessage({
          type: "RESULT",
          payload: {
            api: [],
            cron: [],
            summary: { matched: 0, unmatched: 0, max: 0, avg: 0, errors: 0, slow: 0 },
            cronSummary: { starts: 0, dones: 0, fails: 0, jobs: 0, slowestRun: 0 },
            methods: [],
            unmatchedSample: [],
            unmatchedCount: 0,
          },
        } satisfies WorkerResponse);
        return;
      }
      const result = buildResult(msg.payload.options);
      self.postMessage({ type: "RESULT", payload: result } satisfies WorkerResponse);
      self.postMessage({ type: "DONE" } satisfies WorkerResponse);
    }
  } catch (err) {
    self.postMessage({
      type: "ERROR",
      payload: { message: err instanceof Error ? err.message : String(err) },
    } satisfies WorkerResponse);
  }
};
