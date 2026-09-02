import { Check, Copy, Flame, Lightbulb, X } from "lucide-react";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useMongoStore } from "../../store/mongoStore";
import { formatBytes, formatMs, formatNum } from "../../utils/format";

const { setActiveSlowQuery, showToast } = useMongoStore.getState();

export function MongoQueryDetailModal() {
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [copiedIdx, setCopiedIdx] = useState(false);

  const activeQuery = useMongoStore(useShallow((s) => s.activeSlowQuery));

  if (!activeQuery) return null;

  const handleClose = () => {
    setActiveSlowQuery(null);
  };

  const copyCommandJson = () => {
    const jsonStr = JSON.stringify(activeQuery.command, null, 2);
    void navigator.clipboard.writeText(jsonStr);
    setCopiedCmd(true);
    showToast("Copied query command JSON");
    setTimeout(() => setCopiedCmd(false), 2000);
  };

  const copyIndexSuggestion = () => {
    if (!activeQuery.indexSuggestion) return;
    void navigator.clipboard.writeText(activeQuery.indexSuggestion);
    setCopiedIdx(true);
    showToast(`Copied index: ${activeQuery.indexSuggestion}`);
    setTimeout(() => setCopiedIdx(false), 2000);
  };

  const formattedCommand = JSON.stringify(activeQuery.command, null, 2);
  const formattedOriginating = activeQuery.originatingCommand
    ? JSON.stringify(activeQuery.originatingCommand, null, 2)
    : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs animate-in fade-in duration-150">
      <div className="relative flex max-h-[90vh] w-full max-w-4xl flex-col rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-900">
        {/* Modal Header */}
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4 dark:border-slate-800">
          <div className="flex items-center gap-2.5">
            <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-bold uppercase tracking-wider text-slate-700 dark:bg-slate-800 dark:text-slate-300">
              {activeQuery.op}
            </span>
            <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">
              {activeQuery.ns}
            </h3>
            {activeQuery.isCollscan && (
              <span className="flex items-center gap-1 rounded bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-800 dark:bg-amber-950/80 dark:text-amber-300">
                <Flame className="size-3.5" />
                COLLSCAN
              </span>
            )}
            <span className="rounded border border-slate-200 bg-slate-50 px-2 py-0.5 font-mono text-xs font-semibold text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
              {formatMs(activeQuery.durationMs)}
            </span>
          </div>

          <button
            type="button"
            onClick={handleClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            aria-label="Close modal"
          >
            <X className="size-5" />
          </button>
        </div>

        {/* Modal Scrollable Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5 text-xs">
          {/* Smart Index Recommendation Banner */}
          {activeQuery.indexSuggestion && (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-emerald-300 bg-emerald-50/80 p-3.5 dark:border-emerald-800/80 dark:bg-emerald-950/30">
              <div className="flex items-center gap-2 min-w-0">
                <Lightbulb className="size-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                <div className="min-w-0">
                  <p className="font-semibold text-emerald-900 dark:text-emerald-200">
                    Recommended Index
                  </p>
                  <code className="block truncate font-mono text-[11px] text-emerald-800 dark:text-emerald-300">
                    {activeQuery.indexSuggestion}
                  </code>
                </div>
              </div>
              <button
                type="button"
                onClick={copyIndexSuggestion}
                className="flex shrink-0 items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow-xs hover:bg-emerald-500"
              >
                {copiedIdx ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                <span>{copiedIdx ? "Copied" : "Copy Index"}</span>
              </button>
            </div>
          )}

          {/* Diagnostic Metrics Grid */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-slate-800/50">
              <span className="text-slate-500 dark:text-slate-400">Execution Plan</span>
              <p className="mt-1 font-semibold text-slate-900 dark:text-slate-100 truncate" title={activeQuery.planSummary}>
                {activeQuery.planSummary || "Unknown"}
              </p>
            </div>

            <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-slate-800/50">
              <span className="text-slate-500 dark:text-slate-400">Docs Examined / Returned</span>
              <p className="mt-1 font-semibold text-slate-900 dark:text-slate-100">
                {formatNum(activeQuery.docsExamined)} / {formatNum(activeQuery.nreturned)}
              </p>
              <span className="text-[10px] text-slate-500">Ratio: {Math.round(activeQuery.scanRatio * 10) / 10}x</span>
            </div>

            <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-slate-800/50">
              <span className="text-slate-500 dark:text-slate-400">Keys Examined</span>
              <p className="mt-1 font-semibold text-slate-900 dark:text-slate-100">
                {formatNum(activeQuery.keysExamined)}
              </p>
            </div>

            <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-slate-800/50">
              <span className="text-slate-500 dark:text-slate-400">Yields &amp; Payload Size</span>
              <p className="mt-1 font-semibold text-slate-900 dark:text-slate-100">
                {activeQuery.numYields} yields · {formatBytes(activeQuery.reslen)}
              </p>
            </div>

            {activeQuery.planningTimeMicros !== undefined && (
              <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-slate-800/50">
                <span className="text-slate-500 dark:text-slate-400">Planning Time</span>
                <p className="mt-1 font-semibold text-slate-900 dark:text-slate-100">
                  {activeQuery.planningTimeMicros} µs
                </p>
              </div>
            )}

            {activeQuery.remote && (
              <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-slate-800/50">
                <span className="text-slate-500 dark:text-slate-400">Remote Client</span>
                <p className="mt-1 font-mono font-semibold text-slate-900 dark:text-slate-100 truncate" title={activeQuery.remote}>
                  {activeQuery.remote}
                </p>
              </div>
            )}

            {activeQuery.queryHash && (
              <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-slate-800/50">
                <span className="text-slate-500 dark:text-slate-400">Query Hash</span>
                <p className="mt-1 font-mono font-semibold text-slate-900 dark:text-slate-100">
                  {activeQuery.queryHash}
                </p>
              </div>
            )}

            <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-slate-800/50">
              <span className="text-slate-500 dark:text-slate-400">Timestamp</span>
              <p className="mt-1 font-mono font-semibold text-slate-900 dark:text-slate-100 truncate" title={activeQuery.timestamp}>
                {activeQuery.timestamp}
              </p>
            </div>
          </div>

          {/* Formatted Command JSON */}
          <div className="rounded-xl border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-950">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5 dark:border-slate-800">
              <span className="font-semibold text-slate-700 dark:text-slate-300">
                Command Details (JSON)
              </span>
              <button
                type="button"
                onClick={copyCommandJson}
                className="flex items-center gap-1 rounded bg-white px-2.5 py-1 text-xs font-medium text-slate-700 shadow-xs hover:bg-slate-50 dark:bg-slate-800 dark:text-slate-200"
              >
                {copiedCmd ? <Check className="size-3 text-emerald-600" /> : <Copy className="size-3" />}
                <span>{copiedCmd ? "Copied" : "Copy JSON"}</span>
              </button>
            </div>
            <pre className="max-h-72 overflow-y-auto p-4 font-mono text-[11px] leading-relaxed text-slate-800 dark:text-slate-200">
              {formattedCommand}
            </pre>
          </div>

          {/* Originating Command if getMore */}
          {formattedOriginating && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-950">
              <div className="border-b border-slate-200 px-4 py-2.5 dark:border-slate-800 font-semibold text-slate-700 dark:text-slate-300">
                Originating Command
              </div>
              <pre className="max-h-56 overflow-y-auto p-4 font-mono text-[11px] leading-relaxed text-slate-800 dark:text-slate-200">
                {formattedOriginating}
              </pre>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-end border-t border-slate-200 px-6 py-3 dark:border-slate-800">
          <button
            type="button"
            onClick={handleClose}
            className="rounded-lg border border-slate-300 bg-white px-4 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
