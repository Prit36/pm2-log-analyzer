import type { CronEventCompact, LogMethod, ParsedLine } from "./types";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"] as const;
const ANSI_RE = /\u001b\[[0-9;]*m/g; // oxlint-disable-line no-control-regex -- ESC for ANSI strip

/** Strip ANSI (kept for callers / tests). Prefer in-scanner skip on the hot path. */
export function stripAnsi(input: string): string {
  if (input.indexOf("\u001b") === -1) return input;
  return input.replace(ANSI_RE, "");
}

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

/** Advance past CSI sequences ESC[ ... final. */
function skipAnsi(s: string, i: number): number {
  while (i < s.length && s.charCodeAt(i) === 0x1b && s.charCodeAt(i + 1) === 91) {
    i += 2;
    while (i < s.length) {
      const c = s.charCodeAt(i++);
      if (c >= 0x40 && c <= 0x7e) break;
    }
  }
  return i;
}

function skipSpaceAnsi(s: string, i: number): number {
  for (;;) {
    i = skipAnsi(s, i);
    if (i >= s.length) return i;
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9) {
      i++;
      continue;
    }
    return i;
  }
}

function onlySpaceAnsiLeft(s: string, i: number): boolean {
  i = skipSpaceAnsi(s, i);
  return i >= s.length;
}

function skipTimestamp(s: string, start: number): { i: number; ts?: string } {
  if (s.length - start < 20) return { i: start };
  const a = start;
  for (let k = 0; k < 10; k++) {
    const c = s.charCodeAt(a + k);
    if (k === 4 || k === 7) {
      if (c !== 45) return { i: start };
    } else if (!isDigit(c)) return { i: start };
  }
  const sep = s.charCodeAt(a + 10);
  if (sep !== 84 && sep !== 32) return { i: start };
  for (let k = 11; k < 19; k++) {
    const c = s.charCodeAt(a + k);
    if (k === 13 || k === 16) {
      if (c !== 58) return { i: start };
    } else if (!isDigit(c)) return { i: start };
  }
  if (s.charCodeAt(a + 19) !== 58) return { i: start };
  return { i: skipSpaceAnsi(s, a + 20), ts: s.slice(a, a + 19) };
}

function parseMethod(s: string, i: number): { method: LogMethod; i: number } | null {
  i = skipSpaceAnsi(s, i);
  for (const m of METHODS) {
    if (!s.startsWith(m, i)) continue;
    const after = i + m.length;
    const next = after < s.length ? s.charCodeAt(after) : 32;
    // space, tab, or ESC (ANSI before next token)
    if (next === 32 || next === 9 || next === 0x1b || after >= s.length) {
      return { method: m, i: after };
    }
  }
  return null;
}

function readToken(s: string, i: number): { token: string; i: number } | null {
  i = skipSpaceAnsi(s, i);
  if (i >= s.length) return null;
  const start = i;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 0x1b) break;
    i++;
  }
  if (i === start) return null;
  return { token: s.slice(start, i), i };
}

function parseFloatAt(s: string, i: number): { value: number; i: number } | null {
  i = skipSpaceAnsi(s, i);
  const start = i;
  while (i < s.length && isDigit(s.charCodeAt(i))) i++;
  if (i < s.length && s.charCodeAt(i) === 46) {
    i++;
    while (i < s.length && isDigit(s.charCodeAt(i))) i++;
  }
  if (i === start) return null;
  const value = Number(s.slice(start, i));
  if (!Number.isFinite(value)) return null;
  return { value, i };
}

