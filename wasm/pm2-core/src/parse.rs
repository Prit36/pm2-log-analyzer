//! Byte-level PM2 log line parser (parity with src/parser/parseLine.ts).

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    Get = 0,
    Post = 1,
    Put = 2,
    Patch = 3,
    Delete = 4,
    Head = 5,
}

impl Method {
    pub fn from_code(c: u8) -> Option<Self> {
        match c {
            0 => Some(Self::Get),
            1 => Some(Self::Post),
            2 => Some(Self::Put),
            3 => Some(Self::Patch),
            4 => Some(Self::Delete),
            5 => Some(Self::Head),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
            Self::Put => "PUT",
            Self::Patch => "PATCH",
            Self::Delete => "DELETE",
            Self::Head => "HEAD",
        }
    }
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

const CRON_MARK: &[u8] = b"[cron]";

#[inline(always)]
fn is_digit(c: u8) -> bool {
    c.is_ascii_digit()
}

#[inline(always)]
fn skip_ansi(buf: &[u8], mut i: usize, end: usize) -> usize {
    while i + 1 < end && buf[i] == 0x1b && buf[i + 1] == b'[' {
        i += 2;
        while i < end {
            let c = buf[i];
            i += 1;
            if (0x40..=0x7e).contains(&c) {
                break;
            }
        }
    }
    i
}

#[inline(always)]
fn skip_space_ansi(buf: &[u8], mut i: usize, end: usize) -> usize {
    while i < end {
        let c = buf[i];
        if c == b' ' || c == b'\t' {
            i += 1;
            continue;
        }
        if c == 0x1b && i + 1 < end && buf[i + 1] == b'[' {
            i = skip_ansi(buf, i, end);
            continue;
        }
        break;
    }
    i
}

#[inline(always)]
fn only_space_ansi_left(buf: &[u8], i: usize, end: usize) -> bool {
    skip_space_ansi(buf, i, end) >= end
}

#[inline(always)]
fn is_digits_4(b: &[u8]) -> bool {
    let u = u32::from_le_bytes(b[..4].try_into().unwrap());
    let a = u.wrapping_add(0x4646_4646);
    let b = u.wrapping_sub(0x3030_3030);
    ((a | b) & 0x8080_8080) == 0
}

#[inline(always)]
fn is_digits_2(b: &[u8]) -> bool {
    let u = u16::from_le_bytes(b[..2].try_into().unwrap());
    let a = u.wrapping_add(0x4646);
    let b = u.wrapping_sub(0x3030);
    ((a | b) & 0x8080) == 0
}

#[inline]
fn skip_timestamp(buf: &[u8], start: usize, end: usize) -> Option<(usize, usize, usize, u8, [u8; 10])> {
    if end - start < 20 {
        return None;
    }
    let a = start;
    let b = &buf[a..a + 20];
    if b[4] != b'-' || b[7] != b'-' || b[13] != b':' || b[16] != b':' || b[19] != b':' {
        return None;
    }
    let sep = b[10];
    if sep != b'T' && sep != b' ' {
        return None;
    }
    if !is_digits_4(&b[0..4])
        || !is_digits_2(&b[5..7])
        || !is_digits_2(&b[8..10])
        || !is_digits_2(&b[11..13])
        || !is_digits_2(&b[14..16])
        || !is_digits_2(&b[17..19])
    {
        return None;
    }
    let hour = (b[11] - b'0') * 10 + (b[12] - b'0');
    let mut date = [0u8; 10];
    date.copy_from_slice(&b[0..10]);
    Some((skip_space_ansi(buf, a + 20, end), a, a + 19, hour, date))
}

#[inline(always)]
fn parse_method(buf: &[u8], mut i: usize, end: usize) -> Option<(Method, usize)> {
    i = skip_space_ansi(buf, i, end);
    if i >= end {
        return None;
    }
    // Fast path: method + space delimiter
    if i + 4 <= end && &buf[i..i + 4] == b"GET " {
        return Some((Method::Get, i + 4));
    }
    if i + 5 <= end && &buf[i..i + 5] == b"POST " {
        return Some((Method::Post, i + 5));
    }
    if i + 4 <= end && &buf[i..i + 4] == b"PUT " {
        return Some((Method::Put, i + 4));
    }
    if i + 6 <= end && &buf[i..i + 6] == b"PATCH " {
        return Some((Method::Patch, i + 6));
    }
    if i + 7 <= end && &buf[i..i + 7] == b"DELETE " {
        return Some((Method::Delete, i + 7));
    }
    if i + 5 <= end && &buf[i..i + 5] == b"HEAD " {
        return Some((Method::Head, i + 5));
    }

    let (m, len) = match buf[i] {
        b'G' => {
            if i + 3 <= end && &buf[i..i + 3] == b"GET" {
                (Method::Get, 3)
            } else {
                return None;
            }
        }
        b'P' => {
            if i + 4 <= end && &buf[i..i + 4] == b"POST" {
                (Method::Post, 4)
            } else if i + 5 <= end && &buf[i..i + 5] == b"PATCH" {
                (Method::Patch, 5)
            } else if i + 3 <= end && &buf[i..i + 3] == b"PUT" {
                (Method::Put, 3)
            } else {
                return None;
            }
        }
        b'D' => {
            if i + 6 <= end && &buf[i..i + 6] == b"DELETE" {
                (Method::Delete, 6)
            } else {
                return None;
            }
        }
        b'H' => {
            if i + 4 <= end && &buf[i..i + 4] == b"HEAD" {
                (Method::Head, 4)
            } else {
                return None;
            }
        }
        _ => return None,
    };
    let after = i + len;
    if after < end {
        let next = buf[after];
        if next != b' ' && next != b'\t' && next != 0x1b {
            return None;
        }
    }
    Some((m, after))
}

#[inline(always)]
fn read_token(buf: &[u8], mut i: usize, end: usize) -> Option<(usize, usize, usize)> {
    i = skip_space_ansi(buf, i, end);
    if i >= end {
        return None;
    }
    let start = i;
    let tok_len = memchr::memchr3(b' ', b'\t', 0x1b, &buf[start..end]).unwrap_or(end - start);
    if tok_len == 0 {
        return None;
    }
    let token_end = start + tok_len;
    Some((start, token_end, token_end))
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
fn parse_float(buf: &[u8], mut i: usize, end: usize) -> Option<(f32, usize)> {
    i = skip_space_ansi(buf, i, end);
    if i >= end || (!is_digit(buf[i]) && buf[i] != b'.') {
        return None;
    }
    let start = i;
    let mut int_val: u32 = 0;
    while i < end && is_digit(buf[i]) {
        int_val = int_val * 10 + (buf[i] - b'0') as u32;
        i += 1;
    }
    if i < end && buf[i] == b'.' {
        i += 1;
        let frac_start = i;
        let mut frac_val: u32 = 0;
        let mut frac_digits: usize = 0;
        while i < end && is_digit(buf[i]) {
            frac_val = frac_val * 10 + (buf[i] - b'0') as u32;
            frac_digits += 1;
            i += 1;
        }
        if i == start || (i == frac_start && frac_start == start + 1) {
            return None;
        }
        let mult = if frac_digits < INV_POW10.len() {
            INV_POW10[frac_digits]
        } else {
            10.0f32.powi(-(frac_digits as i32))
        };
        let val = (int_val as f32) + (frac_val as f32) * mult;
        Some((val, i))
    } else {
        if i == start {
            return None;
        }
        Some((int_val as f32, i))
    }
}

fn find_cron_mark(buf: &[u8], from: usize, end: usize) -> Option<usize> {
    if from >= end {
        return None;
    }
    // Most lines have no '[' — skip full-line memmem for "[cron]".
    if memchr::memchr(b'[', &buf[from..end]).is_none() {
        return None;
    }
    memchr::memmem::find(&buf[from..end], CRON_MARK).map(|rel| from + rel)
}

fn has_non_space(buf: &[u8], start: usize, end: usize) -> bool {
    let mut i = start;
    while i < end {
        let c = buf[i];
        if c > 32 && c != 0x1b {
            return true;
        }
        if c == 0x1b && i + 1 < end && buf[i + 1] == b'[' {
            i = skip_ansi(buf, i, end);
            continue;
        }
        i += 1;
    }
    false
}

/// Line content after the optional PM2 timestamp + leading whitespace.
fn noise_body<'a>(buf: &'a [u8], start: usize, end: usize) -> &'a [u8] {
    let mut i = skip_space_ansi(buf, start, end);
    if let Some((ni, _, _, _, _)) = skip_timestamp(buf, i, end) {
        if ni != i {
            i = ni;
        }
    }
    let mut s = i;
    while s < end && (buf[s] == b' ' || buf[s] == b'\t') {
        s += 1;
    }
    &buf[s..end]
}

