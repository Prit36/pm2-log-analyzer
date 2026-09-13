//! Byte-scanning primitives shared by the line-shape parsers.

use memchr::{memchr, memchr3, memmem};

pub(super) const CRON_MARK: &[u8] = b"[cron]";

#[inline(always)]
pub(super) fn is_digit(byte: u8) -> bool {
    byte.is_ascii_digit()
}

/// Skip ANSI CSI escapes (`ESC [` ... final byte).
#[inline(always)]
pub(super) fn skip_ansi(buf: &[u8], mut index: usize, end: usize) -> usize {
    while index + 1 < end && buf[index] == 0x1b && buf[index + 1] == b'[' {
        index += 2;
        while index < end {
            let byte = buf[index];
            index += 1;
            if (0x40..=0x7e).contains(&byte) {
                break;
            }
        }
    }
    index
}

/// Skip spaces, tabs, and ANSI escapes.
#[inline(always)]
pub(super) fn skip_space_ansi(buf: &[u8], mut index: usize, end: usize) -> usize {
    while index < end {
        let byte = buf[index];
        if byte == b' ' || byte == b'\t' {
            index += 1;
            continue;
        }
        if byte == 0x1b && index + 1 < end && buf[index + 1] == b'[' {
            index = skip_ansi(buf, index, end);
            continue;
        }
        break;
    }
    index
}

#[inline(always)]
pub(super) fn only_space_ansi_left(buf: &[u8], index: usize, end: usize) -> bool {
    skip_space_ansi(buf, index, end) >= end
}

/// Four ASCII digits, tested branchlessly: subtracting `0` and adding `0x46`
/// can only both stay inside the sign bit for bytes in the `0`..`9` window.
#[inline(always)]
pub(super) fn is_digits_4(bytes: &[u8]) -> bool {
    let value = u32::from_le_bytes(bytes[..4].try_into().unwrap());
    let at_least_zero = value.wrapping_sub(0x3030_3030);
    let at_most_nine = value.wrapping_add(0x4646_4646);
    ((at_least_zero | at_most_nine) & 0x8080_8080) == 0
}

#[inline(always)]
pub(super) fn is_digits_2(bytes: &[u8]) -> bool {
    let value = u16::from_le_bytes(bytes[..2].try_into().unwrap());
    let at_least_zero = value.wrapping_sub(0x3030);
    let at_most_nine = value.wrapping_add(0x4646);
    ((at_least_zero | at_most_nine) & 0x8080) == 0
}

/// `YYYY-MM-DD[T ]HH:MM:SS:` at `start`. Returns the body start after it, the
/// timestamp span, the hour, and the date bytes.
#[inline]
pub(super) fn skip_timestamp(
    buf: &[u8],
    start: usize,
    end: usize,
) -> Option<(usize, usize, usize, u8, [u8; 10])> {
    if end - start < 20 {
        return None;
    }
    let stamp = &buf[start..start + 20];
    if stamp[4] != b'-' || stamp[7] != b'-' || stamp[13] != b':' || stamp[16] != b':'
        || stamp[19] != b':'
    {
        return None;
    }
    let separator = stamp[10];
    if separator != b'T' && separator != b' ' {
        return None;
    }
    if !is_digits_4(&stamp[0..4])
        || !is_digits_2(&stamp[5..7])
        || !is_digits_2(&stamp[8..10])
        || !is_digits_2(&stamp[11..13])
        || !is_digits_2(&stamp[14..16])
        || !is_digits_2(&stamp[17..19])
    {
        return None;
    }
    let hour = (stamp[11] - b'0') * 10 + (stamp[12] - b'0');
    let mut date = [0u8; 10];
    date.copy_from_slice(&stamp[0..10]);
    Some((skip_space_ansi(buf, start + 20, end), start, start + 19, hour, date))
}

