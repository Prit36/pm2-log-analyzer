// Design tokens — centralized palette for charts and UI
// This file intentionally contains hardcoded color literals (design system source of truth).

export const PALETTE = {
  grid: { dark: "#1e293b", light: "#f1f5f9" },
  tick: { dark: "#94a3b8", light: "#64748b" },
  categoryTick: { dark: "#cbd5e1", light: "#334155" },
  tooltip: {
    dark: { bg: "#0f172a", border: "#334155", text: "#f8fafc" },
    light: { border: "#cbd5e1" },
  },
  latency: {
    p99: "#7c3aed",
    p95: "#2563eb",
    avg: "#0d9488",
    p99Dark: "#7c3aed",
    p95Dark: "#2563eb",
    avgDark: "#0d9488",
  },
  throughput: {
    bar: { dark: "#60a5fa", light: "#3b82f6" },
    error: "#ef4444",
    errorDark: "#f87171",
  },
  distribution: [
    "#22c55e",
    "#84cc16",
    "#eab308",
    "#f97316",
    "#ef4444",
    "#b91c1c",
    "#7f1d1d",
  ] as const,
  daily: {
    bar: { dark: "#60a5fa", light: "#3b82f6" },
    p95: { dark: "#a78bfa", light: "#7c3aed" },
  },
} as const;
