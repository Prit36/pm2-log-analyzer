//! High-performance zero-copy byte scanner for MongoDB 4.4+ JSON log lines.

use memchr::memmem;

pub struct ParsedSlowQuery<'a> {
    pub timestamp: &'a str,
    pub epoch_ms: i64,
    pub severity: u8, // b'I', b'W', b'E', b'F'
    pub ns: &'a str,
    pub collection: &'a str,
    pub db: &'a str,
    pub duration_ms: u32,
    pub plan_summary: &'a str,
    pub is_collscan: bool,
    pub keys_examined: u32,
    pub docs_examined: u32,
    pub nreturned: u32,
    pub num_yields: u32,
    pub reslen: u32,
    pub remote: &'a str,
    pub query_hash: &'a str,
    pub plan_cache_key: &'a str,
    pub line: &'a [u8],
}

pub enum ParsedLine<'a> {
    SlowQuery(ParsedSlowQuery<'a>),
    ConnectionAccepted {
        timestamp: &'a str,
        connection_count: u32,
        remote: &'a str,
    },
    ConnectionEnded {
        timestamp: &'a str,
    },
    AuthSuccess {
        timestamp: &'a str,
    },
    AuthFail {
        timestamp: &'a str,
    },
    ClientMetadata {
        driver_name: &'a str,
        driver_version: &'a str,
        platform: &'a str,
        os_name: &'a str,
        os_version: &'a str,
    },
    Checkpoint {
        timestamp: &'a str,
        msg: &'a str,
    },
    Error {
        timestamp: &'a str,
        severity: u8,
        id: u32,
        msg: &'a str,
    },
    Ignored,
}

/// Extract string field value with exact prefix e.g. b"\"ns\":\""
#[inline(always)]
pub fn extract_str_value<'a>(haystack: &'a [u8], prefix: &[u8]) -> Option<&'a str> {
    let pos = memmem::find(haystack, prefix)?;
    let start = pos + prefix.len();
    let mut i = start;
    while i < haystack.len() && haystack[i] != b'"' {
        if haystack[i] == b'\\' {
            i += 2;
        } else {
            i += 1;
        }
    }
    if i <= haystack.len() {
        std::str::from_utf8(&haystack[start..i]).ok()
    } else {
        None
    }
}

/// Extract integer field value with exact prefix e.g. b"\"durationMillis\":"
#[inline(always)]
pub fn extract_u32_value(haystack: &[u8], prefix: &[u8]) -> Option<u32> {
    let pos = memmem::find(haystack, prefix)?;
    let mut i = pos + prefix.len();
    while i < haystack.len() && (haystack[i] == b':' || haystack[i].is_ascii_whitespace()) {
        i += 1;
    }
    let start = i;
    let mut acc = 0u32;
    while i < haystack.len() && haystack[i].is_ascii_digit() {
        acc = acc.wrapping_mul(10).wrapping_add((haystack[i] - b'0') as u32);
        i += 1;
    }
    if i > start {
        Some(acc)
    } else {
        None
    }
}

/// Extract integer field value scanning from end of slice e.g. b"\"durationMillis\":"
#[inline(always)]
pub fn extract_u32_value_rev(haystack: &[u8], prefix: &[u8]) -> Option<u32> {
    let pos = memmem::rfind(haystack, prefix)?;
    let mut i = pos + prefix.len();
    while i < haystack.len() && (haystack[i] == b':' || haystack[i].is_ascii_whitespace()) {
        i += 1;
    }
    let start = i;
    let mut acc = 0u32;
    while i < haystack.len() && haystack[i].is_ascii_digit() {
        acc = acc.wrapping_mul(10).wrapping_add((haystack[i] - b'0') as u32);
        i += 1;
    }
    if i > start {
        Some(acc)
    } else {
        None
    }
}