/// Path token: stops at space, tab, or an ANSI escape.
#[inline(always)]
pub(super) fn read_token(buf: &[u8], mut index: usize, end: usize) -> Option<(usize, usize, usize)> {
    index = skip_space_ansi(buf, index, end);
    if index >= end {
        return None;
    }
    let token_len = memchr3(b' ', b'\t', 0x1b, &buf[index..end]).unwrap_or(end - index);
    if token_len == 0 {
        return None;
    }
    let token_end = index + token_len;
    Some((index, token_end, token_end))
}

const INV_POW10: [f32; 10] = [
    1.0,
    0.1,
    0.01,
    0.001,
    0.0001,
    0.00001,
    0.000001,
    0.0000001,
    0.00000001,
    0.000000001,
];

#[inline(always)]
pub(super) fn parse_float(buf: &[u8], mut index: usize, end: usize) -> Option<(f32, usize)> {
    index = skip_space_ansi(buf, index, end);
    if index >= end || (!is_digit(buf[index]) && buf[index] != b'.') {
        return None;
    }
    let start = index;
    let (integer, after_integer) = consume_digits(buf, index, end);
    index = after_integer;
    if index < end && buf[index] == b'.' {
        index += 1;
        let fraction_start = index;
        let (fraction, after_fraction) = consume_digits(buf, index, end);
        let fraction_digits = after_fraction - fraction_start;
        index = after_fraction;
        if index == start || (index == fraction_start && fraction_start == start + 1) {
            return None;
        }
        let scale = if fraction_digits < INV_POW10.len() {
            INV_POW10[fraction_digits]
        } else {
            10.0f32.powi(-(fraction_digits as i32))
        };
        return Some(((integer as f32) + (fraction as f32) * scale, index));
    }
    if index == start {
        return None;
    }
    Some((integer as f32, index))
}

/// Decimal digits as `u32`, wrapping like the original multiply loop did.
#[inline(always)]
fn consume_digits(buf: &[u8], mut index: usize, end: usize) -> (u32, usize) {
    let mut value = 0u32;
    while index < end && is_digit(buf[index]) {
        value = value * 10 + (buf[index] - b'0') as u32;
        index += 1;
    }
    (value, index)
}

pub(super) fn find_cron_mark(buf: &[u8], from: usize, end: usize) -> Option<usize> {
    if from >= end {
        return None;
    }
    // Most lines have no '[' — skip full-line memmem for "[cron]".
    if memchr(b'[', &buf[from..end]).is_none() {
        return None;
    }
    memmem::find(&buf[from..end], CRON_MARK).map(|relative| from + relative)
}

pub(super) fn has_non_space(buf: &[u8], start: usize, end: usize) -> bool {
    let mut index = start;
    while index < end {
        let byte = buf[index];
        if byte > 32 && byte != 0x1b {
            return true;
        }
        if byte == 0x1b && index + 1 < end && buf[index + 1] == b'[' {
            index = skip_ansi(buf, index, end);
            continue;
        }
        index += 1;
    }
    false
}

pub(super) fn strip_ansi_bytes(buf: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(buf.len());
    let mut index = 0;
    while index < buf.len() {
        if index + 1 < buf.len() && buf[index] == 0x1b && buf[index + 1] == b'[' {
            index = skip_ansi(buf, index, buf.len());
            continue;
        }
        out.push(buf[index]);
        index += 1;
    }
    out
}

/// Trim spaces and tabs from both ends; other bytes stay verbatim.
pub(super) fn trim_spaces_and_tabs(bytes: &[u8]) -> &[u8] {
    let mut start = 0;
    while start < bytes.len() && (bytes[start] == b' ' || bytes[start] == b'\t') {
        start += 1;
    }
    let mut end = bytes.len();
    while end > start && (bytes[end - 1] == b' ' || bytes[end - 1] == b'\t') {
        end -= 1;
    }
    &bytes[start..end]
}

/// Trim spaces and tabs from the end; other bytes stay verbatim.
pub(super) fn trim_spaces_and_tabs_end(bytes: &[u8]) -> &[u8] {
    let mut end = bytes.len();
    while end > 0 && (bytes[end - 1] == b' ' || bytes[end - 1] == b'\t') {
        end -= 1;
    }
    &bytes[..end]
}
