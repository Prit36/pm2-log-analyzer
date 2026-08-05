import { useEffect } from "react";
import { useAnalysisStore } from "../store/analysisStore";

export function Toast() {
  const toast = useAnalysisStore((s) => s.toast);
  const clearToast = useAnalysisStore((s) => s.clearToast);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(clearToast, 3200);
    return () => clearTimeout(id);
  }, [toast, clearToast]);

  if (!toast) return null;

  return (
    <div
      role="status"
      className="fixed bottom-4 right-4 z-50 max-w-sm rounded border border-slate-200 bg-slate-900 px-3 py-2 text-xs text-white shadow-lg dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
    >
      {toast}
    </div>
  );
}
