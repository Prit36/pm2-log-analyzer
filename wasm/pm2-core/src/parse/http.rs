//! HTTP line shapes: `[timestamp] METHOD path status ms - length` and
//! `ms METHOD path`.

use super::scan::{
    is_digit, only_space_ansi_left, parse_float, read_token, skip_space_ansi, skip_timestamp,
};
use super::{LineKind, Method};

#[inline(always)]
fn parse_method(buf: &[u8], mut index: usize, end: usize) -> Option<(Method, usize)> {
    index = skip_space_ansi(buf, index, end);
    if index >= end {
        return None;
    }
    // Fast path: method + space delimiter.
    if let Some(hit) = match_method_with_space(buf, index, end) {
        return Some(hit);
    }
    let (method, length) = match_bare_method(buf, index, end)?;
    let after = index + length;
    if after < end {
        let next = buf[after];
        if next != b' ' && next != b'\t' && next != 0x1b {
            return None;
        }
    }
    Some((method, after))
}

/// `METHOD ` with the trailing space delimiter, the common PM2 form.
#[inline(always)]
fn match_method_with_space(buf: &[u8], index: usize, end: usize) -> Option<(Method, usize)> {
    let rest = &buf[index..end];
    if rest.starts_with(b"GET ") {
        return Some((Method::Get, index + 4));
    }
    if rest.starts_with(b"POST ") {
        return Some((Method::Post, index + 5));
    }
    if rest.starts_with(b"PUT ") {
        return Some((Method::Put, index + 4));
    }
    if rest.starts_with(b"PATCH ") {
        return Some((Method::Patch, index + 6));
    }
    if rest.starts_with(b"DELETE ") {
        return Some((Method::Delete, index + 7));
    }
    if rest.starts_with(b"HEAD ") {
        return Some((Method::Head, index + 5));
    }
    None
}

/// Bare `METHOD`, followed by whitespace, an ANSI escape, or the end of line.
#[inline(always)]
fn match_bare_method(buf: &[u8], index: usize, end: usize) -> Option<(Method, usize)> {
    let rest = &buf[index..end];
    match *rest.first()? {
        b'G' if rest.starts_with(b"GET") => Some((Method::Get, index + 3)),
        b'P' => {
            if rest.starts_with(b"POST") {
                Some((Method::Post, index + 4))
            } else if rest.starts_with(b"PATCH") {
                Some((Method::Patch, index + 5))
            } else if rest.starts_with(b"PUT") {
                Some((Method::Put, index + 3))
            } else {
                None
            }
        }
        b'D' if rest.starts_with(b"DELETE") => Some((Method::Delete, index + 6)),
        b'H' if rest.starts_with(b"HEAD") => Some((Method::Head, index + 4)),
        _ => None,
    }
}

#[inline]
pub(super) fn try_http_a(
    buf: &[u8],
    start: usize,
    end: usize,
    timestamp_body_start: &mut Option<usize>,
) -> Option<LineKind> {
    let index = skip_space_ansi(buf, start, end);
    let (index, hour, date) = parse_timestamp_prefix(buf, index, end, timestamp_body_start);
    let (method, after_method) = parse_method(buf, index, end)?;
    let (path_start, path_end, path_end_index) = read_token(buf, after_method, end)?;
    let after_path = skip_space_ansi(buf, path_end_index, end);
    let (status, after_status) = parse_status(buf, after_path, end)?;
    let (duration, after_duration) = parse_duration_and_separator(buf, after_status, end)?;
    let after_length = skip_response_length(buf, after_duration, end)?;
    if !only_space_ansi_left(buf, after_length, end) {
        return None;
    }
    Some(LineKind::Http {
        method,
        path_start,
        path_end,
        status,
        duration_ms: duration,
        hour,
        date,
    })
}

/// Body start plus hour/date of an optional leading `YYYY-MM-DD[T ]HH:MM:SS:`.
fn parse_timestamp_prefix(
    buf: &[u8],
    index: usize,
    end: usize,
    timestamp_body_start: &mut Option<usize>,
) -> (usize, Option<u8>, Option<[u8; 10]>) {
    match skip_timestamp(buf, index, end) {
        Some((body_start, _, _, hour, date)) => {
            *timestamp_body_start = Some(body_start);
            let index = if body_start != index { body_start } else { index };
            (index, (hour < 24).then_some(hour), Some(date))
        }
        None => {
            *timestamp_body_start = None;
            (index, None, None)
        }
    }
}

/// Three status digits followed by a delimiter or the end of line.
fn parse_status(buf: &[u8], index: usize, end: usize) -> Option<(u16, usize)> {
    if index + 3 > end {
        return None;
    }
    let hundreds = buf[index];
    let tens = buf[index + 1];
    let ones = buf[index + 2];
    if !is_digit(hundreds) || !is_digit(tens) || !is_digit(ones) {
        return None;
    }
    let after_status = index + 3;
    if after_status < end {
        let next = buf[after_status];
        if next != b' ' && next != b'\t' && next != 0x1b {
            return None;
        }
    }
    let status = ((hundreds - b'0') as u16) * 100 + ((tens - b'0') as u16) * 10 + (ones - b'0') as u16;
    Some((status, after_status))
}

/// Duration plus the ` ms - ` separator that follows it.
fn parse_duration_and_separator(buf: &[u8], index: usize, end: usize) -> Option<(f32, usize)> {
    let (duration, after_duration) = parse_float(buf, index, end)?;
    // Fast path: " ms - " is standard PM2 HTTP log format.
    if after_duration + 6 <= end && &buf[after_duration..after_duration + 6] == b" ms - " {
        return Some((duration, after_duration + 6));
    }
    let index = skip_space_ansi(buf, after_duration, end);
    if index + 1 >= end || buf[index] != b'm' || buf[index + 1] != b's' {
        return None;
    }
    let index = skip_space_ansi(buf, index + 2, end);
    if index >= end || buf[index] != b'-' {
        return None;
    }
    Some((duration, skip_space_ansi(buf, index + 1, end)))
}

/// Trailing `-` or byte count after the duration.
fn skip_response_length(buf: &[u8], index: usize, end: usize) -> Option<usize> {
    if index >= end {
        return None;
    }
    if buf[index] == b'-' {
        return Some(index + 1);
    }
    let digits_start = index;
    let mut index = index;
    while index < end && is_digit(buf[index]) {
        index += 1;
    }
    if index == digits_start {
        return None;
    }
    Some(index)
}

#[inline]
pub(super) fn try_http_b(buf: &[u8], start: usize, end: usize) -> Option<LineKind> {
    let index = skip_space_ansi(buf, start, end);
    let (duration, after_duration) = parse_float(buf, index, end)?;
    let index = skip_space_ansi(buf, after_duration, end);
    if index + 1 >= end || buf[index] != b'm' || buf[index + 1] != b's' {
        return None;
    }
    let index = skip_space_ansi(buf, index + 2, end);
    let (method, after_method) = parse_method(buf, index, end)?;
    let (path_start, path_end, after_path) = read_token(buf, after_method, end)?;
    if !only_space_ansi_left(buf, after_path, end) {
        return None;
    }
    Some(LineKind::Http {
        method,
        path_start,
        path_end,
        status: 0,
        duration_ms: duration,
        hour: None,
        date: None,
    })
}
