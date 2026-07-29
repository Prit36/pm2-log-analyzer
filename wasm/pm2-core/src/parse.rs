//! Byte-level PM2 log line parser (parity with src/parser/parseLine.ts).

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    Get = 0,
    Post = 1,
    Put = 2,
    Patch = 3,
    Delete = 4,
    Options = 5,
    Head = 6,
}

impl Method {
    pub fn from_code(c: u8) -> Option<Self> {
        match c {
            0 => Some(Self::Get),
            1 => Some(Self::Post),
            2 => Some(Self::Put),
            3 => Some(Self::Patch),
            4 => Some(Self::Delete),
            5 => Some(Self::Options),
            6 => Some(Self::Head),
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
            Self::Options => "OPTIONS",
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

#[inline]
fn is_digit(c: u8) -> bool {
    c.is_ascii_digit()
}

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

fn skip_space_ansi(buf: &[u8], mut i: usize, end: usize) -> usize {
    loop {
        i = skip_ansi(buf, i, end);
        if i >= end {
            return i;
        }
        let c = buf[i];
        if c == b' ' || c == b'\t' {
            i += 1;
            continue;
        }
        return i;
    }
}

fn only_space_ansi_left(buf: &[u8], i: usize, end: usize) -> bool {
    skip_space_ansi(buf, i, end) >= end
}

fn skip_timestamp(buf: &[u8], start: usize, end: usize) -> Option<(usize, usize, usize)> {
    if end - start < 20 {
        return None;
    }
    let a = start;
    for k in 0..10 {
        let c = buf[a + k];
        if k == 4 || k == 7 {
            if c != b'-' {
                return None;
            }
        } else if !is_digit(c) {
            return None;
        }
    }
    let sep = buf[a + 10];
    if sep != b'T' && sep != b' ' {
        return None;
    }
    for k in 11..19 {
        let c = buf[a + k];
        if k == 13 || k == 16 {
            if c != b':' {
                return None;
            }
        } else if !is_digit(c) {
            return None;
        }
    }
    if buf[a + 19] != b':' {
        return None;
    }
    Some((skip_space_ansi(buf, a + 20, end), a, a + 19))
}

fn parse_method(buf: &[u8], mut i: usize, end: usize) -> Option<(Method, usize)> {
    i = skip_space_ansi(buf, i, end);
    // Frequency order for this corpus (GET/POST dominate).
    const METHODS: &[(Method, &[u8])] = &[
        (Method::Get, b"GET"),
        (Method::Post, b"POST"),
        (Method::Put, b"PUT"),
        (Method::Head, b"HEAD"),
        (Method::Patch, b"PATCH"),
        (Method::Delete, b"DELETE"),
        (Method::Options, b"OPTIONS"),
    ];
    for &(method, bytes) in METHODS {
        if i + bytes.len() > end {
            continue;
        }
        if &buf[i..i + bytes.len()] != bytes {
            continue;
        }
        let after = i + bytes.len();
        let next = if after < end { buf[after] } else { b' ' };
        if next == b' ' || next == b'\t' || next == 0x1b || after >= end {
            return Some((method, after));
        }
    }
    None
}

fn read_token(buf: &[u8], mut i: usize, end: usize) -> Option<(usize, usize, usize)> {
    i = skip_space_ansi(buf, i, end);
    if i >= end {
        return None;
    }
    let start = i;
    while i < end {
        let c = buf[i];
        if c == b' ' || c == b'\t' || c == 0x1b {
            break;
        }
        i += 1;
    }
    if i == start {
        return None;
    }
    Some((start, i, i))
}

fn parse_float(buf: &[u8], mut i: usize, end: usize) -> Option<(f32, usize)> {
    i = skip_space_ansi(buf, i, end);
    let start = i;
    while i < end && is_digit(buf[i]) {
        i += 1;
    }
    if i < end && buf[i] == b'.' {
        i += 1;
        while i < end && is_digit(buf[i]) {
            i += 1;
        }
    }
    if i == start {
        return None;
    }
    let mut value: f32 = 0.0;
    let mut frac: f32 = 0.0;
    let mut frac_div: f32 = 1.0;
    let mut seen_dot = false;
    for &c in &buf[start..i] {
        if c == b'.' {
            seen_dot = true;
            continue;
        }
        let d = (c - b'0') as f32;
        if !seen_dot {
            value = value * 10.0 + d;
        } else {
            frac = frac * 10.0 + d;
            frac_div *= 10.0;
        }
    }
    if seen_dot {
        value += frac / frac_div;
    }
    Some((value, i))
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
        if c == 0x1b {
            i = skip_ansi(buf, i, end);
            continue;
        }
        i += 1;
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

fn try_http_a(buf: &[u8], start: usize, end: usize) -> Option<LineKind> {
    let mut i = skip_space_ansi(buf, start, end);
    if let Some((ni, _, _)) = skip_timestamp(buf, i, end) {
        if ni != i {
            i = ni;
        }
    }
    let (method, ni) = parse_method(buf, i, end)?;
    i = ni;
    let (ps, pe, ni) = read_token(buf, i, end)?;
    i = ni;
    let (ss, se, ni) = read_token(buf, i, end)?;
    if se - ss != 3 {
        return None;
    }
    let s0 = buf[ss];
    let s1 = buf[ss + 1];
    let s2 = buf[ss + 2];
    if !is_digit(s0) || !is_digit(s1) || !is_digit(s2) {
        return None;
    }
    let status = ((s0 - b'0') as u16) * 100 + ((s1 - b'0') as u16) * 10 + ((s2 - b'0') as u16);
    i = ni;
    let (dur, ni) = parse_float(buf, i, end)?;
    i = skip_space_ansi(buf, ni, end);
    if i + 1 >= end || buf[i] != b'm' || buf[i + 1] != b's' {
        return None;
    }
    i = skip_space_ansi(buf, i + 2, end);
    if i >= end || buf[i] != b'-' {
        return None;
    }
    i = skip_space_ansi(buf, i + 1, end);
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
    })
}

fn try_cron(buf: &[u8], start: usize, end: usize) -> Option<LineKind> {
    let mut i = skip_space_ansi(buf, start, end);
    let ts = skip_timestamp(buf, i, end);
    if let Some((ni, _, _)) = ts {
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
    let ts_bytes = ts.map(|(_, a, b)| buf[a..b].to_vec());
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
    if !has_non_space(buf, start, end) {
        return LineKind::Empty;
    }
    if find_cron_mark(buf, start, end).is_some() {
        if let Some(k) = try_cron(buf, start, end) {
            return k;
        }
    }
    if let Some(k) = try_http_a(buf, start, end) {
        return k;
    }
    if let Some(k) = try_http_b(buf, start, end) {
        return k;
    }
    let _ = start;
    LineKind::Unmatched
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
            } => {
                assert_eq!(method, Method::Get);
                assert_eq!(&s[path_start..path_end], b"/api/health");
                assert_eq!(status, 200);
                assert!((duration_ms - 12.5).abs() < 0.01);
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
            } => {
                assert_eq!(method, Method::Post);
                assert_eq!(&s[path_start..path_end], b"/api/admin/dashboard/dashboarddata");
                assert_eq!(status, 200);
                assert!((duration_ms - 71.197).abs() < 0.01);
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
    fn empty_and_unmatched() {
        assert!(matches!(parse_line_bytes(b"   ", 0, 3), LineKind::Empty));
        assert!(matches!(
            parse_line_bytes(b"socket connected", 0, 16),
            LineKind::Unmatched
        ));
    }
}
