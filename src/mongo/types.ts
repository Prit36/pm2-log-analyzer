import type { MongoDoc } from "./fingerprint";

export type MongoSeverity = "I" | "W" | "E" | "F" | "D";

export type MongoComponent =
  | "COMMAND"
  | "NETWORK"
  | "ACCESS"
  | "STORAGE"
  | "WTCHKPT"
  | "INDEX"
  | "QUERY"
  | "REPL"
  | "CONTROL"
  | "SLOWPROG"
  | "WRITE"
  | string;

export type MongoOperationType =
  | "find"
  | "aggregate"
  | "distinct"
  | "getMore"
  | "insert"
  | "update"
  | "delete"
  | "findAndModify"
  | "createIndexes"
  | "dropIndexes"
  | "count"
  | "other";

export type MongoSlowQuery = {
  id: string;
  timestamp: string;
  epochMs: number;
  severity: MongoSeverity;
  component: MongoComponent;
  ctx: string;
  ns: string;
  db: string;
  collection: string;
  op: MongoOperationType;
  durationMs: number;
  planningTimeMicros?: number | undefined;
  planSummary: string;
  isCollscan: boolean;
  keysExamined: number;
  docsExamined: number;
  nreturned: number;
  scanRatio: number;
  numYields: number;
  reslen: number;
  queryHash?: string | undefined;
  planCacheKey?: string | undefined;
  remote?: string | undefined;
  command: MongoDoc;
  originatingCommand?: MongoDoc | undefined;
  locks?: MongoDoc | undefined;
  storage?: MongoDoc | undefined;
  fingerprint: string;
  indexSuggestion?: string | undefined;
  user?: string | undefined;
};

export type MongoUserTopCollection = {
  ns: string;
  count: number;
  totalDurationMs: number;
  collscanCount: number;
};

export type MongoUserActivity = {
  userName: string;
  authDb: string;
  appName: string;
  clientIps: string[];
  totalOperations: number;
  slowQueryCount: number;
  collscanCount: number;
  totalDurationMs: number;
  avgDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  p95DurationMs: number;
  totalDocsExamined: number;
  totalKeysExamined: number;
  totalReturned: number;
  scanRatio: number;
  firstActive: string;
  lastActive: string;
  authSuccessCount: number;
  authFailCount: number;
  operations: Record<string, number>;
  topCollections: MongoUserTopCollection[];
};

export type MongoQueryPattern = {
  id: string;
  ns: string;
  db: string;
  collection: string;
  op: MongoOperationType;
  fingerprint: string;
  planSummary: string;
  isCollscan: boolean;
  count: number;
  totalDurationMs: number;
  avgDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  p50DurationMs: number;
  p90DurationMs: number;
  p95DurationMs: number;
  p99DurationMs: number;
  totalDocsExamined: number;
  avgDocsExamined: number;
  totalKeysExamined: number;
  avgKeysExamined: number;
  totalReturned: number;
  avgReturned: number;
  scanRatio: number;
  collscanCount: number;
  indexSuggestion: string;
  exampleQuery: MongoSlowQuery;
};

export type MongoCollectionMetric = {
  ns: string;
  collection: string;
  db: string;
  queryCount: number;
  totalDurationMs: number;
  avgDurationMs: number;
  maxDurationMs: number;
  p95DurationMs: number;
  collscanCount: number;
  totalDocsExamined: number;
  totalReturned: number;
  scanRatio: number;
};

export type MongoTimeBucket = {
  timeKey: string;
  hourLabel: string;
  queryCount: number;
  collscanCount: number;
  avgDurationMs: number;
  p95DurationMs: number;
  maxDurationMs: number;
  ops: Record<string, number>;
};

export type MongoDriverInfo = {
  driverName: string;
  driverVersion: string;
  platform: string;
  osName: string;
  osVersion: string;
  count: number;
};

