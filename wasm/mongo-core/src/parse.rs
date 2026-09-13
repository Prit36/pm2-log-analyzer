//! High-performance zero-copy byte scanner for MongoDB 4.4+ JSON log lines.

use crate::json::scan_balanced;
use memchr::memmem;
use std::cell::Cell;
use std::sync::LazyLock;

pub struct ParsedSlowQuery<'a> {
    pub timestamp: &'a str,
    pub epoch_ms: i64,
    pub ctx: &'a str,
    pub user: &'a str,
    pub ns: &'a str,
    pub collection: &'a str,
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
    pub line: &'a [u8],
}

/// A successful authentication line.
pub struct AuthSuccess<'a> {
    pub timestamp: &'a str,
    pub ctx: &'a str,
    pub user: &'a str,
    pub db: &'a str,
    pub client: &'a str,
    pub app_name: &'a str,
}

/// A `client metadata` line.
pub struct ClientMetadata<'a> {
    pub ctx: &'a str,
    pub app_name: &'a str,
    pub driver_name: &'a str,
    pub driver_version: &'a str,
    pub platform: &'a str,
    pub os_name: &'a str,
    pub os_version: &'a str,
}

pub enum ParsedLine<'a> {
    SlowQuery(ParsedSlowQuery<'a>),
    ConnectionAccepted {
        connection_count: u32,
    },
    ConnectionEnded,
    AuthSuccess(AuthSuccess<'a>),
    AuthFail {
        ctx: &'a str,
        user: &'a str,
    },
    ClientMetadata(ClientMetadata<'a>),
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

pub static MSG_FINDER: LazyLock<memmem::Finder<'static>> =
    LazyLock::new(|| memmem::Finder::new(b"\"msg\":\""));
pub static CTX_FINDER: LazyLock<memmem::Finder<'static>> =
    LazyLock::new(|| memmem::Finder::new(b"\"ctx\":\""));
pub static NS_FINDER: LazyLock<memmem::Finder<'static>> =
    LazyLock::new(|| memmem::Finder::new(b"\"ns\":\""));
pub static PLAN_FINDER: LazyLock<memmem::Finder<'static>> =
    LazyLock::new(|| memmem::Finder::new(b"\"planSummary\":\""));
pub static KEYS_FINDER: LazyLock<memmem::Finder<'static>> =
    LazyLock::new(|| memmem::Finder::new(b"\"keysExamined\":"));
pub static DOCS_FINDER: LazyLock<memmem::Finder<'static>> =
    LazyLock::new(|| memmem::Finder::new(b"\"docsExamined\":"));
pub static RET_FINDER: LazyLock<memmem::Finder<'static>> =
    LazyLock::new(|| memmem::Finder::new(b"\"nreturned\":"));
pub static YIELDS_FINDER: LazyLock<memmem::Finder<'static>> =
    LazyLock::new(|| memmem::Finder::new(b"\"numYields\":"));
pub static RESLEN_FINDER: LazyLock<memmem::Finder<'static>> =
    LazyLock::new(|| memmem::Finder::new(b"\"reslen\":"));
pub static REMOTE_FINDER: LazyLock<memmem::Finder<'static>> =
    LazyLock::new(|| memmem::Finder::new(b"\"remote\":\""));
pub static HASH_FINDER: LazyLock<memmem::Finder<'static>> =
    LazyLock::new(|| memmem::Finder::new(b"\"queryHash\":\""));
pub static PLAN_KEY_FINDER: LazyLock<memmem::Finder<'static>> =
    LazyLock::new(|| memmem::Finder::new(b"\"planCacheKey\":\""));
pub static USER_FINDER: LazyLock<memmem::Finder<'static>> =
    LazyLock::new(|| memmem::Finder::new(b"\"user\":\""));
pub static PRINCIPAL_FINDER: LazyLock<memmem::Finder<'static>> =
    LazyLock::new(|| memmem::Finder::new(b"\"principalName\":\""));
pub static DUR_REV_FINDER: LazyLock<memmem::FinderRev<'static>> =
    LazyLock::new(|| memmem::FinderRev::new(b"\"durationMillis\":"));
pub static DATE_FINDER: LazyLock<memmem::Finder<'static>> =
    LazyLock::new(|| memmem::Finder::new(b"\"$date\":\""));

thread_local! {
    static LAST_DATE_CACHE: Cell<([u8; 10], i64)> = const { Cell::new(([0; 10], 0)) };
}

/// Extract string field value using a precompiled static Finder.
#[inline(always)]
pub fn extract_str_with_finder<'a>(haystack: &'a [u8], finder: &memmem::Finder) -> Option<&'a str> {
    let pos = finder.find(haystack)?;
    let start = pos + finder.needle().len();
    let quote = memchr::memchr(b'"', &haystack[start..])?;
    let end = start + quote;
    // SAFETY: MongoDB log strings from valid JSON are ASCII/UTF-8
    unsafe { Some(std::str::from_utf8_unchecked(&haystack[start..end])) }
}

/// Extract string field value with exact prefix e.g. `b"\"ns\":\""`.
#[inline(always)]
pub fn extract_str_value<'a>(haystack: &'a [u8], prefix: &[u8]) -> Option<&'a str> {
    let pos = memmem::find(haystack, prefix)?;
    let start = pos + prefix.len();
    let quote = memchr::memchr(b'"', &haystack[start..])?;
    let end = start + quote;
    // SAFETY: MongoDB log strings from valid JSON are ASCII/UTF-8
    unsafe { Some(std::str::from_utf8_unchecked(&haystack[start..end])) }
}

