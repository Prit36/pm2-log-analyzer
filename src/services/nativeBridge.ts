import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { isTauri } from "../utils/platform";
import type { AggregatedResult } from "../parser/types";
import { useAnalysisStore, workerParseOptions } from "../store/analysisStore";
import { useMongoStore } from "../store/mongoStore";
import { useAppModeStore } from "../store/appModeStore";
import type { MongoAggregationResult } from "../mongo/types";

export type Pm2NativeResult = {
  data?: AggregatedResult;
  json?: string;
  hit_count: number;
  unmatched_count: number;
  methods_mask: number;
  shard_count: number;
  parse_wall_ms: number;
};

export type Pm2ReaggNativeResult = {
  data?: AggregatedResult;
  json?: string;
  reagg_wall_ms: number;
};

export type MongoNativeResult = {
  data?: MongoAggregationResult;
  json?: string;
  parse_wall_ms: number;
  slow_query_count: number;
  total_lines: number;
};

export type NativeFileInfo = {
  name: string;
  path: string;
  size: number;
  category: "pm2" | "mongo" | "skip" | "unknown";
};

export type NativeIngestResult = {
  pm2: Pm2NativeResult | null;
  mongo: MongoNativeResult | null;
  files: NativeFileInfo[];
  total_bytes: number;
  parse_wall_ms: number;
};

type NativeProgressPayload = {
  stage: string;
  processed: number;
  total: number;
  percent: number;
};

/** Wall-clock cost of one native parse, split into the stages the user can feel. */
export type NativeParseStats = {
  /** `invoke` round trip: native parse + aggregation + JSON + IPC transfer. */
  invokeMs: number;
  /** JS tail (JSON parse + store update). */
  assembleMs: number;
  /** Native-reported wall (includes aggregation + serialization, excludes IPC). */
  nativeMs: number;
};

export type Pm2ParseStats = NativeParseStats & { matched: number; shardCount: number };

export type MongoParseStats = NativeParseStats & { totalLines: number; slowQueries: number };

/**
 * Native results omit the per-row `key` (it is always `method + " " + path`);
 * rebuilding it here keeps the IPC body ~2MB smaller without changing the
 * `AggregatedResult` contract the UI consumes.
 */
function restoreApiKeys(result: AggregatedResult): AggregatedResult {
  for (const row of result.api) {
    if (!row.key) row.key = `${row.method} ${row.path}`;
  }
  return result;
}

