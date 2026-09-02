export function generateIndexSuggestion(
  collection: string,
  filterKeys: readonly string[],
  sortKeys: readonly string[],
  planSummary: string,
): string {
  if (!collection || collection === "unknown" || collection === "$cmd") {
    return "";
  }

  // If already IXSCAN and optimal, maybe no suggestion or secondary
  const isCollscan = planSummary.includes("COLLSCAN");

  const combinedKeys = new Set<string>();

  // Filter out mongo operator keys like $and, $or
  for (const k of filterKeys) {
    if (k.startsWith("$")) continue;
    combinedKeys.add(k);
  }

  for (const k of sortKeys) {
    if (k.startsWith("$")) continue;
    combinedKeys.add(k);
  }

  if (combinedKeys.size === 0) {
    if (isCollscan) {
      return `db.${collection}.createIndex({ /* specify target filter field */: 1 })`;
    }
    return "";
  }

  const fieldsObj: Record<string, number> = {};
  for (const key of combinedKeys) {
    // Basic ESR rule: sorts often 1, equality 1
    fieldsObj[key] = 1;
    if (Object.keys(fieldsObj).length >= 4) break; // keep compound index reasonable
  }

  const entries = Object.entries(fieldsObj)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");

  return `db.${collection}.createIndex({ ${entries} })`;
}
