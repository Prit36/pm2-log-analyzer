//! Retained compact Nginx access-log columns shared by Wasm and native ingestion.

mod aggregate;
mod parse;
mod wire;

pub use aggregate::{Filters, Partial, Report, merge_partials};
pub use parse::is_access_line;

use hashbrown::{HashMap, HashTable};
use std::borrow::Cow;
use wasm_bindgen::prelude::*;

/// Raw-byte values in one arena. Values are canonicalized to UTF-8 text only when
/// they leave the engine, so two raw spellings with the same text merge in `Partial`.
#[derive(Default)]
struct Intern {
    bytes: Vec<u8>,
    ends: Vec<usize>,
    table: HashTable<u32>,
    last: Option<u32>,
}

impl Intern {
    fn len(&self) -> usize {
        self.ends.len()
    }

    fn get(&self, id: u32) -> &[u8] {
        value(&self.bytes, &self.ends, id)
    }

    fn text(&self, id: u32) -> Cow<'_, str> {
        canonical_text(self.get(id))
    }

    /// Returns the value id and whether it was newly inserted.
    fn intern(&mut self, key: &[u8]) -> (u32, bool) {
        // Neighbouring lines often repeat a client, referrer or user agent.
        if let Some(last) = self.last
            && same_bytes(self.get(last), key)
        {
            return (last, false);
        }
        let Self {
            bytes,
            ends,
            table,
            last,
        } = self;
        let hash = hash_bytes(key);
        if let Some(&id) = table.find(hash, |&id| same_bytes(value(bytes, ends, id), key)) {
            *last = Some(id);
            return (id, false);
        }
        let id = ends.len() as u32;
        bytes.extend_from_slice(key);
        ends.push(bytes.len());
        table.insert_unique(hash, id, |&id| hash_bytes(value(bytes, ends, id)));
        *last = Some(id);
        (id, true)
    }
}

fn word(bytes: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(bytes[at..at + 8].try_into().expect("8-byte word"))
}

/// Multiply-xorshift hash over 8-byte words. Wasm has no 64x64->128-bit multiply,
/// so folded-multiply hashes (rapidhash, foldhash) call the `__multi3` helper there.
fn hash_bytes(bytes: &[u8]) -> u64 {
    const K: u64 = 0x9E37_79B9_7F4A_7C15;
    // Two independent lanes overlap the multiply latency on long keys.
    let mut hash = (bytes.len() as u64).wrapping_mul(K);
    let mut other = K;
    let mut at = 0;
    while at + 16 <= bytes.len() {
        hash = (hash ^ word(bytes, at)).wrapping_mul(K).rotate_left(31);
        other = (other ^ word(bytes, at + 8))
            .wrapping_mul(K)
            .rotate_left(27);
        at += 16;
    }
    hash ^= other.rotate_left(17);
    if at + 8 <= bytes.len() {
        hash = (hash ^ word(bytes, at)).wrapping_mul(K).rotate_left(31);
        at += 8;
    }
    if at < bytes.len() {
        let mut tail = [0u8; 8];
        tail[..bytes.len() - at].copy_from_slice(&bytes[at..]);
        hash = (hash ^ u64::from_le_bytes(tail)).wrapping_mul(K);
    }
    // MurmurHash3 finalizer: hashbrown takes its control byte from the top bits.
    hash ^= hash >> 33;
    hash = hash.wrapping_mul(0xFF51_AFD7_ED55_8CCD);
    hash ^= hash >> 33;
    hash = hash.wrapping_mul(0xC4CE_B9FE_1A85_EC53);
    hash ^ (hash >> 33)
}

/// Word-at-a-time equality; slice `==` lowers to a byte-wise `memcmp` on Wasm.
fn same_bytes(a: &[u8], b: &[u8]) -> bool {
    let len = a.len();
    if len != b.len() {
        return false;
    }
    if len < 8 {
        return a == b;
    }
    let mut at = 0;
    while at + 8 <= len {
        if word(a, at) != word(b, at) {
            return false;
        }
        at += 8;
    }
    word(a, len - 8) == word(b, len - 8)
}

fn value<'a>(bytes: &'a [u8], ends: &[usize], id: u32) -> &'a [u8] {
    let id = id as usize;
    let start = if id == 0 { 0 } else { ends[id - 1] };
    &bytes[start..ends[id]]
}

