import { useCallback, useRef, useState, type DragEvent } from "react";
import { ClipboardPaste, Upload } from "lucide-react";
import { useAnalysisStore } from "../store/analysisStore";
import { formatBytes } from "../utils/format";
import { cn } from "../utils/cn";

/** Soft guard for paste path — large dumps should use file upload. */
export const PASTE_WARN_BYTES = 8 * 1024 * 1024;

type Props = {
  onFile: (file: File) => void;
  onPaste: (text: string) => void;
  onCancel: () => void;
};

export function IngestPanel({ onFile, onPaste, onCancel }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const isParsing = useAnalysisStore((s) => s.isParsing);
  const isWorkerReady = useAnalysisStore((s) => s.isWorkerReady);
  const progress = useAnalysisStore((s) => s.progress);
  const hasData = useAnalysisStore((s) => s.hasData);
  const pasteOpen = useAnalysisStore((s) => s.pasteOpen);
  const setPasteOpen = useAnalysisStore((s) => s.setPasteOpen);
  const setSourceFile = useAnalysisStore((s) => s.setSourceFile);
  const setSourcePaste = useAnalysisStore((s) => s.setSourcePaste);
  const showToast = useAnalysisStore((s) => s.showToast);

  const busy = isParsing || !isWorkerReady;

  const acceptFile = useCallback(
    (file: File | undefined) => {
      if (!file || busy) return;
      const ok =
        file.name.endsWith(".log") ||
        file.name.endsWith(".txt") ||
        file.type === "text/plain" ||
        file.type === "";
      if (!ok) {
        showToast("Please upload a .log or .txt file");
        return;
      }
      setSourceFile(file.name, file.size);
      onFile(file);
    },
    [busy, onFile, setSourceFile, showToast],
  );

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    acceptFile(e.dataTransfer.files[0]);
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
    onPaste(text);
  };

  return (
    <section className="rounded border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
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
            {hasData ? "Drop a new file to replace" : "Drop a PM2 log file"}
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            .log / .txt — streamed off the main thread for large dumps
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
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
          {isParsing && (
            <button
              type="button"
              onClick={onCancel}
              className="rounded border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-medium text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-300"
            >
              Cancel
            </button>
          )}
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".log,.txt,text/plain"
          className="hidden"
          data-testid="log-file-input"
          onChange={(e) => {
            acceptFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        {isParsing && progress && (
          <div className="w-full max-w-md">
            <div className="mb-1 flex justify-between text-[11px] text-slate-500 dark:text-slate-400">
              <span className="capitalize">{progress.stage}</span>
              <span>{progress.percent}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
              <div
                className="h-full bg-blue-600 transition-[width] duration-150"
                style={{ width: `${progress.percent}%` }}
              />
            </div>
          </div>
        )}
        {!hasData && !isParsing && (
          <p className="max-w-lg font-mono-data text-[11px] leading-relaxed text-slate-400 dark:text-slate-500">
            Example: 2026-07-24T00:00:10: GET /api/health 200 12.5 ms - 42
          </p>
        )}
      </div>

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
