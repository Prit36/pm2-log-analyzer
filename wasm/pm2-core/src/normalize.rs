//! Path normalization (parity with src/parser/normalize.ts).

use std::borrow::Cow;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum NormalizeMode {
    Exact = 0,
    StripQuery = 1,
    CollapseIds = 2,
}

impl NormalizeMode {
    pub fn from_u8(v: u8) -> Self {
        match v {
            1 => Self::StripQuery,
            2 => Self::CollapseIds,
            _ => Self::Exact,
        }
    }
}

fn is_object_id(seg: &[u8]) -> bool {
    if seg.len() != 24 {
        return false;
    }
    seg.iter().all(|&c| c.is_ascii_hexdigit())
}

fn is_long_numeric(seg: &[u8]) -> bool {
    seg.len() >= 6 && seg.iter().all(|&c| c.is_ascii_digit())
}

fn is_uuid(seg: &[u8]) -> bool {
    // 8-4-4-4-12 hex with dashes (36 bytes)
    if seg.len() != 36 {
        return false;
    }
    if seg[8] != b'-' || seg[13] != b'-' || seg[18] != b'-' || seg[23] != b'-' {
        return false;
    }
    seg[..8].iter().all(|&c| c.is_ascii_hexdigit())
        && seg[9..13].iter().all(|&c| c.is_ascii_hexdigit())
        && seg[14..18].iter().all(|&c| c.is_ascii_hexdigit())
        && seg[19..23].iter().all(|&c| c.is_ascii_hexdigit())
        && seg[24..].iter().all(|&c| c.is_ascii_hexdigit())
}

fn is_pr_id(seg: &[u8]) -> bool {
    // /^PR-[A-Z]{3,}-\d{8,}$/i
    if !eq_ignore_ascii_case_prefix(seg, b"PR-") {
        return false;
    }
    let rest = &seg[3..];
    let Some(dash) = memchr::memchr(b'-', rest) else {
        return false;
    };
    let letters = &rest[..dash];
    let digits = &rest[dash + 1..];
    if letters.len() < 3 || !letters.iter().all(|&c| c.is_ascii_alphabetic()) {
        return false;
    }
    digits.len() >= 8 && digits.iter().all(|&c| c.is_ascii_digit())
}

fn eq_ignore_ascii_case_prefix(hay: &[u8], needle: &[u8]) -> bool {
    if hay.len() < needle.len() {
        return false;
    }
    hay[..needle.len()]
        .iter()
        .zip(needle.iter())
        .all(|(a, b)| a.eq_ignore_ascii_case(b))
}

fn is_code_id(seg: &[u8]) -> bool {
    // [A-Z]{2,}-[A-Z]{2,}-\d{6,}
    let Some(d1) = memchr::memchr(b'-', seg) else {
        return false;
    };
    let a = &seg[..d1];
    let rest = &seg[d1 + 1..];
    let Some(d2) = memchr::memchr(b'-', rest) else {
        return false;
    };
    let b = &rest[..d2];
    let digits = &rest[d2 + 1..];
    a.len() >= 2
        && a.iter().all(|&c| c.is_ascii_alphabetic())
        && b.len() >= 2
        && b.iter().all(|&c| c.is_ascii_alphabetic())
        && digits.len() >= 6
        && digits.iter().all(|&c| c.is_ascii_digit())
}

fn collapse_segment(seg: &[u8]) -> &[u8] {
    if seg.len() < 6 {
        return seg;
    }
    if is_object_id(seg) || is_long_numeric(seg) || is_uuid(seg) || is_pr_id(seg) || is_code_id(seg) {
        return b":id";
    }
    seg
}

pub fn normalize_path(path: &[u8], mode: NormalizeMode) -> Cow<'_, [u8]> {
    if mode == NormalizeMode::Exact {
        return Cow::Borrowed(path);
    }
    let mut p = path;
    if matches!(mode, NormalizeMode::StripQuery | NormalizeMode::CollapseIds) {
        if let Some(q) = memchr::memchr(b'?', path) {
            p = &path[..q];
        }
    }
    if mode != NormalizeMode::CollapseIds {
        // StripQuery: borrow the (possibly query-trimmed) slice — no alloc.
        return Cow::Borrowed(p);
    }
    // CollapseIds: borrow when no segment needs collapsing.
    let mut start = 0usize;
    let mut needs_collapse = false;
    for i in 0..=p.len() {
        if i == p.len() || p[i] == b'/' {
            let seg = &p[start..i];
            if collapse_segment(seg) != seg {
                needs_collapse = true;
                break;
            }
            start = i + 1;
        }
    }
    if !needs_collapse {
        return Cow::Borrowed(p);
    }
    let mut out = Vec::with_capacity(p.len());
    start = 0;
    for i in 0..=p.len() {
        if i == p.len() || p[i] == b'/' {
            let seg = &p[start..i];
            out.extend_from_slice(collapse_segment(seg));
            if i < p.len() {
                out.push(b'/');
            }
            start = i + 1;
        }
    }
    Cow::Owned(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collapse_object_id() {
        let p = b"/api/users/507f1f77bcf86cd799439011/profile";
        assert_eq!(
            normalize_path(p, NormalizeMode::CollapseIds).as_ref(),
            b"/api/users/:id/profile"
        );
    }

    #[test]
    fn strip_query() {
        let out = normalize_path(b"/api/x?foo=1&bar=2", NormalizeMode::StripQuery);
        assert_eq!(out.as_ref(), b"/api/x");
        assert!(matches!(out, Cow::Borrowed(_)));
    }

    #[test]
    fn collapse_noop_borrows() {
        let p = b"/api/health";
        let out = normalize_path(p, NormalizeMode::CollapseIds);
        assert_eq!(out.as_ref(), p);
        assert!(matches!(out, Cow::Borrowed(_)));
    }

    #[test]
    fn exact_keeps_query() {
        let p = b"/api/x?foo=1";
        let out = normalize_path(p, NormalizeMode::Exact);
        assert_eq!(out.as_ref(), p);
        assert!(matches!(out, Cow::Borrowed(_)));
    }
}
