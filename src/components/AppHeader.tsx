import { Download, Eraser, FileText, Moon, Sun } from "lucide-react";
import { useAnalysisStore } from "../store/analysisStore";
import { formatBytes } from "../utils/format";
import { cn } from "../utils/cn";

type Props = {
  onExport: () => void;
  onClear: () => void;
};

export function AppHeader({ onExport, onClear }: Props) {
  const hasData = useAnalysisStore((s) => s.hasData);
  const sourceKind = useAnalysisStore((s) => s.sourceKind);
  const fileName = useAnalysisStore((s) => s.fileName);
  const fileSize = useAnalysisStore((s) => s.fileSize);
  const isParsing = useAnalysisStore((s) => s.isParsing);
  const theme = useAnalysisStore((s) => s.theme);
  const toggleTheme = useAnalysisStore((s) => s.toggleTheme);

  const sourceLabel =
    sourceKind === "file" && fileName
      ? `${fileName}${fileSize != null ? ` · ${formatBytes(fileSize)}` : ""}`
      : sourceKind === "paste"
        ? "Pasted text"
        : null;

  return (
    <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur dark:border-slate-800 dark:bg-slate-900/95">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <FileText className="size-5 shrink-0 text-blue-600 dark:text-blue-400" aria-hidden />
            <h1 className="truncate text-base font-semibold tracking-tight text-slate-900 dark:text-slate-100">
              PM2 Log Analyzer
            </h1>
          </div>
          {sourceLabel ? (
            <p className="mt-0.5 truncate font-mono-data text-xs text-slate-500 dark:text-slate-400">
              {sourceLabel}
            </p>
          ) : (
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              API latency &amp; cron insight
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={toggleTheme}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            className="inline-flex items-center justify-center rounded border border-slate-200 bg-white p-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            {theme === "dark" ? (
              <Sun className="size-4 text-amber-400" aria-hidden />
            ) : (
              <Moon className="size-4 text-slate-600" aria-hidden />
            )}
          </button>
          <button
            type="button"
            onClick={onExport}
            disabled={!hasData || isParsing}
            className={cn(
              "inline-flex items-center gap-1.5 rounded border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700",
            )}
          >
            <Download className="size-3.5" aria-hidden />
            Export
          </button>
          <button
            type="button"
            onClick={onClear}
            disabled={!hasData && sourceKind === "none"}
            className="inline-flex items-center gap-1.5 rounded border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            <Eraser className="size-3.5" aria-hidden />
            Clear
          </button>
        </div>
      </div>
    </header>
  );
}
