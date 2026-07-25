export type LogMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

export type NormalizeMode = "exact" | "stripQuery" | "collapseIds";

export type StatusFamily = "all" | "2xx" | "3xx" | "4xx" | "5xx";

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
  p95Ms: number;
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
  statusFamily: StatusFamily;
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

export type CronEventCompact = {
  ts?: string;
  event: "start" | "done" | "fail";
  name: string;
  durationMs?: number;
};

export type HttpRequestHit = {
  method: LogMethod;
  path: string;
  status: number;
  durationMs: number;
};

export type ParsedLine =
  | { kind: "http"; hit: HttpRequestHit }
  | { kind: "cron"; event: CronEventCompact }
  | { kind: "unmatched" }
  | { kind: "empty" };

export const METHODS: LogMethod[] = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "HEAD",
];

export const METHOD_INDEX = new Map(METHODS.map((m, i) => [m, i]));

export const EMPTY_RESULT: AggregatedResult = {
  api: [],
  cron: [],
  summary: { matched: 0, unmatched: 0, max: 0, avg: 0, p95Ms: 0, errors: 0, slow: 0 },
  cronSummary: { starts: 0, dones: 0, fails: 0, jobs: 0, slowestRun: 0 },
  methods: [],
  unmatchedSample: [],
  unmatchedCount: 0,
};
