//! Persistent per-shard columnar store + reaggregation.

pub use decoded::{
    decode_pm2_partial, merge_decoded_partials, merge_two_decoded, DecodedEndpoint,
    DecodedPartial, DecodedSummary,
};
pub use wire::{
    encode_cron_vec, encode_daily_vec, encode_dates_vec, encode_hourly_vec, encode_unmatched_vec,
    merge_pm2_partials,
};

mod aggregate;
mod decoded;
mod ingest;
mod paths;
mod wire;

#[cfg(test)]
mod tests;

use crate::normalize::NormalizeMode;
use crate::relhist::RelHist;
use aggregate::{
    compact_hist_key, daily_for, SummaryRecord,
    SummaryTotal,
};
use hashbrown::HashTable;
use wire::PartialWire;

pub(super) const LINE_EXTEND: usize = 256 * 1024;
pub(super) const INVALID_RELHIST_KEY: i16 = i16::MIN;
/// Reusable ingest window. Keeps Wasm peak memory bounded.
pub const INGEST_CAP: usize = 32 * 1024 * 1024;
/// Direct-mapped path cache size; the fingerprint makes hits verification-free.
pub(super) const PATH_CACHE_SLOTS: usize = 8192;
pub(super) const UNMATCHED_SAMPLE_LIMIT: usize = 40;
pub(super) const UNMATCHED_SAMPLE_LEN: usize = 500;

#[inline(always)]
pub(super) fn hash_bytes(bytes: &[u8]) -> u64 {
    rapidhash::v3::rapidhash_v3(bytes)
}

/// Path-table entry. Carries a 96-bit fingerprint (hash + length + head) so a probe
/// never has to touch the path arena: the arena is only read when interning a new path.
#[derive(Clone, Copy, Debug)]
pub(super) struct PathSlot {
    pub(super) hash: u64,
    pub(super) id: u32,
    pub(super) len: u16,
    pub(super) head: u16,
}

#[inline(always)]
pub(super) fn path_head16(path: &[u8]) -> u16 {
    u16::from_le_bytes([path[0], path.get(1).copied().unwrap_or(0)])
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct PackedEntry {
    pub path_id: u32,
    pub duration: f32,
    pub meta: u32, // status:16, method:3, hour:5, date_id:8
}

impl PackedEntry {
    #[inline(always)]
    pub fn new(path_id: u32, duration: f32, status: u16, method: u8, hour: u8, date_id: u16) -> Self {
        let meta = (status as u32)
            | ((method as u32) << 16)
            | (((hour.min(31)) as u32) << 19)
            | (((date_id & 0xFF) as u32) << 24);
        Self {
            path_id,
            duration,
            meta,
        }
    }

    #[inline(always)]
    pub fn status(self) -> u16 {
        self.meta as u16
    }

    #[inline(always)]
    pub fn method(self) -> u8 {
        ((self.meta >> 16) & 0x7) as u8
    }

    #[inline(always)]
    pub fn hour(self) -> u8 {
        ((self.meta >> 19) & 0x1F) as u8
    }

    #[inline(always)]
    pub fn date_id(self) -> u16 {
        ((self.meta >> 24) & 0xFF) as u16
    }
}

#[derive(Clone, Debug)]
pub struct CronEv {
    pub event: u8,
    pub name: Vec<u8>,
    pub ts: Option<Vec<u8>>,
    pub duration_ms: Option<f32>,
}

#[derive(Clone, Debug)]
pub struct HourlyAcc {
    pub count: u32,
    pub error_count: u32,
    pub sum: f64,
    pub max: f32,
    pub sketch: RelHist,
}

impl HourlyAcc {
    pub fn new() -> Self {
        Self {
            count: 0,
            error_count: 0,
            sum: 0.0,
            max: 0.0,
            sketch: RelHist::new(),
        }
    }

    pub fn merge(&mut self, other: &HourlyAcc) {
        self.count += other.count;
        self.error_count += other.error_count;
        self.sum += other.sum;
        if other.max > self.max {
            self.max = other.max;
        }
        self.sketch.merge(&other.sketch);
    }

    /// Fold one parsed entry into this hour-of-day bucket.
    fn record(&mut self, record: &SummaryRecord) {
        self.count += 1;
        self.sum += record.duration as f64;
        if record.duration > self.max {
            self.max = record.duration;
        }
        if record.is_error {
            self.error_count += 1;
        }
        if record.hist_key != INVALID_RELHIST_KEY {
            self.sketch.accept_key(record.hist_key as i32);
        }
    }
}

impl Default for HourlyAcc {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Debug)]
pub struct DailyAcc {
    pub date: [u8; 10],
    pub count: u32,
    pub error_count: u32,
    pub slow_count: u32,
    pub sum: f64,
    pub max: f32,
    pub sketch: RelHist,
    pub hourly: [HourlyAcc; 24],
}

