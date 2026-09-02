import { useRef, useState, type DragEvent } from "react";
import { ClipboardPaste, Database, Plus, RefreshCw, Upload, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useMongoStore } from "../../store/mongoStore";
import { cancelMongo, parseMongoFiles, parseMongoText } from "../../hooks/useMongoParserWorker";
import { formatBytes } from "../../utils/format";
import { cn } from "../../utils/cn";

export const PASTE_WARN_BYTES = 8 * 1024 * 1024;

const { appendLoadedFiles, setLoadedFiles, setPasteOpen, setSourcePaste, showToast } =
  useMongoStore.getState();

function filterValidFiles(fileList: FileList | File[] | null | undefined): File[] {
  if (!fileList || fileList.length === 0) return [];
  return Array.from(fileList).filter(
    (f) =>
      /\.log\d*$/i.test(f.name) ||
      f.name.endsWith(".txt") ||
      f.name.endsWith(".json") ||
      f.type === "text/plain" ||
      f.type === "",
  );
}

function useMongoIngestHandlers(params: {
  busy: boolean;
  hasData: boolean;
  loadedFiles: File[];
  setPendingDrop: (v: File[] | null) => void;
  setDragOver: (v: boolean) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  setUploadMode: (v: "replace" | "append") => void;
}) {
  const { busy, hasData, loadedFiles, setPendingDrop, setDragOver, inputRef, setUploadMode } = params;

  const executeAppend = (files: File[]) => {
    setPendingDrop(null);
    const existingCount = useMongoStore.getState().loadedFiles.length;
    const combined = appendLoadedFiles(files);
    if (combined.length === existingCount) return;
    void parseMongoFiles(combined);
  };

  const executeReplace = (files: File[]) => {
    setPendingDrop(null);
    const unique = setLoadedFiles(files);
    if (unique.length === 0) return;
    void parseMongoFiles(unique);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (busy) return;
    const validFiles = filterValidFiles(e.dataTransfer.files);
    if (validFiles.length === 0) {
      showToast("Please upload log files (.log, .log1, .txt, etc.)");
      return;
    }
    if (hasData && loadedFiles.length > 0) setPendingDrop(validFiles);
    else executeReplace(validFiles);
  };

  const handleAppendClick = () => {
    setUploadMode("append");
    inputRef.current?.click();
  };

  const handleReplaceClick = () => {
    setUploadMode("replace");
    inputRef.current?.click();
  };

  return {
    onDrop,
    executeAppend,
    executeReplace,
    handleAppendClick,
    handleReplaceClick,
  };
}

