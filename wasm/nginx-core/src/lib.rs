//! Retained compact Nginx access-log columns shared by Wasm and native ingestion.

mod aggregate;
mod parse;
mod wire;

pub use aggregate::{Filters, Partial, Report, merge_partials};
pub use parse::is_access_line;

use hashbrown::HashTable;
use std::borrow::Cow;
use wasm_bindgen::prelude::*;

#[derive(Default)]
struct Intern {
    values: Vec<String>,
    hashes: Vec<u64>,
    table: HashTable<u32>,
}

impl Intern {
    fn intern(&mut self, bytes: &[u8]) -> u32 {
        let value = canonical_text(bytes);
        let bytes = value.as_bytes();
        let hash = rapidhash::v3::rapidhash_v3(bytes);
        if let Some(&id) = self
            .table
            .find(hash, |&id| self.values[id as usize].as_bytes() == bytes)
        {
            return id;
        }
        let id = self.values.len() as u32;
        self.values.push(value.into_owned());
        self.hashes.push(hash);
        self.table
            .insert_unique(hash, id, |&id| self.hashes[id as usize]);
        id
    }
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

#[derive(Clone, Copy)]
struct Row {
    bytes: u64,
    path: u32,
    client: u32,
    referrer: u32,
    agent: u32,
    date: u32,
    method: u32,
    request_ms: f32,
    upstream_ms: f32,
    request_key: i16,
    upstream_key: i16,
    status: u16,
    hour: u8,
}

#[derive(Default)]
struct Normalized {
    paths: Intern,
    ids: Vec<u32>,
}

#[derive(Default)]
pub struct Engine {
    rows: Vec<Row>,
    paths: Intern,
    clients: Intern,
    referrers: Intern,
    agents: Intern,
    dates: Intern,
    methods: Intern,
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
        self.rows.len()
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
    }

    pub fn end_source(&mut self) {
        if !self.carry.is_empty() {
            let line = std::mem::take(&mut self.carry);
            self.accept_line(&line);
        }
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
