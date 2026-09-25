//! JSON primitives used by the reaggregation report.

use std::fmt::Write;

/// Nearest-rank percentile without sorting the full duration array.
#[inline(always)]
pub(super) fn calc_percentile(values: &mut [u32], percentile: f64) -> u32 {
    if values.is_empty() {
        return 0;
    }
    let index = percentile_index(values.len(), percentile);
    *values.select_nth_unstable(index).1
}

/// The summary's four nearest-rank percentiles, found from high to low rank.
pub(super) fn calc_percentiles4(values: &mut [u32]) -> [u32; 4] {
    if values.is_empty() {
        return [0; 4];
    }
    let ranks = [50.0, 90.0, 95.0, 99.0].map(|p| percentile_index(values.len(), p));
    let mut result = [0; 4];
    let mut end = values.len();
    for index in (0..4).rev() {
        if index < 3 && ranks[index] == ranks[index + 1] {
            result[index] = result[index + 1];
            continue;
        }
        result[index] = *values[..end].select_nth_unstable(ranks[index]).1;
        end = ranks[index];
    }
    result
}

#[inline(always)]
fn percentile_index(len: usize, percentile: f64) -> usize {
    (((len as f64) * (percentile / 100.0)).ceil() as usize).saturating_sub(1)
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

#[cfg(test)]
mod tests {
    use super::{calc_percentile, calc_percentiles4, percentile_index};

    fn expected(values: &[u32], percentile: f64) -> u32 {
        if values.is_empty() {
            return 0;
        }
        let mut sorted = values.to_vec();
        sorted.sort_unstable();
        sorted[percentile_index(sorted.len(), percentile)]
    }

    #[test]
    fn percentile_selection_matches_nearest_rank() {
        for values in [
            vec![],
            vec![7],
            vec![9, 1],
            vec![8, 2, 5],
            vec![11, 1, 9, 3, 7, 5],
            vec![4, 4, 4, 1, 9, 9, 2, 7],
        ] {
            let expected = [50.0, 90.0, 95.0, 99.0].map(|p| expected(&values, p));
            let mut selected = values.clone();
            assert_eq!(calc_percentiles4(&mut selected), expected);
        }

        let mut values = [9, 1, 5, 3, 7];
        assert_eq!(calc_percentile(&mut values, 95.0), 9);
    }
}
