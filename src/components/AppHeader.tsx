import { Database, Download, Eraser, FileText, Moon, Sun } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useAnalysisStore } from "../store/analysisStore";
import { useAppModeStore, type AppMode } from "../store/appModeStore";
import { useMongoStore } from "../store/mongoStore";
import { clear as clearPm2 } from "../hooks/useParserWorker";
import { clearMongo } from "../hooks/useMongoParserWorker";
import { exportSpreadsheetData } from "../utils/exportSpreadsheet";
import { exportMongoSpreadsheet } from "../mongo/mongoExport";
import { formatBytes, formatDate } from "../utils/format";
import { MongoHeaderInfo } from "./mongo/MongoHeaderInfo";
import { cn } from "../utils/cn";

const { toggleTheme } = useAnalysisStore.getState();
const { setMode } = useAppModeStore.getState();

function buildDateRangeBadge(dates: string[] | undefined): string | null {
  if (!dates || dates.length === 0) return null;
  if (dates.length > 1) {
    return `${formatDate(dates[0])} → ${formatDate(dates[dates.length - 1])} (${dates.length} days)`;
  }
  return formatDate(dates[0]);
}

function buildSourceLabel(
  kind: string,
  fileName: string | null,
  fileSize: number | null,
): string | null {
  if (kind === "file" && fileName) {
    return `${fileName}${fileSize != null ? ` · ${formatBytes(fileSize)}` : ""}`;
  }
  if (kind === "paste") return "Pasted text";
  return null;
}

function buildFileNamesTitle(fileNames: string[]): string | undefined {
  return fileNames.length > 1 ? fileNames.join("\n") : undefined;
}

export function AppHeader() {
  const appMode = useAppModeStore((s) => s.mode);

  // PM2 State
  const {
    isDark,
    canPm2Export,
    canPm2Clear,
    pm2FileNamesTitle,
    pm2DateRangeBadge,
    pm2SourceLabel,
  } = useAnalysisStore(
    useShallow((s) => ({
      isDark: s.theme === "dark",
      canPm2Export: s.hasData && !s.isParsing,
      canPm2Clear: s.hasData || s.sourceKind !== "none",
      pm2FileNamesTitle: buildFileNamesTitle(s.fileNames),
      pm2DateRangeBadge: buildDateRangeBadge(s.result?.dates),
      pm2SourceLabel: buildSourceLabel(s.sourceKind, s.fileName, s.fileSize),
    })),
  );

  // Mongo State
  const { canMongoExport, canMongoClear } = useMongoStore(
    useShallow((s) => ({
      canMongoExport: s.hasData && !s.isParsing,
      canMongoClear: s.hasData || s.sourceKind !== "none",
    })),
  );

  const isMongo = appMode === "mongo";
  const canExport = isMongo ? canMongoExport : canPm2Export;
  const canClear = isMongo ? canMongoClear : canPm2Clear;

  const handleExport = () => {
    if (isMongo) {
      const result = useMongoStore.getState().result;
      if (result) void exportMongoSpreadsheet(result);
    } else {
      void exportSpreadsheetData();
    }
  };

  const handleClear = () => {
    if (isMongo) clearMongo();
    else clearPm2();
  };

  const handleSwitchMode = (mode: AppMode) => {
    setMode(mode);
  };

  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur-md dark:border-slate-800 dark:bg-slate-900/95">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-2.5">
        {/* Left Side: App Branding & File Info */}
        <div className="min-w-0">
          {isMongo ? (
            <MongoHeaderInfo />
          ) : (
            <div>
              <div className="flex items-center gap-2">
                <FileText className="size-5 shrink-0 text-blue-600 dark:text-blue-400" aria-hidden />
                <h1 className="truncate text-base font-semibold tracking-tight text-slate-900 dark:text-slate-100">
                  PM2 Log Analyzer
                </h1>
                {pm2DateRangeBadge && (
                  <span className="inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700 dark:bg-blue-950/60 dark:text-blue-300">
                    {pm2DateRangeBadge}
                  </span>
                )}
              </div>
              {pm2SourceLabel ? (
                <p
                  className="mt-0.5 truncate font-mono-data text-xs text-slate-500 dark:text-slate-400"
                  title={pm2FileNamesTitle}
                >
                  {pm2SourceLabel}
                </p>
              ) : (
                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  API latency &amp; cron insight
                </p>
              )}
            </div>
          )}
        </div>

        {/* Center: Segmented App Switcher */}
        <div className="flex shrink-0 items-center rounded-xl bg-slate-100 p-1 dark:bg-slate-800">
          <button
            type="button"
            data-testid="app-switcher-pm2"
            onClick={() => handleSwitchMode("pm2")}
            className={cn(
              "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all",
              !isMongo
                ? "bg-white text-blue-600 shadow-xs dark:bg-slate-900 dark:text-blue-400"
                : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200",
            )}
          >
            <FileText className="size-3.5" />
            <span>PM2 Logs</span>
          </button>
          <button
            type="button"
            data-testid="app-switcher-mongo"
            onClick={() => handleSwitchMode("mongo")}
            className={cn(
              "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all",
              isMongo
                ? "bg-white text-emerald-600 shadow-xs dark:bg-slate-900 dark:text-emerald-400"
                : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200",
            )}
          >
            <Database className="size-3.5" />
            <span>MongoDB Logs</span>
          </button>
        </div>

        {/* Right Side: Theme, Export, Clear */}
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={toggleTheme}
            title={isDark ? "Switch to light mode" : "Switch to dark mode"}
            aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
            className="inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white p-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            {isDark ? (
              <Sun className="size-4 text-amber-400" aria-hidden />
            ) : (
              <Moon className="size-4 text-slate-600" aria-hidden />
            )}
          </button>
          <button
            type="button"
            onClick={handleExport}
            disabled={!canExport}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700",
            )}
          >
            <Download className="size-3.5" aria-hidden />
            Export
          </button>
          <button
            type="button"
            onClick={handleClear}
            disabled={!canClear}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            <Eraser className="size-3.5" aria-hidden />
            Clear
          </button>
        </div>
      </div>
    </header>
  );
}
