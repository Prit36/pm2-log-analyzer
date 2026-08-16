import type {
  AggPartial,
  HourlyBucketPartial,
  HourlyPartial,
  NormBucketWire,
} from "../parser/aggregate";
import type { CronEventCompact, LogMethod } from "../parser";
import type { RelHistWire } from "../parser/relHist";
import { METHODS } from "../parser";

const MAGIC = 0x504d3250; // PM2P

function u32(view: DataView, o: number): number {
  return view.getUint32(o, true);
}
function f32(view: DataView, o: number): number {
  return view.getFloat32(o, true);
}
function f64(view: DataView, o: number): number {
  return view.getFloat64(o, true);
}

type ReadBytesResult = {
  bytes: Uint8Array;
  next: number;
};

function readBytes(buf: Uint8Array, view: DataView, o: number): ReadBytesResult {
  const len = u32(view, o);
  o += 4;
  return { bytes: buf.subarray(o, o + len), next: o + len };
}

type DecodedSketch = {
  sketch: RelHistWire;
  next: number;
};

function decodeSketchAt(view: DataView, o: number): DecodedSketch {
  const count = u32(view, o);
  const n = u32(view, 4 + o);
  const buckets: [number, number][] = [];
  let cur = o + 8;
  for (let i = 0; i < n; i++) {
    const k = view.getInt32(cur, true);
    const c = u32(view, cur + 4);
    buckets.push([k, c]);
    cur += 8;
  }
  return { sketch: { buckets, count }, next: cur };
}

const HOURLY_MAGIC = 0x504d3248;

export function decodeHourlyWire(buf: Uint8Array): HourlyPartial {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.byteLength < 8 || u32(view, 0) !== HOURLY_MAGIC) throw new Error("bad PM2H magic");
  const version = view.getUint16(4, true);
  if (version !== 1) throw new Error(`unsupported PM2H version ${version}`);
  const bucketCount = view.getUint16(6, true);
  if (bucketCount !== 24) throw new Error(`unsupported PM2H bucket count ${bucketCount}`);

  const buckets: HourlyBucketPartial[] = [];
  let o = 8;
  for (let i = 0; i < bucketCount; i++) {
    const count = u32(view, o);
    const errorCount = u32(view, o + 4);
    const sum = f64(view, o + 8);
    const max = f32(view, o + 16);
    o += 24;
    const { sketch, next } = decodeSketchAt(view, o);
    o = next;
    buckets.push({ count, errorCount, sum, max, sketch });
  }
  if (o !== buf.byteLength) throw new Error("trailing PM2H bytes");
  return { buckets };
}

const dec = new TextDecoder();

export type DecodedPm2Partial = {
  matched: number;
  unmatched: number;
  partial: AggPartial;
};

export function decodePm2Partial(buf: Uint8Array): DecodedPm2Partial {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = 0;
  if (u32(view, o) !== MAGIC) throw new Error("bad PM2P magic");
  o += 4;
  const version = view.getUint16(o, true);
  o += 2;
  if (version !== 1) throw new Error(`unsupported PM2P version ${version}`);
  o += 1; // mode
  const flags = buf[o]!;
  o += 1;
  const endpointCount = u32(view, o);
  o += 4;
  const matched = u32(view, o);
  o += 4;
  const unmatched = u32(view, o);
  o += 4;

  let summary: AggPartial["summary"] = null;
  if (flags & 1) {
    const sum = f64(view, o);
    o += 8;
    const max = f32(view, o);
    o += 4;
    const errors = u32(view, o);
    o += 4;
    const slow = u32(view, o);
    o += 4;
    o += 4; // skLen
    const { sketch, next } = decodeSketchAt(view, o);
    o = next;
    summary = { sum, max, errors, slow, sketch };
  }

  const buckets: NormBucketWire[] = [];
  for (let i = 0; i < endpointCount; i++) {
    const methodCode = buf[o]!;
    o += 4; // method + pad
    const count = u32(view, o);
    o += 4;
    const sum = f64(view, o);
    o += 8;
    const min = f32(view, o);
    o += 4;
    const max = f32(view, o);
    o += 4;
    const errorCount = u32(view, o);
    o += 4;
    const pathRead = readBytes(buf, view, o);
    o = pathRead.next;
    o += 4; // skLen
    const { sketch, next } = decodeSketchAt(view, o);
    o = next;
    const method = METHODS[methodCode] ?? "GET";
    const path = dec.decode(pathRead.bytes);
    buckets.push({
      method,
      path,
      sketch,
      count,
      sum,
      min,
      max,
      errorCount,
    });
  }

  return { matched, unmatched, partial: { buckets, summary } };
}

