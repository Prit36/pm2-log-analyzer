import { Network } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useNginxStore } from "../../store/nginxStore";
import { formatBytes, formatDate } from "../../utils/format";

export function NginxHeaderInfo() {
  const { fileName, fileNames, fileSize, sourceKind, dates } = useNginxStore(
    useShallow((s) => ({
      fileName: s.fileName,
      fileNames: s.fileNames,
      fileSize: s.fileSize,
      sourceKind: s.sourceKind,
      dates: s.result?.dates,
    })),
  );
  const source =
    sourceKind === "paste"
      ? "Pasted text"
      : fileName
        ? `${fileName}${fileSize != null ? ` · ${formatBytes(fileSize)}` : ""}`
        : "Access traffic, errors & upstream latency";
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        <Network className="size-5 shrink-0 text-violet-600 dark:text-violet-400" aria-hidden />
        <h1 className="truncate text-base font-semibold tracking-tight text-slate-900 dark:text-slate-100">
          Nginx Log Analyzer
        </h1>
        {dates && dates.length > 0 && (
          <span className="hidden shrink-0 rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-medium text-violet-700 md:inline-flex dark:bg-violet-950/60 dark:text-violet-300">
            {formatDate(dates[0])}
            {dates.length > 1 && ` → ${formatDate(dates[dates.length - 1])}`}
          </span>
        )}
      </div>
      <p
        className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400"
        title={fileNames.join("\n")}
      >
        {source}
      </p>
    </div>
  );
}