fn canonical_text(mut bytes: &[u8]) -> Cow<'_, str> {
    if let Ok(value) = std::str::from_utf8(bytes) {
        return Cow::Borrowed(value);
    }
    let mut value = String::with_capacity(bytes.len());
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    while !bytes.is_empty() {
        match std::str::from_utf8(bytes) {
            Ok(tail) => {
                value.push_str(tail);
                break;
            }
            Err(error) => {
                let valid = error.valid_up_to();
                // valid_up_to always marks a complete valid UTF-8 prefix.
                value.push_str(
                    std::str::from_utf8(&bytes[..valid]).expect("validated UTF-8 prefix"),
                );
                bytes = &bytes[valid..];
                let invalid = error.error_len().unwrap_or(bytes.len());
                for &byte in &bytes[..invalid] {
                    value.push_str("\\x");
                    value.push(char::from(HEX[(byte >> 4) as usize]));
                    value.push(char::from(HEX[(byte & 15) as usize]));
                }
                bytes = &bytes[invalid..];
            }
        }
    }
    Cow::Owned(value)
}

/// One request. `endpoint` is the interned `METHOD path` request target, `visitor`
/// the interned (client, referrer, user agent) triple and `time` the interned
/// (date, hour) bucket. Body sizes that do not fit `u32` are kept in
/// `Engine::large_bytes`.
#[derive(Clone, Copy)]
struct Row {
    endpoint: u32,
    visitor: u32,
    time: u32,
    bytes: u32,
    status: u16,
    timed: bool,
}

const LARGE_BYTES: u32 = u32::MAX;

/// Most access logs carry no `rt`/`urt`, so timings are a sparse side column read
/// in row order alongside `rows`.
#[derive(Clone, Copy)]
struct Timing {
    request_ms: f32,
    upstream_ms: f32,
    request_key: i16,
    upstream_key: i16,
}

/// Fixed-capacity row chunks never reallocate, so retained memory tracks the row
/// count instead of a doubling `Vec` (Wasm linear memory never shrinks).
const CHUNK_ROWS: usize = 1 << 16;

struct Chunk {
    rows: Vec<Row>,
    timings: Vec<Timing>,
}

struct HourSlot {
    date: u32,
    hour: u8,
}

/// Endpoint groups for one normalization mode, filled incrementally as endpoints arrive.
#[derive(Default)]
struct Normalized {
    groups: Intern,
    ids: Vec<u32>,
    key: Vec<u8>,
    scratch: Vec<u8>,
}

#[derive(Default)]
pub struct Engine {
    chunks: Vec<Chunk>,
    row_count: usize,
    large_bytes: HashMap<usize, u64>,
    endpoints: Intern,
    clients: Intern,
    referrers: Intern,
    agents: Intern,
    /// Length-prefixed `client referrer agent` keys; one probe per line instead of three.
    visitors: Intern,
    /// (client, referrer, agent) ids per visitor.
    visitor_fields: Vec<[u32; 3]>,
    visitor_key: Vec<u8>,
    methods: Intern,
    dates: Vec<[u8; 10]>,
    date_ids: HashMap<u32, u32>,
    times: Vec<HourSlot>,
    time_ids: HashMap<u32, u32>,
    last_time: Option<(u32, u32)>,
    normalized: [Option<Normalized>; 2],
    ingest: Vec<u8>,
    carry: Vec<u8>,
    diagnostics: aggregate::Diagnostics,
}

impl Engine {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn clear(&mut self) {
        *self = Self::new();
    }

    pub fn hit_count(&self) -> usize {
        self.row_count
    }

    pub fn ingest_ptr(&mut self, len: u32) -> u32 {
        self.ingest.resize(len as usize, 0);
        self.ingest.as_mut_ptr() as u32
    }

    pub fn feed(&mut self, len: u32) {
        // Moving the window temporarily allows parsing to mutate the retained columns
        // without aliasing a slice of self. The allocation stays owned and reusable.
        let window = std::mem::take(&mut self.ingest);
        self.feed_slice(&window[..len as usize]);
        self.ingest = window;
    }

    pub fn feed_slice(&mut self, bytes: &[u8]) {
        let mut start = 0;
        if !self.carry.is_empty() {
            if let Some(end) = memchr::memchr(b'\n', bytes) {
                let mut line = std::mem::take(&mut self.carry);
                line.extend_from_slice(&bytes[..end]);
                self.accept_line(&line);
                line.clear();
                self.carry = line;
                start = end + 1;
            } else {
                self.carry.extend_from_slice(bytes);
                return;
            }
        }
        let base = start;
        for offset in memchr::memchr_iter(b'\n', &bytes[base..]) {
            let end = base + offset;
            self.accept_line(&bytes[start..end]);
            start = end + 1;
        }
        self.carry.extend_from_slice(&bytes[start..]);
        // Group this window's new endpoints for the dashboard's default mode in one
        // batch, so the first aggregate after a parse only walks rows.
        self.normalize_pending(pm2_core::NormalizeMode::CollapseIds);
    }

