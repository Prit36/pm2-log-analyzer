export function formatMs(ms: number) {
  if (!Number.isFinite(ms)) return "-";
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${ms.toFixed(0)}ms`;
}

export function formatNum(n: number) {
  return new Intl.NumberFormat().format(n);
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${Number.parseFloat((bytes / k ** i).toFixed(1))} ${sizes[i]}`;
}

export function formatDate(date?: string): string {
  if (!date) return "";
  const [y, m, d] = date.split("-");
  return y && m && d ? new Date(+y, +m - 1, +d).toLocaleDateString() : date;
}
