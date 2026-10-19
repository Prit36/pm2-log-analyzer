import { useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { ChevronDown, ClipboardPaste, FileText, FolderOpen, Plus, Upload } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useNginxStore } from "../../store/nginxStore";
import { cancelNginx, parseNginxText } from "../../hooks/useNginxParserWorker";
import { filterValidFiles, handleLogFilesUpload } from "../../utils/zipExtractor";
import { ARCHIVE_ACCEPT } from "../../utils/archiveFormats";
import { isTauri } from "../../utils/platform";
import {
  handleNativePathsUpload,
  pickNativeDirectory,
  pickNativeFiles,
} from "../../services/nativeBridge";
import { formatBytes, formatNum } from "../../utils/format";
import { cn } from "../../utils/cn";

const { setPasteOpen, showToast, setError } = useNginxStore.getState();
const buttonClass =
  "inline-flex items-center justify-center gap-1.5 rounded border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700";
const primaryClass =
  "inline-flex items-center justify-center gap-1.5 rounded bg-violet-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-violet-700 disabled:opacity-40";
type UploadMode = "replace" | "append";

function reportUploadError(error: Error | string) {
  const message = error instanceof Error ? error.message : String(error);
  setError(message);
  showToast(message);
}

export async function uploadNginxFiles(files: File[], mode: UploadMode): Promise<void> {
  try {
    const valid = filterValidFiles(files);
    if (valid.length === 0) {
      showToast("Choose log, text, or archive files");
      return;
    }
    await handleLogFilesUpload(valid, mode);
  } catch (error) {
    reportUploadError(error instanceof Error ? error : String(error));
  }
}

async function pickNginxNative(mode: UploadMode, folder: boolean): Promise<void> {
  try {
    const paths = folder ? await pickNativeDirectory() : await pickNativeFiles();
    if (paths) await handleNativePathsUpload(Array.isArray(paths) ? paths : [paths], mode);
  } catch (error) {
    reportUploadError(error instanceof Error ? error : String(error));
  }
}

export async function analyzeNginxPaste(text: string): Promise<void> {
  const raw = String(text ?? "");
  if (!raw.trim()) {
    showToast("Paste some Nginx access log lines first");
    return;
  }
  if (new Blob([raw]).size > 8 * 1024 * 1024) {
    showToast("For more than 8 MiB, save the logs as a file and upload it");
    return;
  }
  try {
    await parseNginxText(raw);
  } catch (error) {
    reportUploadError(error instanceof Error ? error : String(error));
  }
}

