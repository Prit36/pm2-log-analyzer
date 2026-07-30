//! Persistent per-shard columnar store + reaggregation.

use crate::normalize::{normalize_path, NormalizeMode};
use crate::parse::{parse_line_bytes, LineKind, Method};
use crate::relhist::RelHist;
use hashbrown::hash_map::EntryRef;
use hashbrown::HashMap;
use memchr::memchr;
use rapidhash::fast::RandomState;

const LINE_EXTEND: usize = 256 * 1024;
/// Reusable ingest window. Keeps Wasm peak memory bounded.
pub const INGEST_CAP: usize = 8 * 1024 * 1024;

/// Path/norm indexes: rapidhash beats foldhash on byte keys.
type ByteMap<V> = HashMap<Vec<u8>, V, RandomState>;

fn new_byte_map<V>() -> ByteMap<V> {
    HashMap::with_hasher(RandomState::default())
}

#[repr(C, align(16))]
#[derive(Clone, Copy, Debug, Default)]
pub struct PackedEntry {
    pub path_id: u32,
    pub duration: f32,
    pub status: u16,
    pub method: u8,
    pub _pad: u8,
}

#[derive(Clone)]
struct CronEv {
    event: u8,
    name: Vec<u8>,
    ts: Option<Vec<u8>>,
    duration_ms: Option<f32>,
}

struct EndpointAcc {
    method: u8,
    path_bytes: Vec<u8>,
    sketch: RelHist,
    count: u32,
    sum: f64,
    min: f32,
    max: f32,
    error_count: u32,
}

pub struct Engine {
    ingest: Vec<u8>,
    carry: Vec<u8>,
    /// Absolute file offset of carry[0], if carry non-empty.
    carry_abs: u64,

    path_bytes: Vec<u8>,
    path_off: Vec<u32>,
    path_len: Vec<u16>,
    path_index: ByteMap<u32>,

    entries: Vec<PackedEntry>,

    unmatched_count: u32,
    unmatched_sample: Vec<Vec<u8>>,
    cron_events: Vec<CronEv>,
    methods_mask: u8,

    norm_bytes: [Vec<u8>; 3],
    norm_off: [Vec<u32>; 3],
    norm_len: [Vec<u16>; 3],
    norm_index_map: [ByteMap<u32>; 3],
    path_to_norm: [Vec<u32>; 3],
    mode_ready: [bool; 3],

    /// Filter-independent summary computed once after parse.
    summary_sum: f64,
    summary_max: f32,
    summary_errors: u32,
    summary_slow: u32,
    summary_sketch: RelHist,
    summary_ready: bool,