/// Digits from `index` on, as `u32` with wrapping multiply.
#[inline(always)]
fn scan_digits(bytes: &[u8], mut index: usize) -> (u32, usize) {
    let mut value = 0u32;
    while index < bytes.len() && bytes[index].is_ascii_digit() {
        value = value.wrapping_mul(10).wrapping_add((bytes[index] - b'0') as u32);
        index += 1;
    }
    (value, index)
}

/// Skip `:` and whitespace from `index` on.
#[inline(always)]
fn skip_colon_space(bytes: &[u8], mut index: usize) -> usize {
    while index < bytes.len() && (bytes[index] == b':' || bytes[index].is_ascii_whitespace()) {
        index += 1;
    }
    index
}

/// Extract integer field value using a precompiled static Finder.
#[inline(always)]
pub fn extract_u32_with_finder(haystack: &[u8], finder: &memmem::Finder) -> Option<u32> {
    let pos = finder.find(haystack)?;
    let start = skip_colon_space(haystack, pos + finder.needle().len());
    let (value, end) = scan_digits(haystack, start);
    (end > start).then_some(value)
}

/// Extract integer with forward cursor advancement and fallback.
#[inline(always)]
pub fn extract_forward_u32<'a>(
    sub: &'a [u8],
    fallback: &'a [u8],
    finder: &memmem::Finder,
) -> (u32, &'a [u8]) {
    if let Some(pos) = finder.find(sub) {
        let needle_len = finder.needle().len();
        let start = skip_colon_space(sub, pos + needle_len);
        let (value, end) = scan_digits(sub, start);
        if end > start {
            (value, &sub[end..])
        } else {
            (0, &sub[pos + needle_len..])
        }
    } else if let Some(value) = extract_u32_with_finder(fallback, finder) {
        (value, sub)
    } else {
        (0, sub)
    }
}

/// Extract string with forward cursor advancement and fallback.
#[inline(always)]
pub fn extract_forward_str<'a>(
    sub: &'a [u8],
    fallback: &'a [u8],
    finder: &memmem::Finder,
) -> (&'a str, &'a [u8]) {
    if let Some(pos) = finder.find(sub) {
        let start = pos + finder.needle().len();
        let Some(quote) = memchr::memchr(b'"', &sub[start..]) else {
            return ("", sub);
        };
        let end = start + quote;
        // SAFETY: strings from valid JSON log are ASCII
        let text = unsafe { std::str::from_utf8_unchecked(&sub[start..end]) };
        (text, &sub[end + 1..])
    } else if let Some(text) = extract_str_with_finder(fallback, finder) {
        (text, sub)
    } else {
        ("", sub)
    }
}

/// Extract integer field value with exact prefix e.g. `b"\"durationMillis\":"`.
#[inline(always)]
pub fn extract_u32_value(haystack: &[u8], prefix: &[u8]) -> Option<u32> {
    let pos = memmem::find(haystack, prefix)?;
    let start = skip_colon_space(haystack, pos + prefix.len());
    let (value, end) = scan_digits(haystack, start);
    (end > start).then_some(value)
}

