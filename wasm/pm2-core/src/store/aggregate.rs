//! Filtered endpoint aggregation shared by the wire and decoded reaggregate paths.

use super::decoded::DecodedEndpoint;
use super::{hash_bytes, DailyAcc, Engine, PackedEntry, INVALID_RELHIST_KEY};
use crate::normalize::NormalizeMode;
use crate::relhist::{relhist_key, RelHist};
use hashbrown::HashMap;

/// Per-endpoint accumulators for one filtered aggregation pass.
pub(super) struct EndpointAcc {
    pub(super) method: u8,
    pub(super) sketch: EndpointHist,
    pub(super) count: u32,
    pub(super) sum: f64,
    pub(super) min: f32,
    pub(super) max: f32,
    pub(super) error_count: u32,
}

impl EndpointAcc {
    fn new(method: u8) -> Self {
        Self {
            method,
            sketch: EndpointHist::Small {
                bins: [(0, 0); 4],
                len: 0,
            },
            count: 0,
            sum: 0.0,
            min: f32::INFINITY,
            max: f32::NEG_INFINITY,
            error_count: 0,
        }
    }

    /// Fold one hit that passed every filter into this endpoint.
    #[inline(always)]
    fn record(&mut self, duration: f32, status: u16, hist_key: i16) {
        if hist_key != INVALID_RELHIST_KEY {
            self.sketch.accept_key(hist_key);
        }
        self.count += 1;
        self.sum += duration as f64;
        if duration < self.min {
            self.min = duration;
        }
        if duration > self.max {
            self.max = duration;
        }
        if status >= 400 {
            self.error_count += 1;
        }
    }
}

/// Most endpoints have only a few duration buckets. Allocate the dense
/// histogram only once a fifth distinct bucket is needed.
pub(super) enum EndpointHist {
    Small { bins: [(i16, u32); 4], len: usize },
    Full(Box<RelHist>),
}

impl EndpointHist {
    #[inline]
    fn accept_key(&mut self, key: i16) {
        match self {
            Self::Full(hist) => hist.accept_key(key as i32),
            Self::Small { bins, len } => {
                for (bucket, count) in &mut bins[..*len] {
                    if *bucket == key {
                        *count += 1;
                        return;
                    }
                }
                if *len < bins.len() {
                    bins[*len] = (key, 1);
                    *len += 1;
                    return;
                }
                let mut hist = Box::new(RelHist::new());
                for &(bucket, count) in bins.iter() {
                    hist.accept_key_count(bucket as i32, count);
                }
                hist.accept_key(key as i32);
                *self = Self::Full(hist);
            }
        }
    }

    /// Append a length-prefixed wire without allocating for inline buckets.
    pub(super) fn write_wire(&self, out: &mut Vec<u8>) {
        match self {
            Self::Full(hist) => super::wire::write_bytes(out, &hist.to_wire()),
            Self::Small { bins, len } => {
                let mut bins = *bins;
                bins[..*len].sort_unstable_by_key(|&(key, _)| key);
                let count: u32 = bins[..*len].iter().map(|&(_, count)| count).sum();
                out.extend_from_slice(&(8 + *len as u32 * 8).to_le_bytes());
                out.extend_from_slice(&count.to_le_bytes());
                out.extend_from_slice(&(*len as u32).to_le_bytes());
                for &(key, count) in &bins[..*len] {
                    out.extend_from_slice(&(key as i32).to_le_bytes());
                    out.extend_from_slice(&count.to_le_bytes());
                }
            }
        }
    }

    fn into_hist(self) -> Box<RelHist> {
        match self {
            Self::Full(hist) => hist,
            Self::Small { bins, len } => {
                let mut hist = Box::new(RelHist::new());
                for &(key, count) in &bins[..len] {
                    hist.accept_key_count(key as i32, count);
                }
                hist
            }
        }
    }
}

/// Endpoint slots: dense by `(norm_id, method)` when paths collapse, keyed otherwise.
pub(super) enum Slots {
    Dense(Vec<Option<Box<EndpointAcc>>>),
    Keyed(HashMap<u64, EndpointAcc>),
}

impl Slots {
    fn new(mode: usize, norm_count: usize, path_count: usize) -> Self {
        if mode == NormalizeMode::Exact as usize {
            Slots::Keyed(HashMap::with_capacity((path_count / 4).max(64)))
        } else {
            let dense_len = norm_count.saturating_mul(8).saturating_add(8);
            let mut dense = Vec::with_capacity(dense_len);
            dense.resize_with(dense_len, || None);
            Slots::Dense(dense)
        }
    }

