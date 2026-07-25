//! Path normalization (parity with src/parser/normalize.ts).

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
    // 8-4-4-4-12 hex with dashes
    if seg.len() != 36 {
        return false;
    }
    let positions = [8usize, 13, 18, 23];
    for (i, &c) in seg.iter().enumerate() {
        if positions.contains(&i) {
            if c != b'-' {
                return false;
            }
        } else if !c.is_ascii_hexdigit() {
            return false;
        }
    }
    true
}

fn is_pr_id(seg: &[u8]) -> bool {
    // /^PR-[A-Z]{3,}-\d{8,}$/i
    if !eq_ignore_ascii_case_prefix(seg, b"PR-") {
        return false;
    }
    let rest = &seg[3..];
    let Some(dash) = rest.iter().position(|&c| c == b'-') else {
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
    let Some(d1) = seg.iter().position(|&c| c == b'-') else {
        return false;
    };
    let a = &seg[..d1];
    let rest = &seg[d1 + 1..];
    let Some(d2) = rest.iter().position(|&c| c == b'-') else {
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
    if seg.is_empty() {
        return seg;
    }
    if is_object_id(seg) || is_long_numeric(seg) || is_uuid(seg) || is_pr_id(seg) || is_code_id(seg) {
        return b":id";
    }
    seg
}

pub fn normalize_path(path: &[u8], mode: NormalizeMode) -> Vec<u8> {
    if mode == NormalizeMode::Exact {
        return path.to_vec();
    }
    let mut p = path;
    if matches!(mode, NormalizeMode::StripQuery | NormalizeMode::CollapseIds) {
        if let Some(q) = path.iter().position(|&c| c == b'?') {
            p = &path[..q];
        }
    }
    if mode != NormalizeMode::CollapseIds {
        return p.to_vec();
    }
    let mut out = Vec::with_capacity(p.len());
    let mut start = 0usize;
    for i in 0..=p.len() {
        if i == p.len() || p[i] == b'/' {
            let seg = &p[start..i];
            let collapsed = collapse_segment(seg);
            out.extend_from_slice(collapsed);
            if i < p.len() {
                out.push(b'/');
            }
            start = i + 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collapse_object_id() {
        let p = b"/api/users/507f1f77bcf86cd799439011/profile";
        assert_eq!(
            normalize_path(p, NormalizeMode::CollapseIds),
            b"/api/users/:id/profile"
        );
    }

    #[test]
    fn strip_query() {
        assert_eq!(
            normalize_path(b"/api/x?foo=1&bar=2", NormalizeMode::StripQuery),
            b"/api/x"
        );
    }

    #[test]
    fn exact_keeps_query() {
        assert_eq!(
            normalize_path(b"/api/x?foo=1", NormalizeMode::Exact),
            b"/api/x?foo=1"
        );
    }
}