/// Extract durationMillis value scanning from end of slice using precompiled FinderRev.
#[inline(always)]
pub fn extract_duration_rev(haystack: &[u8]) -> Option<u32> {
    let search_slice = if haystack.len() > 512 {
        &haystack[haystack.len() - 512..]
    } else {
        haystack
    };
    let pos = DUR_REV_FINDER
        .rfind(search_slice)
        .map(|position| position + (haystack.len() - search_slice.len()))?;

    let start = skip_colon_space(haystack, pos + 17); // 17 is len of "\"durationMillis\":"
    let (value, end) = scan_digits(haystack, start);
    (end > start).then_some(value)
}

/// Extract timestamp ISO and epoch ms.
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

    match memchr::memchr(b'"', &line[start..]) {
        Some(quote) => {
            let end = start + quote;
            // SAFETY: ISO timestamps from MongoDB JSON are ASCII
            let iso = unsafe { std::str::from_utf8_unchecked(&line[start..end]) };
            (iso, parse_iso_epoch(iso))
        }
        None => ("", 0),
    }
}

/// Seconds since the epoch for a UTC calendar date, ignoring leap seconds.
fn date_to_epoch_seconds(year: i64, month: i64, day: i64) -> i64 {
    let mut days = (year - 1970) * 365 + ((year - 1969) / 4);
    let month_days = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    if (1..=12).contains(&month) {
        days += month_days[(month - 1) as usize];
        if month > 2 && (year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)) {
            days += 1;
        }
    }
    days += day - 1;
    days * 86400
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
    ((slice[0] - b'0') as i64) * 100 + ((slice[1] - b'0') as i64) * 10 + ((slice[2] - b'0') as i64)
}

/// Approximate ISO date string to epoch ms without external chrono crate.
#[inline(always)]
pub fn parse_iso_epoch(iso: &str) -> i64 {
    let bytes = iso.as_bytes();
    if bytes.len() < 19 {
        return 0;
    }
    let date_slice: [u8; 10] = match bytes[..10].try_into() {
        Ok(slice) => slice,
        Err(_) => return 0,
    };
    let (cached_date, base_days_sec) = LAST_DATE_CACHE.get();
    let days_sec = if cached_date == date_slice {
        base_days_sec
    } else {
        let seconds = date_to_epoch_seconds(
            parse_4digits(&bytes[0..4]),
            parse_2digits(&bytes[5..7]),
            parse_2digits(&bytes[8..10]),
        );
        LAST_DATE_CACHE.set((date_slice, seconds));
        seconds
    };

    let hour = parse_2digits(&bytes[11..13]);
    let minute = parse_2digits(&bytes[14..16]);
    let second = parse_2digits(&bytes[17..19]);
    let millis = if bytes.len() >= 23 && bytes[19] == b'.' {
        parse_3digits(&bytes[20..23])
    } else {
        0
    };

    (days_sec + hour * 3600 + minute * 60 + second) * 1000 + millis
}

/// Extract the command JSON object slice.
pub fn extract_command_slice<'a>(line: &'a [u8]) -> Option<&'a [u8]> {
    let pos = memmem::find(line, b"\"command\":{")?;
    Some(scan_balanced(line, pos + 10, b'{', b'}'))
}

/// The `ctx` field of the header, plus the bytes that follow it.
fn extract_ctx<'a>(header: &'a [u8]) -> (&'a str, &'a [u8]) {
    let Some(pos) = CTX_FINDER.find(header) else {
        return ("", header);
    };
    let start = pos + CTX_FINDER.needle().len();
    let Some(quote) = memchr::memchr(b'"', &header[start..]) else {
        return ("", header);
    };
    // SAFETY: ctx from valid JSON log is ASCII
    let ctx = unsafe { std::str::from_utf8_unchecked(&header[start..start + quote]) };
    (ctx, &header[start + quote + 1..])
}

/// `(planSummary, bytes after it, metrics slice)` for a slow-query line.
fn extract_plan_tail<'a>(tail: &'a [u8]) -> (&'a str, &'a [u8], &'a [u8]) {
    let Some(pos) = PLAN_FINDER.find(tail) else {
        return ("", tail, tail);
    };
    let start = pos + PLAN_FINDER.needle().len();
    let Some(quote) = memchr::memchr(b'"', &tail[start..]) else {
        return ("", tail, tail);
    };
    // SAFETY: planSummary from valid JSON log is ASCII
    let plan = unsafe { std::str::from_utf8_unchecked(&tail[start..start + quote]) };
    (plan, &tail[start + quote + 1..], &tail[pos..])
}

