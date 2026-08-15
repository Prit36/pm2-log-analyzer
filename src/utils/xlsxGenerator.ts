import { zipSync, strToU8 } from "fflate";
import type {
  AggregatedEndpoint,
  CronAggregated,
  DaySummary,
  HourlyBucket,
  LogSummary,
} from "../parser";
import type { ApiSortKey, CronSortKey } from "../store/analysisStore";
import { formatDate, formatMs, formatNum } from "./format";
import { generateAllChartImages, type ChartTheme } from "./chartRenderer";

const TABLE_HEADER_ROW = 4;

const API_SORT_LABEL = {
  p95Ms: "p95",
  p99Ms: "p99",
  avgMs: "avg",
  maxMs: "max",
  count: "count",
  errorCount: "errors",
  path: "endpoint",
} satisfies Record<ApiSortKey, string>;

const CRON_SORT_LABEL = {
  p95Ms: "p95",
  p99Ms: "p99",
  avgMs: "avg",
  maxMs: "max",
  runs: "runs",
  fails: "fails",
  starts: "starts",
  lastDurationMs: "last duration",
  name: "job",
} satisfies Record<CronSortKey, string>;

function escapeXml(str: string | number | null | undefined): string {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function colToLetter(col1Based: number): string {
  let temp = col1Based;
  let letter = "";
  while (temp > 0) {
    const mod = (temp - 1) % 26;
    letter = String.fromCharCode(65 + mod) + letter;
    temp = Math.floor((temp - mod) / 26);
  }
  return letter;
}

class SharedStringsBuilder {
  private map = new Map<string, number>();
  public list: string[] = [];

  add(str: string | number | null | undefined): number {
    const s = str == null ? "" : String(str);
    let idx = this.map.get(s);
    if (idx === undefined) {
      idx = this.list.length;
      this.list.push(s);
      this.map.set(s, idx);
    }
    return idx;
  }

  toXml(): string {
    let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${this.list.length}" uniqueCount="${this.list.length}">`;
    for (const s of this.list) {
      xml += `<si><t>${escapeXml(s)}</t></si>`;
    }
    xml += "</sst>";
    return xml;
  }
}

function generateThemeXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme">
  <a:themeElements>
    <a:clrScheme name="Office">
      <a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
      <a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="1F497D"/></a:dk2>
      <a:lt2><a:srgbClr val="EEECE1"/></a:lt2>
      <a:accent1><a:srgbClr val="4F81BD"/></a:accent1>
      <a:accent2><a:srgbClr val="C0504D"/></a:accent2>
      <a:accent3><a:srgbClr val="9BBB59"/></a:accent3>
      <a:accent4><a:srgbClr val="8064A2"/></a:accent4>
      <a:accent5><a:srgbClr val="4BACC6"/></a:accent5>
      <a:accent6><a:srgbClr val="F79646"/></a:accent6>
      <a:hlink><a:srgbClr val="0000FF"/></a:hlink>
      <a:folHlink><a:srgbClr val="800080"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="Office">
      <a:majorFont>
        <a:latin typeface="Calibri"/>
        <a:ea typeface=""/>
        <a:cs typeface=""/>
      </a:majorFont>
      <a:minorFont>
        <a:latin typeface="Calibri"/>
        <a:ea typeface=""/>
        <a:cs typeface=""/>
      </a:minorFont>
    </a:fontScheme>
    <a:fmtScheme name="Office">
      <a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="50000"/><a:satMod val="300000"/></a:schemeClr></a:gs><a:gs pos="35000"><a:schemeClr val="phClr"><a:tint val="37000"/><a:satMod val="220000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:tint val="15000"/><a:satMod val="130000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="16200000"/></a:gradFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:shade val="51000"/><a:satMod val="130000"/></a:schemeClr></a:gs><a:gs pos="80000"><a:schemeClr val="phClr"><a:shade val="93000"/><a:satMod val="130000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="94000"/><a:satMod val="135000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="16200000"/></a:gradFill></a:fillStyleLst>
      <a:lnStyleLst><a:ln w="9525" cap="flat" cmpd="s" algn="ctr"><a:solidFill><a:schemeClr val="phClr"><a:shade val="95000"/><a:satMod val="105000"/></a:schemeClr></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="25400" cap="flat" cmpd="s" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="38100" cap="flat" cmpd="s" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln></a:lnStyleLst>
      <a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
      <a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="40000"/><a:satMod val="350000"/></a:schemeClr></a:gs><a:gs pos="40000"><a:schemeClr val="phClr"><a:tint val="45000"/><a:satMod val="350000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:tint val="20000"/><a:satMod val="255000"/></a:schemeClr></a:gs></a:gsLst><a:path path="circle"><a:fillToRect l="50000" t="-80000" r="50000" b="180000"/></a:path></a:gradFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="80000"/><a:satMod val="300000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="30000"/><a:satMod val="200000"/></a:schemeClr></a:gs></a:gsLst><a:path path="circle"><a:fillToRect l="50000" t="50000" r="50000" b="50000"/></a:path></a:gradFill></a:bgFillStyleLst>
    </a:fmtScheme>
  </a:themeElements>
</a:theme>`;
}

function generateStylesXml(theme: ChartTheme = "light"): string {
  const isDark = theme === "dark";

  // Palette definitions based on theme
  const normalColor = isDark ? "FFF1F5F9" : "FF000000";
  const titleColor = isDark ? "FFF8FAFC" : "FF0F172A";
  const subtitleColor = isDark ? "FF94A3B8" : "FF475569";
  const getBadgeFontColor = isDark ? "FF93C5FD" : "FF1E40AF";
  const getBadgeFillColor = isDark ? "FF1E3A8A" : "FFDBEAFE";
  const postBadgeFontColor = isDark ? "FF6EE7B7" : "FF065F46";
  const postBadgeFillColor = isDark ? "FF064E3B" : "FFD1FAE5";
  const otherBadgeFontColor = isDark ? "FFFDE68A" : "FF92400E";
  const otherBadgeFillColor = isDark ? "FF78350F" : "FFFEF3C7";
  const headerFontColor = "FFFFFFFF"; // Always clean crisp white on header fill
  const kpiValueColor = isDark ? "FFF8FAFC" : "FF0F172A";
  const endpointColor = isDark ? "FFF1F5F9" : "FF0F172A";
  const kpiHeaderFontColor = isDark ? "FF94A3B8" : "FF475569";
  const kpiHeaderFillColor = isDark ? "FF1E293B" : "FFF1F5F9";
  const totalRowColor = isDark ? "FFF8FAFC" : "FF0F172A";
  const errorFillColor = isDark ? "FF7F1D1D" : "FFFEE2E2";

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="1">
    <numFmt numFmtId="164" formatCode="#,##0.0&quot; ms&quot;"/>
  </numFmts>
  <fonts count="11">
    <!-- 0: Normal (${normalColor}, 11pt, Calibri) -->
    <font><sz val="11"/><color rgb="${normalColor}"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>
    <!-- 1: Title (${titleColor}, 16pt Bold, Calibri) -->
    <font><b/><sz val="16"/><color rgb="${titleColor}"/><name val="Calibri"/><family val="2"/><scheme val="major"/></font>
    <!-- 2: Subtitle (${subtitleColor}, 11pt Slate, Calibri) -->
    <font><sz val="11"/><color rgb="${subtitleColor}"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>
    <!-- 3: GET Badge Font (${getBadgeFontColor}, 11pt Bold, Calibri) -->
    <font><b/><sz val="11"/><color rgb="${getBadgeFontColor}"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>
    <!-- 4: POST Badge Font (${postBadgeFontColor}, 11pt Bold, Calibri) -->
    <font><b/><sz val="11"/><color rgb="${postBadgeFontColor}"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>
    <!-- 5: OTHER Badge Font (${otherBadgeFontColor}, 11pt Bold, Calibri) -->
    <font><b/><sz val="11"/><color rgb="${otherBadgeFontColor}"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>
    <!-- 6: Table Header Font (${headerFontColor}, 11pt Bold White, Calibri) -->
    <font><b/><sz val="11"/><color rgb="${headerFontColor}"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>
    <!-- 7: KPI Value Font (${kpiValueColor}, 12pt Bold, Calibri) -->
    <font><b/><sz val="12"/><color rgb="${kpiValueColor}"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>
    <!-- 8: Dark/Light Text / Endpoint Font (${endpointColor}, 11pt, Calibri) -->
    <font><sz val="11"/><color rgb="${endpointColor}"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>
    <!-- 9: KPI Header Font (${kpiHeaderFontColor}, 10pt Bold, Calibri) -->
    <font><b/><sz val="10"/><color rgb="${kpiHeaderFontColor}"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>
    <!-- 10: Total Row Font (${totalRowColor}, 11pt Bold, Calibri) -->
    <font><b/><sz val="11"/><color rgb="${totalRowColor}"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>
  </fonts>
  <fills count="7">
    <!-- 0: None -->
    <fill><patternFill patternType="none"/></fill>
    <!-- 1: Gray125 -->
    <fill><patternFill patternType="gray125"/></fill>
    <!-- 2: GET Badge Fill -->
    <fill><patternFill patternType="solid"><fgColor rgb="${getBadgeFillColor}"/></patternFill></fill>
    <!-- 3: POST Badge Fill -->
    <fill><patternFill patternType="solid"><fgColor rgb="${postBadgeFillColor}"/></patternFill></fill>
    <!-- 4: OTHER Badge Fill -->
    <fill><patternFill patternType="solid"><fgColor rgb="${otherBadgeFillColor}"/></patternFill></fill>
    <!-- 5: KPI Header Fill -->
    <fill><patternFill patternType="solid"><fgColor rgb="${kpiHeaderFillColor}"/></patternFill></fill>
    <!-- 6: Error count fill -->
    <fill><patternFill patternType="solid"><fgColor rgb="${errorFillColor}"/></patternFill></fill>
  </fills>
  <borders count="1">
    <border><left/><right/><top/><bottom/><diagonal/></border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" applyFont="1"/>
  </cellStyleXfs>
  <cellXfs count="13">
    <!-- 0: Default Normal Cell -->
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyFont="1"/>
    <!-- 1: Title (16pt Bold) -->
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
    <!-- 2: Subtitle (11pt Slate) -->
    <xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
    <!-- 3: GET badge -->
    <xf numFmtId="0" fontId="3" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <!-- 4: POST badge -->
    <xf numFmtId="0" fontId="4" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <!-- 5: OTHER badge -->
    <xf numFmtId="0" fontId="5" fillId="4" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <!-- 6: Milliseconds format (#,##0.0 ms) -->
    <xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/>
    <!-- 7: KPI Header -->
    <xf numFmtId="0" fontId="9" fillId="5" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <!-- 8: KPI Value -->
    <xf numFmtId="0" fontId="7" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <!-- 9: Dark/Light Endpoint / Text Cell (Calibri 11pt) -->
    <xf numFmtId="0" fontId="8" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
    <!-- 10: Table Header (11pt Bold White Calibri) -->
    <xf numFmtId="0" fontId="6" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
    <!-- 11: Number Cell (11pt Calibri) -->
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyFont="1"/>
    <!-- 12: Total Row Label (11pt Bold Calibri) -->
    <xf numFmtId="0" fontId="10" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
  </cellXfs>
  <cellStyles count="1">
    <cellStyle name="Normal" xfId="0" builtinId="0"/>
  </cellStyles>
  <dxfs count="1">
    <dxf>
      <font><b/><color rgb="FFDC2626"/><name val="Calibri"/><family val="2"/></font>
    </dxf>
  </dxfs>
</styleSheet>`;
}

