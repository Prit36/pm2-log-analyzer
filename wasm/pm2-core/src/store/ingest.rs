//! Shard ingest: byte windows, carry handling, and per-line acceptance.

use super::{Engine, LINE_EXTEND, UNMATCHED_SAMPLE_LIMIT, UNMATCHED_SAMPLE_LEN, INGEST_CAP};
use crate::parse::{parse_line_bytes, LineKind, Method};
use memchr::memchr;
use std::borrow::Cow;

impl Engine {
    /// Grow ingest to `len` and return pointer for JS to `memory.set` into.
    pub fn ingest_ptr(&mut self, len: u32) -> u32 {
        let len = (len as usize).min(INGEST_CAP);
        if self.ingest.len() < len {
            self.ingest.resize(len, 0);
        }
        self.ingest.as_mut_ptr() as u32
    }

    pub fn begin_shard(&mut self, start: u64, end: u64, file_size: u64) {
        self.reset_columns();
        self.shard_start = start;
        self.shard_end = end;
        self.file_size = file_size;
        self.skip_partial = start > 0;
        self.parsing = true;
        self.carry.clear();
        self.carry_abs = 0;
        let span = end.saturating_sub(start);
        // The stress corpus stores about one hit per 276 input bytes. Keep a
        // small safety margin without reserving roughly twice the live entries.
        let estimate = span
            .saturating_div(256)
            .saturating_add(65536)
            .min(usize::MAX as u64) as usize;
        self.entries.reserve(estimate);
        self.path_off.reserve(8192);
        self.path_len.reserve(8192);
        self.path_bytes.reserve(262144);
        self.path_table.reserve(8192, |entry| entry.hash);
    }

    fn reset_columns(&mut self) {
        self.path_bytes.clear();
        self.path_off.clear();
        self.path_len.clear();
        self.path_table.clear();
        self.path_cache = [(0, u32::MAX, 0, 0); super::PATH_CACHE_SLOTS];
        self.entries.clear();
        self.hist_keys.clear();
        self.dates.clear();
        self.last_date = [0u8; 10];
        self.last_date_id = 0;
        self.unmatched_count = 0;
        self.unmatched_sample.clear();
        self.cron_events.clear();
        self.methods_mask = 0;
        for mode_index in 0..3 {
            self.norm_bytes[mode_index].clear();
            self.norm_off[mode_index].clear();
            self.norm_len[mode_index].clear();
            self.norm_table[mode_index].clear();
            self.path_to_norm[mode_index].clear();
            self.mode_ready[mode_index] = false;
        }
        self.summary_sum = 0.0;
        self.summary_max = 0.0;
        self.summary_errors = 0;
        self.summary_slow = 0;
        self.summary_sketch = crate::relhist::RelHist::new();
        self.summary_ready = false;
        self.cached_hourly_wire.clear();
        self.cached_daily_wire.clear();
        self.hourly_buckets = std::array::from_fn(|_| super::HourlyAcc::new());
        self.daily_accs.clear();
        self.last_path_id = None;
    }

    /// Feed `len` bytes already written at ingest[0..len] starting at absolute `abs_off`.
    pub fn feed(&mut self, len: u32, abs_off: u64) -> u32 {
        let len = (len as usize).min(self.ingest.len());
        let ingest = std::mem::take(&mut self.ingest);
        let added = self.feed_view(&ingest[..len], abs_off);
        self.ingest = ingest;
        added
    }

    /// Feed bytes borrowed from outside the engine (native mmap fast path, zero copy).
    pub fn feed_slice(&mut self, view: &[u8], abs_off: u64) -> u32 {
        self.feed_view(view, abs_off)
    }

    fn feed_view(&mut self, view: &[u8], abs_off: u64) -> u32 {
        if self.carry.is_empty() {
            self.feed_ingest_only(view, abs_off)
        } else {
            self.feed_with_carry(view, abs_off)
        }
    }

