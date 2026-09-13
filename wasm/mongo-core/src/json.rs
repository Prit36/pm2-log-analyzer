//! Shared JSON byte helpers.

/// The balanced `open`..`close` span starting at `start`, quoted strings respected.
///
/// An unterminated span runs to the end of `bytes`.
pub(crate) fn scan_balanced(bytes: &[u8], start: usize, open: u8, close: u8) -> &[u8] {
    let mut depth = 1;
    let mut in_string = false;
    let mut index = start + 1;
    while index < bytes.len() && depth > 0 {
        let byte = bytes[index];
        index += 1;
        if in_string {
            match byte {
                b'\\' => index += 1,
                b'"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match byte {
            b'"' => in_string = true,
            b if b == open => depth += 1,
            b if b == close => depth -= 1,
            _ => {}
        }
    }
    &bytes[start..index]
}
