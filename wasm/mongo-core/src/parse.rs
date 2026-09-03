//! High-performance zero-copy byte scanner for MongoDB 4.4+ JSON log lines.

use memchr::memmem;

pub struct ParsedSlowQuery<'a> {
    pub timestamp: &'a str,
    pub epoch_ms: i64,
    pub severity: u8, // b'I', b'W', b'E', b'F'
    pub ctx: &'a str,
    pub user: &'a str,
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
        ctx: &'a str,
        connection_count: u32,
        remote: &'a str,
    },
    ConnectionEnded {
        timestamp: &'a str,
        ctx: &'a str,
    },
    AuthSuccess {
        timestamp: &'a str,
        ctx: &'a str,
        user: &'a str,
        db: &'a str,
        client: &'a str,
        app_name: &'a str,
    },
    AuthFail {
        timestamp: &'a str,
        ctx: &'a str,
        user: &'a str,
        errmsg: &'a str,
    },
    ClientMetadata {
        ctx: &'a str,
        app_name: &'a str,
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

use std::sync::LazyLock;

pub static MSG_FINDER: LazyLock<memmem::Finder<'static>> = LazyLock::new(|| memmem::Finder::new(b"\"msg\":\""));
pub static S_FINDER: LazyLock<memmem::Finder<'static>> = LazyLock::new(|| memmem::Finder::new(b"\"s\":\""));
pub static CTX_FINDER: LazyLock<memmem::Finder<'static>> = LazyLock::new(|| memmem::Finder::new(b"\"ctx\":\""));
pub static NS_FINDER: LazyLock<memmem::Finder<'static>> = LazyLock::new(|| memmem::Finder::new(b"\"ns\":\""));
pub static PLAN_FINDER: LazyLock<memmem::Finder<'static>> = LazyLock::new(|| memmem::Finder::new(b"\"planSummary\":\""));
pub static KEYS_FINDER: LazyLock<memmem::Finder<'static>> = LazyLock::new(|| memmem::Finder::new(b"\"keysExamined\":"));
pub static DOCS_FINDER: LazyLock<memmem::Finder<'static>> = LazyLock::new(|| memmem::Finder::new(b"\"docsExamined\":"));
pub static RET_FINDER: LazyLock<memmem::Finder<'static>> = LazyLock::new(|| memmem::Finder::new(b"\"nreturned\":"));
pub static YIELDS_FINDER: LazyLock<memmem::Finder<'static>> = LazyLock::new(|| memmem::Finder::new(b"\"numYields\":"));
pub static RESLEN_FINDER: LazyLock<memmem::Finder<'static>> = LazyLock::new(|| memmem::Finder::new(b"\"reslen\":"));
pub static REMOTE_FINDER: LazyLock<memmem::Finder<'static>> = LazyLock::new(|| memmem::Finder::new(b"\"remote\":\""));
pub static HASH_FINDER: LazyLock<memmem::Finder<'static>> = LazyLock::new(|| memmem::Finder::new(b"\"queryHash\":\""));
pub static PLAN_KEY_FINDER: LazyLock<memmem::Finder<'static>> = LazyLock::new(|| memmem::Finder::new(b"\"planCacheKey\":\""));
pub static USER_FINDER: LazyLock<memmem::Finder<'static>> = LazyLock::new(|| memmem::Finder::new(b"\"user\":\""));
pub static PRINCIPAL_FINDER: LazyLock<memmem::Finder<'static>> = LazyLock::new(|| memmem::Finder::new(b"\"principalName\":\""));
pub static DUR_REV_FINDER: LazyLock<memmem::FinderRev<'static>> = LazyLock::new(|| memmem::FinderRev::new(b"\"durationMillis\":"));
pub static C_FINDER: LazyLock<memmem::Finder<'static>> = LazyLock::new(|| memmem::Finder::new(b"\"c\":\""));
pub static ID_FINDER: LazyLock<memmem::Finder<'static>> = LazyLock::new(|| memmem::Finder::new(b"\"id\":"));
pub static DATE_FINDER: LazyLock<memmem::Finder<'static>> = LazyLock::new(|| memmem::Finder::new(b"\"$date\":\""));
pub static CONN_COUNT_FINDER: LazyLock<memmem::Finder<'static>> = LazyLock::new(|| memmem::Finder::new(b"\"connectionCount\":"));

/// Extract string field value using a precompiled static Finder
#[inline(always)]
pub fn extract_str_with_finder<'a>(haystack: &'a [u8], finder: &memmem::Finder) -> Option<&'a str> {
    let pos = finder.find(haystack)?;
    let start = pos + finder.needle().len();
    let quote = memchr::memchr(b'"', &haystack[start..])?;
    let end = start + quote;
    // SAFETY: MongoDB log strings from valid JSON are ASCII/UTF-8
    unsafe { Some(std::str::from_utf8_unchecked(&haystack[start..end])) }
}

