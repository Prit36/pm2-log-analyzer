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
    pub fn from_u8(value: u8) -> Self {
        match value {
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
    let Some(first_dash) = memchr::memchr(b'-', seg) else {
        return false;
    };
    let first_letters = &seg[..first_dash];
    let rest = &seg[first_dash + 1..];
    let Some(second_dash) = memchr::memchr(b'-', rest) else {
        return false;
    };
    let second_letters = &rest[..second_dash];
    let trailing_digits = &rest[second_dash + 1..];
    first_letters.len() >= 2
        && first_letters.iter().all(|&c| c.is_ascii_alphabetic())
        && second_letters.len() >= 2
        && second_letters.iter().all(|&c| c.is_ascii_alphabetic())
        && trailing_digits.len() >= 6
        && trailing_digits.iter().all(|&c| c.is_ascii_digit())
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
    let path = strip_query(path);
    if mode != NormalizeMode::CollapseIds {
        // StripQuery: borrow the query-trimmed slice — no alloc.
        return Cow::Borrowed(path);
    }
    // CollapseIds: borrow when no segment needs collapsing.
    if !has_collapsible_segment(path) {
        return Cow::Borrowed(path);
    }
    Cow::Owned(collapse_segments(path))
}

/// Drop the query string (`?…`) when the mode keeps the path at all.
fn strip_query(path: &[u8]) -> &[u8] {
    match memchr::memchr(b'?', path) {
        Some(query_start) => &path[..query_start],
        None => path,
    }
}

fn has_collapsible_segment(path: &[u8]) -> bool {
    let mut start = 0usize;
    for index in 0..=path.len() {
        if index == path.len() || path[index] == b'/' {
            let segment = &path[start..index];
            if collapse_segment(segment) != segment {
                return true;
            }
            start = index + 1;
        }
    }
    false
}

fn collapse_segments(path: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(path.len());
    let mut start = 0usize;
    for index in 0..=path.len() {
        if index == path.len() || path[index] == b'/' {
            out.extend_from_slice(collapse_segment(&path[start..index]));
            if index < path.len() {
                out.push(b'/');
            }
            start = index + 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{normalize_path, NormalizeMode};
    use std::borrow::Cow;

    #[test]
    fn collapse_object_id() {
        let path = b"/api/users/507f1f77bcf86cd799439011/profile";
        assert_eq!(
            normalize_path(path, NormalizeMode::CollapseIds).as_ref(),
            b"/api/users/:id/profile",
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
        let path = b"/api/health";
        let out = normalize_path(path, NormalizeMode::CollapseIds);
        assert_eq!(out.as_ref(), path);
        assert!(matches!(out, Cow::Borrowed(_)));
    }

    #[test]
    fn exact_keeps_query() {
        let path = b"/api/x?foo=1";
        let out = normalize_path(path, NormalizeMode::Exact);
        assert_eq!(out.as_ref(), path);
        assert!(matches!(out, Cow::Borrowed(_)));
    }
}
