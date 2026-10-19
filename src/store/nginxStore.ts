import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DEFAULT_NGINX_FILTERS } from "../nginx/types";
import type { NginxFilters, NginxResult, NginxView } from "../nginx/types";
import type { ParseProgress, SourceKind } from "./analysisStore";
import { resolveIps } from "../nginx/ipLookup";

export type NginxSource = { name: string; size: number };

type NginxStoreState = {
  sourceKind: SourceKind;
  fileName: string | null;
  fileNames: string[];
  fileSize: number | null;
  sources: NginxSource[];
  hasData: boolean;
  result: NginxResult | null;
  isParsing: boolean;
  isWorkerReady: boolean;
  progress: ParseProgress | null;
  error: string | null;
  filters: NginxFilters;
  activeView: NginxView;
  pasteOpen: boolean;
  toast: string | null;
  setWorkerReady: (ready: boolean) => void;
  setParsing: (parsing: boolean) => void;
  setProgress: (progress: ParseProgress | null) => void;
  setResult: (result: NginxResult | null) => void;
  setError: (error: string | null) => void;
  setSourceFile: (name: string, size: number) => void;
  setSourceFiles: (sources: NginxSource[]) => void;
  appendSourceFiles: (sources: NginxSource[]) => void;
  setLoadedFiles: (files: File[]) => File[];
  appendLoadedFiles: (files: File[]) => File[];
  setSourcePaste: () => void;
  setFilters: (patch: Partial<NginxFilters>) => void;
  resetFilters: () => void;
  setActiveView: (view: NginxView) => void;
  setPasteOpen: (open: boolean) => void;
  showToast: (message: string) => void;
  clearToast: () => void;
  clearAnalysis: () => void;
};

let toastTimer: ReturnType<typeof setTimeout> | null = null;

function sourceState(sources: NginxSource[]) {
  return {
    sourceKind: "file" as const,
    sources,
    fileNames: sources.map((source) => source.name),
    fileName:
      sources.length === 1
        ? sources[0]!.name
        : `${sources.length} Nginx log files (${sources[0]?.name ?? ""}, ...)`,
    fileSize: sources.reduce((sum, source) => sum + source.size, 0),
    pasteOpen: false,
  };
}

export const useNginxStore = create<NginxStoreState>()(
  persist(
    (set, get) => ({
      sourceKind: "none",
      sources: [],
      fileName: null,
      fileNames: [],
      fileSize: null,
      hasData: false,
      result: null,
      isParsing: false,
      isWorkerReady: false,
      progress: null,
      error: null,
      filters: { ...DEFAULT_NGINX_FILTERS },
      activeView: "endpoints",
      pasteOpen: false,
      toast: null,
      setWorkerReady: (ready) => set({ isWorkerReady: ready }),
      setParsing: (parsing) => set({ isParsing: parsing }),
      setProgress: (progress) => set({ progress }),
      setResult: (result) => {
        set({ result, hasData: result !== null && result.diagnostics.totalLines > 0 });
        if (result && get().activeView === "clients")
          void resolveIps(result.clients.map((row) => row.value));
      },
      setError: (error) => set({ error }),
      setSourceFile: (name, size) => set(sourceState([{ name, size }])),
      setSourceFiles: (sources) => set(sourceState(sources)),
      appendSourceFiles: (sources) => set(sourceState([...get().sources, ...sources])),
      setLoadedFiles: (files) => {
        set(sourceState(files.map((file) => ({ name: file.name, size: file.size }))));
        return files;
      },
      appendLoadedFiles: (files) => {
        set(
          sourceState([
            ...get().sources,
            ...files.map((file) => ({ name: file.name, size: file.size })),
          ]),
        );
        return files;
      },
      setSourcePaste: () =>
        set({
          sourceKind: "paste",
          sources: [],
          fileName: null,
          fileNames: [],
          fileSize: null,
          pasteOpen: false,
        }),
      setFilters: (patch) => set({ filters: { ...get().filters, ...patch } }),
      resetFilters: () => set({ filters: { ...DEFAULT_NGINX_FILTERS } }),
      setActiveView: (activeView) => {
        set({ activeView });
        const clients = get().result?.clients;
        if (activeView === "clients" && clients) void resolveIps(clients.map((row) => row.value));
      },
      setPasteOpen: (pasteOpen) => set({ pasteOpen }),
      showToast: (toast) => {
        if (toastTimer) clearTimeout(toastTimer);
        set({ toast });
        toastTimer = setTimeout(() => set({ toast: null }), 3200);
      },
      clearToast: () => {
        if (toastTimer) clearTimeout(toastTimer);
        set({ toast: null });
      },
      clearAnalysis: () =>
        set({
          sourceKind: "none",
          sources: [],
          fileName: null,
          fileNames: [],
          fileSize: null,
          hasData: false,
          result: null,
          isParsing: false,
          progress: null,
          error: null,
          pasteOpen: false,
        }),
    }),
    {
      name: "nginx-analyzer-filters",
      // Filters saved before a field existed keep working with its default.
      merge: (persisted, current) => {
        // SAFETY: persisted state was written by partialize below.
        const saved = (persisted ?? {}) as Partial<Pick<NginxStoreState, "filters" | "activeView">>;
        return {
          ...current,
          ...saved,
          filters: { ...DEFAULT_NGINX_FILTERS, ...saved.filters },
        };
      },
      partialize: (state) => ({ filters: state.filters, activeView: state.activeView }),
    },
  ),
);