export function decodeCronWire(buf: Uint8Array): CronEventCompact[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = 0;
  const n = u32(view, o);
  o += 4;
  const out: CronEventCompact[] = [];
  const eventNames = ["start", "done", "fail"] as const;
  for (let i = 0; i < n; i++) {
    const event = eventNames[buf[o]!] ?? "start";
    o += 1;
    const nameR = readBytes(buf, view, o);
    o = nameR.next;
    const hasTs = buf[o]!;
    o += 1;
    let ts: string | undefined;
    if (hasTs) {
      const tsR = readBytes(buf, view, o);
      o = tsR.next;
      ts = dec.decode(tsR.bytes);
    }
    const hasDur = buf[o]!;
    o += 1;
    let durationMs: number | undefined;
    if (hasDur) {
      durationMs = f32(view, o);
      o += 4;
    }
    const ev: CronEventCompact = { event, name: dec.decode(nameR.bytes) };
    if (ts !== undefined) ev.ts = ts;
    if (durationMs !== undefined) ev.durationMs = durationMs;
    out.push(ev);
  }
  return out;
}

export function decodeUnmatchedWire(buf: Uint8Array): string[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = 0;
  const n = u32(view, o);
  o += 4;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = readBytes(buf, view, o);
    o = r.next;
    out.push(dec.decode(r.bytes));
  }
  return out;
}

export const DAILY_MAGIC = 0x504d3244; // PM2D

export type DailyBucketPartial = {
  date: string;
  count: number;
  errorCount: number;
  slowCount: number;
  sum: number;
  max: number;
  sketch: RelHistWire;
  hourly: HourlyBucketPartial[];
};

export type DailyPartial = {
  days: DailyBucketPartial[];
};

export function decodeDatesWire(buf: Uint8Array): string[] {
  if (buf.byteLength < 4) return [];
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const count = u32(view, 0);
  let o = 4;
  const dates: string[] = [];
  for (let i = 0; i < count; i++) {
    const r = readBytes(buf, view, o);
    o = r.next;
    dates.push(dec.decode(r.bytes));
  }
  return dates;
}

export function decodeDailyWire(buf: Uint8Array): DailyPartial {
  if (buf.byteLength === 0) return { days: [] };
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.byteLength < 8 || u32(view, 0) !== DAILY_MAGIC) throw new Error("bad PM2D magic");
  const version = view.getUint16(4, true);
  if (version !== 1) throw new Error(`unsupported PM2D version ${version}`);
  const dayCount = view.getUint16(6, true);

  const days: DailyBucketPartial[] = [];
  let o = 8;
  for (let i = 0; i < dayCount; i++) {
    const dateBytes = buf.subarray(o, o + 10);
    const date = dec.decode(dateBytes);
    o += 12; // 10 bytes date + 2 bytes pad
    const count = u32(view, o);
    const errorCount = u32(view, o + 4);
    const slowCount = u32(view, o + 8);
    const sum = f64(view, o + 12);
    const max = f32(view, o + 20);
    o += 28; // 24 + 4 for skLen
    const { sketch, next } = decodeSketchAt(view, o);
    o = next;

    const hourly: HourlyBucketPartial[] = [];
    for (let h = 0; h < 24; h++) {
      const hCount = u32(view, o);
      const hError = u32(view, o + 4);
      const hSum = f64(view, o + 8);
      const hMax = f32(view, o + 16);
      o += 24; // 20 + 4 for hSkLen
      const { sketch: hSketch, next: hNext } = decodeSketchAt(view, o);
      o = hNext;
      hourly.push({ count: hCount, errorCount: hError, sum: hSum, max: hMax, sketch: hSketch });
    }

    days.push({ date, count, errorCount, slowCount, sum, max, sketch, hourly });
  }

  return { days };
}

export function methodsFromMask(mask: number): LogMethod[] {
  const out: LogMethod[] = [];
  for (let i = 0; i < METHODS.length; i++) {
    if (mask & (1 << i)) out.push(METHODS[i]!);
  }
  return out.sort();
}

export function normalizeModeCode(mode: string): number {
  if (mode === "stripQuery") return 1;
  if (mode === "collapseIds") return 2;
  return 0;
}

export function statusFamilyCode(family: string): number {
  if (family === "2xx") return 2;
  if (family === "3xx") return 3;
  if (family === "4xx") return 4;
  if (family === "5xx") return 5;
  return 0;
}
