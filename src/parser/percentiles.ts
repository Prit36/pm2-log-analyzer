/** Nearest-rank percentile on a pre-sorted ascending array. */
export function percentile(sorted: ArrayLike<number>, p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

export function sortAsc(values: number[]): number[] {
  return values.slice().sort((a, b) => a - b);
}

/** Sort a duration buffer in place (copy) for summary percentiles. */
export function sortedDurations(durations: Float32Array, count: number): Float32Array {
  const sorted = durations.slice(0, count);
  sorted.sort();
  return sorted;
}