    shard_start: u64,
    shard_end: u64,
    file_size: u64,
    skip_partial: bool,
    parsing: bool,
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
            path_index: new_byte_map(),
            entries: Vec::new(),
            unmatched_count: 0,
            unmatched_sample: Vec::new(),
            cron_events: Vec::new(),
            methods_mask: 0,
            norm_bytes: [Vec::new(), Vec::new(), Vec::new()],
            norm_off: [Vec::new(), Vec::new(), Vec::new()],
            norm_len: [Vec::new(), Vec::new(), Vec::new()],
            norm_index_map: [new_byte_map(), new_byte_map(), new_byte_map()],
            path_to_norm: [Vec::new(), Vec::new(), Vec::new()],
            mode_ready: [false; 3],
            summary_sum: 0.0,
            summary_max: 0.0,
            summary_errors: 0,
            summary_slow: 0,
            summary_sketch: RelHist::new(),
            summary_ready: false,
            shard_start: 0,
            shard_end: 0,
            file_size: 0,
            skip_partial: false,
            parsing: false,
        }
    }

    pub fn clear(&mut self) {
        let cap = self.ingest.capacity();
        *self = Self::new();
        if cap > 0 {
            self.ingest.reserve(cap.min(INGEST_CAP));
        }
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

    /// Grow ingest to `len` and return pointer for JS to `memory.set` into.
    pub fn ingest_ptr(&mut self, len: u32) -> u32 {
        let n = (len as usize).min(INGEST_CAP);
        if self.ingest.len() < n {
            self.ingest.resize(n, 0);
        }
        self.ingest.as_mut_ptr() as u32
    }

    pub fn begin_shard(&mut self, start: u32, end: u32, file_size: u32) {
        self.reset_columns();
        self.shard_start = start as u64;
        self.shard_end = end as u64;
        self.file_size = file_size as u64;
        self.skip_partial = start > 0;
        self.parsing = true;
        self.carry.clear();
        self.carry_abs = 0;
        let span = end.saturating_sub(start) as usize;
        let estimate = (span / 140).saturating_add(1024).min(4_000_000);
        self.entries.reserve(estimate);
        self.path_off.reserve(2048);
        self.path_len.reserve(2048);
        self.path_bytes.reserve(65536);
        self.path_index.reserve(2048);
    }

    fn reset_columns(&mut self) {
        self.path_bytes.clear();
        self.path_off.clear();
        self.path_len.clear();
        self.path_index.clear();
        self.entries.clear();
        self.unmatched_count = 0;
        self.unmatched_sample.clear();
        self.cron_events.clear();
        self.methods_mask = 0;
        for m in 0..3 {
            self.norm_bytes[m].clear();
            self.norm_off[m].clear();
            self.norm_len[m].clear();
            self.norm_index_map[m].clear();
            self.path_to_norm[m].clear();
            self.mode_ready[m] = false;
        }
        self.summary_sum = 0.0;
        self.summary_max = 0.0;
        self.summary_errors = 0;
        self.summary_slow = 0;
        self.summary_sketch = RelHist::new();
        self.summary_ready = false;
    }

    /// Feed `len` bytes already written at ingest[0..len] starting at absolute `abs_off`.
    pub fn feed(&mut self, len: u32, abs_off: u32) -> u32 {
        let len = (len as usize).min(self.ingest.len());
        if self.carry.is_empty() {
            self.feed_ingest_only(len, abs_off)
        } else {
            self.feed_with_carry(len, abs_off)
        }
    }

    /// Common path: no carry — SIMD memchr newline scan over ingest window.
    fn feed_ingest_only(&mut self, len: usize, abs_off: u32) -> u32 {
        let abs_off = abs_off as u64;
        let before = self.entries.len();
        let mut ingest = std::mem::take(&mut self.ingest);
        if ingest.len() < len {
            ingest.resize(len, 0);
        }
        let chunk_end = abs_off + len as u64;
        let at_file_end = chunk_end >= self.file_size;
        let extend_limit = self.shard_end + LINE_EXTEND as u64;
        let view = &ingest[..len];

        let mut i = 0usize;
        if self.skip_partial {
            match memchr(b'\n', view) {
                Some(nl) => {
                    i = nl + 1;
                    self.skip_partial = false;
                }
                None => {
                    if !at_file_end {
                        self.carry.extend_from_slice(view);
                        self.carry_abs = abs_off;
                    }
                    self.ingest = ingest;
                    return 0;
                }
            }
        }

        let mut batch = [0usize; 32];
        while i < len {
            let abs_line_start = abs_off + i as u64;
            if abs_line_start >= self.shard_end {
                break;
            }
            let rest = &view[i..];
            let mut count = 0;
            for nl_rel in memchr::memchr_iter(b'\n', rest) {
                batch[count] = i + nl_rel;
                count += 1;
                if count == 32 {
                    break;
                }
            }

            if count > 0 {
                let mut line_start = i;
                for k in 0..count {
                    let line_end = batch[k];
                    self.accept_line(view, line_start, line_end);
                    line_start = line_end + 1;
                }
                i = line_start;
            } else {
                let line_start = i;
                if !at_file_end && abs_line_start < extend_limit {
                    self.carry.clear();
                    self.carry.extend_from_slice(&view[line_start..]);
                    self.carry_abs = abs_line_start;
                } else if at_file_end {
                    self.accept_line(view, line_start, len);
                }
                break;
            }
        }

        self.ingest = ingest;
        (self.entries.len() - before) as u32
    }

    /// Rare path: leftover partial line from previous chunk.
    fn feed_with_carry(&mut self, len: usize, abs_off: u32) -> u32 {
        let abs_off = abs_off as u64;
        let before = self.entries.len();

        let mut ingest = std::mem::take(&mut self.ingest);
        if ingest.len() < len {
            ingest.resize(len, 0);
        }
        let mut carry = std::mem::take(&mut self.carry);
        let carry_abs = self.carry_abs;

        let chunk_end = abs_off + len as u64;
        let at_file_end = chunk_end >= self.file_size;
        let extend_limit = self.shard_end + LINE_EXTEND as u64;
        let ingest_view = &ingest[..len];

        let total = carry.len() + len;
        let buf_abs = carry_abs;
        let byte_at = |idx: usize| -> u8 {
            if idx < carry.len() {
                carry[idx]
            } else {
                ingest_view[idx - carry.len()]
            }
        };

        let mut i = 0usize;
        if self.skip_partial {
            while i < total && byte_at(i) != b'\n' {
                i += 1;
            }
            if i >= total {
                if !at_file_end {
                    carry.extend_from_slice(ingest_view);
                    self.carry = carry;
                    self.carry_abs = carry_abs;
                }
                self.ingest = ingest;
                return 0;
            }
            i += 1;
            self.skip_partial = false;
        }

        while i < total {
            let line_start = i;
            let abs_line_start = buf_abs + line_start as u64;
            if abs_line_start >= self.shard_end {
                break;
            }
            while i < total && byte_at(i) != b'\n' {
                i += 1;
            }
            let line_end = i;
            let has_nl = i < total && byte_at(i) == b'\n';
            if has_nl {
                i += 1;
            }

            if !has_nl && !at_file_end {
                if abs_line_start < extend_limit {
                    self.carry.clear();
                    self.carry_abs = abs_line_start;
                    if line_start < carry.len() {
                        self.carry.extend_from_slice(&carry[line_start..]);
                        self.carry.extend_from_slice(ingest_view);
                    } else {
                        let s = line_start - carry.len();
                        self.carry.extend_from_slice(&ingest_view[s..]);
                    }
                }
                break;
            }

            if line_end <= carry.len() {
                self.accept_line(&carry, line_start, line_end);
            } else if line_start >= carry.len() {
                let s = line_start - carry.len();
                let e = line_end - carry.len();
                self.accept_line(ingest_view, s, e);
            } else {
                let mut line = Vec::with_capacity(line_end - line_start);
                line.extend_from_slice(&carry[line_start..]);
                line.extend_from_slice(&ingest_view[..line_end - carry.len()]);
                self.accept_line(&line, 0, line.len());
            }

            if !has_nl {
                break;
            }
        }

        self.ingest = ingest;
        (self.entries.len() - before) as u32
    }

    pub fn end_shard(&mut self) {
        if !self.carry.is_empty() {
            let abs_line_start = self.carry_abs;
            if abs_line_start < self.shard_end {
                let buf = std::mem::take(&mut self.carry);
                self.accept_line(&buf, 0, buf.len());
            }
            self.carry.clear();
        }
        self.parsing = false;
        self.ingest.clear();
        self.build_summary();
    }

    /// One-time unfiltered summary (filter-independent).
    fn build_summary(&mut self) {
        if self.summary_ready {
            return;
        }
        let mut sum = 0.0f64;
        let mut max = 0.0f32;
        let mut errors = 0u32;
        let mut slow = 0u32;
        let mut sketch = RelHist::new();
        for entry in &self.entries {
            let d = entry.duration;
            let st = entry.status;
            sum += d as f64;
            sketch.accept(d);
            if d > max {
                max = d;
            }
            if st >= 400 {
                errors += 1;
            }
            if d >= 3000.0 {
                slow += 1;
            }
        }
        self.summary_sum = sum;
        self.summary_max = max;
        self.summary_errors = errors;
        self.summary_slow = slow;
        self.summary_sketch = sketch;
        self.summary_ready = true;
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

    fn accept_line(&mut self, buf: &[u8], line_start: usize, line_end: usize) {
        match parse_line_bytes(buf, line_start, line_end) {
            LineKind::Empty => {}
            LineKind::Cron {
                event,
                name,
                ts,
                duration_ms,
            } => {
                self.cron_events.push(CronEv {
                    event,
                    name,
                    ts,
                    duration_ms,
                });
            }
            LineKind::Http {
                method,
                path_start,
                path_end,
                status,
                duration_ms,
            } => {
                let path = &buf[path_start..path_end];
                let pid = self.intern_path(path);
                self.entries.push(PackedEntry {
                    path_id: pid,
                    duration: duration_ms,
                    status,
                    method: method as u8,
                    _pad: 0,
                });
                self.methods_mask |= 1u8 << (method as u8);
            }
            LineKind::Unmatched => {
                self.unmatched_count += 1;
                if self.unmatched_sample.len() < 40 {
                    let end = (line_start + 500).min(line_end);
                    self.unmatched_sample.push(buf[line_start..end].to_vec());
                }
            }
        }
    }

    /// Test / small-buffer helper: copies through the ingest window.
    pub fn parse_shard(
        &mut self,
        buf: &[u8],
        shard_start: usize,
        shard_end: usize,
        file_size: usize,
    ) -> usize {
        self.begin_shard(shard_start as u32, shard_end as u32, file_size as u32);
        let read_end = (shard_end + LINE_EXTEND).min(file_size);
        let mut off = shard_start;
        while off < read_end {
            let take = (read_end - off)
                .min(INGEST_CAP)
                .min(buf.len().saturating_sub(off - shard_start));
            if take == 0 {
                break;
            }
            let src_off = off - shard_start;
            let _ = self.ingest_ptr(take as u32);
            self.ingest[..take].copy_from_slice(&buf[src_off..src_off + take]);
            self.feed(take as u32, off as u32);
            off += take;
        }
        self.end_shard();
        self.entries.len()
    }

    fn intern_path(&mut self, path: &[u8]) -> u32 {
        let next_id = self.path_off.len() as u32;
        match self.path_index.entry_ref(path) {
            EntryRef::Occupied(e) => return *e.get(),
            EntryRef::Vacant(e) => {
                e.insert(next_id);
            }
        }
        let off = self.path_bytes.len() as u32;
        self.path_bytes.extend_from_slice(path);
        self.path_off.push(off);
        self.path_len.push(path.len() as u16);
        self.mode_ready = [false; 3];
        next_id
    }

    fn path_slice(&self, id: usize) -> &[u8] {
        let off = self.path_off[id] as usize;
        let len = self.path_len[id] as usize;
        &self.path_bytes[off..off + len]
    }

    pub fn path_bytes_of(&self, path_id: usize) -> Option<Vec<u8>> {
        if path_id >= self.path_off.len() {
            return None;
        }
        Some(self.path_slice(path_id).to_vec())
    }

    fn intern_norm(&mut self, mode: usize, path: &[u8]) -> u32 {
        let next_id = self.norm_off[mode].len() as u32;
        match self.norm_index_map[mode].entry_ref(path) {
            EntryRef::Occupied(e) => return *e.get(),
            EntryRef::Vacant(e) => {
                e.insert(next_id);
            }
        }
        let off = self.norm_bytes[mode].len() as u32;
        self.norm_bytes[mode].extend_from_slice(path);
        self.norm_off[mode].push(off);
        self.norm_len[mode].push(path.len() as u16);
        next_id
    }

    pub fn norm_path_bytes(&self, mode: u8, norm_id: usize) -> Option<Vec<u8>> {
        let m = mode as usize;
        if m > 2 || norm_id >= self.norm_off[m].len() {
            return None;
        }
        let off = self.norm_off[m][norm_id] as usize;
        let len = self.norm_len[m][norm_id] as usize;
        Some(self.norm_bytes[m][off..off + len].to_vec())
    }

    pub fn ensure_mode(&mut self, mode: u8) {
        let m = NormalizeMode::from_u8(mode) as usize;
        if self.mode_ready[m] && self.path_to_norm[m].len() == self.path_off.len() {
            return;
        }
        self.norm_bytes[m].clear();
        self.norm_off[m].clear();
        self.norm_len[m].clear();
        self.norm_index_map[m].clear();
        self.path_to_norm[m].resize(self.path_off.len(), 0);
        let mode_enum = NormalizeMode::from_u8(mode);
        for pid in 0..self.path_off.len() {
            let off = self.path_off[pid] as usize;
            let len = self.path_len[pid] as usize;
            // Normalize may borrow path_bytes; intern without into_owned when unchanged.
            let owned: Option<Vec<u8>>;
            let borrow_off: usize;
            let borrow_len: usize;
            {
                let raw = &self.path_bytes[off..off + len];
                match normalize_path(raw, mode_enum) {
                    std::borrow::Cow::Owned(v) => {
                        owned = Some(v);
                        borrow_off = 0;
                        borrow_len = 0;
                    }
                    std::borrow::Cow::Borrowed(b) => {
                        borrow_off = b.as_ptr() as usize - self.path_bytes.as_ptr() as usize;
                        borrow_len = b.len();
                        owned = None;
                    }
                }
            }
            let nid = if let Some(ref v) = owned {
                self.intern_norm(m, v)
            } else {
                self.intern_norm_from_path_bytes(m, borrow_off, borrow_len)
            };
            self.path_to_norm[m][pid] = nid;
        }
        self.mode_ready[m] = true;
    }

    /// Intern a norm key that lives in `path_bytes` (no intermediate Vec when already present).
    fn intern_norm_from_path_bytes(&mut self, mode: usize, off: usize, len: usize) -> u32 {
        if let Some(&id) = self.norm_index_map[mode].get(&self.path_bytes[off..off + len]) {
            return id;
        }
        let key = self.path_bytes[off..off + len].to_vec();
        self.intern_norm(mode, &key)
    }

    pub fn finalize_paths(&mut self) {
        for m in 0u8..3 {
            self.ensure_mode(m);
        }
    }

    pub fn reaggregate(
        &mut self,
        normalize_mode: u8,
        status_family: u8,
        min_ms: f32,
        need_summary: bool,
    ) -> Vec<u8> {
        self.ensure_mode(normalize_mode);
        let mode = NormalizeMode::from_u8(normalize_mode) as usize;
        let status_want: i32 = match status_family {
            2 => 2,
            3 => 3,
            4 => 4,
            5 => 5,
            _ => -1,
        };

        // Dense slots for low-cardinality modes: (norm_id << 3) | method
        let use_dense = mode != 0;
        let n_norm = self.norm_off[mode].len();
        let dense_len = if use_dense {
            n_norm.saturating_mul(8).saturating_add(8)
        } else {
            0
        };

        let mut dense: Vec<Option<Box<EndpointAcc>>> = if use_dense {
            let mut v = Vec::with_capacity(dense_len);
            v.resize_with(dense_len, || None);
            v
        } else {
            Vec::new()
        };
        let mut by_key: HashMap<u64, EndpointAcc> = if use_dense {
            HashMap::new()
        } else {
            HashMap::with_capacity((self.path_off.len() / 4).max(64))
        };

        let mut sum_max = 0.0f32;
        let mut sum_sum = 0.0f64;
        let mut sum_errors = 0u32;
        let mut sum_slow = 0u32;
        let summary_ref: Option<&RelHist> = if need_summary && self.summary_ready {
            sum_sum = self.summary_sum;
            sum_max = self.summary_max;
            sum_errors = self.summary_errors;
            sum_slow = self.summary_slow;
            Some(&self.summary_sketch)
        } else {
            None
        };

        let n = self.entries.len();
        let path_to_norm = &self.path_to_norm[mode];
        for i in 0..n {
            let e = self.entries[i];
            let duration_ms = e.duration;
            let status = e.status;

            if duration_ms < min_ms {
                continue;
            }
            let method_code = e.method;
            if status_want != -1 && ((status / 100) as i32) != status_want {
                continue;
            }

            let path_id = e.path_id as usize;
            let norm_id = path_to_norm[path_id];
            let key = ((norm_id as u64) << 3) | (method_code as u64);

            if use_dense {
                let idx = key as usize;
                if idx >= dense.len() {
                    continue;
                }
                let slot = &mut dense[idx];
                if slot.is_none() {
                    *slot = Some(Box::new(EndpointAcc {
                        method: method_code,
                        path_bytes: Vec::new(),
                        sketch: RelHist::new(),
                        count: 0,
                        sum: 0.0,
                        min: f32::INFINITY,
                        max: f32::NEG_INFINITY,
                        error_count: 0,
                    }));
                }
                let entry = slot.as_mut().unwrap();
                entry.sketch.accept(duration_ms);
                entry.count += 1;
                entry.sum += duration_ms as f64;
                if duration_ms < entry.min {
                    entry.min = duration_ms;
                }
                if duration_ms > entry.max {
                    entry.max = duration_ms;
                }
                if status >= 400 {
                    entry.error_count += 1;
                }
            } else {
                let entry = by_key.entry(key).or_insert_with(|| EndpointAcc {
                    method: method_code,
                    path_bytes: Vec::new(),
                    sketch: RelHist::new(),
                    count: 0,
                    sum: 0.0,
                    min: f32::INFINITY,
                    max: f32::NEG_INFINITY,
                    error_count: 0,
                });
                entry.sketch.accept(duration_ms);
                entry.count += 1;
                entry.sum += duration_ms as f64;
                if duration_ms < entry.min {
                    entry.min = duration_ms;
                }
                if duration_ms > entry.max {
                    entry.max = duration_ms;
                }
                if status >= 400 {
                    entry.error_count += 1;
                }
            }
        }

        // Attach path bytes and collect for encode
        let mut endpoints: Vec<(u32, EndpointAcc)> = Vec::new();
        if use_dense {
            for (idx, slot) in dense.into_iter().enumerate() {
                if let Some(mut e) = slot {
                    let norm_id = (idx >> 3) as u32;
                    let off = self.norm_off[mode][norm_id as usize] as usize;
                    let len = self.norm_len[mode][norm_id as usize] as usize;
                    e.path_bytes = self.norm_bytes[mode][off..off + len].to_vec();
                    endpoints.push((norm_id, *e));
                }
            }
        } else {
            for (key, mut e) in by_key {
                let norm_id = (key >> 3) as u32;
                let off = self.norm_off[mode][norm_id as usize] as usize;
                let len = self.norm_len[mode][norm_id as usize] as usize;
                e.path_bytes = self.norm_bytes[mode][off..off + len].to_vec();
                endpoints.push((norm_id, e));
            }
        }

        encode_partial_vec(
            mode as u8,
            &endpoints,
            summary_ref,
            sum_sum,
            sum_max,
            sum_errors,
            sum_slow,
            self.entries.len() as u32,
            self.unmatched_count,
        )
    }

    pub fn cron_wire(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&(self.cron_events.len() as u32).to_le_bytes());
        for ev in &self.cron_events {
            out.push(ev.event);
            write_bytes(&mut out, &ev.name);
            match &ev.ts {
                Some(ts) => {
                    out.push(1);
                    write_bytes(&mut out, ts);
                }
                None => out.push(0),
            }
            match ev.duration_ms {
                Some(d) => {
                    out.push(1);
                    out.extend_from_slice(&d.to_le_bytes());
                }
                None => out.push(0),
            }
        }
        out
    }

    pub fn unmatched_sample_wire(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&(self.unmatched_sample.len() as u32).to_le_bytes());
        for s in &self.unmatched_sample {
            write_bytes(&mut out, s);
        }
        out
    }
}