    pub fn end_source(&mut self) {
        if !self.carry.is_empty() {
            let line = std::mem::take(&mut self.carry);
            self.accept_line(&line);
        }
    }

    fn visitor_id(&mut self, client: &[u8], referrer: &[u8], agent: &[u8]) -> u32 {
        let mut key = std::mem::take(&mut self.visitor_key);
        key.clear();
        for field in [client, referrer] {
            key.extend_from_slice(&(field.len() as u32).to_le_bytes());
            key.extend_from_slice(field);
        }
        key.extend_from_slice(agent);
        let (id, new) = self.visitors.intern(&key);
        self.visitor_key = key;
        if new {
            self.visitor_fields.push([
                self.clients.intern(client).0,
                self.referrers.intern(referrer).0,
                self.agents.intern(agent).0,
            ]);
        }
        id
    }

    /// `key` orders (date, hour) numerically; `date` is the `YYYY-MM-DD` label.
    fn time_id(&mut self, key: u32, date: [u8; 10], hour: u8) -> u32 {
        if let Some((last_key, id)) = self.last_time
            && last_key == key
        {
            return id;
        }
        let next = self.times.len() as u32;
        let id = *self.time_ids.entry(key).or_insert(next);
        if id == next {
            let next_date = self.dates.len() as u32;
            let date_id = *self.date_ids.entry(key / 24).or_insert(next_date);
            if date_id == next_date {
                self.dates.push(date);
            }
            self.times.push(HourSlot {
                date: date_id,
                hour,
            });
        }
        self.last_time = Some((key, id));
        id
    }

    fn push_row(&mut self, mut row: Row, bytes: u64, timing: Option<Timing>) {
        if self
            .chunks
            .last()
            .is_none_or(|chunk| chunk.rows.len() == CHUNK_ROWS)
        {
            self.chunks.push(Chunk {
                rows: Vec::with_capacity(CHUNK_ROWS),
                timings: Vec::new(),
            });
        }
        if bytes >= u64::from(LARGE_BYTES) {
            self.large_bytes.insert(self.row_count, bytes);
            row.bytes = LARGE_BYTES;
        } else {
            row.bytes = bytes as u32;
        }
        // SAFETY of unwrap: a chunk was pushed above when none had room.
        let chunk = self.chunks.last_mut().expect("row chunk");
        if let Some(timing) = timing {
            row.timed = true;
            chunk.timings.push(timing);
        }
        chunk.rows.push(row);
        self.row_count += 1;
    }
}

#[wasm_bindgen]
pub struct NginxEngine {
    inner: Engine,
}

#[wasm_bindgen]
impl NginxEngine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            inner: Engine::new(),
        }
    }
    pub fn clear(&mut self) {
        self.inner.clear();
    }
    pub fn ingest_ptr(&mut self, len: u32) -> u32 {
        self.inner.ingest_ptr(len)
    }
    pub fn feed(&mut self, len: u32) {
        self.inner.feed(len);
    }
    pub fn end_source(&mut self) {
        self.inner.end_source();
    }
    pub fn hit_count(&self) -> u32 {
        self.inner.hit_count() as u32
    }
    pub fn partial(&mut self, filters_json: &str) -> Result<Vec<u8>, JsValue> {
        let filters: Filters =
            serde_json::from_str(filters_json).map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(self.inner.aggregate(&filters).encode())
    }
}

#[wasm_bindgen]
pub struct NginxAggregator {
    inner: Partial,
}

#[wasm_bindgen]
impl NginxAggregator {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            inner: Partial::default(),
        }
    }
    pub fn add_partial(&mut self, bytes: &[u8]) -> Result<(), JsValue> {
        self.inner
            .merge(Partial::decode(bytes).map_err(JsValue::from_str)?);
        Ok(())
    }
    pub fn finish(&mut self, filters_json: &str) -> Result<String, JsValue> {
        let filters: Filters =
            serde_json::from_str(filters_json).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let report = std::mem::take(&mut self.inner).finish(&filters);
        serde_json::to_string(&report).map_err(|e| JsValue::from_str(&e.to_string()))
    }
}
