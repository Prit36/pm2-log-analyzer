import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { isTauri } from "../utils/platform";
import type { AggregatedResult } from "../parser/types";
import { useAnalysisStore, workerParseOptions } from "../store/analysisStore";
import { useMongoStore } from "../store/mongoStore";
import { useAppModeStore } from "../store/appModeStore";
import type { MongoAggregationResult } from "../mongo/types";

/** `parse_pm2_files`: all aggregation already done natively, `json` is the result. */
export type Pm2NativeResult = {
  json: string;
  hit_count: number;
  unmatched_count: number;
  methods_mask: number;
  shard_count: number;
  parse_wall_ms: number;
};

export type Pm2ReaggNativeResult = {
  json: string;
  reagg_wall_ms: number;
};

export type MongoNativeResult = {
  json: string;
  parse_wall_ms: number;
  slow_query_count: number;
  total_lines: number;
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
    // SAFETY: json is the AggregatedResult schema emitted by the Rust finalizer
    const result = JSON.parse(res.json) as AggregatedResult;
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

  try {
    const res = await invoke<Pm2ReaggNativeResult>("reaggregate_pm2", { options });
    // SAFETY: json is the AggregatedResult schema emitted by the Rust finalizer
    const result = JSON.parse(res.json) as AggregatedResult;
    setResult(result);
  } catch (err) {
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
    // SAFETY: json is guaranteed MongoAggregationResult JSON schema emitted by mongo_core reaggregate
    const parsed = JSON.parse(res.json) as MongoAggregationResult;
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

    // SAFETY: json string is guaranteed MongoAggregationResult JSON schema emitted by mongo_core reaggregate
    const parsed = JSON.parse(json) as MongoAggregationResult;
    setResult(parsed);
  } catch (err) {
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

export function classifyLogPath(path: string): "pm2" | "mongo" | "unknown" {
  const fileName = (path.split(/[/\\]/).pop() ?? path).toLowerCase();
  if (
    fileName.includes("mongo") ||
    fileName.includes("mongod") ||
    fileName.endsWith(".mongodb.log")
  ) {
    return "mongo";
  }
  if (
    fileName.includes("api") ||
    fileName.includes("pm2") ||
    fileName.includes("access") ||
    fileName.includes("out") ||
    fileName.includes("error")
  ) {
    return "pm2";
  }
  return "unknown";
}

export async function handleNativePathsUpload(
  paths: string[],
  uploadMode: "replace" | "append" = "replace",
): Promise<void> {
  const startedAt = performance.now();
  const pm2Paths: string[] = [];
  const mongoPaths: string[] = [];
  const activeMode = useAppModeStore.getState().mode;

  for (const p of paths) {
    const cat = classifyLogPath(p);
    if (cat === "mongo") {
      mongoPaths.push(p);
    } else if (cat === "pm2") {
      pm2Paths.push(p);
    } else {
      if (activeMode === "mongo") mongoPaths.push(p);
      else pm2Paths.push(p);
    }
  }

  const { appendLoadedFiles: appendPm2Files, setLoadedFiles: setPm2Files } =
    useAnalysisStore.getState();
  const { appendLoadedFiles: appendMongoFiles, setLoadedFiles: setMongoFiles } =
    useMongoStore.getState();
  const { setMode } = useAppModeStore.getState();

  let pm2: Pm2ParseStats | null = null;
  let mongo: MongoParseStats | null = null;

  if (pm2Paths.length > 0) {
    const fakeFiles = pm2Paths.map((p) => new File([], p.split(/[/\\]/).pop() ?? p));
    if (uploadMode === "append") appendPm2Files(fakeFiles);
    else setPm2Files(fakeFiles);
    pm2 = await parsePm2FilesNative(pm2Paths);
  }
  if (mongoPaths.length > 0) {
    const fakeFiles = mongoPaths.map((p) => new File([], p.split(/[/\\]/).pop() ?? p));
    if (uploadMode === "append") appendMongoFiles(fakeFiles);
    else setMongoFiles(fakeFiles);
    mongo = await parseMongoFilesNative(mongoPaths);
  }

  if (pm2Paths.length > 0 && mongoPaths.length > 0) {
    // Keep the current tab; both stores are populated.
  } else if (mongoPaths.length > 0) {
    setMode("mongo");
  } else if (pm2Paths.length > 0) {
    setMode("pm2");
  }

  const mode = useAppModeStore.getState().mode;
  await waitForFirstPaint(
    mode === "mongo" ? '[data-testid="mongo-kpi-row"]' : '[data-testid="kpi-row"]',
  );
  const readyMs = performance.now() - startedAt;

  const invokeMs = (pm2?.invokeMs ?? 0) + (mongo?.invokeMs ?? 0);
  const assembleMs = (pm2?.assembleMs ?? 0) + (mongo?.assembleMs ?? 0);
  const nativeMs = (pm2?.nativeMs ?? 0) + (mongo?.nativeMs ?? 0);
  console.info(
    `[native] ui ready in ${readyMs.toFixed(0)}ms (invoke ${invokeMs.toFixed(0)}ms, assemble ${assembleMs.toFixed(0)}ms, native ${nativeMs.toFixed(0)}ms)`,
  );

  const { showToast: showPm2Toast } = useAnalysisStore.getState();
  const { showToast: showMongoToast } = useMongoStore.getState();

  if (pm2 && mongo) {
    const msg = `UI ready in ${sec(readyMs)} · ${pm2.matched.toLocaleString()} requests + ${mongo.totalLines.toLocaleString()} MongoDB lines`;
    showPm2Toast(msg);
    showMongoToast(msg);
  } else if (mongo) {
    showMongoToast(
      `UI ready in ${sec(readyMs)} · ${mongo.totalLines.toLocaleString()} lines (${mongo.slowQueries.toLocaleString()} slow, native ${sec(mongo.nativeMs)})`,
    );
  } else if (pm2) {
    showPm2Toast(
      `UI ready in ${sec(readyMs)} · ${pm2.matched.toLocaleString()} requests (native ${sec(pm2.nativeMs)})`,
    );
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
