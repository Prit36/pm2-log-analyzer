//! `[cron]` line shape: `[timestamp] [cron] start|done|fail NAME [DURATIONms]`.

use super::scan::{
    find_cron_mark, parse_float, skip_ansi, skip_space_ansi, skip_timestamp, strip_ansi_bytes,
    trim_spaces_and_tabs, trim_spaces_and_tabs_end,
};
use super::LineKind;

#[inline]
pub(super) fn try_cron(buf: &[u8], start: usize, end: usize) -> Option<LineKind> {
    let index = skip_space_ansi(buf, start, end);
    let timestamp = skip_timestamp(buf, index, end);
    let index = match timestamp {
        Some((body_start, _, _, _, _)) => body_start,
        None => index,
    };
    let cron_index = find_cron_mark(buf, index, end)?;
    skip_to_cron_index(buf, index, cron_index, end)?;
    let (event, after_event) = parse_cron_event(buf, cron_index + 6, end)?;
    let name = parse_cron_name(buf, after_event, end)?;
    let (name, duration_ms) = split_cron_duration(name);
    let ts = timestamp.map(|(_, ts_start, ts_end, _, _)| buf[ts_start..ts_end].to_vec());
    Some(LineKind::Cron {
        event,
        name,
        ts,
        duration_ms,
    })
}

/// Between the timestamp and `[cron]` only whitespace and ANSI escapes may sit.
fn skip_to_cron_index(buf: &[u8], start: usize, cron_index: usize, end: usize) -> Option<()> {
    let mut index = start;
    while index < cron_index {
        index = skip_ansi(buf, index, end);
        if index >= cron_index {
            break;
        }
        let byte = buf[index];
        if byte == b' ' || byte == b'\t' {
            index += 1;
            continue;
        }
        return None;
    }
    Some(())
}

/// `start` / `done` / `fail` after the `[cron]` mark, with `event` 0/1/2.
fn parse_cron_event(buf: &[u8], index: usize, end: usize) -> Option<(u8, usize)> {
    let index = skip_space_ansi(buf, index, end);
    let rest = &buf[index..end];
    for (literal, event) in [
        (b"start".as_slice(), 0u8),
        (b"done".as_slice(), 1u8),
        (b"fail".as_slice(), 2u8),
    ] {
        if !rest.starts_with(literal) {
            continue;
        }
        let after = index + literal.len();
        if after >= end || buf[after] == b' ' {
            return Some((event, after));
        }
    }
    None
}

/// ANSI-stripped, space-trimmed event name; an empty name is not a cron line.
fn parse_cron_name(buf: &[u8], index: usize, end: usize) -> Option<Vec<u8>> {
    let name = strip_ansi_bytes(&buf[skip_space_ansi(buf, index, end)..end]);
    let trimmed = trim_spaces_and_tabs(&name);
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.len() == name.len() {
        return Some(name);
    }
    Some(trimmed.to_vec())
}

/// Trailing ` NAME DURATIONms` becomes `(NAME, Some(DURATION))`.
fn split_cron_duration(name: Vec<u8>) -> (Vec<u8>, Option<f32>) {
    let Some(without_ms) = name.strip_suffix(b"ms") else {
        return (name, None);
    };
    let body = trim_spaces_and_tabs_end(without_ms);
    let Some(space_index) = body.iter().rposition(|&byte| byte == b' ' || byte == b'\t') else {
        return (name, None);
    };
    let number = &body[space_index + 1..];
    let name_part = trim_spaces_and_tabs_end(&body[..space_index]);
    if name_part.is_empty() {
        return (name, None);
    }
    match parse_float(number, 0, number.len()) {
        Some((duration, consumed)) if consumed == number.len() => {
            (name_part.to_vec(), Some(duration))
        }
        _ => (name, None),
    }
}
