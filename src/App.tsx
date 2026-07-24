import React from 'react'
import { ResponsiveContainer, BarChart, Bar, CartesianGrid, XAxis, YAxis, Tooltip, Cell } from 'recharts'
import { FileDrop } from './components/FileDrop'
import { aggregateByEndpoint, parsePm2Logs, type NormalizeMode, type AggregatedEndpoint } from './utils/pm2LogParser'
import { aggregateCron, parseCronLogs, type CronAggregated } from './utils/cronLogParser'

/* ----------------------------- helpers ----------------------------- */

function formatMs(ms: number) {
  if (!Number.isFinite(ms)) return '-'
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`
  return `${ms.toFixed(0)}ms`
}
function formatNum(n: number) {
  return new Intl.NumberFormat().format(n)
}

/* Count-up animation hook */
function useCountUp(target: number, duration = 700) {
  const [val, setVal] = React.useState(0)
  const ref = React.useRef<number | null>(null)
  React.useEffect(() => {
    if (ref.current) cancelAnimationFrame(ref.current)
    const start = performance.now()
    const from = 0
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - t, 3)
      setVal(from + (target - from) * eased)
      if (t < 1) ref.current = requestAnimationFrame(tick)
    }
    ref.current = requestAnimationFrame(tick)
    return () => { if (ref.current) cancelAnimationFrame(ref.current) }
  }, [target, duration])
  return val
}

/* Scroll reveal hook */
function useReveal<T extends HTMLElement>() {
  const ref = React.useRef<T | null>(null)
  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('is-visible')
            io.unobserve(e.target)
          }
        })
      },
      { threshold: 0.08 }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])
  return ref
}

type SortKey = 'p95Ms' | 'p99Ms' | 'avgMs' | 'maxMs' | 'count' | 'errorCount'
type CronSortKey = 'p95Ms' | 'p99Ms' | 'avgMs' | 'maxMs' | 'runs' | 'fails'

type Analyzed = {
  matched: ReturnType<typeof parsePm2Logs>['matched']
  unmatched: ReturnType<typeof parsePm2Logs>['unmatched']
}

/* LocalStorage keys */
const LS = {
  logs: 'pm2_analyzer_logs_v1',
  source: 'pm2_analyzer_source_v1',
  norm: 'pm2_analyzer_norm_v1',
  status: 'pm2_analyzer_status_v1',
  minms: 'pm2_analyzer_minms_v1',
  topn: 'pm2_analyzer_topn_v1',
  sort: 'pm2_analyzer_sort_v1',
  query: 'pm2_analyzer_query_v1',
  cQuery: 'pm2_analyzer_cron_query_v1',
  cMin: 'pm2_analyzer_cron_minms_v1',
  cFail: 'pm2_analyzer_cron_failed_v1',
  cSort: 'pm2_analyzer_cron_sort_v1',
}
const lsGet = (k: string, fb: string) => { try { return localStorage.getItem(k) ?? fb } catch { return fb } }
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { } }
const lsDel = (k: string) => { try { localStorage.removeItem(k) } catch { } }

/* ----------------------------- component ----------------------------- */

export function App() {
  /* ---- persisted state ---- */
  const [logText, setLogText] = React.useState<string>(() => lsGet(LS.logs, ''))
  const [sourceName, setSourceName] = React.useState<string | undefined>(() => lsGet(LS.source, '') || undefined)
  const [normalizeMode, setNormalizeMode] = React.useState<NormalizeMode>(() => (lsGet(LS.norm, 'collapseIds') as NormalizeMode))
  const [statusFamily, setStatusFamily] = React.useState<'all' | '2xx' | '3xx' | '4xx' | '5xx'>(() => (lsGet(LS.status, 'all') as any))
  const [minMs, setMinMs] = React.useState<number>(() => Number(lsGet(LS.minms, '0')) || 0)
  const [topN, setTopN] = React.useState<number>(() => Number(lsGet(LS.topn, '20')) || 20)
  const [sortKey, setSortKey] = React.useState<SortKey>(() => (lsGet(LS.sort, 'p95Ms') as SortKey))
  const [query, setQuery] = React.useState<string>(() => lsGet(LS.query, ''))

  const [cronQuery, setCronQuery] = React.useState<string>(() => lsGet(LS.cQuery, ''))
  const [cronMinMs, setCronMinMs] = React.useState<number>(() => Number(lsGet(LS.cMin, '0')) || 0)
  const [cronShowFailedOnly, setCronShowFailedOnly] = React.useState<boolean>(() => lsGet(LS.cFail, '0') === '1')
  const [cronSortKey, setCronSortKey] = React.useState<CronSortKey>(() => (lsGet(LS.cSort, 'p95Ms') as CronSortKey))

  const [toast, setToast] = React.useState<string | null>(null)

  /* ---- persistence effects ---- */
  React.useEffect(() => { logText ? lsSet(LS.logs, logText) : lsDel(LS.logs) }, [logText])
  React.useEffect(() => { sourceName ? lsSet(LS.source, sourceName) : lsDel(LS.source) }, [sourceName])
  React.useEffect(() => {
    lsSet(LS.norm, normalizeMode); lsSet(LS.status, statusFamily); lsSet(LS.minms, String(minMs))
    lsSet(LS.topn, String(topN)); lsSet(LS.sort, sortKey); lsSet(LS.query, query)
  }, [normalizeMode, statusFamily, minMs, topN, sortKey, query])
  React.useEffect(() => {
    lsSet(LS.cQuery, cronQuery); lsSet(LS.cMin, String(cronMinMs))
    lsSet(LS.cFail, cronShowFailedOnly ? '1' : '0'); lsSet(LS.cSort, cronSortKey)
  }, [cronQuery, cronMinMs, cronShowFailedOnly, cronSortKey])

  /* ---- derived data ---- */
  const analyzed: Analyzed = React.useMemo(() => parsePm2Logs(logText), [logText])

  const methodSet = React.useMemo(() => {
    const s = new Set<string>()
    for (const l of analyzed.matched) if (l.method) s.add(l.method)
    return s
  }, [analyzed.matched])

  const [methodFilter, setMethodFilter] = React.useState<Set<string> | null>(null)
  React.useEffect(() => {
    if (methodSet.size > 0 && methodFilter === null) setMethodFilter(new Set(methodSet))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [methodSet])

  const rows = React.useMemo(() => {
    const mf = methodFilter ?? new Set(methodSet)
    const aggregated = aggregateByEndpoint(analyzed.matched, normalizeMode, mf, statusFamily, minMs)
    const q = query.trim().toLowerCase()
    const filtered = q ? aggregated.filter((r) => `${r.method} ${r.path}`.toLowerCase().includes(q)) : aggregated
    return [...filtered].sort((a, b) => (b as any)[sortKey] - (a as any)[sortKey])
  }, [analyzed.matched, methodFilter, methodSet, minMs, normalizeMode, query, sortKey, statusFamily])

  const topRows = React.useMemo(() => rows.slice(0, topN), [rows, topN])

  const summary = React.useMemo(() => {
    const matched = analyzed.matched.length
    const unmatched = analyzed.unmatched.length
    const max = analyzed.matched.reduce((m, l) => Math.max(m, l.durationMs ?? 0), 0)
    const avg = matched ? analyzed.matched.reduce((s, l) => s + (l.durationMs ?? 0), 0) / matched : 0
    const errors = analyzed.matched.filter((l) => (l.status ?? 0) >= 400).length
    const slow = analyzed.matched.filter((l) => (l.durationMs ?? 0) >= 3000).length
    return { matched, unmatched, max, avg, errors, slow }
  }, [analyzed])

  const cronParsed = React.useMemo(() => parseCronLogs(logText), [logText])
  const cronRows: CronAggregated[] = React.useMemo(() => {
    const agg = aggregateCron(cronParsed.events, { query: cronQuery, minMs: cronMinMs, showFailedOnly: cronShowFailedOnly })
    return [...agg].sort((a, b) => (b as any)[cronSortKey] - (a as any)[cronSortKey])
  }, [cronParsed.events, cronQuery, cronMinMs, cronShowFailedOnly, cronSortKey])

  const cronSummary = React.useMemo(() => {
    const starts = cronParsed.events.filter(e => e.event === 'start').length
    const dones = cronParsed.events.filter(e => e.event === 'done').length
    const fails = cronParsed.events.filter(e => e.event === 'fail').length
    const slowestRun = cronRows.reduce((m, r) => Math.max(m, r.maxMs), 0)
    return { starts, dones, fails, jobs: cronRows.length, slowestRun }
  }, [cronParsed.events, cronRows])

  const chartData = React.useMemo(() =>
    topRows.map((r) => ({
      name: `${r.method} ${r.path}`,
      p95Ms: Number(r.p95Ms.toFixed(2)),
      avgMs: Number(r.avgMs.toFixed(2)),
      maxMs: Number(r.maxMs.toFixed(2)),
      count: r.count,
    })).reverse()
    , [topRows])

  const tickerItems = React.useMemo(() => rows.slice(0, 10), [rows])

  /* ---- reveal refs ---- */
  const revealApi = useReveal<HTMLDivElement>()
  const revealCron = useReveal<HTMLDivElement>()
  const revealKpi = useReveal<HTMLDivElement>()

  /* ---- count-ups ---- */
  const cuRequests = useCountUp(summary.matched)
  const cuAvg = useCountUp(summary.avg)
  const cuMax = useCountUp(summary.max)
  const cuErrors = useCountUp(summary.errors)
  const cuCronJobs = useCountUp(cronSummary.jobs)
  const cuCronFails = useCountUp(cronSummary.fails)

  /* ---- ui actions ---- */
  function showToast(msg: string) { setToast(msg); setTimeout(() => setToast(null), 2800) }

  function toggleMethod(m: string) {
    setMethodFilter((prev) => {
      const next = new Set(prev ?? methodSet)
      next.has(m) ? next.delete(m) : next.add(m)
      return next
    })
  }
  const selectAllMethods = () => setMethodFilter(new Set(methodSet))
  const clearMethods = () => setMethodFilter(new Set())

  function handleClearAll() {
    setLogText(''); setSourceName(undefined); lsDel(LS.logs); lsDel(LS.source)
    showToast('All logs cleared from memory & storage.')
  }

  /* ---- excel export helpers ---- */
  const buildApiRows = (data: AggregatedEndpoint[]) => data.map((r) => ({
    Method: r.method, Endpoint: r.path, Count: formatNum(r.count),
    Avg: formatMs(r.avgMs), p95: formatMs(r.p95Ms), p99: formatMs(r.p99Ms),
    Max: formatMs(r.maxMs), Min: formatMs(r.minMs), Errors: formatNum(r.errorCount),
  }))

  const esc = (v: any) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

  function handleDownloadExcel() {
    if (topRows.length === 0 && cronRows.length === 0) { showToast('Nothing to export yet — paste logs first.'); return }
    const apiData = buildApiRows(topRows)
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const generated = new Date().toLocaleString()

    // API sheet rows
    const apiHeaders = ['Method', 'Endpoint', 'Count', 'Avg', 'p95', 'p99', 'Max', 'Min', 'Errors']
    const apiHeaderRow = `<Row ss:StyleID="sHeader">${apiHeaders.map(h => `<Cell><Data ss:Type="String">${esc(h)}</Data></Cell>`).join('')}</Row>`
    const apiBodyRows = apiData.map((row) => {
      const ms = row.Method === 'GET' ? 'sMethodGet' : row.Method === 'POST' ? 'sMethodPost' : 'sMethodOther'
      const es = Number(row.Errors) > 0 ? 'sErrorCell' : 'sDataCell'
      return `<Row>
        <Cell ss:StyleID="${ms}"><Data ss:Type="String">${esc(row.Method)}</Data></Cell>
        <Cell ss:StyleID="sEndpointCell"><Data ss:Type="String">${esc(row.Endpoint)}</Data></Cell>
        <Cell ss:StyleID="sDataCell"><Data ss:Type="String">${esc(row.Count)}</Data></Cell>
        <Cell ss:StyleID="sDataCell"><Data ss:Type="String">${esc(row.Avg)}</Data></Cell>
        <Cell ss:StyleID="sP95Cell"><Data ss:Type="String">${esc(row.p95)}</Data></Cell>
        <Cell ss:StyleID="sDataCell"><Data ss:Type="String">${esc(row.p99)}</Data></Cell>
        <Cell ss:StyleID="sMaxCell"><Data ss:Type="String">${esc(row.Max)}</Data></Cell>
        <Cell ss:StyleID="sMinCell"><Data ss:Type="String">${esc(row.Min)}</Data></Cell>
        <Cell ss:StyleID="${es}"><Data ss:Type="String">${esc(row.Errors)}</Data></Cell>
      </Row>`
    }).join('')
    const apiEmpty = apiData.length === 0 ? `<Row><Cell ss:StyleID="sDataCell" ss:MergeAcross="8"><Data ss:Type="String">No API request lines detected in the pasted log.</Data></Cell></Row>` : ''

    // Cron sheet rows
    const cronHeaders = ['Cron Job', 'Runs', 'Starts', 'Fails', 'Avg', 'p95', 'p99', 'Max', 'Min', 'Last Run', 'Last Duration']
    const cronHeaderRow = `<Row ss:StyleID="sHeader">${cronHeaders.map(h => `<Cell><Data ss:Type="String">${esc(h)}</Data></Cell>`).join('')}</Row>`
    const cronBodyRows = cronRows.map((r) => {
      const fs = r.fails > 0 ? 'sErrorCell' : 'sDataCell'
      return `<Row>
        <Cell ss:StyleID="sEndpointCell"><Data ss:Type="String">${esc(r.name)}</Data></Cell>
        <Cell ss:StyleID="sDataCell"><Data ss:Type="String">${esc(formatNum(r.runs))}</Data></Cell>
        <Cell ss:StyleID="sDataCell"><Data ss:Type="String">${esc(formatNum(r.starts))}</Data></Cell>
        <Cell ss:StyleID="${fs}"><Data ss:Type="String">${esc(formatNum(r.fails))}</Data></Cell>
        <Cell ss:StyleID="sDataCell"><Data ss:Type="String">${esc(formatMs(r.avgMs))}</Data></Cell>
        <Cell ss:StyleID="sP95Cell"><Data ss:Type="String">${esc(formatMs(r.p95Ms))}</Data></Cell>
        <Cell ss:StyleID="sDataCell"><Data ss:Type="String">${esc(formatMs(r.p99Ms))}</Data></Cell>
        <Cell ss:StyleID="sMaxCell"><Data ss:Type="String">${esc(formatMs(r.maxMs))}</Data></Cell>
        <Cell ss:StyleID="sMinCell"><Data ss:Type="String">${esc(formatMs(r.minMs))}</Data></Cell>
        <Cell ss:StyleID="sDataCell"><Data ss:Type="String">${esc(r.lastRunTs ?? '-')}</Data></Cell>
        <Cell ss:StyleID="sDataCell"><Data ss:Type="String">${esc(r.lastDurationMs !== undefined ? formatMs(r.lastDurationMs) : '-')}</Data></Cell>
      </Row>`
    }).join('')
    const cronEmpty = cronRows.length === 0 ? `<Row><Cell ss:StyleID="sDataCell" ss:MergeAcross="10"><Data ss:Type="String">No [cron] start/done/fail lines detected in the pasted log.</Data></Cell></Row>` : ''

    // Shared styles block (Calibri 14, center+middle; title 20 bold left; meta 12 grey left)
    const styles = `
    <Style ss:ID="Default" ss:Name="Normal"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Size="14"/></Style>
    <Style ss:ID="sTitle"><Alignment ss:Horizontal="Left" ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Size="20" ss:Bold="1" ss:Color="#0F172A"/></Style>
    <Style ss:ID="sMeta"><Alignment ss:Horizontal="Left" ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Size="12" ss:Color="#475569"/></Style>
    <Style ss:ID="sMetaAccent"><Alignment ss:Horizontal="Left" ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Size="12" ss:Bold="1" ss:Color="#4F46E5"/></Style>
    <Style ss:ID="sSpacer"><Font ss:Size="6"/></Style>
    <Style ss:ID="sHeader"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Size="15" ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#4F46E5" ss:Pattern="Solid"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#3730A3"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#3730A3"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#3730A3"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#3730A3"/></Borders></Style>
    <Style ss:ID="sDataCell"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Size="14"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/></Borders></Style>
    <Style ss:ID="sEndpointCell"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="Consolas" ss:Size="14"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/></Borders></Style>
    <Style ss:ID="sP95Cell"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Size="14" ss:Bold="1" ss:Color="#4F46E5"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/></Borders></Style>
    <Style ss:ID="sMaxCell"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Size="14" ss:Bold="1" ss:Color="#D97706"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/></Borders></Style>
    <Style ss:ID="sMinCell"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Size="14" ss:Color="#64748B"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/></Borders></Style>
    <Style ss:ID="sErrorCell"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Size="14" ss:Bold="1" ss:Color="#DC2626"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/></Borders></Style>
    <Style ss:ID="sMethodGet"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Size="14" ss:Bold="1" ss:Color="#1E40AF"/><Interior ss:Color="#DBEAFE" ss:Pattern="Solid"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/></Borders></Style>
    <Style ss:ID="sMethodPost"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Size="14" ss:Bold="1" ss:Color="#065F46"/><Interior ss:Color="#D1FAE5" ss:Pattern="Solid"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/></Borders></Style>
    <Style ss:ID="sMethodOther"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Size="14" ss:Bold="1" ss:Color="#92400E"/><Interior ss:Color="#FEF3C7" ss:Pattern="Solid"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/></Borders></Style>`

    const sortLabelOf = (k: string) =>
      ({ p95Ms: 'p95', p99Ms: 'p99', avgMs: 'avg', maxMs: 'max', count: 'count', errorCount: 'errors', runs: 'runs', fails: 'fails' } as Record<string, string>)[k] ?? k

    const apiSortLabel = sortLabelOf(sortKey)
    const cronSortLabel = sortLabelOf(cronSortKey)
    const apiMeta = `Generated: ${generated}  |  Total Endpoints: ${apiData.length}  |  Sorted by: ${apiSortLabel}`
    const cronMeta = `Generated: ${generated}  |  Total Cron Jobs: ${cronRows.length}  |  Sorted by: ${cronSortLabel}`


    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:o="urn:schemas-microsoft-com:office:office"
  xmlns:x="urn:schemas-microsoft-com:office:excel"
  xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:html="http://www.w3.org/TR/REC-html40">
  <DocumentProperties xmlns="urn:schemas-microsoft-com:office:office">
    <Title>PM2 Log Analyzer Report</Title><Created>${new Date().toISOString()}</Created>
  </DocumentProperties>
  <Styles>${styles}</Styles>

  <Worksheet ss:Name="API Endpoints">
    <Table>
      <Column ss:Width="80"/><Column ss:Width="420"/><Column ss:Width="72"/><Column ss:Width="82"/>
      <Column ss:Width="82"/><Column ss:Width="82"/><Column ss:Width="82"/><Column ss:Width="82"/><Column ss:Width="72"/>
      <Row ss:Height="32"><Cell ss:StyleID="sTitle" ss:MergeAcross="8"><Data ss:Type="String">🚀 PM2 Log Analyzer - Slow API Endpoints Report</Data></Cell></Row>
      <Row ss:Height="20">
  <Cell ss:StyleID="sMeta" ss:MergeAcross="8">
    <Data ss:Type="String">${esc(apiMeta)}</Data>
  </Cell>
</Row>
      <Row ss:Height="8"><Cell ss:StyleID="sSpacer"/></Row>
      ${apiHeaderRow}
      ${apiBodyRows}
      ${apiEmpty}
    </Table>
    <WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><FreezePanes/><FrozenNoSplit/><SplitHorizontal>4</SplitHorizontal><TopRowBottomPane>4</TopRowBottomPane><ActivePane>2</ActivePane></WorksheetOptions>
  </Worksheet>

  <Worksheet ss:Name="Cron Jobs">
    <Table>
      <Column ss:Width="340"/><Column ss:Width="72"/><Column ss:Width="72"/><Column ss:Width="72"/>
      <Column ss:Width="92"/><Column ss:Width="92"/><Column ss:Width="92"/><Column ss:Width="92"/><Column ss:Width="92"/>
      <Column ss:Width="170"/><Column ss:Width="120"/>
      <Row ss:Height="32"><Cell ss:StyleID="sTitle" ss:MergeAcross="10"><Data ss:Type="String">⏱️ PM2 Log Analyzer - Cron Job Duration Report</Data></Cell></Row>
      <Row ss:Height="20">
  <Cell ss:StyleID="sMeta" ss:MergeAcross="10">
    <Data ss:Type="String">${esc(cronMeta)}</Data>
  </Cell>
</Row>
      <Row ss:Height="8"><Cell ss:StyleID="sSpacer"/></Row>
      ${cronHeaderRow}
      ${cronBodyRows}
      ${cronEmpty}
    </Table>
    <WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><FreezePanes/><FrozenNoSplit/><SplitHorizontal>4</SplitHorizontal><TopRowBottomPane>4</TopRowBottomPane><ActivePane>2</ActivePane></WorksheetOptions>
  </Worksheet>
</Workbook>`

    const blob = new Blob([xml], { type: 'application/vnd.ms-excel;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = `pm2-analyzer-report-${ts}.xls`
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url)
    showToast(`Excel downloaded — 2 tabs: API Endpoints + Cron Jobs`)
  }

  async function copyApiForExcel() {
    if (topRows.length === 0) return
    const d = buildApiRows(topRows)
    const h = ['Method', 'Endpoint', 'Count', 'Avg', 'p95', 'p99', 'Max', 'Min', 'Errors']
    const tsv = [h.join('\t'), ...d.map(r => h.map(k => String((r as any)[k] ?? '')).join('\t'))].join('\r\n')
    await navigator.clipboard.writeText(tsv); showToast('Copied API table — Ctrl+V in Excel.')
  }
  async function copyCronForExcel() {
    if (cronRows.length === 0) return
    const h = ['Cron Job', 'Runs', 'Starts', 'Fails', 'Avg', 'p95', 'p99', 'Max', 'Min', 'Last Run', 'Last Duration']
    const tsv = [h.join('\t'), ...cronRows.map(r => [r.name, r.runs, r.starts, r.fails, formatMs(r.avgMs), formatMs(r.p95Ms), formatMs(r.p99Ms), formatMs(r.maxMs), formatMs(r.minMs), r.lastRunTs ?? '-', r.lastDurationMs !== undefined ? formatMs(r.lastDurationMs) : '-'].join('\t'))].join('\r\n')
    await navigator.clipboard.writeText(tsv); showToast('Copied Cron table — Ctrl+V in Excel.')
  }

  /* ----------------------------- render ----------------------------- */
  return (
    <div className="min-h-screen">
      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 rise flex items-center gap-2.5 rounded-xl bg-slate-950/95 px-4 py-3 text-xs font-semibold text-white backdrop-blur fab-glow ring-1 ring-white/10">
          <span className="pulse-dot" />
          <span>{toast}</span>
        </div>
      )}

      {/* Floating quick nav */}
      <div className="fixed right-5 top-1/2 z-40 hidden -translate-y-1/2 flex-col gap-2 xl:flex">
        <a href="#api" className="press flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white/90 text-slate-700 shadow-sm backdrop-blur hover:border-indigo-300 hover:text-indigo-700" title="API Latency">🚀</a>
        <a href="#cron" className="press flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white/90 text-slate-700 shadow-sm backdrop-blur hover:border-emerald-300 hover:text-emerald-700" title="Cron Jobs">⏱️</a>
        <button onClick={handleDownloadExcel} className="press flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-md hover:bg-indigo-500" title="Download Excel (2 tabs)">⬇</button>
      </div>

      {/* Header band */}
      <header className="relative overflow-hidden bg-slate-950 text-white">
        <div className="pointer-events-none absolute inset-0 opacity-[0.18]" style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, rgba(255,255,255,0.6) 1px, transparent 0)', backgroundSize: '28px 28px' }} />
        <div className="pointer-events-none absolute -right-40 -top-40 h-[420px] w-[420px] rounded-full" style={{ background: 'radial-gradient(circle, rgba(99,102,241,0.45), transparent 60%)' }} />
        <div className="pointer-events-none absolute -left-32 top-10 h-[360px] w-[360px] rounded-full" style={{ background: 'radial-gradient(circle, rgba(16,185,129,0.28), transparent 60%)' }} />

        <div className="relative mx-auto max-w-7xl px-5 py-8 sm:px-8 sm:py-10">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="rise">
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-indigo-200 backdrop-blur">
                <span className="pulse-dot" /> observability · in-browser
              </div>
              <h1 className="font-display text-5xl font-bold leading-[0.95] tracking-tight sm:text-6xl lg:text-7xl">
                <span className="mr-3 inline-block align-middle">🚀</span>
                PM2 Log <span className="italic text-indigo-300">Analyzer</span>
              </h1>
              <p className="mt-4 max-w-2xl text-base leading-relaxed text-slate-300 sm:text-lg">
                Surface your slowest APIs and your slowest cron jobs from raw PM2 output — percentile latency, error rates, and a ready-to-share Excel workbook with two tabs.
              </p>
            </div>

            <div className="rise rise-d2 flex flex-wrap items-center gap-2.5">
              <StatusPill label="matched" value={formatNum(summary.matched)} tone="indigo" />
              <StatusPill label="cron jobs" value={formatNum(cronSummary.jobs)} tone="emerald" />
              <StatusPill label="errors" value={formatNum(summary.errors)} tone={summary.errors > 0 ? 'rose' : 'slate'} />
              {sourceName && (
                <span className="rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-[11px] font-semibold text-slate-200 backdrop-blur">
                  📄 {sourceName}
                </span>
              )}
            </div>
          </div>

          <div className="hairline my-7" />

          {/* Ticker strip */}
          <div className="rise rise-d3 flex items-center gap-4">
            <div className="flex shrink-0 items-center gap-2 rounded-md border border-rose-400/30 bg-rose-500/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.2em] text-rose-200">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-rose-400" /> slowest live
            </div>
            <div className="ticker-mask relative flex-1 overflow-hidden">
              <div className="ticker-track">
                {[...tickerItems, ...tickerItems].map((r, i) => (
                  <span key={i} className="inline-flex items-center gap-2 rounded-md border border-white/10 bg-white/5 px-3 py-1.5 font-mono-data text-[11px] text-slate-200">
                    <span className={r.method === 'GET' ? 'text-sky-300' : r.method === 'POST' ? 'text-emerald-300' : 'text-amber-300'}>{r.method}</span>
                    <span className="max-w-[40ch] truncate text-slate-300">{r.path}</span>
                    <span className="font-bold text-rose-300">p95 {formatMs(r.p95Ms)}</span>
                  </span>
                ))}
                {tickerItems.length === 0 && (
                  <span className="font-mono-data text-[11px] text-slate-400">paste logs to populate the live ticker…</span>
                )}
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="mx-auto max-w-7xl space-y-10 px-5 py-10 sm:px-8">

        {/* Uploader */}
        <section className="rise">
          <FileDrop
            onText={(t, meta) => {
              setLogText(t); setSourceName(meta?.name || 'uploaded file')
              showToast(`Loaded ${meta?.name || 'log file'}`)
            }}
          />
        </section>

        {/* Paste + KPI */}
        <section className="grid gap-5 lg:grid-cols-5">
          <div ref={revealKpi} className="reveal lift rounded-2xl border border-slate-200 bg-white p-5 shadow-sm lg:col-span-3">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-baseline gap-3">
                <h2 className="font-display text-lg font-semibold text-slate-900">Paste logs</h2>
                {logText && <span className="rounded-md bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-700 ring-1 ring-emerald-200">auto-saved</span>}
              </div>
              <div className="flex items-center gap-2">
                <button className="press rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-40" onClick={handleClearAll} disabled={!logText}>Clear all</button>
                <button className="press rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40" onClick={async () => { await navigator.clipboard.writeText(logText); showToast('Raw logs copied') }} disabled={!logText}>Copy</button>
              </div>
            </div>
            <textarea
              className="nice-scroll h-72 w-full resize-y rounded-xl border border-slate-200 bg-slate-50/70 p-4 font-mono-data text-[12px] leading-6 text-slate-800"
              placeholder={"Paste PM2 HTTP lines and [cron] lines together — both analyzers read from this single box.\n\nExamples:\n2026-03-05 09:04:16: POST /api/admin/user/getuserbyrole 200 6142.566 ms - -\n2026-07-24T10:22:30: [cron] done broker ocr processing 14412ms"}
              value={logText}
              onChange={(e) => { setLogText(e.target.value); if (!sourceName) setSourceName('pasted logs') }}
            />
            <p className="mt-2 text-[11px] text-slate-500">
              Tip: on the server run <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono-data text-[10px] text-slate-700">grep -E "\[cron\] (start|done|fail)" api-out.log</code> and paste alongside your HTTP logs.
            </p>
          </div>

          {/* KPI tiles */}
          <div className="grid grid-cols-2 gap-3 lg:col-span-2">
            <KpiTile label="Requests parsed" value={formatNum(Math.round(cuRequests))} accent="indigo" sub={`${summary.unmatched} lines skipped`} />
            <KpiTile label="Avg latency" value={formatMs(cuAvg)} accent="sky" sub={`max ${formatMs(cuMax)}`} />
            <KpiTile label="Errors (≥400)" value={formatNum(Math.round(cuErrors))} accent={summary.errors > 0 ? 'rose' : 'slate'} sub={`${summary.slow} calls ≥ 3s`} />
            <KpiTile label="Cron jobs" value={formatNum(Math.round(cuCronJobs))} accent="emerald" sub={`${formatNum(Math.round(cuCronFails))} failures`} />
          </div>
        </section>

        {/* ===== SECTION 01 — API ===== */}
        <section id="api" ref={revealApi} className="reveal scroll-mt-6">
          <SectionHeader num="01" kicker="HTTP latency" title="Slow API Endpoints" accent="indigo" />

          <div className="grid gap-5 lg:grid-cols-5">
            {/* Filters */}
            <div className="lift rounded-2xl border border-slate-200 bg-white p-5 shadow-sm lg:col-span-2">
              <h3 className="font-display text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">Filters</h3>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <Field label="Normalize URLs">
                  <select className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium" value={normalizeMode} onChange={(e) => setNormalizeMode(e.target.value as NormalizeMode)}>
                    <option value="collapseIds">Collapse IDs (recommended)</option>
                    <option value="stripQuery">Strip query string</option>
                    <option value="exact">Exact (keep IDs + query)</option>
                  </select>
                </Field>
                <Field label="HTTP Status">
                  <select className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium" value={statusFamily} onChange={(e) => setStatusFamily(e.target.value as any)}>
                    <option value="all">All</option><option value="2xx">2xx</option><option value="3xx">3xx</option><option value="4xx">4xx</option><option value="5xx">5xx</option>
                  </select>
                </Field>
                <Field label="Min duration (ms)">
                  <input type="number" min={0} className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm" value={minMs} onChange={(e) => setMinMs(Math.max(0, Number(e.target.value || 0)))} />
                </Field>
                <Field label="Top N">
                  <input type="number" min={1} max={500} className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm" value={topN} onChange={(e) => setTopN(Math.min(500, Math.max(1, Number(e.target.value || 20))))} />
                </Field>
                <Field label="Search endpoint" className="sm:col-span-2">
                  <input className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm" placeholder="/api/admin/motor" value={query} onChange={(e) => setQuery(e.target.value)} />
                </Field>
              </div>

              <div className="mt-4">
                <div className="flex items-center justify-between">
                  <h4 className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500">Methods</h4>
                  <div className="flex gap-1">
                    <button className="press rounded border border-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-600 hover:bg-slate-50" onClick={selectAllMethods}>All</button>
                    <button className="press rounded border border-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-600 hover:bg-slate-50" onClick={clearMethods}>None</button>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {Array.from(methodSet).sort().map((m) => {
                    const on = (methodFilter ?? methodSet).has(m)
                    return (
                      <button key={m} onClick={() => toggleMethod(m)}
                        className={'press rounded-full border px-3 py-1 text-xs font-semibold transition ' + (on ? 'border-indigo-300 bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200' : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50')}>
                        {m}
                      </button>
                    )
                  })}
                  {methodSet.size === 0 && <span className="text-xs text-slate-400">No methods detected yet.</span>}
                </div>
              </div>

              <div className="mt-4 border-t border-slate-100 pt-4">
                <h4 className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500">Rank by</h4>
                <div className="mt-2 grid grid-cols-3 gap-1.5">
                  {([['p95Ms', 'p95'], ['p99Ms', 'p99'], ['avgMs', 'avg'], ['maxMs', 'max'], ['count', 'count'], ['errorCount', 'errors']] as [SortKey, string][]).map(([k, l]) => (
                    <button key={k} onClick={() => setSortKey(k)}
                      className={'press rounded-md px-2 py-1.5 text-xs font-semibold transition ' + (sortKey === k ? 'bg-slate-900 text-white shadow-sm' : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50')}>
                      {l}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Table + chart */}
            <div className="space-y-5 lg:col-span-3">
              <div className="lift overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-gradient-to-r from-white to-slate-50/60 px-5 py-3.5">
                  <div>
                    <h3 className="font-display text-base font-semibold text-slate-900">Top {topN} by {sortKey}</h3>
                    <p className="text-[11px] text-slate-500">{rows.length} endpoints match current filters</p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button onClick={handleDownloadExcel} className="press inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-emerald-500">
                      <span>⬇</span> Excel (2 tabs)
                    </button>
                    <button onClick={copyApiForExcel} disabled={topRows.length === 0} className="press rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40">Copy for Excel</button>
                  </div>
                </div>
                <div className="nice-scroll overflow-x-auto">
                  <table className="min-w-full text-left text-xs">
                    <thead className="bg-slate-50 font-semibold text-slate-600">
                      <tr>
                        <Th>Endpoint</Th><Th r>Count</Th><Th r>Avg</Th><Th r>p95</Th><Th r>p99</Th><Th r>Max</Th><Th r>Errors</Th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {topRows.map((r) => (
                        <tr key={r.key} className="row-accent">
                          <td className="max-w-[22rem] px-3 py-2.5">
                            <div className="flex items-center gap-2">
                              <MethodBadge m={r.method} />
                              <span className="truncate font-mono-data text-[11px] text-slate-800" title={r.path}>{r.path}</span>
                            </div>
                          </td>
                          <Td r>{formatNum(r.count)}</Td>
                          <Td r>{formatMs(r.avgMs)}</Td>
                          <Td r strong tone="indigo">{formatMs(r.p95Ms)}</Td>
                          <Td r>{formatMs(r.p99Ms)}</Td>
                          <Td r strong tone="amber">{formatMs(r.maxMs)}</Td>
                          <Td r tone={r.errorCount > 0 ? 'rose' : 'muted'} strong={r.errorCount > 0}>{formatNum(r.errorCount)}</Td>
                        </tr>
                      ))}
                      {topRows.length === 0 && (
                        <tr><td colSpan={7} className="px-3 py-10 text-center text-sm text-slate-400">Paste logs above to see your slowest APIs here.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="lift rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="font-display text-sm font-semibold text-slate-900">Latency distribution — p95</h3>
                  <span className="font-mono-data text-[10px] uppercase tracking-wider text-slate-400">top {topN}</span>
                </div>
                <div className="h-80">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData} layout="vertical" margin={{ top: 4, right: 18, bottom: 4, left: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#eef2ff" />
                      <XAxis type="number" tickFormatter={(v) => `${v}ms`} tick={{ fontSize: 10, fill: '#64748b' }} />
                      <YAxis type="category" dataKey="name" width={170} tick={{ fontSize: 10, fill: '#334155' }} tickFormatter={(v) => { const s = String(v); return s.length > 26 ? s.slice(0, 26) + '…' : s }} />
                      <Tooltip cursor={{ fill: 'rgba(99,102,241,0.06)' }} formatter={(v: any, n: any) => n === 'count' ? [formatNum(Number(v)), 'count'] : [formatMs(Number(v)), n]} />
                      <Bar dataKey="p95Ms" radius={[4, 4, 4, 4]}>
                        {chartData.map((_, i) => <Cell key={i} fill={i % 2 === 0 ? '#4f46e5' : '#6366f1'} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ===== SECTION 02 — CRON ===== */}
        <section id="cron" ref={revealCron} className="reveal scroll-mt-6">
          <SectionHeader num="02" kicker="Scheduled work" title="Cron Job Durations" accent="emerald" />

          <div className="grid gap-5 lg:grid-cols-5">
            <div className="lift rounded-2xl border border-slate-200 bg-white p-5 shadow-sm lg:col-span-2">
              <h3 className="font-display text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">Cron filters</h3>
              <div className="mt-4 grid gap-3">
                <Field label="Search cron name">
                  <input className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm" placeholder="export-motor-policy-csv" value={cronQuery} onChange={(e) => setCronQuery(e.target.value)} />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Min duration (ms)">
                    <input type="number" min={0} className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm" value={cronMinMs} onChange={(e) => setCronMinMs(Math.max(0, Number(e.target.value || 0)))} />
                  </Field>
                  <Field label="&nbsp;">
                    <label className="flex h-[38px] cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50">
                      <input type="checkbox" className="h-4 w-4 accent-rose-600" checked={cronShowFailedOnly} onChange={(e) => setCronShowFailedOnly(e.target.checked)} />
                      Failures only
                    </label>
                  </Field>
                </div>
              </div>
              <div className="mt-4 border-t border-slate-100 pt-4">
                <h4 className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500">Rank by</h4>
                <div className="mt-2 grid grid-cols-3 gap-1.5">
                  {([['p95Ms', 'p95'], ['p99Ms', 'p99'], ['avgMs', 'avg'], ['maxMs', 'max'], ['runs', 'runs'], ['fails', 'fails']] as [CronSortKey, string][]).map(([k, l]) => (
                    <button key={k} onClick={() => setCronSortKey(k)} className={'press rounded-md px-2 py-1.5 text-xs font-semibold transition ' + (cronSortKey === k ? 'bg-slate-900 text-white shadow-sm' : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50')}>{l}</button>
                  ))}
                </div>
              </div>

              {/* mini stats */}
              <div className="mt-5 grid grid-cols-3 gap-2">
                <MiniStat label="starts" value={formatNum(cronSummary.starts)} tone="slate" />
                <MiniStat label="dones" value={formatNum(cronSummary.dones)} tone="emerald" />
                <MiniStat label="fails" value={formatNum(cronSummary.fails)} tone={cronSummary.fails > 0 ? 'rose' : 'slate'} />
              </div>
              <div className="mt-3">
                <div className="mb-1 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  <span>slowest single run</span><span className="font-mono-data text-slate-700">{formatMs(cronSummary.slowestRun)}</span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                  <div className="lat-bar h-full" style={{ width: '100%' }} />
                </div>
              </div>
            </div>

            <div className="lift overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm lg:col-span-3">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-gradient-to-r from-white to-emerald-50/40 px-5 py-3.5">
                <div>
                  <h3 className="font-display text-base font-semibold text-slate-900">{cronRows.length} cron job{cronRows.length === 1 ? '' : 's'}</h3>
                  <p className="text-[11px] text-slate-500">Duration percentiles from <code className="font-mono-data">[cron] done … ms</code> lines</p>
                </div>
                <div className="flex items-center gap-1.5">
                  <button onClick={handleDownloadExcel} className="press inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-emerald-500"><span>⬇</span> Excel (2 tabs)</button>
                  <button onClick={copyCronForExcel} disabled={cronRows.length === 0} className="press rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40">Copy for Excel</button>
                </div>
              </div>
              <div className="nice-scroll overflow-x-auto">
                <table className="min-w-full text-left text-xs">
                  <thead className="bg-slate-50 font-semibold text-slate-600">
                    <tr>
                      <Th>Cron Job</Th><Th r>Runs</Th><Th r>Starts</Th><Th r>Fails</Th><Th r>Avg</Th><Th r>p95</Th><Th r>p99</Th><Th r>Max</Th><Th r>Min</Th><Th r>Last</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {cronRows.map((r) => (
                      <tr key={r.name} className="row-accent">
                        <td className="max-w-[18rem] px-3 py-2.5 font-mono-data text-[11px] text-slate-800" title={r.name}>{r.name}</td>
                        <Td r>{formatNum(r.runs)}</Td>
                        <Td r muted>{formatNum(r.starts)}</Td>
                        <Td r tone={r.fails > 0 ? 'rose' : 'muted'} strong={r.fails > 0}>{formatNum(r.fails)}</Td>
                        <Td r>{formatMs(r.avgMs)}</Td>
                        <Td r strong tone="indigo">{formatMs(r.p95Ms)}</Td>
                        <Td r>{formatMs(r.p99Ms)}</Td>
                        <Td r strong tone="amber">{formatMs(r.maxMs)}</Td>
                        <Td r muted>{formatMs(r.minMs)}</Td>
                        <Td r>{r.lastDurationMs !== undefined ? formatMs(r.lastDurationMs) : '-'}</Td>
                      </tr>
                    ))}
                    {cronRows.length === 0 && (
                      <tr><td colSpan={10} className="px-3 py-10 text-center text-sm text-slate-400">Paste lines containing <code className="font-mono-data">[cron] start|done|fail</code> to populate this table.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </section>

        {/* Skipped lines */}
        <section className="lift rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <h3 className="font-display text-sm font-semibold text-slate-900">Skipped non-HTTP lines <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-600">{analyzed.unmatched.length}</span></h3>
          </div>
          <div className="nice-scroll mt-3 max-h-40 overflow-auto rounded-xl border border-slate-200 bg-slate-50/70 p-3 font-mono-data text-[11px] leading-5 text-slate-700">
            {analyzed.unmatched.slice(0, 40).map((l, i) => <div key={i} className="whitespace-pre-wrap">{l.raw}</div>)}
            {analyzed.unmatched.length === 0 && <div className="text-slate-400">None — every line parsed.</div>}
            {analyzed.unmatched.length > 40 && <div className="mt-2 text-slate-500">…and {formatNum(analyzed.unmatched.length - 40)} more</div>}
          </div>
        </section>

        <footer className="pb-14 pt-2 text-center">
          <div className="mx-auto mb-3 h-px w-24 bg-gradient-to-r from-transparent via-slate-300 to-transparent" />
          <p className="font-display text-xs uppercase tracking-[0.3em] text-slate-400">PM2 · Log · Analyzer</p>
          <p className="mt-1 text-[11px] text-slate-400">Runs 100% in your browser · LocalStorage persistence · single-file Excel export</p>
        </footer>
      </main>
    </div>
  )
}

export default App

/* ----------------------------- small UI bits ----------------------------- */

function StatusPill({ label, value, tone }: { label: string; value: string; tone: 'indigo' | 'emerald' | 'rose' | 'slate' }) {
  const map = {
    indigo: 'border-indigo-300/30 bg-indigo-400/10 text-indigo-100',
    emerald: 'border-emerald-300/30 bg-emerald-400/10 text-emerald-100',
    rose: 'border-rose-300/30 bg-rose-400/10 text-rose-100',
    slate: 'border-white/15 bg-white/5 text-slate-200',
  } as const
  return (
    <span className={`inline-flex items-baseline gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-semibold backdrop-blur ${map[tone]}`}>
      <span className="font-mono-data text-sm font-bold text-white">{value}</span>
      <span className="uppercase tracking-wider opacity-80">{label}</span>
    </span>
  )
}

function KpiTile({ label, value, sub, accent }: { label: string; value: string; sub: string; accent: 'indigo' | 'sky' | 'rose' | 'emerald' | 'slate' }) {
  const bar = { indigo: 'from-indigo-500 to-violet-500', sky: 'from-sky-500 to-cyan-500', rose: 'from-rose-500 to-pink-500', emerald: 'from-emerald-500 to-teal-500', slate: 'from-slate-400 to-slate-500' }[accent]
  return (
    <div className="lift relative overflow-hidden rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className={`absolute left-0 top-0 h-full w-1 bg-gradient-to-b ${bar}`} />
      <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">{label}</div>
      <div className="mt-1 font-display text-2xl font-bold tracking-tight text-slate-900 tabular-nums">{value}</div>
      <div className="mt-0.5 text-[11px] text-slate-500">{sub}</div>
    </div>
  )
}

function MiniStat({ label, value, tone }: { label: string; value: string; tone: 'slate' | 'emerald' | 'rose' }) {
  const color = tone === 'emerald' ? 'text-emerald-700 bg-emerald-50 ring-emerald-200' : tone === 'rose' ? 'text-rose-700 bg-rose-50 ring-rose-200' : 'text-slate-700 bg-slate-50 ring-slate-200'
  return (
    <div className={`rounded-lg px-2.5 py-2 text-center ring-1 ${color}`}>
      <div className="font-mono-data text-base font-bold tabular-nums">{value}</div>
      <div className="text-[9px] font-bold uppercase tracking-wider opacity-70">{label}</div>
    </div>
  )
}

function SectionHeader({ num, kicker, title, accent }: { num: string; kicker: string; title: string; accent: 'indigo' | 'emerald' }) {
  const ring = accent === 'indigo' ? 'ring-indigo-200 bg-indigo-50 text-indigo-700' : 'ring-emerald-200 bg-emerald-50 text-emerald-700'
  const rule = accent === 'indigo' ? 'from-indigo-400' : 'from-emerald-400'
  return (
    <div className="mb-5 flex items-end gap-5">
      <div className="ghost-num text-6xl sm:text-7xl">{num}</div>
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <span className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.2em] ring-1 ${ring}`}>{kicker}</span>
          <div className={`h-px flex-1 bg-gradient-to-r ${rule} to-transparent`} />
        </div>
        <h2 className="mt-1.5 font-display text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">{title}</h2>
      </div>
    </div>
  )
}

function Field({ label, children, className = '' }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <div className="mb-1 text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500">{label}</div>
      {children}
    </label>
  )
}

function Th({ children, r }: { children: React.ReactNode; r?: boolean }) {
  return <th className={`px-3 py-2.5 ${r ? 'text-right' : ''}`}>{children}</th>
}
function Td({ children, r, strong, tone, muted }: { children: React.ReactNode; r?: boolean; strong?: boolean; tone?: 'indigo' | 'amber' | 'rose' | 'muted'; muted?: boolean; }) {
  const color = tone === 'indigo' ? 'text-indigo-600' : tone === 'amber' ? 'text-amber-700' : tone === 'rose' ? 'text-rose-600' : tone === 'muted' || muted ? 'text-slate-400' : 'text-slate-700'
  return <td className={`px-3 py-2.5 tabular-nums ${r ? 'text-right' : ''} ${strong ? 'font-semibold' : ''} ${color}`}>{children}</td>
}
function MethodBadge({ m }: { m: string }) {
  const cls = m === 'GET' ? 'bg-sky-50 text-sky-700 ring-sky-200' : m === 'POST' ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : m === 'DELETE' ? 'bg-rose-50 text-rose-700 ring-rose-200' : 'bg-amber-50 text-amber-700 ring-amber-200'
  return <span className={`inline-block shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ring-1 ${cls}`}>{m}</span>
}