/// The metrics a slow-query line carries, read with a forward cursor.
struct SlowQueryMetrics<'a> {
    keys_examined: u32,
    docs_examined: u32,
    num_yields: u32,
    nreturned: u32,
    query_hash: &'a str,
    reslen: u32,
    remote: &'a str,
}

/// Walk the forward cursor through the metrics slice.
fn extract_slow_query_metrics<'a>(mut sub: &'a [u8], metrics: &'a [u8]) -> SlowQueryMetrics<'a> {
    let (keys_examined, next) = extract_forward_u32(sub, metrics, &KEYS_FINDER);
    sub = next;
    let (docs_examined, next) = extract_forward_u32(sub, metrics, &DOCS_FINDER);
    sub = next;
    let (num_yields, next) = extract_forward_u32(sub, metrics, &YIELDS_FINDER);
    sub = next;
    let (nreturned, next) = extract_forward_u32(sub, metrics, &RET_FINDER);
    sub = next;
    let (query_hash, next) = extract_forward_str(sub, metrics, &HASH_FINDER);
    sub = next;
    let (_, next) = extract_forward_str(sub, metrics, &PLAN_KEY_FINDER);
    sub = next;
    let (reslen, next) = extract_forward_u32(sub, metrics, &RESLEN_FINDER);
    sub = next;
    let (remote, _) = extract_forward_str(sub, metrics, &REMOTE_FINDER);
    SlowQueryMetrics {
        keys_examined,
        docs_examined,
        num_yields,
        nreturned,
        query_hash,
        reslen,
        remote,
    }
}

/// The slow query's user, from either the header or the metrics slice.
fn extract_slow_query_user<'a>(header: &'a [u8], metrics: &'a [u8]) -> &'a str {
    extract_str_with_finder(header, &USER_FINDER)
        .or_else(|| extract_str_with_finder(header, &PRINCIPAL_FINDER))
        .or_else(|| extract_str_with_finder(metrics, &USER_FINDER))
        .or_else(|| extract_str_with_finder(metrics, &PRINCIPAL_FINDER))
        .unwrap_or("")
}

/// The slow-query shape; `None` when the line carries no duration.
fn parse_slow_query<'a>(header: &'a [u8], line: &'a [u8]) -> Option<ParsedSlowQuery<'a>> {
    let duration_ms = extract_duration_rev(line)?;
    let (timestamp, epoch_ms) = extract_timestamp(header);
    let (ctx, after_ctx) = extract_ctx(header);
    let ns = extract_str_with_finder(after_ctx, &NS_FINDER)
        .or_else(|| extract_str_with_finder(header, &NS_FINDER))
        .unwrap_or("");
    let collection = match ns.find('.') {
        Some(index) => &ns[index + 1..],
        None => ns,
    };
    let tail = if line.len() > 4800 {
        &line[line.len() - 4800..]
    } else {
        line
    };
    let (plan_summary, sub, metrics_slice) = extract_plan_tail(tail);
    let is_collscan = plan_summary.contains("COLLSCAN");
    let metrics = extract_slow_query_metrics(sub, metrics_slice);
    let user = extract_slow_query_user(header, metrics_slice);
    Some(ParsedSlowQuery {
        timestamp,
        epoch_ms,
        ctx,
        user,
        ns,
        collection,
        duration_ms,
        plan_summary,
        is_collscan,
        keys_examined: metrics.keys_examined,
        docs_examined: metrics.docs_examined,
        nreturned: metrics.nreturned,
        num_yields: metrics.num_yields,
        reslen: metrics.reslen,
        remote: metrics.remote,
        query_hash: metrics.query_hash,
        line,
    })
}

/// The client application name, under either spelling the driver uses.
fn extract_app_name(line: &[u8]) -> &str {
    extract_str_value(line, b"\"application\":{\"name\":\"")
        .or_else(|| extract_str_value(line, b"\"appName\":\""))
        .unwrap_or("")
}