impl DailyAcc {
    pub fn new(date: [u8; 10]) -> Self {
        Self {
            date,
            count: 0,
            error_count: 0,
            slow_count: 0,
            sum: 0.0,
            max: 0.0,
            sketch: RelHist::new(),
            hourly: std::array::from_fn(|_| HourlyAcc::new()),
        }
    }

    pub fn merge(&mut self, other: &DailyAcc) {
        self.count += other.count;
        self.error_count += other.error_count;
        self.slow_count += other.slow_count;
        self.sum += other.sum;
        if other.max > self.max {
            self.max = other.max;
        }
        self.sketch.merge(&other.sketch);
        for index in 0..24 {
            self.hourly[index].merge(&other.hourly[index]);
        }
    }

    /// Fold one parsed entry into this day and its hour bucket.
    fn record(&mut self, record: &SummaryRecord) {
        self.count += 1;
        self.sum += record.duration as f64;
        if record.duration > self.max {
            self.max = record.duration;
        }
        if record.is_error {
            self.error_count += 1;
        }
        if record.is_slow {
            self.slow_count += 1;
        }
        if record.hist_key != INVALID_RELHIST_KEY {
            self.sketch.accept_key(record.hist_key as i32);
        }
        if let Some(hour) = self.hourly.get_mut(record.hour) {
            hour.record(record);
        }
    }
}

pub struct Engine {
    pub(super) ingest: Vec<u8>,
    pub(super) carry: Vec<u8>,
    /// Absolute file offset of carry[0], if carry non-empty.
    pub(super) carry_abs: u64,

    pub(super) path_bytes: Vec<u8>,
    pub(super) path_off: Vec<u32>,
    pub(super) path_len: Vec<u16>,
    pub(super) path_table: HashTable<PathSlot>,

    pub(super) entries: Vec<PackedEntry>,
    /// Cached RelHist bucket keys; avoids recomputing duration.ln() on each filter pass.
    pub(super) hist_keys: Vec<i16>,

    pub(super) dates: Vec<[u8; 10]>,
    pub(super) last_date: [u8; 10],
    pub(super) last_date_id: u16,

    pub(super) unmatched_count: u32,
    pub(super) unmatched_sample: Vec<Vec<u8>>,
    pub(super) cron_events: Vec<CronEv>,
    pub(super) methods_mask: u8,

    pub(super) norm_bytes: [Vec<u8>; 3],
    pub(super) norm_off: [Vec<u32>; 3],
    pub(super) norm_len: [Vec<u16>; 3],
    pub(super) norm_table: [HashTable<u32>; 3],
    pub(super) path_to_norm: [Vec<u32>; 3],
    pub(super) mode_ready: [bool; 3],

    /// Filter-independent summary computed once after parse.
    summary_sum: f64,
    summary_max: f32,
    summary_errors: u32,
    summary_slow: u32,
    summary_sketch: RelHist,
    summary_ready: bool,

    cached_hourly_wire: Vec<u8>,
    cached_daily_wire: Vec<u8>,
    hourly_buckets: [HourlyAcc; 24],
    daily_accs: Vec<DailyAcc>,

    pub(super) shard_start: u64,
    pub(super) shard_end: u64,
    pub(super) file_size: u64,
    pub(super) skip_partial: bool,
    parsing: bool,
    pub(super) last_path_id: Option<u32>,
    pub(super) path_cache: [(u64, u32, u16, u16); PATH_CACHE_SLOTS],
}