export function MongoIngestPanel() {
  const [dragOver, setDragOver] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [uploadMode, setUploadMode] = useState<"replace" | "append">("replace");
  const [pendingDrop, setPendingDrop] = useState<File[] | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const { isParsing, progress, hasData, loadedFiles, pasteOpen } = useMongoStore(
    useShallow((s) => ({
      isParsing: s.isParsing,
      progress: s.progress,
      hasData: s.hasData,
      loadedFiles: s.loadedFiles,
      pasteOpen: s.pasteOpen,
    })),
  );

  const busy = isParsing;

  const { onDrop, executeAppend, executeReplace, handleAppendClick, handleReplaceClick } =
    useMongoIngestHandlers({
      busy,
      hasData,
      loadedFiles,
      setPendingDrop,
      setDragOver,
      inputRef,
      setUploadMode,
    });

  const onDragOver = (e: DragEvent) => {
    e.preventDefault();
    if (!busy) setDragOver(true);
  };

  const onDragLeave = () => setDragOver(false);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const validFiles = filterValidFiles(e.target.files);
    e.target.value = "";
    if (validFiles.length === 0) return;
    if (uploadMode === "append" && hasData) {
      executeAppend(validFiles);
    } else {
      executeReplace(validFiles);
    }
  };

  const handlePasteSubmit = () => {
    if (!pasteText.trim()) return;
    setSourcePaste();
    setPasteOpen(false);
    void parseMongoText(pasteText);
    setPasteText("");
  };

  return (
    <div className="flex flex-col gap-3">
      {/* File Drop Area */}
      <div
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        className={cn(
          "relative flex flex-col items-center justify-center rounded-2xl border-2 border-dashed p-6 text-center transition-all",
          dragOver
            ? "border-emerald-500 bg-emerald-50/50 dark:border-emerald-400 dark:bg-emerald-950/20 scale-[0.99]"
            : "border-slate-300 bg-white hover:border-slate-400 dark:border-slate-800 dark:bg-slate-900/60 dark:hover:border-slate-700",
          hasData && !busy && "py-4",
        )}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          data-testid="mongo-log-file-input"
          className="hidden"
          onChange={onFileChange}
          accept=".log*,.txt,.json"
        />

        {busy ? (
          <div className="flex w-full max-w-md flex-col items-center gap-3">
            <RefreshCw className="size-6 animate-spin text-emerald-600 dark:text-emerald-400" />
            <div className="w-full">
              <div className="flex justify-between text-xs text-slate-600 dark:text-slate-400 mb-1">
                <span className="capitalize">{progress?.stage ?? "Parsing"}...</span>
                <span>{progress?.percent ?? 0}%</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                <div
                  className="h-full bg-emerald-500 transition-all duration-150"
                  style={{ width: `${progress?.percent ?? 0}%` }}
                />
              </div>
            </div>
            <button
              type="button"
              onClick={cancelMongo}
              className="mt-1 text-xs text-slate-500 underline hover:text-slate-700 dark:text-slate-400"
            >
              Cancel parsing
            </button>
          </div>
        ) : hasData ? (
          <div className="flex flex-wrap items-center justify-center gap-3">
            <span className="text-xs font-medium text-slate-600 dark:text-slate-400">
              Loaded {loadedFiles.length} file{loadedFiles.length !== 1 ? "s" : ""}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleAppendClick}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-700 shadow-xs hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
              >
                <Plus className="size-3.5 text-emerald-600" />
                Add More Files
              </button>
              <button
                type="button"
                onClick={handleReplaceClick}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-700 shadow-xs hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
              >
                <Upload className="size-3.5 text-slate-500" />
                Replace
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <div className="flex size-12 items-center justify-center rounded-2xl bg-emerald-50 ring-1 ring-emerald-200/60 dark:bg-emerald-950/40 dark:ring-emerald-800/40">
              <Database className="size-6 text-emerald-600 dark:text-emerald-400" />
            </div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Drop MongoDB log files here
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 max-w-sm">
              Supports mongod JSON log files (.log, .log1, etc.) · Ingests in your browser without uploading to any server
            </p>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={handleReplaceClick}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white shadow-xs hover:bg-emerald-500"
              >
                <Upload className="size-3.5" />
                Browse Files
              </button>
              <button
                type="button"
                onClick={() => setPasteOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
              >
                <ClipboardPaste className="size-3.5" />
                Paste Text
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Confirmation Modal when dropping onto existing data */}
      {pendingDrop && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs">
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl dark:border-slate-800 dark:bg-slate-900">
            <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">
              Add or Replace Files?
            </h3>
            <p className="mt-1.5 text-xs text-slate-600 dark:text-slate-400">
              You selected {pendingDrop.length} file{pendingDrop.length > 1 ? "s" : ""}. Do you want to
              combine them with existing logs or replace the analysis?
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingDrop(null)}
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-400"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => executeReplace(pendingDrop)}
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200"
              >
                Replace
              </button>
              <button
                type="button"
                onClick={() => executeAppend(pendingDrop)}
                className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500"
              >
                Add &amp; Combine
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Paste Modal */}
      {pasteOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs">
          <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl dark:border-slate-800 dark:bg-slate-900">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3 dark:border-slate-800">
              <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">
                Paste MongoDB Logs
              </h3>
              <button
                type="button"
                onClick={() => setPasteOpen(false)}
                className="text-slate-400 hover:text-slate-600"
              >
                <X className="size-4" />
              </button>
            </div>
            <textarea
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder="Paste MongoDB JSON log lines here..."
              rows={12}
              className="mt-4 w-full rounded-xl border border-slate-200 bg-slate-50/50 p-3 font-mono text-xs text-slate-900 placeholder:text-slate-400 focus:border-emerald-500 focus:outline-hidden dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
            />
            <div className="mt-4 flex items-center justify-between">
              <span className="text-xs text-slate-500">
                {pasteText.length > 0 ? `${formatBytes(pasteText.length)} pasted` : ""}
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setPasteOpen(false)}
                  className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-400"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={!pasteText.trim()}
                  onClick={handlePasteSubmit}
                  className="rounded-lg bg-emerald-600 px-4 py-1.5 text-xs font-semibold text-white shadow-xs hover:bg-emerald-500 disabled:opacity-50"
                >
                  Analyze Text
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
