import { Database } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useMongoStore } from "../../store/mongoStore";
import { formatBytes, formatDate } from "../../utils/format";

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

export function MongoHeaderInfo() {
  const { dateRangeBadge, sourceLabel, fileNamesTitle } = useMongoStore(
    useShallow((s) => ({
      dateRangeBadge: buildDateRangeBadge(s.result?.dates),
      sourceLabel: buildSourceLabel(s.sourceKind, s.fileName, s.fileSize),
      fileNamesTitle: s.fileNames.length > 1 ? s.fileNames.join("\n") : undefined,
    })),
  );

  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        <Database className="size-5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
        <h1 className="truncate text-base font-semibold tracking-tight text-slate-900 dark:text-slate-100">
          MongoDB Log Analyzer
        </h1>
        {dateRangeBadge && (
          <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
            {dateRangeBadge}
          </span>
        )}
      </div>
      {sourceLabel ? (
        <p
          className="mt-0.5 truncate font-mono text-xs text-slate-500 dark:text-slate-400"
          title={fileNamesTitle}
        >
          {sourceLabel}
        </p>
      ) : (
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          Slow queries, COLLSCAN detection &amp; smart index advisor
        </p>
      )}
    </div>
  );
}
