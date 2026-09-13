//! Decoded PM2 partials: Rust-side accumulators for the native finalize path.

use super::hash_bytes;
use super::wire::{WireReader, PARTIAL_MAGIC, WIRE_VERSION};
use crate::relhist::RelHist;
use hashbrown::HashMap;

#[derive(Clone, Debug)]
pub struct DecodedEndpoint {
    pub method: u8,
    pub hash: u64,
    pub path: Vec<u8>,
    pub count: u32,
    pub sum: f64,
    pub min: f32,
    pub max: f32,
    pub error_count: u32,
    pub sketch: Box<RelHist>,
}

#[derive(Clone, Debug)]
pub struct DecodedSummary {
    pub sum: f64,
    pub max: f32,
    pub errors: u32,
    pub slow: u32,
    pub sketch: RelHist,
}

#[derive(Clone, Debug)]
pub struct DecodedPartial {
    pub mode: u8,
    pub endpoints: Vec<DecodedEndpoint>,
    pub summary: Option<DecodedSummary>,
    pub matched: u32,
    pub unmatched: u32,
}

impl DecodedPartial {
    fn empty() -> Self {
        Self {
            mode: 0,
            endpoints: Vec::new(),
            summary: None,
            matched: 0,
            unmatched: 0,
        }
    }

    /// A partial that carries no data yet and may be replaced wholesale.
    fn is_empty(&self) -> bool {
        self.endpoints.is_empty() && self.summary.is_none() && self.matched == 0
    }
}

/// One endpoint's accumulators while decoded partials are merged by `(method, path)`.
struct EndpointAccumulator {
    count: u32,
    sum: f64,
    min: f32,
    max: f32,
    error_count: u32,
    sketch: Box<RelHist>,
}

impl EndpointAccumulator {
    fn absorb(&mut self, other: Self) {
        self.count += other.count;
        self.sum += other.sum;
        if other.count > 0 && (self.count == other.count || other.min < self.min) {
            self.min = other.min;
        }
        if other.max > self.max {
            self.max = other.max;
        }
        self.error_count += other.error_count;
        self.sketch.merge(&other.sketch);
    }

    fn into_decoded(self, method: u8, path: Vec<u8>) -> DecodedEndpoint {
        let hash = hash_bytes(&path);
        DecodedEndpoint {
            method,
            hash,
            path,
            count: self.count,
            sum: self.sum,
            min: self.min,
            max: self.max,
            error_count: self.error_count,
            sketch: self.sketch,
        }
    }
}

fn into_accumulator(endpoint: DecodedEndpoint) -> (u8, Vec<u8>, EndpointAccumulator) {
    let method = endpoint.method;
    let path = endpoint.path;
    let accumulator = EndpointAccumulator {
        count: endpoint.count,
        sum: endpoint.sum,
        min: endpoint.min,
        max: endpoint.max,
        error_count: endpoint.error_count,
        sketch: endpoint.sketch,
    };
    (method, path, accumulator)
}

fn insert_endpoint(
    map: &mut HashMap<(u8, Vec<u8>), EndpointAccumulator>,
    endpoint: DecodedEndpoint,
) {
    let (method, path, accumulator) = into_accumulator(endpoint);
    match map.entry((method, path)) {
        hashbrown::hash_map::Entry::Vacant(slot) => {
            slot.insert(accumulator);
        }
        hashbrown::hash_map::Entry::Occupied(mut slot) => slot.get_mut().absorb(accumulator),
    }
}

fn to_endpoints(map: HashMap<(u8, Vec<u8>), EndpointAccumulator>) -> Vec<DecodedEndpoint> {
    map.into_iter()
        .map(|((method, path), accumulator)| accumulator.into_decoded(method, path))
        .collect()
}

fn merge_summaries(
    left: Option<DecodedSummary>,
    right: Option<DecodedSummary>,
) -> Option<DecodedSummary> {
    match (left, right) {
        (Some(mut left), Some(right)) => {
            left.sum += right.sum;
            if right.max > left.max {
                left.max = right.max;
            }
            left.errors += right.errors;
            left.slow += right.slow;
            left.sketch.merge(&right.sketch);
            Some(left)
        }
        (Some(left), None) => Some(left),
        (None, Some(right)) => Some(right),
        (None, None) => None,
    }
}

pub fn merge_two_decoded(left: DecodedPartial, right: DecodedPartial) -> DecodedPartial {
    if left.is_empty() {
        return right;
    }
    if right.is_empty() {
        return left;
    }
    let mode = if left.mode != 0 { left.mode } else { right.mode };
    let summary = merge_summaries(left.summary, right.summary);
    let mut endpoints = HashMap::with_capacity(left.endpoints.len() + right.endpoints.len());
    for endpoint in left.endpoints {
        insert_endpoint(&mut endpoints, endpoint);
    }
    for endpoint in right.endpoints {
        insert_endpoint(&mut endpoints, endpoint);
    }
    DecodedPartial {
        mode,
        endpoints: to_endpoints(endpoints),
        summary,
        matched: left.matched + right.matched,
        unmatched: left.unmatched + right.unmatched,
    }
}