impl Engine {
    pub fn new() -> Self {
        Self {
            ingest: Vec::new(),
            carry: Vec::new(),
            carry_abs: 0,
            path_bytes: Vec::new(),
            path_off: Vec::new(),
            path_len: Vec::new(),
            path_table: HashTable::new(),
            entries: Vec::new(),
            hist_keys: Vec::new(),
            dates: Vec::new(),
            last_date: [0u8; 10],
            last_date_id: 0,
            unmatched_count: 0,
            unmatched_sample: Vec::new(),
            cron_events: Vec::new(),
            methods_mask: 0,
            norm_bytes: [Vec::new(), Vec::new(), Vec::new()],
            norm_off: [Vec::new(), Vec::new(), Vec::new()],
            norm_len: [Vec::new(), Vec::new(), Vec::new()],
            norm_table: [HashTable::new(), HashTable::new(), HashTable::new()],
            path_to_norm: [Vec::new(), Vec::new(), Vec::new()],
            mode_ready: [false; 3],
            summary_sum: 0.0,
            summary_max: 0.0,
            summary_errors: 0,
            summary_slow: 0,
            summary_sketch: RelHist::new(),
            summary_ready: false,
            cached_hourly_wire: Vec::new(),
            cached_daily_wire: Vec::new(),
            hourly_buckets: std::array::from_fn(|_| HourlyAcc::new()),
            daily_accs: Vec::new(),
            shard_start: 0,
            shard_end: 0,
            file_size: 0,
            skip_partial: false,
            parsing: false,
            last_path_id: None,
            path_cache: [(0, u32::MAX, 0, 0); PATH_CACHE_SLOTS],
        }
    }

    pub fn clear(&mut self) {
        *self = Self::new();
    }

    pub fn hit_count(&self) -> usize {
        self.entries.len()
    }

    pub fn unmatched_count(&self) -> u32 {
        self.unmatched_count
    }

    pub fn path_count(&self) -> usize {
        self.path_off.len()
    }

    pub fn methods_mask(&self) -> u8 {
        self.methods_mask
    }

    pub fn hourly_accs(&self) -> &[HourlyAcc; 24] {
        &self.hourly_buckets
    }

    pub fn daily_accs(&self) -> &[DailyAcc] {
        &self.daily_accs
    }

    pub fn dates(&self) -> &[[u8; 10]] {
        &self.dates
    }

    pub fn cron_events(&self) -> &[CronEv] {
        &self.cron_events
    }

    pub fn unmatched_sample(&self) -> &[Vec<u8>] {
        &self.unmatched_sample
    }

    /// One-time single-pass computation of summary, hourly stats, and daily stats.
    fn build_summary_and_meta(&mut self) {
        if self.summary_ready {
            return;
        }
        let mut total = SummaryTotal::new();
        let mut hourly_buckets: [HourlyAcc; 24] = std::array::from_fn(|_| HourlyAcc::new());
        let mut daily_accs: Vec<DailyAcc> = self
            .dates
            .iter()
            .map(|&date| DailyAcc::new(date))
            .collect();

        self.hist_keys.reserve(self.entries.len());
        for entry in &self.entries {
            let record = SummaryRecord::of(*entry, compact_hist_key(entry.duration));
            self.hist_keys.push(record.hist_key);
            total.record(&record);
            if let Some(hour) = hourly_buckets.get_mut(record.hour) {
                hour.record(&record);
            }
            if let Some(day) = daily_for(&mut daily_accs, record.date_id) {
                day.record(&record);
            }
        }

        self.summary_sum = total.sum;
        self.summary_max = total.max;
        self.summary_errors = total.errors;
        self.summary_slow = total.slow;
        self.summary_sketch = total.sketch;
        self.summary_ready = true;
        self.cached_hourly_wire = encode_hourly_vec(&hourly_buckets);
        self.cached_daily_wire = encode_daily_vec(&daily_accs);
        self.hourly_buckets = hourly_buckets;
        self.daily_accs = daily_accs;
    }

    /// Encode filter-independent hour-of-day request statistics.
    pub fn hourly_wire(&self) -> Vec<u8> {
        self.cached_hourly_wire.clone()
    }

    /// Encode list of unique dates seen in logs.
    pub fn dates_wire(&self) -> Vec<u8> {
        encode_dates_vec(&self.dates)
    }

