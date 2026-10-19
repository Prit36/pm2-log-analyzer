import { cn } from "../../utils/cn";
import { panelClass, panelTitleClass } from "./nginxUi";

function EmptyPanel({
  title,
  message,
  className,
}: {
  title: string;
  message: string;
  className: string;
}) {
  return (
    <section className={cn(panelClass, className)}>
      <div className="border-b border-slate-200 px-3 py-2 dark:border-slate-800">
        <h2 className={panelTitleClass}>{title}</h2>
      </div>
      <p className="px-3 py-10 text-center text-xs text-slate-400 dark:text-slate-500">{message}</p>
    </section>
  );
}

/** Mirrors the PM2 start page: the empty table and chart panels a loaded file fills. */
export function NginxEmptyState() {
  return (
    <div className="grid items-start gap-4 lg:grid-cols-5">
      <EmptyPanel title="Endpoints" message="No matching endpoints." className="lg:col-span-3" />
      <EmptyPanel
        title="Requests over time"
        message="No chart data available yet."
        className="lg:col-span-2"
      />
    </div>
  );
}