export function NginxIngestPanel() {
  const inputRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const folderMenuRef = useRef<HTMLDetailsElement>(null);
  const [mode, setMode] = useState<UploadMode>("replace");
  const [dragOver, setDragOver] = useState(false);
  const [pending, setPending] = useState<File[] | null>(null);
  const [text, setText] = useState("");
  const {
    hasData,
    isParsing,
    progress,
    pasteOpen,
    fileNames,
    fileSize,
    error,
    sourceKind,
    requestCount,
  } = useNginxStore(
    useShallow((s) => ({
      sourceKind: s.sourceKind,
      requestCount: s.result?.diagnostics.matchedLines,
      hasData: s.hasData,
      isParsing: s.isParsing,
      progress: s.progress,
      pasteOpen: s.pasteOpen,
      fileNames: s.fileNames,
      fileSize: s.fileSize,
      error: s.error,
    })),
  );
  const choose = (nextMode: UploadMode, folder = false) => {
    folderMenuRef.current?.removeAttribute("open");
    if (isTauri()) {
      void pickNginxNative(nextMode, folder);
      return;
    }
    setMode(nextMode);
    if (folder) {
      folderRef.current?.setAttribute("webkitdirectory", "");
      folderRef.current?.click();
    } else inputRef.current?.click();
  };
  const onInput = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    void uploadNginxFiles(files, mode);
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragOver(false);
    if (isTauri() || isParsing) return;
    const files = filterValidFiles(event.dataTransfer.files);
    if (hasData) setPending(files);
    else void uploadNginxFiles(files, "replace");
  };
  const submitDrop = (nextMode: UploadMode) => {
    if (pending) void uploadNginxFiles(pending, nextMode);
    setPending(null);
  };
  const accept = ".log,.txt,.out,.1,.2,.3,.4,.5,.6,.7,.8,.9,text/plain," + ARCHIVE_ACCEPT;
  return (
    <section
      className={cn(
        "rounded-lg bg-white dark:bg-slate-900",
        hasData
          ? "border border-slate-200 dark:border-slate-800"
          : "border-2 border-dashed border-slate-300 dark:border-slate-700",
        dragOver && "border-violet-400 dark:border-violet-500",
      )}
    >
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={cn(
          "rounded-lg",
          hasData ? "flex flex-wrap items-center justify-between gap-2 px-3 py-2" : "px-4 py-10",
          dragOver && "bg-violet-50 dark:bg-violet-950/30",
        )}
      >
        {!hasData && (
          <div className="mb-5 text-center">
            <div className="mx-auto mb-3 flex size-11 items-center justify-center rounded-full bg-violet-50 dark:bg-violet-950/50">
              <Upload className="size-5 text-violet-600 dark:text-violet-400" aria-hidden />
            </div>
            <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
              Drop Nginx access logs here
            </h2>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Combined format, with or without rt= / urt= timings · Files, folders, and archives
            </p>
          </div>
        )}
        {hasData && (
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            <FileText className="size-3.5 shrink-0 text-violet-500" aria-hidden />
            <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
              {sourceKind === "paste"
                ? "Pasted logs:"
                : `${fileNames.length} file${fileNames.length > 1 ? "s" : ""}:`}
            </span>
            {fileNames.slice(0, 4).map((name) => (
              <span
                key={name}
                className="inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-0.5 font-mono-data text-[11px] text-slate-700 dark:bg-slate-800 dark:text-slate-300"
                title={name}
              >
                <span className="max-w-[150px] truncate">{name}</span>
              </span>
            ))}
            {fileNames.length > 4 && (
              <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                +{fileNames.length - 4} more
              </span>
            )}
            {fileSize != null && (
              <span className="text-[11px] text-slate-400 dark:text-slate-500">
                ({formatBytes(fileSize)})
              </span>
            )}
            {requestCount != null && (
              <span className="text-[11px] text-slate-400 dark:text-slate-500">
                · {formatNum(requestCount)} requests
              </span>
            )}
          </div>
        )}
        <div
          className={cn(
            "flex flex-wrap items-center gap-2",
            hasData ? "justify-end" : "justify-center",
          )}
        >
          {hasData && (
            <button
              type="button"
              disabled={isParsing}
              onClick={() => choose("append")}
              className={primaryClass}
            >
              <Plus className="size-3.5" aria-hidden />
              Add files
            </button>
          )}
          <button
            type="button"
            disabled={isParsing}
            onClick={() => choose("replace")}
            className={hasData ? buttonClass : primaryClass}
          >
            <Upload className="size-3.5" aria-hidden />
            {hasData ? "Replace" : "Choose files"}
          </button>
          {hasData ? (
            <details ref={folderMenuRef} className="relative">
              <summary
                aria-disabled={isParsing}
                onClick={(event) => {
                  if (isParsing) event.preventDefault();
                }}
                className={
                  buttonClass + " cursor-pointer list-none [&::-webkit-details-marker]:hidden"
                }
              >
                <FolderOpen className="size-3.5" aria-hidden />
                Folder
                <ChevronDown className="size-3" aria-hidden />
              </summary>
              <div className="absolute right-0 top-full z-20 mt-1 w-40 rounded border border-slate-200 bg-white p-1 shadow-lg dark:border-slate-700 dark:bg-slate-900">
                <button
                  type="button"
                  disabled={isParsing}
                  onClick={() => choose("append", true)}
                  className="block w-full rounded px-3 py-2 text-left text-xs text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  Add folder
                </button>
                <button
                  type="button"
                  disabled={isParsing}
                  onClick={() => choose("replace", true)}
                  className="block w-full rounded px-3 py-2 text-left text-xs text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  Replace folder
                </button>
              </div>
            </details>
          ) : (
            <button
              type="button"
              disabled={isParsing}
              onClick={() => choose("replace", true)}
              className={buttonClass}
            >
              <FolderOpen className="size-3.5" aria-hidden />
              Choose folder
            </button>
          )}
          <button
            type="button"
            disabled={isParsing}
            onClick={() => setPasteOpen(!pasteOpen)}
            className={buttonClass}
          >
            <ClipboardPaste className="size-3.5" aria-hidden />
            {pasteOpen ? "Close paste" : "Paste logs"}
          </button>
        </div>
        {!hasData && (
          <p className="mt-3 text-center font-mono-data text-[11px] leading-relaxed text-slate-400 dark:text-slate-500">
            Example: 203.0.113.7 - - [13/Oct/2026:12:33:59 +0400] "GET /api/health HTTP/1.1" 200 42
            "-" "curl/8.5" rt=0.012
          </p>
        )}
        {isParsing && (
          <div className={cn("flex items-center gap-3", hasData ? "w-full" : "mt-4")} role="status">
            <div className="h-1.5 flex-1 overflow-hidden rounded bg-slate-100 dark:bg-slate-800">
              <div
                className="h-full bg-violet-500"
                style={{ width: `${progress?.percent ?? 0}%` }}
              />
            </div>
            <span className="text-xs capitalize text-slate-500">
              {progress?.stage ?? "Parsing"} {progress?.percent ?? 0}%
            </span>
            <button
              type="button"
              onClick={cancelNginx}
              className="text-xs font-medium text-rose-600 dark:text-rose-400"
            >
              Cancel
            </button>
          </div>
        )}
        {error && (
          <p
            role="alert"
            className={cn(
              "text-xs text-rose-600 dark:text-rose-400",
              hasData ? "w-full" : "mt-3 text-center",
            )}
          >
            {error}
          </p>
        )}
      </div>
      {pending && (
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 bg-violet-50 px-4 py-3 text-xs dark:border-slate-800 dark:bg-violet-950/30">
          <span className="mr-auto text-slate-700 dark:text-slate-200">
            {pending.length} dropped files
          </span>
          <button type="button" className={primaryClass} onClick={() => submitDrop("append")}>
            Append to current
          </button>
          <button type="button" className={buttonClass} onClick={() => submitDrop("replace")}>
            Replace current
          </button>
          <button type="button" className={buttonClass} onClick={() => setPending(null)}>
            Cancel
          </button>
        </div>
      )}
      {pasteOpen && (
        <div className="border-t border-slate-200 px-4 py-3 dark:border-slate-800">
          <label
            htmlFor="nginx-paste"
            className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300"
          >
            Paste access logs (max 8 MiB; replaces current Nginx analysis)
          </label>
          <textarea
            id="nginx-paste"
            data-testid="nginx-paste"
            rows={6}
            value={text}
            disabled={isParsing}
            onChange={(event) => setText(event.target.value)}
            placeholder={
              '94.206.29.30 - - [13/Oct/2026:12:33:59 +0400] "POST /api/example HTTP/1.1" 200 866 "-" "Mozilla/5.0" rt=0.845 urt=0.842'
            }
            className="w-full resize-y rounded border border-slate-200 bg-slate-50 px-3 py-2 font-mono-data text-xs text-slate-800 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
          />
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              data-testid="nginx-analyze-paste"
              className={primaryClass}
              disabled={isParsing}
              onClick={() => void analyzeNginxPaste(text)}
            >
              Analyze paste
            </button>
          </div>
        </div>
      )}
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={accept}
        className="hidden"
        data-testid="nginx-file-input"
        onChange={onInput}
      />
      <input
        ref={folderRef}
        type="file"
        multiple
        accept={accept}
        className="hidden"
        data-testid="nginx-folder-input"
        onChange={onInput}
      />
    </section>
  );
}