/// Extract timestamp ISO and epoch ms
#[inline(always)]
pub fn extract_timestamp<'a>(line: &'a [u8]) -> (&'a str, i64) {
    let prefix = b"\"$date\":\"";
    let fast_prefix = b"{\"t\":{\"$date\":\"";
    let start = if line.len() >= 40 && line.starts_with(fast_prefix) {
        fast_prefix.len()
    } else if let Some(pos) = memmem::find(line, prefix) {
        pos + prefix.len()
    } else {
        return ("", 0);
    };

    let mut i = start;
    while i < line.len() && line[i] != b'"' {
        i += 1;
    }
    if let Ok(iso) = std::str::from_utf8(&line[start..i]) {
        let epoch = parse_iso_epoch(iso);
        (iso, epoch)
    } else {
        ("", 0)
    }
}

/// Approximate ISO date string to epoch ms without external chrono crate.
pub fn parse_iso_epoch(iso: &str) -> i64 {
    let bytes = iso.as_bytes();
    if bytes.len() < 19 {
        return 0;
    }
    // Expected: YYYY-MM-DDTHH:MM:SS
    let year = parse_digits(&bytes[0..4]) as i64;
    let month = parse_digits(&bytes[5..7]) as i64;
    let day = parse_digits(&bytes[8..10]) as i64;
    let hour = parse_digits(&bytes[11..13]) as i64;
    let min = parse_digits(&bytes[14..16]) as i64;
    let sec = parse_digits(&bytes[17..19]) as i64;
    let millis = if bytes.len() >= 23 && bytes[19] == b'.' {
        parse_digits(&bytes[20..23]) as i64
    } else {
        0
    };

    // Days since unix epoch 1970-01-01
    let mut days = (year - 1970) * 365 + ((year - 1969) / 4);
    let month_days = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    if month >= 1 && month <= 12 {
        days += month_days[(month - 1) as usize];
        if month > 2 && (year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)) {
            days += 1;
        }
    }
    days += day - 1;

    let total_sec = days * 86400 + hour * 3600 + min * 60 + sec;
    total_sec * 1000 + millis
}

#[inline(always)]
fn parse_digits(slice: &[u8]) -> u32 {
    let mut acc = 0u32;
    for &b in slice {
        if b.is_ascii_digit() {
            acc = acc * 10 + (b - b'0') as u32;
        }
    }
    acc
}

/// Extract command JSON object slice
pub fn extract_command_slice<'a>(line: &'a [u8]) -> Option<&'a [u8]> {
    let prefix = b"\"command\":{";
    if let Some(pos) = memmem::find(line, prefix) {
        let start = pos + 10;
        let mut depth = 1;
        let mut in_str = false;
        let mut i = start + 1;
        while i < line.len() && depth > 0 {
            let c = line[i];
            if in_str {
                if c == b'\\' {
                    i += 2;
                    continue;
                } else if c == b'"' {
                    in_str = false;
                }
            } else if c == b'"' {
                in_str = true;
            } else if c == b'{' {
                depth += 1;
            } else if c == b'}' {
                depth -= 1;
            }
            i += 1;
        }
        return Some(&line[start..i]);
    }
    None
}

