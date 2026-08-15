//! PM2 log analyzer Wasm core: parse bytes → columnar store → filter reagg.

mod normalize;
mod parse;
mod relhist;
mod store;

use wasm_bindgen::prelude::*;

pub use store::Engine;

/// Opaque engine handle for JS.
#[wasm_bindgen]
pub struct Pm2Engine {
    inner: Engine,
}

#[wasm_bindgen]
impl Pm2Engine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Pm2Engine {
        Pm2Engine {
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

    /// Start shard ownership [start, end) within file_size.
    pub fn begin_shard(&mut self, start: u32, end: u32, file_size: u32) {
        self.inner.begin_shard(start, end, file_size);
    }

    /// Parse `len` bytes previously written at ingest_ptr; `abs_off` is file offset of those bytes.
    pub fn feed(&mut self, len: u32, abs_off: u32) -> u32 {
        self.inner.feed(len, abs_off)
    }

    /// Finish shard (flush carry). Call after all feeds.
    pub fn end_shard(&mut self) {
        self.inner.end_shard();
    }

    /// One-shot parse (copies via wasm-bindgen) — tests / small text only.
    pub fn parse_shard(
        &mut self,
        buf: &[u8],
        shard_start: u32,
        shard_end: u32,
        file_size: u32,
    ) -> u32 {
        self.inner
            .parse_shard(buf, shard_start as usize, shard_end as usize, file_size as usize)
            as u32
    }

    pub fn hit_count(&self) -> u32 {
        self.inner.hit_count() as u32
    }

    pub fn unmatched_count(&self) -> u32 {
        self.inner.unmatched_count()
    }

    pub fn path_count(&self) -> u32 {
        self.inner.path_count() as u32
    }

    /// Lazily build normalize map for one mode (0/1/2). Prefer this over finalize_paths.
    pub fn ensure_mode(&mut self, mode: u8) {
        self.inner.ensure_mode(mode);
    }

    pub fn finalize_paths(&mut self) {
        self.inner.finalize_paths();
    }

    pub fn reaggregate(
        &mut self,
        normalize_mode: u8,
        status_family: u8,
        min_ms: f32,
        date_filter: &[u8],
        need_summary: bool,
    ) -> Vec<u8> {
        self.inner
            .reaggregate(normalize_mode, status_family, min_ms, date_filter, need_summary)
    }

    pub fn path_bytes(&self, path_id: u32) -> Option<Vec<u8>> {
        self.inner.path_bytes_of(path_id as usize)
    }

    pub fn norm_path_bytes(&self, mode: u8, norm_id: u32) -> Option<Vec<u8>> {
        self.inner.norm_path_bytes(mode, norm_id as usize)
    }

    pub fn cron_wire(&self) -> Vec<u8> {
        self.inner.cron_wire()
    }

    pub fn unmatched_sample_wire(&self) -> Vec<u8> {
        self.inner.unmatched_sample_wire()
    }

    pub fn summary_wire(&self) -> Vec<u8> {
        self.inner.summary_wire()
    }

    pub fn hourly_wire(&self) -> Vec<u8> {
        self.inner.hourly_wire()
    }

    pub fn dates_wire(&self) -> Vec<u8> {
        self.inner.dates_wire()
    }

    pub fn daily_wire(&self) -> Vec<u8> {
        self.inner.daily_wire()
    }

    pub fn methods_mask(&self) -> u8 {
        self.inner.methods_mask()
    }
}

impl Default for Pm2Engine {
    fn default() -> Self {
        Self::new()
    }
}
