import type { AggregatedEndpoint, CronAggregated } from "../parser";
import { formatMs, formatNum } from "./format";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function methodStyle(method: string): string {
  if (method === "GET") return "sMethodGet";
  if (method === "POST") return "sMethodPost";
  return "sMethodOther";
}

const STYLES = `
    <Style ss:ID="Default" ss:Name="Normal"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Size="14"/></Style>
    <Style ss:ID="sTitle"><Alignment ss:Horizontal="Left" ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Size="20" ss:Bold="1" ss:Color="#0F172A"/></Style>
    <Style ss:ID="sMeta"><Alignment ss:Horizontal="Left" ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Size="12" ss:Color="#475569"/></Style>
    <Style ss:ID="sSpacer"><Font ss:Size="6"/></Style>
    <Style ss:ID="sHeader"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Size="15" ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#2563EB" ss:Pattern="Solid"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#1D4ED8"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#1D4ED8"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#1D4ED8"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#1D4ED8"/></Borders></Style>
    <Style ss:ID="sDataCell"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Size="14"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/></Borders></Style>
    <Style ss:ID="sEndpointCell"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="Consolas" ss:Size="14"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/></Borders></Style>
    <Style ss:ID="sP95Cell"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Size="14" ss:Bold="1" ss:Color="#2563EB"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/></Borders></Style>
    <Style ss:ID="sMaxCell"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Size="14" ss:Bold="1" ss:Color="#D97706"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/></Borders></Style>
    <Style ss:ID="sMinCell"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Size="14" ss:Color="#64748B"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/></Borders></Style>
    <Style ss:ID="sErrorCell"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Size="14" ss:Bold="1" ss:Color="#DC2626"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/></Borders></Style>
    <Style ss:ID="sMethodGet"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Size="14" ss:Bold="1" ss:Color="#1E40AF"/><Interior ss:Color="#DBEAFE" ss:Pattern="Solid"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/></Borders></Style>
    <Style ss:ID="sMethodPost"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Size="14" ss:Bold="1" ss:Color="#065F46"/><Interior ss:Color="#D1FAE5" ss:Pattern="Solid"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/></Borders></Style>
    <Style ss:ID="sMethodOther"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Size="14" ss:Bold="1" ss:Color="#92400E"/><Interior ss:Color="#FEF3C7" ss:Pattern="Solid"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/></Borders></Style>`;

export function buildApiTsv(rows: AggregatedEndpoint[]): string {
  const h = ["Method", "Endpoint", "Count", "Avg", "p95", "p99", "Max", "Min", "Errors"];
  return [
    h.join("\t"),
    ...rows.map((r) =>
      [
        r.method,
        r.path,
        formatNum(r.count),
        formatMs(r.avgMs),
        formatMs(r.p95Ms),
        formatMs(r.p99Ms),
        formatMs(r.maxMs),
        formatMs(r.minMs),
        formatNum(r.errorCount),
      ].join("\t"),
    ),
  ].join("\r\n");
}

export function buildCronTsv(rows: CronAggregated[]): string {
  const h = [
    "Cron Job",
    "Runs",
    "Starts",
    "Fails",
    "Avg",
    "p95",
    "p99",
    "Max",
    "Min",
    "Last Run",
    "Last Duration",
  ];
  return [
    h.join("\t"),
    ...rows.map((r) =>
      [
        r.name,
        formatNum(r.runs),
        formatNum(r.starts),
        formatNum(r.fails),
        formatMs(r.avgMs),
        formatMs(r.p95Ms),
        formatMs(r.p99Ms),
        formatMs(r.maxMs),
        formatMs(r.minMs),
        r.lastRunTs ?? "-",
        r.lastDurationMs !== undefined ? formatMs(r.lastDurationMs) : "-",
      ].join("\t"),
    ),
  ].join("\r\n");
}