function base64ToUint8(base64: string): Uint8Array {
  const clean = base64.replace(/^data:image\/\w+;base64,/, "");
  const bin = atob(clean);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    u8[i] = bin.charCodeAt(i);
  }
  return u8;
}

export async function buildExcelBlob(
  apiRows: AggregatedEndpoint[],
  cronRows: CronAggregated[],
  sort: { api: ApiSortKey; cron: CronSortKey },
  hourlyStats: HourlyBucket[] = [],
  summary?: LogSummary | null,
  dailyStats: DaySummary[] = [],
  dateFilter?: string | null,
  theme: ChartTheme = "light",
): Promise<Blob> {
  const generatedTime = new Date().toLocaleString();
  const dateMeta =
    dateFilter && dateFilter !== "all" ? `  |  Day Filter: ${formatDate(dateFilter)}` : "";

  const sst = new SharedStringsBuilder();
  const files: Record<string, Uint8Array> = {};

  const strCell = (r: string, s: number, val: string | number | null | undefined) =>
    `<c r="${r}" s="${s}" t="s"><v>${sst.add(val)}</v></c>`;

  const numCell = (r: string, s: number, val: number | string) =>
    `<c r="${r}" s="${s}"><v>${val}</v></c>`;

  const formulaCell = (r: string, s: number, formula: string, val: number | string) =>
    `<c r="${r}" s="${s}"><f>${formula}</f><v>${val}</v></c>`;

  const emptyCell = (r: string, s = 0) => `<c r="${r}" s="${s}"/>`;

  // Sheet definitions
  const sheets: Array<{ name: string; file: string; rId: string; tableFiles: string[] }> = [];

  // Sheet 1: API Endpoints
  sheets.push({
    name: "API Endpoints",
    file: "sheet1.xml",
    rId: "rId1",
    tableFiles: ["table1.xml"],
  });

  // Sheet 2: Daily Summary (if > 1 day)
  if (dailyStats.length > 1) {
    sheets.push({
      name: "Daily Summary",
      file: `sheet${sheets.length + 1}.xml`,
      rId: `rId${sheets.length + 1}`,
      tableFiles: [`table${sheets.length + 1}.xml`],
    });
  }

  // Sheet 3: Cron Jobs (if cronRows > 0)
  if (cronRows.length > 0) {
    sheets.push({
      name: "Cron Jobs",
      file: `sheet${sheets.length + 1}.xml`,
      rId: `rId${sheets.length + 1}`,
      tableFiles: [`table${sheets.length + 1}.xml`],
    });
  }

  // Sheet 4: Hourly & Distribution
  const hourlySheetIdx = sheets.length + 1;
  const hourlyTable1 = `table${sheets.length + 1}.xml`;
  const hourlyTable2 = `table${sheets.length + 2}.xml`;
  sheets.push({
    name: "Hourly & Distribution",
    file: `sheet${hourlySheetIdx}.xml`,
    rId: `rId${hourlySheetIdx}`,
    tableFiles: [hourlyTable1, hourlyTable2],
  });

  // Sheet 5: Visual Analytics
  const visualSheetIdx = sheets.length + 1;
  sheets.push({
    name: "Visual Analytics",
    file: `sheet${visualSheetIdx}.xml`,
    rId: `rId${visualSheetIdx}`,
    tableFiles: [],
  });

  // --- Helper for Sheet 1: API Endpoints ---
  {
    const sheetIdx = 1;
    const colWidths = [10, 48, 10, 12, 12, 12, 12, 12, 10];
    const lastCol = 9;
    const rowCount = apiRows.length;
    const tableEndRow = TABLE_HEADER_ROW + rowCount;
    const totalsRow = tableEndRow + 1;

    let sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheetViews>
    <sheetView tabSelected="1" workbookViewId="0">
      <pane ySplit="${TABLE_HEADER_ROW}" topLeftCell="A${TABLE_HEADER_ROW + 1}" activePane="bottomLeft" state="frozen"/>
    </sheetView>
  </sheetViews>
  <cols>`;
    colWidths.forEach((w, i) => {
      sheetXml += `\n    <col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`;
    });
    sheetXml += "\n  </cols>\n  <sheetData>";

    // Title Row 1
    sheetXml += `\n    <row r="1" ht="28" customHeight="1">${strCell("A1", 1, "PM2 Log Analyzer — API Endpoints")}</row>`;
    // Subtitle Row 2
    sheetXml += `\n    <row r="2" ht="18" customHeight="1">${strCell("A2", 2, `Generated: ${generatedTime}  |  Endpoints: ${rowCount}  |  Sorted by: ${API_SORT_LABEL[sort.api]} (desc)${dateMeta}`)}</row>`;
    // Row 3 Spacer
    sheetXml += `\n    <row r="3" ht="8" customHeight="1"/>`;

    // Row 4: Header
    const headers = ["Method", "Endpoint", "Count", "Avg", "p95", "p99", "Max", "Min", "Errors"];
    sheetXml += `\n    <row r="4">`;
    headers.forEach((h, i) => {
      sheetXml += strCell(`${colToLetter(i + 1)}4`, 10, h);
    });
    sheetXml += `</row>`;

    // Data rows
    let totalCount = 0;
    let totalErrors = 0;
    apiRows.forEach((r, idx) => {
      const rowNum = TABLE_HEADER_ROW + 1 + idx;
      totalCount += r.count;
      totalErrors += r.errorCount;
      const methodStyle = r.method === "GET" ? 3 : r.method === "POST" ? 4 : 5;

      sheetXml += `\n    <row r="${rowNum}">`;
      sheetXml += strCell(`A${rowNum}`, methodStyle, r.method);
      sheetXml += strCell(`B${rowNum}`, 9, r.path);
      sheetXml += numCell(`C${rowNum}`, 11, r.count);
      sheetXml += numCell(`D${rowNum}`, 6, r.avgMs.toFixed(1));
      sheetXml += numCell(`E${rowNum}`, 6, r.p95Ms.toFixed(1));
      sheetXml += numCell(`F${rowNum}`, 6, r.p99Ms.toFixed(1));
      sheetXml += numCell(`G${rowNum}`, 6, r.maxMs.toFixed(1));
      sheetXml += numCell(`H${rowNum}`, 6, r.minMs.toFixed(1));
      sheetXml += numCell(`I${rowNum}`, 11, r.errorCount);
      sheetXml += `</row>`;
    });

    // Totals Row
    sheetXml += `\n    <row r="${totalsRow}">`;
    sheetXml += strCell(`A${totalsRow}`, 12, "Total");
    sheetXml += emptyCell(`B${totalsRow}`, 0);
    sheetXml += formulaCell(`C${totalsRow}`, 11, "SUBTOTAL(109,ApiEndpoints[Count])", totalCount);
    sheetXml += emptyCell(`D${totalsRow}`, 0);
    sheetXml += emptyCell(`E${totalsRow}`, 0);
    sheetXml += emptyCell(`F${totalsRow}`, 0);
    sheetXml += emptyCell(`G${totalsRow}`, 0);
    sheetXml += emptyCell(`H${totalsRow}`, 0);
    sheetXml += formulaCell(`I${totalsRow}`, 11, "SUBTOTAL(109,ApiEndpoints[Errors])", totalErrors);
    sheetXml += `</row>`;

    sheetXml += "\n  </sheetData>";

    sheetXml += `\n  <mergeCells count="2">
    <mergeCell ref="A1:${colToLetter(lastCol)}1"/>
    <mergeCell ref="A2:${colToLetter(lastCol)}2"/>
  </mergeCells>`;

    if (rowCount > 0) {
      sheetXml += `\n  <conditionalFormatting sqref="I5:I${tableEndRow}">
    <cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan">
      <formula>0</formula>
    </cfRule>
  </conditionalFormatting>`;
    }

    sheetXml += `\n  <tableParts count="1"><tablePart r:id="rId1"/></tableParts>`;
    sheetXml += "\n</worksheet>";
    files[`xl/worksheets/sheet${sheetIdx}.xml`] = strToU8(sheetXml);

    const table1Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="ApiEndpoints" displayName="ApiEndpoints" ref="A4:I${totalsRow}" totalsRowCount="1">
  <autoFilter ref="A4:I${tableEndRow}"/>
  <tableColumns count="9">
    <tableColumn id="1" name="Method" totalsRowLabel="Total"/>
    <tableColumn id="2" name="Endpoint"/>
    <tableColumn id="3" name="Count" totalsRowFunction="sum"/>
    <tableColumn id="4" name="Avg"/>
    <tableColumn id="5" name="p95"/>
    <tableColumn id="6" name="p99"/>
    <tableColumn id="7" name="Max"/>
    <tableColumn id="8" name="Min"/>
    <tableColumn id="9" name="Errors" totalsRowFunction="sum"/>
  </tableColumns>
  <tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/>
</table>`;
    files["xl/tables/table1.xml"] = strToU8(table1Xml);

    files[`xl/worksheets/_rels/sheet${sheetIdx}.xml.rels`] =
      strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table1.xml"/>
</Relationships>`);
  }

  // --- Helper for Sheet 2: Daily Summary ---
  if (dailyStats.length > 1) {
    const sheetIdx = 2;
    const colWidths = [16, 14, 14, 14, 14, 14, 12, 14];
    const lastCol = 8;
    const rowCount = dailyStats.length;
    const tableEndRow = TABLE_HEADER_ROW + rowCount;
    const totalsRow = tableEndRow + 1;

    let sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheetViews>
    <sheetView tabSelected="0" workbookViewId="0">
      <pane ySplit="${TABLE_HEADER_ROW}" topLeftCell="A${TABLE_HEADER_ROW + 1}" activePane="bottomLeft" state="frozen"/>
    </sheetView>
  </sheetViews>
  <cols>`;
    colWidths.forEach((w, i) => {
      sheetXml += `\n    <col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`;
    });
    sheetXml += "\n  </cols>\n  <sheetData>";

    sheetXml += `\n    <row r="1" ht="28" customHeight="1">${strCell("A1", 1, "PM2 Log Analyzer — Daily Summary")}</row>`;
    sheetXml += `\n    <row r="2" ht="18" customHeight="1">${strCell("A2", 2, `Generated: ${generatedTime}  |  Days: ${rowCount}`)}</row>`;
    sheetXml += `\n    <row r="3" ht="8" customHeight="1"/>`;

    const headers = ["Date", "Requests", "Avg", "P95", "P99", "Max", "Errors", "Slow (≥3s)"];
    sheetXml += `\n    <row r="4">`;
    headers.forEach((h, i) => {
      sheetXml += strCell(`${colToLetter(i + 1)}4`, 10, h);
    });
    sheetXml += `</row>`;

    let totalRequests = 0;
    let totalErrors = 0;
    let totalSlow = 0;

    dailyStats.forEach((d, idx) => {
      const rowNum = TABLE_HEADER_ROW + 1 + idx;
      totalRequests += d.count;
      totalErrors += d.errorCount;
      totalSlow += d.slowCount;

      sheetXml += `\n    <row r="${rowNum}">`;
      sheetXml += strCell(`A${rowNum}`, 9, formatDate(d.date));
      sheetXml += numCell(`B${rowNum}`, 11, d.count);
      sheetXml += numCell(`C${rowNum}`, 6, d.avgMs.toFixed(1));
      sheetXml += numCell(`D${rowNum}`, 6, d.p95Ms.toFixed(1));
      sheetXml += numCell(`E${rowNum}`, 6, d.p99Ms.toFixed(1));
      sheetXml += numCell(`F${rowNum}`, 6, d.maxMs.toFixed(1));
      sheetXml += numCell(`G${rowNum}`, 11, d.errorCount);
      sheetXml += numCell(`H${rowNum}`, 11, d.slowCount);
      sheetXml += `</row>`;
    });

    // Totals Row
    sheetXml += `\n    <row r="${totalsRow}">`;
    sheetXml += strCell(`A${totalsRow}`, 12, "Total");
    sheetXml += formulaCell(
      `B${totalsRow}`,
      11,
      "SUBTOTAL(109,DailySummary[Requests])",
      totalRequests,
    );
    sheetXml += emptyCell(`C${totalsRow}`, 0);
    sheetXml += emptyCell(`D${totalsRow}`, 0);
    sheetXml += emptyCell(`E${totalsRow}`, 0);
    sheetXml += emptyCell(`F${totalsRow}`, 0);
    sheetXml += formulaCell(`G${totalsRow}`, 11, "SUBTOTAL(109,DailySummary[Errors])", totalErrors);
    sheetXml += formulaCell(
      `H${totalsRow}`,
      11,
      "SUBTOTAL(109,DailySummary[Slow (≥3s)])",
      totalSlow,
    );
    sheetXml += `</row>`;

    sheetXml += "\n  </sheetData>";
    sheetXml += `\n  <mergeCells count="2">
    <mergeCell ref="A1:${colToLetter(lastCol)}1"/>
    <mergeCell ref="A2:${colToLetter(lastCol)}2"/>
  </mergeCells>`;

    if (rowCount > 0) {
      sheetXml += `\n  <conditionalFormatting sqref="G5:G${tableEndRow}">
    <cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan">
      <formula>0</formula>
    </cfRule>
  </conditionalFormatting>`;
    }

    sheetXml += `\n  <tableParts count="1"><tablePart r:id="rId1"/></tableParts>`;
    sheetXml += "\n</worksheet>";
    files[`xl/worksheets/sheet${sheetIdx}.xml`] = strToU8(sheetXml);

    const table2Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="2" name="DailySummary" displayName="DailySummary" ref="A4:H${totalsRow}" totalsRowCount="1">
  <autoFilter ref="A4:H${tableEndRow}"/>
  <tableColumns count="8">
    <tableColumn id="1" name="Date" totalsRowLabel="Total"/>
    <tableColumn id="2" name="Requests" totalsRowFunction="sum"/>
    <tableColumn id="3" name="Avg"/>
    <tableColumn id="4" name="P95"/>
    <tableColumn id="5" name="P99"/>
    <tableColumn id="6" name="Max"/>
    <tableColumn id="7" name="Errors" totalsRowFunction="sum"/>
    <tableColumn id="8" name="Slow (≥3s)" totalsRowFunction="sum"/>
  </tableColumns>
  <tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/>
</table>`;
    files["xl/tables/table2.xml"] = strToU8(table2Xml);

    files[`xl/worksheets/_rels/sheet${sheetIdx}.xml.rels`] =
      strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table2.xml"/>
</Relationships>`);
  }

  // --- Helper for Sheet 3: Cron Jobs ---
  if (cronRows.length > 0) {
    const cronSheetIdx = dailyStats.length > 1 ? 3 : 2;
    const colWidths = [40, 10, 10, 10, 12, 12, 12, 12, 12, 22, 14];
    const lastCol = 11;
    const rowCount = cronRows.length;
    const tableEndRow = TABLE_HEADER_ROW + rowCount;
    const totalsRow = tableEndRow + 1;
    const tableId = cronSheetIdx;

    let sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheetViews>
    <sheetView tabSelected="0" workbookViewId="0">
      <pane ySplit="${TABLE_HEADER_ROW}" topLeftCell="A${TABLE_HEADER_ROW + 1}" activePane="bottomLeft" state="frozen"/>
    </sheetView>
  </sheetViews>
  <cols>`;
    colWidths.forEach((w, i) => {
      sheetXml += `\n    <col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`;
    });
    sheetXml += "\n  </cols>\n  <sheetData>";

    sheetXml += `\n    <row r="1" ht="28" customHeight="1">${strCell("A1", 1, "PM2 Log Analyzer — Cron Jobs")}</row>`;
    sheetXml += `\n    <row r="2" ht="18" customHeight="1">${strCell("A2", 2, `Generated: ${generatedTime}  |  Jobs: ${rowCount}  |  Sorted by: ${CRON_SORT_LABEL[sort.cron]} (desc)`)}</row>`;
    sheetXml += `\n    <row r="3" ht="8" customHeight="1"/>`;

    const headers = [
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
    sheetXml += `\n    <row r="4">`;
    headers.forEach((h, i) => {
      sheetXml += strCell(`${colToLetter(i + 1)}4`, 10, h);
    });
    sheetXml += `</row>`;

    let totalRuns = 0;
    let totalStarts = 0;
    let totalFails = 0;

    cronRows.forEach((r, idx) => {
      const rowNum = TABLE_HEADER_ROW + 1 + idx;
      totalRuns += r.runs;
      totalStarts += r.starts;
      totalFails += r.fails;

      sheetXml += `\n    <row r="${rowNum}">`;
      sheetXml += strCell(`A${rowNum}`, 9, r.name);
      sheetXml += numCell(`B${rowNum}`, 11, r.runs);
      sheetXml += numCell(`C${rowNum}`, 11, r.starts);
      sheetXml += numCell(`D${rowNum}`, 11, r.fails);
      sheetXml += numCell(`E${rowNum}`, 6, r.avgMs.toFixed(1));
      sheetXml += numCell(`F${rowNum}`, 6, r.p95Ms.toFixed(1));
      sheetXml += numCell(`G${rowNum}`, 6, r.p99Ms.toFixed(1));
      sheetXml += numCell(`H${rowNum}`, 6, r.maxMs.toFixed(1));
      sheetXml += numCell(`I${rowNum}`, 6, r.minMs.toFixed(1));
      sheetXml += strCell(`J${rowNum}`, 9, r.lastRunTs ?? "-");
      sheetXml +=
        r.lastDurationMs != null
          ? numCell(`K${rowNum}`, 6, r.lastDurationMs.toFixed(1))
          : strCell(`K${rowNum}`, 9, "-");
      sheetXml += `</row>`;
    });

    // Totals Row
    sheetXml += `\n    <row r="${totalsRow}">`;
    sheetXml += strCell(`A${totalsRow}`, 12, "Total");
    sheetXml += formulaCell(`B${totalsRow}`, 11, "SUBTOTAL(109,CronJobs[Runs])", totalRuns);
    sheetXml += formulaCell(`C${totalsRow}`, 11, "SUBTOTAL(109,CronJobs[Starts])", totalStarts);
    sheetXml += formulaCell(`D${totalsRow}`, 11, "SUBTOTAL(109,CronJobs[Fails])", totalFails);
    sheetXml += emptyCell(`E${totalsRow}`, 0);
    sheetXml += emptyCell(`F${totalsRow}`, 0);
    sheetXml += emptyCell(`G${totalsRow}`, 0);
    sheetXml += emptyCell(`H${totalsRow}`, 0);
    sheetXml += emptyCell(`I${totalsRow}`, 0);
    sheetXml += emptyCell(`J${totalsRow}`, 0);
    sheetXml += emptyCell(`K${totalsRow}`, 0);
    sheetXml += `</row>`;

    sheetXml += "\n  </sheetData>";
    sheetXml += `\n  <mergeCells count="2">
    <mergeCell ref="A1:${colToLetter(lastCol)}1"/>
    <mergeCell ref="A2:${colToLetter(lastCol)}2"/>
  </mergeCells>`;

    if (rowCount > 0) {
      sheetXml += `\n  <conditionalFormatting sqref="D5:D${tableEndRow}">
    <cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan">
      <formula>0</formula>
    </cfRule>
  </conditionalFormatting>`;
    }

    sheetXml += `\n  <tableParts count="1"><tablePart r:id="rId1"/></tableParts>`;
    sheetXml += "\n</worksheet>";
    files[`xl/worksheets/sheet${cronSheetIdx}.xml`] = strToU8(sheetXml);

    const cronTableXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="${tableId}" name="CronJobs" displayName="CronJobs" ref="A4:K${totalsRow}" totalsRowCount="1">
  <autoFilter ref="A4:K${tableEndRow}"/>
  <tableColumns count="11">
    <tableColumn id="1" name="Cron Job" totalsRowLabel="Total"/>
    <tableColumn id="2" name="Runs" totalsRowFunction="sum"/>
    <tableColumn id="3" name="Starts" totalsRowFunction="sum"/>
    <tableColumn id="4" name="Fails" totalsRowFunction="sum"/>
    <tableColumn id="5" name="Avg"/>
    <tableColumn id="6" name="p95"/>
    <tableColumn id="7" name="p99"/>
    <tableColumn id="8" name="Max"/>
    <tableColumn id="9" name="Min"/>
    <tableColumn id="10" name="Last Run"/>
    <tableColumn id="11" name="Last Duration"/>
  </tableColumns>
  <tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/>
</table>`;
    files[`xl/tables/table${tableId}.xml`] = strToU8(cronTableXml);

    files[`xl/worksheets/_rels/sheet${cronSheetIdx}.xml.rels`] =
      strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table${tableId}.xml"/>
</Relationships>`);
  }

  // --- Helper for Sheet 4: Hourly & Distribution Sheet ---
  {
    const sheetIdx = hourlySheetIdx;
    const colWidths = [15, 15, 15, 15, 15, 15, 6, 18, 18];
    const lastCol = 9;

    const buckets = [
      { label: "<50ms", count: 0 },
      { label: "50-100ms", count: 0 },
      { label: "100-300ms", count: 0 },
      { label: "300-500ms", count: 0 },
      { label: "500ms-1s", count: 0 },
      { label: "1s-3s", count: 0 },
      { label: ">3s", count: 0 },
    ];
    const classify = (ms: number) =>
      ms < 50 ? 0 : ms < 100 ? 1 : ms < 300 ? 2 : ms < 500 ? 3 : ms < 1000 ? 4 : ms < 3000 ? 5 : 6;

    for (const r of apiRows) {
      if (r.count <= 0) continue;
      const c50 = Math.round(r.count * 0.5);
      const c90 = Math.round(r.count * 0.4);
      const c95 = Math.round(r.count * 0.05);
      const c99 = Math.round(r.count * 0.04);
      const cMax = Math.max(0, r.count - c50 - c90 - c95 - c99);
      buckets[classify(r.p50Ms)]!.count += c50;
      buckets[classify((r.p50Ms + r.p90Ms) / 2)]!.count += c90;
      buckets[classify((r.p90Ms + r.p95Ms) / 2)]!.count += c95;
      buckets[classify((r.p95Ms + r.p99Ms) / 2)]!.count += c99;
      buckets[classify(r.maxMs)]!.count += cMax;
    }

    const hourlyRowCount = hourlyStats.length;
    const distRowCount = buckets.length;

    let sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheetViews>
    <sheetView tabSelected="0" workbookViewId="0">
      <pane ySplit="${TABLE_HEADER_ROW}" topLeftCell="A${TABLE_HEADER_ROW + 1}" activePane="bottomLeft" state="frozen"/>
    </sheetView>
  </sheetViews>
  <cols>`;
    colWidths.forEach((w, i) => {
      sheetXml += `\n    <col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`;
    });
    sheetXml += "\n  </cols>\n  <sheetData>";

    sheetXml += `\n    <row r="1" ht="28" customHeight="1">${strCell("A1", 1, "PM2 Log Analyzer — Hourly Trends & Distribution Data")}</row>`;
    sheetXml += `\n    <row r="2" ht="18" customHeight="1">${strCell("A2", 2, `Generated: ${generatedTime}`)}</row>`;
    sheetXml += `\n    <row r="3" ht="8" customHeight="1"/>`;

    // Row 4: Header
    const headers = [
      "Hour",
      "Total Requests",
      "Avg Latency",
      "P95 Latency",
      "P99 Latency",
      "Errors",
      "",
      "Latency Range",
      "Request Count",
    ];
    sheetXml += `\n    <row r="4">`;
    headers.forEach((h, i) => {
      if (h) {
        sheetXml += strCell(`${colToLetter(i + 1)}4`, 10, h);
      } else {
        sheetXml += emptyCell(`${colToLetter(i + 1)}4`, 0);
      }
    });
    sheetXml += `</row>`;

    let totalHourlyReqs = 0;
    let totalHourlyErrors = 0;
    let totalDistReqs = 0;

    const hourlyTotalsRow = hourlyRowCount > 0 ? TABLE_HEADER_ROW + hourlyRowCount + 1 : 0;
    const distTotalsRow = TABLE_HEADER_ROW + distRowCount + 1;
    const maxRow = Math.max(hourlyTotalsRow, distTotalsRow);

    for (let rowNum = TABLE_HEADER_ROW + 1; rowNum <= maxRow; rowNum++) {
      const dataIdx = rowNum - TABLE_HEADER_ROW - 1;
      let rowContent = "";

      // 1. Hourly Columns (A-F)
      if (dataIdx < hourlyRowCount) {
        const h = hourlyStats[dataIdx]!;
        totalHourlyReqs += h.count;
        totalHourlyErrors += h.errorCount;
        rowContent += strCell(`A${rowNum}`, 9, h.label);
        rowContent += numCell(`B${rowNum}`, 11, h.count);
        rowContent += numCell(`C${rowNum}`, 6, h.avgMs.toFixed(1));
        rowContent += numCell(`D${rowNum}`, 6, h.p95Ms.toFixed(1));
        rowContent += numCell(`E${rowNum}`, 6, h.p99Ms.toFixed(1));
        rowContent += numCell(`F${rowNum}`, 11, h.errorCount);
      } else if (rowNum === hourlyTotalsRow) {
        rowContent += strCell(`A${rowNum}`, 12, "Total");
        rowContent += formulaCell(
          `B${rowNum}`,
          11,
          "SUBTOTAL(109,HourlyTrends[Total Requests])",
          totalHourlyReqs,
        );
        rowContent += emptyCell(`C${rowNum}`, 0);
        rowContent += emptyCell(`D${rowNum}`, 0);
        rowContent += emptyCell(`E${rowNum}`, 0);
        rowContent += formulaCell(
          `F${rowNum}`,
          11,
          "SUBTOTAL(109,HourlyTrends[Errors])",
          totalHourlyErrors,
        );
      }

      // 2. Distribution Columns (H-I)
      if (dataIdx < distRowCount) {
        const b = buckets[dataIdx]!;
        totalDistReqs += b.count;
        rowContent += strCell(`H${rowNum}`, 9, b.label);
        rowContent += numCell(`I${rowNum}`, 11, b.count);
      } else if (rowNum === distTotalsRow) {
        rowContent += strCell(`H${rowNum}`, 12, "Total");
        rowContent += formulaCell(
          `I${rowNum}`,
          11,
          "SUBTOTAL(109,LatencyDistribution[Request Count])",
          totalDistReqs,
        );
      }

      if (rowContent) {
        sheetXml += `\n    <row r="${rowNum}">${rowContent}</row>`;
      }
    }

    sheetXml += "\n  </sheetData>";
    sheetXml += `\n  <mergeCells count="2">
    <mergeCell ref="A1:${colToLetter(lastCol)}1"/>
    <mergeCell ref="A2:${colToLetter(lastCol)}2"/>
  </mergeCells>`;

    if (hourlyRowCount > 0) {
      sheetXml += `\n  <conditionalFormatting sqref="F5:F${TABLE_HEADER_ROW + hourlyRowCount}">
    <cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan">
      <formula>0</formula>
    </cfRule>
  </conditionalFormatting>`;
    }

    const tablePartsCount = hourlyRowCount > 0 ? 2 : 1;
    sheetXml += `\n  <tableParts count="${tablePartsCount}">`;
    if (hourlyRowCount > 0) {
      sheetXml += `\n    <tablePart r:id="rId1"/>\n    <tablePart r:id="rId2"/>`;
    } else {
      sheetXml += `\n    <tablePart r:id="rId1"/>`;
    }
    sheetXml += `\n  </tableParts>`;
    sheetXml += "\n</worksheet>";
    files[`xl/worksheets/sheet${sheetIdx}.xml`] = strToU8(sheetXml);

    const t1Id = parseInt(hourlyTable1.replace(/\D/g, ""), 10);
    const t2Id = parseInt(hourlyTable2.replace(/\D/g, ""), 10);

    if (hourlyRowCount > 0) {
      const hourlyTableXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="${t1Id}" name="HourlyTrends" displayName="HourlyTrends" ref="A4:F${hourlyTotalsRow}" totalsRowCount="1">
  <autoFilter ref="A4:F${TABLE_HEADER_ROW + hourlyRowCount}"/>
  <tableColumns count="6">
    <tableColumn id="1" name="Hour" totalsRowLabel="Total"/>
    <tableColumn id="2" name="Total Requests" totalsRowFunction="sum"/>
    <tableColumn id="3" name="Avg Latency"/>
    <tableColumn id="4" name="P95 Latency"/>
    <tableColumn id="5" name="P99 Latency"/>
    <tableColumn id="6" name="Errors" totalsRowFunction="sum"/>
  </tableColumns>
  <tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/>
</table>`;
      files[`xl/tables/${hourlyTable1}`] = strToU8(hourlyTableXml);
    }

    const distTableXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="${hourlyRowCount > 0 ? t2Id : t1Id}" name="LatencyDistribution" displayName="LatencyDistribution" ref="H4:I${distTotalsRow}" totalsRowCount="1">
  <autoFilter ref="H4:I${TABLE_HEADER_ROW + distRowCount}"/>
  <tableColumns count="2">
    <tableColumn id="1" name="Latency Range" totalsRowLabel="Total"/>
    <tableColumn id="2" name="Request Count" totalsRowFunction="sum"/>
  </tableColumns>
  <tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/>
</table>`;
    files[`xl/tables/${hourlyRowCount > 0 ? hourlyTable2 : hourlyTable1}`] = strToU8(distTableXml);

    if (hourlyRowCount > 0) {
      files[`xl/worksheets/_rels/sheet${sheetIdx}.xml.rels`] =
        strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/${hourlyTable1}"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/${hourlyTable2}"/>
</Relationships>`);
    } else {
      files[`xl/worksheets/_rels/sheet${sheetIdx}.xml.rels`] =
        strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/${hourlyTable1}"/>
</Relationships>`);
    }
  }

  // --- Helper for Sheet 5: Visual Analytics with 4 Embedded Charts ---
  {
    const sheetIdx = visualSheetIdx;
    const colWidths = Array(15).fill(13);
    colWidths[7] = 4; // Col H spacer
    const lastCol = 15;

    const totalCount = summary?.matched ?? apiRows.reduce((acc, r) => acc + r.count, 0);
    const totalErrors = summary?.errors ?? apiRows.reduce((acc, r) => acc + r.errorCount, 0);
    const errorRate = totalCount > 0 ? ((totalErrors / totalCount) * 100).toFixed(2) : "0.00";

    const kpis = [
      ["Total Requests", formatNum(totalCount)],
      ["Total Errors", formatNum(totalErrors)],
      ["Error Rate", `${errorRate}%`],
      ["Avg Latency", formatMs(summary?.avg ?? 0)],
      ["P95 Latency", formatMs(summary?.p95Ms ?? 0)],
      ["Unique Endpoints", formatNum(apiRows.length)],
    ];

    let sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <cols>`;
    colWidths.forEach((w, i) => {
      sheetXml += `\n    <col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`;
    });
    sheetXml += "\n  </cols>\n  <sheetData>";

    sheetXml += `\n    <row r="1" ht="28" customHeight="1">${strCell("A1", 1, "PM2 Log Analyzer — Visual Analytics & Charts")}</row>`;
    sheetXml += `\n    <row r="2" ht="18" customHeight="1">${strCell("A2", 2, `Generated: ${generatedTime}  |  Total Requests: ${formatNum(totalCount)}  |  Endpoints: ${apiRows.length}`)}</row>`;
    sheetXml += `\n    <row r="3" ht="8" customHeight="1"/>`;

    // Row 4: KPI Titles
    sheetXml += `\n    <row r="4" ht="20" customHeight="1">`;
    kpis.forEach(([title], i) => {
      sheetXml += strCell(`${colToLetter(i + 1)}4`, 7, title);
    });
    sheetXml += `</row>`;

    // Row 5: KPI Values
    sheetXml += `\n    <row r="5" ht="24" customHeight="1">`;
    kpis.forEach(([, val], i) => {
      sheetXml += strCell(`${colToLetter(i + 1)}5`, 8, val);
    });
    sheetXml += `</row>`;

    sheetXml += "\n  </sheetData>";
    sheetXml += `\n  <mergeCells count="2">
    <mergeCell ref="A1:${colToLetter(lastCol)}1"/>
    <mergeCell ref="A2:${colToLetter(lastCol)}2"/>
  </mergeCells>`;

    sheetXml += `\n  <drawing r:id="rId1"/>`;
    sheetXml += "\n</worksheet>";
    files[`xl/worksheets/sheet${sheetIdx}.xml`] = strToU8(sheetXml);

    // Generate chart images matching current theme
    const chartImages = await generateAllChartImages(apiRows, hourlyStats, dailyStats, theme);

    const imageList: Array<{
      bytes: Uint8Array;
      fromCol: number;
      fromRow: number;
      toCol: number;
      toRow: number;
    }> = [];

    if (chartImages.timeVsLatency) {
      imageList.push({
        bytes: base64ToUint8(chartImages.timeVsLatency),
        fromCol: 0,
        fromRow: 7,
        toCol: 7,
        toRow: 24,
      });
    }
    if (chartImages.hourlyVolume) {
      imageList.push({
        bytes: base64ToUint8(chartImages.hourlyVolume),
        fromCol: 8,
        fromRow: 7,
        toCol: 15,
        toRow: 24,
      });
    }
    if (chartImages.distribution) {
      imageList.push({
        bytes: base64ToUint8(chartImages.distribution),
        fromCol: 0,
        fromRow: 26,
        toCol: 7,
        toRow: 43,
      });
    }
    if (chartImages.dailyTrend) {
      imageList.push({
        bytes: base64ToUint8(chartImages.dailyTrend),
        fromCol: 8,
        fromRow: 26,
        toCol: 15,
        toRow: 43,
      });
    }

    // Save media images and build drawing1.xml
    let drawingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`;

    let drawingRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`;

    imageList.forEach((img, idx) => {
      const imgNum = idx + 1;
      const imgFileName = `image${imgNum}.png`;
      files[`xl/media/${imgFileName}`] = img.bytes;

      drawingRelsXml += `\n  <Relationship Id="rId${imgNum}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${imgFileName}"/>`;

      drawingXml += `\n  <xdr:twoCellAnchor editAs="oneCell">
    <xdr:from><xdr:col>${img.fromCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${img.fromRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
    <xdr:to><xdr:col>${img.toCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${img.toRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
    <xdr:pic>
      <xdr:nvPicPr>
        <xdr:cNvPr id="${imgNum}" name="Picture ${imgNum}"/>
        <xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr>
      </xdr:nvPicPr>
      <xdr:blipFill>
        <a:blip r:embed="rId${imgNum}"/>
        <a:stretch><a:fillRect/></a:stretch>
      </xdr:blipFill>
      <xdr:spPr>
        <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
      </xdr:spPr>
    </xdr:pic>
    <xdr:clientData/>
  </xdr:twoCellAnchor>`;
    });

    drawingXml += "\n</xdr:wsDr>";
    drawingRelsXml += "\n</Relationships>";

    files["xl/drawings/drawing1.xml"] = strToU8(drawingXml);
    files["xl/drawings/_rels/drawing1.xml.rels"] = strToU8(drawingRelsXml);

    files[`xl/worksheets/_rels/sheet${sheetIdx}.xml.rels`] =
      strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>`);
  }

  // 1. [Content_Types].xml
  let contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
  <Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`;

  sheets.forEach((s) => {
    contentTypesXml += `\n  <Override PartName="/xl/worksheets/${s.file}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`;
    s.tableFiles.forEach((tf) => {
      contentTypesXml += `\n  <Override PartName="/xl/tables/${tf}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/>`;
    });
  });
  contentTypesXml += "\n</Types>";
  files["[Content_Types].xml"] = strToU8(contentTypesXml);

  // 2. _rels/.rels
  files["_rels/.rels"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`);

  // 3. xl/_rels/workbook.xml.rels
  let wbRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rIdTheme" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>
  <Relationship Id="rIdSharedStrings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>`;
  sheets.forEach((s) => {
    wbRelsXml += `\n  <Relationship Id="${s.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/${s.file}"/>`;
  });
  wbRelsXml += "\n</Relationships>";
  files["xl/_rels/workbook.xml.rels"] = strToU8(wbRelsXml);

  // 4. xl/workbook.xml
  let wbXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <workbookPr date1904="false"/>
  <sheets>`;
  sheets.forEach((s, idx) => {
    wbXml += `\n    <sheet name="${escapeXml(s.name)}" sheetId="${idx + 1}" r:id="${s.rId}"/>`;
  });
  wbXml += `\n  </sheets>
</workbook>`;
  files["xl/workbook.xml"] = strToU8(wbXml);

  // 5. xl/styles.xml, xl/theme/theme1.xml, xl/sharedStrings.xml
  files["xl/styles.xml"] = strToU8(generateStylesXml(theme));
  files["xl/theme/theme1.xml"] = strToU8(generateThemeXml());
  files["xl/sharedStrings.xml"] = strToU8(sst.toXml());

  // Compress into ZIP
  const zipBuffer = zipSync(files);
  return new Blob([zipBuffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}
