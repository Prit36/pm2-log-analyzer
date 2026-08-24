import { useRef, useState, type DragEvent } from "react";
import { ClipboardPaste, FilePlus, Plus, RefreshCw, Upload, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useAnalysisStore } from "../store/analysisStore";
import { cancel, parseFiles, parseText } from "../hooks/useParserWorker";
import { formatBytes } from "../utils/format";
import { cn } from "../utils/cn";

/** Soft guard for paste path — large dumps should use file upload. */
export const PASTE_WARN_BYTES = 8 * 1024 * 1024;

const { appendLoadedFiles, setLoadedFiles, setPasteOpen, setSourcePaste, showToast } =
  useAnalysisStore.getState();

function filterValidFiles(fileList: FileList | File[] | null | undefined): File[] {
  if (!fileList || fileList.length === 0) return [];
  return Array.from(fileList).filter((file) => {
    return (
      /\.log\d*$/i.test(file.name) ||
      file.name.endsWith(".txt") ||
      file.type === "text/plain" ||
      file.type === ""
    );
  });
}

export function IngestPanel() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploadMode, setUploadMode] = useState<"replace" | "append">("replace");
  const [pendingDrop, setPendingDrop] = useState<File[] | null>(null);
  const [pasteText, setPasteText] = useState("");

  const { isParsing, busy, progress, hasData, loadedFiles, pasteOpen } = useAnalysisStore(
    useShallow((s) => ({
      isParsing: s.isParsing,
      busy: s.isParsing || !s.isWorkerReady,
      progress: s.progress,
      hasData: s.hasData,
      loadedFiles: s.loadedFiles,
      pasteOpen: s.pasteOpen,
    })),
  );

  const executeAppend = (files: File[]) => {
    setPendingDrop(null);
    const existingCount = useAnalysisStore.getState().loadedFiles.length;
    const combined = appendLoadedFiles(files);
    if (combined.length === existingCount) return;
    void parseFiles(combined);
  };

  const executeReplace = (files: File[]) => {
    setPendingDrop(null);
    const unique = setLoadedFiles(files);
    if (unique.length === 0) return;
    void parseFiles(unique);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (busy) return;
    const validFiles = filterValidFiles(e.dataTransfer.files);
    if (validFiles.length === 0) {
      showToast("Please upload log or text files (.log, .log1, .txt, etc.)");
      return;
    }
    if (hasData && loadedFiles.length > 0) {
      setPendingDrop(validFiles);
    } else {
      executeReplace(validFiles);
    }
  };

  const handleAppendClick = () => {
    setUploadMode("append");
    inputRef.current?.click();
  };

  const handleReplaceClick = () => {
    setUploadMode("replace");
    inputRef.current?.click();
  };

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const validFiles = filterValidFiles(e.target.files);
    if (validFiles.length === 0) {
      showToast("Please upload log or text files (.log, .log1, .txt, etc.)");
      e.target.value = "";
      return;
    }
    if (uploadMode === "append" && hasData && loadedFiles.length > 0) {
      executeAppend(validFiles);
    } else {
      executeReplace(validFiles);
    }
    e.target.value = "";
  };

  const handlePasteAnalyze = () => {
    const text = pasteText.trim();
    if (!text) {
      showToast("Paste some log lines first");
      return;
    }
    const bytes = new Blob([text]).size;
    if (bytes > PASTE_WARN_BYTES) {
      showToast(
        `Paste is ${formatBytes(bytes)} — save as a .log file and upload instead (limit ~${formatBytes(PASTE_WARN_BYTES)})`,
      );
      return;
    }
    setSourcePaste();
    void parseText(text);
  };

  return (
    <section className="rounded border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      {hasData ? (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            if (!busy) setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          className={cn(
            "relative flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 transition-colors",
            dragOver ? "bg-blue-50/80 dark:bg-blue-950/40" : "bg-white dark:bg-slate-900",
            busy && "opacity-60",
          )}
        >
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <Upload className="size-4 shrink-0 text-slate-400 dark:text-slate-500" aria-hidden />
            {loadedFiles.length > 0 ? (
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  {loadedFiles.length} file{loadedFiles.length > 1 ? "s" : ""}:
                </span>
                {loadedFiles.slice(0, 5).map((f) => (
                  <span
                    key={`${f.name}-${f.size}`}
                    className="inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-0.5 font-mono-data text-[11px] text-slate-700 dark:bg-slate-800 dark:text-slate-300"
                    title={`${f.name} (${formatBytes(f.size)})`}
                  >
                    <span className="max-w-[150px] truncate">{f.name}</span>
                    <span className="text-[10px] text-slate-400 dark:text-slate-500">
                      {formatBytes(f.size)}
                    </span>
                  </span>
                ))}
                {loadedFiles.length > 5 && (
                  <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                    +{loadedFiles.length - 5} more
                  </span>
                )}
              </div>
            ) : (
              <span className="truncate text-xs font-medium text-slate-700 dark:text-slate-300">
                Logs loaded
              </span>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {isParsing ? (
              <div className="flex items-center gap-3">
                {progress && (
                  <div className="flex items-center gap-2 font-mono-data text-xs text-slate-600 dark:text-slate-300">
                    <span className="capitalize">{progress.stage}</span>
                    <span className="font-semibold text-blue-600 dark:text-blue-400">
                      {progress.percent}%
                    </span>
                  </div>
                )}
                <button
                  type="button"
                  onClick={cancel}
                  className="rounded border border-rose-200 bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-700 hover:bg-rose-100 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-300 dark:hover:bg-rose-900/60"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={handleAppendClick}
                  className="inline-flex items-center gap-1.5 rounded bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40"
                >
                  <FilePlus className="size-3.5" aria-hidden />
                  Add / Append
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={handleReplaceClick}
                  className="inline-flex items-center gap-1.5 rounded border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                >
                  <RefreshCw className="size-3.5" aria-hidden />
                  Replace
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setPasteOpen(!pasteOpen)}
                  className="inline-flex items-center gap-1.5 rounded border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                >
                  <ClipboardPaste className="size-3.5" aria-hidden />
                  Paste
                </button>
              </>
            )}
          </div>
          {isParsing && progress && (
            <div className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-slate-100 dark:bg-slate-800">
              <div
                className="h-full bg-blue-600 transition-[width] duration-150"
                style={{ width: `${progress.percent}%` }}
              />
            </div>
          )}
        </div>
      ) : (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            if (!busy) setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          className={cn(
            "flex flex-col items-center justify-center gap-3 px-6 py-10 text-center transition-colors",
            dragOver ? "bg-blue-50 dark:bg-blue-950/40" : "bg-white dark:bg-slate-900",
            busy && "opacity-60",
          )}
        >
          <Upload className="size-8 text-slate-400 dark:text-slate-500" aria-hidden />
          <div>
            <p className="text-sm font-medium text-slate-800 dark:text-slate-200">
              {isParsing ? "Parsing PM2 log file(s)…" : "Drop PM2 log file(s)"}
            </p>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              .log / .log1 / .txt — multi-file &amp; multi-day log analysis supported
            </p>
          </div>

          {isParsing ? (
            <div className="w-full max-w-md space-y-3">
              {progress && (
                <div>
                  <div className="mb-1.5 flex justify-between text-[11px] text-slate-500 dark:text-slate-400">
                    <span className="capitalize">{progress.stage}</span>
                    <span className="font-mono-data font-semibold text-blue-600 dark:text-blue-400">
                      {progress.percent}%
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                    <div
                      className="h-full bg-blue-600 transition-[width] duration-150"
                      style={{ width: `${progress.percent}%` }}
                    />
                  </div>
                </div>
              )}
              <button
                type="button"
                onClick={cancel}
                className="rounded border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-100 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-300 dark:hover:bg-rose-900/60"
              >
                Cancel
              </button>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={handleReplaceClick}
                  className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40"
                >
                  Browse files
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setPasteOpen(!pasteOpen)}
                  className="inline-flex items-center gap-1.5 rounded border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                >
                  <ClipboardPaste className="size-3.5" aria-hidden />
                  Paste logs
                </button>
              </div>
              <p className="max-w-lg font-mono-data text-[11px] leading-relaxed text-slate-400 dark:text-slate-500">
                Example: 2026-07-24T00:00:10: GET /api/health 200 12.5 ms - 42
              </p>
            </>
          )}
        </div>
      )}

      {pendingDrop && (
        <div className="border-t border-blue-200 bg-blue-50/90 p-3.5 text-left dark:border-blue-900 dark:bg-slate-800">
          <div className="mx-auto max-w-md">
            <p className="text-xs font-semibold text-slate-800 dark:text-slate-200">
              You dropped {pendingDrop.length} file{pendingDrop.length > 1 ? "s" : ""}
            </p>
            <p className="mt-0.5 text-[11px] text-slate-600 dark:text-slate-400">
              {loadedFiles.length} file
              {loadedFiles.length > 1 ? "s currently loaded" : " currently loaded"}. How would you
              like to proceed?
            </p>
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => executeAppend(pendingDrop)}
                className="inline-flex items-center gap-1 rounded bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700"
              >
                <Plus className="size-3.5" />
                Append to current
              </button>
              <button
                type="button"
                onClick={() => executeReplace(pendingDrop)}
                className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600"
              >
                <RefreshCw className="size-3.5" />
                Replace current
              </button>
              <button
                type="button"
                onClick={() => setPendingDrop(null)}
                className="rounded p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                title="Cancel"
              >
                <X className="size-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".log,.log1,.log2,.log3,.log4,.log5,.log6,.log7,.log8,.log9,.log10,.txt,.out,.err,.1,.2,.3,.4,.5,.6,.7,.8,.9,text/plain"
        className="hidden"
        data-testid="log-file-input"
        onChange={onInputChange}
      />

      {pasteOpen && (
        <div className="border-t border-slate-200 px-4 py-3 dark:border-slate-800">
          <label
            className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300"
            htmlFor="paste-logs"
          >
            Paste log lines (not persisted; max ~{formatBytes(PASTE_WARN_BYTES)})
          </label>
          <textarea
            id="paste-logs"
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            disabled={busy}
            rows={6}
            placeholder="Paste PM2 stdout/stderr here…"
            className="w-full resize-y rounded border border-slate-200 bg-slate-50 px-3 py-2 font-mono-data text-xs text-slate-800 placeholder:text-slate-400 focus:border-blue-500 focus:bg-white dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:placeholder:text-slate-500 dark:focus:bg-slate-900"
          />
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              disabled={busy}
              onClick={handlePasteAnalyze}
              className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40"
            >
              Analyze paste
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
