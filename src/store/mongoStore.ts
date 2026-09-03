import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  MongoAggregationResult,
  MongoFilters,
  MongoPlanFilter,
  MongoSlowQuery,
  MongoSlowQuerySortField,
  MongoSortField,
  MongoUserActivity,
} from "../mongo/types";
import { DEFAULT_MONGO_FILTERS, EMPTY_MONGO_RESULT } from "../mongo/types";
import type { ParseProgress, SourceKind } from "./analysisStore";

export type MongoActiveView = "patterns" | "slow_queries" | "charts" | "diagnostics" | "users";

type MongoStoreState = {
  sourceKind: SourceKind;
  fileName: string | null;
  fileNames: string[];
  fileSize: number | null;
  loadedFiles: File[];
  hasData: boolean;
  result: MongoAggregationResult | null;
  isParsing: boolean;
  isWorkerReady: boolean;
  progress: ParseProgress | null;
  error: string | null;
  filters: MongoFilters;
  toast: string | null;
  pasteOpen: boolean;
  activeSlowQuery: MongoSlowQuery | null;
  activeUserDetail: MongoUserActivity | null;
  activeView: MongoActiveView;

  setWorkerReady: (ready: boolean) => void;
  setParsing: (parsing: boolean) => void;
  setProgress: (progress: ParseProgress | null) => void;
  setResult: (result: MongoAggregationResult | null) => void;
  setError: (error: string | null) => void;
  setSourceFile: (name: string, size: number) => void;
  setSourceFiles: (files: { name: string; size: number }[]) => void;
  setLoadedFiles: (files: File[]) => File[];
  appendLoadedFiles: (files: File[]) => File[];
  setSourcePaste: () => void;
  setFilters: (patch: Partial<MongoFilters>) => void;
  setOperationFilter: (op: string) => void;
  setPlanFilter: (plan: MongoPlanFilter) => void;
  setCollectionFilter: (coll: string) => void;
  setUserFilter: (user: string) => void;
  setMinDurationMs: (ms: number) => void;
  setSearchQuery: (query: string) => void;
  toggleHighScanRatio: () => void;
  setSort: (field: MongoSortField, dir?: "asc" | "desc") => void;
  setSlowSort: (field: MongoSlowQuerySortField, dir?: "asc" | "desc") => void;
  setActiveSlowQuery: (query: MongoSlowQuery | null) => void;
  setActiveUserDetail: (user: MongoUserActivity | null) => void;
  setActiveView: (view: MongoActiveView) => void;
  showToast: (message: string) => void;
  clearToast: () => void;
  setPasteOpen: (open: boolean) => void;
  clearAnalysis: () => void;
};

let toastTimer: ReturnType<typeof setTimeout> | null = null;

export const useMongoStore = create<MongoStoreState>()(
  persist(
    (set, get) => ({
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
      filters: { ...DEFAULT_MONGO_FILTERS },
      toast: null,
      pasteOpen: false,
      activeSlowQuery: null,
      activeUserDetail: null,
      activeView: "patterns",

      setWorkerReady: (ready) => set({ isWorkerReady: ready }),
      setParsing: (parsing) => set({ isParsing: parsing }),
      setProgress: (progress) => set({ progress }),
      setResult: (result) =>
        set({
          result,
          hasData: result !== null && (result.summary.slowQueryCount > 0 || result.summary.totalLines > 0),
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
            : `${files.length} MongoDB log files (${files[0]!.name}, ...)`;
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
          get().showToast("All selected files are already loaded");
          return existing;
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
      setOperationFilter: (op) => set({ filters: { ...get().filters, operation: op } }),
      setPlanFilter: (plan) => set({ filters: { ...get().filters, planFilter: plan } }),
      setCollectionFilter: (collection) => set({ filters: { ...get().filters, collection } }),
      setUserFilter: (userFilter) => set({ filters: { ...get().filters, userFilter } }),
      setMinDurationMs: (minDurationMs) => set({ filters: { ...get().filters, minDurationMs } }),
      setSearchQuery: (searchQuery) => set({ filters: { ...get().filters, searchQuery } }),
      toggleHighScanRatio: () =>
        set({ filters: { ...get().filters, highScanRatioOnly: !get().filters.highScanRatioOnly } }),

      setSort: (sortField, dir) => {
        const current = get().filters;
        const sortDirection =
          dir ?? (current.sortField === sortField && current.sortDirection === "desc" ? "asc" : "desc");
        set({ filters: { ...current, sortField, sortDirection } });
      },

      setSlowSort: (slowSortField, dir) => {
        const current = get().filters;
        const slowSortDirection =
          dir ??
          (current.slowSortField === slowSortField && current.slowSortDirection === "desc"
            ? "asc"
            : "desc");
        set({ filters: { ...current, slowSortField, slowSortDirection } });
      },

      setActiveSlowQuery: (query) => set({ activeSlowQuery: query }),
      setActiveUserDetail: (user) => set({ activeUserDetail: user }),
      setActiveView: (view) => set({ activeView: view }),

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
          activeSlowQuery: null,
          activeUserDetail: null,
        }),
    }),
    {
      name: "mongo-analyzer-filters",
      partialize: (s) => ({ filters: s.filters, activeView: s.activeView }),
    },
  ),
);

export { EMPTY_MONGO_RESULT };
