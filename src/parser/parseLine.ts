import type { CronEventCompact, LogMethod, ParsedLine } from "./types";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;
const METHOD_BYTES: { method: LogMethod; bytes: number[] }[] = METHODS.map((m) => ({
  method: m,
  bytes: Array.from(m, (ch) => ch.charCodeAt(0)),
}));

const ANSI_RE = /\u001b\[[0-9;]*m/g; // oxlint-disable-line no-control-regex -- ESC for ANSI strip
const CRON_MARK = [0x5b, 0x63, 0x72, 0x6f, 0x6e, 0x5d]; // [cron]
const decoder = new TextDecoder("utf-8", { fatal: false });

export function stripAnsi(input: string): string {
  if (input.indexOf("\u001b") === -1) return input;
  return input.replace(ANSI_RE, "");
}

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

function isAlpha(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function isAlphaNumeric(c: number): boolean {
  return (c >= 48 && c <= 57) || isAlpha(c);
}

function decodeAscii(buf: Uint8Array, start: number, end: number): string {
  return decoder.decode(buf.subarray(start, end));
}

function startsWithBytes(buf: Uint8Array, s: string): boolean {
  if (buf.length < s.length) return false;
  for (let k = 0; k < s.length; k++) if (buf[k] !== s.charCodeAt(k)) return false;
  return true;
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

// ── Timestamp ───────────────────────────────────────────────────────────────

function hasValidDatePrefix(buf: Uint8Array, a: number): boolean {
  for (let k = 0; k < 10; k++) {
    const c = buf[a + k]!;
    if (k === 4 || k === 7) {
      if (c !== 45) return false;
    } else if (!isDigit(c)) return false;
  }
  return true;
}

function hasValidTimePrefix(buf: Uint8Array, a: number): boolean {
  for (let k = 11; k < 19; k++) {
    const c = buf[a + k]!;
    if (k === 13 || k === 16) {
      if (c !== 58) return false;
    } else if (!isDigit(c)) return false;
  }
  return true;
}

function isTimestampSeparator(c: number): boolean {
  return c === 84 || c === 32;
}

function extractTimestampHour(buf: Uint8Array, a: number): number {
  const hour = (buf[a + 11]! - 48) * 10 + (buf[a + 12]! - 48);
  return hour >= 0 && hour < 24 ? hour : 0;
}

function skipTimestampBytes(
  buf: Uint8Array,
  start: number,
  end: number,
): { i: number; tsStart: number; tsEnd: number; hour: number; dateStr: string } | null {
  if (end - start < 20) return null;
  const a = start;
  if (!hasValidDatePrefix(buf, a)) return null;
  if (!isTimestampSeparator(buf[a + 10]!)) return null;
  if (!hasValidTimePrefix(buf, a)) return null;
  if (buf[a + 19] !== 58) return null;
  return {
    i: skipSpaceAnsiBytes(buf, a + 20, end),
    tsStart: a,
    tsEnd: a + 19,
    hour: extractTimestampHour(buf, a),
    dateStr: decodeAscii(buf, a, a + 10),
  };
}

// ── Token helpers ───────────────────────────────────────────────────────────

function parseMethodBytes(
  buf: Uint8Array,
  i: number,
  end: number,
): { method: LogMethod; i: number } | null {
  i = skipSpaceAnsiBytes(buf, i, end);
  for (const { method, bytes } of METHOD_BYTES) {
    if (i + bytes.length > end) continue;
    if (!methodBytesMatch(buf, i, bytes)) continue;
    const after = i + bytes.length;
    const next = after < end ? buf[after]! : 32;
    if (isMethodTerminator(next) || after >= end) return { method, i: after };
  }
  return null;
}

function methodBytesMatch(buf: Uint8Array, i: number, bytes: number[]): boolean {
  for (let k = 0; k < bytes.length; k++) if (buf[i + k] !== bytes[k]) return false;
  return true;
}

function isMethodTerminator(c: number): boolean {
  return c === 32 || c === 9 || c === 0x1b;
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
  i = consumeDigits(buf, i, end);
  if (i < end && buf[i] === 46) i = consumeDigits(buf, i + 1, end);
  if (i === start) return null;
  return { value: decodeFloatBytes(buf, start, i), i };
}

function consumeDigits(buf: Uint8Array, i: number, end: number): number {
  while (i < end && isDigit(buf[i]!)) i++;
  return i;
}

function decodeFloatBytes(buf: Uint8Array, start: number, end: number): number {
  let value = 0;
  let frac = 0;
  let fracDiv = 1;
  let seenDot = false;
  for (let k = start; k < end; k++) {
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
  return seenDot ? value + frac / fracDiv : value;
}

function findCronMark(buf: Uint8Array, from: number, end: number): number {
  outer: for (let i = from; i + CRON_MARK.length <= end; i++) {
    for (let k = 0; k < CRON_MARK.length; k++) if (buf[i + k] !== CRON_MARK[k]) continue outer;
    return i;
  }
  return -1;
}

// ── HTTP ────────────────────────────────────────────────────────────────────

function parseStatusCode(buf: Uint8Array, tok: { start: number; end: number }): number | null {
  if (tok.end - tok.start !== 3) return null;
  const s0 = buf[tok.start]!;
  const s1 = buf[tok.start + 1]!;
  const s2 = buf[tok.start + 2]!;
  if (!isDigit(s0) || !isDigit(s1) || !isDigit(s2)) return null;
  return (s0 - 48) * 100 + (s1 - 48) * 10 + (s2 - 48);
}

function expectMsSuffix(buf: Uint8Array, i: number, end: number): number | null {
  i = skipSpaceAnsiBytes(buf, i, end);
  if (i + 1 >= end || buf[i] !== 0x6d || buf[i + 1] !== 0x73) return null;
  return i + 2;
}

function expectDashWithPayload(buf: Uint8Array, i: number, end: number): number | null {
  i = skipSpaceAnsiBytes(buf, i, end);
  if (i >= end || buf[i] !== 45) return null;
  i = skipSpaceAnsiBytes(buf, i + 1, end);
  if (i >= end) return null;
  if (buf[i] === 45) return i + 1;
  const b0 = i;
  while (i < end && isDigit(buf[i]!)) i++;
  return i === b0 ? null : i;
}

function tryHttpABytes(buf: Uint8Array, start: number, end: number, out: LineScratch): boolean {
  let i = skipSpaceAnsiBytes(buf, start, end);
  const ts = skipTimestampBytes(buf, i, end);
  if (ts && ts.i !== i) i = ts.i;

  const meth = parseMethodBytes(buf, i, end);
  if (!meth) return false;
  const pathTok = readTokenRange(buf, meth.i, end);
  if (!pathTok) return false;
  const statusTok = readTokenRange(buf, pathTok.i, end);
  if (!statusTok) return false;
  const status = parseStatusCode(buf, statusTok);
  if (status === null) return false;
  const dur = parseFloatBytes(buf, statusTok.i, end);
  if (!dur) return false;

  const afterMs = expectMsSuffix(buf, dur.i, end);
  if (afterMs === null) return false;
  const afterDash = expectDashWithPayload(buf, afterMs, end);
  if (afterDash === null) return false;
  if (!onlySpaceAnsiLeftBytes(buf, afterDash, end)) return false;

  out.kind = "http";
  out.method = meth.method;
  out.path = decodeAscii(buf, pathTok.start, pathTok.end);
  out.status = status;
  out.durationMs = dur.value;
  out.hour = ts ? ts.hour : -1;
  out.dateStr = ts ? ts.dateStr : null;
  out.cron = null;
  return true;
}

function tryHttpBBytes(buf: Uint8Array, start: number, end: number, out: LineScratch): boolean {
  let i = skipSpaceAnsiBytes(buf, start, end);
  const dur = parseFloatBytes(buf, i, end);
  if (!dur) return false;
  const afterMs = expectMsSuffix(buf, dur.i, end);
  if (afterMs === null) return false;
  const meth = parseMethodBytes(buf, afterMs, end);
  if (!meth) return false;
  const pathTok = readTokenRange(buf, meth.i, end);
  if (!pathTok) return false;
  if (!onlySpaceAnsiLeftBytes(buf, pathTok.i, end)) return false;

  out.kind = "http";
  out.method = meth.method;
  out.path = decodeAscii(buf, pathTok.start, pathTok.end);
  out.status = 0;
  out.durationMs = dur.value;
  out.hour = -1;
  out.dateStr = null;
  out.cron = null;
  return true;
}

// ── Cron ────────────────────────────────────────────────────────────────────

const CRON_EVENTS = {
  start: "start",
  done: "done",
  fail: "fail",
} as const satisfies Record<string, "start" | "done" | "fail">;

function matchCronEvent(
  buf: Uint8Array,
  i: number,
  end: number,
): { event: "start" | "done" | "fail"; next: number } | null {
  // SAFETY: CRON_EVENTS keys are exactly "start"|"done"|"fail"
  for (const word of Object.keys(CRON_EVENTS) as (keyof typeof CRON_EVENTS)[]) {
    if (i + word.length > end) continue;
    if (!bytesEqualWord(buf, i, word)) continue;
    const after = i + word.length;
    if (after < end && buf[after]! !== 32 && buf[after]! !== 9) continue;
    return { event: CRON_EVENTS[word], next: after };
  }
  return null;
}

function bytesEqualWord(buf: Uint8Array, i: number, word: string): boolean {
  for (let k = 0; k < word.length; k++) if (buf[i + k] !== word.charCodeAt(k)) return false;
  return true;
}

function hasOnlyWhitespaceToCron(
  buf: Uint8Array,
  from: number,
  cronIdx: number,
  end: number,
): boolean {
  let k = from;
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
  return true;
}

type CronDurationExtract = { name: string; durationMs?: number };
function extractCronDuration(name: string): CronDurationExtract {
  const durMatch = /^(.+?)\s+([0-9.]+)\s*ms\s*$/i.exec(name);
  if (!durMatch) return { name };
  return { name: durMatch[1]!.trim(), durationMs: Number(durMatch[2]) };
}

function tryCronBytes(buf: Uint8Array, start: number, end: number, out: LineScratch): boolean {
  let i = skipSpaceAnsiBytes(buf, start, end);
  const ts = skipTimestampBytes(buf, i, end);
  if (ts) i = ts.i;

  const cronIdx = findCronMark(buf, i, end);
  if (cronIdx === -1) return false;
  if (!hasOnlyWhitespaceToCron(buf, i, cronIdx, end)) return false;

  i = skipSpaceAnsiBytes(buf, cronIdx + 6, end);
  const matched = matchCronEvent(buf, i, end);
  if (!matched) return false;

  i = skipSpaceAnsiBytes(buf, matched.next, end);
  let name = stripAnsi(decodeAscii(buf, i, end)).trim();
  if (!name) return false;
  const extracted = extractCronDuration(name);
  name = extracted.name;

  const ev: CronEventCompact = { event: matched.event, name };
  if (ts) ev.ts = decodeAscii(buf, ts.tsStart, ts.tsEnd);
  if (extracted.durationMs !== undefined) ev.durationMs = extracted.durationMs;
  out.kind = "cron";
  out.cron = ev;
  return true;
}

// ── Noise / misc ────────────────────────────────────────────────────────────

function hasNonSpaceBytes(buf: Uint8Array, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    const c = buf[i]!;
    if (c > 32 && c !== 0x1b) return true;
    if (c === 0x1b) i = skipAnsiBytes(buf, i, end) - 1;
  }
  return false;
}

function noiseBody(buf: Uint8Array, start: number, end: number): Uint8Array {
  let i = skipSpaceAnsiBytes(buf, start, end);
  const ts = skipTimestampBytes(buf, i, end);
  if (ts && ts.i !== i) i = ts.i;
  while (i < end && (buf[i] === 32 || buf[i] === 9)) i++;
  return buf.subarray(i, end);
}

function isSocketNoiseBytes(buf: Uint8Array, start: number, end: number): boolean {
  const body = noiseBody(buf, start, end);
  if (body.length === 0) return false;
  const c0 = body[0]!;
  if (isAlpha(c0)) return isSocketAlphaNoise(body);
  return isBareSocketFragment(body);
}

function isSocketAlphaNoise(body: Uint8Array): boolean {
  let w = 0;
  while (w < body.length && isAlphaNumeric(body[w]!)) w++;
  const word = body.subarray(0, w);
  let after = body.subarray(w);
  while (after.length && (after[0] === 32 || after[0] === 9)) after = after.subarray(1);
  if (isSocketConnectionWord(word, after)) return true;
  if (startsWithBytes(word, "Token") && startsWithBytes(after, "parts: [")) return true;
  if (isMethodSocketNoise(word, after)) return true;
  if (startsWithBytes(word, "address") && startsWithBytes(after, ": '::ffff:")) return true;
  if (startsWithBytes(word, "id") && startsWithBytes(after, ": '") && body.length <= 64)
    return true;
  return false;
}

function isSocketConnectionWord(word: Uint8Array, after: Uint8Array): boolean {
  const isSocketWord =
    startsWithBytes(word, "New") ||
    startsWithBytes(word, "disconnected") ||
    startsWithBytes(word, "join") ||
    startsWithBytes(word, "leave");
  return isSocketWord && (startsWithBytes(after, "Connection {") || startsWithBytes(after, "{"));
}

function isMethodSocketNoise(word: Uint8Array, after: Uint8Array): boolean {
  if (!startsWithBytes(word, "method")) return false;
  return startsWithBytes(after, ": 'join'") || startsWithBytes(after, ": 'disconnect'");
}

function isBareSocketFragment(body: Uint8Array): boolean {
  const c0 = body[0]!;
  const tail = body.subarray(1);
  const bareTail = Array.from(tail).every((c) => c === 32 || c === 9 || c === 44);
  if (c0 === 0x7b) return bareTail || startsWithBytes(body, "{ '");
  if (c0 === 0x5b) return bareTail;
  if (c0 === 0x7d) return bareTail;
  if (c0 === 0x5d) {
    if (startsWithBytes(body, "] {") || startsWithBytes(body, "] Length:")) return true;
    return bareTail;
  }
  return false;
}

// ── Public API ──────────────────────────────────────────────────────────────

export type LineScratch = {
  kind: "empty" | "http" | "cron" | "unmatched";
  method: LogMethod;
  path: string;
  status: number;
  durationMs: number;
  hour: number;
  dateStr: string | null;
  cron: CronEventCompact | null;
};

export function createLineScratch(): LineScratch {
  return {
    kind: "empty",
    method: "GET",
    path: "",
    status: 0,
    durationMs: 0,
    hour: -1,
    dateStr: null,
    cron: null,
  };
}

export function parseLineBytes(
  buf: Uint8Array,
  start: number,
  end: number,
  out: LineScratch,
): void {
  if (end > start && buf[end - 1] === 0x0d) end--;
  if (!hasNonSpaceBytes(buf, start, end)) {
    out.kind = "empty";
    out.cron = null;
    return;
  }
  if (findCronMark(buf, start, end) !== -1 && tryCronBytes(buf, start, end, out)) return;
  if (tryHttpABytes(buf, start, end, out)) return;
  if (tryHttpBBytes(buf, start, end, out)) return;
  if (isSocketNoiseBytes(buf, start, end)) {
    out.kind = "empty";
    out.cron = null;
    return;
  }
  out.kind = "unmatched";
  out.cron = null;
}

export function parseLineInto(line: string, out: LineScratch): void {
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
        hour: out.hour >= 0 ? out.hour : undefined,
        date: out.dateStr ?? undefined,
      },
    };
  }
  if (out.kind === "cron") return { kind: "cron", event: out.cron! };
  if (out.kind === "empty") return { kind: "empty" };
  return { kind: "unmatched" };
}
