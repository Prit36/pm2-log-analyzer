//! JSON primitives used by the reaggregation report.

use std::fmt::Write;

/// Nearest-rank percentile of an ascending array.
#[inline(always)]
pub(super) fn calc_percentile(sorted: &[u32], percentile: f64) -> u32 {
    if sorted.is_empty() {
        return 0;
    }
    let index = (((sorted.len() as f64) * (percentile / 100.0)).ceil() as usize).saturating_sub(1);
    sorted[index.min(sorted.len() - 1)]
}

/// Append `text` with JSON string escapes applied.
#[inline]
pub(super) fn write_escaped_json(out: &mut String, text: &str) {
    let bytes = text.as_bytes();
    let mut last = 0;
    for (index, &byte) in bytes.iter().enumerate() {
        let escape = match byte {
            b'"' => r#"\""#,
            b'\\' => r"\\",
            b'\n' => r"\n",
            b'\r' => r"\r",
            b'\t' => r"\t",
            _ => continue,
        };
        if index > last {
            // SAFETY: original string is valid UTF-8, ascii char boundary slice is valid UTF-8
            out.push_str(unsafe { std::str::from_utf8_unchecked(&bytes[last..index]) });
        }
        out.push_str(escape);
        last = index + 1;
    }
    if last < bytes.len() {
        // SAFETY: original string is valid UTF-8, ascii char boundary slice is valid UTF-8
        out.push_str(unsafe { std::str::from_utf8_unchecked(&bytes[last..]) });
    }
}

/// Append an epoch-millisecond instant as an ISO-8601 UTC timestamp.
pub(super) fn write_epoch_to_iso(out: &mut String, epoch_ms: i64) {
    if epoch_ms <= 0 {
        out.push_str("1970-01-01T00:00:00.000Z");
        return;
    }
    let total_seconds = epoch_ms / 1000;
    let second_of_day = (total_seconds % 86400 + 86400) % 86400;
    let (year, month, day) = civil_from_days(total_seconds / 86400);
    let _ = write!(
        out,
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        year,
        month,
        day,
        second_of_day / 3600,
        (second_of_day % 3600) / 60,
        second_of_day % 60,
        epoch_ms % 1000,
    );
}

/// The civil date `days` after 1970-01-01.
fn civil_from_days(mut days: i64) -> (i64, i64, i64) {
    let mut year = 1970;
    loop {
        let days_in_year = 365 + leap_day(year);
        if days < days_in_year {
            break;
        }
        days -= days_in_year;
        year += 1;
    }
    let month_days = [
        31,
        28 + leap_day(year),
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 1;
    for &days_in_month in &month_days {
        if days < days_in_month {
            break;
        }
        days -= days_in_month;
        month += 1;
    }
    (year, month, days + 1)
}

fn leap_day(year: i64) -> i64 {
    i64::from(year % 4 == 0 && (year % 100 != 0 || year % 400 == 0))
}
