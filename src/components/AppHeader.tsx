import { Download, Eraser, FileText, Moon, Sun } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useAnalysisStore } from "../store/analysisStore";
import { clear } from "../hooks/useParserWorker";
import { exportSpreadsheetData } from "../utils/exportSpreadsheet";
import { formatBytes, formatDate } from "../utils/format";
import { cn } from "../utils/cn";

const { toggleTheme } = useAnalysisStore.getState();

export function AppHeader() {
  const { isDark, canExport, canClear, fileNamesTitle, dateRangeBadge, sourceLabel } =
    useAnalysisStore(
      useShallow((s) => {
        const dates = s.result?.dates;
        const dateRangeBadge =
          !dates || dates.length === 0
            ? null
            : dates.length > 1
              ? `${formatDate(dates[0])} → ${formatDate(dates[dates.length - 1])} (${dates.length} days)`
              : formatDate(dates[0]);
        const sourceLabel =
          s.sourceKind === "file" && s.fileName
            ? `${s.fileName}${s.fileSize != null ? ` · ${formatBytes(s.fileSize)}` : ""}`
            : s.sourceKind === "paste"
              ? "Pasted text"
              : null;
        const fileNamesTitle =
          s.fileNames && s.fileNames.length > 1 ? s.fileNames.join("\n") : undefined;

        return {
          isDark: s.theme === "dark",
          canExport: s.hasData && !s.isParsing,
          canClear: s.hasData || s.sourceKind !== "none",
          fileNamesTitle,
          dateRangeBadge,
          sourceLabel,
        };
      }),
    );

  return (
    <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur dark:border-slate-800 dark:bg-slate-900/95">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <FileText className="size-5 shrink-0 text-blue-600 dark:text-blue-400" aria-hidden />
            <h1 className="truncate text-base font-semibold tracking-tight text-slate-900 dark:text-slate-100">
              PM2 Log Analyzer
            </h1>
            {dateRangeBadge && (
              <span className="inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700 dark:bg-blue-950/60 dark:text-blue-300">
                {dateRangeBadge}
              </span>
            )}
          </div>
          {sourceLabel ? (
            <p
              className="mt-0.5 truncate font-mono-data text-xs text-slate-500 dark:text-slate-400"
              title={fileNamesTitle}
            >
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
            title={isDark ? "Switch to light mode" : "Switch to dark mode"}
            aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
            className="inline-flex items-center justify-center rounded border border-slate-200 bg-white p-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            {isDark ? (
              <Sun className="size-4 text-amber-400" aria-hidden />
            ) : (
              <Moon className="size-4 text-slate-600" aria-hidden />
            )}
          </button>
          <button
            type="button"
            onClick={() => void exportSpreadsheetData()}
            disabled={!canExport}
            className={cn(
              "inline-flex items-center gap-1.5 rounded border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700",
            )}
          >
            <Download className="size-3.5" aria-hidden />
            Export
          </button>
          <button
            type="button"
            onClick={clear}
            disabled={!canClear}
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
