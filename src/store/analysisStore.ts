import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  AggregatedEndpoint,
  AggregatedResult,
  CronAggregated,
  DaySummary,
  HourlyBucket,
  NormalizeMode,
  ParseOptions,
  StatusFamily,
} from "../parser";
import { EMPTY_RESULT } from "../parser";

/** Stable empties for Zustand selectors — never inline `?? []` (infinite re-render). */
export const EMPTY_API: AggregatedEndpoint[] = [];
export const EMPTY_CRON: CronAggregated[] = [];
export const EMPTY_METHODS: string[] = [];
export const EMPTY_SAMPLES: string[] = [];
export const EMPTY_DATES: string[] = [];
export const EMPTY_DAILY: DaySummary[] = [];
export const EMPTY_HOURLY: HourlyBucket[] = [];
export const EMPTY_FILE_NAMES: string[] = [];

export type SortDirection = "asc" | "desc";
export type ApiSortKey = "p95Ms" | "p99Ms" | "avgMs" | "maxMs" | "count" | "errorCount" | "path";
export type CronSortKey =
  | "p95Ms"
  | "p99Ms"
  | "avgMs"
  | "maxMs"
  | "runs"
  | "fails"
  | "starts"
  | "lastDurationMs"
  | "name";

export type ParseProgress = {
  stage: "reading" | "parsing" | "aggregating" | "complete";
  processed: number;
  total: number;
  percent: number;
};

export type SourceKind = "none" | "file" | "paste";

export type AnalysisFilters = {
  normalizeMode: NormalizeMode;
  statusFamily: StatusFamily;
  minMs: number;
  methods: string[];
  query: string;
  sortKey: ApiSortKey;
  sortDir: SortDirection;
  topN: number;
  cronQuery: string;
  cronMinMs: number;
  cronShowFailedOnly: boolean;
  cronSortKey: CronSortKey;
  cronSortDir: SortDirection;
  dateFilter: string;
};

const DEFAULT_FILTERS: AnalysisFilters = {
  normalizeMode: "collapseIds",
  statusFamily: "all",
  minMs: 0,
  methods: [],
  query: "",
  sortKey: "p95Ms",
  sortDir: "desc",
  topN: 50,
  cronQuery: "",
  cronMinMs: 0,
  cronShowFailedOnly: false,
  cronSortKey: "p95Ms",
  cronSortDir: "desc",
  dateFilter: "all",
};

export type Theme = "light" | "dark";

type AnalysisState = {
  theme: Theme;
  sourceKind: SourceKind;
  fileName: string | null;
  fileNames: string[];
  fileSize: number | null;
  loadedFiles: File[];
  hasData: boolean;
  result: AggregatedResult | null;
  isParsing: boolean;
  isWorkerReady: boolean;
  progress: ParseProgress | null;
  error: string | null;
  filters: AnalysisFilters;
  toast: string | null;
  pasteOpen: boolean;

  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
  setWorkerReady: (ready: boolean) => void;
  setParsing: (parsing: boolean) => void;
  setProgress: (progress: ParseProgress | null) => void;
  setResult: (result: AggregatedResult | null) => void;
  setError: (error: string | null) => void;
  setSourceFile: (name: string, size: number) => void;
  setSourceFiles: (files: { name: string; size: number }[]) => void;
  setLoadedFiles: (files: File[]) => File[];
  appendLoadedFiles: (files: File[]) => File[];
  setSourcePaste: () => void;
  setFilters: (patch: Partial<AnalysisFilters>) => void;
  setDateFilter: (dateFilter: string) => void;
  setMethodFilter: (methods: string[]) => void;
  toggleMethod: (method: string) => void;
  showToast: (message: string) => void;
  clearToast: () => void;
  setPasteOpen: (open: boolean) => void;
  clearAnalysis: () => void;
};

let toastTimer: ReturnType<typeof setTimeout> | null = null;