/// Extract string field value with exact prefix e.g. b"\"ns\":\""
#[inline(always)]
pub fn extract_str_value<'a>(haystack: &'a [u8], prefix: &[u8]) -> Option<&'a str> {
    let pos = memmem::find(haystack, prefix)?;
    let start = pos + prefix.len();
    let quote = memchr::memchr(b'"', &haystack[start..])?;
    let end = start + quote;
    // SAFETY: MongoDB log strings from valid JSON are ASCII/UTF-8
    unsafe { Some(std::str::from_utf8_unchecked(&haystack[start..end])) }
}

/// Extract integer field value using a precompiled static Finder
#[inline(always)]
pub fn extract_u32_with_finder(haystack: &[u8], finder: &memmem::Finder) -> Option<u32> {
    let pos = finder.find(haystack)?;
    let mut i = pos + finder.needle().len();
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

/// Extract integer with forward cursor advancement and fallback
#[inline(always)]
pub fn extract_forward_u32<'a>(
    sub: &'a [u8],
    fallback: &'a [u8],
    finder: &memmem::Finder,
) -> (u32, &'a [u8]) {
    if let Some(pos) = finder.find(sub) {
        let needle_len = finder.needle().len();
        let mut i = pos + needle_len;
        while i < sub.len() && (sub[i] == b':' || sub[i].is_ascii_whitespace()) {
            i += 1;
        }
        let start = i;
        let mut acc = 0u32;
        while i < sub.len() && sub[i].is_ascii_digit() {
            acc = acc.wrapping_mul(10).wrapping_add((sub[i] - b'0') as u32);
            i += 1;
        }
        if i > start {
            (acc, &sub[i..])
        } else {
            (0, &sub[pos + needle_len..])
        }
    } else if let Some(val) = extract_u32_with_finder(fallback, finder) {
        (val, sub)
    } else {
        (0, sub)
    }
}

