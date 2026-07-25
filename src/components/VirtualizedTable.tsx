import { List, type RowComponentProps } from 'react-window'
import { formatMs, formatNum } from '../utils/format'
import type { AggregatedEndpoint } from '../utils/pm2LogParser'
import type { CronAggregated } from '../utils/cronLogParser'

type ApiRowProps = {
  rows: AggregatedEndpoint[]
}

type CronRowProps = {
  rows: CronAggregated[]
}

function MethodBadge({ method }: { method: string }) {
  const styles: Record<string, string> = {
    GET: 'bg-sky-50 text-sky-700 ring-sky-200',
    POST: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    PUT: 'bg-amber-50 text-amber-700 ring-amber-200',
    PATCH: 'bg-amber-50 text-amber-700 ring-amber-200',
    DELETE: 'bg-rose-50 text-rose-700 ring-rose-200',
    OPTIONS: 'bg-violet-50 text-violet-700 ring-violet-200',
    HEAD: 'bg-slate-50 text-slate-700 ring-slate-200',
  }
  const cls = styles[method] || styles.GET
  return (
    <span className={`inline-block shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ring-1 ${cls}`}>
      {method}
    </span>
  )
}

function ApiRow({ index, style, rows }: RowComponentProps<ApiRowProps>) {
  const row = rows[index]!
  const isEven = index % 2 === 0
  return (
    <div
      style={style}
      className={`grid grid-cols-[minmax(0,1fr)_72px_72px_72px_72px_72px_72px] items-center gap-1 border-b border-slate-100 px-3 text-xs ${isEven ? 'bg-slate-50/80' : 'bg-white'}`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <MethodBadge method={row.method} />
        <span className="truncate font-mono-data text-[11px] text-slate-800" title={row.path}>
          {row.path}
        </span>
      </div>
      <div className="text-right tabular-nums text-slate-700">{formatNum(row.count)}</div>
      <div className="text-right tabular-nums text-slate-700">{formatMs(row.avgMs)}</div>
      <div className="text-right tabular-nums font-semibold text-indigo-600">{formatMs(row.p95Ms)}</div>
      <div className="text-right tabular-nums text-slate-700">{formatMs(row.p99Ms)}</div>
      <div className="text-right tabular-nums font-semibold text-amber-700">{formatMs(row.maxMs)}</div>
      <div className={`text-right tabular-nums ${row.errorCount > 0 ? 'font-semibold text-rose-600' : 'text-slate-400'}`}>
        {formatNum(row.errorCount)}
      </div>
    </div>
  )
}

function CronRow({ index, style, rows }: RowComponentProps<CronRowProps>) {
  const row = rows[index]!
  const isEven = index % 2 === 0
  return (
    <div
      style={style}
      className={`grid grid-cols-[minmax(0,1.2fr)_64px_64px_64px_72px_72px_72px_72px_72px_80px] items-center gap-1 border-b border-slate-100 px-3 text-xs ${isEven ? 'bg-slate-50/80' : 'bg-white'}`}
    >
      <div className="truncate font-mono-data text-[11px] text-slate-800" title={row.name}>
        {row.name}
      </div>
      <div className="text-right tabular-nums">{formatNum(row.runs)}</div>
      <div className="text-right tabular-nums text-slate-400">{formatNum(row.starts)}</div>
      <div className={`text-right tabular-nums ${row.fails > 0 ? 'font-semibold text-rose-600' : 'text-slate-400'}`}>
        {formatNum(row.fails)}
      </div>
      <div className="text-right tabular-nums">{formatMs(row.avgMs)}</div>
      <div className="text-right tabular-nums font-semibold text-indigo-600">{formatMs(row.p95Ms)}</div>
      <div className="text-right tabular-nums">{formatMs(row.p99Ms)}</div>
      <div className="text-right tabular-nums font-semibold text-amber-700">{formatMs(row.maxMs)}</div>
      <div className="text-right tabular-nums text-slate-400">{formatMs(row.minMs)}</div>
      <div className="text-right tabular-nums">
        {row.lastDurationMs !== undefined ? formatMs(row.lastDurationMs) : '-'}
      </div>
    </div>
  )
}

export function VirtualizedApiTable({ rows, height = 420 }: { rows: AggregatedEndpoint[]; height?: number }) {
  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center px-3 py-10 text-sm text-slate-400" style={{ height }}>
        Paste or upload logs to see your slowest APIs here.
      </div>
    )
  }

  return (
    <div className="overflow-hidden" style={{ height }}>
      <div className="grid grid-cols-[minmax(0,1fr)_72px_72px_72px_72px_72px_72px] items-center gap-1 border-b border-slate-100 bg-slate-50 px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
        <div>Endpoint</div>
        <div className="text-right">Count</div>
        <div className="text-right">Avg</div>
        <div className="text-right">p95</div>
        <div className="text-right">p99</div>
        <div className="text-right">Max</div>
        <div className="text-right">Errors</div>
      </div>
      <div style={{ height: height - 40 }}>
        <List
          rowComponent={ApiRow}
          rowCount={rows.length}
          rowHeight={36}
          rowProps={{ rows }}
          overscanCount={8}
          style={{ height: '100%', width: '100%' }}
        />
      </div>
    </div>
  )
}

export function VirtualizedCronTable({ rows, height = 420 }: { rows: CronAggregated[]; height?: number }) {
  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center px-3 py-10 text-sm text-slate-400" style={{ height }}>
        Paste lines containing <code className="font-mono-data">[cron] start|done|fail</code> to populate this table.
      </div>
    )
  }

  return (
    <div className="overflow-hidden" style={{ height }}>
      <div className="grid grid-cols-[minmax(0,1.2fr)_64px_64px_64px_72px_72px_72px_72px_72px_80px] items-center gap-1 border-b border-slate-100 bg-slate-50 px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
        <div>Cron Job</div>
        <div className="text-right">Runs</div>
        <div className="text-right">Starts</div>
        <div className="text-right">Fails</div>
        <div className="text-right">Avg</div>
        <div className="text-right">p95</div>
        <div className="text-right">p99</div>
        <div className="text-right">Max</div>
        <div className="text-right">Min</div>
        <div className="text-right">Last</div>
      </div>
      <div style={{ height: height - 40 }}>
        <List
          rowComponent={CronRow}
          rowCount={rows.length}
          rowHeight={36}
          rowProps={{ rows }}
          overscanCount={8}
          style={{ height: '100%', width: '100%' }}
        />
      </div>
    </div>
  )
}