    /// Encode daily summary stats and per-date hourly breakdown.
    pub fn daily_wire(&self) -> Vec<u8> {
        self.cached_daily_wire.clone()
    }

    /// Summary wire for coordinator cache (same fields as PM2P summary block).
    pub fn summary_wire(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&self.summary_sum.to_le_bytes());
        out.extend_from_slice(&self.summary_max.to_le_bytes());
        out.extend_from_slice(&self.summary_errors.to_le_bytes());
        out.extend_from_slice(&self.summary_slow.to_le_bytes());
        let wire = self.summary_sketch.to_wire();
        out.extend_from_slice(&(wire.len() as u32).to_le_bytes());
        out.extend_from_slice(&wire);
        out
    }

    /// The path arena that carries `mode`'s normalized paths.
    fn norm_arena(&self, mode: usize) -> (&[u8], &[u32], &[u16]) {
        if mode == NormalizeMode::Exact as usize {
            (&self.path_bytes, &self.path_off, &self.path_len)
        } else {
            (
                &self.norm_bytes[mode],
                &self.norm_off[mode],
                &self.norm_len[mode],
            )
        }
    }

    /// The summary to emit: the cached one, the freshly scanned one, or none.
    fn emit_summary<'a>(
        &'a self,
        need_summary: bool,
        used_cached_summary: bool,
        sketch: &'a RelHist,
    ) -> Option<&'a RelHist> {
        if !need_summary {
            return None;
        }
        if used_cached_summary {
            return Some(&self.summary_sketch);
        }
        Some(sketch)
    }

    pub fn reaggregate(
        &mut self,
        normalize_mode: u8,
        status_family: u8,
        min_ms: f32,
        date_filter: &[u8],
        need_summary: bool,
    ) -> Vec<u8> {
        self.ensure_mode(normalize_mode);
        let mode = NormalizeMode::from_u8(normalize_mode) as usize;
        let filtered =
            self.aggregate_filtered(mode, status_family, min_ms, date_filter, need_summary);
        let (norm_bytes, norm_off, norm_len) = self.norm_arena(mode);
        let summary =
            self.emit_summary(need_summary, filtered.used_cached_summary, &filtered.sketch);
        let endpoints = filtered.slots.into_endpoints();
        let wire = PartialWire {
            mode: mode as u8,
            endpoints: &endpoints,
            norm_bytes,
            norm_off,
            norm_len,
            summary,
            sum: filtered.sum,
            max: filtered.max,
            errors: filtered.errors,
            slow: filtered.slow,
            matched: filtered.matched,
            unmatched: filtered.unmatched,
        };
        wire.encode()
    }

    pub fn reaggregate_decoded(
        &mut self,
        normalize_mode: u8,
        status_family: u8,
        min_ms: f32,
        date_filter: &[u8],
        need_summary: bool,
    ) -> DecodedPartial {
        self.ensure_mode(normalize_mode);
        let mode = NormalizeMode::from_u8(normalize_mode) as usize;
        let filtered =
            self.aggregate_filtered(mode, status_family, min_ms, date_filter, need_summary);
        let (norm_bytes, norm_off, norm_len) = self.norm_arena(mode);
        let endpoints = filtered
            .slots
            .into_decoded_endpoints(norm_bytes, norm_off, norm_len);
        let summary = if !need_summary {
            None
        } else if filtered.used_cached_summary {
            Some(DecodedSummary {
                sum: filtered.sum,
                max: filtered.max,
                errors: filtered.errors,
                slow: filtered.slow,
                sketch: self.summary_sketch.clone(),
            })
        } else {
            Some(DecodedSummary {
                sum: filtered.sum,
                max: filtered.max,
                errors: filtered.errors,
                slow: filtered.slow,
                sketch: filtered.sketch,
            })
        };
        DecodedPartial {
            mode: mode as u8,
            endpoints,
            summary,
            matched: filtered.matched,
            unmatched: filtered.unmatched,
        }
    }

    pub fn cron_wire(&self) -> Vec<u8> {
        encode_cron_vec(&self.cron_events)
    }

    pub fn unmatched_sample_wire(&self) -> Vec<u8> {
        encode_unmatched_vec(&self.unmatched_sample)
    }
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}
