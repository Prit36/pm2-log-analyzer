//! Path normalization (parity with src/parser/normalize.ts).

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

/// Collapse-aware normalization into a reusable scratch buffer: one pass over
/// the path, no per-path allocation. Returns `path` itself when nothing
/// collapsed (the scratch contents are then meaningless).
pub fn normalize_into<'a>(
    path: &'a [u8],
    mode: NormalizeMode,
    scratch: &'a mut Vec<u8>,
) -> &'a [u8] {
    if mode == NormalizeMode::Exact {
        return path;
    }
    let path = strip_query(path);
    if mode != NormalizeMode::CollapseIds {
        return path;
    }
    scratch.clear();
    let mut collapsed = false;
    let mut start = 0usize;
    for index in 0..=path.len() {
        if index == path.len() || path[index] == b'/' {
            let segment = &path[start..index];
            let replacement = collapse_segment(segment);
            if !std::ptr::eq(replacement.as_ptr(), segment.as_ptr()) {
                collapsed = true;
            }
            scratch.extend_from_slice(replacement);
            if index < path.len() {
                scratch.push(b'/');
            }
            start = index + 1;
        }
    }
    if collapsed { scratch } else { path }
}

/// Drop the query string (`?…`) when the mode keeps the path at all.
fn strip_query(path: &[u8]) -> &[u8] {
    match memchr::memchr(b'?', path) {
        Some(query_start) => &path[..query_start],
        None => path,
    }
}

#[cfg(test)]
mod tests {
    use super::{normalize_into, NormalizeMode};

    /// Normalize with a fresh scratch buffer, like a single call would.
    fn normalized(path: &[u8], mode: NormalizeMode) -> Vec<u8> {
        let mut scratch = Vec::new();
        normalize_into(path, mode, &mut scratch).to_vec()
    }

    #[test]
    fn collapse_object_id() {
        let path = b"/api/users/507f1f77bcf86cd799439011/profile";
        assert_eq!(normalized(path, NormalizeMode::CollapseIds), b"/api/users/:id/profile");
    }

    #[test]
    fn strip_query() {
        assert_eq!(normalized(b"/api/x?foo=1&bar=2", NormalizeMode::StripQuery), b"/api/x");
    }

    #[test]
    fn collapse_noop_keeps_bytes() {
        assert_eq!(normalized(b"/api/health", NormalizeMode::CollapseIds), b"/api/health");
    }

    #[test]
    fn exact_keeps_query() {
        assert_eq!(normalized(b"/api/x?foo=1", NormalizeMode::Exact), b"/api/x?foo=1");
    }
}
