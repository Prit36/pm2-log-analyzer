/** Decode Rust PM2P reagg partials and cron/unmatched wires. */

import type { AggPartial, NormBucketWire } from "../parser/aggregate";
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

function readBytes(buf: Uint8Array, view: DataView, o: number): { bytes: Uint8Array; next: number } {
  const len = u32(view, o);
  o += 4;
  return { bytes: buf.subarray(o, o + len), next: o + len };
}

function decodeSketch(buf: Uint8Array): RelHistWire {
  if (buf.length < 8) return { buckets: [], count: 0 };
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const count = u32(view, 0);
  const n = u32(view, 4);
  const buckets: [number, number][] = [];
  let o = 8;
  for (let i = 0; i < n; i++) {
    const k = view.getInt32(o, true);
    const c = u32(view, o + 4);
    buckets.push([k, c]);
    o += 8;
  }
  return { buckets, count };
}

const dec = new TextDecoder();

export function decodePm2Partial(buf: Uint8Array): {
  matched: number;
  unmatched: number;
  partial: AggPartial;
} {
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
    const skLen = u32(view, o);
    o += 4;
    const sketch = decodeSketch(buf.subarray(o, o + skLen));
    o += skLen;
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
    const skLen = u32(view, o);
    o += 4;
    const sketch = decodeSketch(buf.subarray(o, o + skLen));
    o += skLen;
    const method = (METHODS[methodCode] ?? "GET") as LogMethod;
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
