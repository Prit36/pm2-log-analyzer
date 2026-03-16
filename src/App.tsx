import React from 'react'
import { ResponsiveContainer, BarChart, Bar, CartesianGrid, XAxis, YAxis, Tooltip } from 'recharts'
import { FileDrop } from './components/FileDrop'
import { aggregateByEndpoint, parsePm2Logs, type NormalizeMode } from './utils/pm2LogParser'

function formatMs(ms: number) {
  if (!Number.isFinite(ms)) return '-'
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`
  return `${ms.toFixed(0)}ms`
}

function formatNum(n: number) {
  return new Intl.NumberFormat().format(n)
}

type SortKey = 'p95Ms' | 'p99Ms' | 'avgMs' | 'maxMs' | 'count' | 'errorCount'

type Analyzed = {
  matched: ReturnType<typeof parsePm2Logs>['matched']
  unmatched: ReturnType<typeof parsePm2Logs>['unmatched']
}

export function App() {
  const [logText, setLogText] = React.useState('')
  const [sourceName, setSourceName] = React.useState<string | undefined>(undefined)

  const [normalizeMode, setNormalizeMode] = React.useState<NormalizeMode>('collapseIds')
  const [statusFamily, setStatusFamily] = React.useState<'all' | '2xx' | '3xx' | '4xx' | '5xx'>('all')
  const [minMs, setMinMs] = React.useState(0)
  const [topN, setTopN] = React.useState(20)
  const [sortKey, setSortKey] = React.useState<SortKey>('p95Ms')
  const [query, setQuery] = React.useState('')

  const analyzed: Analyzed = React.useMemo(() => parsePm2Logs(logText), [logText])

  const methodSet = React.useMemo(() => {
    const s = new Set<string>()
    for (const l of analyzed.matched) s.add(l.method!)
    return s
  }, [analyzed.matched])

  const [methodFilter, setMethodFilter] = React.useState<Set<string> | null>(null)

  React.useEffect(() => {
    // Initialize method filter to all methods found
    if (methodSet.size > 0 && methodFilter === null) setMethodFilter(new Set(methodSet))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [methodSet])

  const rows = React.useMemo(() => {
    const mf = methodFilter ?? new Set(methodSet)
    const aggregated = aggregateByEndpoint(analyzed.matched, normalizeMode, mf, statusFamily, minMs)

    const q = query.trim().toLowerCase()
    const filtered = q
      ? aggregated.filter((r) => `${r.method} ${r.path}`.toLowerCase().includes(q))
      : aggregated

    const sorted = [...filtered].sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      return bv - av
    })

    return sorted
  }, [analyzed.matched, methodFilter, methodSet, minMs, normalizeMode, query, sortKey, statusFamily])

  const topRows = React.useMemo(() => rows.slice(0, topN), [rows, topN])

  const summary = React.useMemo(() => {
    const totalLines = logText.split(/\r?\n/).filter((l) => l.trim().length > 0).length
    const matched = analyzed.matched.length
    const unmatched = analyzed.unmatched.length
    const max = analyzed.matched.reduce((m, l) => Math.max(m, l.durationMs ?? 0), 0)
    const avg = matched
      ? analyzed.matched.reduce((s, l) => s + (l.durationMs ?? 0), 0) / matched
      : 0
    const errors = analyzed.matched.filter((l) => (l.status ?? 0) >= 400).length
    return { totalLines, matched, unmatched, max, avg, errors }
  }, [analyzed, logText])

  const chartData = React.useMemo(() => {
    return topRows
      .map((r) => ({
        name: `${r.method} ${r.path}`,
        p95Ms: Number(r.p95Ms.toFixed(2)),
        avgMs: Number(r.avgMs.toFixed(2)),
        maxMs: Number(r.maxMs.toFixed(2)),
        count: r.count,
      }))
      .reverse()
  }, [topRows])

  function toggleMethod(m: string) {
    setMethodFilter((prev) => {
      const next = new Set(prev ?? methodSet)
      if (next.has(m)) next.delete(m)
      else next.add(m)
      return next
    })
  }

  function selectAllMethods() {
    setMethodFilter(new Set(methodSet))
  }

  function clearMethods() {
    setMethodFilter(new Set())
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-6xl px-4 py-4 sm:px-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h1 className="text-xl font-semibold tracking-tight">PM2 Log Analyzer</h1>
              <p className="text-sm text-slate-600">
                Paste your PM2 HTTP logs and find which APIs are slow (p95/p99/avg/max).
              </p>
            </div>
            <div className="text-xs text-slate-500">
              {sourceName ? (
                <span>
                  Source: <span className="font-medium text-slate-700">{sourceName}</span>
                </span>
              ) : (
                <span>Tip: drop a file to analyze instantly.</span>
              )}
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-6">
        <FileDrop
          onText={(t, meta) => {
            setLogText(t)
            setSourceName(meta?.name)
          }}
        />

        <section className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Paste logs</h2>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold hover:bg-slate-50"
                  onClick={() => {
                    setLogText('')
                    setSourceName(undefined)
                  }}
                >
                  Clear
                </button>
                <button
                  type="button"
                  className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
                  onClick={async () => {
                    await navigator.clipboard.writeText(logText)
                  }}
                  disabled={!logText}
                >
                  Copy
                </button>
              </div>
            </div>
            <textarea
              className="mt-3 h-64 w-full resize-y rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono text-xs leading-5 text-slate-900 outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
              placeholder="Paste PM2 logs here..."
              value={logText}
              onChange={(e) => {
                setLogText(e.target.value)
                if (!sourceName) setSourceName('pasted')
              }}
            />
            <div className="mt-2 text-xs text-slate-600">
              Parsed: <span className="font-semibold">{formatNum(summary.matched)}</span> matched lines,
              <span className="font-semibold"> {formatNum(summary.unmatched)}</span> skipped, errors:{' '}
              <span className="font-semibold">{formatNum(summary.errors)}</span>, avg:{' '}
              <span className="font-semibold">{formatMs(summary.avg)}</span>, max:{' '}
              <span className="font-semibold">{formatMs(summary.max)}</span>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <h2 className="text-sm font-semibold">Filters</h2>

            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="block">
                <div className="text-xs font-semibold text-slate-700">Normalize URLs</div>
                <select
                  className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
                  value={normalizeMode}
                  onChange={(e) => setNormalizeMode(e.target.value as NormalizeMode)}
                >
                  <option value="collapseIds">Collapse IDs (recommended)</option>
                  <option value="stripQuery">Strip query string</option>
                  <option value="exact">Exact (includes IDs + query)</option>
                </select>
                <div className="mt-1 text-xs text-slate-500">
                  Helps group endpoints like <span className="font-mono">/policy/:id/getcomments</span>
                </div>
              </label>

              <label className="block">
                <div className="text-xs font-semibold text-slate-700">Status</div>
                <select
                  className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
                  value={statusFamily}
                  onChange={(e) => setStatusFamily(e.target.value as any)}
                >
                  <option value="all">All</option>
                  <option value="2xx">2xx</option>
                  <option value="3xx">3xx</option>
                  <option value="4xx">4xx</option>
                  <option value="5xx">5xx</option>
                </select>
              </label>

              <label className="block">
                <div className="text-xs font-semibold text-slate-700">Min duration (ms)</div>
                <input
                  className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
                  type="number"
                  min={0}
                  value={minMs}
                  onChange={(e) => setMinMs(Math.max(0, Number(e.target.value || 0)))}
                />
              </label>

              <label className="block">
                <div className="text-xs font-semibold text-slate-700">Top N</div>
                <input
                  className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
                  type="number"
                  min={1}
                  max={200}
                  value={topN}
                  onChange={(e) => setTopN(Math.min(200, Math.max(1, Number(e.target.value || 20))))}
                />
              </label>

              <label className="block sm:col-span-2">
                <div className="text-xs font-semibold text-slate-700">Search endpoint</div>
                <input
                  className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
                  placeholder="e.g. /api/admin/motor"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
            </div>

            <div className="mt-4">
              <div className="flex items-center justify-between">
                <div className="text-xs font-semibold text-slate-700">Methods</div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="rounded-md border border-slate-200 px-2 py-1 text-xs font-semibold hover:bg-slate-50"
                    onClick={selectAllMethods}
                  >
                    All
                  </button>
                  <button
                    type="button"
                    className="rounded-md border border-slate-200 px-2 py-1 text-xs font-semibold hover:bg-slate-50"
                    onClick={clearMethods}
                  >
                    None
                  </button>
                </div>
              </div>

              <div className="mt-2 flex flex-wrap gap-2">
                {Array.from(methodSet)
                  .sort()
                  .map((m) => {
                    const checked = (methodFilter ?? methodSet).has(m)
                    return (
                      <button
                        key={m}
                        type="button"
                        onClick={() => toggleMethod(m)}
                        className={
                          'rounded-full border px-3 py-1 text-xs font-semibold ' +
                          (checked
                            ? 'border-indigo-200 bg-indigo-50 text-indigo-700'
                            : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50')
                        }
                      >
                        {m}
                      </button>
                    )
                  })}
                {methodSet.size === 0 && <div className="text-xs text-slate-500">No methods found yet.</div>}
              </div>
            </div>

            <div className="mt-4">
              <div className="text-xs font-semibold text-slate-700">Sort by</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {(
                  [
                    { k: 'p95Ms', label: 'p95' },
                    { k: 'p99Ms', label: 'p99' },
                    { k: 'avgMs', label: 'avg' },
                    { k: 'maxMs', label: 'max' },
                    { k: 'count', label: 'count' },
                    { k: 'errorCount', label: 'errors' },
                  ] as { k: SortKey; label: string }[]
                ).map(({ k, label }) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setSortKey(k)}
                    className={
                      'rounded-lg border px-3 py-1.5 text-xs font-semibold ' +
                      (sortKey === k
                        ? 'border-slate-900 bg-slate-900 text-white'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50')
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Slow endpoints (Top {topN})</h2>
              <button
                type="button"
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold hover:bg-slate-50"
                onClick={async () => {
                  const header = ['method', 'path', 'count', 'avgMs', 'p95Ms', 'p99Ms', 'maxMs', 'errorCount']
                  const lines = topRows.map((r) =>
                    [r.method, r.path, r.count, r.avgMs.toFixed(3), r.p95Ms.toFixed(3), r.p99Ms.toFixed(3), r.maxMs.toFixed(3), r.errorCount].join(',')
                  )
                  const csv = [header.join(','), ...lines].join('\n')
                  await navigator.clipboard.writeText(csv)
                }}
                disabled={topRows.length === 0}
              >
                Copy CSV
              </button>
            </div>

            <div className="mt-3 overflow-auto rounded-lg border border-slate-200">
              <table className="min-w-full text-left text-xs">
                <thead className="bg-slate-50 text-slate-700">
                  <tr>
                    <th className="px-3 py-2">Endpoint</th>
                    <th className="px-3 py-2">Count</th>
                    <th className="px-3 py-2">Avg</th>
                    <th className="px-3 py-2">p95</th>
                    <th className="px-3 py-2">p99</th>
                    <th className="px-3 py-2">Max</th>
                    <th className="px-3 py-2">Errors</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {topRows.map((r) => (
                    <tr key={r.key} className="hover:bg-slate-50">
                      <td className="max-w-[34rem] px-3 py-2">
                        <div className="font-semibold text-slate-900">{r.method}</div>
                        <div className="truncate font-mono text-[11px] text-slate-700" title={`${r.method} ${r.path}`}>
                          {r.path}
                        </div>
                      </td>
                      <td className="px-3 py-2 tabular-nums">{formatNum(r.count)}</td>
                      <td className="px-3 py-2 tabular-nums">{formatMs(r.avgMs)}</td>
                      <td className="px-3 py-2 tabular-nums">{formatMs(r.p95Ms)}</td>
                      <td className="px-3 py-2 tabular-nums">{formatMs(r.p99Ms)}</td>
                      <td className="px-3 py-2 tabular-nums">{formatMs(r.maxMs)}</td>
                      <td className="px-3 py-2 tabular-nums">{formatNum(r.errorCount)}</td>
                    </tr>
                  ))}
                  {topRows.length === 0 && (
                    <tr>
                      <td className="px-3 py-6 text-center text-slate-500" colSpan={7}>
                        Paste or upload PM2 logs to see results.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <h2 className="text-sm font-semibold">Visualization (Top {topN} by {sortKey})</h2>
            <div className="mt-3 h-96">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} layout="vertical" margin={{ top: 8, right: 16, bottom: 8, left: 16 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis type="number" tickFormatter={(v) => `${v}ms`} />
                  <YAxis
                    type="category"
                    dataKey="name"
                    width={140}
                    tick={{ fontSize: 10 }}
                    tickFormatter={(v) => {
                      const s = String(v)
                      return s.length > 18 ? s.slice(0, 18) + '…' : s
                    }}
                  />
                  <Tooltip
                    formatter={(value: any, name: any) => {
                      if (name === 'count') return [formatNum(Number(value)), 'count']
                      return [formatMs(Number(value)), name]
                    }}
                    labelFormatter={(label) => String(label)}
                  />
                  <Bar dataKey="p95Ms" fill="#6366f1" radius={[6, 6, 6, 6]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-2 text-xs text-slate-500">
              Chart shows <span className="font-semibold">p95</span> latency (ms). Use “Sort by” to change top list.
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold">Skipped lines</h2>
          <p className="mt-1 text-xs text-slate-600">
            Non-HTTP lines (like custom app logs) are skipped. If you want them parsed too, share an example and I’ll extend the parser.
          </p>
          <div className="mt-3 max-h-48 overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono text-[11px] leading-5 text-slate-700">
            {analyzed.unmatched.slice(0, 50).map((l, idx) => (
              <div key={idx} className="whitespace-pre-wrap">
                {l.raw}
              </div>
            ))}
            {analyzed.unmatched.length === 0 && <div>None</div>}
            {analyzed.unmatched.length > 50 && (
              <div className="mt-2 text-slate-500">…and {formatNum(analyzed.unmatched.length - 50)} more</div>
            )}
          </div>
        </section>

        <footer className="pb-10 text-xs text-slate-500">
          Works fully in-browser (no uploads). Supports PM2/Express-like lines: method + path + status + durationMs.
        </footer>
      </main>
    </div>
  )
}

export default App
