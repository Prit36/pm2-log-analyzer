import { useAnalysisStore } from "../store/analysisStore";
import { useMongoStore } from "../store/mongoStore";
import { useAppModeStore } from "../store/appModeStore";

export function Toast() {
  const mode = useAppModeStore((s) => s.mode);
  const pm2Toast = useAnalysisStore((s) => s.toast);
  const mongoToast = useMongoStore((s) => s.toast);

  const toast = mode === "mongo" ? (mongoToast ?? pm2Toast) : (pm2Toast ?? mongoToast);

  if (!toast) return null;

  return (
    <div
      role="status"
      className="fixed bottom-4 right-4 z-50 max-w-sm rounded-lg border border-slate-200 bg-slate-900 px-3.5 py-2.5 text-xs font-medium text-white shadow-xl dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
    >
      {toast}
    </div>
  );
}