/// Extract string with forward cursor advancement and fallback
#[inline(always)]
pub fn extract_forward_str<'a>(
    sub: &'a [u8],
    fallback: &'a [u8],
    finder: &memmem::Finder,
) -> (&'a str, &'a [u8]) {
    if let Some(pos) = finder.find(sub) {
        let start = pos + finder.needle().len();
        if let Some(quote) = memchr::memchr(b'"', &sub[start..]) {
            let end = start + quote;
            // SAFETY: strings from valid JSON log are ASCII
            let s = unsafe { std::str::from_utf8_unchecked(&sub[start..end]) };
            (s, &sub[end + 1..])
        } else {
            ("", sub)
        }
    } else if let Some(s) = extract_str_with_finder(fallback, finder) {
        (s, sub)
    } else {
        ("", sub)
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

/// Extract durationMillis value scanning from end of slice using precompiled FinderRev
#[inline(always)]
pub fn extract_duration_rev(haystack: &[u8]) -> Option<u32> {
    let search_slice = if haystack.len() > 512 {
        &haystack[haystack.len() - 512..]
    } else {
        haystack
    };
    let pos = DUR_REV_FINDER
        .rfind(search_slice)
        .map(|p| p + (haystack.len() - search_slice.len()))?;

    let mut i = pos + 17; // 17 is len of "\"durationMillis\":"
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
    let fast_prefix = b"{\"t\":{\"$date\":\"";
    let start = if line.len() >= 40 && line.starts_with(fast_prefix) {
        fast_prefix.len()
    } else if let Some(pos) = DATE_FINDER.find(line) {
        pos + 9
    } else {
        return ("", 0);
    };

    if let Some(quote) = memchr::memchr(b'"', &line[start..]) {
        let i = start + quote;
        // SAFETY: ISO timestamps from MongoDB JSON are ASCII
        let iso = unsafe { std::str::from_utf8_unchecked(&line[start..i]) };
        let epoch = parse_iso_epoch(iso);
        (iso, epoch)
    } else {
        ("", 0)
    }
}

#[inline(always)]
fn parse_2digits(slice: &[u8]) -> i64 {
    ((slice[0] - b'0') as i64) * 10 + ((slice[1] - b'0') as i64)
}

#[inline(always)]
fn parse_4digits(slice: &[u8]) -> i64 {
    ((slice[0] - b'0') as i64) * 1000
        + ((slice[1] - b'0') as i64) * 100
        + ((slice[2] - b'0') as i64) * 10
        + ((slice[3] - b'0') as i64)
}

#[inline(always)]
fn parse_3digits(slice: &[u8]) -> i64 {
    ((slice[0] - b'0') as i64) * 100
        + ((slice[1] - b'0') as i64) * 10
        + ((slice[2] - b'0') as i64)
}

use std::cell::Cell;

thread_local! {
    static LAST_DATE_CACHE: Cell<([u8; 10], i64)> = const { Cell::new(([0; 10], 0)) };
}

/// Approximate ISO date string to epoch ms without external chrono crate.
#[inline(always)]
pub fn parse_iso_epoch(iso: &str) -> i64 {
    let bytes = iso.as_bytes();
    if bytes.len() < 19 {
        return 0;
    }
    let date_slice: [u8; 10] = match bytes[..10].try_into() {
        Ok(s) => s,
        Err(_) => return 0,
    };
    let (cached_date, base_days_sec) = LAST_DATE_CACHE.get();
    let days_sec = if cached_date == date_slice {
        base_days_sec
    } else {
        let year = parse_4digits(&bytes[0..4]);
        let month = parse_2digits(&bytes[5..7]);
        let day = parse_2digits(&bytes[8..10]);

        let mut days = (year - 1970) * 365 + ((year - 1969) / 4);
        let month_days = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
        if (1..=12).contains(&month) {
            days += month_days[(month - 1) as usize];
            if month > 2 && (year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)) {
                days += 1;
            }
        }
        days += day - 1;
        let s = days * 86400;
        LAST_DATE_CACHE.set((date_slice, s));
        s
    };

    let hour = parse_2digits(&bytes[11..13]);
    let min = parse_2digits(&bytes[14..16]);
    let sec = parse_2digits(&bytes[17..19]);
    let millis = if bytes.len() >= 23 && bytes[19] == b'.' {
        parse_3digits(&bytes[20..23])
    } else {
        0
    };

    (days_sec + hour * 3600 + min * 60 + sec) * 1000 + millis
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

    let header = if line.len() > 384 { &line[..384] } else { line };

    if let Some(msg) = extract_str_with_finder(header, &MSG_FINDER) {
        if msg == "Slow query" {
            if let Some(dur) = extract_duration_rev(line) {
                let (timestamp, epoch_ms) = extract_timestamp(header);
                let severity = if let Some(s) = extract_str_with_finder(header, &S_FINDER) {
                    s.as_bytes().first().copied().unwrap_or(b'I')
                } else {
                    b'I'
                };

                let (ctx, after_ctx) = if let Some(pos) = CTX_FINDER.find(header) {
                    let start = pos + CTX_FINDER.needle().len();
                    if let Some(quote) = memchr::memchr(b'"', &header[start..]) {
                        // SAFETY: ctx from valid JSON log is ASCII
                        let c = unsafe { std::str::from_utf8_unchecked(&header[start..start + quote]) };
                        (c, &header[start + quote + 1..])
                    } else {
                        ("", header)
                    }
                } else {
                    ("", header)
                };

                let ns = extract_str_with_finder(after_ctx, &NS_FINDER)
                    .or_else(|| extract_str_with_finder(header, &NS_FINDER))
                    .unwrap_or("");
                let (db, collection) = if let Some(idx) = ns.find('.') {
                    (&ns[..idx], &ns[idx + 1..])
                } else {
                    ("unknown", ns)
                };

                let tail = if line.len() > 4800 {
                    &line[line.len() - 4800..]
                } else {
                    line
                };

                let (plan_summary, mut sub, metrics_slice) = if let Some(pos) = PLAN_FINDER.find(tail) {
                    let start = pos + PLAN_FINDER.needle().len();
                    if let Some(quote) = memchr::memchr(b'"', &tail[start..]) {
                        // SAFETY: planSummary from valid JSON log is ASCII
                        let plan = unsafe { std::str::from_utf8_unchecked(&tail[start..start + quote]) };
                        let after_quote = start + quote + 1;
                        (plan, &tail[after_quote..], &tail[pos..])
                    } else {
                        ("", tail, tail)
                    }
                } else {
                    ("", tail, tail)
                };

                let is_collscan = plan_summary.starts_with("COLLSCAN") || plan_summary.contains("COLLSCAN");
                let (keys_examined, s) = extract_forward_u32(sub, metrics_slice, &KEYS_FINDER);
                sub = s;
                let (docs_examined, s) = extract_forward_u32(sub, metrics_slice, &DOCS_FINDER);
                sub = s;
                let (num_yields, s) = extract_forward_u32(sub, metrics_slice, &YIELDS_FINDER);
                sub = s;
                let (nreturned, s) = extract_forward_u32(sub, metrics_slice, &RET_FINDER);
                sub = s;
                let (query_hash, s) = extract_forward_str(sub, metrics_slice, &HASH_FINDER);
                sub = s;
                let (plan_cache_key, s) = extract_forward_str(sub, metrics_slice, &PLAN_KEY_FINDER);
                sub = s;
                let (reslen, s) = extract_forward_u32(sub, metrics_slice, &RESLEN_FINDER);
                sub = s;
                let (remote, _) = extract_forward_str(sub, metrics_slice, &REMOTE_FINDER);
                let user = extract_str_with_finder(header, &USER_FINDER)
                    .or_else(|| extract_str_with_finder(header, &PRINCIPAL_FINDER))
                    .or_else(|| extract_str_with_finder(metrics_slice, &USER_FINDER))
                    .or_else(|| extract_str_with_finder(metrics_slice, &PRINCIPAL_FINDER))
                    .unwrap_or("");

                return ParsedLine::SlowQuery(ParsedSlowQuery {
                    timestamp,
                    epoch_ms,
                    severity,
                    ctx,
                    user,
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

        let (timestamp, _) = extract_timestamp(header);
        let ctx = extract_str_value(header, b"\"ctx\":\"").unwrap_or("");

        if msg == "Connection accepted" {
            let connection_count = extract_u32_value(header, b"\"connectionCount\":")
                .or_else(|| extract_u32_value(line, b"\"connectionCount\":"))
                .unwrap_or(0);
            let remote = extract_str_value(header, b"\"remote\":\"")
                .or_else(|| extract_str_value(line, b"\"remote\":\""))
                .unwrap_or("");
            return ParsedLine::ConnectionAccepted {
                timestamp,
                ctx,
                connection_count,
                remote,
            };
        }
        if msg == "Connection ended" {
            return ParsedLine::ConnectionEnded { timestamp, ctx };
        }
        if msg == "Authentication succeeded" || msg == "Successfully authenticated" {
            let user = extract_str_value(line, b"\"user\":\"")
                .or_else(|| extract_str_value(line, b"\"principalName\":\""))
                .unwrap_or("unknown");
            let db = extract_str_value(line, b"\"db\":\"")
                .or_else(|| extract_str_value(line, b"\"authenticationDatabase\":\""))
                .unwrap_or("admin");
            let client = extract_str_value(line, b"\"client\":\"")
                .or_else(|| extract_str_value(line, b"\"remote\":\""))
                .unwrap_or("");
            let app_name = extract_str_value(line, b"\"application\":{\"name\":\"")
                .or_else(|| extract_str_value(line, b"\"appName\":\""))
                .unwrap_or("");

            return ParsedLine::AuthSuccess {
                timestamp,
                ctx,
                user,
                db,
                client,
                app_name,
            };
        }
        if msg == "Authentication failed" || msg == "Checking authorization failed" {
            let user = extract_str_value(line, b"\"user\":\"")
                .or_else(|| extract_str_value(line, b"\"principalName\":\""))
                .unwrap_or("");
            let errmsg = extract_str_value(line, b"\"errmsg\":\"").unwrap_or(msg);
            return ParsedLine::AuthFail {
                timestamp,
                ctx,
                user,
                errmsg,
            };
        }
        if msg == "client metadata" {
            let app_name = extract_str_value(line, b"\"application\":{\"name\":\"")
                .or_else(|| extract_str_value(line, b"\"appName\":\""))
                .unwrap_or("");
            return ParsedLine::ClientMetadata {
                ctx,
                app_name,
                driver_name: extract_str_value(line, b"\"name\":\"").unwrap_or("unknown"),
                driver_version: extract_str_value(line, b"\"version\":\"").unwrap_or("unknown"),
                platform: extract_str_value(line, b"\"platform\":\"").unwrap_or("unknown"),
                os_name: extract_str_value(line, b"\"osName\":\"").unwrap_or("unknown"),
                os_version: extract_str_value(line, b"\"osVersion\":\"").unwrap_or("unknown"),
            };
        }
    }

    // Checkpoints
    if let Some(c) = extract_str_value(header, b"\"c\":\"") {
        if c == "WTCHKPT" {
            let (timestamp, _) = extract_timestamp(header);
            let msg = extract_str_value(header, b"\"msg\":\"")
                .or_else(|| extract_str_value(line, b"\"msg\":\""))
                .unwrap_or("WiredTiger checkpoint");
            return ParsedLine::Checkpoint { timestamp, msg };
        }
    }

    // Severity warnings / errors
    if let Some(s) = extract_str_value(header, b"\"s\":\"") {
        let s_byte = s.as_bytes().first().copied().unwrap_or(b'I');
        if s_byte == b'W' || s_byte == b'E' || s_byte == b'F' {
            let (timestamp, _) = extract_timestamp(header);
            let id = extract_u32_value(header, b"\"id\":")
                .or_else(|| extract_u32_value(line, b"\"id\":"))
                .unwrap_or(0);
            let msg = extract_str_value(header, b"\"msg\":\"")
                .or_else(|| extract_str_value(line, b"\"msg\":\""))
                .unwrap_or("MongoDB log event");
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
