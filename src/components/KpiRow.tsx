import { useAnalysisStore } from "../store/analysisStore";
import { formatMs, formatNum } from "../utils/format";

export function KpiRow() {
  const summary = useAnalysisStore((s) => s.result?.summary);
  const cronJobs = useAnalysisStore((s) => s.result?.cronSummary.jobs ?? 0);
  const hasCronEvents = useAnalysisStore((s) => {
    const c = s.result?.cronSummary;
    return !!c && c.starts + c.dones + c.fails > 0;
  });
  const hasData = useAnalysisStore((s) => s.hasData);

  if (!hasData || !summary) return null;

  const items: { label: string; value: string; accent?: boolean; danger?: boolean }[] = [
    { label: "Requests", value: formatNum(summary.matched) },
    { label: "Avg", value: formatMs(summary.avg) },
    { label: "p95", value: formatMs(summary.p95Ms), accent: true },
    { label: "Errors", value: formatNum(summary.errors), danger: summary.errors > 0 },
    { label: "Slow ≥3s", value: formatNum(summary.slow) },
  ];
  if (hasCronEvents) items.push({ label: "Cron jobs", value: formatNum(cronJobs) });

  return (
    <section
      data-testid="kpi-row"
      className="grid grid-cols-2 gap-px overflow-hidden rounded border border-slate-200 bg-slate-200 sm:grid-cols-3 lg:grid-cols-6"
    >
      {items.map((item) => (
        <div key={item.label} className="bg-white px-3 py-3">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            {item.label}
          </div>
          <div
            className={`mt-1 font-mono-data text-lg font-semibold tabular-nums ${
              item.danger ? "text-rose-600" : item.accent ? "text-blue-600" : "text-slate-900"
            }`}
          >
            {item.value}
          </div>
        </div>
      ))}
    </section>
  );
}