    /// Common path: no carry — SIMD memchr newline scan over ingest window.
    fn feed_ingest_only(&mut self, view: &[u8], abs_off: u64) -> u32 {
        let before = self.entries.len();
        let len = view.len();
        let chunk_end = abs_off + len as u64;
        let at_file_end = chunk_end >= self.file_size;
        let extend_limit = self.shard_end + LINE_EXTEND as u64;

        let mut index = 0usize;
        if self.skip_partial {
            match memchr(b'\n', view) {
                Some(newline) => {
                    index = newline + 1;
                    self.skip_partial = false;
                }
                None => {
                    if !at_file_end {
                        self.carry.extend_from_slice(view);
                        self.carry_abs = abs_off;
                    }
                    return 0;
                }
            }
        }

        let mut line_start = index;
        for newline in memchr::memchr_iter(b'\n', &view[index..]) {
            let line_end = index + newline;
            let abs_line_start = abs_off + line_start as u64;
            if abs_line_start >= self.shard_end {
                line_start = line_end + 1;
                break;
            }
            self.accept_line(view, line_start, line_end);
            line_start = line_end + 1;
        }

        if line_start < len {
            let abs_line_start = abs_off + line_start as u64;
            if !at_file_end && abs_line_start < extend_limit {
                self.carry.clear();
                self.carry.extend_from_slice(&view[line_start..]);
                self.carry_abs = abs_line_start;
            } else if at_file_end && abs_line_start < self.shard_end {
                self.accept_line(view, line_start, len);
            }
        }

        (self.entries.len() - before) as u32
    }

    /// Rare path: leftover partial line from the previous chunk.
    fn feed_with_carry(&mut self, view: &[u8], abs_off: u64) -> u32 {
        let carry = std::mem::take(&mut self.carry);
        let carry_abs = self.carry_abs;
        let before = self.entries.len();
        let chunk = JoinedChunk::new(&carry, view, carry_abs);
        let at_file_end = abs_off + view.len() as u64 >= self.file_size;

        let Some(start) = self.skip_partial_prefix(&chunk, at_file_end) else {
            return 0;
        };
        self.accept_joined_lines(&chunk, start, at_file_end);
        (self.entries.len() - before) as u32
    }

    /// Index just past the partial line a shard boundary cut in half. `None` means
    /// the chunk held no newline and was saved as carry instead.
    fn skip_partial_prefix(&mut self, chunk: &JoinedChunk, at_file_end: bool) -> Option<usize> {
        if !self.skip_partial {
            return Some(0);
        }
        let Some(newline) = chunk.find_newline(0) else {
            if !at_file_end {
                self.save_carry(chunk, 0);
            }
            return None;
        };
        self.skip_partial = false;
        Some(newline + 1)
    }

    /// Accept every complete line from `start` on, carrying a trailing partial line.
    fn accept_joined_lines(&mut self, chunk: &JoinedChunk, start: usize, at_file_end: bool) {
        let extend_limit = self.shard_end + LINE_EXTEND as u64;
        let mut index = start;
        while index < chunk.len() {
            let abs_line_start = chunk.abs_of(index);
            if abs_line_start >= self.shard_end {
                return;
            }
            let line_end = chunk.find_newline(index).unwrap_or_else(|| chunk.len());
            if line_end == chunk.len() && !at_file_end {
                if abs_line_start < extend_limit {
                    self.save_carry(chunk, index);
                }
                return;
            }
            match chunk.slice(index, line_end) {
                Cow::Borrowed(line) => self.accept_line(line, 0, line.len()),
                Cow::Owned(line) => self.accept_line(&line, 0, line.len()),
            }
            if line_end == chunk.len() {
                return;
            }
            index = line_end + 1;
        }
    }

    /// Stash `chunk[start..]` as the next call's carry.
    fn save_carry(&mut self, chunk: &JoinedChunk, start: usize) {
        self.carry.clear();
        self.carry_abs = chunk.abs_of(start);
        match chunk.tail(start) {
            Cow::Borrowed(tail) => self.carry.extend_from_slice(tail),
            Cow::Owned(tail) => self.carry.extend_from_slice(&tail),
        }
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
        self.build_summary_and_meta();
    }

    /// Test / small-buffer helper: copies through the ingest window.
    pub fn parse_shard(
        &mut self,
        buf: &[u8],
        shard_start: usize,
        shard_end: usize,
        file_size: usize,
    ) -> usize {
        self.begin_shard(shard_start as u64, shard_end as u64, file_size as u64);
        let read_end = (shard_end + LINE_EXTEND).min(file_size);
        let end = read_end.saturating_sub(shard_start).min(buf.len());
        self.feed_slice(&buf[..end], shard_start as u64);
        self.end_shard();
        self.entries.len()
    }

