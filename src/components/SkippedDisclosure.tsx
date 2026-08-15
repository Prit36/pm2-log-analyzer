import { useShallow } from "zustand/react/shallow";
import { EMPTY_SAMPLES, useAnalysisStore } from "../store/analysisStore";
import { formatNum } from "../utils/format";

export function SkippedDisclosure() {
  const { unmatchedCount, sample } = useAnalysisStore(
    useShallow((s) => ({
      unmatchedCount: s.hasData ? (s.result?.unmatchedCount ?? 0) : 0,
      sample: s.result?.unmatchedSample ?? EMPTY_SAMPLES,
    })),
  );

  if (unmatchedCount === 0) return null;

  return (
    <details className="rounded border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800">
        {formatNum(unmatchedCount)} lines skipped
        <span className="ml-2 font-normal text-slate-400 dark:text-slate-500">
          (non-HTTP / unmatched)
        </span>
      </summary>
      <div className="border-t border-slate-100 px-3 py-2 dark:border-slate-800">
        <ul className="max-h-48 space-y-1 overflow-auto font-mono-data text-[11px] text-slate-600 dark:text-slate-400">
          {sample.map((line, i) => (
            <li key={i} className="truncate" title={line}>
              {line}
            </li>
          ))}
        </ul>
        {unmatchedCount > sample.length && (
          <p className="mt-2 text-[11px] text-slate-400 dark:text-slate-500">
            Showing {sample.length} of {formatNum(unmatchedCount)} samples
          </p>
        )}
      </div>
    </details>
  );
}