/// Parse a single line
pub fn parse_line<'a>(line: &'a [u8]) -> ParsedLine<'a> {
    if line.len() < 10 || line[0] != b'{' {
        return ParsedLine::Ignored;
    }

    // Fast check for Slow Query durationMillis from the end of the line
    if let Some(dur) = extract_u32_value_rev(line, b"\"durationMillis\":") {
        let is_slow_query = memmem::find(line, b"\"msg\":\"Slow query\"").is_some()
            || memmem::find(line, b"\"Slow query\"").is_some();

        if is_slow_query {
            let (timestamp, epoch_ms) = extract_timestamp(line);
            let severity = if let Some(s) = extract_str_value(line, b"\"s\":\"") {
                s.as_bytes().first().copied().unwrap_or(b'I')
            } else {
                b'I'
            };

            let ns = extract_str_value(line, b"\"ns\":\"").unwrap_or("");
            let (db, collection) = if let Some(idx) = ns.find('.') {
                (&ns[..idx], &ns[idx + 1..])
            } else {
                ("unknown", ns)
            };

            let plan_summary = extract_str_value(line, b"\"planSummary\":\"").unwrap_or("");
            let is_collscan = plan_summary.contains("COLLSCAN");
            let keys_examined = extract_u32_value(line, b"\"keysExamined\":").unwrap_or(0);
            let docs_examined = extract_u32_value(line, b"\"docsExamined\":").unwrap_or(0);
            let nreturned = extract_u32_value(line, b"\"nreturned\":").unwrap_or(0);
            let num_yields = extract_u32_value(line, b"\"numYields\":").unwrap_or(0);
            let reslen = extract_u32_value(line, b"\"reslen\":").unwrap_or(0);
            let remote = extract_str_value(line, b"\"remote\":\"").unwrap_or("");
            let query_hash = extract_str_value(line, b"\"queryHash\":\"").unwrap_or("");
            let plan_cache_key = extract_str_value(line, b"\"planCacheKey\":\"").unwrap_or("");

            return ParsedLine::SlowQuery(ParsedSlowQuery {
                timestamp,
                epoch_ms,
                severity,
                ns,
                collection,
                db,
                duration_ms: dur,
                plan_summary,
                is_collscan,
                keys_examined,
                docs_examined,
                nreturned,
                num_yields,
                reslen,
                remote,
                query_hash,
                plan_cache_key,
                line,
            });
        }
    }

    // Check message field
    if let Some(msg) = extract_str_value(line, b"\"msg\":\"") {
        let (timestamp, _) = extract_timestamp(line);
        if msg == "Connection accepted" {
            let connection_count = extract_u32_value(line, b"\"connectionCount\":").unwrap_or(0);
            let remote = extract_str_value(line, b"\"remote\":\"").unwrap_or("");
            return ParsedLine::ConnectionAccepted {
                timestamp,
                connection_count,
                remote,
            };
        }
        if msg == "Connection ended" {
            return ParsedLine::ConnectionEnded { timestamp };
        }
        if msg == "Authentication succeeded" || msg == "Successfully authenticated" {
            return ParsedLine::AuthSuccess { timestamp };
        }
        if msg == "Authentication failed" {
            return ParsedLine::AuthFail { timestamp };
        }
        if msg == "client metadata" {
            return ParsedLine::ClientMetadata {
                driver_name: extract_str_value(line, b"\"name\":\"").unwrap_or("unknown"),
                driver_version: extract_str_value(line, b"\"version\":\"").unwrap_or("unknown"),
                platform: extract_str_value(line, b"\"platform\":\"").unwrap_or("unknown"),
                os_name: extract_str_value(line, b"\"osName\":\"").unwrap_or("unknown"),
                os_version: extract_str_value(line, b"\"osVersion\":\"").unwrap_or("unknown"),
            };
        }
    }

    // Checkpoints
    if let Some(c) = extract_str_value(line, b"\"c\":\"") {
        if c == "WTCHKPT" {
            let (timestamp, _) = extract_timestamp(line);
            let msg = extract_str_value(line, b"\"msg\":\"").unwrap_or("WiredTiger checkpoint");
            return ParsedLine::Checkpoint { timestamp, msg };
        }
    }

    // Severity warnings / errors
    if let Some(s) = extract_str_value(line, b"\"s\":\"") {
        let s_byte = s.as_bytes().first().copied().unwrap_or(b'I');
        if s_byte == b'W' || s_byte == b'E' || s_byte == b'F' {
            let (timestamp, _) = extract_timestamp(line);
            let id = extract_u32_value(line, b"\"id\":").unwrap_or(0);
            let msg = extract_str_value(line, b"\"msg\":\"").unwrap_or("MongoDB log event");
            return ParsedLine::Error {
                timestamp,
                severity: s_byte,
                id,
                msg,
            };
        }
    }

    ParsedLine::Ignored
}
