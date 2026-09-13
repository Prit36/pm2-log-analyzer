//! Socket.IO / socket connection noise detection.

use super::scan::{skip_space_ansi, skip_timestamp};

/// Socket.IO / socket connection noise: preflight `OPTIONS` is handled by dropping
/// the method; these are the chat/tracking lines that are pure noise for HTTP analysis.
#[inline]
pub(super) fn is_socket_noise(
    buf: &[u8],
    start: usize,
    end: usize,
    timestamp_body_start: Option<usize>,
) -> bool {
    let body = match timestamp_body_start {
        Some(body_start) => &buf[body_start..end],
        None => noise_body(buf, start, end),
    };
    match body.first() {
        None => false,
        Some(first) if first.is_ascii_alphabetic() => is_socket_word_noise(body),
        Some(_) => is_socket_frame_noise(body),
    }
}

/// Line content after the optional PM2 timestamp + leading whitespace.
fn noise_body<'a>(buf: &'a [u8], start: usize, end: usize) -> &'a [u8] {
    let mut index = skip_space_ansi(buf, start, end);
    if let Some((body_start, _, _, _, _)) = skip_timestamp(buf, index, end) {
        if body_start != index {
            index = body_start;
        }
    }
    let mut content_start = index;
    while content_start < end && (buf[content_start] == b' ' || buf[content_start] == b'\t') {
        content_start += 1;
    }
    &buf[content_start..end]
}

/// Keyword shapes: `New Connection {`, `disconnected {`, `join {`, `leave {`,
/// `Token parts: [`, `method: 'join'`, `address: '::ffff:`, `id: '…`.
fn is_socket_word_noise(body: &[u8]) -> bool {
    let word_len = body
        .iter()
        .take_while(|&&byte| byte.is_ascii_alphanumeric())
        .count();
    let word = &body[..word_len];
    let after = &body[word_len..];
    match word {
        b"New" | b"disconnected" | b"join" | b"leave" => {
            let after_trimmed = skip_spaces_and_tabs(after);
            after_trimmed.starts_with(b"Connection {") || after_trimmed.starts_with(b"{")
        }
        b"Token" => after.starts_with(b" parts: ["),
        b"method" => after.starts_with(b": 'join'") || after.starts_with(b": 'disconnect'"),
        b"address" => after.starts_with(b": '::ffff:"),
        b"id" => after.starts_with(b": '") && body.len() <= 64,
        _ => false,
    }
}

/// Frame shapes: bare `{`/`}`/`[`/`]` (optionally with trailing comma/space),
/// `{ 'socketId': … }` maps, and `] { …` / `] Length: N` leave-frame tails.
fn is_socket_frame_noise(body: &[u8]) -> bool {
    let bare = body[1..]
        .iter()
        .all(|&byte| byte == b' ' || byte == b'\t' || byte == b',');
    match body.first() {
        Some(b'{') => bare || body.starts_with(b"{ '"),
        Some(b'[') | Some(b'}') => bare,
        Some(b']') => body.starts_with(b"] {") || body.starts_with(b"] Length:") || bare,
        _ => false,
    }
}

fn skip_spaces_and_tabs(bytes: &[u8]) -> &[u8] {
    let mut start = 0;
    while start < bytes.len() && (bytes[start] == b' ' || bytes[start] == b'\t') {
        start += 1;
    }
    &bytes[start..]
}