/// Socket.IO / socket connection noise: preflight `OPTIONS` is handled by dropping
/// the method; these are the chat/tracking lines that are pure noise for HTTP analysis.
fn is_socket_noise(
    buf: &[u8],
    start: usize,
    end: usize,
    timestamp_body_start: Option<usize>,
) -> bool {
    let body = timestamp_body_start
        .map(|i| &buf[i..end])
        .unwrap_or_else(|| noise_body(buf, start, end));
    if body.is_empty() {
        return false;
    }
    let c0 = body[0];
    if c0.is_ascii_alphabetic() {
        let word_len = body
            .iter()
            .take_while(|&&c| c.is_ascii_alphanumeric())
            .count();
        let word = &body[..word_len];
        let after = &body[word_len..];
        // `New Connection {…}`, `disconnected {…}`, `join {`, `leave {`
        let mut after_trim = after;
        while after_trim
            .first()
            .is_some_and(|&c| c == b' ' || c == b'\t')
        {
            after_trim = &after_trim[1..];
        }
        let word_is_socket = word == b"New" || word == b"disconnected" || word == b"join" || word == b"leave";
        if word_is_socket && (after_trim.starts_with(b"Connection {") || after_trim.starts_with(b"{")) {
            return true;
        }
        // `Token parts: [`
        if word == b"Token" && after.starts_with(b" parts: [") {
            return true;
        }
        // `method: 'join'` / `method: 'disconnect'`
        if word == b"method" && (after.starts_with(b": 'join'") || after.starts_with(b": 'disconnect'")) {
            return true;
        }
        // `address: '::ffff:` (socket connection dumps)
        if word == b"address" && after.starts_with(b": '::ffff:") {
            return true;
        }
        // `id: '…` (Socket.IO connection-id dumps)
        if word == b"id" && after.starts_with(b": '") && body.len() <= 64 {
            return true;
        }
        return false;
    }
    // Socket.IO frame fragments: bare `{`/`}`/`[`/`]` (optionally with trailing comma/space),
    // `{ 'socketId': … }` maps, `] { …` and `] Length: N` leave-frame tails.
    let bare = body[1..]
        .iter()
        .all(|&c| c == b' ' || c == b'\t' || c == b',');
    if c0 == b'{' {
        return bare || body.starts_with(b"{ '");
    }
    if c0 == b'[' {
        return bare;
    }
    if c0 == b'}' {
        return bare;
    }
    if c0 == b']' {
        if body.starts_with(b"] {") || body.starts_with(b"] Length:") {
            return true;
        }
        return bare;
    }
    false
}

