import { useAnalysisStore } from "../store/analysisStore";
import { IngestPanel } from "./IngestPanel";
import { KpiRow } from "./KpiRow";
import { FilterBar } from "./FilterBar";
import { ApiTable, useFilteredApiRows } from "./ApiTable";
import { LatencyChart } from "./LatencyChart";
import { CronTable, useFilteredCronRows } from "./CronTable";
import { SkippedDisclosure } from "./SkippedDisclosure";

export function Pm2AppView() {
  const hasCron = useAnalysisStore((s) => {
    const c = s.result?.cronSummary;
    return !!c && c.starts + c.dones + c.fails > 0;
  });
  const chartLayout = useAnalysisStore((s) => s.chartLayout);
  const apiRows = useFilteredApiRows();
  const cronRows = useFilteredCronRows();

  return (
    <div className="flex flex-col gap-4">
      <IngestPanel />
      <KpiRow />
      <FilterBar />
      {chartLayout === "wide" ? (
        <div className="flex flex-col gap-4">
          <LatencyChart rows={apiRows} />
          <ApiTable rows={apiRows} />
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-5">
          <div className="lg:col-span-3">
            <ApiTable rows={apiRows} />
          </div>
          <div className="lg:col-span-2">
            <LatencyChart rows={apiRows} />
          </div>
        </div>
      )}
      {hasCron && <CronTable rows={cronRows} />}
      <SkippedDisclosure />
      <footer className="pb-6 pt-2 text-center text-[11px] text-slate-400">
        Parses in your browser - logs never leave this machine
      </footer>
    </div>
  );
}