function tryHttpA(s: string, start: number, out: LineScratch): boolean {
  let i = skipSpaceAnsi(s, start);
  const tsPart = skipTimestamp(s, i);
  if (tsPart.ts === undefined || tsPart.i === i) return false;
  i = tsPart.i;

  const meth = parseMethod(s, i);
  if (!meth) return false;
  i = meth.i;

  const pathTok = readToken(s, i);
  if (!pathTok) return false;
  i = pathTok.i;

  const statusTok = readToken(s, i);
  if (!statusTok || statusTok.token.length !== 3) return false;
  const status = Number(statusTok.token);
  if (!Number.isFinite(status)) return false;
  i = statusTok.i;

  const dur = parseFloatAt(s, i);
  if (!dur) return false;
  i = skipSpaceAnsi(s, dur.i);
  if (!s.startsWith("ms", i)) return false;
  i = skipSpaceAnsi(s, i + 2);
  if (s.charCodeAt(i) !== 45) return false;
  i = skipSpaceAnsi(s, i + 1);
  if (i >= s.length) return false;
  if (s.charCodeAt(i) === 45) i++;
  else {
    const b0 = i;
    while (i < s.length && isDigit(s.charCodeAt(i))) i++;
    if (i === b0) return false;
  }
  if (!onlySpaceAnsiLeft(s, i)) return false;

  out.kind = "http";
  out.method = meth.method;
  out.path = pathTok.token;
  out.status = status;
  out.durationMs = dur.value;
  out.cron = null;
  return true;
}

function tryHttpB(s: string, start: number, out: LineScratch): boolean {
  let i = skipSpaceAnsi(s, start);
  const dur = parseFloatAt(s, i);
  if (!dur) return false;
  i = skipSpaceAnsi(s, dur.i);
  if (!s.startsWith("ms", i)) return false;
  i = skipSpaceAnsi(s, i + 2);

  const meth = parseMethod(s, i);
  if (!meth) return false;
  i = meth.i;

  const pathTok = readToken(s, i);
  if (!pathTok) return false;
  if (!onlySpaceAnsiLeft(s, pathTok.i)) return false;

  out.kind = "http";
  out.method = meth.method;
  out.path = pathTok.token;
  out.status = 0;
  out.durationMs = dur.value;
  out.cron = null;
  return true;
}

function tryCron(s: string, start: number, out: LineScratch): boolean {
  let i = skipSpaceAnsi(s, start);
  const tsPart = skipTimestamp(s, i);
  if (tsPart.ts !== undefined) i = tsPart.i;

  const cronIdx = s.indexOf("[cron]", i);
  if (cronIdx === -1) return false;
  let k = i;
  while (k < cronIdx) {
    k = skipAnsi(s, k);
    if (k >= cronIdx) break;
    const c = s.charCodeAt(k);
    if (c === 32 || c === 9) {
      k++;
      continue;
    }
    return false;
  }

  i = skipSpaceAnsi(s, cronIdx + 6);

  let event: "start" | "done" | "fail" | null = null;
  if (s.startsWith("start", i) && (i + 5 >= s.length || s.charCodeAt(i + 5) === 32)) {
    event = "start";
    i += 5;
  } else if (s.startsWith("done", i) && (i + 4 >= s.length || s.charCodeAt(i + 4) === 32)) {
    event = "done";
    i += 4;
  } else if (s.startsWith("fail", i) && (i + 4 >= s.length || s.charCodeAt(i + 4) === 32)) {
    event = "fail";
    i += 4;
  } else return false;

  i = skipSpaceAnsi(s, i);
  let name = stripAnsi(s.slice(i)).trim();
  if (!name) return false;

  let durationMs: number | undefined;
  const durMatch = /^(.+?)\s+([0-9.]+)\s*ms\s*$/i.exec(name);
  if (durMatch) {
    name = durMatch[1]!.trim();
    durationMs = Number(durMatch[2]);
  }

  const ev: CronEventCompact = { event, name };
  if (tsPart.ts) ev.ts = tsPart.ts;
  if (durationMs !== undefined) ev.durationMs = durationMs;
  out.kind = "cron";
  out.cron = ev;
  return true;
}

function hasNonSpace(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 32 && c !== 0x1b) return true;
    if (c === 0x1b) {
      i = skipAnsi(s, i) - 1;
    }
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

export function parseLineInto(line: string, out: LineScratch): void {
  if (!hasNonSpace(line)) {
    out.kind = "empty";
    out.cron = null;
    return;
  }

  if (line.indexOf("[cron]") !== -1 && tryCron(line, 0, out)) return;

  if (tryHttpA(line, 0, out)) return;
  if (tryHttpB(line, 0, out)) return;

  out.kind = "unmatched";
  out.cron = null;
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
