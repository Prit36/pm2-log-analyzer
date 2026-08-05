import { useEffect } from "react";
import { useParserWorker } from "./hooks/useParserWorker";
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
import { downloadExcel } from "./utils/exportSpreadsheet";

export function App() {
  const theme = useAnalysisStore((s) => s.theme);
  const { parseFile, parseText, cancel, clear } = useParserWorker();
  const showToast = useAnalysisStore((s) => s.showToast);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);
  const apiRows = useFilteredApiRows();
  const cronRows = useFilteredCronRows();
  const apiSortKey = useAnalysisStore((s) => s.filters.sortKey);
  const cronSortKey = useAnalysisStore((s) => s.filters.cronSortKey);
  const hourlyStats = useAnalysisStore((s) => s.result?.hourlyStats);
  const hasCron = useAnalysisStore((s) => {
    const c = s.result?.cronSummary;
    return !!c && c.starts + c.dones + c.fails > 0;
  });

  const onExport = async () => {
    if (apiRows.length === 0 && cronRows.length === 0) {
      showToast("Nothing to export yet");
      return;
    }
    try {
      await downloadExcel(apiRows, cronRows, { api: apiSortKey, cron: cronSortKey });
      showToast(
        cronRows.length > 0
          ? "Excel downloaded — API + Cron sheets"
          : "Excel downloaded — API sheet",
      );
    } catch {
      showToast("Excel export failed");
    }
  };

  return (
    <div className="min-h-full">
      <AppHeader onExport={onExport} onClear={clear} />
      <main className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4">
        <IngestPanel
          onFile={(file) => void parseFile(file)}
          onPaste={(text) => void parseText(text)}
          onCancel={cancel}
        />
        <KpiRow />
        <FilterBar />
        <div className="grid gap-4 lg:grid-cols-5">
          <div className="lg:col-span-3">
            <ApiTable rows={apiRows} />
          </div>
          <div className="lg:col-span-2">
            <LatencyChart rows={apiRows} hourlyStats={hourlyStats} />
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
