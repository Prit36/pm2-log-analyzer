import { useAnalysisStore } from "./store/analysisStore";
import { AppHeader } from "./components/AppHeader";
import { IngestPanel } from "./components/IngestPanel";
import { KpiRow } from "./components/KpiRow";
import { FilterBar } from "./components/FilterBar";
import { ApiTable, useFilteredApiRows } from "./components/ApiTable";
import { LatencyChart } from "./components/LatencyChart";
import { CronTable, useFilteredCronRows } from "./components/CronTable";
import { SkippedDisclosure } from "./components/SkippedDisclosure";
import { Toast } from "./components/Toast";

export function App() {
  const hasCron = useAnalysisStore((s) => {
    const c = s.result?.cronSummary;
    return !!c && c.starts + c.dones + c.fails > 0;
  });
  const apiRows = useFilteredApiRows();
  const cronRows = useFilteredCronRows();

  return (
    <div className="min-h-full">
      <AppHeader />
      <main className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4">
        <IngestPanel />
        <KpiRow />
        <FilterBar />
        <div className="grid gap-4 lg:grid-cols-5">
          <div className="lg:col-span-3">
            <ApiTable rows={apiRows} />
          </div>
          <div className="lg:col-span-2">
            <LatencyChart rows={apiRows} />
          </div>
        </div>
        {hasCron && <CronTable rows={cronRows} />}
        <SkippedDisclosure />
        <footer className="pb-6 pt-2 text-center text-[11px] text-slate-400">
          Parses in your browser - logs never leave this machine
        </footer>
      </main>
      <Toast />
    </div>
  );
}

export default App;
