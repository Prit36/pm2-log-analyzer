//! PM2P partial wire format: encoding and partial merging.

use super::aggregate::EndpointAcc;
use super::{CronEv, DailyAcc, HourlyAcc};
use crate::relhist::RelHist;

pub(super) const PARTIAL_MAGIC: u32 = 0x504D3250;
const HOURLY_MAGIC: u32 = 0x504D3248;
const DAILY_MAGIC: u32 = 0x504D3244;
pub(super) const WIRE_VERSION: u16 = 1;

pub fn encode_dates_vec(dates: &[[u8; 10]]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&(dates.len() as u32).to_le_bytes());
    for date in dates {
        write_bytes(&mut out, date);
    }
    out
}

pub fn encode_cron_vec(cron_events: &[CronEv]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&(cron_events.len() as u32).to_le_bytes());
    for event in cron_events {
        out.push(event.event);
        write_bytes(&mut out, &event.name);
        match &event.ts {
            Some(timestamp) => {
                out.push(1);
                write_bytes(&mut out, timestamp);
            }
            None => out.push(0),
        }
        match event.duration_ms {
            Some(duration) => {
                out.push(1);
                out.extend_from_slice(&duration.to_le_bytes());
            }
            None => out.push(0),
        }
    }
    out
}

pub fn encode_unmatched_vec(unmatched_sample: &[Vec<u8>]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&(unmatched_sample.len() as u32).to_le_bytes());
    for sample in unmatched_sample {
        write_bytes(&mut out, sample);
    }
    out
}

pub fn encode_hourly_vec(buckets: &[HourlyAcc]) -> Vec<u8> {
    let mut out = Vec::with_capacity(16 + buckets.len() * 32);
    out.extend_from_slice(&HOURLY_MAGIC.to_le_bytes());
    out.extend_from_slice(&WIRE_VERSION.to_le_bytes());
    out.extend_from_slice(&(buckets.len() as u16).to_le_bytes());
    for bucket in buckets {
        out.extend_from_slice(&bucket.count.to_le_bytes());
        out.extend_from_slice(&bucket.error_count.to_le_bytes());
        out.extend_from_slice(&bucket.sum.to_le_bytes());
        out.extend_from_slice(&bucket.max.to_le_bytes());
        write_bytes(&mut out, &bucket.sketch.to_wire());
    }
    out
}

pub fn encode_daily_vec(accs: &[DailyAcc]) -> Vec<u8> {
    let mut out = Vec::with_capacity(16 + accs.len() * (32 + 24 * 32));
    out.extend_from_slice(&DAILY_MAGIC.to_le_bytes());
    out.extend_from_slice(&WIRE_VERSION.to_le_bytes());
    out.extend_from_slice(&(accs.len() as u16).to_le_bytes());
    for acc in accs {
        out.extend_from_slice(&acc.date); // 10 bytes
        out.extend_from_slice(&[0u8; 2]); // pad to 12 bytes
        out.extend_from_slice(&acc.count.to_le_bytes());
        out.extend_from_slice(&acc.error_count.to_le_bytes());
        out.extend_from_slice(&acc.slow_count.to_le_bytes());
        out.extend_from_slice(&acc.sum.to_le_bytes());
        out.extend_from_slice(&acc.max.to_le_bytes());
        write_bytes(&mut out, &acc.sketch.to_wire());
        for bucket in &acc.hourly {
            out.extend_from_slice(&bucket.count.to_le_bytes());
            out.extend_from_slice(&bucket.error_count.to_le_bytes());
            out.extend_from_slice(&bucket.sum.to_le_bytes());
            out.extend_from_slice(&bucket.max.to_le_bytes());
            write_bytes(&mut out, &bucket.sketch.to_wire());
        }
    }
    out
}

pub(super) fn write_bytes(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(bytes);
}

/// The wire-level fields of one shard's filtered endpoint aggregation.
pub(super) struct PartialWire<'a> {
    pub(super) mode: u8,
    pub(super) endpoints: &'a [(u32, EndpointAcc)],
    pub(super) norm_bytes: &'a [u8],
    pub(super) norm_off: &'a [u32],
    pub(super) norm_len: &'a [u16],
    pub(super) summary: Option<&'a RelHist>,
    pub(super) sum: f64,
    pub(super) max: f32,
    pub(super) errors: u32,
    pub(super) slow: u32,
    pub(super) matched: u32,
    pub(super) unmatched: u32,
}

