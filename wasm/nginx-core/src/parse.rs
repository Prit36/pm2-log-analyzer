use std::borrow::Cow;

use crate::{Engine, Row, Timing};

struct Parsed<'a> {
    client: &'a [u8],
    /// `METHOD path`: the request line without its protocol.
    endpoint: Cow<'a, [u8]>,
    referrer: Cow<'a, [u8]>,
    agent: Cow<'a, [u8]>,
    date: [u8; 10],
    hour: u8,
    time_key: u32,
    status: u16,
    bytes: u64,
    request_ms: f32,
    upstream_ms: f32,
    invalid_timings: u64,
}

/// `u8::is_ascii_whitespace` as one table load instead of five comparisons.
static WHITESPACE: [bool; 256] = {
    let mut table = [false; 256];
    let mut byte = 0;
    while byte < 256 {
        table[byte] = (byte as u8).is_ascii_whitespace();
        byte += 1;
    }
    table
};

fn spaces(line: &[u8], cursor: &mut usize) {
    while *cursor < line.len() && WHITESPACE[line[*cursor] as usize] {
        *cursor += 1;
    }
}

fn token<'a>(line: &'a [u8], cursor: &mut usize) -> Option<&'a [u8]> {
    spaces(line, cursor);
    let start = *cursor;
    while *cursor < line.len() && !WHITESPACE[line[*cursor] as usize] {
        *cursor += 1;
    }
    (*cursor > start).then_some(&line[start..*cursor])
}

fn hex(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn quoted<'a>(line: &'a [u8], cursor: &mut usize) -> Option<Cow<'a, [u8]>> {
    spaces(line, cursor);
    if line.get(*cursor) != Some(&b'"') {
        return None;
    }
    *cursor += 1;
    let start = *cursor;
    let mut escaped = false;
    while let Some(offset) = memchr::memchr2(b'"', b'\\', &line[*cursor..]) {
        *cursor += offset;
        match line[*cursor] {
            b'"' => {
                let raw = &line[start..*cursor];
                *cursor += 1;
                if !escaped {
                    return Some(Cow::Borrowed(raw));
                }
                let mut decoded = Vec::with_capacity(raw.len());
                let mut offset = 0;
                while offset < raw.len() {
                    if raw[offset] == b'\\' && offset + 1 < raw.len() {
                        if raw[offset + 1] == b'x' && offset + 3 < raw.len() {
                            if let (Some(a), Some(b)) = (hex(raw[offset + 2]), hex(raw[offset + 3]))
                            {
                                decoded.push(a * 16 + b);
                                offset += 4;
                                continue;
                            }
                        }
                        offset += 1;
                    }
                    decoded.push(raw[offset]);
                    offset += 1;
                }
                return Some(Cow::Owned(decoded));
            }
            _ => {
                // A backslash escapes the next byte, including a quote.
                escaped = true;
                *cursor = (*cursor + 2).min(line.len());
            }
        }
    }
    None
}

fn integer(bytes: &[u8]) -> Option<u64> {
    if bytes.is_empty() {
        return None;
    }
    // Nineteen decimal digits always fit in u64, so short values skip overflow checks.
    if bytes.len() <= 19 {
        let mut value = 0u64;
        for &byte in bytes {
            let digit = byte.wrapping_sub(b'0');
            if digit > 9 {
                return None;
            }
            value = value * 10 + u64::from(digit);
        }
        return Some(value);
    }
    let mut value = 0u64;
    for &byte in bytes {
        if !byte.is_ascii_digit() {
            return None;
        }
        value = value.checked_mul(10)?.checked_add(u64::from(byte - b'0'))?;
    }
    Some(value)
}