fn strip_ansi_bytes(buf: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(buf.len());
    let mut i = 0;
    while i < buf.len() {
        if i + 1 < buf.len() && buf[i] == 0x1b && buf[i + 1] == b'[' {
            i = skip_ansi(buf, i, buf.len());
            continue;
        }
        out.push(buf[i]);
        i += 1;
    }
    out
}

fn try_http_a(
    buf: &[u8],
    start: usize,
    end: usize,
    timestamp_body_start: &mut Option<usize>,
) -> Option<LineKind> {
    let mut i = skip_space_ansi(buf, start, end);
    let (hour, date) = if let Some((ni, _, _, hour, date_bytes)) = skip_timestamp(buf, i, end) {
        *timestamp_body_start = Some(ni);
        if ni != i {
            i = ni;
        }
        ((hour < 24).then_some(hour), Some(date_bytes))
    } else {
        *timestamp_body_start = None;
        (None, None)
    };
    let (method, ni) = parse_method(buf, i, end)?;
    i = ni;
    let (ps, pe, ni) = read_token(buf, i, end)?;
    i = skip_space_ansi(buf, ni, end);
    if i + 3 > end {
        return None;
    }
    let s0 = buf[i];
    let s1 = buf[i + 1];
    let s2 = buf[i + 2];
    if !is_digit(s0) || !is_digit(s1) || !is_digit(s2) {
        return None;
    }
    let after_status = i + 3;
    if after_status < end {
        let n = buf[after_status];
        if n != b' ' && n != b'\t' && n != 0x1b {
            return None;
        }
    }
    let status = ((s0 - b'0') as u16) * 100 + ((s1 - b'0') as u16) * 10 + ((s2 - b'0') as u16);
    i = after_status;
    let (dur, ni) = parse_float(buf, i, end)?;
    // Fast path: " ms - " is standard PM2 HTTP log format
    if ni + 6 <= end && &buf[ni..ni + 6] == b" ms - " {
        i = ni + 6;
    } else {
        i = skip_space_ansi(buf, ni, end);
        if i + 1 >= end || buf[i] != b'm' || buf[i + 1] != b's' {
            return None;
        }
        i = skip_space_ansi(buf, i + 2, end);
        if i >= end || buf[i] != b'-' {
            return None;
        }
        i = skip_space_ansi(buf, i + 1, end);
    }
    if i >= end {
        return None;
    }
    if buf[i] == b'-' {
        i += 1;
    } else {
        let b0 = i;
        while i < end && is_digit(buf[i]) {
            i += 1;
        }
        if i == b0 {
            return None;
        }
    }
    if !only_space_ansi_left(buf, i, end) {
        return None;
    }
    Some(LineKind::Http {
        method,
        path_start: ps,
        path_end: pe,
        status,
        duration_ms: dur,
        hour,
        date,
    })
}

