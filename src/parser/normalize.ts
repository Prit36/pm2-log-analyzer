import type { NormalizeMode } from "./types";

export function normalizePath(path: string, mode: NormalizeMode): string {
  if (mode === "exact") return path;
  let p = path;
  if (mode === "stripQuery" || mode === "collapseIds") {
    const q = p.indexOf("?");
    if (q !== -1) p = p.slice(0, q);
  }
  if (mode === "collapseIds") {
    p = p
      .split("/")
      .map((seg) => {
        if (!seg) return seg;
        if (/^[a-f0-9]{24}$/i.test(seg)) return ":id";
        if (/^[0-9]{6,}$/.test(seg)) return ":id";
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg))
          return ":id";
        if (/^PR-[A-Z]{3,}-\d{8,}$/i.test(seg)) return ":id";
        if (/^[A-Z]{2,}-[A-Z]{2,}-\d{6,}$/i.test(seg)) return ":id";
        return seg;
      })
      .join("/");
  }
  return p;
}
