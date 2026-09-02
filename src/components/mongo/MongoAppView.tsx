import { useShallow } from "zustand/react/shallow";
import { useMongoStore } from "../../store/mongoStore";
import { MongoIngestPanel } from "./MongoIngestPanel";
import { MongoKpiRow } from "./MongoKpiRow";
import { MongoFilterBar } from "./MongoFilterBar";
import { MongoPatternTable } from "./MongoPatternTable";
import { MongoSlowQueryTable } from "./MongoSlowQueryTable";
import { MongoLatencyChart } from "./MongoLatencyChart";
import { MongoDiagnosticsPanel } from "./MongoDiagnosticsPanel";
import { MongoQueryDetailModal } from "./MongoQueryDetailModal";

export function MongoAppView() {
  const { hasData, activeView } = useMongoStore(
    useShallow((s) => ({
      hasData: s.hasData,
      activeView: s.activeView,
    })),
  );

  return (
    <div className="flex flex-col gap-4">
      <MongoIngestPanel />

      {hasData && (
        <>
          <MongoKpiRow />
          <MongoFilterBar />

          {/* Active View Container */}
          {activeView === "patterns" && <MongoPatternTable />}
          {activeView === "slow_queries" && <MongoSlowQueryTable />}
          {activeView === "charts" && <MongoLatencyChart />}
          {activeView === "diagnostics" && <MongoDiagnosticsPanel />}
        </>
      )}

      <MongoQueryDetailModal />

      <footer className="pb-6 pt-2 text-center text-[11px] text-slate-400">
        MongoDB JSON Log Analyzer · Parses locally in your browser · Logs never leave your machine
      </footer>
    </div>
  );
}