fn write_bytes(out: &mut Vec<u8>, b: &[u8]) {
    out.extend_from_slice(&(b.len() as u32).to_le_bytes());
    out.extend_from_slice(b);
}

fn encode_partial_vec(
    mode: u8,
    endpoints: &[(u32, EndpointAcc)],
    summary: Option<&RelHist>,
    sum_sum: f64,
    sum_max: f32,
    sum_errors: u32,
    sum_slow: u32,
    matched: u32,
    unmatched: u32,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(64 + endpoints.len() * 64);
    out.extend_from_slice(&0x504D3250u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.push(mode);
    let flags = if summary.is_some() { 1u8 } else { 0u8 };
    out.push(flags);
    out.extend_from_slice(&(endpoints.len() as u32).to_le_bytes());
    out.extend_from_slice(&matched.to_le_bytes());
    out.extend_from_slice(&unmatched.to_le_bytes());

    if let Some(sk) = summary {
        out.extend_from_slice(&sum_sum.to_le_bytes());
        out.extend_from_slice(&sum_max.to_le_bytes());
        out.extend_from_slice(&sum_errors.to_le_bytes());
        out.extend_from_slice(&sum_slow.to_le_bytes());
        let wire = sk.to_wire();
        out.extend_from_slice(&(wire.len() as u32).to_le_bytes());
        out.extend_from_slice(&wire);
    }

    for (_nid, e) in endpoints {
        out.push(e.method);
        out.extend_from_slice(&[0, 0, 0]);
        out.extend_from_slice(&e.count.to_le_bytes());
        out.extend_from_slice(&e.sum.to_le_bytes());
        let min = if e.count > 0 { e.min } else { 0.0 };
        let max = if e.count > 0 { e.max } else { 0.0 };
        out.extend_from_slice(&min.to_le_bytes());
        out.extend_from_slice(&max.to_le_bytes());
        out.extend_from_slice(&e.error_count.to_le_bytes());
        write_bytes(&mut out, &e.path_bytes);
        let wire = e.sketch.to_wire();
        out.extend_from_slice(&(wire.len() as u32).to_le_bytes());
        out.extend_from_slice(&wire);
    }
    out
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

#[allow(dead_code)]
pub fn method_name(code: u8) -> &'static str {
    Method::from_code(code).map(|m| m.as_str()).unwrap_or("GET")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunked_matches_oneshot() {
        let sample = b"2026-07-24T00:00:10: GET /api/health 200 12.5 ms - 42\n\
socket connected\n\
2026-07-24T00:00:11: POST /api/x 201 3.1 ms - -\n";
        let mut a = Engine::new();
        a.parse_shard(sample, 0, sample.len(), sample.len());

        let mut b = Engine::new();
        b.begin_shard(0, sample.len() as u32, sample.len() as u32);
        let mut off = 0usize;
        while off < sample.len() {
            let take = (sample.len() - off).min(17);
            let _ = b.ingest_ptr(take as u32);
            b.ingest[..take].copy_from_slice(&sample[off..off + take]);
            b.feed(take as u32, off as u32);
            off += take;
        }
        b.end_shard();
        assert_eq!(a.hit_count(), b.hit_count());
        assert_eq!(a.unmatched_count(), b.unmatched_count());
        assert_eq!(a.hit_count(), 2);
        assert_eq!(a.unmatched_count(), 1);
    }

    #[test]
    fn mid_line_chunk_boundary() {
        let sample = b"2026-07-24T00:00:10: GET /api/health 200 12.5 ms - 42\n";
        let split = 20; // inside timestamp
        let mut e = Engine::new();
        e.begin_shard(0, sample.len() as u32, sample.len() as u32);
        let _ = e.ingest_ptr(split as u32);
        e.ingest[..split].copy_from_slice(&sample[..split]);
        e.feed(split as u32, 0);
        let rest = sample.len() - split;
        let _ = e.ingest_ptr(rest as u32);
        e.ingest[..rest].copy_from_slice(&sample[split..]);
        e.feed(rest as u32, split as u32);
        e.end_shard();
        assert_eq!(e.hit_count(), 1);
        assert!(e.summary_ready);
        assert!(e.summary_sum > 0.0);
    }
}