    #[inline(always)]
    fn accept_line(&mut self, buf: &[u8], line_start: usize, line_end: usize) {
        match parse_line_bytes(buf, line_start, line_end) {
            LineKind::Empty => {}
            LineKind::Cron {
                event,
                name,
                ts,
                duration_ms,
            } => self.cron_events.push(super::CronEv {
                event,
                name,
                ts,
                duration_ms,
            }),
            LineKind::Http {
                method,
                path_start,
                path_end,
                status,
                duration_ms,
                hour,
                date,
            } => self.accept_http_line(
                buf,
                method,
                path_start,
                path_end,
                status,
                duration_ms,
                hour,
                date,
            ),
            LineKind::Unmatched => self.accept_unmatched_line(buf, line_start, line_end),
        }
    }

    #[inline(always)]
    fn accept_http_line(
        &mut self,
        buf: &[u8],
        method: Method,
        path_start: usize,
        path_end: usize,
        status: u16,
        duration_ms: f32,
        hour: Option<u8>,
        date: Option<[u8; 10]>,
    ) {
        let path_id = self.intern_path(&buf[path_start..path_end]);
        let date_id = self.intern_line_date(date);
        self.entries.push(super::PackedEntry::new(
            path_id,
            duration_ms,
            status,
            method as u8,
            hour.unwrap_or(255),
            date_id,
        ));
        self.methods_mask |= 1u8 << (method as u8);
    }

    /// Intern the line's date, reusing the last id when the date is unchanged.
    #[inline(always)]
    fn intern_line_date(&mut self, date: Option<[u8; 10]>) -> u16 {
        match date {
            Some(date) if date == self.last_date && self.last_date_id != 0 => self.last_date_id,
            Some(date) => self.intern_date(date),
            None => 0,
        }
    }

    fn accept_unmatched_line(&mut self, buf: &[u8], line_start: usize, line_end: usize) {
        self.unmatched_count += 1;
        if self.unmatched_sample.len() < UNMATCHED_SAMPLE_LIMIT {
            let sample_end = (line_start + UNMATCHED_SAMPLE_LEN).min(line_end);
            self.unmatched_sample.push(buf[line_start..sample_end].to_vec());
        }
    }
}

/// The logical chunk formed by the leftover carry plus the newly fed bytes.
struct JoinedChunk<'a> {
    carry: &'a [u8],
    view: &'a [u8],
    carry_abs: u64,
}

impl<'a> JoinedChunk<'a> {
    fn new(carry: &'a [u8], view: &'a [u8], carry_abs: u64) -> Self {
        Self {
            carry,
            view,
            carry_abs,
        }
    }

    fn len(&self) -> usize {
        self.carry.len() + self.view.len()
    }

    fn abs_of(&self, index: usize) -> u64 {
        self.carry_abs + index as u64
    }

    /// Index of the first `\n` at or after `from`.
    fn find_newline(&self, from: usize) -> Option<usize> {
        if from < self.carry.len() {
            if let Some(offset) = memchr(b'\n', &self.carry[from..]) {
                return Some(from + offset);
            }
            return memchr(b'\n', self.view).map(|offset| self.carry.len() + offset);
        }
        let offset = from - self.carry.len();
        memchr(b'\n', &self.view[offset..]).map(|found| from + found)
    }

    /// The bytes of `[start, end)`; allocated only when the span crosses buffers.
    fn slice(&self, start: usize, end: usize) -> Cow<'a, [u8]> {
        if end <= self.carry.len() {
            Cow::Borrowed(&self.carry[start..end])
        } else if start >= self.carry.len() {
            Cow::Borrowed(&self.view[start - self.carry.len()..end - self.carry.len()])
        } else {
            let mut line = Vec::with_capacity(end - start);
            line.extend_from_slice(&self.carry[start..]);
            line.extend_from_slice(&self.view[..end - self.carry.len()]);
            Cow::Owned(line)
        }
    }

    /// The bytes from `start` to the end of the chunk.
    fn tail(&self, start: usize) -> Cow<'a, [u8]> {
        self.slice(start, self.len())
    }
}
