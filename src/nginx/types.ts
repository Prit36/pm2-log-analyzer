import type { NormalizeMode, StatusFamily } from "../parser";

export type NginxMetric = "request" | "upstream";
/** Status families plus "errors" (4xx + 5xx). */
export type NginxStatusFamily = StatusFamily | "errors";
export type NginxView = "endpoints" | "traffic" | "clients" | "referrers" | "userAgents";
export type NginxSortKey =
  | "count"
  | "errorCount"
  | "bodyBytes"
  | "avgMs"
  | "p95Ms"
  | "p99Ms"
  | "maxMs"
  | "path";

export type NginxFilters = {
  normalizeMode: NormalizeMode;
  statusFamily: NginxStatusFamily;
  /** Exact HTTP status; 0 matches every status. */
  statusCode: number;
  minMs: number;
  methods: string[];
  query: string;
  dateFilter: string;
  metric: NginxMetric;
  sortKey: NginxSortKey;
  sortDir: "asc" | "desc";
  topN: number;
};

export type NginxLatency = {
  count: number;
  avgMs: number | null;
  minMs: number | null;
  maxMs: number | null;
  p50Ms: number | null;
  p90Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
};

export type NginxSummary = {
  count: number;
  errorCount: number;
  bodyBytes: number;
  uniqueClients: number;
  requestTime: NginxLatency;
  upstreamTime: NginxLatency;
};

export type NginxEndpoint = {
  method: string;
  path: string;
  count: number;
  errorCount: number;
  bodyBytes: number;
  requestTime: NginxLatency;
  upstreamTime: NginxLatency;
};

/** Exact top endpoints for the overview, independent of the table sort and Top N. */
export type NginxHotspot = {
  method: string;
  path: string;
  count: number;
  errorCount: number;
  timedCount: number;
  avgMs: number | null;
  p95Ms: number | null;
};

export type NginxBreakdown = {
  value: string;
  count: number;
  errorCount: number;
  bodyBytes: number;
};

export type NginxTimeBucket = {
  label: string;
  count: number;
  errorCount: number;
  bodyBytes: number;
  requestTime: NginxLatency;
  upstreamTime: NginxLatency;
};

export type NginxResult = {
  summary: NginxSummary;
  endpoints: NginxEndpoint[];
  endpointCount: number;
  slowestEndpoints: NginxHotspot[];
  failingEndpoints: NginxHotspot[];
  hourlyStats: NginxTimeBucket[];
  dailyStats: NginxTimeBucket[];
  clients: NginxBreakdown[];
  referrers: NginxBreakdown[];
  userAgents: NginxBreakdown[];
  clientCount: number;
  referrerCount: number;
  userAgentCount: number;
  statusCounts: { status: number; count: number }[];
  dates: string[];
  methods: string[];
  diagnostics: {
    totalLines: number;
    matchedLines: number;
    unmatchedCount: number;
    invalidTimingCount: number;
    unmatchedSample: string[];
  };
};

export const DEFAULT_NGINX_FILTERS: NginxFilters = {
  normalizeMode: "collapseIds",
  statusFamily: "all",
  statusCode: 0,
  minMs: 0,
  methods: [],
  query: "",
  dateFilter: "all",
  metric: "request",
  sortKey: "count",
  sortDir: "desc",
  topN: 50,
};
