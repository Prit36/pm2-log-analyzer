import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  AggregatedEndpoint,
  AggregatedResult,
  CronAggregated,
  NormalizeMode,
  StatusFamily,
} from "../parser";
import { EMPTY_RESULT } from "../parser";

/** Stable empties for Zustand selectors — never inline `?? []` (infinite re-render). */
export const EMPTY_API: AggregatedEndpoint[] = [];
export const EMPTY_CRON: CronAggregated[] = [];
export const EMPTY_METHODS: string[] = [];
export const EMPTY_SAMPLES: string[] = [];

export type ApiSortKey = "p95Ms" | "p99Ms" | "avgMs" | "maxMs" | "count" | "errorCount";
export type CronSortKey = "p95Ms" | "p99Ms" | "avgMs" | "maxMs" | "runs" | "fails";

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
  topN: number;
  cronQuery: string;
  cronMinMs: number;
  cronShowFailedOnly: boolean;
  cronSortKey: CronSortKey;
};

const DEFAULT_FILTERS: AnalysisFilters = {
  normalizeMode: "collapseIds",
  statusFamily: "all",
  minMs: 0,
  methods: [],
  query: "",
  sortKey: "p95Ms",
  topN: 50,
  cronQuery: "",
  cronMinMs: 0,
  cronShowFailedOnly: false,
  cronSortKey: "p95Ms",
};

export type Theme = "light" | "dark";

type AnalysisState = {
  theme: Theme;
  sourceKind: SourceKind;
  fileName: string | null;
  fileSize: number | null;
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
  setSourcePaste: () => void;
  setFilters: (patch: Partial<AnalysisFilters>) => void;
  setMethodFilter: (methods: string[]) => void;
  toggleMethod: (method: string) => void;
  showToast: (message: string) => void;
  clearToast: () => void;
  setPasteOpen: (open: boolean) => void;
  clearAnalysis: () => void;
};

export const useAnalysisStore = create<AnalysisState>()(
  persist(
    (set, get) => ({
      theme: "light",
      sourceKind: "none",
      fileName: null,
      fileSize: null,
      hasData: false,
      result: null,
      isParsing: false,
      isWorkerReady: false,
      progress: null,
      error: null,
      filters: { ...DEFAULT_FILTERS },
      toast: null,
      pasteOpen: false,

      toggleTheme: () => set({ theme: get().theme === "light" ? "dark" : "light" }),
      setTheme: (theme) => set({ theme }),
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
        set({ sourceKind: "file", fileName: name, fileSize: size, pasteOpen: false }),
      setSourcePaste: () => set({ sourceKind: "paste", fileName: null, fileSize: null }),
      setFilters: (patch) => set({ filters: { ...get().filters, ...patch } }),
      setMethodFilter: (methods) => set({ filters: { ...get().filters, methods } }),
      toggleMethod: (method) => {
        const { methods } = get().filters;
        const next = methods.includes(method)
          ? methods.filter((m) => m !== method)
          : [...methods, method];
        set({ filters: { ...get().filters, methods: next } });
      },
      showToast: (message) => set({ toast: message }),
      clearToast: () => set({ toast: null }),
      setPasteOpen: (open) => set({ pasteOpen: open }),
      clearAnalysis: () =>
        set({
          sourceKind: "none",
          fileName: null,
          fileSize: null,
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

export function workerParseOptions(filters: AnalysisFilters): {
  normalizeMode: NormalizeMode;
  methodFilter: null;
  statusFamily: StatusFamily;
  minMs: number;
  cronQuery: string;
  cronMinMs: number;
  cronShowFailedOnly: boolean;
} {
  return {
    normalizeMode: filters.normalizeMode,
    methodFilter: null, // method filter is client-side
    statusFamily: filters.statusFamily,
    minMs: filters.minMs,
    cronQuery: filters.cronQuery,
    cronMinMs: filters.cronMinMs,
    cronShowFailedOnly: filters.cronShowFailedOnly,
  };
}

export { DEFAULT_FILTERS, EMPTY_RESULT };