/// Returns the `YYYY-MM-DD` label, the hour, and a numeric key ordered by (date, hour).
fn timestamp(bytes: &[u8]) -> Option<([u8; 10], u8, u32)> {
    if bytes.len() != 26
        || bytes[2] != b'/'
        || bytes[6] != b'/'
        || bytes[11] != b':'
        || bytes[14] != b':'
        || bytes[17] != b':'
        || bytes[20] != b' '
        || !matches!(bytes[21], b'+' | b'-')
    {
        return None;
    }
    let month = match &bytes[3..6] {
        b"Jan" => 1,
        b"Feb" => 2,
        b"Mar" => 3,
        b"Apr" => 4,
        b"May" => 5,
        b"Jun" => 6,
        b"Jul" => 7,
        b"Aug" => 8,
        b"Sep" => 9,
        b"Oct" => 10,
        b"Nov" => 11,
        b"Dec" => 12,
        _ => return None,
    };
    let year = integer(&bytes[7..11])?;
    let day = integer(&bytes[..2])?;
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    let hour = integer(&bytes[12..14])?;
    if day == 0
        || day > days
        || hour > 23
        || integer(&bytes[15..17])? > 59
        || integer(&bytes[18..20])? > 59
        || integer(&bytes[22..24])? > 23
        || integer(&bytes[24..26])? > 59
    {
        return None;
    }
    let mut date = *b"0000-00-00";
    date[..4].copy_from_slice(&bytes[7..11]);
    date[5] = b'0' + month / 10;
    date[6] = b'0' + month % 10;
    date[8..].copy_from_slice(&bytes[..2]);
    let key = ((year as u32 * 12 + u32::from(month) - 1) * 31 + day as u32 - 1) * 24 + hour as u32;
    Some((date, hour as u8, key))
}

fn seconds(bytes: &[u8]) -> Option<f64> {
    let mut value = 0.0;
    let mut fraction = 0.1;
    let mut decimal = false;
    let mut digits = false;
    for &byte in bytes {
        if byte == b'.' && !decimal {
            decimal = true;
            continue;
        }
        if !byte.is_ascii_digit() {
            return None;
        }
        digits = true;
        if decimal {
            value += f64::from(byte - b'0') * fraction;
            fraction *= 0.1;
        } else {
            value = value * 10.0 + f64::from(byte - b'0');
        }
    }
    (digits && value.is_finite()).then_some(value)
}

fn timing(bytes: &[u8], upstream: bool) -> (f32, bool) {
    let bytes = bytes.trim_ascii();
    if bytes.is_empty() {
        return (f32::NAN, true);
    }
    if bytes == b"-" {
        return (f32::NAN, false);
    }
    let mut sum = 0.0;
    let mut found = false;
    for attempt in bytes.split(|byte| upstream && matches!(byte, b',' | b':')) {
        let attempt = attempt.trim_ascii();
        if attempt == b"-" {
            continue;
        }
        let Some(value) = seconds(attempt) else {
            return (f32::NAN, true);
        };
        sum += value;
        found = true;
    }
    let millis = (sum * 1000.0) as f32;
    if !millis.is_finite() {
        return (f32::NAN, true);
    }
    (if found { millis } else { f32::NAN }, false)
}

