//! Byte-level PM2 log line parser.

mod cron;
mod http;
mod noise;
mod scan;

#[cfg(test)]
mod tests;

use cron::try_cron;
use http::{try_http_a, try_http_b};
use noise::is_socket_noise;
use scan::{find_cron_mark, has_non_space, skip_space_ansi};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    Get = 0,
    Post = 1,
    Put = 2,
    Patch = 3,
    Delete = 4,
    Head = 5,
}

#[derive(Clone, Debug)]
pub enum LineKind {
    Empty,
    Http {
        method: Method,
        path_start: usize,
        path_end: usize,
        status: u16,
        duration_ms: f32,
        hour: Option<u8>,
        date: Option<[u8; 10]>,
    },
    Cron {
        event: u8, // 0=start 1=done 2=fail
        name: Vec<u8>,
        ts: Option<Vec<u8>>,
        duration_ms: Option<f32>,
    },
    Unmatched,
}

/// Parse one line from raw bytes [start, end).
pub fn parse_line_bytes(buf: &[u8], start: usize, mut end: usize) -> LineKind {
    if end > start && buf[end - 1] == b'\r' {
        end -= 1;
    }
    if start >= end {
        return LineKind::Empty;
    }
    let gate = skip_space_ansi(buf, start, end);
    if gate >= end {
        return LineKind::Empty;
    }
    let first = buf[gate];
    let mut timestamp_body_start = None;
    if let Some(kind) = try_structured_line(buf, start, end, first, &mut timestamp_body_start) {
        return kind;
    }
    if is_socket_candidate(first) && is_socket_noise(buf, start, end, timestamp_body_start) {
        // Socket.IO / socket tracking lines are pure noise — skip like empty lines.
        return LineKind::Empty;
    }
    classify_unmatched(buf, start, end, gate)
}

/// The three structured shapes, tried in the parser's established order.
#[inline]
fn try_structured_line(
    buf: &[u8],
    start: usize,
    end: usize,
    first: u8,
    timestamp_body_start: &mut Option<usize>,
) -> Option<LineKind> {
    let method_start = matches!(first, b'G' | b'P' | b'H' | b'D');
    // httpB (duration-first) allows a leading '.' (e.g. `.5ms GET /x`).
    let float_start = first.is_ascii_digit() || first == b'.';
    if method_start || float_start {
        if let Some(kind) = try_http_a(buf, start, end, timestamp_body_start) {
            return Some(kind);
        }
    }
    if first == b'[' {
        return try_cron(buf, start, end);
    }
    // Timestamp-first lines may still embed `[cron]` after the timestamp.
    if float_start && first.is_ascii_digit() && find_cron_mark(buf, start, end).is_some() {
        if let Some(kind) = try_cron(buf, start, end) {
            return Some(kind);
        }
    }
    if float_start {
        return try_http_b(buf, start, end);
    }
    None
}

/// Only these leading bytes can start a socket-noise shape. Avoid reparsing the
/// timestamp/body for ordinary unmatched payload lines.
#[inline(always)]
fn is_socket_candidate(first: u8) -> bool {
    first.is_ascii_digit()
        || matches!(
            first,
            b'N' | b'd' | b'j' | b'l' | b'T' | b'm' | b'a' | b'i' | b'{' | b'}' | b'[' | b']',
        )
}

/// A payload line is unmatched unless it holds no visible bytes at all.
#[inline]
fn classify_unmatched(buf: &[u8], start: usize, end: usize, gate: usize) -> LineKind {
    if buf[gate] > 32 || has_non_space(buf, start, end) {
        LineKind::Unmatched
    } else {
        LineKind::Empty
    }
}