impl PartialWire<'_> {
    /// Encode this shard's filtered endpoints as a PM2P partial.
    pub(super) fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(64 + self.endpoints.len() * 64);
        out.extend_from_slice(&PARTIAL_MAGIC.to_le_bytes());
        out.extend_from_slice(&WIRE_VERSION.to_le_bytes());
        out.push(self.mode);
        out.push(if self.summary.is_some() { 1u8 } else { 0u8 });
        out.extend_from_slice(&(self.endpoints.len() as u32).to_le_bytes());
        out.extend_from_slice(&self.matched.to_le_bytes());
        out.extend_from_slice(&self.unmatched.to_le_bytes());

        if let Some(sketch) = self.summary {
            out.extend_from_slice(&self.sum.to_le_bytes());
            out.extend_from_slice(&self.max.to_le_bytes());
            out.extend_from_slice(&self.errors.to_le_bytes());
            out.extend_from_slice(&self.slow.to_le_bytes());
            write_bytes(&mut out, &sketch.to_wire());
        }

        for (norm_id, endpoint) in self.endpoints {
            out.push(endpoint.method);
            out.extend_from_slice(&[0, 0, 0]);
            out.extend_from_slice(&endpoint.count.to_le_bytes());
            out.extend_from_slice(&endpoint.sum.to_le_bytes());
            let min = if endpoint.count > 0 { endpoint.min } else { 0.0 };
            let max = if endpoint.count > 0 { endpoint.max } else { 0.0 };
            out.extend_from_slice(&min.to_le_bytes());
            out.extend_from_slice(&max.to_le_bytes());
            out.extend_from_slice(&endpoint.error_count.to_le_bytes());
            let offset = self.norm_off[*norm_id as usize] as usize;
            let length = self.norm_len[*norm_id as usize] as usize;
            write_bytes(&mut out, &self.norm_bytes[offset..offset + length]);
            write_bytes(&mut out, &endpoint.sketch.to_wire());
        }
        out
    }
}

/// Bounds-checked cursor over a length-prefixed wire buffer.
pub(super) struct WireReader<'a> {
    buf: &'a [u8],
    off: usize,
}

impl<'a> WireReader<'a> {
    pub(super) fn new(buf: &'a [u8]) -> Self {
        Self { buf, off: 0 }
    }

    pub(super) fn take(&mut self, len: usize) -> Option<&'a [u8]> {
        let end = self.off.checked_add(len)?;
        let out = self.buf.get(self.off..end)?;
        self.off = end;
        Some(out)
    }

    pub(super) fn u8(&mut self) -> Option<u8> {
        self.take(1).map(|bytes| bytes[0])
    }

    pub(super) fn u16(&mut self) -> Option<u16> {
        let bytes = self.take(2)?;
        Some(u16::from_le_bytes([bytes[0], bytes[1]]))
    }

    pub(super) fn u32(&mut self) -> Option<u32> {
        let bytes = self.take(4)?;
        Some(u32::from_le_bytes([
            bytes[0], bytes[1], bytes[2], bytes[3],
        ]))
    }

    pub(super) fn f32(&mut self) -> Option<f32> {
        let bytes = self.take(4)?;
        Some(f32::from_le_bytes([
            bytes[0], bytes[1], bytes[2], bytes[3],
        ]))
    }

    pub(super) fn f64(&mut self) -> Option<f64> {
        let bytes = self.take(8)?;
        Some(f64::from_le_bytes([
            bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        ]))
    }

    /// A `u32`-length-prefixed byte string.
    pub(super) fn bytes(&mut self) -> Option<&'a [u8]> {
        let len = self.u32()? as usize;
        self.take(len)
    }

    /// A `u32`-length-prefixed [`RelHist`] wire.
    pub(super) fn sketch(&mut self) -> Option<RelHist> {
        RelHist::from_wire(self.bytes()?)
    }
}

/// One endpoint's accumulators while partials are merged by `(method, path)`.
struct MergedEndpoint {
    count: u32,
    sum: f64,
    min: f32,
    max: f32,
    error_count: u32,
    sketch: RelHist,
}

impl MergedEndpoint {
    fn merge(&mut self, other: Self) {
        self.count += other.count;
        self.sum += other.sum;
        if other.min < self.min {
            self.min = other.min;
        }
        if other.max > self.max {
            self.max = other.max;
        }
        self.error_count += other.error_count;
        self.sketch.merge(&other.sketch);
    }
}

/// Accumulator for the PM2P partials being merged into one.
struct MergedPartials {
    mode: u8,
    has_summary: bool,
    matched: u32,
    unmatched: u32,
    sum: f64,
    max: f32,
    errors: u32,
    slow: u32,
    sketch: RelHist,
    endpoints: hashbrown::HashMap<(u8, Vec<u8>), MergedEndpoint>,
}

impl MergedPartials {
    fn new() -> Self {
        Self {
            mode: 0,
            has_summary: false,
            matched: 0,
            unmatched: 0,
            sum: 0.0,
            max: 0.0,
            errors: 0,
            slow: 0,
            sketch: RelHist::new(),
            endpoints: hashbrown::HashMap::with_capacity(512),
        }
    }