    /// Fold one filtered hit into its endpoint slot.
    #[inline(always)]
    fn record(&mut self, key: u64, method: u8, duration: f32, status: u16, hist_key: i16) {
        match self {
            Slots::Dense(dense) => {
                let Some(slot) = dense.get_mut(key as usize) else {
                    return;
                };
                slot.get_or_insert_with(|| Box::new(EndpointAcc::new(method)))
                    .record(duration, status, hist_key);
            }
            Slots::Keyed(by_key) => by_key
                .entry(key)
                .or_insert_with(|| EndpointAcc::new(method))
                .record(duration, status, hist_key),
        }
    }

    /// Visit accumulators in slot order without moving them into another vector.
    pub(super) fn for_each(&self, mut visit: impl FnMut(u32, &EndpointAcc)) {
        match self {
            Slots::Dense(dense) => {
                for (index, slot) in dense.iter().enumerate() {
                    if let Some(acc) = slot {
                        visit((index >> 3) as u32, acc);
                    }
                }
            }
            Slots::Keyed(by_key) => {
                for (&key, acc) in by_key {
                    visit((key >> 3) as u32, acc);
                }
            }
        }
    }

    /// The decoded path: build each endpoint where its accumulator lives, so the
    /// histogram is moved once instead of through an intermediate vector.
    pub(super) fn into_decoded_endpoints(
        self,
        norm_bytes: &[u8],
        norm_off: &[u32],
        norm_len: &[u16],
    ) -> Vec<DecodedEndpoint> {
        match self {
            Slots::Dense(dense) => dense
                .into_iter()
                .enumerate()
                .filter_map(|(index, slot)| {
                    slot.map(|acc| decoded_endpoint((index >> 3) as u32, *acc, norm_bytes, norm_off, norm_len))
                })
                .collect(),
            Slots::Keyed(by_key) => by_key
                .into_iter()
                .map(|(key, acc)| {
                    decoded_endpoint((key >> 3) as u32, acc, norm_bytes, norm_off, norm_len)
                })
                .collect(),
        }
    }
}

/// One entry's filter-independent fields, shared by every summary accumulator.
#[derive(Clone, Copy)]
pub(super) struct SummaryRecord {
    pub(super) duration: f32,
    pub(super) hour: usize,
    pub(super) date_id: u16,
    pub(super) hist_key: i16,
    pub(super) is_error: bool,
    pub(super) is_slow: bool,
}

impl SummaryRecord {
    #[inline(always)]
    pub(super) fn of(entry: PackedEntry, hist_key: i16) -> Self {
        let duration = entry.duration;
        let status = entry.status();
        SummaryRecord {
            duration,
            hour: entry.hour() as usize,
            date_id: entry.date_id(),
            hist_key,
            is_error: status >= 400,
            is_slow: duration >= 3000.0,
        }
    }
}

/// The filter-independent summary being accumulated during the entry scan.
struct SummaryAcc {
    sum: f64,
    max: f32,
    errors: u32,
    slow: u32,
    sketch: RelHist,
    matched: u32,
    accumulate: bool,
    used_cached: bool,
}

impl SummaryAcc {
    fn new(engine: &Engine, used_cached: bool, accumulate: bool) -> Self {
        if used_cached {
            return Self {
                sum: engine.summary_sum,
                max: engine.summary_max,
                errors: engine.summary_errors,
                slow: engine.summary_slow,
                sketch: RelHist::new(),
                matched: 0,
                accumulate: false,
                used_cached: true,
            };
        }
        Self {
            sum: 0.0,
            max: 0.0,
            errors: 0,
            slow: 0,
            sketch: RelHist::new(),
            matched: 0,
            accumulate,
            used_cached: false,
        }
    }

    #[inline(always)]
    fn record(&mut self, record: &SummaryRecord) {
        if !self.accumulate {
            return;
        }
        self.sum += record.duration as f64;
        if record.duration > self.max {
            self.max = record.duration;
        }
        if record.is_error {
            self.errors += 1;
        }
        if record.is_slow {
            self.slow += 1;
        }
        if record.hist_key != INVALID_RELHIST_KEY {
            self.sketch.accept_key(record.hist_key as i32);
        }
    }
}

/// One filtered aggregation pass, ready to encode or decode.
pub(super) struct FilteredEndpoints {
    pub(super) slots: Slots,
    pub(super) matched: u32,
    pub(super) unmatched: u32,
    pub(super) sum: f64,
    pub(super) max: f32,
    pub(super) errors: u32,
    pub(super) slow: u32,
    pub(super) sketch: RelHist,
    pub(super) used_cached_summary: bool,
}

/// Inclusive status bounds for a status family; `(0, 0)` means "no status filter".
fn status_bounds(status_family: u8) -> (u16, u16) {
    match status_family {
        2 => (200, 299),
        3 => (300, 399),
        4 => (400, 499),
        5 => (500, 599),
        _ => (0, 0),
    }
}