/// Per-method endpoint maps for the decoded merge: partitioning by method lowers
/// collisions and the cache footprint of the merge.
struct MergedDecoded {
    mode: u8,
    matched: u32,
    unmatched: u32,
    sum: f64,
    max: f32,
    errors: u32,
    slow: u32,
    has_summary: bool,
    sketch: RelHist,
    maps: [HashMap<Vec<u8>, EndpointAccumulator>; 6],
}

impl MergedDecoded {
    fn new(total_endpoints: usize) -> Self {
        Self {
            mode: 0,
            matched: 0,
            unmatched: 0,
            sum: 0.0,
            max: 0.0,
            errors: 0,
            slow: 0,
            has_summary: false,
            sketch: RelHist::new(),
            maps: [
                HashMap::with_capacity((total_endpoints / 2).max(4096)),
                HashMap::with_capacity(1024),
                HashMap::with_capacity(512),
                HashMap::with_capacity(256),
                HashMap::with_capacity(256),
                HashMap::with_capacity(256),
            ],
        }
    }

    fn absorb(&mut self, partial: DecodedPartial) {
        self.mode = partial.mode;
        self.matched += partial.matched;
        self.unmatched += partial.unmatched;
        if let Some(summary) = partial.summary {
            self.has_summary = true;
            self.sum += summary.sum;
            if summary.max > self.max {
                self.max = summary.max;
            }
            self.errors += summary.errors;
            self.slow += summary.slow;
            self.sketch.merge(&summary.sketch);
        }
        for endpoint in partial.endpoints {
            let method_index = (endpoint.method as usize).min(5);
            let (_, path, accumulator) = into_accumulator(endpoint);
            let map = &mut self.maps[method_index];
            match map.entry(path) {
                hashbrown::hash_map::Entry::Vacant(slot) => {
                    slot.insert(accumulator);
                }
                hashbrown::hash_map::Entry::Occupied(mut slot) => {
                    slot.get_mut().absorb(accumulator);
                }
            }
        }
    }

    fn finish(self) -> DecodedPartial {
        let summary = self.has_summary.then_some(DecodedSummary {
            sum: self.sum,
            max: self.max,
            errors: self.errors,
            slow: self.slow,
            sketch: self.sketch,
        });
        let total_unique: usize = self.maps.iter().map(HashMap::len).sum();
        let mut endpoints = Vec::with_capacity(total_unique);
        for (method_index, map) in self.maps.into_iter().enumerate() {
            let method = method_index as u8;
            for (path, accumulator) in map {
                endpoints.push(accumulator.into_decoded(method, path));
            }
        }
        DecodedPartial {
            mode: self.mode,
            endpoints,
            summary,
            matched: self.matched,
            unmatched: self.unmatched,
        }
    }
}

pub fn merge_decoded_partials(partials: Vec<DecodedPartial>) -> DecodedPartial {
    if partials.is_empty() {
        return DecodedPartial::empty();
    }
    if partials.len() == 1 {
        return partials.into_iter().next().expect("length checked above");
    }
    let total_endpoints: usize = partials.iter().map(|partial| partial.endpoints.len()).sum();
    let mut merged = MergedDecoded::new(total_endpoints);
    for partial in partials {
        merged.absorb(partial);
    }
    merged.finish()
}

/// Decode a merged PM2P partial wire back into Rust accumulators.
pub fn decode_pm2_partial(buf: &[u8]) -> Option<DecodedPartial> {
    let mut reader = WireReader::new(buf);
    if reader.u32()? != PARTIAL_MAGIC {
        return None;
    }
    if reader.u16()? != WIRE_VERSION {
        return None;
    }
    let mode = reader.u8()?;
    let flags = reader.u8()?;
    let endpoint_count = reader.u32()? as usize;
    let matched = reader.u32()?;
    let unmatched = reader.u32()?;
    let summary = decode_summary(&mut reader, flags)?;

    let mut endpoints = Vec::with_capacity(endpoint_count.min(1 << 16));
    for _ in 0..endpoint_count {
        endpoints.push(decode_endpoint(&mut reader)?);
    }

    Some(DecodedPartial {
        mode,
        endpoints,
        summary,
        matched,
        unmatched,
    })
}

/// The optional summary block, which the partial's flag byte announces.
fn decode_summary(
    reader: &mut WireReader,
    flags: u8,
) -> Option<Option<DecodedSummary>> {
    if flags & 1 == 0 {
        return Some(None);
    }
    Some(Some(DecodedSummary {
        sum: reader.f64()?,
        max: reader.f32()?,
        errors: reader.u32()?,
        slow: reader.u32()?,
        sketch: reader.sketch()?,
    }))
}

/// One `method`, pad, counters, `path`, [`RelHist`] endpoint record.
fn decode_endpoint(reader: &mut WireReader) -> Option<DecodedEndpoint> {
    let method = reader.u8()?;
    reader.take(3)?;
    let count = reader.u32()?;
    let sum = reader.f64()?;
    let min = reader.f32()?;
    let max = reader.f32()?;
    let error_count = reader.u32()?;
    let path = reader.bytes()?.to_vec();
    let sketch = reader.sketch()?;
    let hash = hash_bytes(&path);
    Some(DecodedEndpoint {
        method,
        hash,
        path,
        count,
        sum,
        min,
        max,
        error_count,
        sketch: Box::new(sketch),
    })
}
