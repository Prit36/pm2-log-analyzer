//! MongoDB log analyzer Wasm core: parse bytes → compact columnar store → microsecond reagg.

pub use store::{Engine, MONGO_LINE_EXTEND};

mod fingerprint;
mod json;
mod parse;
mod reagg;
mod store;

#[cfg(test)]
mod tests;

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct MongoEngine {
    inner: Engine,
}

#[wasm_bindgen]
impl MongoEngine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> MongoEngine {
        MongoEngine {
            inner: Engine::new(),
        }
    }

    pub fn clear(&mut self) {
        self.inner.clear();
    }

    /// Grow ingest window to `len` bytes; returns pointer into Wasm memory for JS writes.
    pub fn ingest_ptr(&mut self, len: u32) -> u32 {
        self.inner.ingest_ptr(len)
    }

    /// Parse `len` bytes previously written at ingest_ptr; `abs_off` is file offset of those bytes.
    pub fn feed(&mut self, len: u32, abs_off: f64) -> u32 {
        self.inner.feed(len, abs_off as u64)
    }

    /// Finish shard (flush carry). Call after all feeds.
    pub fn end_shard(&mut self) {
        self.inner.end_shard();
    }

    pub fn slow_query_count(&self) -> u32 {
        self.inner.slow_query_count()
    }

    pub fn total_lines(&self) -> u32 {
        self.inner.total_lines as u32
    }

    /// Fast reaggregate returning serialized JSON string.
    pub fn reaggregate(
        &self,
        op: &str,
        plan_filter: u8,
        min_duration_ms: u32,
        collection: &str,
        search_query: &str,
        high_scan_ratio_only: bool,
        user: &str,
    ) -> String {
        let params = reagg::FilterParams {
            op,
            plan_filter,
            min_duration_ms,
            collection,
            search_query,
            high_scan_ratio_only,
            user,
        };
        reagg::reaggregate(&self.inner, params)
    }

    /// Parse shard directly from the ingest window without extra copying
    pub fn parse_shard_ingest(
        &mut self,
        len: u32,
        shard_start: f64,
        shard_end: f64,
        file_size: f64,
    ) -> usize {
        self.inner.parse_shard_ingest(
            len,
            shard_start as usize,
            shard_end as usize,
            file_size as usize,
        )
    }

    /// Encode shard data into compact transferable byte array for web worker messaging
    pub fn encode_shard(&self) -> Vec<u8> {
        self.inner.encode_shard()
    }

    /// Merge shard byte array directly into this engine
    pub fn merge_shard_bytes(&mut self, data: &[u8]) {
        let _ = self.inner.merge_shard_bytes(data);
    }

    /// Merge another MongoEngine into this one
    pub fn merge(&mut self, other: MongoEngine) {
        self.inner.merge(other.inner);
    }
}

// Native Rust methods (not exposed to JavaScript via wasm-bindgen glue to prevent slow JS copies)
impl MongoEngine {
    /// Parse shard slice [shard_start..shard_end] with lookahead up to MONGO_LINE_EXTEND.
    /// Used natively by Tauri desktop worker threads with zero-copy memory-mapped slices.
    pub fn parse_shard(
        &mut self,
        slice: &[u8],
        shard_start: f64,
        shard_end: f64,
        file_size: f64,
    ) -> usize {
        self.inner.parse_shard(
            slice,
            shard_start as usize,
            shard_end as usize,
            file_size as usize,
        )
    }

    /// Feed a byte slice directly. Used natively by Tauri desktop with memory-mapped slices.
    pub fn feed_slice(&mut self, data: &[u8]) -> u32 {
        self.inner.feed_slice(data)
    }

    #[cfg(test)]
    pub fn write_ingest_for_test(&mut self, data: &[u8]) {
        self.ingest_ptr(data.len() as u32);
        self.inner.ingest[..data.len()].copy_from_slice(data);
    }
}

impl Default for MongoEngine {
    fn default() -> Self {
        Self::new()
    }
}