impl Engine {
    /// Run the filtered scan shared by `reaggregate` and `reaggregate_decoded`.
    pub(super) fn aggregate_filtered(
        &self,
        mode: usize,
        status_family: u8,
        min_ms: f32,
        date_filter: &[u8],
        need_summary: bool,
    ) -> FilteredEndpoints {
        let (status_min, status_max) = status_bounds(status_family);
        let filter_status = status_min != 0;
        let target_date_id = self.target_date_id(date_filter);
        let mut slots = Slots::new(mode, self.norm_off[mode].len(), self.path_off.len());
        let use_cached_summary = target_date_id == 0 && need_summary && self.summary_ready;
        let mut summary = SummaryAcc::new(self, use_cached_summary, need_summary);

        for index in 0..self.entries.len() {
            let entry = self.entries[index];
            if target_date_id != 0 && entry.date_id() != target_date_id {
                continue;
            }
            summary.matched += 1;
            let duration = entry.duration;
            let status = entry.status();
            let hist_key = self.hist_keys[index];
            summary.record(&SummaryRecord::of(entry, hist_key));
            if filter_status && (status < status_min || status > status_max) {
                continue;
            }
            if min_ms > 0.0 && duration < min_ms {
                continue;
            }
            slots.record(
                self.endpoint_key(mode, entry),
                entry.method(),
                duration,
                status,
                hist_key,
            );
        }

        FilteredEndpoints {
            slots,
            matched: summary.matched,
            unmatched: if target_date_id == 0 {
                self.unmatched_count
            } else {
                0
            },
            sum: summary.sum,
            max: summary.max,
            errors: summary.errors,
            slow: summary.slow,
            sketch: summary.sketch,
            used_cached_summary: summary.used_cached,
        }
    }

    /// The `(mode, method)` filter key of one entry.
    #[inline(always)]
    fn endpoint_key(&self, mode: usize, entry: PackedEntry) -> u64 {
        let norm_id = if mode == NormalizeMode::Exact as usize {
            entry.path_id
        } else {
            self.path_to_norm[mode][entry.path_id as usize]
        };
        ((norm_id as u64) << 3) | entry.method() as u64
    }

    /// `0` for "all dates", else the 1-based date-table id (or `u16::MAX` when absent).
    fn target_date_id(&self, date_filter: &[u8]) -> u16 {
        if date_filter.is_empty() {
            return 0;
        }
        self.dates
            .iter()
            .position(|date| date == date_filter)
            .map(|position| (position + 1) as u16)
            .unwrap_or(u16::MAX)
    }
}

/// One decoded endpoint with its normalized path bytes and hash.
fn decoded_endpoint(
    norm_id: u32,
    acc: EndpointAcc,
    norm_bytes: &[u8],
    norm_off: &[u32],
    norm_len: &[u16],
) -> DecodedEndpoint {
    let offset = norm_off[norm_id as usize] as usize;
    let length = norm_len[norm_id as usize] as usize;
    let path = norm_bytes[offset..offset + length].to_vec();
    let hash = hash_bytes(&path);
    DecodedEndpoint {
        method: acc.method,
        hash,
        path,
        count: acc.count,
        sum: acc.sum,
        min: if acc.count > 0 { acc.min } else { 0.0 },
        max: if acc.count > 0 { acc.max } else { 0.0 },
        error_count: acc.error_count,
        sketch: acc.sketch.into_hist(),
    }
}

/// Filter-independent totals accumulated over every entry.
pub(super) struct SummaryTotal {
    pub(super) sum: f64,
    pub(super) max: f32,
    pub(super) errors: u32,
    pub(super) slow: u32,
    pub(super) sketch: RelHist,
}

impl SummaryTotal {
    pub(super) fn new() -> Self {
        Self {
            sum: 0.0,
            max: 0.0,
            errors: 0,
            slow: 0,
            sketch: RelHist::new(),
        }
    }

    pub(super) fn record(&mut self, record: &SummaryRecord) {
        self.sum += record.duration as f64;
        if record.duration > self.max {
            self.max = record.duration;
        }
        if record.is_error {
            self.errors += 1;
        }
        if record.is_slow {
            self.slow += 1;
        }
        if record.hist_key != INVALID_RELHIST_KEY {
            self.sketch.accept_key(record.hist_key as i32);
        }
    }
}

/// The 1-based date accumulator for `date_id`; `0` means "no date".
pub(super) fn daily_for(daily_accs: &mut [DailyAcc], date_id: u16) -> Option<&mut DailyAcc> {
    if date_id == 0 {
        return None;
    }
    daily_accs.get_mut((date_id - 1) as usize)
}

/// Compact an entry's duration bucket key onto `i16`, keeping `i16::MIN` invalid.
#[inline]
pub(super) fn compact_hist_key(duration: f32) -> i16 {
    relhist_key(duration)
        .map(|key| key.clamp((i16::MIN + 1) as i32, i16::MAX as i32) as i16)
        .unwrap_or(INVALID_RELHIST_KEY)
}
