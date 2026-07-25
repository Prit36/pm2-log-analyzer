import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { AggregatedEndpoint } from "../parser";
import { formatMs } from "../utils/format";

export function LatencyChart({ rows }: { rows: AggregatedEndpoint[] }) {
  const data = useMemo(
    () =>
      rows.slice(0, 20).map((r) => ({
        name: `${r.method} ${r.path.length > 36 ? `${r.path.slice(0, 34)}…` : r.path}`,
        p95: Math.round(r.p95Ms),
        full: `${r.method} ${r.path}`,
      })),
    [rows],
  );

  return (
    <section className="rounded border border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-600">
          Top p95 latency
        </h2>
      </div>
      {data.length === 0 ? (
        <div className="px-3 py-10 text-center text-sm text-slate-400">No chart data yet.</div>
      ) : (
        <div className="h-[320px] px-2 py-3">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} layout="vertical" margin={{ top: 4, right: 12, left: 4, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
              <XAxis
                type="number"
                tick={{ fontSize: 10, fill: "#64748b" }}
                tickFormatter={(v) => formatMs(Number(v))}
              />
              <YAxis
                type="category"
                dataKey="name"
                width={160}
                tick={{ fontSize: 9, fill: "#475569", fontFamily: "IBM Plex Mono, monospace" }}
              />
              <Tooltip
                formatter={(value) => formatMs(Number(value ?? 0))}
                labelFormatter={(_, payload) => {
                  const p = payload?.[0]?.payload as { full?: string } | undefined;
                  return p?.full ?? "";
                }}
                contentStyle={{
                  fontSize: 12,
                  borderRadius: 4,
                  border: "1px solid #e2e8f0",
                }}
              />
              <Bar dataKey="p95" fill="#2563eb" radius={[0, 2, 2, 0]} maxBarSize={18} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}
