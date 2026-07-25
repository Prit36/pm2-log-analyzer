import { EMPTY_SAMPLES, useAnalysisStore } from "../store/analysisStore";
import { formatNum } from "../utils/format";

export function SkippedDisclosure() {
  const unmatchedCount = useAnalysisStore((s) => s.result?.unmatchedCount ?? 0);
  const sample = useAnalysisStore((s) => s.result?.unmatchedSample ?? EMPTY_SAMPLES);
  const hasData = useAnalysisStore((s) => s.hasData);

  if (!hasData || unmatchedCount === 0) return null;

  return (
    <details className="rounded border border-slate-200 bg-white">
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50">
        {formatNum(unmatchedCount)} lines skipped
        <span className="ml-2 font-normal text-slate-400">(non-HTTP / unmatched)</span>
      </summary>
      <div className="border-t border-slate-100 px-3 py-2">
        <ul className="max-h-48 space-y-1 overflow-auto font-mono-data text-[11px] text-slate-600">
          {sample.map((line, i) => (
            <li key={i} className="truncate" title={line}>
              {line}
            </li>
          ))}
        </ul>
        {unmatchedCount > sample.length && (
          <p className="mt-2 text-[11px] text-slate-400">
            Showing {sample.length} of {formatNum(unmatchedCount)} samples
          </p>
        )}
      </div>
    </details>
  );
}