    fn absorb(&mut self, partial: &[u8]) {
        let mut reader = WireReader::new(partial);
        if reader.u32() != Some(PARTIAL_MAGIC) {
            return;
        }
        let (Some(_version), Some(mode), Some(flags), Some(endpoint_count)) =
            (reader.u16(), reader.u8(), reader.u8(), reader.u32())
        else {
            return;
        };
        let (Some(matched), Some(unmatched)) = (reader.u32(), reader.u32()) else {
            return;
        };
        self.mode = mode;
        self.matched += matched;
        self.unmatched += unmatched;
        if flags & 1 != 0 {
            self.absorb_summary(&mut reader);
        }
        for _ in 0..endpoint_count {
            let Some(endpoint) = read_endpoint(&mut reader) else {
                break;
            };
            self.merge_endpoint(endpoint);
        }
    }

    fn absorb_summary(&mut self, reader: &mut WireReader) {
        let (Some(sum), Some(max), Some(errors), Some(slow), Some(sketch)) = (
            reader.f64(),
            reader.f32(),
            reader.u32(),
            reader.u32(),
            reader.sketch(),
        ) else {
            return;
        };
        self.has_summary = true;
        self.sum += sum;
        if max > self.max {
            self.max = max;
        }
        self.errors += errors;
        self.slow += slow;
        self.sketch.merge(&sketch);
    }

    fn merge_endpoint(&mut self, (method, path, endpoint): (u8, Vec<u8>, MergedEndpoint)) {
        match self.endpoints.entry((method, path)) {
            hashbrown::hash_map::Entry::Vacant(slot) => {
                slot.insert(endpoint);
            }
            hashbrown::hash_map::Entry::Occupied(mut slot) => slot.get_mut().merge(endpoint),
        }
    }

    fn encode(self) -> Vec<u8> {
        let mut out = Vec::with_capacity(64 + self.endpoints.len() * 128);
        out.extend_from_slice(&PARTIAL_MAGIC.to_le_bytes());
        out.extend_from_slice(&WIRE_VERSION.to_le_bytes());
        out.push(self.mode);
        out.push(if self.has_summary { 1u8 } else { 0u8 });
        out.extend_from_slice(&(self.endpoints.len() as u32).to_le_bytes());
        out.extend_from_slice(&self.matched.to_le_bytes());
        out.extend_from_slice(&self.unmatched.to_le_bytes());
        if self.has_summary {
            out.extend_from_slice(&self.sum.to_le_bytes());
            out.extend_from_slice(&self.max.to_le_bytes());
            out.extend_from_slice(&self.errors.to_le_bytes());
            out.extend_from_slice(&self.slow.to_le_bytes());
            write_bytes(&mut out, &self.sketch.to_wire());
        }

        let mut sorted: Vec<((u8, Vec<u8>), MergedEndpoint)> = self.endpoints.into_iter().collect();
        sorted.sort_unstable_by(|left, right| {
            left.0.1.cmp(&right.0.1).then_with(|| left.0.0.cmp(&right.0.0))
        });
        for ((method, path), endpoint) in sorted {
            out.push(method);
            out.extend_from_slice(&[0, 0, 0]);
            out.extend_from_slice(&endpoint.count.to_le_bytes());
            out.extend_from_slice(&endpoint.sum.to_le_bytes());
            out.extend_from_slice(&endpoint.min.to_le_bytes());
            out.extend_from_slice(&endpoint.max.to_le_bytes());
            out.extend_from_slice(&endpoint.error_count.to_le_bytes());
            write_bytes(&mut out, &path);
            write_bytes(&mut out, &endpoint.sketch.to_wire());
        }
        out
    }
}

/// Read one `method`, pad, counters, `path`, [`RelHist`] endpoint record.
fn read_endpoint(reader: &mut WireReader) -> Option<(u8, Vec<u8>, MergedEndpoint)> {
    let method = reader.u8()?;
    reader.take(3)?;
    let count = reader.u32()?;
    let sum = reader.f64()?;
    let min = reader.f32()?;
    let max = reader.f32()?;
    let error_count = reader.u32()?;
    let path = reader.bytes()?.to_vec();
    let sketch = reader.sketch().unwrap_or_default();
    Some((
        method,
        path,
        MergedEndpoint {
            count,
            sum,
            min,
            max,
            error_count,
            sketch,
        },
    ))
}

pub fn merge_pm2_partials(partials: &[Vec<u8>]) -> Vec<u8> {
    if partials.is_empty() {
        return Vec::new();
    }
    if partials.len() == 1 {
        return partials[0].clone();
    }
    let mut merged = MergedPartials::new();
    for partial in partials {
        merged.absorb(partial);
    }
    merged.encode()
}