export const useAnalysisStore = create<AnalysisState>()(
  persist(
    (set, get) => ({
      theme: "light",
      sourceKind: "none",
      fileName: null,
      fileNames: [],
      fileSize: null,
      loadedFiles: [],
      hasData: false,
      result: null,
      isParsing: false,
      isWorkerReady: false,
      progress: null,
      error: null,
      filters: { ...DEFAULT_FILTERS },
      toast: null,
      pasteOpen: false,

      toggleTheme: () => {
        const next = get().theme === "light" ? "dark" : "light";
        document.documentElement.classList.toggle("dark", next === "dark");
        set({ theme: next });
      },
      setTheme: (theme) => {
        document.documentElement.classList.toggle("dark", theme === "dark");
        set({ theme });
      },
      setWorkerReady: (ready) => set({ isWorkerReady: ready }),
      setParsing: (parsing) => set({ isParsing: parsing }),
      setProgress: (progress) => set({ progress }),
      setResult: (result) =>
        set({
          result,
          hasData:
            result !== null &&
            (result.summary.matched > 0 ||
              result.cronSummary.jobs > 0 ||
              result.unmatchedCount > 0),
        }),
      setError: (error) => set({ error }),
      setSourceFile: (name, size) =>
        set({
          sourceKind: "file",
          fileName: name,
          fileNames: [name],
          fileSize: size,
          pasteOpen: false,
        }),
      setSourceFiles: (files) => {
        const totalSize = files.reduce((acc, f) => acc + f.size, 0);
        const names = files.map((f) => f.name);
        const displayName =
          files.length === 1
            ? files[0]!.name
            : `${files.length} log files (${files[0]!.name}, ...)`;
        set({
          sourceKind: "file",
          fileName: displayName,
          fileNames: names,
          fileSize: totalSize,
          pasteOpen: false,
        });
      },
      setLoadedFiles: (files) => {
        const seenSizes = new Set<number>();
        const uniqueFiles: File[] = [];
        for (const file of files) {
          if (!seenSizes.has(file.size)) {
            seenSizes.add(file.size);
            uniqueFiles.push(file);
          }
        }
        if (uniqueFiles.length < files.length) {
          const skipped = files.length - uniqueFiles.length;
          get().showToast(
            `Skipped ${skipped} duplicate file${skipped > 1 ? "s" : ""} (identical file size)`,
          );
        }
        const totalSize = uniqueFiles.reduce((acc, f) => acc + f.size, 0);
        const names = uniqueFiles.map((f) => f.name);
        const displayName =
          uniqueFiles.length === 1
            ? uniqueFiles[0]!.name
            : `${uniqueFiles.length} log files (${uniqueFiles[0]!.name}, ...)`;
        set({
          sourceKind: "file",
          fileName: displayName,
          fileNames: names,
          fileSize: totalSize,
          loadedFiles: uniqueFiles,
          pasteOpen: false,
        });
        return uniqueFiles;
      },
      appendLoadedFiles: (newFiles) => {
        const existing = get().loadedFiles;
        const seenSizes = new Set(existing.map((f) => f.size));
        const uniqueNew: File[] = [];
        for (const file of newFiles) {
          if (!seenSizes.has(file.size)) {
            seenSizes.add(file.size);
            uniqueNew.push(file);
          }
        }
        if (uniqueNew.length === 0) {
          get().showToast("All selected files are already loaded (identical file size)");
          return existing;
        }
        if (uniqueNew.length < newFiles.length) {
          const skipped = newFiles.length - uniqueNew.length;
          get().showToast(
            `Skipped ${skipped} duplicate file${skipped > 1 ? "s" : ""} (already loaded with same size)`,
          );
        }
        const combined = [...existing, ...uniqueNew];
        const totalSize = combined.reduce((acc, f) => acc + f.size, 0);
        const names = combined.map((f) => f.name);
        const displayName =
          combined.length === 1
            ? combined[0]!.name
            : `${combined.length} log files (${combined[0]!.name}, ...)`;
        set({
          sourceKind: "file",
          fileName: displayName,
          fileNames: names,
          fileSize: totalSize,
          loadedFiles: combined,
          pasteOpen: false,
        });
        return combined;
      },
      setSourcePaste: () =>
        set({
          sourceKind: "paste",
          fileName: null,
          fileNames: [],
          fileSize: null,
          loadedFiles: [],
        }),
      setFilters: (patch) => set({ filters: { ...get().filters, ...patch } }),
      setDateFilter: (dateFilter) => set({ filters: { ...get().filters, dateFilter } }),
      setMethodFilter: (methods) => set({ filters: { ...get().filters, methods } }),
      toggleMethod: (method) => {
        const { methods } = get().filters;
        const next = methods.includes(method)
          ? methods.filter((m) => m !== method)
          : [...methods, method];
        set({ filters: { ...get().filters, methods: next } });
      },
      showToast: (message) => {
        if (toastTimer) clearTimeout(toastTimer);
        set({ toast: message });
        toastTimer = setTimeout(() => {
          set({ toast: null });
        }, 3200);
      },
      clearToast: () => {
        if (toastTimer) clearTimeout(toastTimer);
        set({ toast: null });
      },
      setPasteOpen: (open) => set({ pasteOpen: open }),
      clearAnalysis: () =>
        set({
          sourceKind: "none",
          fileName: null,
          fileNames: [],
          fileSize: null,
          loadedFiles: [],
          hasData: false,
          result: null,
          progress: null,
          error: null,
          isParsing: false,
          pasteOpen: false,
        }),
    }),
    {
      name: "pm2-analyzer-filters",
      partialize: (s) => ({ filters: s.filters, theme: s.theme }),
    },
  ),
);

export function workerParseOptions(filters: AnalysisFilters): ParseOptions {
  return {
    normalizeMode: filters.normalizeMode,
    methodFilter: null, // method filter is client-side
    statusFamily: filters.statusFamily,
    minMs: filters.minMs,
    cronQuery: filters.cronQuery,
    cronMinMs: filters.cronMinMs,
    cronShowFailedOnly: filters.cronShowFailedOnly,
    dateFilter: filters.dateFilter === "all" ? null : filters.dateFilter,
  };
}

export { DEFAULT_FILTERS, EMPTY_RESULT };