function sec(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Resolve after the first frame in which `selector` is present on screen.
 * rAF polling is enough: React flushes store updates in a microtask, and two
 * nested frames guarantee the browser has painted the committed DOM.
 */
function waitForFirstPaint(selector: string): Promise<void> {
  return new Promise((resolve) => {
    const deadline = performance.now() + 3000;
    const poll = () => {
      if (document.querySelector(selector) !== null || performance.now() > deadline) {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        return;
      }
      requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  });
}

let nativePm2Active = false;
let nativeMongoActive = false;

// Ingest and reaggregate now run off the webview thread, so a slow request can
// finish after a newer one. Tag requests per store and let only the newest
// write its result, otherwise a stale reaggregate overwrites a fresh ingest.
let pm2RequestSeq = 0;
let mongoRequestSeq = 0;

export function isNativePm2Active(): boolean {
  return nativePm2Active;
}

export function isNativeMongoActive(): boolean {
  return nativeMongoActive;
}

export async function pickNativeFiles(): Promise<string[] | null> {
  if (!isTauri()) return null;
  const selected = await open({
    multiple: true,
    filters: [
      {
        name: "Logs & Archives",
        extensions: ["log", "txt", "json", "zip"],
      },
    ],
  });
  if (!selected) return null;
  return Array.isArray(selected) ? selected : [selected];
}

export async function parsePm2FilesNative(paths: string[]): Promise<Pm2ParseStats> {
  const { setParsing, setProgress, setResult, setError, showToast } = useAnalysisStore.getState();
  const options = workerParseOptions(useAnalysisStore.getState().filters);

  setParsing(true);
  setError(null);
  setProgress({ stage: "parsing", processed: 0, total: 100, percent: 0 });

  let unlisten: (() => void) | null = null;
  try {
    unlisten = await listen<NativeProgressPayload>("native-progress", (event) => {
      const stage = event.payload.stage === "complete" ? "complete" : "parsing";
      setProgress({
        stage,
        processed: event.payload.processed,
        total: event.payload.total,
        percent: event.payload.percent,
      });
    });

    const t0 = performance.now();
    const res = await invoke<Pm2NativeResult>("parse_pm2_files", {
      paths,
      options,
    });
    const invokeMs = performance.now() - t0;

    const t1 = performance.now();
    // SAFETY: data or parsed json conforms to AggregatedResult schema emitted by Rust finalizer
    const result = restoreApiKeys(
      (res.data ?? (res.json ? JSON.parse(res.json) : null)) as AggregatedResult,
    );
    setResult(result);
    const assembleMs = performance.now() - t1;

    nativePm2Active = true;
    setProgress({ stage: "complete", processed: 100, total: 100, percent: 100 });
    setParsing(false);
    return {
      invokeMs,
      assembleMs,
      nativeMs: res.parse_wall_ms,
      matched: result.summary.matched,
      shardCount: res.shard_count,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setError(message);
    setParsing(false);
    showToast(message);
    throw err;
  } finally {
    if (unlisten) unlisten();
  }
}

export async function reaggregatePm2Native(): Promise<void> {
  const { setResult, setError } = useAnalysisStore.getState();
  const options = workerParseOptions(useAnalysisStore.getState().filters);
  const seq = ++pm2RequestSeq;

  try {
    const res = await invoke<Pm2ReaggNativeResult>("reaggregate_pm2", { options });
    if (seq !== pm2RequestSeq) return;
    // SAFETY: data or parsed json conforms to AggregatedResult schema emitted by Rust finalizer
    const result = restoreApiKeys(
      (res.data ?? (res.json ? JSON.parse(res.json) : null)) as AggregatedResult,
    );
    setResult(result);
  } catch (err) {
    if (seq !== pm2RequestSeq) return;
    const message = err instanceof Error ? err.message : String(err);
    setError(message);
    throw err;
  }
}

export async function parseMongoFilesNative(paths: string[]): Promise<MongoParseStats> {
  const { setParsing, setProgress, setResult, setError, showToast, filters } =
    useMongoStore.getState();

  setParsing(true);
  setError(null);
  setProgress({ stage: "parsing", processed: 50, total: 100, percent: 50 });

  try {
    const t0 = performance.now();
    const res = await invoke<MongoNativeResult>("parse_mongo_files", {
      paths,
      options: {
        op: filters.operation,
        planFilter:
          filters.planFilter === "collscan_only" ? 1 : filters.planFilter === "ixscan_only" ? 2 : 0,
        minDurationMs: filters.minDurationMs,
        collection: filters.collection,
        searchQuery: filters.searchQuery,
        highScanRatioOnly: filters.highScanRatioOnly,
        user: filters.userFilter,
      },
    });
    const invokeMs = performance.now() - t0;

    const t1 = performance.now();
    // SAFETY: data or parsed json conforms to MongoAggregationResult schema emitted by mongo_core
    const parsed = (res.data ?? (res.json ? JSON.parse(res.json) : null)) as MongoAggregationResult;
    setResult(parsed);
    const assembleMs = performance.now() - t1;

    nativeMongoActive = true;
    setProgress({ stage: "complete", processed: 100, total: 100, percent: 100 });
    setParsing(false);
    return {
      invokeMs,
      assembleMs,
      nativeMs: res.parse_wall_ms,
      totalLines: res.total_lines,
      slowQueries: res.slow_query_count,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setError(message);
    setParsing(false);
    showToast(message);
    throw err;
  }
}

export async function reaggregateMongoNative(): Promise<void> {
  const { setResult, setError, filters } = useMongoStore.getState();
  const seq = ++mongoRequestSeq;

  try {
    const json = await invoke<string>("reaggregate_mongo", {
      options: {
        op: filters.operation,
        planFilter:
          filters.planFilter === "collscan_only" ? 1 : filters.planFilter === "ixscan_only" ? 2 : 0,
        minDurationMs: filters.minDurationMs,
        collection: filters.collection,
        searchQuery: filters.searchQuery,
        highScanRatioOnly: filters.highScanRatioOnly,
        user: filters.userFilter,
      },
    });
    if (seq !== mongoRequestSeq) return;

    // SAFETY: json string is guaranteed MongoAggregationResult JSON schema emitted by mongo_core reaggregate
    const parsed = JSON.parse(json) as MongoAggregationResult;
    setResult(parsed);
  } catch (err) {
    if (seq !== mongoRequestSeq) return;
    const message = err instanceof Error ? err.message : String(err);
    setError(message);
    throw err;
  }
}

export async function clearNative(): Promise<void> {
  nativePm2Active = false;
  nativeMongoActive = false;
  if (!isTauri()) return;
  await invoke("clear_engine");
}

export function classifyLogPath(path: string): "pm2" | "mongo" | "skip" | "unknown" {
  const lower = path.toLowerCase().replace(/\\/g, "/");
  const fileName = lower.split("/").pop() ?? lower;
  if (fileName.startsWith(".") || fileName.startsWith("__macosx") || fileName.includes("error")) {
    return "skip";
  }
  if (/(?:^|[._-])mongo(?:[._-]|\d|$)|mongod/i.test(fileName)) {
    return "mongo";
  }
  if (/(?:^|[._-])(?:api[._-]out|pm2)|out\.log/i.test(fileName) || /^api[.-]/.test(fileName)) {
    return "pm2";
  }
  return "unknown";
}

export async function handleNativePathsUpload(
  paths: string[],
  uploadMode: "replace" | "append" = "replace",
): Promise<void> {
  const startedAt = performance.now();
  const pm2Options = workerParseOptions(useAnalysisStore.getState().filters);
  const mongoFilters = useMongoStore.getState().filters;
  const mongoOptions = {
    op: mongoFilters.operation,
    planFilter:
      mongoFilters.planFilter === "collscan_only"
        ? 1
        : mongoFilters.planFilter === "ixscan_only"
          ? 2
          : 0,
    minDurationMs: mongoFilters.minDurationMs,
    collection: mongoFilters.collection,
    searchQuery: mongoFilters.searchQuery,
    highScanRatioOnly: mongoFilters.highScanRatioOnly,
    user: mongoFilters.userFilter,
  };

  const {
    setParsing: setPm2Parsing,
    setProgress: setPm2Progress,
    setResult: setPm2Result,
    setError: setPm2Error,
    showToast: showPm2Toast,
    appendLoadedFiles: appendPm2Files,
    setLoadedFiles: setPm2Files,
  } = useAnalysisStore.getState();

  const {
    setParsing: setMongoParsing,
    setProgress: setMongoProgress,
    setResult: setMongoResult,
    setError: setMongoError,
    showToast: showMongoToast,
    appendLoadedFiles: appendMongoFiles,
    setLoadedFiles: setMongoFiles,
  } = useMongoStore.getState();

  const { setMode } = useAppModeStore.getState();

  const pm2Seq = ++pm2RequestSeq;
  const mongoSeq = ++mongoRequestSeq;

  // Set visual progress on active store
  setPm2Parsing(true);
  setPm2Progress({ stage: "reading", processed: 0, total: 100, percent: 0 });
  setMongoParsing(true);
  setMongoProgress({ stage: "reading", processed: 0, total: 100, percent: 0 });

  let unlisten: (() => void) | null = null;
  try {
    unlisten = await listen<NativeProgressPayload>("native-progress", (event) => {
      const stage: "complete" | "reading" | "parsing" =
        event.payload.stage === "complete"
          ? "complete"
          : event.payload.stage === "reading"
            ? "reading"
            : "parsing";
      const payload = {
        stage,
        processed: event.payload.processed,
        total: event.payload.total,
        percent: event.payload.percent,
      };
      setPm2Progress(payload);
      setMongoProgress(payload);
    });

    const t0 = performance.now();
    const res = await invoke<NativeIngestResult>("ingest_native_files", {
      paths,
      pm2Options,
      mongoOptions,
      uploadMode,
    });
    const invokeMs = performance.now() - t0;

    const t1 = performance.now();
    let pm2Matched = 0;
    let pm2WallMs = 0;
    let mongoTotalLines = 0;
    let mongoSlowQueries = 0;
    let mongoWallMs = 0;

    const pm2Files: File[] = [];
    const mongoFiles: File[] = [];

    for (const f of res.files) {
      const fileObj = new File([], f.name);
      Object.defineProperty(fileObj, "size", { value: f.size, writable: false });
      if (f.category === "mongo") {
        mongoFiles.push(fileObj);
      } else {
        pm2Files.push(fileObj);
      }
    }

    if (res.pm2) {
      nativePm2Active = true;
      // SAFETY: data or parsed json conforms to AggregatedResult schema emitted by Rust finalizer
      const result = restoreApiKeys(
        (res.pm2.data ?? (res.pm2.json ? JSON.parse(res.pm2.json) : null)) as AggregatedResult,
      );
      pm2Matched = result.summary.matched;
      pm2WallMs = res.pm2.parse_wall_ms;
      if (pm2Seq === pm2RequestSeq) {
        setPm2Result(result);
        if (uploadMode === "append") appendPm2Files(pm2Files);
        else setPm2Files(pm2Files);
      }
      setPm2Progress({ stage: "complete", processed: 100, total: 100, percent: 100 });
      setPm2Parsing(false);
    } else {
      setPm2Parsing(false);
    }

    if (res.mongo) {
      nativeMongoActive = true;
      // SAFETY: data or parsed json conforms to MongoAggregationResult schema emitted by mongo_core
      const parsed = (res.mongo.data ??
        (res.mongo.json ? JSON.parse(res.mongo.json) : null)) as MongoAggregationResult;
      mongoTotalLines = res.mongo.total_lines;
      mongoSlowQueries = res.mongo.slow_query_count;
      mongoWallMs = res.mongo.parse_wall_ms;
      if (mongoSeq === mongoRequestSeq) {
        setMongoResult(parsed);
        if (uploadMode === "append") appendMongoFiles(mongoFiles);
        else setMongoFiles(mongoFiles);
      }
      setMongoProgress({ stage: "complete", processed: 100, total: 100, percent: 100 });
      setMongoParsing(false);
    } else {
      setMongoParsing(false);
    }

    const assembleMs = performance.now() - t1;

    // Tab switching
    if (res.pm2 && res.mongo) {
      // Both tabs populated; keep the current tab
    } else if (res.mongo) {
      setMode("mongo");
    } else if (res.pm2) {
      setMode("pm2");
    }

    const mode = useAppModeStore.getState().mode;
    await waitForFirstPaint(
      mode === "mongo" ? '[data-testid="mongo-kpi-row"]' : '[data-testid="kpi-row"]',
    );
    const readyMs = performance.now() - startedAt;
    const nativeMs = res.parse_wall_ms;

    console.info(
      `[native] ui ready in ${readyMs.toFixed(0)}ms (invoke ${invokeMs.toFixed(0)}ms, assemble ${assembleMs.toFixed(0)}ms, native ${nativeMs.toFixed(0)}ms)`,
    );

    if (res.pm2 && res.mongo) {
      const msg = `UI ready in ${sec(readyMs)} · ${pm2Matched.toLocaleString()} requests + ${mongoTotalLines.toLocaleString()} MongoDB lines (both tabs populated)`;
      showPm2Toast(msg);
      showMongoToast(msg);
    } else if (res.mongo) {
      showMongoToast(
        `UI ready in ${sec(readyMs)} · ${mongoTotalLines.toLocaleString()} lines (${mongoSlowQueries.toLocaleString()} slow, native ${sec(mongoWallMs)})`,
      );
    } else if (res.pm2) {
      showPm2Toast(
        `UI ready in ${sec(readyMs)} · ${pm2Matched.toLocaleString()} requests (native ${sec(pm2WallMs)})`,
      );
    }
  } catch (err) {
    setPm2Parsing(false);
    setMongoParsing(false);
    const message = err instanceof Error ? err.message : String(err);
    setPm2Error(message);
    setMongoError(message);
    showPm2Toast(message);
    throw err;
  } finally {
    if (unlisten) unlisten();
  }
}

if (isTauri()) {
  import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => {
      void getCurrentWindow().onDragDropEvent((event) => {
        if (event.payload.type === "drop") {
          const paths = event.payload.paths;
          if (paths && paths.length > 0) {
            void handleNativePathsUpload(paths, "replace");
          }
        }
      });
    })
    .catch(() => {});
}

// Automation hook for scripts/bench/bench_native_tauri.mjs. It is inert unless the
// benchmark harness opts in via localStorage, so normal runs never see it.
if (isTauri() && localStorage.getItem("pm2-native-bench") === "1") {
  window.__nativeUpload = (paths: string[]) => handleNativePathsUpload(paths, "replace");
}
