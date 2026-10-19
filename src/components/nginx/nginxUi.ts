import { formatMs } from "../../utils/format";

export const panelClass =
  "overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900";
export const panelTitleClass = "text-sm font-semibold text-slate-800 dark:text-slate-100";
export const mutedClass = "text-[11px] text-slate-500 dark:text-slate-400";

const compactFormat = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function latency(value: number | null): string {
  return value == null ? "—" : formatMs(value);
}

export function percent(part: number, total: number): string {
  const value = total > 0 ? (part * 100) / total : 0;
  return `${value > 0 && value < 0.1 ? "<0.1" : value.toFixed(value >= 10 ? 0 : 1)}%`;
}

export function compactNum(value: number): string {
  return compactFormat.format(value);
}

export function compactBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${Number.parseFloat(value.toFixed(value >= 10 ? 0 : 1))} ${units[unit]}`;
}

export type StatusTone = "ok" | "redirect" | "client" | "server" | "other";

export function statusTone(status: number): StatusTone {
  if (status >= 500) return "server";
  if (status >= 400) return "client";
  if (status >= 300) return "redirect";
  if (status >= 200) return "ok";
  return "other";
}

export const toneColor = {
  ok: "#10b981",
  redirect: "#0ea5e9",
  client: "#f59e0b",
  server: "#f43f5e",
  other: "#94a3b8",
} satisfies Record<StatusTone, string>;

export const toneLabel = {
  ok: "2xx Success",
  redirect: "3xx Redirect",
  client: "4xx Client error",
  server: "5xx Server error",
  other: "Other",
} satisfies Record<StatusTone, string>;

/** Error-rate text color: red above 5%, amber above 1%. */
export function errorTone(errors: number, count: number): string {
  const rate = count > 0 ? errors / count : 0;
  if (rate > 0.05) return "text-rose-600 dark:text-rose-400";
  if (rate > 0.01) return "text-amber-600 dark:text-amber-400";
  return "text-slate-500 dark:text-slate-400";
}

/** Drops the shared date/year prefix from bucket labels so chart axes stay readable. */
export function bucketLabelFormatter(labels: string[]): (label: string) => string {
  const first = labels[0] ?? "";
  const sameDay = labels.every((label) => label.slice(0, 10) === first.slice(0, 10));
  const sameYear = labels.every((label) => label.slice(0, 4) === first.slice(0, 4));
  return (label) => {
    if (label.length > 10 && sameDay) return label.slice(11);
    if (sameYear && label.length >= 10) return label.slice(5);
    return label;
  };
}