export type MongoConnectionStats = {
  accepted: number;
  ended: number;
  peakConcurrent: number;
  authSuccess: number;
  authFailed: number;
  drivers: MongoDriverInfo[];
  clientIps: { ip: string; count: number }[];
};

export type MongoErrorInfo = {
  timestamp: string;
  severity: MongoSeverity;
  component: string;
  id?: number | undefined;
  msg: string;
  attr?: MongoDoc | undefined;
  count: number;
};

export type MongoCheckpointInfo = {
  timestamp: string;
  thread?: string | undefined;
  msg: string;
  bytesWritten?: number | undefined;
};

export type MongoAggregationResult = {
  summary: {
    totalLines: number;
    slowQueryCount: number;
    collscanCount: number;
    avgDurationMs: number;
    p50DurationMs: number;
    p90DurationMs: number;
    p95DurationMs: number;
    p99DurationMs: number;
    maxDurationMs: number;
    totalDocsExamined: number;
    totalKeysExamined: number;
    totalReturned: number;
    overallScanRatio: number;
    uniquePatterns: number;
    uniqueCollections: number;
  };
  patterns: MongoQueryPattern[];
  slowQueries: MongoSlowQuery[];
  collections: MongoCollectionMetric[];
  timeBuckets: MongoTimeBucket[];
  connections: MongoConnectionStats;
  errors: MongoErrorInfo[];
  checkpoints: MongoCheckpointInfo[];
  dates: string[];
  operations: string[];
  users: MongoUserActivity[];
  userNames: string[];
};

export type MongoSortField =
  | "totalDurationMs"
  | "avgDurationMs"
  | "p95DurationMs"
  | "maxDurationMs"
  | "count"
  | "collscanCount"
  | "totalDocsExamined"
  | "scanRatio"
  | "collection";

export type MongoSlowQuerySortField =
  | "timestamp"
  | "durationMs"
  | "docsExamined"
  | "keysExamined"
  | "nreturned"
  | "scanRatio"
  | "collection";

export type MongoPlanFilter = "all" | "collscan_only" | "ixscan_only";

export type MongoFilters = {
  operation: string;
  planFilter: MongoPlanFilter;
  minDurationMs: number;
  collection: string;
  searchQuery: string;
  highScanRatioOnly: boolean;
  sortField: MongoSortField;
  sortDirection: "asc" | "desc";
  slowSortField: MongoSlowQuerySortField;
  slowSortDirection: "asc" | "desc";
  dateFilter: string;
  userFilter: string;
};

export const DEFAULT_MONGO_FILTERS: MongoFilters = {
  operation: "all",
  planFilter: "all",
  minDurationMs: 0,
  collection: "all",
  searchQuery: "",
  highScanRatioOnly: false,
  sortField: "totalDurationMs",
  sortDirection: "desc",
  slowSortField: "durationMs",
  slowSortDirection: "desc",
  dateFilter: "all",
  userFilter: "all",
};

export const EMPTY_MONGO_RESULT: MongoAggregationResult = {
  summary: {
    totalLines: 0,
    slowQueryCount: 0,
    collscanCount: 0,
    avgDurationMs: 0,
    p50DurationMs: 0,
    p90DurationMs: 0,
    p95DurationMs: 0,
    p99DurationMs: 0,
    maxDurationMs: 0,
    totalDocsExamined: 0,
    totalKeysExamined: 0,
    totalReturned: 0,
    overallScanRatio: 0,
    uniquePatterns: 0,
    uniqueCollections: 0,
  },
  patterns: [],
  slowQueries: [],
  collections: [],
  timeBuckets: [],
  connections: {
    accepted: 0,
    ended: 0,
    peakConcurrent: 0,
    authSuccess: 0,
    authFailed: 0,
    drivers: [],
    clientIps: [],
  },
  errors: [],
  checkpoints: [],
  dates: [],
  operations: [],
  users: [],
  userNames: [],
};
