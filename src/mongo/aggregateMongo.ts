import type {
  MongoAggregationResult,
  MongoCheckpointInfo,
  MongoCollectionMetric,
  MongoConnectionStats,
  MongoErrorInfo,
  MongoFilters,
  MongoQueryPattern,
  MongoSlowQuery,
  MongoTimeBucket,
} from "./types";

function computePercentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const weight = rank - lower;
  const lowerVal = sorted[lower] ?? 0;
  const upperVal = sorted[upper] ?? 0;
  return Math.round(lowerVal + weight * (upperVal - lowerVal));
}

export function filterMongoQueries(
  queries: MongoSlowQuery[],
  filters: MongoFilters,
): MongoSlowQuery[] {
  const searchLower = filters.searchQuery.trim().toLowerCase();
  const hasSearch = searchLower.length > 0;

  return queries.filter((q) => {
    if (filters.operation !== "all" && q.op !== filters.operation) return false;
    if (filters.planFilter === "collscan_only" && !q.isCollscan) return false;
    if (filters.planFilter === "ixscan_only" && q.isCollscan) return false;
    if (filters.minDurationMs > 0 && q.durationMs < filters.minDurationMs) return false;
    if (filters.collection !== "all" && q.collection !== filters.collection && q.ns !== filters.collection)
      return false;
    if (filters.highScanRatioOnly && q.scanRatio < 100) return false;
    if (filters.dateFilter !== "all" && !q.timestamp.startsWith(filters.dateFilter)) return false;

    if (hasSearch) {
      const match =
        q.collection.toLowerCase().includes(searchLower) ||
        q.ns.toLowerCase().includes(searchLower) ||
        q.op.toLowerCase().includes(searchLower) ||
        q.fingerprint.toLowerCase().includes(searchLower) ||
        q.planSummary.toLowerCase().includes(searchLower) ||
        (q.queryHash && q.queryHash.toLowerCase().includes(searchLower)) ||
        (q.remote && q.remote.toLowerCase().includes(searchLower));
      if (!match) return false;
    }

    return true;
  });
}

