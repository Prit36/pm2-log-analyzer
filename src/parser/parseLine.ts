import type { CronEventCompact, LogMethod, ParsedLine } from "./types";

// oxlint-disable-next-line no-control-regex -- intentional ESC (0x1b) for ANSI strip
const ANSI_REGEX = /\u001b\[[0-9;]*m/g;

/** Pattern A: `2026-07-24T00:00:10: GET /api/... 200 150.517 ms - 379` (timestamp required). */
const LINE_REGEX_A =
  /^\s*(?:\d{4}-\d{2}-\d{2}(?:T|\s)\d{2}:\d{2}:\d{2}):\s*(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+(\S+)\s+(\d{3})\s+([0-9.]+)\s*ms\s*-\s*(-|\d+)\s*$/;

/** Pattern B: duration-first `68064.174ms\tPOST /api/...` */
const LINE_REGEX_B =
  /^\s*([0-9.]+)\s*ms\s*[\t ]+\s*(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+(\S+)\s*$/;

const CRON_REGEX =
  /^\s*(?:(\d{4}-\d{2}-\d{2}(?:T|\s)\d{2}:\d{2}:\d{2}):\s*)?\[cron\]\s+(start|done|fail)\s+(.+?)\s*$/i;

export function stripAnsi(input: string): string {
  return input.replace(ANSI_REGEX, "");
}

export function parseLine(line: string): ParsedLine {
  if (!line.trim()) return { kind: "empty" };

  const clean = stripAnsi(line).trim();

  const cronMatch = clean.match(CRON_REGEX);
  if (cronMatch) {
    const ts = cronMatch[1];
    const event = cronMatch[2]!.toLowerCase() as "start" | "done" | "fail";
    let name = cronMatch[3]!.trim();
    let durationMs: number | undefined;
    const durMatch = name.match(/^(.+?)\s+([0-9.]+)\s*ms\s*$/);
    if (durMatch) {
      name = durMatch[1]!.trim();
      durationMs = Number(durMatch[2]);
    }
    const ev: CronEventCompact = { event, name };
    if (ts) ev.ts = ts;
    if (durationMs !== undefined) ev.durationMs = durationMs;
    return { kind: "cron", event: ev };
  }

  const matchA = clean.match(LINE_REGEX_A);
  if (matchA) {
    return {
      kind: "http",
      hit: {
        method: matchA[1] as LogMethod,
        path: matchA[2]!,
        status: Number(matchA[3]),
        durationMs: Number(matchA[4]),
      },
    };
  }

  const matchB = clean.match(LINE_REGEX_B);
  if (matchB) {
    return {
      kind: "http",
      hit: {
        method: matchB[2] as LogMethod,
        path: matchB[3]!,
        status: 0,
        durationMs: Number(matchB[1]),
      },
    };
  }

  return { kind: "unmatched" };
}