fn try_http_b(buf: &[u8], start: usize, end: usize) -> Option<LineKind> {
    let mut i = skip_space_ansi(buf, start, end);
    let (dur, ni) = parse_float(buf, i, end)?;
    i = skip_space_ansi(buf, ni, end);
    if i + 1 >= end || buf[i] != b'm' || buf[i + 1] != b's' {
        return None;
    }
    i = skip_space_ansi(buf, i + 2, end);
    let (method, ni) = parse_method(buf, i, end)?;
    i = ni;
    let (ps, pe, ni) = read_token(buf, i, end)?;
    if !only_space_ansi_left(buf, ni, end) {
        return None;
    }
    Some(LineKind::Http {
        method,
        path_start: ps,
        path_end: pe,
        status: 0,
        duration_ms: dur,
        hour: None,
        date: None,
    })
}

fn try_cron(buf: &[u8], start: usize, end: usize) -> Option<LineKind> {
    let mut i = skip_space_ansi(buf, start, end);
    let ts = skip_timestamp(buf, i, end);
    if let Some((ni, _, _, _, _)) = ts {
        i = ni;
    }
    let cron_idx = find_cron_mark(buf, i, end)?;
    let mut k = i;
    while k < cron_idx {
        k = skip_ansi(buf, k, end);
        if k >= cron_idx {
            break;
        }
        let c = buf[k];
        if c == b' ' || c == b'\t' {
            k += 1;
            continue;
        }
        return None;
    }
    i = skip_space_ansi(buf, cron_idx + 6, end);
    let event = if i + 5 <= end && &buf[i..i + 5] == b"start" && (i + 5 >= end || buf[i + 5] == b' ')
    {
        i += 5;
        0u8
    } else if i + 4 <= end && &buf[i..i + 4] == b"done" && (i + 4 >= end || buf[i + 4] == b' ') {
        i += 4;
        1
    } else if i + 4 <= end && &buf[i..i + 4] == b"fail" && (i + 4 >= end || buf[i + 4] == b' ') {
        i += 4;
        2
    } else {
        return None;
    };
    i = skip_space_ansi(buf, i, end);
    let mut name = strip_ansi_bytes(&buf[i..end]);
    // trim without O(n) remove(0)
    let mut lo = 0usize;
    let mut hi = name.len();
    while lo < hi && (name[lo] == b' ' || name[lo] == b'\t') {
        lo += 1;
    }
    while hi > lo && (name[hi - 1] == b' ' || name[hi - 1] == b'\t') {
        hi -= 1;
    }
    if lo > 0 || hi < name.len() {
        name = name[lo..hi].to_vec();
    }
    if name.is_empty() {
        return None;
    }
    let mut duration_ms = None;
    // trailing "… NAME DURATIONms"
    if name.ends_with(b"ms") {
        let body = &name[..name.len() - 2];
        let body = {
            let mut b = body.to_vec();
            while b.last() == Some(&b' ') || b.last() == Some(&b'\t') {
                b.pop();
            }
            b
        };
        if let Some(sp) = body.iter().rposition(|&c| c == b' ' || c == b'\t') {
            let num = &body[sp + 1..];
            let name_part = {
                let mut n = body[..sp].to_vec();
                while n.last() == Some(&b' ') || n.last() == Some(&b'\t') {
                    n.pop();
                }
                n
            };
            if !name_part.is_empty() {
                if let Some((v, consumed)) = parse_float(num, 0, num.len()) {
                    if consumed == num.len() {
                        name = name_part;
                        duration_ms = Some(v);
                    }
                }
            }
        }
    }
    let ts_bytes = ts.map(|(_, a, b, _, _)| buf[a..b].to_vec());
    Some(LineKind::Cron {
        event,
        name,
        ts: ts_bytes,
        duration_ms,
    })
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
    let g = buf[gate];
    let method_start = matches!(g, b'G' | b'P' | b'H' | b'D');
    // httpB (duration-first) allows a leading '.' (e.g. `.5ms GET /x`).
    let float_start = g.is_ascii_digit() || g == b'.';
    let cron_start = g == b'[';
    let mut timestamp_body_start = None;

    if method_start || float_start {
        if let Some(k) = try_http_a(buf, start, end, &mut timestamp_body_start) {
            return k;
        }
    }
    if cron_start {
        if let Some(k) = try_cron(buf, start, end) {
            return k;
        }
    } else if float_start && g.is_ascii_digit() {
        // Timestamp-first lines may still embed `[cron]` after the timestamp.
        if find_cron_mark(buf, start, end).is_some() {
            if let Some(k) = try_cron(buf, start, end) {
                return k;
            }
        }
    }
    if float_start {
        if let Some(k) = try_http_b(buf, start, end) {
            return k;
        }
    }
    // Only these leading bytes can start a socket-noise shape. Avoid reparsing the
    // timestamp/body for ordinary unmatched payload lines.
    let socket_candidate = g.is_ascii_digit()
        || matches!(
            g,
            b'N' | b'd' | b'j' | b'l' | b'T' | b'm' | b'a' | b'i' | b'{' | b'}' | b'[' | b']'
        );
    if socket_candidate && is_socket_noise(buf, start, end, timestamp_body_start) {
        // Socket.IO / socket tracking lines are pure noise — skip like empty lines.
        return LineKind::Empty;
    }
    if buf[gate] > 32 {
        LineKind::Unmatched
    } else if !has_non_space(buf, start, end) {
        LineKind::Empty
    } else {
        LineKind::Unmatched
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_a() {
        let s = b"2026-07-24T00:00:10: GET /api/health 200 12.5 ms - 42";
        match parse_line_bytes(s, 0, s.len()) {
            LineKind::Http {
                method,
                path_start,
                path_end,
                status,
                duration_ms,
                hour,
                date,
            } => {
                assert_eq!(method, Method::Get);
                assert_eq!(&s[path_start..path_end], b"/api/health");
                assert_eq!(status, 200);
                assert!((duration_ms - 12.5).abs() < 0.01);
                assert_eq!(hour, Some(0));
                assert_eq!(date, Some(*b"2026-07-24"));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn http_a_no_timestamp() {
        let s = b"\x1b[0mPOST /api/admin/dashboard/dashboarddata \x1b[32m200\x1b[0m 71.197 ms - 223\x1b[0m";
        match parse_line_bytes(s, 0, s.len()) {
            LineKind::Http {
                method,
                path_start,
                path_end,
                status,
                duration_ms,
                hour,
                date,
            } => {
                assert_eq!(method, Method::Post);
                assert_eq!(&s[path_start..path_end], b"/api/admin/dashboard/dashboarddata");
                assert_eq!(status, 200);
                assert!((duration_ms - 71.197).abs() < 0.01);
                assert_eq!(hour, None);
                assert_eq!(date, None);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn http_b() {
        let s = b"68064.174ms\tPOST /api/admin/user/getuserbyrole";
        match parse_line_bytes(s, 0, s.len()) {
            LineKind::Http {
                method,
                status,
                duration_ms,
                ..
            } => {
                assert_eq!(method, Method::Post);
                assert_eq!(status, 0);
                assert!((duration_ms - 68064.174).abs() < 0.01);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn http_b_leading_dot() {
        // Duration-first lines may start with '.' (e.g. `.5ms GET /x`).
        let s = b".5ms GET /api/dot";
        match parse_line_bytes(s, 0, s.len()) {
            LineKind::Http {
                method,
                path_start,
                path_end,
                duration_ms,
                ..
            } => {
                assert_eq!(method, Method::Get);
                assert_eq!(&s[path_start..path_end], b"/api/dot");
                assert!((duration_ms - 0.5).abs() < 0.01);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn empty_and_unmatched() {
        assert!(matches!(parse_line_bytes(b"   ", 0, 3), LineKind::Empty));
        assert!(matches!(
            parse_line_bytes(b"socket connected", 0, 16),
            LineKind::Unmatched
        ));
    }

    #[test]
    fn options_is_noise() {
        let s = b"2026-07-24T00:00:10: \x1b[0mOPTIONS /api/x \x1b[32m204\x1b[0m 0.115 ms - 0\x1b[0m";
        assert!(matches!(
            parse_line_bytes(s, 0, s.len()),
            LineKind::Empty | LineKind::Unmatched
        ));
    }

    #[test]
    fn socket_noise_is_skipped() {
        let cases: &[&[u8]] = &[
            b"2026-07-24T00:00:05: New Connection { address: '::ffff:127.0.0.1', id: 'abc' }",
            b"2026-07-24T00:00:39: disconnected { id: 'abc', method: 'disconnect' }",
            b"2026-07-24T00:01:29: join {",
            b"  { 'abc': undefined }",
            b"}",
            b"] { CoNctv8nmitCu03iAAEW: undefined }",
            b"] Length: 5",
            b"2026-07-24T00:04:28: Token parts: [",
            b"  address: '::ffff:127.0.0.1',",
            b"  method: 'join'",
        ];
        for c in cases {
            assert!(
                matches!(parse_line_bytes(c, 0, c.len()), LineKind::Empty),
                "expected Empty for {:?}",
                String::from_utf8_lossy(c)
            );
        }
        // Legit non-HTTP lines stay unmatched, not silently dropped.
        let keep: &[&[u8]] = &[
            b"Generated new NCD declaration for proposal PR-MOT-20261397003",
            b"useOfVehicle 1 vehicleUsage 1",
            b"customerReferenceNumber: 'QN/02/4030/2026/0715183'",
        ];
        for c in keep {
            assert!(
                matches!(parse_line_bytes(c, 0, c.len()), LineKind::Unmatched),
                "expected Unmatched for {:?}",
                String::from_utf8_lossy(c)
            );
        }
    }
}