export function aggregateMongoData(params: {
  allQueries: MongoSlowQuery[];
  filters: MongoFilters;
  connections: MongoConnectionStats;
  errors: MongoErrorInfo[];
  checkpoints: MongoCheckpointInfo[];
  dates: string[];
  operations: string[];
  totalLines: number;
}): MongoAggregationResult {
  const {
    allQueries,
    filters,
    connections,
    errors,
    checkpoints,
    dates,
    operations,
    totalLines,
  } = params;

  const filteredQueries = filterMongoQueries(allQueries, filters);

  // Group by pattern
  type PatternAcc = {
    id: string;
    ns: string;
    db: string;
    collection: string;
    op: MongoSlowQuery["op"];
    fingerprint: string;
    planSummary: string;
    isCollscan: boolean;
    durations: number[];
    totalDurationMs: number;
    totalDocsExamined: number;
    totalKeysExamined: number;
    totalReturned: number;
    collscanCount: number;
    indexSuggestion: string;
    exampleQuery: MongoSlowQuery;
  };

  const patternMap = new Map<string, PatternAcc>();
  const collectionMap = new Map<
    string,
    {
      ns: string;
      collection: string;
      db: string;
      durations: number[];
      totalDurationMs: number;
      collscanCount: number;
      totalDocs: number;
      totalReturned: number;
    }
  >();
  const bucketMap = new Map<string, { timeKey: string; hourLabel: string; durations: number[]; collscans: number; ops: Record<string, number> }>();

  let allDurations: number[] = [];
  let totalDocs = 0;
  let totalKeys = 0;
  let totalRet = 0;
  let collscansTotal = 0;

  for (const q of filteredQueries) {
    allDurations.push(q.durationMs);
    totalDocs += q.docsExamined;
    totalKeys += q.keysExamined;
    totalRet += q.nreturned;
    if (q.isCollscan) collscansTotal++;

    // Pattern grouping
    const patternKey = `${q.ns} | ${q.op} | ${q.fingerprint} | ${q.planSummary}`;
    let pAcc = patternMap.get(patternKey);
    if (!pAcc) {
      pAcc = {
        id: `pat-${patternMap.size + 1}`,
        ns: q.ns,
        db: q.db,
        collection: q.collection,
        op: q.op,
        fingerprint: q.fingerprint,
        planSummary: q.planSummary,
        isCollscan: q.isCollscan,
        durations: [],
        totalDurationMs: 0,
        totalDocsExamined: 0,
        totalKeysExamined: 0,
        totalReturned: 0,
        collscanCount: 0,
        indexSuggestion: q.indexSuggestion || "",
        exampleQuery: q,
      };
      patternMap.set(patternKey, pAcc);
    }
    pAcc.durations.push(q.durationMs);
    pAcc.totalDurationMs += q.durationMs;
    pAcc.totalDocsExamined += q.docsExamined;
    pAcc.totalKeysExamined += q.keysExamined;
    pAcc.totalReturned += q.nreturned;
    if (q.isCollscan) pAcc.collscanCount++;
    if (!pAcc.indexSuggestion && q.indexSuggestion) {
      pAcc.indexSuggestion = q.indexSuggestion;
    }

    // Collection grouping
    let cAcc = collectionMap.get(q.ns);
    if (!cAcc) {
      cAcc = {
        ns: q.ns,
        collection: q.collection,
        db: q.db,
        durations: [],
        totalDurationMs: 0,
        collscanCount: 0,
        totalDocs: 0,
        totalReturned: 0,
      };
      collectionMap.set(q.ns, cAcc);
    }
    cAcc.durations.push(q.durationMs);
    cAcc.totalDurationMs += q.durationMs;
    cAcc.totalDocs += q.docsExamined;
    cAcc.totalReturned += q.nreturned;
    if (q.isCollscan) cAcc.collscanCount++;

    // Time bucketing (hour based: YYYY-MM-DDTHH)
    const hourKey = q.timestamp.length >= 13 ? q.timestamp.slice(0, 13) : "unknown";
    const hourLabel = q.timestamp.length >= 16 ? q.timestamp.slice(11, 16) : hourKey;
    let bAcc = bucketMap.get(hourKey);
    if (!bAcc) {
      bAcc = { timeKey: hourKey, hourLabel, durations: [], collscans: 0, ops: {} };
      bucketMap.set(hourKey, bAcc);
    }
    bAcc.durations.push(q.durationMs);
    if (q.isCollscan) bAcc.collscans++;
    bAcc.ops[q.op] = (bAcc.ops[q.op] || 0) + 1;
  }

  allDurations.sort((a, b) => a - b);

  // Build patterns
  const patterns: MongoQueryPattern[] = Array.from(patternMap.values()).map((p) => {
    p.durations.sort((a, b) => a - b);
    const count = p.durations.length;
    const minDurationMs = p.durations[0] ?? 0;
    const maxDurationMs = p.durations[count - 1] ?? 0;
    const avgDurationMs = Math.round(p.totalDurationMs / count);
    const p50DurationMs = computePercentile(p.durations, 50);
    const p90DurationMs = computePercentile(p.durations, 90);
    const p95DurationMs = computePercentile(p.durations, 95);
    const p99DurationMs = computePercentile(p.durations, 99);
    const avgDocsExamined = Math.round(p.totalDocsExamined / count);
    const avgKeysExamined = Math.round(p.totalKeysExamined / count);
    const avgReturned = Math.round(p.totalReturned / count);
    const scanRatio = p.totalDocsExamined / Math.max(p.totalReturned, 1);

    return {
      id: p.id,
      ns: p.ns,
      db: p.db,
      collection: p.collection,
      op: p.op,
      fingerprint: p.fingerprint,
      planSummary: p.planSummary,
      isCollscan: p.isCollscan,
      count,
      totalDurationMs: p.totalDurationMs,
      avgDurationMs,
      minDurationMs,
      maxDurationMs,
      p50DurationMs,
      p90DurationMs,
      p95DurationMs,
      p99DurationMs,
      totalDocsExamined: p.totalDocsExamined,
      avgDocsExamined,
      totalKeysExamined: p.totalKeysExamined,
      avgKeysExamined,
      totalReturned: p.totalReturned,
      avgReturned,
      scanRatio: Math.round(scanRatio * 10) / 10,
      collscanCount: p.collscanCount,
      indexSuggestion: p.indexSuggestion,
      exampleQuery: p.exampleQuery,
    };
  });

  // Sort patterns
  patterns.sort((a, b) => {
    const dir = filters.sortDirection === "asc" ? 1 : -1;
    switch (filters.sortField) {
      case "totalDurationMs":
        return (a.totalDurationMs - b.totalDurationMs) * dir;
      case "avgDurationMs":
        return (a.avgDurationMs - b.avgDurationMs) * dir;
      case "p95DurationMs":
        return (a.p95DurationMs - b.p95DurationMs) * dir;
      case "maxDurationMs":
        return (a.maxDurationMs - b.maxDurationMs) * dir;
      case "count":
        return (a.count - b.count) * dir;
      case "collscanCount":
        return (a.collscanCount - b.collscanCount) * dir;
      case "totalDocsExamined":
        return (a.totalDocsExamined - b.totalDocsExamined) * dir;
      case "scanRatio":
        return (a.scanRatio - b.scanRatio) * dir;
      case "collection":
        return a.collection.localeCompare(b.collection) * dir;
      default:
        return (b.totalDurationMs - a.totalDurationMs);
    }
  });

  // Sort slow queries
  const sortedQueries = [...filteredQueries].sort((a, b) => {
    const dir = filters.slowSortDirection === "asc" ? 1 : -1;
    switch (filters.slowSortField) {
      case "timestamp":
        return a.timestamp.localeCompare(b.timestamp) * dir;
      case "durationMs":
        return (a.durationMs - b.durationMs) * dir;
      case "docsExamined":
        return (a.docsExamined - b.docsExamined) * dir;
      case "keysExamined":
        return (a.keysExamined - b.keysExamined) * dir;
      case "nreturned":
        return (a.nreturned - b.nreturned) * dir;
      case "scanRatio":
        return (a.scanRatio - b.scanRatio) * dir;
      case "collection":
        return a.collection.localeCompare(b.collection) * dir;
      default:
        return (b.durationMs - a.durationMs);
    }
  });

  // Collections
  const collections: MongoCollectionMetric[] = Array.from(collectionMap.values()).map((c) => {
    c.durations.sort((a, b) => a - b);
    const queryCount = c.durations.length;
    const avgDurationMs = Math.round(c.totalDurationMs / queryCount);
    const maxDurationMs = c.durations[queryCount - 1] ?? 0;
    const p95DurationMs = computePercentile(c.durations, 95);
    const scanRatio = c.totalDocs / Math.max(c.totalReturned, 1);
    return {
      ns: c.ns,
      collection: c.collection,
      db: c.db,
      queryCount,
      totalDurationMs: c.totalDurationMs,
      avgDurationMs,
      maxDurationMs,
      p95DurationMs,
      collscanCount: c.collscanCount,
      totalDocsExamined: c.totalDocs,
      totalReturned: c.totalReturned,
      scanRatio: Math.round(scanRatio * 10) / 10,
    };
  });
  collections.sort((a, b) => b.totalDurationMs - a.totalDurationMs);

  // Time Buckets
  const timeBuckets: MongoTimeBucket[] = Array.from(bucketMap.values())
    .sort((a, b) => a.timeKey.localeCompare(b.timeKey))
    .map((b) => {
      b.durations.sort((x, y) => x - y);
      const queryCount = b.durations.length;
      const sum = b.durations.reduce((acc, v) => acc + v, 0);
      const avgDurationMs = Math.round(sum / queryCount);
      const p95DurationMs = computePercentile(b.durations, 95);
      const maxDurationMs = b.durations[queryCount - 1] ?? 0;
      return {
        timeKey: b.timeKey,
        hourLabel: b.hourLabel,
        queryCount,
        collscanCount: b.collscans,
        avgDurationMs,
        p95DurationMs,
        maxDurationMs,
        ops: b.ops,
      };
    });

  const queryCount = allDurations.length;
  const avgDurationMs = queryCount > 0 ? Math.round(allDurations.reduce((acc, v) => acc + v, 0) / queryCount) : 0;
  const overallScanRatio = totalDocs / Math.max(totalRet, 1);

  return {
    summary: {
      totalLines,
      slowQueryCount: queryCount,
      collscanCount: collscansTotal,
      avgDurationMs,
      p50DurationMs: computePercentile(allDurations, 50),
      p90DurationMs: computePercentile(allDurations, 90),
      p95DurationMs: computePercentile(allDurations, 95),
      p99DurationMs: computePercentile(allDurations, 99),
      maxDurationMs: allDurations.length > 0 ? (allDurations[allDurations.length - 1] ?? 0) : 0,
      totalDocsExamined: totalDocs,
      totalKeysExamined: totalKeys,
      totalReturned: totalRet,
      overallScanRatio: Math.round(overallScanRatio * 10) / 10,
      uniquePatterns: patterns.length,
      uniqueCollections: collections.length,
    },
    patterns,
    slowQueries: sortedQueries,
    collections,
    timeBuckets,
    connections,
    errors,
    checkpoints,
    dates,
    operations,
  };
}