fn parse(line: &[u8]) -> Option<Parsed<'_>> {
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    let mut cursor = 0;
    let client = token(line, &mut cursor)?;
    token(line, &mut cursor)?;
    token(line, &mut cursor)?;
    spaces(line, &mut cursor);
    if line.get(cursor) != Some(&b'[') {
        return None;
    }
    cursor += 1;
    let end = cursor + memchr::memchr(b']', &line[cursor..])?;
    let (date, hour, time_key) = timestamp(&line[cursor..end])?;
    cursor = end + 1;
    let request = quoted(line, &mut cursor)?;
    let endpoint = if request.as_ref() == b"-" {
        Cow::Borrowed(b"- -".as_slice())
    } else {
        let first = memchr::memchr(b' ', &request)?;
        let last = memchr::memrchr(b' ', &request)?;
        if first == 0
            || last <= first + 1
            || !request[last + 1..].starts_with(b"HTTP/")
            || !request[..first].iter().all(|byte| byte.is_ascii_graphic())
        {
            return None;
        }
        match request {
            Cow::Borrowed(bytes) => Cow::Borrowed(&bytes[..last]),
            Cow::Owned(mut bytes) => {
                bytes.truncate(last);
                Cow::Owned(bytes)
            }
        }
    };
    let status = integer(token(line, &mut cursor)?)?;
    if !(100..=599).contains(&status) {
        return None;
    }
    let bytes = token(line, &mut cursor)?;
    let bytes = if bytes == b"-" { 0 } else { integer(bytes)? };
    let referrer = quoted(line, &mut cursor)?;
    let agent = quoted(line, &mut cursor)?;
    let mut request_ms = f32::NAN;
    let mut upstream_ms = f32::NAN;
    let mut invalid_timings = 0;
    while cursor < line.len() {
        spaces(line, &mut cursor);
        let start = cursor;
        while cursor < line.len() && !line[cursor].is_ascii_whitespace() && line[cursor] != b'=' {
            cursor += 1;
        }
        if line.get(cursor) != Some(&b'=') {
            continue;
        }
        let key = &line[start..cursor];
        cursor += 1;
        let value = if line.get(cursor) == Some(&b'"') {
            let Some(value) = quoted(line, &mut cursor) else {
                if key == b"rt" || key == b"urt" {
                    invalid_timings += 1;
                }
                break;
            };
            value
        } else {
            let start = cursor;
            while cursor < line.len() {
                if line[cursor].is_ascii_whitespace() {
                    let mut lookahead = cursor;
                    if let Some(next) = token(line, &mut lookahead) {
                        if next.contains(&b'=') {
                            break;
                        }
                    } else {
                        cursor = line.len();
                        break;
                    }
                }
                cursor += 1;
            }
            Cow::Borrowed(&line[start..cursor])
        };
        if key == b"rt" || key == b"urt" {
            let (value, invalid) = timing(&value, key == b"urt");
            invalid_timings += u64::from(invalid);
            if key == b"rt" {
                request_ms = value;
            } else {
                upstream_ms = value;
            }
        }
    }
    Some(Parsed {
        client,
        endpoint,
        referrer,
        agent,
        date,
        hour,
        time_key,
        status: status as u16,
        bytes,
        request_ms,
        upstream_ms,
        invalid_timings,
    })
}

/// Structural format detection used before the generic HTTP/PM2 classifier.
pub fn is_access_line(line: &[u8]) -> bool {
    parse(line).is_some()
}

fn compact_key(ms: f32) -> i16 {
    if ms == 0.0 {
        return i16::MIN + 1;
    }
    pm2_core::relhist_key(ms).map_or(i16::MIN, |key| {
        key.clamp(i16::MIN as i32 + 2, i16::MAX as i32) as i16
    })
}

impl Engine {
    pub(crate) fn accept_line(&mut self, line: &[u8]) {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if line.trim_ascii().is_empty() {
            return;
        }
        self.diagnostics.total_lines += 1;
        let Some(parsed) = parse(line) else {
            self.diagnostics.unmatched_count += 1;
            if self.diagnostics.unmatched_sample.len() < 40 {
                let sample = String::from_utf8_lossy(&line[..line.len().min(500)]).into_owned();
                self.diagnostics.unmatched_sample.push(sample);
            }
            return;
        };
        self.diagnostics.matched_lines += 1;
        self.diagnostics.invalid_timing_count += parsed.invalid_timings;
        let (endpoint, new_endpoint) = self.endpoints.intern(&parsed.endpoint);
        if new_endpoint {
            // A method never contains a space, so the endpoint splits at the first one.
            let space = memchr::memchr(b' ', &parsed.endpoint).unwrap_or(parsed.endpoint.len());
            self.methods.intern(&parsed.endpoint[..space]);
        }
        let request_key = compact_key(parsed.request_ms);
        let upstream_key = compact_key(parsed.upstream_ms);
        let timing = (request_key != i16::MIN || upstream_key != i16::MIN).then_some(Timing {
            request_ms: parsed.request_ms,
            upstream_ms: parsed.upstream_ms,
            request_key,
            upstream_key,
        });
        let row = Row {
            endpoint,
            visitor: self.visitor_id(parsed.client, &parsed.referrer, &parsed.agent),
            time: self.time_id(parsed.time_key, parsed.date, parsed.hour),
            bytes: 0,
            status: parsed.status,
            timed: false,
        };
        self.push_row(row, parsed.bytes, timing);
    }
}
