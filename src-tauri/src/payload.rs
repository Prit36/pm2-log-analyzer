//! Loopback payload delivery for large result JSON.
//!
//! Tauri's IPC custom protocol tops out around 140MB/s on WebView2, which costs
//! ~55ms for a 7MB result, while a localhost HTTP server moves the same bytes in
//! ~20ms. Commands return a small [`crate::PayloadRef`] instead of the payload
//! itself; the webview fetches it from here.
//!
//! The listener is bound to an ephemeral 127.0.0.1 port with a per-process
//! random path token, so only this process's own webview can read payloads.

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

/// How many of the most recent payloads stay fetchable. Extra headroom lets the
/// webview retry or re-read a payload, while bounding retained memory.
const KEEP_PAYLOADS: usize = 4;
const MAX_REQUEST_BYTES: usize = 2048;

pub struct PayloadServer {
    base: String,
    payloads: Mutex<VecDeque<(u64, Vec<u8>)>>,
    next: AtomicU64,
}

impl PayloadServer {
    /// Bind the loopback listener and start serving in the background.
    pub fn start() -> Arc<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind payload listener");
        let port = listener
            .local_addr()
            .expect("payload listener address")
            .port();
        let server = Arc::new(Self {
            base: format!("http://127.0.0.1:{port}/p/{}", random_token()),
            payloads: Mutex::new(VecDeque::new()),
            next: AtomicU64::new(1),
        });
        let serving = Arc::clone(&server);
        std::thread::Builder::new()
            .name("payload-server".into())
            .spawn(move || serving.accept_loop(listener))
            .expect("spawn payload server");
        server
    }

    /// Retain one payload and return the reference the webview fetches it with.
    pub fn publish(&self, bytes: Vec<u8>) -> (u64, String, usize) {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let url = format!("{}/{}", self.base, id);
        let length = bytes.len();
        let mut payloads = self.payloads.lock().unwrap();
        payloads.push_back((id, bytes));
        while payloads.len() > KEEP_PAYLOADS {
            payloads.pop_front();
        }
        (id, url, length)
    }

    /// Serve requests one at a time; each connection carries exactly one.
    fn accept_loop(&self, listener: TcpListener) {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else {
                continue;
            };
            let _ = self.serve(&mut stream);
        }
    }

    fn serve(&self, stream: &mut TcpStream) -> std::io::Result<()> {
        let mut request = [0u8; MAX_REQUEST_BYTES];
        let mut filled = 0;
        while filled < request.len() {
            let read = stream.read(&mut request[filled..])?;
            if read == 0 {
                break;
            }
            filled += read;
            if request[..filled].windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
        }
        let head = String::from_utf8_lossy(&request[..filled]);
        let path = head.split_whitespace().nth(1).unwrap_or("");
        let id = path.rsplit('/').next().and_then(|last| last.parse::<u64>().ok());

        let payloads = self.payloads.lock().unwrap();
        match id.and_then(|id| {
            payloads
                .iter()
                .find(|(stored, _)| *stored == id)
                .map(|(_, bytes)| bytes)
        }) {
            Some(bytes) => write_response(stream, "200 OK", "application/json", bytes),
            None => write_response(stream, "404 Not Found", "text/plain", b"not found"),
        }
    }
}

/// One HTTP response, then close: `Connection: close` lets Chromium size the
/// body off `Content-Length` without chunking.
fn write_response(
    stream: &mut TcpStream,
    status: &str,
    content_type: &str,
    body: &[u8],
) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n\
         Access-Control-Allow-Origin: *\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}

/// A per-process token so another local process cannot guess the payload path.
fn random_token() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    hasher.write_u128((now << 32) ^ u128::from(std::process::id()));
    format!("{:016x}", hasher.finish())
}
