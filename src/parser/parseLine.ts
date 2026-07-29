import type { CronEventCompact, LogMethod, ParsedLine } from "./types";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"] as const;
const METHOD_BYTES: { method: LogMethod; bytes: number[] }[] = METHODS.map((m) => ({
  method: m,
  bytes: Array.from(m, (ch) => ch.charCodeAt(0)),
}));

const ANSI_RE = /\u001b\[[0-9;]*m/g; // oxlint-disable-line no-control-regex -- ESC for ANSI strip
const CRON_MARK = [0x5b, 0x63, 0x72, 0x6f, 0x6e, 0x5d]; // [cron]
const decoder = new TextDecoder("utf-8", { fatal: false });

/** Strip ANSI (kept for callers / tests). Prefer in-scanner skip on the hot path. */
export function stripAnsi(input: string): string {
  if (input.indexOf("\u001b") === -1) return input;
  return input.replace(ANSI_RE, "");
}

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

function skipAnsiBytes(buf: Uint8Array, i: number, end: number): number {
  while (i + 1 < end && buf[i] === 0x1b && buf[i + 1] === 0x5b) {
    i += 2;
    while (i < end) {
      const c = buf[i++]!;
      if (c >= 0x40 && c <= 0x7e) break;
    }
  }
  return i;
}

function skipSpaceAnsiBytes(buf: Uint8Array, i: number, end: number): number {
  for (;;) {
    i = skipAnsiBytes(buf, i, end);
    if (i >= end) return i;
    const c = buf[i]!;
    if (c === 32 || c === 9) {
      i++;
      continue;
    }
    return i;
  }
}

function onlySpaceAnsiLeftBytes(buf: Uint8Array, i: number, end: number): boolean {
  return skipSpaceAnsiBytes(buf, i, end) >= end;
}

function skipTimestampBytes(
  buf: Uint8Array,
  start: number,
  end: number,
): { i: number; tsStart: number; tsEnd: number } | null {
  if (end - start < 20) return null;
  const a = start;
  for (let k = 0; k < 10; k++) {
    const c = buf[a + k]!;
    if (k === 4 || k === 7) {
      if (c !== 45) return null;
    } else if (!isDigit(c)) return null;
  }
  const sep = buf[a + 10]!;
  if (sep !== 84 && sep !== 32) return null;
  for (let k = 11; k < 19; k++) {
    const c = buf[a + k]!;
    if (k === 13 || k === 16) {
      if (c !== 58) return null;
    } else if (!isDigit(c)) return null;
  }
  if (buf[a + 19] !== 58) return null;
  return { i: skipSpaceAnsiBytes(buf, a + 20, end), tsStart: a, tsEnd: a + 19 };
}

function parseMethodBytes(
  buf: Uint8Array,
  i: number,
  end: number,
): { method: LogMethod; i: number } | null {
  i = skipSpaceAnsiBytes(buf, i, end);
  for (const { method, bytes } of METHOD_BYTES) {
    if (i + bytes.length > end) continue;
    let ok = true;
    for (let k = 0; k < bytes.length; k++) {
      if (buf[i + k] !== bytes[k]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const after = i + bytes.length;
    const next = after < end ? buf[after]! : 32;
    if (next === 32 || next === 9 || next === 0x1b || after >= end) {
      return { method, i: after };
    }
  }
  return null;
}

function readTokenRange(
  buf: Uint8Array,
  i: number,
  end: number,
): { start: number; end: number; i: number } | null {
  i = skipSpaceAnsiBytes(buf, i, end);
  if (i >= end) return null;
  const start = i;
  while (i < end) {
    const c = buf[i]!;
    if (c === 32 || c === 9 || c === 0x1b) break;
    i++;
  }
  if (i === start) return null;
  return { start, end: i, i };
}

function parseFloatBytes(
  buf: Uint8Array,
  i: number,
  end: number,
): { value: number; i: number } | null {
  i = skipSpaceAnsiBytes(buf, i, end);
  const start = i;
  while (i < end && isDigit(buf[i]!)) i++;
  if (i < end && buf[i] === 46) {
    i++;
    while (i < end && isDigit(buf[i]!)) i++;
  }
  if (i === start) return null;
  let value = 0;
  let frac = 0;
  let fracDiv = 1;
  let seenDot = false;
  for (let k = start; k < i; k++) {
    const c = buf[k]!;
    if (c === 46) {
      seenDot = true;
      continue;
    }
    if (!seenDot) value = value * 10 + (c - 48);
    else {
      frac = frac * 10 + (c - 48);
      fracDiv *= 10;
    }
  }
  if (seenDot) value += frac / fracDiv;
  return { value, i };
}

function decodeAscii(buf: Uint8Array, start: number, end: number): string {
  return decoder.decode(buf.subarray(start, end));
}

function findCronMark(buf: Uint8Array, from: number, end: number): number {
  outer: for (let i = from; i + CRON_MARK.length <= end; i++) {
    for (let k = 0; k < CRON_MARK.length; k++) {
      if (buf[i + k] !== CRON_MARK[k]) continue outer;
    }
    return i;
  }
  return -1;
}

function tryHttpABytes(buf: Uint8Array, start: number, end: number, out: LineScratch): boolean {
  let i = skipSpaceAnsiBytes(buf, start, end);
  const ts = skipTimestampBytes(buf, i, end);
  if (ts && ts.i !== i) i = ts.i;

  const meth = parseMethodBytes(buf, i, end);
  if (!meth) return false;
  i = meth.i;

  const pathTok = readTokenRange(buf, i, end);
  if (!pathTok) return false;
  i = pathTok.i;

  const statusTok = readTokenRange(buf, i, end);
  if (!statusTok || statusTok.end - statusTok.start !== 3) return false;
  const s0 = buf[statusTok.start]!;
  const s1 = buf[statusTok.start + 1]!;
  const s2 = buf[statusTok.start + 2]!;
  if (!isDigit(s0) || !isDigit(s1) || !isDigit(s2)) return false;
  const status = (s0 - 48) * 100 + (s1 - 48) * 10 + (s2 - 48);
  i = statusTok.i;

  const dur = parseFloatBytes(buf, i, end);
  if (!dur) return false;
  i = skipSpaceAnsiBytes(buf, dur.i, end);
  if (i + 1 >= end || buf[i] !== 0x6d || buf[i + 1] !== 0x73) return false; // ms
  i = skipSpaceAnsiBytes(buf, i + 2, end);
  if (i >= end || buf[i] !== 45) return false;
  i = skipSpaceAnsiBytes(buf, i + 1, end);
  if (i >= end) return false;
  if (buf[i] === 45) i++;
  else {
    const b0 = i;
    while (i < end && isDigit(buf[i]!)) i++;
    if (i === b0) return false;
  }
  if (!onlySpaceAnsiLeftBytes(buf, i, end)) return false;

  out.kind = "http";
  out.method = meth.method;
  out.path = decodeAscii(buf, pathTok.start, pathTok.end);
  out.status = status;
  out.durationMs = dur.value;
  out.cron = null;
  return true;
}

function tryHttpBBytes(buf: Uint8Array, start: number, end: number, out: LineScratch): boolean {
  let i = skipSpaceAnsiBytes(buf, start, end);
  const dur = parseFloatBytes(buf, i, end);
  if (!dur) return false;
  i = skipSpaceAnsiBytes(buf, dur.i, end);
  if (i + 1 >= end || buf[i] !== 0x6d || buf[i + 1] !== 0x73) return false;
  i = skipSpaceAnsiBytes(buf, i + 2, end);

  const meth = parseMethodBytes(buf, i, end);
  if (!meth) return false;
  i = meth.i;

  const pathTok = readTokenRange(buf, i, end);
  if (!pathTok) return false;
  if (!onlySpaceAnsiLeftBytes(buf, pathTok.i, end)) return false;

  out.kind = "http";
  out.method = meth.method;
  out.path = decodeAscii(buf, pathTok.start, pathTok.end);
  out.status = 0;
  out.durationMs = dur.value;
  out.cron = null;
  return true;
}

function tryCronBytes(buf: Uint8Array, start: number, end: number, out: LineScratch): boolean {
  let i = skipSpaceAnsiBytes(buf, start, end);
  const ts = skipTimestampBytes(buf, i, end);
  if (ts) i = ts.i;

  const cronIdx = findCronMark(buf, i, end);
  if (cronIdx === -1) return false;
  let k = i;
  while (k < cronIdx) {
    k = skipAnsiBytes(buf, k, end);
    if (k >= cronIdx) break;
    const c = buf[k]!;
    if (c === 32 || c === 9) {
      k++;
      continue;
    }
    return false;
  }

  i = skipSpaceAnsiBytes(buf, cronIdx + 6, end);

  let event: "start" | "done" | "fail" | null = null;
  if (
    i + 5 <= end &&
    buf[i] === 0x73 &&
    buf[i + 1] === 0x74 &&
    buf[i + 2] === 0x61 &&
    buf[i + 3] === 0x72 &&
    buf[i + 4] === 0x74 &&
    (i + 5 >= end || buf[i + 5] === 32)
  ) {
    event = "start";
    i += 5;
  } else if (
    i + 4 <= end &&
    buf[i] === 0x64 &&
    buf[i + 1] === 0x6f &&
    buf[i + 2] === 0x6e &&
    buf[i + 3] === 0x65 &&
    (i + 4 >= end || buf[i + 4] === 32)
  ) {
    event = "done";
    i += 4;
  } else if (
    i + 4 <= end &&
    buf[i] === 0x66 &&
    buf[i + 1] === 0x61 &&
    buf[i + 2] === 0x69 &&
    buf[i + 3] === 0x6c &&
    (i + 4 >= end || buf[i + 4] === 32)
  ) {
    event = "fail";
    i += 4;
  } else return false;

  i = skipSpaceAnsiBytes(buf, i, end);
  let name = stripAnsi(decodeAscii(buf, i, end)).trim();
  if (!name) return false;

  let durationMs: number | undefined;
  const durMatch = /^(.+?)\s+([0-9.]+)\s*ms\s*$/i.exec(name);
  if (durMatch) {
    name = durMatch[1]!.trim();
    durationMs = Number(durMatch[2]);
  }

  const ev: CronEventCompact = { event, name };
  if (ts) ev.ts = decodeAscii(buf, ts.tsStart, ts.tsEnd);
  if (durationMs !== undefined) ev.durationMs = durationMs;
  out.kind = "cron";
  out.cron = ev;
  return true;
}

function hasNonSpaceBytes(buf: Uint8Array, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    const c = buf[i]!;
    if (c > 32 && c !== 0x1b) return true;
    if (c === 0x1b) i = skipAnsiBytes(buf, i, end) - 1;
  }
  return false;
}

/** Reusable parse output — avoids per-line object alloc in the worker. */
export type LineScratch = {
  kind: "empty" | "http" | "cron" | "unmatched";
  method: LogMethod;
  path: string;
  status: number;
  durationMs: number;
  cron: CronEventCompact | null;
};

export function createLineScratch(): LineScratch {
  return {
    kind: "empty",
    method: "GET",
    path: "",
    status: 0,
    durationMs: 0,
    cron: null,
  };
}

/** Hot path: parse one line from raw bytes [start, end). */
export function parseLineBytes(
  buf: Uint8Array,
  start: number,
  end: number,
  out: LineScratch,
): void {
  // trim trailing CR
  if (end > start && buf[end - 1] === 0x0d) end--;

  if (!hasNonSpaceBytes(buf, start, end)) {
    out.kind = "empty";
    out.cron = null;
    return;
  }

  if (findCronMark(buf, start, end) !== -1 && tryCronBytes(buf, start, end, out)) return;
  if (tryHttpABytes(buf, start, end, out)) return;
  if (tryHttpBBytes(buf, start, end, out)) return;

  out.kind = "unmatched";
  out.cron = null;
}

export function parseLineInto(line: string, out: LineScratch): void {
  // Encode once for paste / selfcheck path — shards use parseLineBytes directly
  const enc = new TextEncoder().encode(line);
  parseLineBytes(enc, 0, enc.length, out);
}

export function parseLine(line: string): ParsedLine {
  const out = createLineScratch();
  parseLineInto(line, out);
  if (out.kind === "http") {
    return {
      kind: "http",
      hit: {
        method: out.method,
        path: out.path,
        status: out.status,
        durationMs: out.durationMs,
      },
    };
  }
  if (out.kind === "cron") return { kind: "cron", event: out.cron! };
  if (out.kind === "empty") return { kind: "empty" };
  return { kind: "unmatched" };
}
