import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { isTauri } from "../utils/platform";
import type { AggregatedResult } from "../parser/types";
import { useAnalysisStore, workerParseOptions } from "../store/analysisStore";
import { useMongoStore } from "../store/mongoStore";
import { useAppModeStore } from "../store/appModeStore";
import type { MongoAggregationResult } from "../mongo/types";

/**
 * Large results travel through the Rust loopback payload server instead of the
 * `invoke` response: WebView2's IPC custom protocol caps around 140MB/s, while
 * the localhost fetch moves the same bytes ~3x faster.
 */
type NativePayload = {
  url: string;
  bytes: number;
};

type Pm2NativeResult = {
  payload?: NativePayload;
  hit_count: number;
  unmatched_count: number;
  methods_mask: number;
  shard_count: number;
  parse_wall_ms: number;
};

type Pm2ReaggNativeResult = {
  payload?: NativePayload;
  reagg_wall_ms: number;
};

type MongoNativeResult = {
  payload?: NativePayload;
  parse_wall_ms: number;
  slow_query_count: number;
  total_lines: number;
};

type NativeFileInfo = {
  name: string;
  path: string;
  size: number;
  category: "pm2" | "mongo" | "skip" | "unknown";
};

type NativeIngestResult = {
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

/**
 * Native results omit the per-row `key` (it is always `method + " " + path`);
 * rebuilding it here keeps the payload smaller without changing the
 * `AggregatedResult` contract the UI consumes.
 */
function restoreApiKeys(result: AggregatedResult): AggregatedResult {
  for (const row of result.api) {
    if (!row.key) row.key = `${row.method} ${row.path}`;
  }
  return result;
}

/** Fetch and parse one loopback payload; `null` when the result carried none. */
async function readPayload<T>(ref: NativePayload | null | undefined): Promise<T | null> {
  if (!ref) return null;
  const response = await fetch(ref.url);
  if (!response.ok) throw new Error(`payload fetch failed: HTTP ${response.status}`);
  // SAFETY: the URL is served by the Rust payload server, which only publishes
  // the JSON this module's result types describe.
  return (await response.json()) as T;
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
        extensions: ["log", "txt", "json", "zip", "gz"],
      },
    ],
  });
  if (!selected) return null;
  return Array.isArray(selected) ? selected : [selected];
}

export async function pickNativeDirectory(): Promise<string | null> {
  if (!isTauri()) return null;
  const selected = await open({ directory: true, multiple: false });
  return Array.isArray(selected) ? (selected[0] ?? null) : selected;
}

export async function reaggregatePm2Native(): Promise<void> {
  const { setResult, setError } = useAnalysisStore.getState();
  const options = workerParseOptions(useAnalysisStore.getState().filters);
  const seq = ++pm2RequestSeq;

  try {
    const res = await invoke<Pm2ReaggNativeResult>("reaggregate_pm2", { options });
    const payload = await readPayload<AggregatedResult>(res.payload);
    if (seq !== pm2RequestSeq) return;
    setResult(payload ? restoreApiKeys(payload) : null);
  } catch (err) {
    if (seq !== pm2RequestSeq) return;
    const message = err instanceof Error ? err.message : String(err);
    setError(message);
    throw err;
  }
}

interface MongoReaggNativeResult {
  payload?: NativePayload;
  reagg_wall_ms?: number;
}

export async function reaggregateMongoNative(): Promise<void> {
  const { setResult, setError, filters } = useMongoStore.getState();
  const seq = ++mongoRequestSeq;

  try {
    const res = await invoke<MongoReaggNativeResult>("reaggregate_mongo", {
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

    const payload = await readPayload<MongoAggregationResult>(res.payload);
    setResult(payload);
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

    // Both payloads travel over the loopback server, so fetch them together.
    const [pm2Result, mongoResult] = await Promise.all([
      readPayload<AggregatedResult>(res.pm2?.payload),
      readPayload<MongoAggregationResult>(res.mongo?.payload),
    ]);

    if (res.pm2 && pm2Result) {
      nativePm2Active = true;
      const result = restoreApiKeys(pm2Result);
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

    if (res.mongo && mongoResult) {
      nativeMongoActive = true;
      const parsed = mongoResult;
      mongoTotalLines = res.mongo.total_lines;
      mongoSlowQueries = res.mongo.slow_query_count;
      mongoWallMs = res.mongo.parse_wall_ms;
      if (mongoSeq === mongoRequestSeq) {
        setMongoResult(parsed);
        if (uploadMode === "append") appendMongoFiles(mongoFiles);
        else setMongoFiles(mongoFiles);
      }
      const w = window;
      if (!w.__MONGO_BENCH__) {
        w.__MONGO_BENCH__ = {
          at: new Date().toISOString(),
          source: "native",
          parseWallMs: 0,
          slowQueryCount: 0,
          collscanCount: 0,
          patternsCount: 0,
          collectionsCount: 0,
          p95DurationMs: 0,
          reaggTimes: [],
        };
      }
      Object.assign(w.__MONGO_BENCH__, {
        parseWallMs: mongoWallMs,
        slowQueryCount: mongoSlowQueries,
        collscanCount: parsed?.summary?.collscanCount ?? 0,
        patternsCount: parsed?.patterns?.length ?? 0,
        collectionsCount: parsed?.collections?.length ?? 0,
        p95DurationMs: parsed?.summary?.p95DurationMs ?? 0,
      });
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