/// The non-slow `msg`-shaped lines.
fn parse_message<'a>(header: &'a [u8], line: &'a [u8], msg: &str) -> Option<ParsedLine<'a>> {
    match msg {
        "Connection accepted" => Some(ParsedLine::ConnectionAccepted {
            connection_count: extract_u32_value(header, b"\"connectionCount\":")
                .or_else(|| extract_u32_value(line, b"\"connectionCount\":"))
                .unwrap_or(0),
        }),
        "Connection ended" => Some(ParsedLine::ConnectionEnded),
        "Authentication succeeded" | "Successfully authenticated" => {
            let (timestamp, _) = extract_timestamp(header);
            let ctx = extract_str_value(header, b"\"ctx\":\"").unwrap_or("");
            Some(ParsedLine::AuthSuccess(AuthSuccess {
                timestamp,
                ctx,
                user: extract_str_value(line, b"\"user\":\"")
                    .or_else(|| extract_str_value(line, b"\"principalName\":\""))
                    .unwrap_or("unknown"),
                db: extract_str_value(line, b"\"db\":\"")
                    .or_else(|| extract_str_value(line, b"\"authenticationDatabase\":\""))
                    .unwrap_or("admin"),
                client: extract_str_value(line, b"\"client\":\"")
                    .or_else(|| extract_str_value(line, b"\"remote\":\""))
                    .unwrap_or(""),
                app_name: extract_app_name(line),
            }))
        }
        "Authentication failed" | "Checking authorization failed" => Some(ParsedLine::AuthFail {
            ctx: extract_str_value(header, b"\"ctx\":\"").unwrap_or(""),
            user: extract_str_value(line, b"\"user\":\"")
                .or_else(|| extract_str_value(line, b"\"principalName\":\""))
                .unwrap_or(""),
        }),
        "client metadata" => Some(ParsedLine::ClientMetadata(ClientMetadata {
            ctx: extract_str_value(header, b"\"ctx\":\"").unwrap_or(""),
            app_name: extract_app_name(line),
            driver_name: extract_str_value(line, b"\"name\":\"").unwrap_or("unknown"),
            driver_version: extract_str_value(line, b"\"version\":\"").unwrap_or("unknown"),
            platform: extract_str_value(line, b"\"platform\":\"").unwrap_or("unknown"),
            os_name: extract_str_value(line, b"\"osName\":\"").unwrap_or("unknown"),
            os_version: extract_str_value(line, b"\"osVersion\":\"").unwrap_or("unknown"),
        })),
        _ => None,
    }
}

/// `WTCHKPT` checkpoint lines.
fn parse_checkpoint<'a>(header: &'a [u8], line: &'a [u8]) -> Option<ParsedLine<'a>> {
    if extract_str_value(header, b"\"c\":\"") != Some("WTCHKPT") {
        return None;
    }
    let (timestamp, _) = extract_timestamp(header);
    let msg = extract_str_value(header, b"\"msg\":\"")
        .or_else(|| extract_str_value(line, b"\"msg\":\""))
        .unwrap_or("WiredTiger checkpoint");
    Some(ParsedLine::Checkpoint { timestamp, msg })
}

/// `W`/`E`/`F` severity lines.
fn parse_severity<'a>(header: &'a [u8], line: &'a [u8]) -> Option<ParsedLine<'a>> {
    let severity = extract_str_value(header, b"\"s\":\"")?;
    let severity_byte = severity.as_bytes().first().copied().unwrap_or(b'I');
    if severity_byte != b'W' && severity_byte != b'E' && severity_byte != b'F' {
        return None;
    }
    let (timestamp, _) = extract_timestamp(header);
    let id = extract_u32_value(header, b"\"id\":")
        .or_else(|| extract_u32_value(line, b"\"id\":"))
        .unwrap_or(0);
    let msg = extract_str_value(header, b"\"msg\":\"")
        .or_else(|| extract_str_value(line, b"\"msg\":\""))
        .unwrap_or("MongoDB log event");
    Some(ParsedLine::Error {
        timestamp,
        severity: severity_byte,
        id,
        msg,
    })
}

/// Parse a single line.
pub fn parse_line<'a>(line: &'a [u8]) -> ParsedLine<'a> {
    if line.len() < 10 || line[0] != b'{' {
        return ParsedLine::Ignored;
    }

    let header = if line.len() > 384 { &line[..384] } else { line };

    if let Some(msg) = extract_str_with_finder(header, &MSG_FINDER) {
        if msg == "Slow query" {
            if let Some(slow) = parse_slow_query(header, line) {
                return ParsedLine::SlowQuery(slow);
            }
        } else if let Some(parsed) = parse_message(header, line, msg) {
            return parsed;
        }
    }

    if let Some(checkpoint) = parse_checkpoint(header, line) {
        return checkpoint;
    }
    if let Some(error) = parse_severity(header, line) {
        return error;
    }
    ParsedLine::Ignored
}