export function downloadExcel(apiRows: AggregatedEndpoint[], cronRows: CronAggregated[]): void {
  const generated = new Date().toLocaleString();
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

  const apiHeaders = ["Method", "Endpoint", "Count", "Avg", "p95", "p99", "Max", "Min", "Errors"];
  const apiHeaderRow = `<Row ss:StyleID="sHeader">${apiHeaders.map((h) => `<Cell><Data ss:Type="String">${esc(h)}</Data></Cell>`).join("")}</Row>`;
  const apiBodyRows = apiRows
    .map((r) => {
      const ms = methodStyle(r.method);
      const es = r.errorCount > 0 ? "sErrorCell" : "sDataCell";
      return `<Row>
        <Cell ss:StyleID="${ms}"><Data ss:Type="String">${esc(r.method)}</Data></Cell>
        <Cell ss:StyleID="sEndpointCell"><Data ss:Type="String">${esc(r.path)}</Data></Cell>
        <Cell ss:StyleID="sDataCell"><Data ss:Type="String">${esc(formatNum(r.count))}</Data></Cell>
        <Cell ss:StyleID="sDataCell"><Data ss:Type="String">${esc(formatMs(r.avgMs))}</Data></Cell>
        <Cell ss:StyleID="sP95Cell"><Data ss:Type="String">${esc(formatMs(r.p95Ms))}</Data></Cell>
        <Cell ss:StyleID="sDataCell"><Data ss:Type="String">${esc(formatMs(r.p99Ms))}</Data></Cell>
        <Cell ss:StyleID="sMaxCell"><Data ss:Type="String">${esc(formatMs(r.maxMs))}</Data></Cell>
        <Cell ss:StyleID="sMinCell"><Data ss:Type="String">${esc(formatMs(r.minMs))}</Data></Cell>
        <Cell ss:StyleID="${es}"><Data ss:Type="String">${esc(formatNum(r.errorCount))}</Data></Cell>
      </Row>`;
    })
    .join("");

  let cronSheet = "";
  if (cronRows.length > 0) {
    const cronHeaders = [
      "Cron Job",
      "Runs",
      "Starts",
      "Fails",
      "Avg",
      "p95",
      "p99",
      "Max",
      "Min",
      "Last Run",
      "Last Duration",
    ];
    const cronHeaderRow = `<Row ss:StyleID="sHeader">${cronHeaders.map((h) => `<Cell><Data ss:Type="String">${esc(h)}</Data></Cell>`).join("")}</Row>`;
    const cronBodyRows = cronRows
      .map((r) => {
        const fs = r.fails > 0 ? "sErrorCell" : "sDataCell";
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
        <Cell ss:StyleID="sDataCell"><Data ss:Type="String">${esc(r.lastRunTs ?? "-")}</Data></Cell>
        <Cell ss:StyleID="sDataCell"><Data ss:Type="String">${esc(r.lastDurationMs !== undefined ? formatMs(r.lastDurationMs) : "-")}</Data></Cell>
      </Row>`;
      })
      .join("");
    cronSheet = `
  <Worksheet ss:Name="Cron Jobs">
    <Table>
      <Column ss:Width="340"/><Column ss:Width="72"/><Column ss:Width="72"/><Column ss:Width="72"/>
      <Column ss:Width="92"/><Column ss:Width="92"/><Column ss:Width="92"/><Column ss:Width="92"/><Column ss:Width="92"/>
      <Column ss:Width="170"/><Column ss:Width="120"/>
      <Row ss:Height="32"><Cell ss:StyleID="sTitle" ss:MergeAcross="10"><Data ss:Type="String">PM2 Log Analyzer — Cron Jobs</Data></Cell></Row>
      <Row ss:Height="20"><Cell ss:StyleID="sMeta" ss:MergeAcross="10"><Data ss:Type="String">${esc(`Generated: ${generated}  |  Jobs: ${cronRows.length}`)}</Data></Cell></Row>
      <Row ss:Height="8"><Cell ss:StyleID="sSpacer"/></Row>
      ${cronHeaderRow}
      ${cronBodyRows}
    </Table>
  </Worksheet>`;
  }

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
  <Styles>${STYLES}</Styles>
  <Worksheet ss:Name="API Endpoints">
    <Table>
      <Column ss:Width="80"/><Column ss:Width="420"/><Column ss:Width="72"/><Column ss:Width="82"/>
      <Column ss:Width="82"/><Column ss:Width="82"/><Column ss:Width="82"/><Column ss:Width="82"/><Column ss:Width="72"/>
      <Row ss:Height="32"><Cell ss:StyleID="sTitle" ss:MergeAcross="8"><Data ss:Type="String">PM2 Log Analyzer — API Endpoints</Data></Cell></Row>
      <Row ss:Height="20"><Cell ss:StyleID="sMeta" ss:MergeAcross="8"><Data ss:Type="String">${esc(`Generated: ${generated}  |  Endpoints: ${apiRows.length}`)}</Data></Cell></Row>
      <Row ss:Height="8"><Cell ss:StyleID="sSpacer"/></Row>
      ${apiHeaderRow}
      ${apiBodyRows}
    </Table>
  </Worksheet>${cronSheet}
</Workbook>`;

  const blob = new Blob([xml], { type: "application/vnd.ms-excel;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `pm2-analyzer-report-${ts}.xls`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
